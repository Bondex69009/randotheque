/* Randothèque – « Survol 3D » : rejoue la trace en vol au-dessus du relief (MapLibre GL, chargé à la demande).
   Caméra embarquée lissée, trace qui se dessine, bornes kilométriques et profil d'étape façon Tour de France. */
(() => {
  'use strict';
  const ML = window.maplibregl;
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cssVar = (n, fb) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmtDur = (min) => { const m = Math.round(min); const h = Math.floor(m / 60); return h ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${m} min`; };

  // Fonds de carte (sans clé) et relief (tuiles Terrarium d'AWS Open Data)
  const IGN = (layer, fmt) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM&FORMAT=${fmt}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
  const IGN_ATTR = '© <a href="https://www.ign.fr/" target="_blank" rel="noopener">IGN</a>';
  const BASES = {
    photo: (fr) => fr
      ? { tiles: [IGN('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg')], maxzoom: 19, attribution: IGN_ATTR }
      : { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], maxzoom: 19, attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics' },
    plan: (fr) => fr
      ? { tiles: [IGN('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png')], maxzoom: 19, attribution: IGN_ATTR }
      : { tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`), maxzoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)' },
  };
  const DEM = {
    type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 15,
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    attribution: 'Relief : <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Mapzen Terrain Tiles</a>',
  };

  // Couleurs de pente, du plat au très raide (montée) ; descente à part
  const SLOPES = [
    { max: 5, color: '#7cc84a', label: '< 5 %' },
    { max: 10, color: '#f6d32d', label: '5-10 %' },
    { max: 15, color: '#f59e0b', label: '10-15 %' },
    { max: 20, color: '#e5452f', label: '15-20 %' },
    { max: Infinity, color: '#8b1a1a', label: '> 20 %' },
  ];
  const DESCENT = '#5f7f95';
  const slopeColor = (g) => (g < -2 ? DESCENT : (SLOPES.find((s) => g < s.max) || SLOPES[SLOPES.length - 1]).color);

  // ---------------------------------------------------------------- Préparation de la trace
  function prepare(track, dplusRef) {
    const raw = track.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[3]));
    let lastEle = raw.find((p) => p[2] != null)?.[2] ?? 0;
    for (const p of raw) { if (p[2] == null) p[2] = lastEle; else lastEle = p[2]; }
    const total = raw[raw.length - 1][3];
    // Rééchantillonnage régulier : interpolation simple et animation sans à-coups
    const step = Math.max(0.01, total / 3000);
    const n = Math.max(2, Math.ceil(total / step) + 1);
    const lon = new Float64Array(n), lat = new Float64Array(n), ele = new Float64Array(n), km = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.min(total, i * step);
      while (j < raw.length - 2 && raw[j + 1][3] < d) j++;
      const a = raw[j], b = raw[j + 1] || a;
      const t = b[3] > a[3] ? clamp((d - a[3]) / (b[3] - a[3]), 0, 1) : 0;
      lat[i] = a[0] + (b[0] - a[0]) * t; lon[i] = a[1] + (b[1] - a[1]) * t;
      ele[i] = a[2] + (b[2] - a[2]) * t; km[i] = d;
    }
    // Lissage léger des altitudes (fenêtre de ~60 m) pour les pentes et le dénivelé
    const w = Math.max(1, Math.round(0.03 / step));
    const sm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) { s += ele[k]; c++; }
      sm[i] = s / c;
    }
    // Dénivelé positif cumulé (avec seuil), recalé sur la valeur de la fiche
    const up = new Float64Array(n);
    let ref = sm[0], acc = 0;
    for (let i = 1; i < n; i++) {
      if (sm[i] - ref >= 3) { acc += sm[i] - ref; ref = sm[i]; } else if (sm[i] < ref) ref = sm[i];
      up[i] = acc;
    }
    if (dplusRef && acc > 0) { const k = dplusRef / acc; for (let i = 0; i < n; i++) up[i] *= k; }
    return { lon, lat, ele, sm, up, km, n, step, total };
  }

  function sampler(T) {
    const idx = (d) => clamp(d / T.step, 0, T.n - 1);
    const lerp = (arr, d) => { const f = idx(d), i = Math.floor(f), t = f - i; return i >= T.n - 1 ? arr[T.n - 1] : arr[i] + (arr[i + 1] - arr[i]) * t; };
    return {
      pos: (d) => [lerp(T.lon, d), lerp(T.lat, d)],
      ele: (d) => lerp(T.ele, d),
      sm: (d) => lerp(T.sm, d),
      up: (d) => lerp(T.up, d),
      grade: (d) => { const a = clamp(d - 0.1, 0, T.total), b = clamp(d + 0.1, 0, T.total); return b > a ? ((lerp(T.sm, b) - lerp(T.sm, a)) / ((b - a) * 1000)) * 100 : 0; },
      coordsTo: (d) => {
        const end = Math.floor(idx(d)), out = [];
        for (let i = 0; i <= end; i++) out.push([T.lon[i], T.lat[i]]);
        out.push([lerp(T.lon, d), lerp(T.lat, d)]);
        return out;
      },
    };
  }
  // Tronçons de couleur homogène selon la pente (pour colorer la trace parcourue)
  function slopeRuns(T, S) {
    const runs = [];
    for (let i = 0; i < T.n - 1; i++) {
      const c = slopeColor(S.grade((T.km[i] + T.km[i + 1]) / 2));
      const r = runs[runs.length - 1];
      if (r && r.c === c) r.b = i + 1; else runs.push({ a: i, b: i + 1, c });
    }
    // Absorbe les tronçons trop courts (< ~40 m) dans le précédent pour éviter le scintillement
    const min = Math.max(1, Math.round(0.04 / T.step));
    const out = [];
    for (const r of runs) {
      const prev = out[out.length - 1];
      if (prev && (r.b - r.a < min || prev.c === r.c)) prev.b = r.b; else out.push({ ...r });
    }
    return out;
  }
  function slopeDone(T, S, runs, d) {
    const f = clamp(d / T.step, 0, T.n - 1), features = [];
    for (const r of runs) {
      if (r.a >= f) break;
      const coords = [];
      const end = Math.min(r.b, Math.floor(f));
      for (let i = r.a; i <= end; i++) coords.push([T.lon[i], T.lat[i]]);
      if (f < r.b) coords.push(S.pos(d));
      if (coords.length < 2) coords.push(coords[0]);
      features.push({ type: 'Feature', properties: { c: r.c }, geometry: { type: 'LineString', coordinates: coords } });
    }
    return { type: 'FeatureCollection', features };
  }
  const bearingOf = (a, b) => {
    const k = Math.cos((a[1] * Math.PI) / 180);
    return (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI;
  };
  const angDiff = (a, b) => ((b - a + 540) % 360) - 180;

  // ---------------------------------------------------------------- Randonneur en 3D (couche WebGL dans la scène MapLibre)
  // Petit bonhomme articulé (sac, chapeau, bâtons) posé sur le relief, tourné dans le sens de la marche,
  // qui se penche dans les montées et dont les jambes et les bras bougent pendant la lecture.
  const M4 = {
    id: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    mul: (...ms) => ms.reduce((a, b) => {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
      return o;
    }),
    t: (x, y, z) => { const m = M4.id(); m[12] = x; m[13] = y; m[14] = z; return m; },
    s: (x, y, z) => { const m = M4.id(); m[0] = x; m[5] = y; m[10] = z; return m; },
    rx: (a) => { const c = Math.cos(a), s = Math.sin(a), m = M4.id(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; },
    ry: (a) => { const c = Math.cos(a), s = Math.sin(a), m = M4.id(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; },
    rz: (a) => { const c = Math.cos(a), s = Math.sin(a), m = M4.id(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; },
  };
  // Géométries simples en mètres (x = droite, y = avant, z = haut), positions + normales entrelacées
  const GEO = {
    tube(rxB, ryB, rxT, ryT, zB, zT, n = 12, cy = 0) {
      const v = [];
      const ring = (k, rx, ry, z) => { const a = (k / n) * Math.PI * 2; return [Math.cos(a) * rx, cy + Math.sin(a) * ry, z]; };
      const nor = (k, rx, ry) => { const a = (k / n) * Math.PI * 2, x = Math.cos(a) / rx, y = Math.sin(a) / ry, l = Math.hypot(x, y); return [x / l, y / l, 0]; };
      for (let k = 0; k < n; k++) {
        const a0 = ring(k, rxB, ryB, zB), a1 = ring(k + 1, rxB, ryB, zB), b0 = ring(k, rxT, ryT, zT), b1 = ring(k + 1, rxT, ryT, zT);
        const n0 = nor(k, (rxB + rxT) / 2, (ryB + ryT) / 2), n1 = nor(k + 1, (rxB + rxT) / 2, (ryB + ryT) / 2);
        v.push(...a0, ...n0, ...a1, ...n1, ...b1, ...n1, ...a0, ...n0, ...b1, ...n1, ...b0, ...n0);
        v.push(0, cy, zT, 0, 0, 1, ...b0, 0, 0, 1, ...b1, 0, 0, 1);
        v.push(0, cy, zB, 0, 0, -1, ...a1, 0, 0, -1, ...a0, 0, 0, -1);
      }
      return v;
    },
    ball(rx, ry, rz, cz, cy = 0, seg = 10) {
      const v = [];
      const p = (i, j) => {
        const th = (i / seg) * Math.PI, ph = (j / (seg * 2)) * Math.PI * 2;
        const nx = Math.sin(th) * Math.cos(ph), ny = Math.sin(th) * Math.sin(ph), nz = Math.cos(th);
        const l = Math.hypot(nx / rx, ny / ry, nz / rz) || 1;
        return [nx * rx, cy + ny * ry, cz + nz * rz, nx / rx / l, ny / ry / l, nz / rz / l];
      };
      for (let i = 0; i < seg; i++) for (let j = 0; j < seg * 2; j++) {
        const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
        v.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
      return v;
    },
    // Applique une matrice à un lot de sommets (positions + normales), pour poser une pièce de biais
    xf(v, m) {
      const o = [];
      for (let i = 0; i < v.length; i += 6) {
        const [x, y, z, nx, ny, nz] = v.slice(i, i + 6);
        o.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        const a = m[0] * nx + m[4] * ny + m[8] * nz, b = m[1] * nx + m[5] * ny + m[9] * nz, c = m[2] * nx + m[6] * ny + m[10] * nz, l = Math.hypot(a, b, c) || 1;
        o.push(a / l, b / l, c / l);
      }
      return o;
    },
    box(w, d, h, cy, z0, cx = 0) {
      const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - d / 2, y1 = cy + d / 2, z1 = z0 + h, v = [];
      const q = (a, b, c, e, n) => v.push(...a, ...n, ...b, ...n, ...c, ...n, ...a, ...n, ...c, ...n, ...e, ...n);
      q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
      q([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0]);
      q([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0]);
      q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
      q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
      q([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1]);
      return v;
    },
  };
  const HIKER_PARTS = {
    thigh: { c: 'pants', g: () => GEO.tube(0.062, 0.066, 0.08, 0.085, -0.47, 0) },
    shin: { c: 'pants', g: () => GEO.tube(0.05, 0.055, 0.064, 0.068, -0.45, 0) },
    boot: { c: 'boot', g: () => [...GEO.box(0.12, 0.25, 0.1, 0.045, -0.07), ...GEO.tube(0.06, 0.06, 0.06, 0.06, -0.02, 0.06)] },
    hips: { c: 'pants', g: () => GEO.tube(0.17, 0.11, 0.18, 0.115, -0.1, 0.1) },
    torso: { c: 'shirt', g: () => [...GEO.tube(0.175, 0.11, 0.205, 0.12, 0.06, 0.52), ...GEO.ball(0.205, 0.12, 0.07, 0.52)] },
    skin: { c: 'skin', g: () => [...GEO.tube(0.05, 0.05, 0.05, 0.05, 0.55, 0.66), ...GEO.ball(0.095, 0.105, 0.12, 0.76, 0.01)] },
    hat: { c: 'hat', g: () => [...GEO.tube(0.19, 0.19, 0.18, 0.18, 0.835, 0.85), ...GEO.tube(0.11, 0.115, 0.095, 0.1, 0.845, 0.95)] },
    pack: { c: 'pack', g: () => [...GEO.box(0.32, 0.2, 0.48, -0.2, 0.06), ...GEO.box(0.26, 0.06, 0.24, -0.32, 0.12)] },
    roll: { c: 'roll', g: () => GEO.tube(0.065, 0.065, 0.065, 0.065, -0.2, 0.2) },
    arm: { c: 'shirt', g: () => GEO.tube(0.044, 0.046, 0.056, 0.058, -0.29, 0.02) },
    fore: { c: 'skin', g: () => [...GEO.tube(0.034, 0.034, 0.042, 0.042, -0.27, 0), ...GEO.ball(0.042, 0.048, 0.05, -0.3)] },
    pole: { c: 'pole', g: () => [...GEO.tube(0.011, 0.011, 0.013, 0.013, -1.02, 0.08, 6), ...GEO.tube(0.02, 0.02, 0.02, 0.02, -0.06, 0.08, 6)] },
    shadow: { c: 'shadow', flat: true, g: () => {
      const v = [], n = 24;
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
        v.push(0, 0, 0.01, 0, 0, 1, Math.cos(a0) * 0.42, Math.sin(a0) * 0.5, 0.01, 0, 0, 1, Math.cos(a1) * 0.42, Math.sin(a1) * 0.5, 0.01, 0, 0, 1);
      }
      return v;
    } },
  };
  // le duvet roulé sur le sac est couché à l'horizontale
  const ROLL_AT = M4.mul(M4.t(0, -0.21, 0.6), M4.ry(Math.PI / 2));

  // Godillot ailé (l'emblème des Godillots Ailés) : chaussure de rando qui vole au-dessus de la trace
  // en battant des ailes. Mêmes unités que le randonneur (environ 1,9 de haut, y = avant).
  const feather = (len, wid, ang, off) => GEO.xf(
    [...GEO.box(len, wid, 0.03, 0, -0.015, len / 2), ...GEO.xf(GEO.ball(wid / 2, wid / 2, 0.015, 0), M4.t(len, 0, 0))],
    M4.mul(M4.t(0, off, 0), M4.rz(ang)),
  );
  const BOOT_PARTS = {
    sole: { c: 'sole', g: () => [...GEO.box(0.5, 1.2, 0.12, 0.04, 0), ...GEO.xf(GEO.ball(0.25, 0.2, 0.06, 0.06), M4.t(0, 0.62, 0))] },
    foot: { c: 'leather', g: () => [...GEO.box(0.46, 1.0, 0.34, 0.02, 0.12), ...GEO.ball(0.23, 0.3, 0.2, 0.3, 0.5)] },
    toe: { c: 'cap', g: () => GEO.ball(0.245, 0.24, 0.13, 0.2, 0.6) },
    shaft: { c: 'leather', g: () => GEO.tube(0.25, 0.3, 0.27, 0.3, 0.3, 1.02, 16, -0.26) },
    collar: { c: 'cap', g: () => GEO.tube(0.29, 0.33, 0.29, 0.33, 0.98, 1.12, 16, -0.26) },
    tongue: { c: 'cap', g: () => GEO.box(0.22, 0.06, 0.62, 0.05, 0.5) },
    laces: { c: 'lace', g: () => [0.58, 0.7, 0.82, 0.94].flatMap((z) => GEO.box(0.3, 0.05, 0.035, 0.08, z)) },
    // Aile droite, charnière à l'origine, plumes en éventail vers l'extérieur (+x) et l'arrière
    wing: { c: 'wing', g: () => [
      ...GEO.xf(GEO.ball(0.32, 0.2, 0.06, 0), M4.t(0.26, 0, 0)),
      ...[[0.95, 0.15, 0.32], [0.9, 0.03, 0.18], [0.82, -0.09, 0.04], [0.7, -0.21, -0.1], [0.56, -0.32, -0.22]]
        .flatMap(([len, ang, off]) => feather(len, 0.15, ang, off)),
    ] },
    shadow: HIKER_PARTS.shadow,
  };

  // Visuel qui suit la trace, au choix (gardé sur l'appareil)
  const AVATARS = [
    { id: 'hiker', label: 'Randonneur 3D' },
    { id: 'boot', label: 'Godillot ailé' },
    { id: 'dot', label: 'Point simple' },
  ];
  const AV_KEY = 'rt-fly-avatar';
  const loadAvatar = () => { try { const v = localStorage.getItem(AV_KEY); if (AVATARS.some((a) => a.id === v)) return v; } catch (e) { /* stockage bloqué */ } return 'hiker'; };
  const saveAvatar = (v) => { try { localStorage.setItem(AV_KEY, v); } catch (e) { /* stockage bloqué */ } };

  const hexRgb = (h) => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(h).trim());
    if (!m) return [0.53, 0.97, 0];
    const s = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
  };

  // Cap de marche au km d : direction de la trace autour du point
  const headingAt = (S, total, d) => {
    const w = clamp(total * 0.004, 0.015, 0.06);
    const a = Math.max(0, Math.min(d, total - w) - w), b = Math.min(total, Math.max(d, w) + w);
    return bearingOf(S.pos(a), S.pos(b));
  };

  // Couche : hikers = [{ color, pos(), heading(), grade(), moving() }]
  function hikerLayer(map, hikers, onReady) {
    let prog, parts, loc, last = 0, vaoExt;
    const st = hikers.map(() => ({ ph: 0, amp: 0, head: null, lean: 0, flap: 0 }));
    const VS = 'attribute vec3 aP;attribute vec3 aN;uniform mat4 uM;uniform mat4 uL;varying vec3 vN;void main(){vN=(uL*vec4(aN,0.)).xyz;gl_Position=uM*vec4(aP,1.);}';
    const FS = 'precision mediump float;varying vec3 vN;uniform vec4 uC;uniform vec3 uS;uniform float uF;void main(){vec3 n=normalize(vN);float d=max(dot(n,uS),0.);float r=pow(max(dot(n,normalize(uS+vec3(0.,0.,1.))),0.),12.);vec3 c=uC.rgb*(.42+.7*d)+vec3(r*.12);gl_FragColor=vec4(mix(c,uC.rgb,uF),uC.a);}';
    const palette = (shirt) => ({
      shirt: [...hexRgb(shirt), 1], pants: [0.24, 0.28, 0.33, 1], boot: [0.3, 0.2, 0.13, 1], skin: [0.88, 0.67, 0.52, 1],
      hat: [0.78, 0.69, 0.5, 1], pack: [0.85, 0.36, 0.16, 1], roll: [0.17, 0.32, 0.44, 1], pole: [0.72, 0.74, 0.76, 1], shadow: [0, 0, 0, 0.32],
      leather: [0.62, 0.4, 0.22, 1], cap: [0.38, 0.23, 0.12, 1], sole: [0.13, 0.11, 0.1, 1], lace: [...hexRgb(shirt), 1], wing: [0.97, 0.96, 0.93, 1],
    });
    const cols = hikers.map((h) => palette(h.color));

    function draw(gl, P, part, col, L) {
      const p = parts[part];
      const def = HIKER_PARTS[part] || BOOT_PARTS[part];
      gl.bindBuffer(gl.ARRAY_BUFFER, p.buf);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.uniformMatrix4fv(loc.uM, false, M4.mul(P, L));
      gl.uniformMatrix4fv(loc.uL, false, L);
      gl.uniform4fv(loc.uC, col[def.c]);
      gl.uniform1f(loc.uF, def.flat ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, p.count);
    }

    const layer = {
      id: 'hikers-3d', type: 'custom', renderingMode: '3d',
      mode: loadAvatar(),
      onAdd(m, gl) {
        const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
        prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
        gl.bindAttribLocation(prog, 0, 'aP');
        gl.bindAttribLocation(prog, 1, 'aN');
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('randonneur 3D : shader');
        loc = Object.fromEntries(['uM', 'uL', 'uC', 'uS', 'uF'].map((u) => [u, gl.getUniformLocation(prog, u)]));
        parts = {};
        for (const [k, def] of Object.entries({ ...HIKER_PARTS, ...BOOT_PARTS })) {
          const data = new Float32Array(def.g());
          const buf = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
          parts[k] = { buf, count: data.length / 6 };
        }
        if (!gl.bindVertexArray) vaoExt = gl.getExtension('OES_vertex_array_object');
        onReady && onReady();
      },
      render(gl, args) {
        if (layer.mode === 'dot') return;
        const boot = layer.mode === 'boot';
        const P = args?.defaultProjectionData?.mainMatrix || args?.modelViewProjectionMatrix || args;
        const now = performance.now();
        const dt = Math.min(0.1, (now - (last || now)) / 1000);
        last = now;
        const still = reduceMotion();
        const tr = map.transform;
        const zoom = map.getZoom();
        // Taille constante à l'écran (~ 60 à 80 px de haut), quel que soit le zoom
        const px = matchMedia('(max-width: 640px)').matches ? 60 : 78;
        let animating = false;

        if (gl.bindVertexArray) gl.bindVertexArray(null); else if (vaoExt) vaoExt.bindVertexArrayOES(null);
        gl.useProgram(prog);
        gl.enableVertexAttribArray(0);
        gl.enableVertexAttribArray(1);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        // Lumière venant de derrière la caméra, en hauteur : la face qu'on voit est toujours éclairée
        const cb = (map.getBearing() * Math.PI) / 180;
        const sun = [Math.cos(cb) * 0.35 - Math.sin(cb) * 0.55, -Math.sin(cb) * 0.35 - Math.cos(cb) * 0.55, 0.76];
        gl.uniform3fv(loc.uS, sun.map((x) => x / Math.hypot(...sun)));
        // Le randonneur passe devant le relief (pas coupé par une crête ou la pente sous ses pieds)
        gl.clear(gl.DEPTH_BUFFER_BIT);

        hikers.forEach((h, i) => {
          if (h.hidden && h.hidden()) return;
          const at = h.pos();
          const alt = map.queryTerrainElevation ? map.queryTerrainElevation(at) : 0;
          if (alt == null && map.getTerrain && map.getTerrain()) return;
          const s = st[i];
          const target = h.heading();
          if (s.head == null) s.head = target;
          s.head += angDiff(s.head, target) * (1 - Math.exp(-dt * 8));
          const moving = h.moving() && !still;
          s.amp += ((moving ? 1 : 0) - s.amp) * (1 - Math.exp(-dt * 6));
          if (moving) s.ph += dt * Math.PI * 2 * 1.05;
          // Penché en avant dans les montées, un peu en arrière dans les descentes raides
          const g = clamp(h.grade(), -30, 30);
          s.lean += ((g > 0 ? g * 0.012 : g * 0.006) + 0.04 * s.amp - s.lean) * (1 - Math.exp(-dt * 3));
          if (s.amp > 0.002 && s.amp < 0.998) animating = true;
          if (moving) animating = true;

          const mc = ML.MercatorCoordinate.fromLngLat(at, alt || 0);
          const mpp = (40075016.686 * Math.cos((at[1] * Math.PI) / 180)) / (512 * 2 ** zoom);
          const k = (px * mpp) / 1.9;
          const u = mc.meterInMercatorCoordinateUnits() * k;
          const W = M4.mul(P, M4.t(mc.x, mc.y, mc.z), M4.s(u, -u, u));
          const R = M4.rz((-s.head * Math.PI) / 180);
          const col = cols[i];
          const sw = Math.sin(s.ph), cw = Math.cos(s.ph), a = s.amp;

          // Ombre portée sous les pieds
          gl.depthMask(false); gl.disable(gl.DEPTH_TEST);
          draw(gl, W, 'shadow', col, R);
          gl.depthMask(true); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);

          if (boot) {
            // Vol stationnaire qui ondule ; battements plus rapides et plus amples en marche
            s.flap += dt * Math.PI * 2 * (still ? 0 : 0.7 + 1.6 * a);
            if (!still) animating = true;
            const fl = still ? 0.35 : 0.3 + (0.25 + 0.35 * a) * Math.sin(s.flap);
            const hover = 0.3 + (still ? 0 : 0.07 * Math.sin(s.flap + 1.2));
            const pitchUp = clamp(g, -25, 25) * 0.012;
            // Tourné de trois quarts (pointe vers la droite de l'écran) : la caméra suit de dos, on voit ainsi
            // la chaussure de profil plutôt qu'un simple talon
            const body = M4.mul(R, M4.t(0, 0, hover), M4.rz(-1.15), M4.s(1.3, 1.3, 1.3), M4.rx(pitchUp), M4.ry(0.05 * a * Math.sin(s.flap * 0.5)));
            ['sole', 'foot', 'toe', 'shaft', 'collar', 'tongue', 'laces'].forEach((pt) => draw(gl, W, pt, col, body));
            // Ailes accrochées de part et d'autre de la tige, l'une en miroir de l'autre
            [1, -1].forEach((side) => {
              const hinge = M4.mul(body, M4.t(side * 0.27, -0.36, 0.86), M4.s(side, 1, 1), M4.rz(-0.75), M4.ry(-fl));
              draw(gl, W, 'wing', col, hinge);
            });
            return;
          }
          const bob = 0.035 * a * Math.abs(cw);
          const pelvis = M4.mul(R, M4.t(0, 0, 0.98 + bob));
          [[-1, 1], [1, -1]].forEach(([side, sg]) => {
            const th = 0.42 * a * sw * sg;
            const kn = -(0.08 + 0.75 * a * Math.max(0, cw * sg));
            const hip = M4.mul(pelvis, M4.t(side * 0.095, 0, 0), M4.rx(th));
            const knee = M4.mul(hip, M4.t(0, 0, -0.47), M4.rx(kn));
            const ankle = M4.mul(knee, M4.t(0, 0, -0.45), M4.rx(-th - kn));
            draw(gl, W, 'thigh', col, hip);
            draw(gl, W, 'shin', col, knee);
            draw(gl, W, 'boot', col, ankle);
          });
          draw(gl, W, 'hips', col, pelvis);
          const torso = M4.mul(pelvis, M4.rx(-s.lean), M4.rz(0.06 * a * sw));
          draw(gl, W, 'torso', col, torso);
          draw(gl, W, 'skin', col, torso);
          draw(gl, W, 'hat', col, M4.mul(torso, M4.t(0, 0.01, 0), M4.rx(-0.06)));
          draw(gl, W, 'pack', col, torso);
          draw(gl, W, 'roll', col, M4.mul(torso, ROLL_AT));
          [[-1, -1], [1, 1]].forEach(([side, sg]) => {
            const ar = 0.38 * a * sw * sg + 0.12;
            const sh = M4.mul(torso, M4.t(side * 0.235, 0, 0.47), M4.ry(side * 0.08), M4.rx(ar));
            const el = M4.mul(sh, M4.t(0, 0, -0.29), M4.rx(0.55 + 0.15 * a * Math.max(0, sw * sg)));
            draw(gl, W, 'arm', col, sh);
            draw(gl, W, 'fore', col, el);
            // Bâton tenu dans la main, presque vertical, pointe un peu en arrière
            draw(gl, W, 'pole', col, M4.mul(el, M4.t(0, 0.01, -0.3), M4.rx(-(ar + 0.55) - 0.12 - 0.15 * a * sw * sg + s.lean)));
          });
        });

        gl.disableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        if (animating) map.triggerRepaint();
      },
      onRemove(m, gl) {
        if (!parts) return;
        Object.values(parts).forEach((p) => gl.deleteBuffer(p.buf));
        gl.deleteProgram(prog);
      },
    };
    return layer;
  }

  // Bouton « Visuel » de la barre + petit menu (randonneur 3D, godillot ailé ou point simple)
  function avatarButton() {
    const cur = loadAvatar();
    return `<div class="fo__av">
            <button type="button" class="fo__btn fo__btn--pill" data-fo="avatar" aria-haspopup="true" aria-expanded="false" aria-controls="fo-av-menu" title="Choisir ce qui suit la trace">${ICON.avatar}<span>Visuel</span></button>
            <div class="fo__av-menu fo__card" id="fo-av-menu" role="menu" aria-label="Ce qui suit la trace" hidden>
              ${AVATARS.map((v) => `<button type="button" role="menuitemradio" class="fo__av-item" data-avatar="${v.id}" aria-checked="${v.id === cur}">${ICON['av_' + v.id]}<span>${v.label}</span></button>`).join('')}
            </div>
          </div>`;
  }
  // walkers : éléments du point (repli si le 3D ne s'affiche pas) ; ready() : le calque 3D est prêt
  function wireAvatar(dlg, map, layer, walkers, ready) {
    const btn = dlg.querySelector('[data-fo="avatar"]'), menu = dlg.querySelector('#fo-av-menu');
    const show = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
    const apply = () => walkers().forEach((el) => el.classList.toggle('is-3d', ready() && layer.mode !== 'dot'));
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-fo="avatar"]')) { show(menu.hidden); if (!menu.hidden) menu.querySelector('[aria-checked="true"]')?.focus(); return; }
      const it = e.target.closest('[data-avatar]');
      if (it) {
        layer.mode = it.dataset.avatar; saveAvatar(layer.mode);
        menu.querySelectorAll('[data-avatar]').forEach((x) => x.setAttribute('aria-checked', String(x === it)));
        show(false); btn.focus(); apply(); map.triggerRepaint();
        return;
      }
      if (!menu.hidden && !e.target.closest('#fo-av-menu')) show(false);
    });
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); show(false); btn.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...menu.querySelectorAll('[data-avatar]')], i = items.indexOf(document.activeElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      }
    });
    return apply;
  }

  // ---------------------------------------------------------------- Interface
  const ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>',
    replay: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    cam: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    layers: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>',
    code: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/></svg>',
    ext: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    avatar: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="m10 21 2-7 3 3v4M9 11l3-3 3 2 2 1M12 8l-1 6"/></svg>',
    av_hiker: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="m10 21 2-7 3 3v4M9 11l3-3 3 2 2 1M12 8l-1 6M18 12v9"/></svg>',
    av_boot: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6v9H5a2 2 0 0 0-2 2v2h15a2 2 0 0 0 2-2c0-2-2-3-4-3h-2V6Z"/><path d="M13 8c3-3 6-4 8-4-1 2-3 4-6 6M13 11c3-1 5-1 7 0"/></svg>',
    av_dot: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".5"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    full: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  };

  // Boutons en haut à droite : fermer (sur le site) ou lien vers la fiche (survol intégré à un blog)
  function topActions(o) {
    if (o.embed) {
      return `<div class="fo__actions">
          ${document.fullscreenEnabled ? `<button type="button" class="fo__btn fo__btn--round" data-fo="full" aria-label="Plein écran" title="Plein écran">${ICON.full}</button>` : ''}
          ${o.link ? `<a class="fo__btn fo__btn--pill fo__btn--link" href="${esc(o.link)}" target="_blank" rel="noopener">${ICON.ext}<span>${esc(o.linkLabel || 'Voir la fiche')}</span></a>` : ''}
        </div>`;
    }
    return `<div class="fo__actions">
          ${o.embedCode ? `<button type="button" class="fo__btn fo__btn--pill" data-fo="embed" aria-expanded="false" aria-controls="fo-embed" title="Code HTML pour mettre ce survol 3D sur un blog">${ICON.code}<span>Intégrer</span></button>` : ''}
          <button type="button" class="fo__btn fo__btn--round" data-fo="close" aria-label="Fermer le survol 3D">${ICON.close}</button>
        </div>`;
  }
  // Panneau « Intégrer à un blog » : code iframe à copier (Blogger : vue HTML du message)
  function embedPanel(o) {
    if (o.embed || !o.embedCode) return '';
    return `<section class="fo__embed fo__card" id="fo-embed" aria-labelledby="fo-embed-title" hidden>
        <h3 class="fo__embed-title" id="fo-embed-title">Mettre ce survol 3D sur un blog</h3>
        <ol class="fo__embed-steps">
          <li>Dans Blogger, ouvrez le message et passez en <strong>Vue HTML</strong> (icône <code>&lt;&gt;</code> en haut à gauche de l'éditeur).</li>
          <li>Collez le code à l'endroit voulu, puis publiez. Le survol démarre quand le lecteur clique dessus.</li>
        </ol>
        <label class="fo__embed-label" for="fo-embed-code">Code HTML à copier</label>
        <textarea class="fo__embed-code" id="fo-embed-code" rows="5" readonly spellcheck="false">${esc(o.embedCode)}</textarea>
        <div class="fo__embed-foot">
          <p class="fo__embed-status" id="fo-embed-status" role="status" aria-live="polite"></p>
          <button type="button" class="fo__btn fo__btn--pill fo__btn--accent" data-fo="copy">${ICON.code}<span>Copier le code</span></button>
        </div>
      </section>`;
  }

  function shellHtml(o) {
    return `
      <div class="fo__map" id="fo-map" role="region" aria-label="Carte en relief du parcours"></div>
      <div class="fo__loading" id="fo-loading">${window.rtHiker ? window.rtHiker() : '<span class="fo__spinner" aria-hidden="true"></span>'}Chargement du relief…</div>
      <header class="fo__top">
        <div class="fo__card fo__title">
          <p class="fo__eyebrow">Survol 3D</p>
          <h2 class="fo__name" id="fo-title">${esc(o.title)}</h2>
          ${o.place ? `<p class="fo__place">${esc(o.place)}</p>` : ''}
        </div>
        ${topActions(o)}
      </header>
      ${embedPanel(o)}
      ${o.commune || o.weather ? `<div class="fo__card fo__info" id="fo-info"${o.commune ? '' : ' hidden'}>
        <p class="fo__wx" id="fo-wx" hidden></p>
        ${o.commune ? `<p class="fo__loc">${ICON.pin}<span>${esc(o.commune)}</span></p>` : ''}
      </div>` : ''}
      <dl class="fo__hud fo__card" aria-live="off">
        <div><dt>Distance</dt><dd><b id="fo-d">0,0</b> <small><span class="fo__of">/ ${nf1.format(o.total)}</span> km</small></dd></div>
        <div><dt>Altitude</dt><dd><b id="fo-e">–</b> <small>m</small></dd></div>
        <div><dt>Dénivelé +</dt><dd><b id="fo-u">0</b> <small>m</small></dd></div>
        <div><dt>Pente</dt><dd><b id="fo-g">0</b> <small>%</small></dd></div>
        ${o.durationMin ? `<div class="fo__hud-time"><dt>Temps de marche</dt><dd><b id="fo-t">0 min</b></dd></div>` : ''}
      </dl>
      <div class="fo__bottom">
        <div class="fo__bar">
          <button type="button" class="fo__btn fo__btn--play" data-fo="play" aria-label="Lecture">${ICON.play}</button>
          <button type="button" class="fo__btn fo__btn--round" data-fo="replay" aria-label="Recommencer depuis le départ" title="Recommencer">${ICON.replay}</button>
          <div class="fo__speed" role="group" aria-label="Vitesse de l'animation">
            ${[0.5, 1, 2, 4].map((s) => `<button type="button" class="fo__chip" data-speed="${s}" aria-pressed="${s === 1}">×${String(s).replace('.', ',')}</button>`).join('')}
          </div>
          <span class="fo__spacer"></span>
          <button type="button" class="fo__btn fo__btn--pill" data-fo="follow" hidden>${ICON.cam}<span>Suivre la trace</span></button>
          ${avatarButton()}
          <button type="button" class="fo__btn fo__btn--pill" data-fo="base" aria-label="Changer de fond de carte">${ICON.layers}<span id="fo-base-label">Carte</span></button>
        </div>
        <div class="fo__profile" id="fo-profile" role="slider" tabindex="0" aria-label="Position sur le profil de l'étape"
             aria-valuemin="0" aria-valuemax="${o.total.toFixed(1)}" aria-valuenow="0" aria-valuetext="0 km"></div>
        <ul class="fo__legend" aria-label="Légende des pentes">
          ${SLOPES.map((s) => `<li><i style="background:${s.color}"></i>${s.label}</li>`).join('')}<li><i style="background:${DESCENT}"></i>Descente</li>
        </ul>
      </div>`;
  }

  // ---------------------------------------------------------------- Profil d'étape (SVG)
  function profileView(box, T, S, runs, onSeek) {
    let W = 0, H = 0, x, y, mask, cur, dot, lastD = 0;
    function render() {
      W = Math.round(box.clientWidth); H = Math.round(box.clientHeight);
      if (W < 50 || H < 40) return;
      const L = 38, R = 10, TOP = 22, B = 18;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < T.n; i++) { lo = Math.min(lo, T.ele[i]); hi = Math.max(hi, T.ele[i]); }
      const pad = Math.max(15, (hi - lo) * 0.12);
      const min = Math.floor((lo - pad) / 10) * 10, max = Math.ceil((hi + pad * 0.5) / 10) * 10;
      x = (d) => L + (d / T.total) * (W - L - R);
      y = (e) => TOP + (1 - (e - min) / (max - min)) * (H - TOP - B);
      const base = H - B;
      const every = Math.max(1, Math.round(T.n / (W * 1.5)));
      const ptsBetween = (a, b) => {
        const out = [`${x(a).toFixed(1)},${y(S.ele(a)).toFixed(1)}`];
        for (let i = Math.ceil(a / T.step); i * T.step < b; i += every) out.push(`${x(T.km[i]).toFixed(1)},${y(T.ele[i]).toFixed(1)}`);
        out.push(`${x(b).toFixed(1)},${y(S.ele(b)).toFixed(1)}`);
        return out;
      };
      let bars = '', labels = '';
      // Mêmes tronçons et mêmes couleurs que la trace sur la carte
      for (const r of runs) {
        const a = T.km[r.a], b = T.km[r.b];
        const g = ((T.sm[r.b] - T.sm[r.a]) / ((b - a) * 1000)) * 100;
        const p = ptsBetween(a, b);
        bars += `<polygon points="${x(a).toFixed(1)},${base} ${p.join(' ')} ${x(b).toFixed(1)},${base}" fill="${r.c}"/>`;
        if (x(b) - x(a) >= 24 && Math.abs(g) >= 2) labels += `<text class="fo-p-pct" x="${((x(a) + x(b)) / 2).toFixed(1)}" y="${base - 5}" text-anchor="middle">${g > 0 ? '' : '−'}${nf0.format(Math.abs(g))}</text>`;
      }
      const line = `M${ptsBetween(0, T.total).join('L')}`;
      const kStep = (() => { const target = (W - L - R) / 46; for (const s of [0.5, 1, 2, 5, 10, 20]) if (T.total / s <= target) return s; return 50; })();
      let ticks = '';
      for (let k = 0; k <= T.total + 1e-6; k += kStep) ticks += `<line class="fo-p-tick" x1="${x(k)}" x2="${x(k)}" y1="${base}" y2="${base + 4}"/><text class="fo-p-axis" x="${x(k)}" y="${H - 3}" text-anchor="middle">${Number.isInteger(+k.toFixed(6)) ? Math.round(k) : nf1.format(k)}</text>`;
      // Point culminant et altitudes de départ / arrivée
      let top = 0;
      for (let i = 1; i < T.n; i++) if (T.ele[i] > T.ele[top]) top = i;
      const tx = clamp(x(T.km[top]), L + 30, W - R - 30);
      const summit = `<path class="fo-p-summit" d="M${x(T.km[top])},${y(T.ele[top]) - 4}l-4,-7h8z"/><text class="fo-p-alt" x="${tx}" y="${Math.max(10, y(T.ele[top]) - 13)}" text-anchor="middle">${nf0.format(T.ele[top])} m</text>`;
      box.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
          <line class="fo-p-grid" x1="${L}" x2="${W - R}" y1="${y(min + (max - min) / 2)}" y2="${y(min + (max - min) / 2)}"/>
          <text class="fo-p-axis" x="${L - 5}" y="${y(max) + 9}" text-anchor="end">${nf0.format(max)}</text>
          <text class="fo-p-axis" x="${L - 5}" y="${base}" text-anchor="end">${nf0.format(min)}</text>
          <g>${bars}</g>
          <path class="fo-p-line" d="${line}"/>
          <g>${labels}</g>
          ${summit}
          <line class="fo-p-base" x1="${L}" x2="${W - R}" y1="${base}" y2="${base}"/>
          ${ticks}
          <rect class="fo-p-mask" id="fo-mask" x="${L}" y="0" width="${W - L - R}" height="${base}"/>
          <line class="fo-p-cur" id="fo-cur" x1="${L}" x2="${L}" y1="${TOP - 6}" y2="${base}"/>
          <circle class="fo-p-dot" id="fo-dot" cx="${L}" cy="${y(T.ele[0])}" r="5"/>
        </svg>`;
      mask = box.querySelector('#fo-mask'); cur = box.querySelector('#fo-cur'); dot = box.querySelector('#fo-dot');
      box._L = L; box._R = R;
      set(lastD);
    }
    function set(d) {
      lastD = d;
      if (!mask) return;
      const px = x(d);
      mask.setAttribute('x', px.toFixed(1)); mask.setAttribute('width', Math.max(0, W - box._R - px).toFixed(1));
      cur.setAttribute('x1', px.toFixed(1)); cur.setAttribute('x2', px.toFixed(1));
      dot.setAttribute('cx', px.toFixed(1)); dot.setAttribute('cy', y(S.ele(d)).toFixed(1));
    }
    const toKm = (clientX) => {
      const r = box.getBoundingClientRect();
      return clamp(((clientX - r.left - box._L) / (r.width - box._L - box._R)) * T.total, 0, T.total);
    };
    let dragging = false;
    box.addEventListener('pointerdown', (e) => { dragging = true; box.setPointerCapture(e.pointerId); onSeek(toKm(e.clientX), true); });
    box.addEventListener('pointermove', (e) => { if (dragging) onSeek(toKm(e.clientX), true); });
    const stop = () => { if (dragging) { dragging = false; onSeek(null, false); } };
    box.addEventListener('pointerup', stop);
    box.addEventListener('pointercancel', stop);
    const ro = new ResizeObserver(() => { render(); });
    ro.observe(box);
    render();
    return { set, render, destroy: () => ro.disconnect() };
  }

  // ---------------------------------------------------------------- Lecteur
  function open(o) {
    if (!ML) throw new Error('MapLibre indisponible');
    const T = prepare(o.track.map((p) => p.slice()), o.dplus);
    const S = sampler(T);
    const total = T.total;
    const fr = o.inFrance;
    const color = o.color || cssVar('--c-accent', '#87f700');
    const bgColor = cssVar('--c-bg', '#0b0f0a');

    const dlg = document.createElement('dialog');
    dlg.className = o.embed ? 'fo fo--embed' : 'fo';
    dlg.setAttribute('aria-labelledby', 'fo-title');
    dlg.innerHTML = shellHtml({ ...o, total });
    // Intégré à un blog : le lecteur ne se ferme pas (Échap laisserait une page vide)
    if (o.embed) dlg.addEventListener('cancel', (e) => e.preventDefault());
    document.body.appendChild(dlg);
    dlg.showModal();
    const $ = (s) => dlg.querySelector(s);
    // Météo du jour de la rando (assets/meteo.js) : picto et température, dans le coin de l'écran
    if (o.weather) {
      Promise.resolve(o.weather).then(async (w) => {
        const box = $('#fo-wx');
        if (!w || !box || !dlg.isConnected) return;
        const img = window.RTMeteo && window.RTMeteo.pictoImage ? await window.RTMeteo.pictoImage(w.kind, 96) : null;
        if (img) { img.className = 'fo__wx-ico'; img.alt = ''; img.width = 34; img.height = 34; box.append(img); }
        box.insertAdjacentHTML('beforeend', `<b>${nf0.format(w.tmax)}°</b><small>${esc(w.label)}</small>`);
        box.title = `${w.status === 'forecast' ? 'Prévision' : 'Météo'} du jour : ${w.label}, ${nf0.format(w.tmin)}° à ${nf0.format(w.tmax)}°`;
        box.setAttribute('aria-label', box.title);
        box.hidden = false; $('#fo-info').hidden = false;
      }, () => {});
    }

    // Rythme : environ 20 s + 2,5 s par km, entre 25 et 75 s en vitesse ×1
    const baseDuration = clamp(20 + total * 2.5, 25, 75);
    const zoom = clamp(15.6 - Math.log2(Math.max(total, 1) / 4) * 0.45, 13.3, 15.6);
    const pitch = 62;
    const look = clamp(total * 0.04, 0.15, 0.6);
    const lineCoords = Array.from({ length: T.n }, (_, i) => [T.lon[i], T.lat[i]]);
    const runs = slopeRuns(T, S);
    const bounds = lineCoords.reduce((b, c) => b.extend(c), new ML.LngLatBounds(lineCoords[0], lineCoords[0]));

    let base = 'photo';
    let map;
    try {
      map = new ML.Map({
        container: $('#fo-map'),
        style: {
          version: 8,
          sources: {
            base: { type: 'raster', tileSize: 256, ...BASES.photo(fr) },
            dem: DEM,
            hs: (({ attribution, ...rest }) => rest)(DEM),
            route: { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: lineCoords } } },
            done: { type: 'geojson', data: slopeDone(T, S, runs, 1e-4) },
          },
          layers: [
            { id: 'bg', type: 'background', paint: { 'background-color': bgColor } },
            { id: 'base', type: 'raster', source: 'base', paint: { 'raster-fade-duration': 200 } },
            { id: 'hs', type: 'hillshade', source: 'hs', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': 'rgba(0,0,0,0.55)', 'hillshade-highlight-color': 'rgba(255,255,255,0.15)' } },
            { id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000', 'line-opacity': 0.35, 'line-width': 6 } },
            { id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': 0.55, 'line-width': 2.5, 'line-dasharray': [1.5, 1.5] } },
            { id: 'done-glow', type: 'line', source: 'done', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-opacity': 0.45, 'line-width': 14, 'line-blur': 8 } },
            { id: 'done-casing', type: 'line', source: 'done', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': bgColor, 'line-width': 7.5 } },
            { id: 'done', type: 'line', source: 'done', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': 5 } },
          ],
          terrain: { source: 'dem', exaggeration: 1.5 },
          sky: {
            'sky-color': '#5b9bd5', 'horizon-color': '#d8e6f2', 'fog-color': '#c9d6e3',
            'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.25, 'atmosphere-blend': 0.8,
          },
        },
        bounds, fitBoundsOptions: { padding: 60 },
        pitch: 40, maxPitch: 80,
        keyboard: false, attributionControl: { compact: true },
        fadeDuration: 150, antialias: true,
      });
    } catch (e) {
      $('#fo-loading').innerHTML = 'Le survol 3D nécessite WebGL, indisponible sur cet appareil.';
      dlg.addEventListener('close', () => dlg.remove(), { once: true });
      return;
    }
    map.addControl(new ML.NavigationControl({ visualizePitch: true, showZoom: true }), 'top-right');

    // Bornes kilométriques, départ, arrivée, randonneur
    const mk = (html, cls, at, anchor = 'bottom') => {
      const el = document.createElement('div'); el.className = cls; el.innerHTML = html;
      return new ML.Marker({ element: el, anchor }).setLngLat(at).addTo(map);
    };
    const kmEvery = total <= 25 ? 1 : total <= 60 ? 2 : 5;
    const bornes = [];
    for (let k = kmEvery; k < total - kmEvery * 0.35; k += kmEvery) {
      const m = mk(`<span class="fo-borne__cap"></span><span class="fo-borne__num">${k}</span>`, 'fo-borne', S.pos(k));
      m.getElement().setAttribute('aria-label', `Borne du kilomètre ${k}`);
      bornes.push({ k, el: m.getElement(), on: false });
    }
    mk('<span>D</span>', 'fo-flag fo-flag--start', S.pos(0)).getElement().title = 'Départ';
    if (!o.loop) mk('<span>A</span>', 'fo-flag fo-flag--end', S.pos(total)).getElement().title = 'Arrivée';
    const walker = mk('<span class="fo-walker__pulse"></span><span class="fo-walker__dot"></span>', 'fo-walker', S.pos(0), 'center');
    walker.getElement().style.setProperty('--fo-c', color);
    let ready3d = false;
    const hiker3d = hikerLayer(map, [{
      color, pos: () => S.pos(d), heading: () => headingAt(S, total, d), grade: () => S.grade(d),
      moving: () => phase === 'run' && playing && d < total,
      hidden: () => phase === 'outro' || phase === 'done',
    }], () => { ready3d = true; applyAvatar(); });
    const applyAvatar = wireAvatar(dlg, map, hiker3d, () => [walker.getElement()], () => ready3d);

    // État de lecture
    let d = 0, speed = 1, playing = false, phase = 'intro', follow = true, raf = 0, last = 0, hudAt = 0;
    let cam = { c: S.pos(0), b: bearingOf(S.pos(0), S.pos(look)) };
    const playBtn = $('[data-fo="play"]'), followBtn = $('[data-fo="follow"]');
    const setPlayUi = () => { playBtn.innerHTML = playing ? ICON.pause : ICON.play; playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Lecture'); };

    const profile = profileView($('#fo-profile'), T, S, runs, (km, active) => {
      if (km == null) return;
      seek(km);
    });
    const padBottom = () => {
      const h = Math.round($('.fo__bottom').getBoundingClientRect().height);
      dlg.style.setProperty('--fo-bottom-h', `${h}px`);
      const top = $('.fo__title');
      if (top) dlg.style.setProperty('--fo-top-h', `${Math.round(top.getBoundingClientRect().bottom - dlg.getBoundingClientRect().top)}px`);
      const hud = matchMedia('(max-width: 640px)').matches ? $('.fo__hud').getBoundingClientRect().height + 8 : 0;
      return Math.round(h * 0.85 + hud);
    };

    function camTarget(dd) {
      const here = S.pos(dd);
      const b = bearingOf(S.pos(Math.max(0, dd - look * 0.3)), S.pos(Math.min(total, dd + look)));
      return { here, b };
    }
    function updateHud(force) {
      const now = performance.now();
      if (!force && now - hudAt < 90) return;
      hudAt = now;
      $('#fo-d').textContent = nf1.format(d);
      $('#fo-e').textContent = nf0.format(S.ele(d));
      $('#fo-u').textContent = nf0.format(S.up(d));
      const g = S.grade(d);
      $('#fo-g').textContent = `${g < -0.5 ? '−' : ''}${nf0.format(Math.abs(g))}`;
      $('#fo-g').style.color = Math.abs(g) < 0.5 ? '' : slopeColor(g);
      if (o.durationMin) $('#fo-t').textContent = fmtDur((o.durationMin * d) / total);
      const pr = $('#fo-profile');
      pr.setAttribute('aria-valuenow', d.toFixed(1));
      pr.setAttribute('aria-valuetext', `${nf1.format(d)} km, ${nf0.format(S.ele(d))} m d'altitude`);
    }
    function draw(force) {
      map.getSource('done')?.setData(slopeDone(T, S, runs, Math.max(d, 1e-4)));
      walker.setLngLat(S.pos(d));
      profile.set(d);
      for (const b of bornes) {
        const on = d >= b.k;
        if (on !== b.on) { b.on = on; b.el.classList.toggle('is-on', on); }
      }
      updateHud(force);
    }
    function placeCamera(dt, snap) {
      if (!follow) return;
      const t = camTarget(d);
      if (snap) cam = { c: t.here, b: t.b };
      else {
        const kc = 1 - Math.exp(-dt * 4), kb = 1 - Math.exp(-dt * 1.3);
        cam.c = [cam.c[0] + (t.here[0] - cam.c[0]) * kc, cam.c[1] + (t.here[1] - cam.c[1]) * kc];
        cam.b += angDiff(cam.b, t.b) * kb;
      }
      map.jumpTo({ center: cam.c, bearing: cam.b, zoom, pitch });
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now;
      if (phase === 'run' && playing) {
        d = Math.min(total, d + (dt * total * speed) / baseDuration);
        draw();
        placeCamera(dt);
        if (d >= total) finish();
      }
      // (pas de rotation finale : la trace reste cadrée plein écran)
    }
    // Vue d'ensemble finale : bornes et randonneur masqués pour laisser voir toute la trace
    const endView = (on) => { dlg.classList.toggle('fo--end', on); map.triggerRepaint(); };
    function finish() {
      phase = 'outro';
      endView(true);
      updateHud(true);
      const end = endCamera();
      if (end) map.easeTo({ ...end, duration: reduceMotion() ? 0 : 3500, essential: true });
      else map.fitBounds(bounds, { padding: 40, pitch: 55, bearing: cam.b, duration: reduceMotion() ? 0 : 3500, essential: true });
      // Une fois arrivé, le relief réel est chargé : on mesure la trace à l'écran et on corrige le cadrage
      let fixes = 0;
      const settle = () => {
        if (phase !== 'outro') return;
        const f = fixes++ < 3 && fitCorrection();
        if (f) { map.easeTo({ ...f, duration: reduceMotion() ? 0 : 700, essential: true }); map.once('moveend', settle); }
        else phase = 'done';
      };
      map.once('moveend', settle);
    }
    // Zone libre de la carte (entre le titre et les commandes) et points de la trace pour la mesurer
    function freeArea() {
      const box = dlg.getBoundingClientRect(), m = 14;
      let bottom = $('.fo__bottom').getBoundingClientRect().top - box.top;
      if (matchMedia('(max-width: 640px)').matches) bottom = Math.min(bottom, $('.fo__hud').getBoundingClientRect().top - box.top);
      return { W: box.width, H: box.height, l: m, r: box.width - m, t: $('.fo__top').getBoundingClientRect().bottom - box.top + m, b: bottom - m };
    }
    let fitPts = null;
    function measure(area) {
      if (!fitPts) {
        const every = Math.max(1, Math.floor(T.n / 400));
        fitPts = [];
        for (let i = 0; i < T.n; i += every) fitPts.push([T.lon[i], T.lat[i]]);
        fitPts.push([T.lon[T.n - 1], T.lat[T.n - 1]]);
      }
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of fitPts) {
        const q = map.project(p);
        if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
      }
      return {
        fill: Math.min((area.r - area.l) / Math.max(1, x1 - x0), (area.b - area.t) / Math.max(1, y1 - y0)),
        dx: (area.l + area.r) / 2 - (x0 + x1) / 2, dy: (area.t + area.b) / 2 - (y0 + y1) / 2,
      };
    }
    // Petit recadrage depuis la vue actuelle, ou null si la trace remplit déjà la zone
    function fitCorrection() {
      try {
        const area = freeArea(), me = measure(area);
        if (Math.abs(Math.log2(me.fill)) < 0.04 && Math.abs(me.dx) < 8 && Math.abs(me.dy) < 8) return null;
        const pad = map.getPadding();
        const mid = [(pad.left + area.W - pad.right) / 2, (pad.top + area.H - pad.bottom) / 2];
        return { center: map.unproject([mid[0] - me.dx, mid[1] - me.dy]), zoom: clamp(map.getZoom() + Math.log2(me.fill) * 0.95, 3, 17) };
      } catch (e) { return null; }
    }
    // Cadrage final : la trace remplit toute la zone visible de la carte (entre le titre et les commandes),
    // mesurée à l'écran avec la perspective et le relief, puis ajustée en quelques passes
    function endCamera() {
      try {
        const area = freeArea();
        if (area.r - area.l < 80 || area.b - area.t < 80) return null;
        const pad = map.getPadding();
        const mid = [(pad.left + area.W - pad.right) / 2, (pad.top + area.H - pad.bottom) / 2];
        const saved = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
        const pitchEnd = 55, bearing = cam.b;
        const start = map.cameraForBounds(bounds, { padding: 20, bearing, pitch: 0 });
        let center = start ? start.center : saved.center, z = start ? start.zoom : saved.zoom;
        for (let k = 0; k < 6; k++) {
          map.jumpTo({ center, zoom: z, bearing, pitch: pitchEnd });
          const me = measure(area);
          if (Math.abs(Math.log2(me.fill)) < 0.01 && Math.abs(me.dx) < 2 && Math.abs(me.dy) < 2) break;
          center = map.unproject([mid[0] - me.dx, mid[1] - me.dy]);
          z = clamp(z + Math.log2(me.fill) * 0.9, 3, 17);
        }
        map.jumpTo(saved);
        return { center, zoom: z, bearing, pitch: pitchEnd };
      } catch (e) { return null; }
    }
    function startRun() {
      phase = 'run'; follow = true; followBtn.hidden = true; endView(false);
      placeCamera(0, true);
    }
    function intro() {
      const t = camTarget(0);
      cam = { c: t.here, b: t.b };
      if (reduceMotion()) { startRun(); playing = false; setPlayUi(); draw(true); return; }
      phase = 'intro'; endView(false);
      map.flyTo({ center: t.here, bearing: t.b, zoom, pitch, duration: 3200, curve: 1.3, essential: true });
      map.once('moveend', () => { if (phase === 'intro') startRun(); });
    }
    function seek(km) {
      map.stop();
      d = clamp(km, 0, total);
      if (phase !== 'run') { phase = 'run'; endView(false); }
      if (d >= total) { draw(true); finish(); return; }
      draw(true);
      if (follow) placeCamera(0, true);
    }
    function toggle() {
      if (phase === 'done' || (phase === 'outro')) { if (d >= total) { replay(); return; } }
      playing = !playing; setPlayUi();
      if (playing && phase === 'run' && follow) placeCamera(0, true);
    }
    function replay() {
      map.stop();
      d = 0; draw(true);
      follow = true; followBtn.hidden = true;
      playing = true; setPlayUi();
      intro();
    }

    // Interactions
    map.on('movestart', (e) => {
      if (!e.originalEvent) return;
      if (phase === 'run' || phase === 'intro') { follow = false; followBtn.hidden = false; if (phase === 'intro') { map.stop(); phase = 'run'; } }
      if (phase === 'done') { playing = false; setPlayUi(); }
    });
    dlg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fo], [data-speed]');
      if (!b) return;
      if (b.dataset.speed) {
        speed = Number(b.dataset.speed);
        dlg.querySelectorAll('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        return;
      }
      const a = b.dataset.fo;
      if (a === 'close') dlg.close();
      else if (a === 'embed') {
        const panel = $('#fo-embed');
        panel.hidden = !panel.hidden;
        b.setAttribute('aria-expanded', String(!panel.hidden));
        if (!panel.hidden) { $('#fo-embed-status').textContent = ''; $('#fo-embed-code').select(); o.onEmbed && o.onEmbed(); }
      } else if (a === 'copy') {
        const area = $('#fo-embed-code');
        (navigator.clipboard ? navigator.clipboard.writeText(area.value) : Promise.reject())
          .catch(() => { area.select(); document.execCommand('copy'); })
          .then(() => { $('#fo-embed-status').textContent = 'Code copié ! Collez-le dans la vue HTML du message.'; });
      } else if (a === 'full') {
        if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
      }
      else if (a === 'play') toggle();
      else if (a === 'replay') replay();
      else if (a === 'follow') { follow = true; followBtn.hidden = true; map.stop(); const t = camTarget(d); map.easeTo({ center: t.here, bearing: t.b, zoom, pitch, duration: 900 }); cam = { c: t.here, b: t.b }; }
      else if (a === 'base') {
        base = base === 'photo' ? 'plan' : 'photo';
        map.removeLayer('base'); map.removeSource('base');
        map.addSource('base', { type: 'raster', tileSize: 256, ...BASES[base](fr) });
        map.addLayer({ id: 'base', type: 'raster', source: 'base' }, 'hs');
        $('#fo-base-label').textContent = base === 'photo' ? 'Carte' : 'Satellite';
      }
    });
    dlg.addEventListener('keydown', (e) => {
      if (e.target.closest('textarea, a')) return;
      if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); toggle(); }
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.target.closest('.maplibregl-canvas')) {
        e.preventDefault(); seek(d + (e.key === 'ArrowRight' ? 1 : -1) * Math.max(0.1, total * 0.02));
      }
    });

    map.on('load', () => {
      $('#fo-loading').hidden = true;
      try { map.addLayer(hiker3d); } catch (e) { /* le point reste affiché */ }
      map.setPadding({ top: 40, bottom: padBottom(), left: 0, right: 0 });
      draw(true);
      playing = !reduceMotion();
      setPlayUi();
      setTimeout(intro, 500);
      raf = requestAnimationFrame(frame);
    });
    map.on('error', (e) => { if (!map.loaded() && /style|webgl/i.test(String(e.error?.message))) $('#fo-loading').textContent = 'Carte 3D indisponible.'; });
    const onResize = () => map.setPadding({ top: 40, bottom: padBottom(), left: 0, right: 0 });
    window.addEventListener('resize', onResize);

    dlg.addEventListener('close', () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      profile.destroy();
      map.remove();
      dlg.remove();
      o.onClose && o.onClose();
    }, { once: true });
  }

  // ---------------------------------------------------------------- Duel : deux randos en même temps sur la même carte
  // Chaque randonneur avance selon son temps de marche estimé (DIN 33466 : plus lent en montée),
  // recalé sur la durée de sa fiche : à la même minute, on voit où en est chacun.
  function timeline(T, durationMin) {
    const tm = new Float64Array(T.n);
    for (let i = 1; i < T.n; i++) {
      const h = (T.km[i] - T.km[i - 1]) / 4;
      const dz = T.sm[i] - T.sm[i - 1];
      const v = dz > 0 ? dz / 300 : -dz / 500;
      tm[i] = tm[i - 1] + (Math.max(h, v) + Math.min(h, v) / 2) * 60;
    }
    const end = tm[T.n - 1] || 1;
    const k = durationMin ? durationMin / end : 1;
    for (let i = 0; i < T.n; i++) tm[i] *= k;
    const kmAt = (t) => {
      if (t <= 0) return 0;
      if (t >= tm[T.n - 1]) return T.total;
      let lo = 0, hi = T.n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tm[mid] < t) lo = mid; else hi = mid; }
      const f = tm[hi] > tm[lo] ? (t - tm[lo]) / (tm[hi] - tm[lo]) : 0;
      return T.km[lo] + (T.km[hi] - T.km[lo]) * f;
    };
    return { tm, end: tm[T.n - 1], kmAt };
  }
  const fmtClock = (min) => { const m = Math.round(min); const h = Math.floor(m / 60); return h ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${m} min`; };
  const distKm = (a, b) => {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };

  function duelShellHtml(R, far) {
    const card = (r, i) => `
      <div class="fo__card fo-duel__hud" style="--fo-c:${r.color}">
        <p class="fo-duel__who"><i aria-hidden="true"></i><span>${esc(r.title)}</span><em class="fo-duel__done" id="fo-done-${i}" hidden>Arrivée</em></p>
        <dl>
          <div><dt>Distance</dt><dd><b id="fo-d-${i}">0,0</b> <small>/ ${nf1.format(r.T.total)} km</small></dd></div>
          <div><dt>Altitude</dt><dd><b id="fo-e-${i}">–</b> <small>m</small></dd></div>
          <div><dt>Dénivelé +</dt><dd><b id="fo-u-${i}">0</b> <small>m</small></dd></div>
        </dl>
      </div>`;
    return `
      <div class="fo__map" id="fo-map" role="region" aria-label="Carte en relief des deux parcours"></div>
      <div class="fo__loading" id="fo-loading">${window.rtHiker ? window.rtHiker() : '<span class="fo__spinner" aria-hidden="true"></span>'}Chargement du relief…</div>
      <header class="fo__top">
        <div class="fo__card fo__title">
          <p class="fo__eyebrow">Survol 3D · duel</p>
          <h2 class="fo__name" id="fo-title">${R.map((r) => esc(r.title)).join(' <span class="fo-duel__vs">vs</span> ')}</h2>
          <p class="fo__place">Départ en même temps, au rythme du temps de marche estimé${far ? ` · ${nf0.format(far)} km entre les deux` : ''}</p>
        </div>
        <button type="button" class="fo__btn fo__btn--round" data-fo="close" aria-label="Fermer le survol 3D">${ICON.close}</button>
      </header>
      <div class="fo-duel__huds" aria-live="off">${R.map(card).join('')}</div>
      <div class="fo__bottom">
        <div class="fo__bar">
          <button type="button" class="fo__btn fo__btn--play" data-fo="play" aria-label="Lecture">${ICON.play}</button>
          <button type="button" class="fo__btn fo__btn--round" data-fo="replay" aria-label="Recommencer depuis le départ" title="Recommencer">${ICON.replay}</button>
          <div class="fo__speed" role="group" aria-label="Vitesse de l'animation">
            ${[0.5, 1, 2, 4].map((s) => `<button type="button" class="fo__chip" data-speed="${s}" aria-pressed="${s === 1}">×${String(s).replace('.', ',')}</button>`).join('')}
          </div>
          <p class="fo-duel__clock"><small>Temps de marche</small><b id="fo-clock">0 min</b></p>
          <span class="fo__spacer"></span>
          <div class="fo__speed fo-duel__cams" role="group" aria-label="Caméra">
            <button type="button" class="fo__chip" data-cam="both" aria-pressed="true" title="Cadrer les deux randonneurs">Les deux</button>
            ${R.map((r, i) => `<button type="button" class="fo__chip fo-duel__cam" data-cam="${i}" aria-pressed="false" style="--fo-c:${r.color}" title="Suivre ${esc(r.title)}"><i aria-hidden="true"></i><span>Suivre</span></button>`).join('')}
          </div>
          ${avatarButton()}
          <button type="button" class="fo__btn fo__btn--pill" data-fo="base" aria-label="Changer de fond de carte">${ICON.layers}<span id="fo-base-label">Carte</span></button>
        </div>
        <div class="fo__profile" id="fo-profile" role="slider" tabindex="0" aria-label="Temps de marche écoulé"
             aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="0 min"></div>
      </div>`;
  }

  // Profils des deux randos sur un axe commun du temps de marche
  function duelProfileView(box, R, totalT, onSeek) {
    let W = 0, H = 0, x, mask, cur, dots = [], ys = [], lastT = 0;
    const L = 38, RR = 10, TOP = 14, B = 18;
    function render() {
      W = Math.round(box.clientWidth); H = Math.round(box.clientHeight);
      if (W < 50 || H < 40) return;
      let lo = Infinity, hi = -Infinity;
      for (const r of R) for (let i = 0; i < r.T.n; i++) { lo = Math.min(lo, r.T.ele[i]); hi = Math.max(hi, r.T.ele[i]); }
      const pad = Math.max(15, (hi - lo) * 0.1);
      const min = Math.floor((lo - pad) / 10) * 10, max = Math.ceil((hi + pad * 0.5) / 10) * 10;
      x = (t) => L + (t / totalT) * (W - L - RR);
      const y = (e) => TOP + (1 - (e - min) / (max - min)) * (H - TOP - B);
      const base = H - B;
      ys = R.map((r) => (t) => y(r.S.ele(r.tl.kmAt(t))));
      const every = (r) => Math.max(1, Math.round(r.T.n / (W * 1.5)));
      const lines = R.map((r, k) => {
        const pts = [];
        for (let i = 0; i < r.T.n; i += every(r)) pts.push(`${x(r.tl.tm[i]).toFixed(1)},${y(r.T.ele[i]).toFixed(1)}`);
        pts.push(`${x(r.tl.end).toFixed(1)},${y(r.T.ele[r.T.n - 1]).toFixed(1)}`);
        return `<path d="M${pts.join('L')}L${x(r.tl.end).toFixed(1)},${base}L${L},${base}Z" fill="${r.color}" fill-opacity="0.16"/>
          <path class="fo-duel__line" d="M${pts.join('L')}" stroke="${r.color}"/>
          <line x1="${x(r.tl.end).toFixed(1)}" x2="${x(r.tl.end).toFixed(1)}" y1="${TOP}" y2="${base}" stroke="${r.color}" stroke-dasharray="3 3" stroke-opacity="0.8"/>`;
      }).join('');
      const hStep = [15, 30, 60, 120, 180].find((s) => totalT / s <= (W - L - RR) / 60) || 240;
      let ticks = '';
      for (let t = 0; t <= totalT + 1e-6; t += hStep) ticks += `<line class="fo-p-tick" x1="${x(t)}" x2="${x(t)}" y1="${base}" y2="${base + 4}"/><text class="fo-p-axis" x="${x(t)}" y="${H - 3}" text-anchor="middle">${t ? fmtClock(t).replace(' ', '') : '0'}</text>`;
      box.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
          <text class="fo-p-axis" x="${L - 5}" y="${y(max) + 9}" text-anchor="end">${nf0.format(max)}</text>
          <text class="fo-p-axis" x="${L - 5}" y="${base}" text-anchor="end">${nf0.format(min)}</text>
          ${lines}
          <line class="fo-p-base" x1="${L}" x2="${W - RR}" y1="${base}" y2="${base}"/>
          ${ticks}
          <rect class="fo-p-mask" id="fo-mask" x="${L}" y="0" width="${W - L - RR}" height="${base}"/>
          <line class="fo-duel__cur" id="fo-cur" x1="${L}" x2="${L}" y1="${TOP - 6}" y2="${base}"/>
          ${R.map((r, i) => `<circle class="fo-p-dot" id="fo-dot-${i}" style="fill:${r.color}" cx="${L}" cy="${y(r.T.ele[0])}" r="5"/>`).join('')}
        </svg>`;
      mask = box.querySelector('#fo-mask'); cur = box.querySelector('#fo-cur');
      dots = R.map((_, i) => box.querySelector(`#fo-dot-${i}`));
      set(lastT);
    }
    function set(t) {
      lastT = t;
      if (!mask) return;
      const px = x(t);
      mask.setAttribute('x', px.toFixed(1)); mask.setAttribute('width', Math.max(0, W - RR - px).toFixed(1));
      cur.setAttribute('x1', px.toFixed(1)); cur.setAttribute('x2', px.toFixed(1));
      R.forEach((r, i) => {
        const tt = Math.min(t, r.tl.end);
        dots[i].setAttribute('cx', x(tt).toFixed(1)); dots[i].setAttribute('cy', ys[i](tt).toFixed(1));
      });
    }
    const toT = (clientX) => {
      const r = box.getBoundingClientRect();
      return clamp(((clientX - r.left - L) / (r.width - L - RR)) * totalT, 0, totalT);
    };
    let dragging = false;
    box.addEventListener('pointerdown', (e) => { dragging = true; box.setPointerCapture(e.pointerId); onSeek(toT(e.clientX)); });
    box.addEventListener('pointermove', (e) => { if (dragging) onSeek(toT(e.clientX)); });
    const stop = () => { dragging = false; };
    box.addEventListener('pointerup', stop);
    box.addEventListener('pointercancel', stop);
    const ro = new ResizeObserver(() => render());
    ro.observe(box);
    render();
    return { set, destroy: () => ro.disconnect() };
  }

  function duel(o) {
    if (!ML) throw new Error('MapLibre indisponible');
    const R = o.racers.slice(0, 2).map((r) => {
      const T = prepare(r.track.map((p) => p.slice()), r.dplus);
      return { ...r, T, S: sampler(T), tl: timeline(T, r.durationMin) };
    });
    const totalT = Math.max(...R.map((r) => r.tl.end));
    const maxKm = Math.max(...R.map((r) => r.T.total));
    const fr = R.every((r) => r.inFrance);
    const bgColor = cssVar('--c-bg', '#0b0f0a');
    const gap = distKm(R[0].S.pos(0), R[1].S.pos(0));

    const dlg = document.createElement('dialog');
    dlg.className = 'fo fo--duel';
    dlg.setAttribute('aria-labelledby', 'fo-title');
    dlg.innerHTML = duelShellHtml(R, gap >= 15 ? gap : 0);
    document.body.appendChild(dlg);
    dlg.showModal();
    const $ = (s) => dlg.querySelector(s);
    $('#fo-profile').setAttribute('aria-valuemax', String(Math.round(totalT)));

    const baseDuration = clamp(22 + maxKm * 2.6, 28, 90);
    const zoomOne = clamp(15.6 - Math.log2(Math.max(maxKm, 1) / 4) * 0.45, 13.3, 15.6);
    const pitch = 60;
    const coords = R.map((r) => Array.from({ length: r.T.n }, (_, i) => [r.T.lon[i], r.T.lat[i]]));
    const all = coords.flat();
    const bounds = all.reduce((b, c) => b.extend(c), new ML.LngLatBounds(all[0], all[0]));

    const sources = {
      base: { type: 'raster', tileSize: 256, ...BASES.photo(fr) },
      dem: DEM,
      hs: (({ attribution, ...rest }) => rest)(DEM),
    };
    const layers = [
      { id: 'bg', type: 'background', paint: { 'background-color': bgColor } },
      { id: 'base', type: 'raster', source: 'base', paint: { 'raster-fade-duration': 200 } },
      { id: 'hs', type: 'hillshade', source: 'hs', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': 'rgba(0,0,0,0.55)', 'hillshade-highlight-color': 'rgba(255,255,255,0.15)' } },
    ];
    const lc = { 'line-cap': 'round', 'line-join': 'round' };
    R.forEach((r, i) => {
      sources[`route-${i}`] = { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords[i] } } };
      sources[`done-${i}`] = { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [coords[i][0], coords[i][0]] } } };
      layers.push(
        { id: `route-casing-${i}`, type: 'line', source: `route-${i}`, layout: lc, paint: { 'line-color': '#000', 'line-opacity': 0.3, 'line-width': 5 } },
        { id: `route-${i}`, type: 'line', source: `route-${i}`, layout: lc, paint: { 'line-color': r.color, 'line-opacity': 0.75, 'line-width': 2.2, 'line-dasharray': [1.5, 1.5] } },
      );
    });
    R.forEach((r, i) => layers.push(
      { id: `done-glow-${i}`, type: 'line', source: `done-${i}`, layout: lc, paint: { 'line-color': r.color, 'line-opacity': 0.45, 'line-width': 14, 'line-blur': 8 } },
      { id: `done-casing-${i}`, type: 'line', source: `done-${i}`, layout: lc, paint: { 'line-color': bgColor, 'line-width': 7.5 } },
      { id: `done-${i}`, type: 'line', source: `done-${i}`, layout: lc, paint: { 'line-color': r.color, 'line-width': 5 } },
    ));

    let base = 'photo';
    let map;
    try {
      map = new ML.Map({
        container: $('#fo-map'),
        style: {
          version: 8, sources, layers,
          terrain: { source: 'dem', exaggeration: 1.5 },
          sky: {
            'sky-color': '#5b9bd5', 'horizon-color': '#d8e6f2', 'fog-color': '#c9d6e3',
            'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.25, 'atmosphere-blend': 0.8,
          },
        },
        bounds, fitBoundsOptions: { padding: 60 },
        pitch: 40, maxPitch: 80,
        keyboard: false, attributionControl: { compact: true },
        fadeDuration: 150, antialias: true,
      });
    } catch (e) {
      $('#fo-loading').innerHTML = 'Le survol 3D nécessite WebGL, indisponible sur cet appareil.';
      dlg.addEventListener('close', () => dlg.remove(), { once: true });
      return;
    }
    map.addControl(new ML.NavigationControl({ visualizePitch: true, showZoom: true }), 'top-right');

    const mk = (html, cls, at, anchor = 'bottom', c) => {
      const el = document.createElement('div'); el.className = cls; el.innerHTML = html;
      if (c) el.style.setProperty('--fo-c', c);
      return new ML.Marker({ element: el, anchor }).setLngLat(at).addTo(map);
    };
    R.forEach((r) => {
      mk('<span>D</span>', 'fo-flag fo-duel__flag', r.S.pos(0), 'bottom', r.color).getElement().title = `Départ : ${r.title}`;
      if (!r.loop) mk('<span>A</span>', 'fo-flag fo-duel__flag fo-duel__flag--end', r.S.pos(r.T.total), 'bottom', r.color).getElement().title = `Arrivée : ${r.title}`;
      r.walker = mk('<span class="fo-walker__pulse"></span><span class="fo-walker__dot"></span>', 'fo-walker', r.S.pos(0), 'center', r.color);
    });
    const hiker3d = hikerLayer(map, R.map((r) => {
      const at = () => r.tl.kmAt(t);
      return {
        color: r.color, pos: () => r.S.pos(at()), heading: () => headingAt(r.S, r.T.total, at()), grade: () => r.S.grade(at()),
        moving: () => phase === 'run' && playing && t < r.tl.end,
      };
    }), () => { ready3d = true; applyAvatar(); });
    let ready3d = false;
    const applyAvatar = wireAvatar(dlg, map, hiker3d, () => R.map((r) => r.walker.getElement()), () => ready3d);

    // État : horloge commune (minutes de marche), caméra « les deux » ou qui suit l'un des deux
    let t = 0, speed = 1, playing = false, phase = 'intro', camMode = 'both', follow = true, raf = 0, last = 0, hudAt = 0;
    const kms = () => R.map((r) => r.tl.kmAt(t));
    let cam = null;
    const playBtn = $('[data-fo="play"]');
    const setPlayUi = () => { playBtn.innerHTML = playing ? ICON.pause : ICON.play; playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Lecture'); };
    const setCamUi = () => dlg.querySelectorAll('[data-cam]').forEach((b) => b.setAttribute('aria-pressed', String(follow && String(camMode) === b.dataset.cam)));

    const profile = duelProfileView($('#fo-profile'), R, totalT, (tt) => seek(tt));
    const padBottom = () => {
      const h = Math.round($('.fo__bottom').getBoundingClientRect().height);
      dlg.style.setProperty('--fo-bottom-h', `${h}px`);
      const top = $('.fo__title');
      if (top) dlg.style.setProperty('--fo-top-h', `${Math.round(top.getBoundingClientRect().bottom - dlg.getBoundingClientRect().top)}px`);
      const hud = matchMedia('(max-width: 640px)').matches ? $('.fo-duel__huds').getBoundingClientRect().height + 8 : 0;
      return Math.round(h * 0.85 + hud);
    };

    // Cible de la caméra : centre, cap et zoom
    function camTarget() {
      const ds = kms();
      if (camMode === 'both') {
        const ps = R.map((r, i) => r.S.pos(ds[i]));
        const b = new ML.LngLatBounds(ps[0], ps[0]).extend(ps[1]);
        // un peu de marge autour des randonneurs, même quand ils sont côte à côte
        const span = 0.004;
        b.extend([b.getWest() - span, b.getSouth() - span]).extend([b.getEast() + span, b.getNorth() + span]);
        const bearing = cam ? cam.b : bearingOf(R[0].S.pos(0), R[0].S.pos(Math.min(R[0].T.total, 0.5)));
        const c = map.cameraForBounds(b, { padding: { top: 120, bottom: 80, left: 60, right: 60 }, bearing, pitch: 0 });
        const z = c ? clamp(c.zoom + 0.6, 7, zoomOne) : zoomOne;
        const ctr = c ? [c.center.lng, c.center.lat] : ps[0];
        return { c: ctr, b: bearing, z };
      }
      const r = R[camMode], d = ds[camMode];
      const look = clamp(r.T.total * 0.04, 0.15, 0.6);
      return { c: r.S.pos(d), b: bearingOf(r.S.pos(Math.max(0, d - look * 0.3)), r.S.pos(Math.min(r.T.total, d + look))), z: zoomOne };
    }
    function placeCamera(dt, snap) {
      if (!follow) return;
      const tg = camTarget();
      if (snap || !cam) cam = { ...tg };
      else {
        const kc = 1 - Math.exp(-dt * 3), kb = 1 - Math.exp(-dt * 1.2), kz = 1 - Math.exp(-dt * 1.5);
        cam.c = [cam.c[0] + (tg.c[0] - cam.c[0]) * kc, cam.c[1] + (tg.c[1] - cam.c[1]) * kc];
        cam.z += (tg.z - cam.z) * kz;
        if (camMode === 'both') cam.b += dt * 3; // lente rotation pour voir le relief
        else cam.b += angDiff(cam.b, tg.b) * kb;
      }
      map.jumpTo({ center: cam.c, bearing: cam.b, zoom: cam.z, pitch });
    }
    function updateHud(force) {
      const now = performance.now();
      if (!force && now - hudAt < 90) return;
      hudAt = now;
      const ds = kms();
      R.forEach((r, i) => {
        $(`#fo-d-${i}`).textContent = nf1.format(ds[i]);
        $(`#fo-e-${i}`).textContent = nf0.format(r.S.ele(ds[i]));
        $(`#fo-u-${i}`).textContent = nf0.format(r.S.up(ds[i]));
        const done = t >= r.tl.end - 1e-6;
        const el = $(`#fo-done-${i}`);
        if (el.hidden === done) { el.hidden = !done; el.textContent = `Arrivée en ${fmtClock(r.tl.end)}`; }
      });
      $('#fo-clock').textContent = fmtClock(t);
      const pr = $('#fo-profile');
      pr.setAttribute('aria-valuenow', String(Math.round(t)));
      pr.setAttribute('aria-valuetext', `${fmtClock(t)} de marche`);
    }
    function draw(force) {
      const ds = kms();
      R.forEach((r, i) => {
        map.getSource(`done-${i}`)?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.S.coordsTo(Math.max(ds[i], 1e-4)) } });
        r.walker.setLngLat(r.S.pos(ds[i]));
      });
      profile.set(t);
      updateHud(force);
    }
    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now;
      if (phase === 'run' && playing) {
        t = Math.min(totalT, t + (dt * totalT * speed) / baseDuration);
        draw();
        placeCamera(dt);
        if (t >= totalT) finish();
      } else if (phase === 'done' && playing && !map.isMoving()) {
        map.setBearing(map.getBearing() + dt * 6);
      }
    }
    function finish() {
      phase = 'outro';
      updateHud(true);
      map.fitBounds(bounds, { padding: { top: 120, left: 50, right: 50, bottom: padBottom() + 20 }, pitch: 55, bearing: cam ? cam.b : 0, duration: reduceMotion() ? 0 : 3500, essential: true });
      map.once('moveend', () => { if (phase === 'outro') phase = 'done'; });
    }
    function startRun() { phase = 'run'; follow = true; setCamUi(); placeCamera(0, true); }
    function intro() {
      cam = null;
      const tg = camTarget();
      cam = { ...tg };
      if (reduceMotion()) { startRun(); playing = false; setPlayUi(); draw(true); return; }
      phase = 'intro';
      map.flyTo({ center: tg.c, bearing: tg.b, zoom: tg.z, pitch, duration: 3200, curve: 1.3, essential: true });
      map.once('moveend', () => { if (phase === 'intro') startRun(); });
    }
    function seek(tt) {
      map.stop();
      t = clamp(tt, 0, totalT);
      phase = 'run';
      if (t >= totalT) { draw(true); finish(); return; }
      draw(true);
      if (follow) placeCamera(0, true);
    }
    function toggle() {
      if ((phase === 'done' || phase === 'outro') && t >= totalT) { replay(); return; }
      playing = !playing; setPlayUi();
      if (playing && phase === 'run' && follow) placeCamera(0, true);
    }
    function replay() {
      map.stop();
      t = 0; draw(true);
      follow = true; setCamUi();
      playing = true; setPlayUi();
      intro();
    }

    map.on('movestart', (e) => {
      if (!e.originalEvent) return;
      if (phase === 'run' || phase === 'intro') { follow = false; setCamUi(); if (phase === 'intro') { map.stop(); phase = 'run'; } }
      if (phase === 'done') { playing = false; setPlayUi(); }
    });
    dlg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fo], [data-speed], [data-cam]');
      if (!b) return;
      if (b.dataset.speed) {
        speed = Number(b.dataset.speed);
        dlg.querySelectorAll('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        return;
      }
      if (b.dataset.cam) {
        camMode = b.dataset.cam === 'both' ? 'both' : Number(b.dataset.cam);
        follow = true; setCamUi();
        if (phase === 'done' || phase === 'outro') phase = 'run';
        map.stop();
        const tg = camTarget();
        if (cam && camMode === 'both') tg.b = cam.b;
        map.easeTo({ center: tg.c, bearing: tg.b, zoom: tg.z, pitch, duration: 900 });
        cam = { ...tg };
        return;
      }
      const a = b.dataset.fo;
      if (a === 'close') dlg.close();
      else if (a === 'play') toggle();
      else if (a === 'replay') replay();
      else if (a === 'base') {
        base = base === 'photo' ? 'plan' : 'photo';
        map.removeLayer('base'); map.removeSource('base');
        map.addSource('base', { type: 'raster', tileSize: 256, ...BASES[base](fr) });
        map.addLayer({ id: 'base', type: 'raster', source: 'base' }, 'hs');
        $('#fo-base-label').textContent = base === 'photo' ? 'Carte' : 'Satellite';
      }
    });
    dlg.addEventListener('keydown', (e) => {
      if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); toggle(); }
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.target.closest('.maplibregl-canvas')) {
        e.preventDefault(); seek(t + (e.key === 'ArrowRight' ? 1 : -1) * Math.max(1, totalT * 0.02));
      }
    });

    map.on('load', () => {
      $('#fo-loading').hidden = true;
      try { map.addLayer(hiker3d); } catch (e) { /* le point reste affiché */ }
      map.setPadding({ top: 40, bottom: padBottom(), left: 0, right: 0 });
      draw(true);
      playing = !reduceMotion();
      setPlayUi();
      setTimeout(intro, 500);
      raf = requestAnimationFrame(frame);
    });
    map.on('error', (e) => { if (!map.loaded() && /style|webgl/i.test(String(e.error?.message))) $('#fo-loading').textContent = 'Carte 3D indisponible.'; });
    const onResize = () => map.setPadding({ top: 40, bottom: padBottom(), left: 0, right: 0 });
    window.addEventListener('resize', onResize);

    dlg.addEventListener('close', () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      profile.destroy();
      map.remove();
      dlg.remove();
      o.onClose && o.onClose();
    }, { once: true });
  }

  window.RTFlyover = { open, duel };
})();
