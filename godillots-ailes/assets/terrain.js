/* Randothèque – mode terrain (même fichier dans les deux sites).
   - Plein écran : carte, trace, position GPS en direct, km parcourus et restants, dénivelé restant,
     arrivée estimée comparée au coucher du soleil, alerte (vibration) si l'on s'écarte de la trace.
   - « Emporter hors ligne » : met de côté la fiche, la trace et le fond de carte IGN autour du parcours
     (zooms 11 à 16) pour tout rouvrir sans réseau. Le service worker (sw.js) les sert ensuite d'abord
     depuis l'appareil. Une rando emportée occupe environ 3 à 10 Mo ; « Retirer » libère la place.
   Utilisation par app.js : RTTerrain.init(outils), RTTerrain.button(r), RTTerrain.open(id). */
(() => {
  'use strict';

  const SITE = location.pathname.replace(/[^/]*$/, '');      // /godillots-ailes/ ou /gerard-martine/
  const PREFIX = `rt-terrain:${SITE}:`;                       // un cache par rando emportée
  const SHELL = `rt-terrain-shell:${SITE}`;                    // pages, scripts et données du site
  const TZ = 'Europe/Paris';
  const OFF_TRACK_M = 70;                                      // au-delà (plus la précision du GPS) : hors trace
  const hm = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const hhmm = (ms) => hm.format(new Date(ms)).replace(':', 'h');
  const nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hasCaches = 'caches' in window && window.isSecureContext;
  let T = null; // outils fournis par app.js

  // ------------------------------------------------------------ Randos emportées
  const saved = new Set();
  async function refreshSaved() {
    saved.clear();
    if (!hasCaches) return saved;
    try { for (const k of await caches.keys()) if (k.startsWith(PREFIX)) saved.add(k.slice(PREFIX.length)); } catch { /* indisponible */ }
    document.dispatchEvent(new CustomEvent('terrain:saved', { detail: { ids: [...saved] } }));
    return saved;
  }

  // Tuiles (x, y) couvrant une zone, au zoom z (schéma Web Mercator, comme Leaflet)
  const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2y = (lat, z) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  };
  function tilesFor(track, bbox) {
    const out = new Set();
    const [s, w, n, e] = bbox;
    const padLat = 0.012, padLon = 0.016; // ~1,3 km autour du parcours
    for (let z = 11; z <= 14; z++) {
      for (let x = lon2x(w - padLon, z); x <= lon2x(e + padLon, z); x++) {
        for (let y = lat2y(n + padLat, z); y <= lat2y(s - padLat, z); y++) out.add(`${z}/${x}/${y}`);
      }
    }
    // Zooms 15 et 16 : seulement un couloir d'environ 300 m de chaque côté de la trace
    const dLat = 0.0027, dLon = 0.0037;
    let last = null;
    for (const p of track) {
      if (last && Math.abs(p[0] - last[0]) < 0.0004 && Math.abs(p[1] - last[1]) < 0.0005) continue;
      last = p;
      for (const z of [15, 16]) {
        for (let x = lon2x(p[1] - dLon, z); x <= lon2x(p[1] + dLon, z); x++) {
          for (let y = lat2y(p[0] + dLat, z); y <= lat2y(p[0] - dLat, z); y++) out.add(`${z}/${x}/${y}`);
        }
      }
    }
    return [...out].map((k) => k.split('/').map(Number));
  }
  const tileUrl = (tpl, [z, x, y]) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a');

  // Fichiers du site nécessaires pour rouvrir la Randothèque sans réseau
  function shellUrls() {
    const urls = new Set([new URL('./', location.href).href]);
    for (const el of document.querySelectorAll('script[src], link[rel="stylesheet"][href], link[rel="manifest"][href], link[rel="icon"][href]')) {
      const u = new URL(el.src || el.href, location.href);
      if (u.origin === location.origin || u.hostname === 'unpkg.com') urls.add(u.href);
    }
    return [...urls];
  }

  async function saveOffline(r, track, onProgress) {
    if (!hasCaches) throw new Error('Mise hors ligne impossible sur ce navigateur.');
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await T.ensureLeaflet();
    const shell = await caches.open(SHELL);
    await Promise.all(shellUrls().map((u) => shell.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    const cache = await caches.open(PREFIX + r.id);
    await cache.add(new Request(new URL(T.trackUrl(r.id), location.href).href, { cache: 'reload' }));
    const tiles = r.region ? tilesFor(track, r.bbox) : [];
    let done = 0, bytes = 0, failed = 0;
    const queue = tiles.slice();
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift();
        const url = tileUrl(T.tileTemplate, t);
        try {
          const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
          if (!res.ok) throw new Error(res.status);
          const blob = await res.clone().blob();
          bytes += blob.size;
          await cache.put(url, res);
        } catch { failed++; }
        done++;
        onProgress(done, tiles.length, bytes);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (tiles.length && failed > tiles.length * 0.2) {
      await caches.delete(PREFIX + r.id);
      throw new Error('Trop de morceaux de carte n\'ont pas pu être téléchargés. Vérifiez la connexion puis réessayez.');
    }
    localStorageSet(`rt-terrain-size:${SITE}${r.id}`, String(bytes));
    await refreshSaved();
    return { tiles: tiles.length, bytes, noMap: !r.region };
  }
  async function removeOffline(id) {
    if (hasCaches) await caches.delete(PREFIX + id);
    await refreshSaved();
  }
  function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* indisponible */ } }
  function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  const fmtMo = (b) => `${nf1.format(Math.max(0.1, b / 1048576))} Mo`;

  // ------------------------------------------------------------ Géométrie de la trace
  // Projection locale en mètres, distance cumulée (km, déjà dans la trace) et dénivelés cumulés
  function prepare(track) {
    const lat0 = track[0][0] * Math.PI / 180;
    const kx = 111320 * Math.cos(lat0), ky = 110540;
    const xs = new Float64Array(track.length), ys = new Float64Array(track.length);
    const up = new Float64Array(track.length), down = new Float64Array(track.length);
    let ref = null, u = 0, d = 0;
    track.forEach((p, i) => {
      xs[i] = p[1] * kx; ys[i] = p[0] * ky;
      if (p[2] != null) {
        if (ref == null) ref = p[2];
        else if (p[2] - ref >= 3) { u += p[2] - ref; ref = p[2]; }
        else if (ref - p[2] >= 3) { d += ref - p[2]; ref = p[2]; }
      }
      up[i] = u; down[i] = d;
    });
    return { track, xs, ys, up, down, kx, ky, total: track[track.length - 1][3], upTotal: u, downTotal: d };
  }
  // Point de la trace le plus proche (projection sur les segments), en privilégiant la suite du chemin
  function locate(G, lat, lon, lastIdx) {
    const px = lon * G.kx, py = lat * G.ky;
    const near = (i0, i1) => {
      let best = { d: Infinity, i: 0, t: 0 };
      for (let i = Math.max(0, i0); i < Math.min(G.xs.length - 1, i1); i++) {
        const ax = G.xs[i], ay = G.ys[i], bx = G.xs[i + 1], by = G.ys[i + 1];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
        const ex = ax + t * dx - px, ey = ay + t * dy - py, dist = Math.hypot(ex, ey);
        if (dist < best.d) best = { d: dist, i, t };
      }
      return best;
    };
    let b = lastIdx != null ? near(lastIdx - 30, lastIdx + 250) : null;
    if (!b || b.d > 60) {
      const g = near(0, G.xs.length);
      if (!b || g.d < b.d - 15) b = g;
    }
    const p0 = G.track[b.i], p1 = G.track[b.i + 1] || p0;
    return {
      dist: b.d, idx: b.i,
      km: p0[3] + (p1[3] - p0[3]) * b.t,
      up: G.up[b.i] + (G.up[b.i + 1] - G.up[b.i]) * b.t,
      down: G.down[b.i] + (G.down[b.i + 1] - G.down[b.i]) * b.t,
    };
  }
  // Temps de marche (norme DIN 33466) puis pauses au rythme des sorties enregistrées
  function remainingMin(km, up, down) {
    const h = km / 4, v = up / 300 + down / 500;
    const walk = (Math.max(h, v) + Math.min(h, v) / 2) * 60;
    return walk + (window.RTMeteo ? window.RTMeteo.pausesFor(walk) : walk * 0.1);
  }

  // ------------------------------------------------------------ Vue plein écran
  let view = null;
  function buildDialog() {
    const dlg = document.createElement('dialog');
    dlg.className = 'terrain';
    dlg.setAttribute('aria-labelledby', 'terrain-title');
    dlg.innerHTML = `
      <div class="terrain__bar">
        <button type="button" class="terrain__close" data-t-close aria-label="Quitter le mode terrain">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="terrain__heading"><h2 id="terrain-title" class="terrain__title"></h2><p class="terrain__gps" data-t-gps role="status">GPS en attente…</p></div>
      </div>
      <div class="terrain__map" data-t-map></div>
      <div class="terrain__alert" data-t-alert role="alert" hidden></div>
      <button type="button" class="terrain__follow" data-t-follow aria-pressed="true" title="Garder ma position au centre">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/></svg>
        <span class="visually-hidden">Me suivre</span>
      </button>
      <section class="terrain__sheet" aria-label="Où j'en suis">
        <dl class="terrain__stats">
          <div><dt>Parcouru</dt><dd data-t="done">–</dd></div>
          <div><dt>Reste</dt><dd data-t="left">–</dd></div>
          <div><dt>D+ restant</dt><dd data-t="up">–</dd></div>
          <div><dt>Arrivée vers</dt><dd data-t="eta">–</dd></div>
        </dl>
        <p class="terrain__sun" data-t-sun></p>
        <div class="terrain__offline" data-t-offline></div>
        <label class="terrain__wake"><input type="checkbox" data-t-wake> Garder l'écran allumé</label>
      </section>`;
    document.body.appendChild(dlg);
    return dlg;
  }

  async function open(id) {
    const r = T.getR(id);
    if (!r) return;
    T.stat('terrain', r.name, r.id);
    if (!view) view = { dlg: buildDialog() };
    const V = view;
    V.r = r;
    const dlg = V.dlg;
    dlg.querySelector('#terrain-title').textContent = r.name;
    if (!dlg.open) dlg.showModal();
    document.documentElement.classList.add('is-terrain');
    const mapEl = dlg.querySelector('[data-t-map]');
    stopGps();
    if (V.map) { V.map.remove(); V.map = null; } // rouvert sans avoir été fermé
    mapEl.innerHTML = '';
    let track;
    try {
      [track] = await Promise.all([T.loadTrack(id), T.ensureLeaflet()]);
    } catch {
      mapEl.innerHTML = '<p class="terrain__empty">La trace ou la carte n\'a pas pu se charger. Emportez la rando hors ligne quand vous avez du réseau.</p>';
      return;
    }
    if (V.r !== r || !dlg.open) return;
    const L = window.L;
    V.G = prepare(track);
    V.lastIdx = null; V.offCount = 0; V.follow = true; V.fix = null;
    V.map = L.map(mapEl, { zoomControl: false, attributionControl: true });
    L.control.zoom({ position: 'bottomright' }).addTo(V.map);
    const ign = L.tileLayer(T.tileTemplate, { maxZoom: 19, maxNativeZoom: 16, minZoom: 6, attribution: '© IGN' });
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, © OpenTopoMap' });
    (r.region ? ign : topo).addTo(V.map);
    const latlngs = track.map((p) => [p[0], p[1]]);
    L.polyline(latlngs, { color: '#000', weight: 9, opacity: 0.35 }).addTo(V.map);
    V.line = L.polyline(latlngs, { color: T.levelColor(r.level), weight: 5 }).addTo(V.map);
    V.doneLine = L.polyline([], { color: '#9aa39a', weight: 5, opacity: 0.95 }).addTo(V.map);
    L.marker(latlngs[0], { icon: L.divIcon({ className: '', html: '<div class="pin-start">D</div>', iconSize: [28, 28] }) }).addTo(V.map);
    if (!r.loop) L.marker(latlngs[latlngs.length - 1], { icon: L.divIcon({ className: '', html: '<div class="pin-end">A</div>', iconSize: [28, 28] }) }).addTo(V.map);
    V.acc = L.circle(latlngs[0], { radius: 1, color: '#1c7ed6', weight: 1, fillOpacity: 0.12, interactive: false });
    V.me = L.marker(latlngs[0], { icon: L.divIcon({ className: '', html: '<div class="terrain-me"><i></i></div>', iconSize: [26, 26] }), interactive: false, keyboard: false });
    V.map.fitBounds(V.line.getBounds().pad(0.1));
    V.map.on('dragstart', () => setFollow(false));
    // La taille de la carte n'est connue qu'une fois le plein écran posé (et change en tournant le téléphone)
    if (V.ro) V.ro.disconnect();
    if ('ResizeObserver' in window) { V.ro = new ResizeObserver(() => V.map && V.map.invalidateSize({ pan: false })); V.ro.observe(mapEl); }
    requestAnimationFrame(() => { if (V.map) { V.map.invalidateSize({ pan: false }); V.map.fitBounds(V.line.getBounds().pad(0.1)); } });
    paintSun();
    paintOffline();
    startGps();
  }

  function setFollow(on) {
    if (!view) return;
    view.follow = on;
    view.dlg.querySelector('[data-t-follow]').setAttribute('aria-pressed', String(on));
    if (on && view.fix) view.map.setView([view.fix.lat, view.fix.lon], Math.max(view.map.getZoom(), 15));
  }

  function startGps() {
    const V = view;
    const gps = V.dlg.querySelector('[data-t-gps]');
    if (!('geolocation' in navigator)) { gps.textContent = 'GPS indisponible sur cet appareil'; return; }
    gps.textContent = 'Recherche du GPS…';
    stopGps();
    V.watch = navigator.geolocation.watchPosition((pos) => onFix(pos), (err) => {
      gps.textContent = err.code === 1 ? 'Position refusée : autorisez-la dans les réglages du navigateur' : 'Signal GPS perdu, nouvelle tentative…';
      gps.classList.add('is-bad');
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  function stopGps() {
    if (view && view.watch != null) { navigator.geolocation.clearWatch(view.watch); view.watch = null; }
  }

  function onFix(pos) {
    const V = view;
    if (!V || !V.map) return;
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    V.fix = { lat, lon, accuracy, at: pos.timestamp };
    const gps = V.dlg.querySelector('[data-t-gps]');
    gps.textContent = `Position GPS à ±${nf0.format(accuracy)} m`;
    gps.classList.toggle('is-bad', accuracy > 50);
    V.me.setLatLng([lat, lon]); V.acc.setLatLng([lat, lon]).setRadius(accuracy);
    if (!V.map.hasLayer(V.me)) { V.acc.addTo(V.map); V.me.addTo(V.map); }
    if (V.follow) V.map.setView([lat, lon], Math.max(V.map.getZoom(), 15), { animate: true });

    const G = V.G, loc = locate(G, lat, lon, V.lastIdx);
    const q = (k) => V.dlg.querySelector(`[data-t="${k}"]`);
    const alert = V.dlg.querySelector('[data-t-alert]');
    const tooFar = loc.dist > 1500; // pas encore sur place : on indique seulement la distance du départ
    if (tooFar) {
      q('done').textContent = '–'; q('left').textContent = `${nf1.format(G.total)} km`;
      q('up').textContent = `${nf0.format(G.upTotal)} m`; q('eta').textContent = '–';
      alert.hidden = false; alert.className = 'terrain__alert terrain__alert--info';
      alert.textContent = `Vous êtes à ${nf1.format(loc.dist / 1000)} km de la trace.`;
      V.lastIdx = null;
      return;
    }
    V.lastIdx = loc.idx;
    const left = Math.max(0, G.total - loc.km), upLeft = Math.max(0, G.upTotal - loc.up), downLeft = Math.max(0, G.downTotal - loc.down);
    q('done').textContent = `${nf1.format(loc.km)} km`;
    q('left').textContent = `${nf1.format(left)} km`;
    q('up').textContent = `${nf0.format(upLeft)} m`;
    const eta = Date.now() + remainingMin(left, upLeft, downLeft) * 6e4;
    q('eta').textContent = left < 0.05 ? 'Arrivé !' : hhmm(eta);
    V.doneLine.setLatLngs(G.track.slice(0, loc.idx + 1).map((p) => [p[0], p[1]]).concat([[lat, lon]]));
    paintSun(eta);
    // Hors trace : plusieurs relevés de suite au-delà du seuil (plus la précision du GPS)
    const limit = OFF_TRACK_M + Math.min(accuracy, 60);
    V.offCount = loc.dist > limit ? V.offCount + 1 : 0;
    if (V.offCount >= 3) {
      alert.hidden = false; alert.className = 'terrain__alert';
      alert.textContent = `Hors trace : vous êtes à ${nf0.format(loc.dist)} m du parcours.`;
      if (V.offCount === 3 && navigator.vibrate) navigator.vibrate([250, 120, 250]);
    } else {
      alert.hidden = true;
    }
  }

  function paintSun(eta) {
    const V = view, el = V.dlg.querySelector('[data-t-sun]');
    if (!window.RTMeteo) { el.textContent = ''; return; }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    const p = V.fix || { lat: V.r.start[0], lon: V.r.start[1] };
    const sun = window.RTMeteo.sunTimes(today, p.lat, p.lon);
    if (!sun) { el.textContent = ''; return; }
    const margin = eta ? (sun.set - eta) / 6e4 : (sun.set - Date.now()) / 6e4;
    const lvl = !eta ? 'info' : margin < 0 ? 'bad' : margin < 60 ? 'warn' : 'ok';
    el.className = `terrain__sun terrain__sun--${lvl}`;
    el.textContent = `Coucher du soleil à ${hhmm(sun.set)}, nuit à ${sun.dusk ? hhmm(sun.dusk) : '–'}`
      + (eta ? (margin < 0 ? ' : arrivée après le coucher, sortez la frontale.' : ` : ${Math.floor(margin / 60)} h ${String(Math.round(margin % 60)).padStart(2, '0')} de marge.`) : '.');
  }

  function paintOffline() {
    const V = view, box = V.dlg.querySelector('[data-t-offline]');
    const r = V.r;
    if (!hasCaches) { box.innerHTML = '<p class="terrain__hint">Ce navigateur ne permet pas d\'emporter la rando hors ligne.</p>'; return; }
    if (saved.has(r.id)) {
      const size = +localStorageGet(`rt-terrain-size:${SITE}${r.id}`) || 0;
      box.innerHTML = `<p class="terrain__ok">Disponible sans réseau${size ? ` · ${fmtMo(size)}` : ''}</p>
        <button type="button" class="terrain__btn terrain__btn--ghost" data-t-remove>Retirer de l'appareil</button>`;
    } else {
      box.innerHTML = `<button type="button" class="terrain__btn" data-t-save>Emporter hors ligne</button>
        <p class="terrain__hint">${r.region ? 'Fiche, trace et fond de carte IGN autour du parcours (quelques Mo), à faire avant de partir.' : 'Fiche et trace (fond de carte hors ligne disponible seulement en France).'}</p>`;
    }
  }

  async function onSave(btn) {
    const V = view, r = V.r;
    const box = V.dlg.querySelector('[data-t-offline]');
    btn.disabled = true;
    box.insertAdjacentHTML('beforeend', '<div class="terrain__progress"><i data-t-bar></i></div><p class="terrain__hint" data-t-prog>Préparation…</p>');
    try {
      const track = await T.loadTrack(r.id);
      const res = await saveOffline(r, track, (d, n, b) => {
        const bar = box.querySelector('[data-t-bar]'), txt = box.querySelector('[data-t-prog]');
        if (bar) bar.style.width = `${Math.round((d / n) * 100)}%`;
        if (txt) txt.textContent = `Fond de carte : ${d} / ${n} morceaux (${fmtMo(b)})`;
      });
      T.stat('offline', r.name, r.id);
      paintOffline();
      if (res.noMap) box.insertAdjacentHTML('beforeend', '<p class="terrain__hint">Fond de carte non emporté : hors de France.</p>');
    } catch (e) {
      paintOffline();
      box.insertAdjacentHTML('beforeend', `<p class="terrain__err">${esc(e.message || 'Échec de la mise hors ligne.')}</p>`);
    }
  }

  async function setWake(on) {
    const V = view;
    try {
      if (on && 'wakeLock' in navigator) {
        V.wake = await navigator.wakeLock.request('screen');
        V.wake.addEventListener('release', () => { V.wake = null; });
      } else if (V.wake) { await V.wake.release(); V.wake = null; }
    } catch { V.dlg.querySelector('[data-t-wake]').checked = false; }
  }
  document.addEventListener('visibilitychange', () => {
    if (view && view.dlg.open && document.visibilityState === 'visible' && view.dlg.querySelector('[data-t-wake]').checked && !view.wake) setWake(true);
  });

  function close() {
    if (!view) return;
    stopGps();
    setWake(false);
    if (view.map) { view.map.remove(); view.map = null; }
    document.documentElement.classList.remove('is-terrain');
    if (view.dlg.open) view.dlg.close();
  }

  document.addEventListener('click', (e) => {
    if (!view || !view.dlg.contains(e.target)) return;
    if (e.target.closest('[data-t-close]')) close();
    else if (e.target.closest('[data-t-follow]')) setFollow(!view.follow);
    else if (e.target.closest('[data-t-save]')) onSave(e.target.closest('[data-t-save]'));
    else if (e.target.closest('[data-t-remove]')) removeOffline(view.r.id).then(paintOffline);
  });
  document.addEventListener('change', (e) => {
    if (view && e.target.closest('[data-t-wake]')) setWake(e.target.checked);
  });
  document.addEventListener('close', (e) => { if (view && e.target === view.dlg) close(); }, true);

  // Bouton de la fiche
  function button(r) {
    if (!r || r.external) return '';
    const on = saved.has(r.id);
    return `<button type="button" class="btn btn--terrain btn--block" data-terrain="${esc(r.id)}" title="Carte plein écran avec votre position GPS, à emporter hors ligne">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6-5.5-6-11a6 6 0 1 1 12 0c0 5.5-6 11-6 11Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.4" fill="currentColor"/></svg>
      <span class="btn__label">Mode terrain</span><span class="btn__meta">${on ? 'hors ligne ✓' : 'GPS + hors ligne'}</span></button>`;
  }

  window.RTTerrain = {
    init(tools) { T = tools; refreshSaved(); },
    button, open, close, refreshSaved,
    savedIds: () => [...saved],
    // pour les tests : position simulée
    _fix: (lat, lon, accuracy = 8) => onFix({ coords: { latitude: lat, longitude: lon, accuracy }, timestamp: Date.now() }),
  };
})();
