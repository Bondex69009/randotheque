/* Randothèques – espace statistiques des deux sites (réservé aux gestionnaires).
   Accès par un champ mot de passe : le serveur renvoie un jeton, gardé dans ce navigateur
   (celui de l'administrateur seulement) et envoyé dans l'en-tête X-Stats-Token.
   Graphiques dessinés en SVG/HTML, sans bibliothèque. */
(() => {
  'use strict';

  const API = 'api.php';
  const KEY = 'rt-stats-token';
  let token = null;
  try { token = localStorage.getItem(KEY); } catch { /* navigation privée */ }

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const pct = (a, b) => (b ? (100 * a) / b : 0);
  const fmtDur = (s) => {
    s = Math.round(s || 0);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return r ? `${m} min ${String(r).padStart(2, '0')}` : `${m} min`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  };
  // Couleurs des catégories : ordre fixe, validé (daltonisme, contraste) sur les fonds sombres des deux sites.
  const CAT = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];
  const ONE = {
    rando: 'Fiche ouverte', gpx: 'GPX téléchargé', fly: 'Survol 3D', fly_duel: 'Survol 3D en duel', vs: 'Comparaison VS',
    share: 'Partage', png: 'Image PNG', ibp: 'Calcul IBP', search: 'Recherche', filter: 'Filtre', map: 'Vue carte',
    audio: 'Audio écouté', evo: 'Évolution du compteur', embed: 'Code du compteur', ailleurs: 'Chercher aussi sur',
    ext: 'Fiche externe', install: 'Appli installée', outbound: 'Lien externe',
    blog: 'Article du blog', photos: 'Album photos', relive: 'Vidéo Relive', drive: 'Google Drive', route: 'Itinéraire vers le départ',
    video: 'Vidéo', ext_site: 'Fiche sur un autre site', ui: 'Clic', vs_add: 'Ajout au comparateur', anim: 'Clic sur un animateur',
  };
  const ACCENT = () => css('--c-accent') || '#87f700';

  const state = { period: '30d', from: '', to: '', metric: 'visitors', rfEvent: '', rfRando: '' };
  try { Object.assign(state, JSON.parse(sessionStorage.getItem('rt-stats-view') || '{}')); } catch { /* rien */ }
  let data = null, liveTimer = null;

  // ------------------------------------------------------------ Serveur
  async function api(action, { method = 'GET', body, query = {} } = {}) {
    const qs = new URLSearchParams({ a: action, ...query }).toString();
    const res = await fetch(`${API}?${qs}`, {
      method, credentials: 'same-origin',
      headers: { ...(token ? { 'X-Stats-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && action !== 'login') { logout(false); throw new Error(json.error || 'Connectez-vous.'); }
    if (!res.ok) throw new Error(json.error || `Erreur ${res.status}`);
    return json;
  }

  // ------------------------------------------------------------ Connexion
  function showLogin(msg = '') {
    $('#sx-app').hidden = true;
    $('#sx-logout').hidden = true;
    $('#sx-login').hidden = false;
    $('#sx-login-error').textContent = msg;
    $('#sx-password').focus();
  }
  function logout(callServer = true) {
    if (callServer && token) api('logout', { method: 'POST' }).catch(() => {});
    token = null;
    try { localStorage.removeItem(KEY); } catch { /* rien */ }
    clearInterval(liveTimer);
    showLogin();
  }
  $('#sx-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    $('#sx-login-error').textContent = '';
    try {
      const res = await api('login', { method: 'POST', body: { password: $('#sx-password').value } });
      token = res.token;
      try { localStorage.setItem(KEY, token); } catch { /* rien */ }
      $('#sx-password').value = '';
      start();
    } catch (err) {
      $('#sx-login-error').textContent = err.message === 'Failed to fetch' ? 'Serveur de statistiques injoignable.' : err.message;
    } finally {
      btn.disabled = false;
    }
  });
  $('#sx-logout').addEventListener('click', () => logout());

  // ------------------------------------------------------------ Barre d'outils
  function paintToolbar() {
    for (const b of $$('#sx-period [data-p]')) { b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(state.period === b.dataset.p)); }
    const metrics = { visitors: 'Visiteurs', visits: 'Visites', randos: 'Fiches', gpx: 'GPX', actions: 'Actions' };
    $('#sx-metric').innerHTML = Object.entries(metrics).map(([k, v]) => `<button type="button" role="radio" data-m="${k}" aria-checked="${state.metric === k}">${v}</button>`).join('');
    if (state.period === 'custom') { $('#sx-from').value = state.from; $('#sx-to').value = state.to; }
  }
  const save = () => { try { sessionStorage.setItem('rt-stats-view', JSON.stringify(state)); } catch { /* rien */ } };
  $('#sx-period').addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) { state.period = b.dataset.p; $('#sx-from').value = ''; $('#sx-to').value = ''; save(); load(); } });
  $('#sx-metric').addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (b && data) { state.metric = b.dataset.m; save(); paintToolbar(); drawEvo(); } });
  for (const id of ['#sx-from', '#sx-to']) {
    $(id).addEventListener('change', () => {
      const from = $('#sx-from').value, to = $('#sx-to').value;
      if (from && to && from <= to) { Object.assign(state, { period: 'custom', from, to }); save(); load(); }
    });
  }

  // ------------------------------------------------------------ Infobulle commune
  const tip = $('#sx-tip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2));
    const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
    tip.style.transform = `translate(${left}px, ${top}px)`;
  }
  const hideTip = () => { tip.hidden = true; };
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    showTip(el.dataset.tip, r.left + r.width / 2, r.top);
  });
  document.addEventListener('pointerout', (e) => { if (e.target.closest('[data-tip]')) hideTip(); });
  addEventListener('scroll', hideTip, { passive: true });

  // ------------------------------------------------------------ Briques graphiques
  const empty = (txt = 'Pas encore de données sur cette période.') => `<p class="sx-empty">${txt}</p>`;

  /** Barres horizontales (classement). rows : [[libellé, valeur, (info)]]. */
  function bars(rows, { total, color, fmt = nf0.format, unit = '', max = 12, labelFmt = esc } = {}) {
    rows = rows.filter((r) => r[1] > 0).slice(0, max);
    if (!rows.length) return empty();
    const top = Math.max(...rows.map((r) => r[1]));
    const sum = total ?? rows.reduce((s, r) => s + r[1], 0);
    return `<ol class="sx-bars">${rows.map(([k, v, info]) => {
      const share = pct(v, sum);
      return `<li class="sx-bar" data-tip="${esc(`<strong>${labelFmt(k)}</strong><br>${fmt(v)}${unit} · ${nf1.format(share)} %${info ? `<br>${info}` : ''}`)}">
        <span class="sx-bar__fill" style="width:${Math.max(1.5, (100 * v) / top)}%;${color ? `background:${color}` : ''}"></span>
        <span class="sx-bar__label">${labelFmt(k)}</span>
        <span class="sx-bar__value">${fmt(v)}${unit} <small>${nf0.format(share)} %</small></span>
      </li>`;
    }).join('')}</ol>`;
  }

  /** Anneau + légende (parts d'un tout, 6 catégories au plus, le reste en « Autres »). */
  function donut(rows, { labels = {}, center = 'visites' } = {}) {
    rows = rows.filter((r) => r[1] > 0);
    if (!rows.length) return empty();
    if (rows.length > 6) {
      const rest = rows.slice(5).reduce((s, r) => s + r[1], 0);
      rows = [...rows.slice(0, 5), ['__autres', rest]];
    }
    const total = rows.reduce((s, r) => s + r[1], 0);
    const R = 52, C = 2 * Math.PI * R, gap = rows.length > 1 ? 2.5 : 0;
    let off = 0;
    const name = (k) => (k === '__autres' ? 'Autres' : labels[k] || k || 'Inconnu');
    const arcs = rows.map(([k, v], i) => {
      const len = (C * v) / total;
      const seg = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${k === '__autres' ? css('--c-text-faint') : CAT[i]}" stroke-width="20"
        stroke-dasharray="${Math.max(0.5, len - gap)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"
        data-tip="${esc(`<strong>${esc(name(k))}</strong><br>${nf0.format(v)} · ${nf1.format(pct(v, total))} %`)}"/>`;
      off += len;
      return seg;
    }).join('');
    return `<div class="sx-donut">
      <svg viewBox="0 0 140 140" class="sx-donut__svg" role="img" aria-label="Répartition">${arcs}
        <text x="70" y="68" text-anchor="middle" class="sx-donut__n">${nf0.format(total)}</text>
        <text x="70" y="86" text-anchor="middle" class="sx-donut__u">${center}</text></svg>
      <ul class="sx-legend">${rows.map(([k, v], i) => `<li><span class="sx-dot" style="background:${k === '__autres' ? css('--c-text-faint') : CAT[i]}"></span>
        <span class="sx-legend__k">${esc(name(k))}</span><span class="sx-legend__v">${nf0.format(pct(v, total))} %</span></li>`).join('')}</ul>
    </div>`;
  }

  /** Histogramme vertical (tranches ordonnées). */
  function columns(rows, { unit = 'visites' } = {}) {
    const top = Math.max(1, ...rows.map((r) => r[1]));
    const total = rows.reduce((s, r) => s + r[1], 0);
    if (!total) return empty();
    return `<div class="sx-cols">${rows.map(([k, v]) => `<div class="sx-col" data-tip="${esc(`<strong>${esc(k)}</strong><br>${nf0.format(v)} ${unit} · ${nf1.format(pct(v, total))} %`)}">
      <span class="sx-col__v">${nf0.format(pct(v, total))} %</span>
      <span class="sx-col__bar"><span style="height:${(100 * v) / top}%"></span></span>
      <span class="sx-col__k">${esc(k)}</span></div>`).join('')}</div>`;
  }

  /** Mini-courbe d'un indicateur (dans les tuiles). */
  function spark(values) {
    if (values.length < 2) return '';
    const w = 120, h = 32, top = Math.max(1, ...values);
    const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - (v / top) * (h - 4)]);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    return `<svg class="sx-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${d}L${w},${h}L0,${h}Z" class="sx-spark__area"/><path d="${d}" class="sx-spark__line"/></svg>`;
  }

  // ------------------------------------------------------------ Courbe d'évolution (survol : réticule + infobulle)
  function drawEvo() {
    const box = $('#c-evo');
    const pts = data.series.points;
    const key = state.metric;
    const vals = pts.map((p) => p[key]);
    if (!vals.some((v) => v > 0)) { box.innerHTML = empty(); return; }
    const W = Math.max(320, box.clientWidth), H = 260, L = 40, Rm = 12, T = 14, B = 30;
    const top = niceMax(Math.max(...vals));
    const x = (i) => L + (pts.length === 1 ? (W - L - Rm) / 2 : (i / (pts.length - 1)) * (W - L - Rm));
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const v = top * f;
      return `<line x1="${L}" x2="${W - Rm}" y1="${y(v)}" y2="${y(v)}" class="sx-grid-line"/>
        <text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="sx-axis">${nf0.format(v)}</text>`;
    }).join('');
    const every = Math.max(1, Math.ceil(pts.length / Math.floor((W - L) / 70)));
    const xl = pts.map((p, i) => (i % every === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="sx-axis">${esc(p.label.replace('sem. du ', ''))}</text>` : '')).join('');
    const names = { visitors: 'visiteurs', visits: 'visites', randos: 'fiches ouvertes', gpx: 'GPX téléchargés', actions: 'actions' };
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="sx-evo" role="img" aria-label="Évolution des ${names[key]}">
      <defs><linearGradient id="evo-g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${ACCENT()}" stop-opacity=".32"/><stop offset="1" stop-color="${ACCENT()}" stop-opacity="0"/></linearGradient></defs>
      ${grid}${xl}
      <path d="${line}L${x(pts.length - 1)},${y(0)}L${x(0)},${y(0)}Z" fill="url(#evo-g)"/>
      <path d="${line}" fill="none" stroke="${ACCENT()}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <line class="sx-cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
      <circle class="sx-cross-dot" r="5" fill="${ACCENT()}" visibility="hidden"/>
      <rect x="${L}" y="0" width="${W - L - Rm}" height="${H - B}" fill="transparent" class="sx-hit"/>
    </svg>`;
    const svg = $('svg', box), cross = $('.sx-cross', svg), dot = $('.sx-cross-dot', svg);
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - L) / (W - L - Rm)) * (pts.length - 1))));
      const p = pts[i];
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(p[key])); dot.setAttribute('visibility', 'visible');
      showTip(`<strong>${esc(p.label)}</strong><br>${nf0.format(p.visitors)} visiteurs · ${nf0.format(p.visits)} visites<br>${nf0.format(p.randos)} fiches · ${nf0.format(p.gpx)} GPX · ${nf0.format(p.actions)} actions`,
        r.left + (x(i) / W) * r.width, r.top + (y(p[key]) / H) * r.height);
    };
    $('.sx-hit', svg).addEventListener('pointermove', move);
    $('.sx-hit', svg).addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); });
  }
  function niceMax(v) {
    if (v <= 4) return 4;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  // ------------------------------------------------------------ Sections
  function delta(cur, prev, { invert = false, points = false } = {}) {
    if (!prev && !cur) return '<span class="sx-delta">–</span>';
    if (!prev) return '<span class="sx-delta sx-delta--up">nouveau</span>';
    const d = points ? cur - prev : (100 * (cur - prev)) / prev;
    if (Math.abs(d) < 0.5) return '<span class="sx-delta">stable</span>';
    const good = invert ? d < 0 : d > 0;
    return `<span class="sx-delta ${good ? 'sx-delta--up' : 'sx-delta--down'}">${d > 0 ? '▲' : '▼'} ${nf0.format(Math.abs(d))}${points ? ' pt' : ' %'}</span>`;
  }
  // Infobulle du KPI « Actions par visite » : le détail des actions de la période
  function actionsTip(k) {
    const L = data.labels.events, ev = data.events || [];
    const head = `<strong>${nf0.format(k.actions)} action${k.actions > 1 ? 's' : ''}</strong> sur ${nf0.format(k.visits)} visite${k.visits > 1 ? 's' : ''}`;
    if (!ev.length) return `${head}<br>Aucune action sur la période.`;
    const MAX = 12;
    const rows = ev.slice(0, MAX).map(([e, n]) => `<span class="sx-tip__row"><span>${esc(L[e] || e)}</span><b>${nf0.format(n)}</b></span>`).join('');
    const rest = ev.slice(MAX);
    const more = rest.length ? `<span class="sx-tip__more">+ ${rest.length} autre${rest.length > 1 ? 's' : ''} (${nf0.format(rest.reduce((t, [, n]) => t + n, 0))})</span>` : '';
    return `${head}${rows ? `<span class="sx-tip__list">${rows}</span>` : ''}${more}`;
  }
  function drawKpis() {
    const k = data.kpis, p = data.prev, pts = data.series.points;
    const tiles = [
      ['Visiteurs', nf0.format(k.visitors), delta(k.visitors, p.visitors), spark(pts.map((x) => x.visitors)), 'Personnes différentes, comptées jour par jour (sans cookie, impossible de reconnaître quelqu\'un d\'un jour à l\'autre).'],
      ['Visites', nf0.format(k.visits), delta(k.visits, p.visits), spark(pts.map((x) => x.visits)), 'Une visite se termine après 30 minutes sans activité.'],
      ['Fiches rando ouvertes', nf0.format(k.randos), delta(k.randos, p.randos), spark(pts.map((x) => x.randos)), 'Nombre de fois où une fiche détaillée a été ouverte.'],
      ['GPX téléchargés', nf0.format(k.gpx), delta(k.gpx, p.gpx), spark(pts.map((x) => x.gpx)), 'Clics sur « Télécharger le GPX ».'],
      ['Durée moyenne', fmtDur(k.avg_dur), delta(k.avg_dur, p.avg_dur), '', 'Temps passé onglet visible, par visite.'],
      ['Taux de rebond', `${nf1.format(k.bounce)} %`, delta(k.bounce, p.bounce, { invert: true, points: true }), '', 'Visites sans aucune action (ni fiche, ni recherche, ni filtre…).'],
      ['Actions par visite', nf1.format(k.per_visit), delta(k.per_visit, p.per_visit), '', actionsTip(k), true],
      ['Visites avec GPX', `${nf1.format(k.gpx_rate)} %`, delta(k.gpx_rate, p.gpx_rate, { points: true }), '', 'Part des visites qui se terminent par au moins un téléchargement.'],
    ];
    $('#sx-kpis').innerHTML = tiles.map(([t, v, d, s, help, html]) => `<div class="sx-kpi" data-tip="${esc(html ? help : esc(help))}">
      <span class="sx-kpi__t">${t}</span><span class="sx-kpi__v">${v}</span>${d}${s}</div>`).join('');
  }

  function drawSummary() {
    const k = data.kpis, per = data.period;
    const best = data.randos[0];
    const top = (arr, labels = {}) => (arr[0] ? `${labels[arr[0][0]] || arr[0][0]}` : null);
    const parts = [`${per.label} : <strong>${nf0.format(k.visitors)}</strong> visiteur${k.visitors > 1 ? 's' : ''}, <strong>${nf0.format(k.randos)}</strong> fiche${k.randos > 1 ? 's' : ''} ouverte${k.randos > 1 ? 's' : ''} et <strong>${nf0.format(k.gpx)}</strong> GPX téléchargé${k.gpx > 1 ? 's' : ''}.`];
    if (best) parts.push(`La rando la plus vue : <strong>${esc(best.name)}</strong>.`);
    const src = top(data.sources, data.labels.sources), city = data.cities[0];
    if (src) parts.push(`Première source : ${esc(src.toLowerCase())}${city ? `, première ville : ${esc(city.city)}` : ''}.`);
    $('#sx-summary').innerHTML = parts.join(' ');
  }

  function drawFunnel() {
    const k = data.kpis;
    const steps = [
      ['Visites', k.visits],
      ['Ouvrent au moins une fiche', Math.round((k.visits * k.rando_rate) / 100)],
      ['Téléchargent un GPX', Math.round((k.visits * k.gpx_rate) / 100)],
    ];
    if (!k.visits) { $('#c-funnel').innerHTML = empty(); return; }
    $('#c-funnel').innerHTML = `<ol class="sx-funnel">${steps.map(([t, v], i) => `<li class="sx-funnel__step">
      <span class="sx-funnel__bar" style="width:${Math.max(4, pct(v, k.visits))}%;opacity:${0.42 - i * 0.1}"></span>
      <span class="sx-funnel__t">${t}</span><span class="sx-funnel__v">${nf0.format(v)} <small>${nf0.format(pct(v, k.visits))} %</small></span></li>`).join('')}</ol>
      <p class="sx-note">${nf1.format(k.randos / Math.max(1, k.visits))} fiche${k.randos / Math.max(1, k.visits) >= 2 ? 's' : ''} ouverte${k.randos / Math.max(1, k.visits) >= 2 ? 's' : ''} par visite en moyenne · ${nf0.format(k.fly)} survol${k.fly > 1 ? 's' : ''} 3D.</p>`;
  }

  function drawActions() {
    const L = data.labels.events;
    const rows = data.events.map(([e, n, v]) => [L[e] || e, n, `dans ${nf0.format(v)} visite${v > 1 ? 's' : ''} (${nf0.format(pct(v, data.kpis.visits))} %)`]);
    $('#c-actions').innerHTML = bars(rows, { max: 18 });
  }

  function drawRandos() {
    const rows = data.randos;
    if (!rows.length) { $('#c-randos').innerHTML = empty(); return; }
    const top = Math.max(...rows.map((r) => r.views), 1);
    const link = (r) => `../#rando=${encodeURIComponent(r.id)}`;
    $('#c-randos').innerHTML = `<table class="sx-table">
      <thead><tr><th scope="col">#</th><th scope="col">Rando</th><th scope="col" class="num">Vues</th><th scope="col" class="num">Personnes</th>
      <th scope="col" class="num">GPX</th><th scope="col" class="num" title="Téléchargements pour 100 vues">GPX / vue</th><th scope="col" class="num">3D</th><th scope="col" class="num">Partages</th><th scope="col" class="num">Audio</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td class="rank">${i + 1}</td>
        <td><a href="${link(r)}" target="_blank" rel="noopener">${esc(r.name || r.id)}</a><span class="sx-inline-bar" style="width:${(100 * r.views) / top}%"></span></td>
        <td class="num">${nf0.format(r.views)}</td><td class="num">${nf0.format(r.people)}</td><td class="num">${nf0.format(r.gpx)}</td>
        <td class="num">${r.views ? `${nf0.format(pct(r.gpx, r.views))} %` : '–'}</td><td class="num">${nf0.format(r.fly)}</td><td class="num">${nf0.format(r.share)}</td><td class="num">${nf0.format(r.audio)}</td>
      </tr>`).join('')}</tbody></table>`;
  }

  // Actions par rando : filtre par action (sur quelles randos : GPX, Relive, blog…) et par rando
  // (tout ce qui a été cliqué sur sa fiche), avec le journal des derniers clics correspondants.
  const RF_COLS = [['rando', 'Vues'], ['gpx', 'GPX'], ['relive', 'Relive'], ['blog', 'Blog'], ['photos', 'Photos'], ['route', 'Itinéraire'], ['fly', '3D'], ['share', 'Partages']];
  function drawByRando() {
    const br = data.by_rando || { names: {}, counts: [], btns: [], log: [] };
    const L = data.labels.events;
    const name = (id) => br.names[id] || id;
    // Totaux par rando et par action
    const per = new Map();
    for (const [id, ev, n, v] of br.counts) {
      if (!per.has(id)) per.set(id, { id, total: 0, ev: {}, people: {} });
      const p = per.get(id);
      p.total += n; p.ev[ev] = (p.ev[ev] || 0) + n; p.people[ev] = v;
    }
    const evTotals = {};
    for (const [, ev, n] of br.counts) evTotals[ev] = (evTotals[ev] || 0) + n;

    // Listes des filtres (une valeur choisie absente de la période reste proposée)
    if (state.rfEvent && !evTotals[state.rfEvent]) evTotals[state.rfEvent] = 0;
    const evOpts = Object.entries(evTotals).sort((a, b) => b[1] - a[1]);
    $('#sx-rf-event').innerHTML = `<option value="">Toutes les actions</option>${evOpts.map(([e, n]) => `<option value="${esc(e)}"${e === state.rfEvent ? ' selected' : ''}>${esc(L[e] || e)} (${nf0.format(n)})</option>`).join('')}`;
    const rOpts = [...per.values()].sort((a, b) => b.total - a.total || name(a.id).localeCompare(name(b.id), 'fr'));
    const rSel = state.rfRando && !per.has(state.rfRando) ? `<option value="${esc(state.rfRando)}" selected>${esc(name(state.rfRando))} (0)</option>` : '';
    $('#sx-rf-rando').innerHTML = `<option value="">Toutes les randos</option>${rSel}${rOpts.map((p) => `<option value="${esc(p.id)}"${p.id === state.rfRando ? ' selected' : ''}>${esc(name(p.id))} (${nf0.format(p.total)})</option>`).join('')}`;

    const box = $('#c-byrando');
    if (!br.counts.length && !state.rfRando) { box.innerHTML = empty('Aucune action sur une fiche rando pendant cette période.'); return; }
    const ev = state.rfEvent, rid = state.rfRando;
    const parts = [];

    if (!rid) {
      // Classement des randos (pour l'action choisie, ou toutes)
      const rows = [...per.values()].map((p) => ({ ...p, n: ev ? p.ev[ev] || 0 : p.total })).filter((p) => p.n > 0).sort((a, b) => b.n - a.n).slice(0, 50);
      const top = Math.max(1, ...rows.map((r) => r.n));
      const cell = (r) => `<td><button type="button" class="sx-linkbtn" data-rf-rando="${esc(r.id)}">${esc(name(r.id))}</button><span class="sx-inline-bar" style="width:${(100 * r.n) / top}%"></span></td>`;
      parts.push(rows.length ? `<div class="sx-table-wrap"><table class="sx-table">
        <thead><tr><th scope="col">#</th><th scope="col">Rando</th>${ev
          ? `<th scope="col" class="num">${esc(L[ev] || ev)}</th><th scope="col" class="num">Personnes</th>`
          : `<th scope="col" class="num">Actions</th>${RF_COLS.map(([, t]) => `<th scope="col" class="num">${t}</th>`).join('')}`}</tr></thead>
        <tbody>${rows.map((r, i) => `<tr><td class="rank">${i + 1}</td>${cell(r)}${ev
          ? `<td class="num">${nf0.format(r.n)}</td><td class="num">${nf0.format(r.people[ev] || 0)}</td>`
          : `<td class="num">${nf0.format(r.n)}</td>${RF_COLS.map(([k]) => {
            const v = k === 'fly' ? (r.ev.fly || 0) + (r.ev.fly_duel || 0) : k === 'share' ? (r.ev.share || 0) + (r.ev.png || 0) : r.ev[k] || 0;
            return `<td class="num">${v ? nf0.format(v) : '<span class="sx-muted">–</span>'}</td>`;
          }).join('')}`}</tr>`).join('')}</tbody></table></div>
        <p class="sx-note">Cliquez sur une rando pour voir tout ce qui a été cliqué sur sa fiche.</p>`
        : empty('Aucune rando concernée par cette action sur la période.'));
    } else {
      // Détail d'une rando : actions par type et boutons de la fiche
      const p = per.get(rid) || { ev: {}, people: {}, total: 0 };
      const evRows = Object.entries(p.ev).sort((a, b) => b[1] - a[1])
        .map(([e, n]) => [L[e] || e, n, `par ${nf0.format(p.people[e] || 0)} personne${(p.people[e] || 0) > 1 ? 's' : ''}`]);
      const btnRows = br.btns.filter((b) => b[0] === rid).sort((a, b) => b[2] - a[2]).map((b) => [b[1], b[2]]);
      parts.push(`<p class="sx-note" style="margin-top:0"><a href="../#rando=${encodeURIComponent(rid)}" target="_blank" rel="noopener"><strong>${esc(name(rid))}</strong></a> : ${nf0.format(p.total)} action${p.total > 1 ? 's' : ''} sur la période. <button type="button" class="btn btn--ghost btn--sm" data-rf-rando="">Toutes les randos</button></p>
        <div class="sx-byrando__grid">
          <div><h3 class="sx-sub">Actions</h3>${bars(evRows, { max: 30, color: CAT[0] })}</div>
          <div><h3 class="sx-sub">Boutons de la fiche</h3>${btnRows.length ? bars(btnRows, { max: 30, color: CAT[2] }) : empty('Aucun bouton de la fiche cliqué.')}</div>
        </div>`);
    }

    // Journal des derniers clics correspondant aux filtres
    const dev = { mobile: '📱', desktop: '💻', tablet: '📲' };
    const when = (ts) => new Date(ts.replace(' ', 'T')).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const log = br.log.filter(([, id, e]) => (!rid || id === rid) && (!ev || e === ev)).slice(0, 30);
    if (log.length) {
      parts.push(`<h3 class="sx-sub">Derniers clics${ev ? ` · ${esc(L[ev] || ev)}` : ''}</h3><div class="sx-table-wrap"><table class="sx-table sx-table--log">
        <thead><tr><th scope="col">Quand</th>${rid ? '' : '<th scope="col">Rando</th>'}<th scope="col">Action</th><th scope="col">Bouton</th><th scope="col">Où</th></tr></thead>
        <tbody>${log.map(([ts, id, e, btn, city, device]) => `<tr><td class="nowrap">${when(ts)}</td>${rid ? '' : `<td><button type="button" class="sx-linkbtn" data-rf-rando="${esc(id)}">${esc(name(id))}</button></td>`}
          <td><span class="sx-chip sx-chip--${esc(e)}">${esc(ONE[e] || e)}</span></td><td>${esc(btn) || '<span class="sx-muted">–</span>'}</td>
          <td><span aria-hidden="true">${dev[device] || ''}</span> ${esc(city || 'Ville inconnue')}</td></tr>`).join('')}</tbody></table></div>`);
    }
    box.innerHTML = parts.join('');
  }
  function setRf(key, val) { state[key] = val; save(); if (data) drawByRando(); }
  $('#sx-rf-event').addEventListener('change', (e) => setRf('rfEvent', e.target.value));
  $('#sx-rf-rando').addEventListener('change', (e) => setRf('rfRando', e.target.value));
  $('#c-byrando').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rf-rando]');
    if (!b) return;
    setRf('rfRando', b.dataset.rfRando);
    $('#t-byrando').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  function drawLists() {
    $('#c-search').innerHTML = bars(data.searches, { max: 15, labelFmt: (k) => `« ${esc(k)} »` });
    $('#c-filters').innerHTML = bars(data.filters, { max: 15, color: CAT[0] });
    const vs = data.vs.length ? `<h3 class="sx-sub">Duels VS</h3>${bars(data.vs, { max: 6, color: CAT[1] })}` : '';
    const ail = data.ailleurs.length ? `<h3 class="sx-sub">Chercher aussi sur</h3>${bars(data.ailleurs, { max: 6, color: CAT[2] })}` : '';
    $('#c-vs').innerHTML = vs + ail || empty();
    // Liens externes : par destination, puis les randos (ou sites) les plus cliquées pour chacune.
    const KINDS = { blog: 'Articles du blog', photos: 'Albums photos', relive: 'Vidéos Relive', drive: 'Audios et fichiers Google Drive', route: 'Itinéraires vers le départ', video: 'Vidéos', ext_site: 'Fiches sur d\'autres sites', outbound: 'Autres sites' };
    const byKind = Object.keys(KINDS).map((k) => [KINDS[k], (data.events.find((e) => e[0] === k) || [k, 0])[1]]);
    const detail = Object.keys(KINDS).filter((k) => (data.links[k] || []).length)
      .map((k, i) => `<h3 class="sx-sub">${KINDS[k]}</h3>${bars(data.links[k], { max: 6, color: CAT[(i + 1) % CAT.length] })}`).join('');
    $('#c-links').innerHTML = byKind.some((r) => r[1]) ? bars(byKind, { color: CAT[0] }) + detail : empty();
    $('#c-ui').innerHTML = bars(data.ui, { max: 30, color: CAT[6] });
    // Chaque bouton de la fiche, sous son nom exact (Partager, Survol 3D, Télécharger le GPX, Photos de…).
    $('#c-fiche_btns').innerHTML = bars(data.fiche_btns.map(([k, n, nr]) => [k, n, `sur ${nf0.format(nr)} rando${nr > 1 ? 's' : ''} différente${nr > 1 ? 's' : ''}`]), { max: 40, color: CAT[0] });
  }

  function drawSources() {
    $('#c-sources').innerHTML = donut(data.sources, { labels: data.labels.sources });
    const landing = { accueil: 'Page d\'accueil', fiche: 'Lien direct vers une fiche', vs: 'Lien vers un duel VS', recherche: 'Lien avec une recherche', filtres: 'Lien avec des filtres', carte: 'Lien vers la carte', appli: 'Appli installée' };
    const parts = [];
    parts.push(`<h3 class="sx-sub">Sites et moteurs</h3>${bars(data.referrers, { max: 10, color: CAT[0] })}`);
    parts.push(`<h3 class="sx-sub">Portes d'entrée</h3>${bars(data.landing.map(([k, v]) => [landing[k] || k, v]), { max: 7, color: CAT[2] })}`);
    if (data.campaigns.length) parts.push(`<h3 class="sx-sub">Campagnes (utm)</h3>${bars(data.campaigns, { max: 8, color: CAT[3] })}`);
    if (data.by_site.length) parts.push(`<h3 class="sx-sub">Visites par site</h3>${bars(data.by_site.map((r) => [data.sites[r.k] || r.k, +r.n]), { color: CAT[1] })}`);
    $('#c-referrers').innerHTML = parts.join('');
  }

  const deviceText = (r) => [
    [r.browser, r.browser_v].filter(Boolean).join(' '),
    [r.os, r.os_v].filter(Boolean).join(' '),
    r.model && r.brand !== 'Apple' ? `${r.brand && !/^(Autre|PC)/.test(r.brand) ? `${r.brand} ` : ''}${r.model}` : '',
    r.res || '',
  ].filter(Boolean).join(' · ');
  const flag = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : '');
  const countryName = (cc) => { try { return new Intl.DisplayNames(['fr'], { type: 'region' }).of(cc); } catch { return cc; } };
  function drawGeo() {
    const cities = data.cities;
    $('#c-cities').innerHTML = cities.length
      ? bars(cities.map((c) => [`${flag(c.country)} ${c.city}`, c.n]), { max: 25 })
      : empty(data.geo_ready ? undefined : 'Base des villes pas encore installée sur le serveur (bouton en bas de page).');
  }

  function drawTech() {
    const dev = { mobile: 'Téléphone', desktop: 'Ordinateur', tablet: 'Tablette' };
    $('#c-devices').innerHTML = donut(data.devices, { labels: dev });
    $('#c-browsers').innerHTML = donut(data.browsers);
    $('#c-os').innerHTML = donut(data.os);
    $('#c-screens').innerHTML = bars(data.screens, { color: CAT[0] });
    const lang = (l) => { try { return new Intl.DisplayNames(['fr'], { type: 'language' }).of(l); } catch { return l; } };
    $('#c-langs').innerHTML = `${bars(data.langs.map(([k, v]) => [lang(k), v]), { max: 5, color: CAT[2] })}
      <h3 class="sx-sub">Pays</h3>${bars(data.countries.map(([k, v]) => [`${flag(k)} ${countryName(k)}`, v]), { max: 6, color: CAT[3] })}`;
    const apps = data.apps.map(([k, v]) => [String(k) === '1' ? 'Appli installée' : 'Navigateur', v]);
    $('#c-browsers_v').innerHTML = bars(data.browsers_v, { color: CAT[0] });
    $('#c-os_v').innerHTML = bars(data.os_v, { color: CAT[2] });
    $('#c-brands').innerHTML = donut(data.brands);
    $('#c-models').innerHTML = bars(data.models.map(([k, v]) => [k.replace(/^(Autre Android|Autre) /, ''), v]), { max: 15, color: CAT[1] });
    $('#c-res').innerHTML = bars(data.res, { color: CAT[3] });
    $('#c-net').innerHTML = `${bars(data.net.map(([k, v]) => [`Réseau ${k}`, v]), { color: CAT[5] })}<h3 class="sx-sub">Densité d'écran</h3>${bars(data.dpr.map(([k, v]) => [`${k}${parseFloat(k) >= 2 ? ' (écran Retina / HD)' : ''}`, v]), { color: CAT[4] })}`;
    $('#c-misc').innerHTML = `${bars(apps, { color: CAT[4] })}<h3 class="sx-sub">Thème du système</h3>${bars(data.themes.map(([k, v]) => [k === 'sombre' ? 'Sombre' : 'Clair', v]), { color: CAT[6] })}`;
  }

  function drawHeat() {
    const days = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
    const full = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
    const h = data.heatmap, top = Math.max(1, ...h.flat());
    if (!h.flat().some((v) => v)) { $('#c-heat').innerHTML = empty(); return; }
    const col = (v) => (v ? `color-mix(in oklab, ${ACCENT()} ${Math.round(12 + 88 * (v / top))}%, var(--c-surface-2))` : 'var(--c-surface-2)');
    const dayTot = h.map((r) => r.reduce((a, b) => a + b, 0));
    $('#c-heat').innerHTML = `<div class="sx-heat" role="table" aria-label="Visites par jour et heure">
      <div class="sx-heat__row sx-heat__row--head" role="row"><span></span>${[...Array(24)].map((_, i) => `<span class="sx-heat__h">${i % 3 === 0 ? `${i}h` : ''}</span>`).join('')}<span class="sx-heat__tot">Total</span></div>
      ${h.map((row, d) => `<div class="sx-heat__row" role="row"><span class="sx-heat__d">${days[d]}</span>${row.map((v, hr) => `<span class="sx-heat__c" style="background:${col(v)}"
        data-tip="${esc(`<strong>${full[d]}, ${hr} h – ${hr + 1} h</strong><br>${nf0.format(v)} visite${v > 1 ? 's' : ''}`)}"></span>`).join('')}<span class="sx-heat__tot">${nf0.format(dayTot[d])}</span></div>`).join('')}
    </div>`;
  }

  function drawRecent() {
    const rows = data.recent;
    if (!rows.length) { $('#c-recent').innerHTML = empty(); return; }
    const L = data.labels.events;
    const dev = { mobile: '📱', desktop: '💻', tablet: '📲' };
    const short = { rando: 'fiche', gpx: 'GPX', fly: '3D', fly_duel: '3D duel', vs: 'VS', share: 'partage', png: 'PNG', ibp: 'IBP', search: 'recherche', filter: 'filtre', map: 'carte', audio: 'audio', evo: 'évolution', embed: 'compteur', ailleurs: 'ailleurs', ext: 'fiche ext.', install: 'install', outbound: 'lien', blog: 'blog', photos: 'photos', relive: 'Relive', drive: 'Drive', route: 'itinéraire', video: 'vidéo', ext_site: 'autre site', ui: 'clic', vs_add: '+VS', anim: 'animateur' };
    const when = (ts) => new Date(ts.replace(' ', 'T')).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    $('#c-recent').innerHTML = `<table class="sx-table sx-table--log"><thead><tr><th scope="col">Quand</th><th scope="col">Où</th><th scope="col">Appareil</th><th scope="col">Venu de</th><th scope="col" class="num">Durée</th><th scope="col">Parcours</th></tr></thead>
      <tbody>${rows.map((r) => {
        const counts = {};
        for (const e of r.events) counts[e] = (counts[e] || 0) + 1;
        const chips = Object.entries(counts).map(([e, n]) => `<span class="sx-chip sx-chip--${e}" title="${esc(L[e] || e)}">${esc(short[e] || e)}${n > 1 ? ` ×${n}` : ''}</span>`).join('') || '<span class="sx-muted">aucune action</span>';
        return `<tr><td class="nowrap">${when(r.start)}${data.site === 'all' ? `<br><small class="sx-muted">${esc(data.sites[r.site] || r.site)}</small>` : ''}</td>
          <td>${flag(r.country)} ${esc(r.city || 'Inconnue')}</td>
          <td><span aria-hidden="true">${dev[r.device] || ''}</span> ${esc(deviceText(r))}${r.app ? ' <small class="sx-muted">· appli</small>' : ''}${r.scroll ? ` <small class="sx-muted">· lu à ${r.scroll} %</small>` : ''}</td>
          <td>${esc(r.src_type === 'direct' ? 'Accès direct' : r.src_name)}</td>
          <td class="num">${fmtDur(r.dur)}</td><td class="sx-chips">${chips}</td></tr>`;
      }).join('')}</tbody></table>`;
  }

  function drawMisc() {
    // Tranches dans l'ordre (les clés « 0 », « 1 » d'un objet JS passeraient devant les autres)
    const DUR = ['Moins de 10 s', '10 à 30 s', '30 s à 1 min', '1 à 3 min', '3 à 10 min', '10 à 30 min', 'Plus de 30 min'];
    $('#c-dur').innerHTML = columns(DUR.map((k) => [k, data.durations[k] || 0]));
    $('#c-scroll').innerHTML = `<p class="sx-note" style="margin:0 0 var(--space-3)">En moyenne, les pages sont lues jusqu'à <strong>${data.scroll.avg} %</strong> de leur hauteur.</p>${columns(Object.entries(data.scroll.buckets), { unit: 'pages vues' })}`;
    $('#c-depth').innerHTML = columns(['0', '1', '2-3', '4-6', '7-10', '11+'].map((k) => [k === '0' ? 'Aucune' : k, data.depth[k] || 0]), { unit: 'visites' });
    const w = data.widget;
    $('#c-widget').innerHTML = w.total
      ? `<p class="sx-big">${nf0.format(w.total)} <small>affichages du compteur de km sur le blog</small></p>${bars(w.cities.map((r) => [r.k, +r.n]), { max: 6, color: CAT[5] })}`
      : empty('Aucun affichage du compteur sur la période.');
    const note = $('#sx-geo-note');
    note.innerHTML = data.geo_ready && data.asn_ready
      ? `${data.geo_src === 'maxmind'
        ? 'Villes : GeoLite2 City de MaxMind (<a href="https://www.maxmind.com" rel="noopener">maxmind.com</a>). Hébergeurs : DB-IP ASN Lite (CC BY 4.0).'
        : 'Villes et hébergeurs : bases DB-IP City Lite et ASN Lite (CC BY 4.0).'} Installées sur le serveur.` + ' <button type="button" class="btn btn--ghost btn--sm" id="sx-geo">Mettre à jour les bases</button>'
      : '<button type="button" class="btn btn--primary btn--sm" id="sx-geo">Installer les bases des villes et des hébergeurs</button> pour voir d\'où viennent les visiteurs et écarter les pays inhabituels et les centres de données (1 à 2 minutes, à refaire une fois par mois).';
  }

  // Installation de la base des villes, par petites étapes (temps limité par requête chez l'hébergeur)
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('#sx-geo');
    if (!b) return;
    b.disabled = true;
    try {
      for (const [kind, name] of [['asn', 'hébergeurs'], ['city', 'villes']]) {
        let r = await api('geo', { method: 'POST', body: { step: 'debut', kind } });
        while (r.recu < r.taille) {
          b.textContent = `Base des ${name}… ${nf0.format(pct(r.recu, r.taille))} %`;
          r = await api('geo', { method: 'POST', body: { step: 'suite', kind } });
        }
        b.textContent = `Installation des ${name}…`;
        await api('geo', { method: 'POST', body: { step: 'fin', kind } });
      }
      b.textContent = 'Bases installées';
    } catch (err) {
      b.disabled = false;
      b.textContent = `Échec : ${err.message}. Réessayer`;
    }
  });

  // ------------------------------------------------------------ En direct
  async function live() {
    try {
      const l = await api('live');
      const dev = { mobile: '📱', desktop: '💻', tablet: '📲' };
      const ago = (sec) => (sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min`);
      const src = (p) => (p.src_type === 'direct' || !p.src_name ? 'Accès direct' : p.src_name);
      const doing = (p) => (p.event ? `${esc(ONE[p.event] || p.event)}${p.label ? ` · <span class="sx-muted">${esc(p.label)}</span>` : ''}` : '<span class="sx-muted">regarde la liste des randos</span>');
      const rows = l.people.map((p) => `<li class="sx-now__p${p.idle > 120 ? ' is-idle' : ''}">
          <span class="sx-now__who"><span aria-hidden="true">${dev[p.device] || ''}</span> ${flag(p.country)} <strong>${esc(p.city || 'Ville inconnue')}</strong>
            <small class="sx-muted">${esc(deviceText(p))}${p.app ? ' · appli' : ''}</small></span>
          <span class="sx-now__doing">${doing(p)}</span>
          <span class="sx-now__meta"><span>${esc(src(p))}</span><span>depuis ${ago(p.since)}</span><span>${p.actions} action${p.actions > 1 ? 's' : ''}</span></span>
        </li>`).join('');
      const d0 = new Date(), today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
      const feed = l.feed.slice(0, 8).map((f) => `<li><time>${f.ts.slice(0, 10) === today ? '' : `${f.ts.slice(8, 10)}/${f.ts.slice(5, 7)} `}${f.ts.slice(11, 16)}</time> ${esc(ONE[f.event] || f.event)}${f.label ? ` · <span class="sx-muted">${esc(f.label)}</span>` : ''}${f.city ? ` <small class="sx-muted">(${esc(f.city)})</small>` : ''}</li>`).join('');
      const top = Math.max(1, ...l.minutes);
      const bars = l.minutes.map((n, i) => `<span style="height:${Math.max(4, (100 * n) / top)}%" data-tip="${esc(`il y a ${l.minutes.length - i} min : <strong>${n}</strong> personne${n > 1 ? 's' : ''}`)}"${n ? '' : ' class="is-zero"'}></span>`).join('');
      $('#sx-live').innerHTML = `
        <div class="sx-now__head">
          <span class="sx-live__dot${l.now ? ' is-on' : ''}" aria-hidden="true"></span>
          <span class="sx-now__n">${nf0.format(l.now)}</span>
          <span class="sx-now__t">personne${l.now > 1 ? 's' : ''} sur le site en ce moment<small class="sx-muted">${nf0.format(l.today)} visiteur${l.today > 1 ? 's' : ''} aujourd'hui · mis à jour à ${esc(l.time)}</small></span>
          <span class="sx-now__bars" role="img" aria-label="Personnes actives minute par minute, 30 dernières minutes">${bars}</span>
        </div>
        ${rows ? `<ul class="sx-now__list" aria-label="Visiteurs présents">${rows}</ul>` : '<p class="sx-muted sx-now__empty">Personne pour l\'instant. La liste se met à jour toute seule.</p>'}
        ${feed ? `<h3 class="sx-sub">Dernières actions</h3><ul class="sx-live__feed" aria-label="Dernières actions">${feed}</ul>` : ''}`;
    } catch { /* silencieux */ }
  }

  // ------------------------------------------------------------ Chargement
  async function load() {
    paintToolbar();
    $('#sx-app').classList.add('is-loading');
    try {
      data = await api('report', { query: { period: state.period, from: state.from, to: state.to } });
      const name = data.sites[data.site] || '';
      $('#sx-site-name').textContent = name;
      document.title = `Statistiques | ${name}`;
    } catch (err) {
      if (token) $('#sx-summary').textContent = `Impossible de charger les statistiques : ${err.message}`;
      return;
    } finally {
      $('#sx-app').classList.remove('is-loading');
    }
    drawSummary(); drawKpis(); drawEvo(); drawFunnel(); drawActions(); drawRandos(); drawByRando(); drawLists();
    drawSources(); drawGeo(); drawTech(); drawHeat(); drawRecent(); drawMisc();
    live();
  }

  function start() {
    $('#sx-login').hidden = true;
    $('#sx-app').hidden = false;
    $('#sx-logout').hidden = false;
    load();
    clearInterval(liveTimer);
    liveTimer = setInterval(() => { if (document.visibilityState === 'visible') live(); }, 10000);
  }

  let resizeT;
  addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => data && drawEvo(), 150); });

  if (token) start(); else showLogin();
})();
