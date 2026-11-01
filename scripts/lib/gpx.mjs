// Lecture d'un fichier GPX et calcul des caractéristiques d'une randonnée.
import { decodeEntities } from './util.mjs';

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'i'));
  return m ? decodeEntities(m[1]).replace(/<[^>]+>/g, '').trim() : null;
};
const block = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? m[1] : '';
};
const attr = (s, name) => {
  const m = s.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return m ? m[1] : null;
};

export function parseGpx(raw) {
  const xml = raw.replace(/^﻿/, '');
  if (!/<gpx[\s>]/i.test(xml)) throw new Error('fichier GPX invalide');

  const metaXml = block(xml, 'metadata');
  const trkXml = block(xml, 'trk');
  const rteXml = block(xml, 'rte');
  const gpxOpen = (xml.match(/<gpx\b[^>]*>/i) || [''])[0];

  const meta = {
    name: tag(metaXml, 'name'),
    description: tag(metaXml, 'desc'),
    author: tag(block(metaXml, 'author'), 'name') || tag(metaXml, 'author'),
    time: tag(metaXml, 'time'),
    keywords: tag(metaXml, 'keywords'),
    copyright: attr(block(metaXml, 'copyright') ? (metaXml.match(/<copyright\b[^>]*>/i) || [''])[0] : '', 'author'),
    link: attr((metaXml.match(/<link\b[^>]*>/i) || [''])[0], 'href'),
    creator: attr(gpxOpen, 'creator'),
    version: attr(gpxOpen, 'version'),
    trackName: trkXml ? tag(trkXml.replace(/<trkseg[\s\S]*$/i, ''), 'name') : null,
    trackDescription: trkXml ? tag(trkXml.replace(/<trkseg[\s\S]*$/i, ''), 'desc') : null,
    trackComment: trkXml ? tag(trkXml.replace(/<trkseg[\s\S]*$/i, ''), 'cmt') : null,
    trackType: trkXml ? tag(trkXml.replace(/<trkseg[\s\S]*$/i, ''), 'type') : null,
    routeName: rteXml ? tag(rteXml.replace(/<rtept[\s\S]*$/i, ''), 'name') : null,
    routeDescription: rteXml ? tag(rteXml.replace(/<rtept[\s\S]*$/i, ''), 'desc') : null,
  };

  // Points de passage nommés
  const waypoints = [];
  for (const m of xml.matchAll(/<wpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/wpt>)/gi)) {
    const lat = parseFloat(attr(m[1], 'lat'));
    const lon = parseFloat(attr(m[1], 'lon'));
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      waypoints.push({ lat, lon, name: m[2] ? tag(m[2], 'name') : null });
    }
  }

  // Segments de trace (ou de route si pas de trace)
  const readPoints = (src, ptTag) => {
    const pts = [];
    for (const m of src.matchAll(new RegExp(`<${ptTag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${ptTag}>)`, 'gi'))) {
      const lat = parseFloat(attr(m[1], 'lat'));
      const lon = parseFloat(attr(m[1], 'lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const inner = m[2] || '';
      const eleM = inner.match(/<ele>\s*([-\d.eE+]+)\s*<\/ele>/i);
      const timeM = inner.match(/<time>\s*([^<]+?)\s*<\/time>/i);
      pts.push({
        lat, lon,
        ele: eleM ? parseFloat(eleM[1]) : null,
        time: timeM ? Date.parse(timeM[1]) || null : null,
      });
    }
    return pts;
  };

  let segments = [];
  for (const seg of xml.matchAll(/<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/gi)) {
    const pts = readPoints(seg[1], 'trkpt');
    if (pts.length) segments.push(pts);
  }
  let kind = 'trace';
  if (!segments.length) {
    for (const rte of xml.matchAll(/<rte\b[^>]*>([\s\S]*?)<\/rte>/gi)) {
      const pts = readPoints(rte[1], 'rtept');
      if (pts.length) segments.push(pts);
    }
    kind = 'route';
  }
  if (!segments.length) throw new Error('aucun point de trace ou de route');

  return { meta, waypoints, segments, kind };
}

// ---------------------------------------------------------------- Calculs
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Assemble les segments en une seule polyligne avec la distance cumulée.
export function flatten(segments) {
  const pts = [];
  let d = 0;
  for (const seg of segments) {
    seg.forEach((p, i) => {
      if (pts.length) {
        const step = haversine(pts[pts.length - 1], p);
        // Saut entre deux segments très éloignés : on ne le compte pas comme marché.
        if (!(i === 0 && step > 300)) d += step;
      }
      pts.push({ ...p, d });
    });
  }
  return pts;
}

// Dénivelés : lissage léger puis seuil d'hystérésis pour ignorer le bruit GPS.
export function elevationStats(pts, threshold = 3) {
  const withEle = pts.filter((p) => p.ele != null && Number.isFinite(p.ele));
  if (withEle.length < Math.max(2, pts.length * 0.6)) return null;
  // Lissage par fenêtre glissante sur ~60 m
  const smooth = withEle.map((p, i) => {
    let s = 0, n = 0;
    for (let j = i; j >= 0 && p.d - withEle[j].d <= 30; j--) { s += withEle[j].ele; n++; }
    for (let j = i + 1; j < withEle.length && withEle[j].d - p.d <= 30; j++) { s += withEle[j].ele; n++; }
    return s / n;
  });
  let up = 0, down = 0, ref = smooth[0];
  for (const e of smooth) {
    if (e - ref >= threshold) { up += e - ref; ref = e; }
    else if (ref - e >= threshold) { down += ref - e; ref = e; }
  }
  const eles = withEle.map((p) => p.ele);
  return {
    dplus: Math.round(up),
    dminus: Math.round(down),
    altMin: Math.round(Math.min(...eles)),
    altMax: Math.round(Math.max(...eles)),
  };
}

// Temps de marche estimé – norme DIN 33466 (utilisée par les fédérations alpines) :
// 4 km/h à plat, 300 m/h en montée, 500 m/h en descente ; on additionne la plus grande
// des deux composantes et la moitié de la plus petite. Pauses non comprises.
export function estimateDurationMin(km, dplus = 0, dminus = 0) {
  const horizontal = km / 4;
  const vertical = dplus / 300 + dminus / 500;
  const h = Math.max(horizontal, vertical) + Math.min(horizontal, vertical) / 2;
  return Math.round((h * 60) / 5) * 5;
}

// Durée réellement enregistrée (si la trace contient des horodatages).
export function recordedDuration(pts) {
  const t = pts.filter((p) => p.time);
  if (t.length < pts.length * 0.8 || t.length < 10) return null;
  const total = (t[t.length - 1].time - t[0].time) / 60000;
  if (!(total > 5 && total < 60 * 24 * 3)) return null;
  let moving = 0;
  for (let i = 1; i < t.length; i++) {
    const dt = (t[i].time - t[i - 1].time) / 1000;
    const v = haversine(t[i - 1], t[i]) / (dt || 1);
    if (dt > 0 && dt < 600 && v > 0.3) moving += dt;
  }
  return { start: new Date(t[0].time).toISOString(), totalMin: Math.round(total), movingMin: Math.round(moving / 60) };
}

// Douglas-Peucker (en mètres, projection locale équirectangulaire).
export function simplify(pts, tolerance) {
  if (pts.length <= 2) return pts.slice();
  const lat0 = rad(pts[0].lat);
  const xy = pts.map((p) => [rad(p.lon) * Math.cos(lat0) * R, rad(p.lat) * R]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      let t = ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - xy[i][0], ey = ay + t * dy - xy[i][1];
      const d2 = ex * ex + ey * ey;
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (maxD > tol2) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Simplifie jusqu'à tenir dans un nombre maximum de points.
export function simplifyTo(pts, maxPoints, startTol = 2) {
  let tol = startTol, out = simplify(pts, tol);
  while (out.length > maxPoints) { tol *= 1.6; out = simplify(pts, tol); }
  return out;
}

// Profil altimétrique rééchantillonné à intervalle de distance régulier.
export function profile(pts, n) {
  const withEle = pts.filter((p) => p.ele != null);
  if (withEle.length < 2) return [];
  const total = withEle[withEle.length - 1].d;
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = (total * i) / (n - 1);
    while (j < withEle.length - 2 && withEle[j + 1].d < target) j++;
    const a = withEle[j], b = withEle[j + 1];
    const t = b.d === a.d ? 0 : (target - a.d) / (b.d - a.d);
    out.push([+(target / 1000).toFixed(2), Math.round(a.ele + (b.ele - a.ele) * Math.max(0, Math.min(1, t)))]);
  }
  return out;
}

export function bbox(pts) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of pts) {
    if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat;
    if (p.lon < w) w = p.lon; if (p.lon > e) e = p.lon;
  }
  return [+s.toFixed(5), +w.toFixed(5), +n.toFixed(5), +e.toFixed(5)];
}
