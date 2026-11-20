#!/usr/bin/env node
// Croisements le long de chaque trace (même fichier dans les deux Randothèques), pour le guidage du mode terrain.
// Le guidage ne parle qu'aux endroits où l'on peut se tromper : un croisement ou une fourche. Quand le chemin
// tourne tout seul, il n'annonce que la distance jusqu'au prochain croisement.
//
// Les chemins et routes viennent de la BD TOPO de l'IGN en France (service WFS de la Géoplateforme, rapide,
// tronçons déjà coupés aux croisements), sinon d'OpenStreetMap (API Overpass, à moins de 20 m de la trace).
// Un croisement = un point partagé par au moins 3 tronçons. Pour chaque passage de la trace, on garde
// la direction d'arrivée, celle de départ et les autres branches possibles.
// Résultat gardé dans .cache/carrefours/<id>.json (enregistré dans le dépôt : chaque trace n'est demandée
// qu'une fois), puis ajouté aux fichiers data/tracks/<id>.js. Au plus CARREFOURS_MAX nouvelles traces par
// passage (80 par défaut) pour rester poli avec le service.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, DATA_DIR, CACHE_DIR, readJSON, writeJSON, sleep } from './lib/util.mjs';
import { parseGpx, flatten, simplifyTo } from './lib/gpx.mjs';

export const VERSION = 1;
const DIR = path.join(CACHE_DIR, 'carrefours');
const TRACKS = path.join(DATA_DIR, 'tracks');
const MAX = Number(process.env.CARREFOURS_MAX || 80);
// Temps maximal par passage : la mise en ligne du site ne doit jamais attendre ce calcul (3 min par défaut)
const BUDGET_MS = Number(process.env.CARREFOURS_BUDGET_S || 180) * 1000;
const NEAR = 20;        // m : distance trace / croisement
const ARM = 25;         // m : longueur de branche pour mesurer sa direction
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
// Ce qui ne se parcourt pas à pied, ou pas encore
const SKIP = /^(motorway|motorway_link|trunk_link|construction|proposed|platform|corridor|elevator|bus_stop|raceway|abandoned|razed)$/;

const rad = (d) => (d * Math.PI) / 180;
const norm = (a) => ((a + 540) % 360) - 180;

// Projection locale en mètres autour d'un point
function projector(lat0) {
  const kx = 111320 * Math.cos(rad(lat0)), ky = 110540;
  return (lat, lon) => [lon * kx, lat * ky];
}
const bearingXY = (a, b) => (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;

// BD TOPO : routes, chemins et sentiers de l'emprise de la trace (par pages de 5 000)
async function bdtopo(bbox) {
  const [s, w, n, e] = [bbox[0] - 0.002, bbox[1] - 0.003, bbox[2] + 0.002, bbox[3] + 0.003];
  const nodes = new Map(), ways = [];
  const key = (c) => `${c[1].toFixed(6)},${c[0].toFixed(6)}`;
  for (let start = 0; start < 60000; start += 5000) {
    const url = 'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:troncon_de_route'
      + `&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&BBOX=${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`
      + `&COUNT=5000&STARTINDEX=${start}&PROPERTYNAME=nature,geometrie&SORTBY=cleabs`;
    let j;
    for (let k = 0; ; k++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Randotheque/1.0 (guidage pas a pas)' }, signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error(`IGN HTTP ${res.status}`);
        j = await res.json();
        break;
      } catch (err) { if (k >= 2) throw err; await sleep(3000 * (k + 1)); }
    }
    for (const f of j.features || []) {
      if (!f.geometry || /bac|liaison/i.test(f.properties.nature || '')) continue;
      const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
      for (const line of lines) {
        const ids = line.map((c) => { const k = key(c); if (!nodes.has(k)) nodes.set(k, [c[1], c[0]]); return k; });
        ways.push(ids);
      }
    }
    if ((j.features || []).length < 5000) break;
  }
  return { nodes, ways };
}

async function overpass(poly) {
  const coords = poly.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(',');
  const q = `[out:json][timeout:90];way["highway"](around:${NEAR},${coords});out body;>;out skel qt;`;
  let last;
  for (const url of ENDPOINTS) {
    for (let k = 0; k < 1; k++) {
      try {
        const res = await fetch(url, {
          method: 'POST', body: new URLSearchParams({ data: q }),
          headers: { 'User-Agent': 'Randotheque/1.0 (guidage pas a pas)' }, signal: AbortSignal.timeout(40000),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const osm = await res.json();
        const nodes = new Map(), ways = [];
        for (const el of osm.elements) if (el.type === 'node') nodes.set(el.id, [el.lat, el.lon]);
        for (const el of osm.elements) {
          if (el.type === 'way' && !SKIP.test(el.tags?.highway || '') && el.nodes.length > 1) ways.push(el.nodes.filter((id) => nodes.has(id)));
        }
        return { nodes, ways };
      } catch (e) { last = e; await sleep(4000 * (k + 1)); }
    }
  }
  throw last;
}

// net = { nodes: Map(id -> [lat, lon]), ways: [[id, id, …], …] }
export function junctionsFor(pts, net) {
  const P = projector(pts[0].lat);
  const nodes = new Map();
  for (const [id, [lat, lon]] of net.nodes) nodes.set(id, P(lat, lon));
  const ways = net.ways;
  // Voisins de chaque nœud, et branches (direction mesurée sur ~25 m le long du chemin)
  const adj = new Map(), arms = new Map();
  for (const ns of ways) {
    ns.forEach((id, i) => {
      if (!adj.has(id)) { adj.set(id, new Set()); arms.set(id, []); }
      for (const dir of [-1, 1]) {
        const j = i + dir;
        if (j < 0 || j >= ns.length) continue;
        adj.get(id).add(ns[j]);
        const a = nodes.get(id);
        let k = j, b = nodes.get(ns[k]);
        while (Math.hypot(b[0] - a[0], b[1] - a[1]) < ARM && k + dir >= 0 && k + dir < ns.length) { k += dir; b = nodes.get(ns[k]); }
        arms.get(id).push(bearingXY(a, b));
      }
    });
  }
  // Trace rééchantillonnée tous les 5 m
  const S = [];
  for (let i = 0, d = 0; i < pts.length; i++) {
    if (i && pts[i].d < d) continue;
    S.push({ xy: P(pts[i].lat, pts[i].lon), d: pts[i].d });
    d = pts[i].d + 5;
  }
  const at = (d) => { let lo = 0, hi = S.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m].d < d) lo = m; else hi = m; } return S[hi]; };
  const out = [];
  for (const [id, set] of adj) {
    if (set.size < 3) continue;
    const xy = nodes.get(id);
    // Chaque passage de la trace près du croisement (une boucle peut y repasser)
    let best = null;
    const flush = () => { if (best) passes.push(best); best = null; };
    const passes = [];
    for (const s of S) {
      const dist = Math.hypot(s.xy[0] - xy[0], s.xy[1] - xy[1]);
      if (dist <= NEAR) { if (!best || dist < best.dist) best = { dist, d: s.d }; } else if (best && s.d - best.d > 60) flush();
    }
    flush();
    // Directions des branches, sans doublons (deux chemins qui partent ensemble)
    const br = [];
    for (const b of arms.get(id)) if (!br.some((x) => Math.abs(norm(x - b)) < 12)) br.push(b);
    if (br.length < 3) continue;
    for (const p of passes) {
      const inB = bearingXY(at(p.d - ARM).xy, at(p.d).xy), outB = bearingXY(at(p.d).xy, at(p.d + ARM).xy);
      if (p.d < 15 || p.d + 15 > S[S.length - 1].d) continue; // départ et arrivée : pas une consigne
      const closest = (target) => br.reduce((m, b) => (Math.abs(norm(b - target)) < Math.abs(norm(m - target)) ? b : m), br[0]);
      const back = closest(inB + 180), fwd = closest(outB);
      if (Math.abs(norm(fwd - outB)) > 50 || Math.abs(norm(back - (inB + 180))) > 50 || back === fwd) continue; // la trace quitte les chemins
      const heading = back + 180;
      out.push([+(p.d / 1000).toFixed(3), Math.round(norm(fwd - heading)),
        br.filter((b) => b !== back && b !== fwd).map((b) => Math.round(norm(b - heading)))]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

// Ajoute les croisements connus au fichier de trace (3e argument de __rtTrack)
export function patchTrackFile(id, junctions) {
  const file = path.join(TRACKS, `${id}.js`);
  if (!fs.existsSync(file)) return false;
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/^window\.__rtTrack&&__rtTrack\(("[^"]+"),(\[.*\])(?:,\{.*\})?\);\s*$/s);
  if (!m) return false;
  fs.writeFileSync(file, `window.__rtTrack&&__rtTrack(${m[1]},${m[2]},${JSON.stringify({ j: junctions })});`);
  return true;
}

export function readCache(id) {
  const c = readJSON(path.join(DIR, `${id}.json`), null);
  return c && c.v === VERSION ? c : null;
}

async function main() {
  const payload = readJSON(path.join(DATA_DIR, 'randos.json'), null);
  if (!payload) { console.error('data/randos.json manquant : lancez d\'abord « npm run build ».'); process.exit(1); }
  fs.mkdirSync(DIR, { recursive: true });
  let fetched = 0, failed = 0, patched = 0, osmFailed = 0;
  const t0 = Date.now();
  const todo = payload.randos.filter((r) => !readCache(r.id));
  for (const r of todo) {
    if (fetched >= MAX || Date.now() - t0 > BUDGET_MS) break;
    if (!r.region && osmFailed >= 1) continue; // OpenStreetMap saturé : ces traces attendront le prochain passage
    try {
      const pts = flatten(parseGpx(fs.readFileSync(path.join(ROOT, r.file), 'utf8')).segments);
      const net = r.region ? await bdtopo(r.bbox) : await overpass(simplifyTo(pts, 150, 5));
      const j = junctionsFor(pts, net);
      writeJSON(path.join(DIR, `${r.id}.json`), { v: VERSION, at: new Date().toISOString().slice(0, 10), j }, false);
      fetched++;
      await sleep(r.region ? 300 : 2000);
    } catch (e) {
      if (r.region) failed++; else osmFailed++;
      console.log(`   ⚠️  ${r.name} (${r.date}) : ${e.message}`);
      if (failed >= 5) { console.log('   Trop d\'échecs, on reprendra au prochain passage.'); break; }
    }
  }
  for (const r of payload.randos) {
    const c = readCache(r.id);
    if (c && patchTrackFile(r.id, c.j)) patched++;
  }
  const left = payload.randos.filter((r) => !readCache(r.id)).length;
  console.log(`🧭 Croisements : ${fetched} trace(s) analysée(s), ${patched} fichier(s) de trace complété(s), ${left} restante(s)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
