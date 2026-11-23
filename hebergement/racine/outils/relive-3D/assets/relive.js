/* Outil « Relive 3D » : import d'un GPX, survol 3D (lecteur de la Randothèque), code d'intégration.
   Les calculs (distance, dénivelé, temps, simplification de la trace) reprennent ceux de scripts/lib/gpx.mjs
   des Randothèques, pour que le survol soit identique à celui d'une fiche. */
(() => {
  'use strict';
  const LIB = '../../godillots-ailes/assets/';
  const ML_VER = '4.7.1';
  const API = 'api.php';
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  const fmtDur = (min) => { const m = Math.round(min || 0); const h = Math.floor(m / 60); return h ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${m} min`; };

  // Couleurs de trace proposées : celles des niveaux de la Randothèque
  const COLORS = [
    ['', 'Couleur du site'], ['#4ade80', 'Vert'], ['#60a5fa', 'Bleu'], ['#facc15', 'Jaune'], ['#f87171', 'Rouge'], ['#f4f4f0', 'Blanc'],
  ];

  // ---------------------------------------------------------------- API
  async function api(action, { body, params = '' } = {}) {
    const res = await fetch(`${API}?a=${action}${params}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur du serveur (${res.status}).`);
    return data;
  }

  // ---------------------------------------------------------------- Lecture du GPX
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const haversine = (a, b) => {
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  function parseGpx(text) {
    const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length || !/gpx$/i.test(doc.documentElement.localName)) throw new Error('Ce fichier n\'est pas un GPX lisible.');
    const kids = (el, name) => Array.from(el.getElementsByTagNameNS('*', name));
    const txt = (el, name) => { const c = Array.from(el.children).find((x) => x.localName === name); return c ? c.textContent.trim() : ''; };
    const read = (els) => els.map((e) => {
      const ele = parseFloat(txt(e, 'ele')), time = Date.parse(txt(e, 'time'));
      return { lat: parseFloat(e.getAttribute('lat')), lon: parseFloat(e.getAttribute('lon')), ele: Number.isFinite(ele) ? ele : null, time: Number.isFinite(time) ? time : null };
    }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    let segments = kids(doc, 'trkseg').map((s) => read(kids(s, 'trkpt'))).filter((s) => s.length);
    if (!segments.length) segments = kids(doc, 'rte').map((r) => read(kids(r, 'rtept'))).filter((s) => s.length);
    if (!segments.length) throw new Error('Ce GPX ne contient aucune trace.');
    const meta = Array.from(doc.documentElement.children).find((x) => x.localName === 'metadata');
    const trk = kids(doc, 'trk')[0] || kids(doc, 'rte')[0];
    const name = (trk && txt(trk, 'name')) || (meta && txt(meta, 'name')) || '';
    const metaTime = meta ? Date.parse(txt(meta, 'time')) : NaN;
    return { name, segments, metaTime: Number.isFinite(metaTime) ? metaTime : null };
  }

  // Une seule polyligne, distance cumulée ; saut de plus de 300 m entre deux segments : non compté
  function flatten(segments) {
    const pts = [];
    let d = 0;
    for (const seg of segments) {
      seg.forEach((p, i) => {
        if (pts.length) { const step = haversine(pts[pts.length - 1], p); if (!(i === 0 && step > 300)) d += step; }
        pts.push({ ...p, d });
      });
    }
    return pts;
  }

  function elevationStats(pts, threshold = 3) {
    const w = pts.filter((p) => p.ele != null);
    if (w.length < Math.max(2, pts.length * 0.6)) return null;
    let lo = Infinity, hi = -Infinity;
    for (const p of w) { lo = Math.min(lo, p.ele); hi = Math.max(hi, p.ele); }
    if (hi - lo < 0.5 && pts[pts.length - 1].d > 1000) return null;
    const smooth = w.map((p, i) => {
      let s = 0, n = 0;
      for (let j = i; j >= 0 && p.d - w[j].d <= 30; j--) { s += w[j].ele; n++; }
      for (let j = i + 1; j < w.length && w[j].d - p.d <= 30; j++) { s += w[j].ele; n++; }
      return s / n;
    });
    let up = 0, down = 0, ref = smooth[0];
    for (const e of smooth) {
      if (e - ref >= threshold) { up += e - ref; ref = e; } else if (ref - e >= threshold) { down += ref - e; ref = e; }
    }
    return { dplus: Math.round(up), dminus: Math.round(down), altMin: Math.round(lo), altMax: Math.round(hi) };
  }

  // Norme DIN 33466 (comme les fiches) : 4 km/h à plat, 300 m/h en montée, 500 m/h en descente
  const estimateDurationMin = (km, up = 0, down = 0) => {
    const h1 = km / 4, h2 = up / 300 + down / 500;
    return Math.round(((Math.max(h1, h2) + Math.min(h1, h2) / 2) * 60) / 5) * 5;
  };

  // Temps de marche enregistré (pauses retirées : vitesse lissée sur 2 min sous 1 km/h)
  function movingMinutes(pts) {
    const t = pts.filter((p) => p.time);
    if (t.length < pts.length * 0.8 || t.length < 10) return null;
    const total = (t[t.length - 1].time - t[0].time) / 1000;
    if (!(total > 300 && total < 3 * 86400)) return null;
    let pause = 0, a = 0, b = 0;
    for (let i = 1; i < t.length; i++) {
      const dt = (t[i].time - t[i - 1].time) / 1000;
      if (dt <= 0) continue;
      while (a < i && (t[i].time - t[a].time) / 1000 > 60) a++;
      if (b < i) b = i;
      while (b < t.length - 1 && (t[b].time - t[i].time) / 1000 < 60) b++;
      const A = t[Math.max(0, a - 1)];
      const v = ((t[b].d - A.d) / ((t[b].time - A.time) / 1000 || 1)) * 3.6;
      if (v < 1) pause += dt;
    }
    return Math.round(Math.max(0, total - pause) / 60);
  }

  // Douglas-Peucker, jusqu'à tenir en maxPoints
  function simplify(pts, tol) {
    if (pts.length <= 2) return pts.slice();
    const lat0 = rad(pts[0].lat);
    const xy = pts.map((p) => [rad(p.lon) * Math.cos(lat0) * R, rad(p.lat) * R]);
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]], tol2 = tol * tol;
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
      let maxD = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const t = Math.max(0, Math.min(1, ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / len2));
        const ex = ax + t * dx - xy[i][0], ey = ay + t * dy - xy[i][1], d2 = ex * ex + ey * ey;
        if (d2 > maxD) { maxD = d2; idx = i; }
      }
      if (maxD > tol2) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  const simplifyTo = (pts, max, tol = 4) => { let out = simplify(pts, tol); while (out.length > max) { tol *= 1.6; out = simplify(pts, tol); } return out; };

  const parisDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

  // Altitudes absentes ou fictives (30 m partout) : relief IGN le long de la trace, comme la mise à jour des sites
  async function fillElevation(pts) {
    const sample = simplifyTo(pts, 600, 3);
    const z = [];
    for (let i = 0; i < sample.length; i += 150) {
      const c = sample.slice(i, i + 150);
      const url = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json'
        + `?lon=${c.map((p) => p.lon.toFixed(6)).join('|')}&lat=${c.map((p) => p.lat.toFixed(6)).join('|')}`
        + '&resource=ign_rge_alti_wld&zonly=true&delimiter=|';
      const res = await fetch(url);
      if (!res.ok) return null;
      z.push(...(await res.json()).elevations.map((e) => (typeof e === 'number' ? e : e.z)));
    }
    if (z.some((e) => e == null || e < -1000)) return null;
    return sample.map((p, i) => ({ ...p, ele: z[i] }));
  }

  async function analyse(text, fileName) {
    const g = parseGpx(text);
    let pts = flatten(g.segments);
    if (pts.length < 2 || pts[pts.length - 1].d < 50) throw new Error('La trace est trop courte pour un survol.');
    let ele = elevationStats(pts);
    if (!ele) {
      const filled = await fillElevation(pts).catch(() => null);
      if (filled) { pts = filled; ele = elevationStats(pts); }
    }
    const km = pts[pts.length - 1].d / 1000;
    const start = pts[0], end = pts[pts.length - 1];
    const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
    const S = Math.min(...lats), N = Math.max(...lats), W = Math.min(...lons), E = Math.max(...lons);
    const t0 = (pts.find((p) => p.time) || {}).time || null;
    const moving = movingMinutes(pts);
    const track = simplifyTo(pts, 1500).map((p) => {
      const row = [+p.lat.toFixed(5), +p.lon.toFixed(5), p.ele == null ? null : Math.round(p.ele), +(p.d / 1000).toFixed(3)];
      if (t0) row.push(p.time ? Math.round((p.time - t0) / 1000) : null);
      return row;
    });
    const dateMs = t0 || g.metaTime;
    return {
      fileName,
      track,
      info: {
        name: g.name || fileName.replace(/\.gpx$/i, '').replace(/[_-]+/g, ' ').trim(),
        date: dateMs ? parisDate(dateMs) : '',
        distanceKm: +km.toFixed(2),
        dplus: ele ? ele.dplus : null, dminus: ele ? ele.dminus : null,
        altMin: ele ? ele.altMin : null, altMax: ele ? ele.altMax : null,
        durationMin: moving || estimateDurationMin(km, ele ? ele.dplus : 0, ele ? ele.dminus : 0),
        recorded: !!moving,
        loop: haversine(start, end) < Math.max(250, km * 1000 * 0.03),
        inFrance: S > 41 && N < 51.2 && W > -5.3 && E < 9.7,
        start: [+start.lat.toFixed(5), +start.lon.toFixed(5)],
        commune: '', place: '', color: '',
      },
    };
  }

  // Commune du départ : Géoplateforme IGN en France, Nominatim ailleurs (seule la position du départ part)
  async function reverseGeocode([lat, lon], inFrance) {
    try {
      if (inFrance) {
        const r = await fetch(`https://data.geopf.fr/geocodage/reverse?lon=${lon}&lat=${lat}&index=address&limit=1`).then((x) => x.json());
        const p = r.features && r.features[0] && r.features[0].properties;
        if (p && p.city) { const dept = (p.context || '').split(',')[1]; return { commune: p.city, place: [p.city, dept && dept.trim()].filter(Boolean).join(', ') }; }
      }
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=fr&lat=${lat}&lon=${lon}`).then((x) => x.json());
      const a = r.address || {};
      const commune = a.village || a.town || a.city || a.municipality || '';
      return commune ? { commune, place: [commune, a.county || a.state, inFrance ? '' : a.country].filter(Boolean).join(', ') } : null;
    } catch { return null; }
  }

  // ---------------------------------------------------------------- Lecteur 3D (celui de la Randothèque)
  const load = (url, css) => new Promise((resolve, reject) => {
    const el = document.createElement(css ? 'link' : 'script');
    if (css) { el.rel = 'stylesheet'; el.href = url; } else { el.src = url; }
    el.onload = resolve;
    el.onerror = () => reject(new Error(`chargement impossible : ${url}`));
    document.head.appendChild(el);
  });
  let playerP = null;
  const loadPlayer = () => (playerP = playerP || Promise.all([
    load(`https://unpkg.com/maplibre-gl@${ML_VER}/dist/maplibre-gl.css`, true),
    load(`${LIB}flyover.css?v=18`, true),
    load(`https://unpkg.com/maplibre-gl@${ML_VER}/dist/maplibre-gl.js`).then(() => load(`${LIB}flyover.js?v=17`)),
    window.RTMeteo ? null : load(`${LIB}meteo.js?v=3`).catch(() => null),
  ]).catch((e) => { playerP = null; throw e; }));

  async function preview(it, track, btn) {
    const label = btn && $('.btn__label', btn);
    const before = label && label.textContent;
    if (btn) { btn.disabled = true; if (label) label.textContent = 'Chargement…'; }
    try {
      await loadPlayer();
      window.RTFlyover.open({
        embedCode: it.id ? embedCode(it) : null,
        track: track.map((p) => p.slice()), title: it.name || 'Randonnée', place: it.place || it.commune || '',
        commune: it.commune, weather: window.RTMeteo && it.date && it.start ? window.RTMeteo.summary(it) : null,
        color: it.color || undefined, inFrance: !!it.inFrance,
        loop: it.loop, dplus: it.dplus, durationMin: it.durationMin,
      });
    } catch {
      toast('Le survol 3D n\'a pas pu se charger. Vérifiez la connexion internet puis réessayez.', true);
    } finally {
      if (btn) { btn.disabled = false; if (label) label.textContent = before; }
    }
  }

  // ---------------------------------------------------------------- Code d'intégration (comme le bouton « Intégrer » des fiches)
  const pageUrl = (it) => new URL(`survol.html?id=${encodeURIComponent(it.id)}&t=${encodeURIComponent(it.name)}`, location.href).href;
  const embedCode = (it) => `<iframe src="${esc(pageUrl(it))}" title="Survol 3D : ${esc(it.name)}" width="100%" height="540" loading="lazy" allow="fullscreen" allowfullscreen style="border:0;display:block;width:100%;max-width:960px;height:540px;margin:1em auto;border-radius:12px;"></iframe>`;

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    const label = $('.btn__label', btn) || btn;
    const before = label.textContent;
    label.textContent = 'Copié !';
    setTimeout(() => { label.textContent = before; }, 1800);
  }

  // ---------------------------------------------------------------- Interface

  const stats = (it) => [
    it.distanceKm != null ? `${nf1.format(it.distanceKm)} km` : '',
    it.dplus != null ? `${nf0.format(it.dplus)} m D+` : '',
    it.durationMin ? `${fmtDur(it.durationMin)}${it.recorded ? '' : ' (estimé)'}` : '',
    it.loop ? 'Boucle' : 'Aller simple',
  ].filter(Boolean);

  let toastTimer = 0;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('is-error', isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }


  // ---- Import
  let draft = null; // { fileName, gpx, track, info }
  const drop = $('#drop'), fileInput = $('#file');

  async function readFile(file) {
    const err = $('#drop-err');
    err.textContent = '';
    if (!file) return;
    if (!/\.gpx$/i.test(file.name) && !/gpx/i.test(file.type)) { err.textContent = 'Choisissez un fichier .gpx.'; return; }
    if (file.size > 15 * 1024 * 1024) { err.textContent = 'Ce fichier dépasse 15 Mo.'; return; }
    try {
      const gpx = await file.text();
      err.textContent = 'Lecture du GPX…'; err.classList.add('is-info');
      const a = await analyse(gpx, file.name);
      err.textContent = '';
      draft = { ...a, gpx };
      fillForm(a.info);
      $('#draft-form').hidden = false;
      $('#result').hidden = true;
      $('#f-name').focus();
      reverseGeocode(a.info.start, a.info.inFrance).then((g) => {
        if (!g || !draft || draft.info !== a.info) return;
        if (!$('#f-commune').value) $('#f-commune').value = g.commune;
        if (!$('#f-place').value) $('#f-place').value = g.place;
      });
    } catch (ex) { err.textContent = ex.message || 'Ce fichier n\'a pas pu être lu.'; } finally { err.classList.remove('is-info'); }
  }
  fileInput.addEventListener('change', () => { readFile(fileInput.files[0]); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('is-over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); readFile(e.dataTransfer.files[0]); });

  $('#f-color').innerHTML = COLORS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  function fillForm(info) {
    $('#f-name').value = info.name || '';
    $('#f-date').value = info.date || '';
    $('#f-commune').value = info.commune || '';
    $('#f-place').value = info.place || '';
    $('#f-color').value = info.color || '';
    $('#draft-file').textContent = draft.fileName;
    $('#draft-stats').innerHTML = stats(info).map((s) => `<li>${esc(s)}</li>`).join('');
  }
  const formInfo = () => ({
    name: $('#f-name').value.trim(), date: $('#f-date').value, commune: $('#f-commune').value.trim(),
    place: $('#f-place').value.trim(), color: $('#f-color').value,
  });
  $('#draft-preview').addEventListener('click', (e) => draft && preview({ ...draft.info, ...formInfo() }, draft.track, e.currentTarget));
  $('#draft-cancel').addEventListener('click', () => { draft = null; $('#draft-form').hidden = true; drop.focus(); });
  $('#draft-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!draft) return;
    const name = $('#f-name');
    if (!name.value.trim()) { name.setAttribute('aria-invalid', 'true'); name.focus(); return; }
    name.removeAttribute('aria-invalid');
    const btn = $('#draft-save');
    btn.disabled = true; $('.btn__label', btn).textContent = 'Enregistrement…';
    try {
      const { item } = await api('save', { body: { gpx: draft.gpx, fileName: draft.fileName, track: draft.track, info: { ...draft.info, ...formInfo() } } });
      draft = null;
      $('#draft-form').hidden = true;
      showResult(item);
    } catch (ex) { toast(ex.message, true); } finally {
      btn.disabled = false; $('.btn__label', btn).textContent = 'Enregistrer et obtenir le code';
    }
  });

  function showResult(it) {
    const box = $('#result');
    $('#result-name').textContent = it.name;
    $('#result-code').value = embedCode(it);
    $('#result-open').href = pageUrl(it);
    box.hidden = false;
    box.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
    $('#result-copy').focus();
  }
  $('#result-copy').addEventListener('click', (e) => copy($('#result-code').value, e.currentTarget));
})();
