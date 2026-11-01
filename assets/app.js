/* Randothèque des Godillots Ailés – interface (JavaScript sans dépendance, Leaflet pour les cartes) */
(() => {
  'use strict';

  const DATA = window.RANDOTHEQUE;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const PAGE = 36;

  if (!DATA || !Array.isArray(DATA.randos) || !DATA.randos.length) {
    $('#grid').removeAttribute('aria-busy');
    $('#error').hidden = false;
    $('#results-title').textContent = 'Aucune donnée';
    return;
  }

  const RANDOS = DATA.randos;
  const LEVELS = DATA.levels;
  const LEVEL_BY_ID = Object.fromEntries(LEVELS.map((l) => [l.id, l]));
  const byId = new Map(RANDOS.map((r) => [r.id, r]));
  const css = getComputedStyle(document.documentElement);
  const cssVar = (n) => css.getPropertyValue(n).trim();

  // ------------------------------------------------------------ Formatage
  const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  const df = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtKm = (k) => `${nf1.format(k)} km`;
  const fmtM = (m) => (m == null ? 'n.c.' : `${nf0.format(m)} m`);
  const fmtDur = (min) => {
    if (min == null) return 'n.c.';
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h ? `${h} h ${m ? String(m).padStart(2, '0') : ''}`.trim() : `${m} min`;
  };
  const fmtDate = (d) => { try { return df.format(new Date(d + 'T12:00:00')); } catch { return d; } };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const icon = (id, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const placeOf = (r) => [r.commune, r.deptCode ? `(${r.deptCode})` : r.deptName].filter(Boolean).join(' ');
  const animLinks = (r) => r.animateursList.length
    ? r.animateursList.map((n) => `<button type="button" class="link-btn" data-anim="${esc(n)}" title="Voir les randos animées par ${esc(n)}">${esc(n)}</button>`).join(', ')
    : esc(r.animateurs || '');
  const levelLabel = (r) => (r.level ? LEVEL_BY_ID[r.level].label : 'Non évaluée');
  const ibpBadge = (r) => r.ibp == null ? '' : `
    <span class="ibp ibp--${r.level}" title="IBP index ${r.ibpEstimated ? 'estimé' : r.ibpSource === 'blog' ? 'publié sur le blog' : 'saisi par le club'} : ${r.ibp} (${levelLabel(r)})">
      <span class="ibp__num">${r.ibpEstimated ? '≈' : ''}${r.ibp}</span>${levelLabel(r)}
    </span>`;

  // Texte de recherche pré-calculé
  for (const r of RANDOS) {
    r._search = norm([
      r.name, r.commune, r.deptName, r.deptCode, r.region, r.description, r.animateurs,
      r.blog && r.blog.title, r.file.split('/').pop(), r.meta && r.meta.keywords,
      r.meta && r.meta.author, r.loop ? 'boucle' : 'aller simple', r.date && r.date.slice(0, 4),
      (r.waypoints || []).map((w) => w.name).join(' '),
    ].filter(Boolean).join(' '));
    r._dur = r.durationMin;
    r.animateursList = r.animateursList || [];
  }

  // ------------------------------------------------------------ Bornes des curseurs
  const ceilTo = (v, s) => Math.ceil(v / s) * s;
  const BOUNDS = {
    dist: { min: 0, max: ceilTo(Math.max(...RANDOS.map((r) => r.distanceKm)), 5), step: 1, fmt: (v) => `${v} km` },
    dplus: { min: 0, max: ceilTo(Math.max(...RANDOS.map((r) => r.dplus || 0)), 100), step: 50, fmt: (v) => `${nf0.format(v)} m` },
    dur: { min: 0, max: ceilTo(Math.max(...RANDOS.map((r) => r.durationMin || 0)), 60), step: 30, fmt: (v) => fmtDur(v) },
  };

  // ------------------------------------------------------------ État (synchronisé avec l'URL)
  const defaults = () => ({
    q: '', levels: new Set(), depts: new Set(), anims: new Set(), types: new Set(), sources: new Set(),
    dist: [BOUNDS.dist.min, BOUNDS.dist.max], dplus: [BOUNDS.dplus.min, BOUNDS.dplus.max],
    dur: [BOUNDS.dur.min, BOUNDS.dur.max], sort: 'date-desc', view: 'grid',
  });
  const SET_KEYS = ['levels', 'depts', 'anims', 'types', 'sources'];
  let state = defaults();
  let openId = null;

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const s = defaults();
    s.q = p.get('q') || '';
    for (const k of SET_KEYS) {
      if (p.get(k)) s[k] = new Set(p.get(k).split(','));
    }
    for (const k of ['dist', 'dplus', 'dur']) {
      const v = (p.get(k) || '').split('-').map(Number);
      if (v.length === 2 && v.every(Number.isFinite)) s[k] = v;
    }
    if (p.get('sort')) s.sort = p.get('sort');
    if (p.get('view') === 'map') s.view = 'map';
    state = s;
    openId = p.get('rando');
  }
  function writeHash() {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    for (const k of SET_KEYS) if (state[k].size) p.set(k, [...state[k]].join(','));
    for (const k of ['dist', 'dplus', 'dur']) {
      if (state[k][0] !== BOUNDS[k].min || state[k][1] !== BOUNDS[k].max) p.set(k, state[k].join('-'));
    }
    if (state.sort !== 'date-desc') p.set('sort', state.sort);
    if (state.view !== 'grid') p.set('view', state.view);
    if (openId) p.set('rando', openId);
    const h = p.toString();
    history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
  }

  // ------------------------------------------------------------ Filtrage
  function matches(r, skip) {
    if (state.q) {
      for (const t of norm(state.q).split(/\s+/).filter(Boolean)) if (!r._search.includes(t)) return false;
    }
    if (skip !== 'levels' && state.levels.size && !state.levels.has(r.level || 'na')) return false;
    if (skip !== 'depts' && state.depts.size && !state.depts.has(r.deptName || 'Inconnu')) return false;
    if (skip !== 'anims' && state.anims.size && !r.animateursList.some((n) => state.anims.has(n))) return false;
    if (skip !== 'types' && state.types.size && !state.types.has(r.loop ? 'boucle' : 'aller')) return false;
    if (skip !== 'sources' && state.sources.size && !state.sources.has(r.source)) return false;
    const inRange = (v, [a, b], k) => v == null || (v >= a && (b >= BOUNDS[k].max || v <= b));
    if (!inRange(r.distanceKm, state.dist, 'dist')) return false;
    if (!inRange(r.dplus, state.dplus, 'dplus')) return false;
    if (!inRange(r._dur, state.dur, 'dur')) return false;
    return true;
  }
  const SORTS = {
    'date-desc': (a, b) => b.date.localeCompare(a.date),
    'date-asc': (a, b) => a.date.localeCompare(b.date),
    'dist-asc': (a, b) => a.distanceKm - b.distanceKm,
    'dist-desc': (a, b) => b.distanceKm - a.distanceKm,
    'dplus-asc': (a, b) => (a.dplus ?? 1e9) - (b.dplus ?? 1e9),
    'dplus-desc': (a, b) => (b.dplus ?? -1) - (a.dplus ?? -1),
    'ibp-asc': (a, b) => (a.ibp ?? 1e9) - (b.ibp ?? 1e9),
    'ibp-desc': (a, b) => (b.ibp ?? -1) - (a.ibp ?? -1),
    'name-asc': (a, b) => a.name.localeCompare(b.name, 'fr'),
  };

  // ------------------------------------------------------------ Panneau de filtres
  const deptEntries = (() => {
    const m = new Map();
    for (const r of RANDOS) {
      const k = r.deptName || 'Inconnu';
      if (!m.has(k)) m.set(k, { name: k, code: r.deptCode || '' });
    }
    return [...m.values()].sort((a, b) => (a.code || 'zz').localeCompare(b.code || 'zz') || a.name.localeCompare(b.name));
  })();
  const animEntries = (() => {
    const m = new Map();
    for (const r of RANDOS) for (const n of r.animateursList) m.set(n, (m.get(n) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr')).map(([name]) => ({ name }));
  })();
  const CHECKLISTS = {
    depts: { entries: deptEntries, label: (d) => `${d.code ? `${esc(d.code)} · ` : ''}${esc(d.name)}`, more: (n) => `Afficher les ${n} départements` },
    anims: { entries: animEntries, label: (d) => esc(d.name), more: (n) => `Afficher les ${n} animateurs` },
  };
  const expanded = { depts: false, anims: false };

  function rangeGroup(key, label, hint) {
    const b = BOUNDS[key];
    return `
    <fieldset class="fgroup" data-range="${key}">
      <legend class="fgroup__legend"><span>${label}</span><span class="fgroup__value" id="${key}-value"></span></legend>
      <div class="range">
        <div class="range__track"></div><div class="range__fill" id="${key}-fill"></div>
        <input type="range" id="${key}-min" min="${b.min}" max="${b.max}" step="${b.step}" aria-label="${label} minimum">
        <input type="range" id="${key}-max" min="${b.min}" max="${b.max}" step="${b.step}" aria-label="${label} maximum">
      </div>
      ${hint ? `<p class="fgroup__hint">${hint}</p>` : ''}
    </fieldset>`;
  }

  function buildFilters() {
    $('#filters-body').innerHTML = `
      <fieldset class="fgroup">
        <legend class="fgroup__legend">Difficulté (IBP index)</legend>
        <div class="chips" id="f-levels">
          ${LEVELS.map((l) => `
            <label class="chip"><input type="checkbox" name="levels" value="${l.id}">
              <span><i class="level-dot level-dot--${l.id}" aria-hidden="true"></i>${l.label} <small data-count="levels:${l.id}"></small></span>
            </label>`).join('')}
        </div>
        <p class="fgroup__hint">Vert ≤ 25 · Bleu ≤ 50 · Jaune ≤ 75 · Rouge ≤ 100 · Noir au-delà</p>
      </fieldset>
      ${rangeGroup('dist', 'Distance')}
      ${rangeGroup('dplus', 'Dénivelé positif')}
      ${rangeGroup('dur', 'Temps de marche estimé', 'Pauses non comprises')}
      <fieldset class="fgroup">
        <legend class="fgroup__legend">Type de parcours</legend>
        <div class="chips">
          <label class="chip"><input type="checkbox" name="types" value="boucle"><span>${icon('loop')}Boucle <small data-count="types:boucle"></small></span></label>
          <label class="chip"><input type="checkbox" name="types" value="aller"><span>${icon('arrow')}Aller simple <small data-count="types:aller"></small></span></label>
        </div>
      </fieldset>
      <fieldset class="fgroup">
        <legend class="fgroup__legend">Département</legend>
        <div class="dept-list" id="f-depts"></div>
      </fieldset>
      ${animEntries.length ? `<fieldset class="fgroup">
        <legend class="fgroup__legend">Animateur</legend>
        <div class="dept-list" id="f-anims"></div>
        <p class="fgroup__hint">Randos encadrées par au moins un des animateurs cochés</p>
      </fieldset>` : ''}
      <fieldset class="fgroup">
        <legend class="fgroup__legend">Origine de la trace</legend>
        <div class="chips">
          <label class="chip"><input type="checkbox" name="sources" value="blog"><span>Blog du club <small data-count="sources:blog"></small></span></label>
          <label class="chip"><input type="checkbox" name="sources" value="perso"><span>Ajoutées au dossier <small data-count="sources:perso"></small></span></label>
        </div>
      </fieldset>`;
    renderChecklist('depts');
    if (animEntries.length) renderChecklist('anims');

    $('#filters-body').addEventListener('change', (e) => {
      const t = e.target;
      if (t.type === 'checkbox' && state[t.name]) {
        t.checked ? state[t.name].add(t.value) : state[t.name].delete(t.value);
        update();
      }
    });

    for (const key of Object.keys(BOUNDS)) {
      const lo = $(`#${key}-min`), hi = $(`#${key}-max`);
      const onInput = (which) => {
        let a = +lo.value, b = +hi.value;
        if (a > b) { if (which === 'lo') b = a; else a = b; lo.value = a; hi.value = b; }
        state[key] = [a, b];
        paintRange(key);
        scheduleUpdate();
      };
      lo.addEventListener('input', () => onInput('lo'));
      hi.addEventListener('input', () => onInput('hi'));
    }
  }

  // Liste à cocher repliable (départements, animateurs)
  function renderChecklist(key) {
    const box = $(`#f-${key}`);
    if (!box) return;
    const { entries, label, more } = CHECKLISTS[key];
    const LIMIT = 6;
    const list = expanded[key] ? entries.slice() : entries.slice(0, LIMIT);
    // garder visibles les éléments cochés même repliés
    for (const d of entries) if (state[key].has(d.name) && !list.includes(d)) list.push(d);
    box.innerHTML = list.map((d) => `
      <label class="check">
        <input type="checkbox" name="${key}" value="${esc(d.name)}" ${state[key].has(d.name) ? 'checked' : ''}>
        <span class="check__label">${label(d)}</span>
        <span class="check__count" data-count="${key}:${esc(d.name)}"></span>
      </label>`).join('')
      + (entries.length > LIMIT ? `<button type="button" class="btn btn--ghost btn--sm more-btn" aria-expanded="${expanded[key]}">
          ${expanded[key] ? 'Afficher moins' : more(entries.length)}</button>` : '');
    const btn = $('.more-btn', box);
    if (btn) btn.addEventListener('click', () => { expanded[key] = !expanded[key]; renderChecklist(key); updateCounts(); $('.more-btn', box).focus(); });
  }

  function paintRange(key) {
    const b = BOUNDS[key];
    const [a, c] = state[key];
    const pct = (v) => ((v - b.min) / (b.max - b.min)) * 100;
    const fill = $(`#${key}-fill`);
    fill.style.left = `${pct(a)}%`;
    fill.style.right = `${100 - pct(c)}%`;
    const full = a === b.min && c === b.max;
    $(`#${key}-value`).textContent = full ? 'Tout' : `${b.fmt(a)} à ${c >= b.max ? b.fmt(c) + '+' : b.fmt(c)}`;
    $(`#${key}-min`).setAttribute('aria-valuetext', b.fmt(a));
    $(`#${key}-max`).setAttribute('aria-valuetext', b.fmt(c));
  }

  function syncFilterInputs() {
    $('#q').value = state.q;
    $('#sort').value = SORTS[state.sort] ? state.sort : 'date-desc';
    renderChecklist('depts');
    renderChecklist('anims');
    for (const input of $$('#filters-body input[type=checkbox]')) input.checked = state[input.name].has(input.value);
    for (const key of Object.keys(BOUNDS)) {
      $(`#${key}-min`).value = state[key][0];
      $(`#${key}-max`).value = state[key][1];
      paintRange(key);
    }
    for (const btn of $$('.segmented__btn')) btn.setAttribute('aria-pressed', String(btn.dataset.view === state.view));
  }

  function updateCounts() {
    const facets = {
      levels: (r) => r.level || 'na', types: (r) => (r.loop ? 'boucle' : 'aller'),
      sources: (r) => r.source, depts: (r) => r.deptName || 'Inconnu', anims: (r) => r.animateursList,
    };
    for (const [facet, keyOf] of Object.entries(facets)) {
      const counts = {};
      for (const r of RANDOS) {
        if (!matches(r, facet)) continue;
        for (const k of [].concat(keyOf(r))) counts[k] = (counts[k] || 0) + 1;
      }
      for (const el of $$(`[data-count^="${facet}:"]`)) {
        const val = el.dataset.count.slice(facet.length + 1);
        const n = counts[val] || 0;
        el.textContent = n;
        const input = el.closest('label').querySelector('input');
        input.disabled = n === 0 && !input.checked;
      }
    }
  }

  // ------------------------------------------------------------ Puces des filtres actifs
  function activeFilterTags() {
    const tags = [];
    if (state.q) tags.push({ label: `« ${state.q} »`, clear: () => { state.q = ''; } });
    for (const l of state.levels) tags.push({ label: LEVEL_BY_ID[l] ? LEVEL_BY_ID[l].label : l, clear: () => state.levels.delete(l) });
    for (const k of ['dist', 'dplus', 'dur']) {
      const b = BOUNDS[k], [a, c] = state[k];
      if (a !== b.min || c !== b.max) {
        const name = { dist: 'Distance', dplus: 'D+', dur: 'Durée' }[k];
        tags.push({ label: `${name} ${b.fmt(a)} à ${b.fmt(c)}${c >= b.max ? '+' : ''}`, clear: () => { state[k] = [b.min, b.max]; } });
      }
    }
    for (const t of state.types) tags.push({ label: t === 'boucle' ? 'Boucle' : 'Aller simple', clear: () => state.types.delete(t) });
    for (const d of state.depts) tags.push({ label: d, clear: () => state.depts.delete(d) });
    for (const a of state.anims) tags.push({ label: `Animateur : ${a}`, clear: () => state.anims.delete(a) });
    for (const s of state.sources) tags.push({ label: s === 'blog' ? 'Blog du club' : 'Ajoutées au dossier', clear: () => state.sources.delete(s) });
    return tags;
  }
  function renderActiveFilters() {
    const tags = activeFilterTags();
    const box = $('#active-filters');
    box.innerHTML = tags.map((t, i) => `<button type="button" class="tag-remove" data-i="${i}" aria-label="Retirer le filtre ${esc(t.label)}">${esc(t.label)} ${icon('close')}</button>`).join('');
    $$('.tag-remove', box).forEach((b) => b.addEventListener('click', () => {
      tags[+b.dataset.i].clear();
      syncFilterInputs();
      update();
    }));
    const n = tags.length - (state.q ? 1 : 0);
    const badge = $('#filters-count');
    badge.hidden = !n;
    badge.textContent = n;
  }

  // ------------------------------------------------------------ Dessins SVG
  function shapeSvg(r) {
    const pts = r.shape;
    if (!pts || pts.length < 2) return '';
    const W = 320, H = 180, P = 22;
    const k = Math.cos((pts[0][0] * Math.PI) / 180);
    const xs = pts.map((p) => p[1] * k), ys = pts.map((p) => -p[0]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const s = Math.min((W - 2 * P) / (maxX - minX || 1), (H - 2 * P) / (maxY - minY || 1));
    const ox = (W - (maxX - minX) * s) / 2, oy = (H - (maxY - minY) * s) / 2;
    const coords = xs.map((x, i) => [((x - minX) * s + ox).toFixed(1), ((ys[i] - minY) * s + oy).toFixed(1)]);
    const d = 'M' + coords.map((c) => c.join(',')).join('L');
    return `<svg class="card__shape" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <path class="trk-glow" d="${d}"/><path class="trk" d="${d}"/>
      <circle class="trk-start" cx="${coords[0][0]}" cy="${coords[0][1]}" r="5"/></svg>`;
  }

  function sparkSvg(r) {
    const p = r.profile;
    if (!p || p.length < 2) return '';
    const W = 300, H = 36;
    const eles = p.map((x) => x[1]);
    const min = Math.min(...eles), max = Math.max(...eles);
    const span = Math.max(max - min, 60);
    const pts = p.map((x, i) => [(i / (p.length - 1)) * W, H - 2 - ((x[1] - min) / span) * (H - 6)]);
    const line = 'M' + pts.map((c) => c.map((v) => v.toFixed(1)).join(',')).join('L');
    return `<svg class="card__spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path class="area" d="${line}L${W},${H}L0,${H}Z"/><path class="line" d="${line}"/></svg>`;
  }

  // ------------------------------------------------------------ Cartes de la liste
  function cardHtml(r) {
    const flags = [];
    if (r.blog && r.blog.cancelled) flags.push('<span class="pill pill--warn">Annulée</span>');
    flags.push(`<span class="pill" title="${r.loop ? 'Boucle' : 'Aller simple'}">${icon(r.loop ? 'loop' : 'arrow')}${r.loop ? 'Boucle' : 'Aller'}</span>`);
    return `
    <article class="card">
      <div class="card__visual">
        ${shapeSvg(r)}
        <div class="card__ibp">${ibpBadge(r)}</div>
        <div class="card__flags">${flags.join('')}</div>
      </div>
      <div class="card__body">
        <h3 class="card__title"><a class="card__link" href="#rando=${r.id}" data-open="${r.id}">${esc(r.name)}</a></h3>
        <p class="card__meta">
          ${placeOf(r) ? `<span>${icon('pin')}${esc(placeOf(r))}</span>` : ''}
          <span>${icon('calendar')}${fmtDate(r.date)}</span>
        </p>
        <div class="card__stats">
          <div class="stat"><span class="stat__label">${icon('distance')}Distance</span><span class="stat__value">${fmtKm(r.distanceKm)}</span></div>
          <div class="stat"><span class="stat__label">${icon('up')}D+</span><span class="stat__value">${fmtM(r.dplus)}</span></div>
          <div class="stat"><span class="stat__label">${icon('clock')}Durée</span><span class="stat__value">${fmtDur(r.durationMin)}</span></div>
        </div>
        ${sparkSvg(r)}
      </div>
    </article>`;
  }

  let filtered = [];
  let shown = 0;
  function renderGrid(reset = true) {
    const grid = $('#grid');
    if (reset) { grid.innerHTML = ''; shown = 0; }
    const next = filtered.slice(shown, shown + PAGE);
    grid.insertAdjacentHTML('beforeend', next.map(cardHtml).join(''));
    shown += next.length;
    grid.removeAttribute('aria-busy');
  }

  const sentinelObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && state.view === 'grid' && shown < filtered.length) renderGrid(false);
  }, { rootMargin: '800px 0px' });
  sentinelObserver.observe($('#sentinel'));

  // ------------------------------------------------------------ Mise à jour globale
  let rafId = 0;
  function scheduleUpdate() { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(update); }

  function update() {
    filtered = RANDOS.filter((r) => matches(r)).sort(SORTS[state.sort] || SORTS['date-desc']);
    const n = filtered.length;
    $('#results-title').innerHTML = `<span>${n}</span> rando${n > 1 ? 's' : ''}${n !== RANDOS.length ? ` sur ${RANDOS.length}` : ''}`;
    $('#empty').hidden = n > 0;
    $('#grid').hidden = state.view !== 'grid' || n === 0;
    $('#overview-map').hidden = state.view !== 'map' || n === 0;
    if (state.view === 'grid') renderGrid(true);
    else renderOverviewMap();
    renderActiveFilters();
    updateCounts();
    writeHash();
  }

  // ------------------------------------------------------------ Statistiques du bandeau
  function renderHeroStats() {
    const km = RANDOS.reduce((s, r) => s + r.distanceKm, 0);
    const dp = RANDOS.reduce((s, r) => s + (r.dplus || 0), 0);
    const years = RANDOS.map((r) => r.date.slice(0, 4)).sort();
    $('#hero-stats').innerHTML = `
      <div><dt>Randonnées</dt><dd>${nf0.format(RANDOS.length)}</dd></div>
      <div><dt>Kilomètres de sentiers</dt><dd>${nf0.format(km)} <small>km</small></dd></div>
      <div><dt>Dénivelé cumulé</dt><dd>${nf0.format(dp)} <small>m</small></dd></div>
      <div><dt>Sorties de</dt><dd>${years[0]} <small>à</small> ${years[years.length - 1]}</dd></div>`;
    const when = '';
    // Dernière synchronisation (date et heure de Paris) et lien vers la tâche GitHub de ce dépôt
    if (DATA.blog && DATA.blog.scrapedAt) {
      const at = new Date(DATA.blog.scrapedAt);
      const day = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }).format(at);
      const hour = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(at);
      $('#sync-status').textContent = `Dernière synchronisation avec le blog : le ${day} à ${hour.replace(':', 'h')}.`;
    }
    if (/\.github\.io$/.test(location.hostname)) {
      const owner = location.hostname.split('.')[0];
      const repo = location.pathname.split('/').filter(Boolean)[0];
      if (repo) $('#sync-link').href = `https://github.com/${owner}/${repo}/actions/workflows/mise-a-jour.yml`;
    }
    const model = DATA.ibpModel ? ` IBP estimé calé sur ${DATA.ibpModel.samples} randos du blog (écart moyen ±${nf1.format(DATA.ibpModel.mae)}).` : '';
    $('#footer-info').textContent = `Données générées le ${fmtDate(DATA.generatedAt.slice(0, 10))}.${when}${model}`;
  }

  // ------------------------------------------------------------ Cartes Leaflet
  const hasLeaflet = () => typeof window.L !== 'undefined';
  const IGN = (layer, fmt) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM&FORMAT=${fmt}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
  function baseLayers() {
    return {
      'Plan IGN': L.tileLayer(IGN('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png'), { maxZoom: 19, attribution: '© <a href="https://www.ign.fr/">IGN</a>' }),
      'Topographique': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)' }),
      'Photo aérienne': L.tileLayer(IGN('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'), { maxZoom: 19, attribution: '© <a href="https://www.ign.fr/">IGN</a>' }),
      'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
    };
  }
  const levelColor = (lvl) => (lvl === 'noir' ? '#111' : cssVar(`--c-lvl-${lvl || 'vert'}`)) || cssVar('--c-lime');
  const mapUnavailable = (el) => { el.innerHTML = '<div class="state"><p class="state__title">Carte indisponible</p><p class="state__text">Une connexion internet est nécessaire pour afficher les fonds de carte.</p></div>'; };

  let overview = null, cluster = null;
  function renderOverviewMap() {
    const el = $('#overview-map');
    if (!hasLeaflet()) { mapUnavailable(el); return; }
    if (!overview) {
      overview = L.map(el, { scrollWheelZoom: true });
      const layers = baseLayers();
      layers['Plan IGN'].addTo(overview);
      L.control.layers(layers, null, { position: 'topright' }).addTo(overview);
      cluster = L.markerClusterGroup({
        showCoverageOnHover: false, maxClusterRadius: 45,
        iconCreateFunction: (c) => L.divIcon({ html: `<div class="cluster">${c.getChildCount()}</div>`, className: '', iconSize: [44, 44] }),
      });
      overview.addLayer(cluster);
    }
    cluster.clearLayers();
    const markers = filtered.map((r) => {
      const m = L.marker(r.start, {
        icon: L.divIcon({ className: '', html: `<div class="map-marker map-marker--${r.level || 'vert'}"></div>`, iconSize: [18, 18] }),
        title: r.name, keyboard: true,
      });
      m.bindPopup(`<div class="map-popup">
        <div class="map-popup__title">${esc(r.name)}</div>
        <div class="map-popup__meta">${fmtKm(r.distanceKm)} · ${fmtM(r.dplus)} D+ · ${fmtDur(r.durationMin)}<br>IBP ${r.ibpEstimated ? '≈' : ''}${r.ibp ?? 'n.c.'} (${levelLabel(r)})</div>
        <button type="button" class="btn btn--primary btn--sm" data-open="${r.id}">Voir la fiche</button></div>`);
      return m;
    });
    cluster.addLayers(markers);
    setTimeout(() => {
      overview.invalidateSize();
      if (markers.length) overview.fitBounds(L.featureGroup(markers).getBounds().pad(0.1), { maxZoom: 12 });
    }, 0);
  }

  // ------------------------------------------------------------ Chargement d'une trace
  const trackCache = new Map();
  const trackWaiters = new Map();
  window.__rtTrack = (id, pts) => {
    trackCache.set(id, pts);
    (trackWaiters.get(id) || []).forEach((fn) => fn(pts));
    trackWaiters.delete(id);
  };
  function loadTrack(id) {
    if (trackCache.has(id)) return Promise.resolve(trackCache.get(id));
    return new Promise((resolve, reject) => {
      if (!trackWaiters.has(id)) {
        trackWaiters.set(id, []);
        const s = document.createElement('script');
        s.src = `data/tracks/${id}.js`;
        s.onerror = () => { trackWaiters.delete(id); reject(new Error('trace introuvable')); };
        document.head.appendChild(s);
      }
      trackWaiters.get(id).push(resolve);
    });
  }

  // ------------------------------------------------------------ Envoi du GPX à IBP index
  // On reproduit le formulaire d'ibpindex.com : le GPX est envoyé et l'analyse s'ouvre dans un nouvel onglet.
  const IBP_PAGE = 'https://www.ibpindex.com/ibpindex/analyser.php?LAN=fr';
  const IBP_UPLOAD = 'https://www.ibpindex.com/ibpindex/ibp_de_formulario.php?LAN=fr&REM=ffr';
  const gpxCache = new Map();
  function prefetchGpx(r) {
    const known = gpxCache.get(r.id);
    if (known instanceof Blob) return Promise.resolve(known);
    if (!known) {
      gpxCache.set(r.id, fetch(encodeURI(r.file))
        .then((res) => { if (!res.ok) throw new Error('GPX introuvable'); return res.blob(); })
        .then((blob) => { gpxCache.set(r.id, blob); return blob; })
        .catch((e) => { gpxCache.delete(r.id); throw e; }));
    }
    return gpxCache.get(r.id);
  }
  function submitToIbp(r, blob) {
    const dt = new DataTransfer();
    dt.items.add(new File([blob], r.file.split('/').pop(), { type: 'application/gpx+xml' }));
    const form = document.createElement('form');
    form.method = 'post';
    form.enctype = 'multipart/form-data';
    form.action = IBP_UPLOAD;
    form.target = '_blank';
    form.rel = 'noopener';
    form.hidden = true;
    const input = document.createElement('input');
    input.type = 'file';
    input.name = 'fichero';
    input.files = dt.files;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }
  async function sendToIbp(r) {
    const cached = gpxCache.get(r.id);
    try {
      // GPX déjà préchargé : envoi immédiat, pendant le clic (aucun blocage de fenêtre)
      if (cached instanceof Blob) submitToIbp(r, cached);
      else submitToIbp(r, await prefetchGpx(r));
    } catch {
      window.open(IBP_PAGE, '_blank', 'noopener'); // repli : la page d'IBP, pour choisir le fichier à la main
    }
  }
  // Préchargement du GPX dès qu'on approche du bouton
  ['pointerover', 'focusin', 'touchstart'].forEach((type) => document.addEventListener(type, (e) => {
    const b = e.target.closest && e.target.closest('[data-ibp]');
    if (b) prefetchGpx(byId.get(b.dataset.ibp)).catch(() => {});
  }, { passive: true }));

  // ------------------------------------------------------------ Export de la fiche en image PNG
  // Dessin sur canvas (1920 px de large), sur le modèle de la carte d'analyse IBP du club.
  const PNG = {
    bg: '#080d09', card: '#0c130e', cardLine: '#1a271d', tile: '#101912', tileLine: '#1c2b20',
    text: '#eef5ef', muted: '#8fa293', soft: '#9aa89c', green: '#3fbf6a', dot: '#22c55e', track: '#1f2a22',
    up: '#e11d2e', flat: '#34d27a', down: '#4f8ff7',
    levels: {
      vert: ['#3ddc84', 'Très facile'], bleu: ['#4f8ff7', 'Facile'], jaune: ['#f5a524', 'Peu difficile'],
      rouge: ['#ef4444', 'Difficile'], noir: ['#e5e7eb', 'Très difficile'],
    },
  };
  const SANS = '"IBM Plex Sans", "Plus Jakarta Sans", system-ui, sans-serif';
  const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
  const EMOJI = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  const hms = (sec) => {
    const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
  };
  const ddmmyyyy = (d) => { const [y, m, j] = d.slice(0, 10).split('-'); return `${j}/${m}/${y}`; };
  const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'rando';

  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function text(ctx, str, x, y, { font, color, align = 'left', spacing = 0, maxWidth } = {}) {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
    let s = String(str);
    if (maxWidth && ctx.measureText(s).width > maxWidth) {
      while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
      s += '…';
    }
    ctx.fillText(s, x, y);
    const w = ctx.measureText(s).width;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    return w;
  }
  // Valeur en gras suivie de son unité en petit (ex. « 16.14 km »)
  function valueUnit(ctx, value, unit, x, y, { size, color = PNG.text, unitSize = 9.5 }) {
    const w = text(ctx, value, x, y, { font: `700 ${size}px ${SANS}`, color });
    if (unit) text(ctx, unit, x + w + 3, y, { font: `400 ${unitSize}px ${MONO}`, color: PNG.muted });
  }

  async function drawPngCard(r) {
    await Promise.all([
      `700 17px ${SANS}`, `600 10px ${SANS}`, `400 11px ${SANS}`, `400 11px ${MONO}`, `600 11px ${MONO}`,
    ].map((f) => document.fonts.load(f).catch(() => {})));
    const S = 2, W = 960, H = 611, X = 32, Y = 32, CW = 896, CH = 547;
    const canvas = document.createElement('canvas');
    canvas.width = W * S; canvas.height = H * S;
    const ctx = canvas.getContext('2d');
    ctx.scale(S, S);
    ctx.fillStyle = PNG.bg; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.translate(X, Y);

    // Carte
    rrect(ctx, 0.5, 0.5, CW - 1, CH - 1, 20); ctx.fillStyle = PNG.card; ctx.fill();
    ctx.strokeStyle = PNG.cardLine; ctx.lineWidth = 1; ctx.stroke();
    const hline = (y) => { ctx.fillStyle = PNG.cardLine; ctx.fillRect(1, y, CW - 2, 1); };

    // En-tête
    text(ctx, '🏔️', 29, 46, { font: `26px ${EMOJI}`, color: PNG.text });
    text(ctx, r.name, 66.5, 31.5, { font: `700 17px ${SANS}`, color: PNG.text, maxWidth: 560 });
    text(ctx, '📅', 66, 49, { font: `11px ${EMOJI}`, color: PNG.text });
    text(ctx, ddmmyyyy(r.date), 83, 49, { font: `400 11px ${MONO}`, color: PNG.muted });
    text(ctx, 'Les Godillots Ailés · Caissargues', 866.5, 31, { font: `700 12px ${SANS}`, color: PNG.text, align: 'right' });
    text(ctx, 'godillotsailes.blogspot.com', 866.5, 48, { font: `400 10.5px ${MONO}`, color: PNG.green, align: 'right' });
    hline(67);

    // Indice IBP
    const [lvlColor, lvlLabel] = PNG.levels[r.level] || ['#8fa293', 'Non évaluée'];
    rrect(ctx, 29, 88, 206.5, 87.5, 14);
    ctx.fillStyle = PNG.card; ctx.fill();
    ctx.globalAlpha = 0.13; ctx.fillStyle = lvlColor; ctx.fill(); ctx.globalAlpha = 1;
    ctx.globalAlpha = 0.55; ctx.strokeStyle = lvlColor; ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
    const ibpTxt = r.ibp == null ? '?' : String(r.ibp);
    const ibpSize = ibpTxt.length > 2 ? 34 : 42;
    const ibpW = text(ctx, ibpTxt, 50, 148, { font: `700 ${ibpSize}px ${SANS}`, color: lvlColor });
    const lx = Math.max(120, 50 + ibpW + 14), lw = 29 + 206.5 - 12 - lx;
    text(ctx, 'HKG', lx, 116.5, { font: `400 10px ${MONO}`, color: PNG.muted, spacing: 0.5 });
    text(ctx, lvlLabel, lx, 138, { font: `700 16px ${SANS}`, color: lvlColor, maxWidth: lw });
    text(ctx, r.ibpEstimated ? 'Indice IBP estimé' : 'Indice IBP', lx, 155, { font: `400 11px ${SANS}`, color: PNG.soft, maxWidth: lw });

    // Source de l'indice (à la place de la « fiabilité », propre à ibpindex.com)
    const src = {
      blog: ['Publié sur le blog', 1, PNG.flat], manuel: ['Saisi par le club', 1, PNG.flat],
      fichier: ['Saisi par le club', 1, PNG.flat], estime: ['Estimé · ±2', 0.6, '#f5a524'],
    }[r.ibpSource] || ['Non évalué', 0, PNG.muted];
    const srcW = text(ctx, "Source de l'indice", 260, 136, { font: `400 11px ${SANS}`, color: PNG.soft });
    const bx = 260 + srcW + 10;
    rrect(ctx, bx, 132.5, 129, 5, 2.5); ctx.fillStyle = PNG.track; ctx.fill();
    if (src[1]) { rrect(ctx, bx, 132.5, 129 * src[1], 5, 2.5); ctx.fillStyle = src[2]; ctx.fill(); }
    text(ctx, src[0], bx + 129 + 10, 136.5, { font: `600 11px ${MONO}`, color: src[2] });
    hline(196.5);

    // Tuiles de statistiques
    const tile = (x, y, w, h) => {
      rrect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 11); ctx.fillStyle = PNG.tile; ctx.fill();
      ctx.strokeStyle = PNG.tileLine; ctx.lineWidth = 1; ctx.stroke();
    };
    const small = (x, y, emoji, label, value, unit, valueY) => {
      tile(x, y, 160.5, 87);
      text(ctx, emoji, x + 15, y + 27, { font: `13px ${EMOJI}`, color: PNG.text });
      text(ctx, label, x + 15, y + 48, { font: `600 9.5px ${SANS}`, color: PNG.muted, spacing: 1.2, maxWidth: 140 });
      valueUnit(ctx, value, unit, x + 15, y + valueY, { size: 18 });
    };
    const cols = [29, 198, 367, 536, 705];
    const f2 = (n) => (n == null ? '—' : n.toFixed(2));
    const f0 = (n) => (n == null ? '—' : String(Math.round(n)));
    small(cols[0], 215.5, '📏', 'DISTANCE TOTALE', f2(r.distanceKm), 'km', 68);
    small(cols[1], 215.5, '⬆️', 'DÉNIVELÉE POSITIVE', f0(r.dplus), 'm', 68);
    small(cols[2], 215.5, '⬇️', 'DÉNIVELÉE NÉGATIVE', f0(r.dminus), 'm', 68);
    small(cols[3], 215.5, '🔼', 'ALTITUDE MAXIMALE', f0(r.altMax), 'm', 68);
    small(cols[4], 215.5, '🔽', 'ALTITUDE MINIMALE', f0(r.altMin), 'm', 68);
    const rec = r.recorded && r.recorded.totalSec ? r.recorded : null;
    const v = (km, sec) => (sec > 0 ? (km / (sec / 3600)).toFixed(1) : '—');
    if (rec) {
      small(cols[0], 311.5, '⏱️', 'TEMPS TOTAL', `${hms(rec.totalSec)} h`, '', 67);
      small(cols[1], 311.5, '🏃', 'TEMPS MOUVEMENT', `${hms(rec.movingSec)} h`, '', 67);
      small(cols[2], 311.5, '☕', 'TEMPS DE PAUSE', `${hms(rec.pauseSec)} h`, '', 67);
      small(cols[3], 311.5, '💨', 'VITESSE MOY. TOTALE', v(r.distanceKm, rec.totalSec), 'km/h', 67);
      small(cols[4], 311.5, '⚡', 'VITESSE MOY. MVT', v(r.distanceKm, rec.movingSec), 'km/h', 67);
    } else {
      small(cols[0], 311.5, '⏱️', 'TEMPS ESTIMÉ', `${hms(r.durationMin * 60)} h`, '', 67);
      small(cols[1], 311.5, '🏃', 'TEMPS MOUVEMENT', '—', '', 67);
      small(cols[2], 311.5, '☕', 'TEMPS DE PAUSE', '—', '', 67);
      small(cols[3], 311.5, '💨', 'VITESSE MOY. TOTALE', '—', '', 67);
      small(cols[4], 311.5, '⚡', 'VITESSE MOY. MVT', '—', '', 67);
    }

    // Montée / plat / descente
    const sl = r.slopes || { upKm: 0, flatKm: 0, downKm: 0 };
    const tot = sl.upKm + sl.flatKm + sl.downKm || 1;
    [[29, 'MONTÉE', sl.upKm, PNG.up], [311.5, 'PLAT', sl.flatKm, PNG.flat], [593, 'DESCENTE', sl.downKm, PNG.down]]
      .forEach(([x, label, km, color]) => {
        const y = 408.5, w = 273, pct = km / tot;
        tile(x, y, w, 88);
        text(ctx, label, x + 17, y + 25, { font: `600 9.5px ${SANS}`, color: PNG.muted, spacing: 1.2 });
        text(ctx, `${(pct * 100).toFixed(1)}%`, x + w - 17, y + 25, { font: `400 10.5px ${MONO}`, color: PNG.muted, align: 'right' });
        valueUnit(ctx, km.toFixed(2), 'km', x + 17, y + 59, { size: 22, color, unitSize: 10 });
        rrect(ctx, x + 17, y + 70, w - 34, 4, 2); ctx.fillStyle = PNG.track; ctx.fill();
        if (pct > 0) { rrect(ctx, x + 17, y + 70, Math.max(4, (w - 34) * pct), 4, 2); ctx.fillStyle = color; ctx.fill(); }
      });

    // Pied
    hline(517.5);
    ctx.beginPath(); ctx.arc(31.5, 532, 3.5, 0, Math.PI * 2); ctx.fillStyle = PNG.dot; ctx.fill();
    text(ctx, 'Les Godillots Ailés', 40, 535.5, { font: `400 10.5px ${MONO}`, color: PNG.muted });
    text(ctx, `Généré le ${ddmmyyyy(new Date().toISOString())}`, CW / 2, 535.5, { font: `400 10.5px ${MONO}`, color: PNG.muted, align: 'center' });
    text(ctx, 'Caissargues · godillotsailes.blogspot.com', 866.5, 535.5, { font: `400 10.5px ${MONO}`, color: PNG.muted, align: 'right' });
    ctx.restore();
    return canvas;
  }

  async function exportPng(r, btn) {
    if (!r) return;
    const label = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Création de l\'image…'; }
    try {
      const canvas = await drawPngCard(r);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${r.date}-${slug(r.name)}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
  }
  window.__rtDrawPngCard = (id) => drawPngCard(byId.get(id)); // pour contrôle visuel

  // ------------------------------------------------------------ Fiche détaillée
  const dialog = $('#detail');
  let detailMap = null, cursorMarker = null;

  function kpi(iconId, label, value, hint, cls = '') {
    return `<div class="kpi ${cls}"><div class="kpi__label">${icon(iconId)}${label}</div><div class="kpi__value">${value}</div>${hint ? `<div class="kpi__hint">${hint}</div>` : ''}</div>`;
  }

  const META_LABELS = {
    name: 'Nom', trackName: 'Nom de la trace', routeName: 'Nom de la route', description: 'Description',
    trackDescription: 'Description de la trace', trackComment: 'Commentaire', author: 'Auteur', time: 'Créé le',
    keywords: 'Mots-clés', creator: 'Logiciel', version: 'Version GPX', trackType: 'Activité', link: 'Lien', copyright: 'Droits',
  };

  function detailHtml(r) {
    const lvl = r.level;
    const fileName = r.file.split('/').pop();
    const metaRows = Object.entries(r.meta || {})
      .filter(([k]) => META_LABELS[k] && !(k === 'description' && r.description === r.meta.description))
      .map(([k, v]) => {
        let val = esc(v);
        if (k === 'time') { const d = new Date(v); if (!isNaN(d)) val = df.format(d); }
        if (k === 'link' && /^https?:/.test(v)) val = `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`;
        return `<dt>${META_LABELS[k]}</dt><dd>${val}</dd>`;
      }).join('');
    const rec = r.recorded ? `<dt>Durée enregistrée</dt><dd>${fmtDur(r.recorded.totalMin)} (dont ${fmtDur(r.recorded.movingMin)} en mouvement)</dd>` : '';
    const ibpHint = {
      estime: 'Estimation calculée à partir de la distance et des dénivelés.',
      manuel: 'Valeur saisie par le club.',
      fichier: 'Valeur indiquée avec le fichier GPX.',
    }[r.ibpSource] || 'Valeur publiée sur le blog du club.';
    const blog = r.blog;
    return `
      <header class="detail__head">
        <div class="detail__headings">
          <h2 class="detail__title" id="detail-title">${esc(r.name)}</h2>
          <p class="detail__sub">
            ${placeOf(r) ? `<span>${icon('pin')}${esc([r.commune, r.deptName].filter(Boolean).join(', '))}</span>` : ''}
            <span>${icon('calendar')}${fmtDate(r.date)}</span>
            ${r.animateurs ? `<span>${icon('user')}${animLinks(r)}</span>` : ''}
          </p>
        </div>
        <button type="button" class="icon-btn" data-close aria-label="Fermer la fiche">${icon('close')}</button>
      </header>
      <div class="detail__body">
        <div class="detail__main">
          <div class="detail__map" id="detail-map" role="region" aria-label="Carte du parcours"></div>
          <section class="panel" aria-labelledby="profile-title">
            <h3 class="panel__title" id="profile-title">Profil altimétrique</h3>
            <div class="profile" id="profile"><div class="state" style="padding:var(--space-8)">Chargement du profil…</div></div>
          </section>
          ${r.description ? `<section class="panel"><h3 class="panel__title">Description</h3><p class="desc">${esc(r.description)}</p></section>` : ''}
          <section class="panel" aria-labelledby="meta-title">
            <h3 class="panel__title" id="meta-title">Métadonnées du fichier GPX</h3>
            <dl class="meta-list">
              <dt>Fichier</dt><dd>${esc(fileName)}</dd>
              ${metaRows}
              <dt>Contenu</dt><dd>${r.kind === 'route' ? 'Route' : 'Trace'} de ${nf0.format(r.points)} points${r.waypoints && r.waypoints.length ? `, ${r.waypoints.length} point(s) d'intérêt` : ''}</dd>
              <dt>Altitudes</dt><dd>${r.eleSource === 'ign' ? 'Complétées par le service altimétrique IGN' : r.eleSource ? 'Issues du fichier GPX' : 'Absentes'}</dd>
              ${rec}
              <dt>Départ</dt><dd>${r.start[0].toFixed(5)}, ${r.start[1].toFixed(5)}</dd>
            </dl>
          </section>
        </div>
        <aside class="detail__side">
          <div class="kpis">
            <div class="kpi kpi--wide kpi--ibp">
              <div class="ibp-big ibp-big--${lvl}" aria-hidden="true">${r.ibpEstimated ? '≈' : ''}${r.ibp ?? '?'}</div>
              <div>
                <div class="kpi__label">${icon('gauge')}IBP index ${r.ibpEstimated ? 'estimé' : ''}</div>
                <div class="kpi__value">${r.ibp ?? 'n.c.'} <small>${levelLabel(r)}${lvl ? ` (${lvl})` : ''}</small></div>
                <div class="kpi__hint">${ibpHint}</div>
              </div>
            </div>
            ${kpi('distance', 'Distance', fmtKm(r.distanceKm))}
            ${kpi('clock', 'Temps estimé', fmtDur(r.durationMin), 'Hors pauses')}
            ${kpi('up', 'Dénivelé +', fmtM(r.dplus))}
            ${kpi('down', 'Dénivelé −', fmtM(r.dminus))}
            ${kpi('up', 'Altitude max', fmtM(r.altMax))}
            ${kpi('down', 'Altitude min', fmtM(r.altMin))}
            ${kpi(r.loop ? 'loop' : 'arrow', 'Parcours', r.loop ? 'Boucle' : 'Aller simple', '', 'kpi--wide')}
          </div>
          <div class="actions">
            <a class="btn btn--primary btn--block" href="${encodeURI(r.file)}" download="${esc(fileName)}">${icon('download')}Télécharger le GPX</a>
            <button type="button" class="btn btn--outline btn--block" data-png="${r.id}">${icon('image')}Exporter la fiche en image (PNG)</button>
            ${blog ? `<a class="btn btn--outline btn--block" href="${esc(blog.url)}" target="_blank" rel="noopener">${icon('external')}Voir l'article sur le blog</a>` : ''}
            <a class="btn btn--outline btn--block" href="${IBP_PAGE}" target="_blank" rel="noopener" data-ibp="${r.id}"
               title="Le fichier GPX est envoyé à ibpindex.com, qui affiche son analyse dans un nouvel onglet">${icon('gauge')}Analyser la trace sur ibpindex.com</a>
          </div>
          ${blog ? `
          <section class="panel" aria-labelledby="blog-title">
            <h3 class="panel__title" id="blog-title">Sur le blog</h3>
            ${blog.image ? `<div class="photo"><img src="${esc(blog.image)}" alt="Photo de la sortie ${esc(r.name)}" loading="lazy" width="640" height="360"></div>` : ''}
            <dl class="meta-list" style="margin-top:var(--space-3)">
              <dt>Article</dt><dd><a href="${esc(blog.url)}" target="_blank" rel="noopener">${esc(blog.title)}</a></dd>
              ${r.animateurs ? `<dt>Animateurs</dt><dd>${animLinks(r)}</dd>` : ''}
              ${blog.outings && blog.outings.length ? `<dt>Sortie${blog.outings.length > 1 ? 's' : ''}</dt><dd class="outings">${blog.outings.map((d) => `<span class="pill">${fmtDate(d)}</span>`).join('')}</dd>` : ''}
              ${blog.cancelled ? '<dt>Statut</dt><dd><span class="pill pill--warn">Sortie annulée</span></dd>' : ''}
            </dl>
          </section>` : ''}
        </aside>
      </div>`;
  }

  function renderProfile(track, onHover) {
    const box = $('#profile');
    const pts = track.filter((p) => p[2] != null);
    if (pts.length < 2) { box.innerHTML = '<p class="desc">Pas de données d\'altitude dans ce fichier.</p>'; return; }
    const W = Math.max(280, Math.round(box.clientWidth) || 600), H = 176, L = 40, B = 20, T = 8;
    const total = pts[pts.length - 1][3];
    const eles = pts.map((p) => p[2]);
    let min = Math.min(...eles), max = Math.max(...eles);
    const pad = Math.max(20, (max - min) * 0.1);
    min = Math.floor((min - pad) / 10) * 10; max = Math.ceil((max + pad) / 10) * 10;
    const x = (d) => L + (d / total) * (W - L - 4);
    const y = (e) => T + (1 - (e - min) / (max - min)) * (H - T - B);
    const line = 'M' + pts.map((p) => `${x(p[3]).toFixed(1)},${y(p[2]).toFixed(1)}`).join('L');
    const yTicks = [min, Math.round((min + max) / 2), max];
    const step = (total > 20 ? 5 : total > 8 ? 2 : 1) * (W < 420 && total > 8 ? 2 : 1);
    const xTicks = [];
    for (let k = 0; k <= total; k += step) xTicks.push(k);
    box.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Profil : altitude de ${nf0.format(Math.min(...eles))} à ${nf0.format(Math.max(...eles))} mètres sur ${fmtKm(total)}">
        <defs><linearGradient id="profile-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="${cssVar('--c-lime')}" stop-opacity=".35"/><stop offset="1" stop-color="${cssVar('--c-lime')}" stop-opacity="0"/></linearGradient></defs>
        ${yTicks.map((t) => `<line class="p-grid" x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="p-axis" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('')}
        ${xTicks.map((t) => `<text class="p-axis" x="${x(t)}" y="${H - 4}" text-anchor="middle">${t}</text>`).join('')}
        <path class="p-area" d="${line}L${x(total)},${H - B}L${L},${H - B}Z"/>
        <path class="p-line" d="${line}"/>
        <line class="p-cursor" id="p-cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
      </svg>
      <div class="profile__tip" id="p-tip" hidden></div>`;
    const svg = $('svg', box), cursor = $('#p-cursor'), tip = $('#p-tip');
    const move = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const vx = ((clientX - rect.left) / rect.width) * W;
      const d = Math.max(0, Math.min(total, ((vx - L) / (W - L - 4)) * total));
      let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][3] < d) lo = mid; else hi = mid; }
      const p = Math.abs(pts[lo][3] - d) < Math.abs(pts[hi][3] - d) ? pts[lo] : pts[hi];
      cursor.setAttribute('x1', x(p[3])); cursor.setAttribute('x2', x(p[3]));
      cursor.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.style.left = `${(x(p[3]) / W) * 100}%`;
      tip.textContent = `${nf1.format(p[3])} km · ${nf0.format(p[2])} m`;
      onHover(p);
    };
    const leave = () => { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; onHover(null); };
    svg.addEventListener('pointermove', (e) => move(e.clientX));
    svg.addEventListener('pointerdown', (e) => move(e.clientX));
    svg.addEventListener('pointerleave', leave);
  }

  async function openDetail(id, { push = true } = {}) {
    const r = byId.get(id);
    if (!r) return;
    openId = id;
    if (push) writeHash();
    $('#detail-content').innerHTML = detailHtml(r);
    if (!dialog.open) dialog.showModal();
    $('#detail-content').scrollTop = 0;
    dialog.scrollTop = 0;
    $('[data-close]', dialog).focus();

    const mapEl = $('#detail-map');
    if (detailMap) { detailMap.remove(); detailMap = null; }
    let track;
    try { track = await loadTrack(id); } catch {
      $('#profile').innerHTML = '<p class="desc">Trace introuvable. Relancez « npm run build ».</p>';
      mapUnavailable(mapEl);
      return;
    }
    if (openId !== id) return;
    if (hasLeaflet()) {
      detailMap = L.map(mapEl, { scrollWheelZoom: false });
      const layers = baseLayers();
      const inFrance = !!r.region;
      (inFrance ? layers['Plan IGN'] : layers['Topographique']).addTo(detailMap);
      L.control.layers(layers, null, { position: 'topright' }).addTo(detailMap);
      const latlngs = track.map((p) => [p[0], p[1]]);
      L.polyline(latlngs, { color: cssVar('--c-bg'), weight: 8, opacity: 0.55 }).addTo(detailMap);
      const line = L.polyline(latlngs, { color: levelColor(r.level), weight: 4.5, opacity: 1 }).addTo(detailMap);
      if (r.level === 'noir') line.setStyle({ color: '#000' });
      const end = latlngs[latlngs.length - 1];
      if (!r.loop) L.marker(end, { icon: L.divIcon({ className: '', html: '<div class="pin-end" title="Arrivée">A</div>', iconSize: [28, 28] }) }).addTo(detailMap);
      L.marker(latlngs[0], { icon: L.divIcon({ className: '', html: '<div class="pin-start" title="Départ">D</div>', iconSize: [28, 28] }) }).addTo(detailMap);
      for (const w of r.waypoints || []) L.circleMarker([w.lat, w.lon], { radius: 5, color: cssVar('--c-cyan'), weight: 2, fillOpacity: 0.6 }).bindTooltip(esc(w.name)).addTo(detailMap);
      cursorMarker = L.marker(latlngs[0], { icon: L.divIcon({ className: '', html: '<div class="pin-cursor"></div>', iconSize: [16, 16] }), interactive: false, keyboard: false });
      detailMap.fitBounds(line.getBounds().pad(0.08));
      setTimeout(() => detailMap && detailMap.invalidateSize(), 60);
    } else {
      mapUnavailable(mapEl);
    }
    renderProfile(track, (p) => {
      if (!detailMap || !cursorMarker) return;
      if (p) { cursorMarker.setLatLng([p[0], p[1]]); if (!detailMap.hasLayer(cursorMarker)) cursorMarker.addTo(detailMap); }
      else if (detailMap.hasLayer(cursorMarker)) cursorMarker.remove();
    });
  }

  function closeDetail() {
    if (dialog.open) dialog.close();
  }
  dialog.addEventListener('close', () => {
    if (detailMap) { detailMap.remove(); detailMap = null; }
    const last = openId;
    openId = null;
    writeHash();
    const link = last && $(`[data-open="${last}"]`, $('#grid'));
    if (link) link.focus({ preventScroll: true });
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) closeDetail();
  });

  // ------------------------------------------------------------ Panneau des filtres (mobile)
  const filtersEl = $('#filters'), backdrop = $('#filters-backdrop'), openBtn = $('#open-filters');
  const isDrawer = () => !matchMedia('(min-width: 1024px)').matches;
  function openFilters() {
    filtersEl.classList.add('is-open');
    backdrop.hidden = false;
    openBtn.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    setTimeout(() => $('#close-filters').focus(), 50);
  }
  function closeFilters() {
    if (!filtersEl.classList.contains('is-open')) return;
    filtersEl.classList.remove('is-open');
    backdrop.hidden = true;
    openBtn.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    openBtn.focus();
  }
  openBtn.addEventListener('click', openFilters);
  $('#close-filters').addEventListener('click', closeFilters);
  $('#apply-filters').addEventListener('click', () => { closeFilters(); $('#resultats').scrollIntoView({ block: 'start' }); });
  backdrop.addEventListener('click', closeFilters);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDrawer()) closeFilters();
    if (e.key === '/' && !/input|select|textarea/i.test(document.activeElement.tagName) && !dialog.open) {
      e.preventDefault(); $('#q').focus();
    }
  });

  // ------------------------------------------------------------ Événements
  let qTimer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.q = e.target.value.trim(); update(); }, 120);
  });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; update(); });
  $$('.segmented__btn').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    syncFilterInputs();
    update();
  }));
  const resetAll = () => {
    const view = state.view;
    state = defaults();
    state.view = view;
    syncFilterInputs();
    update();
  };
  $('#reset-filters').addEventListener('click', resetAll);
  $('[data-action="reset"]').addEventListener('click', resetAll);

  document.addEventListener('click', (e) => {
    const png = e.target.closest('[data-png]');
    if (png) { exportPng(byId.get(png.dataset.png), png); return; }
    const ibp = e.target.closest('[data-ibp]');
    if (ibp) { e.preventDefault(); sendToIbp(byId.get(ibp.dataset.ibp)); return; }
    const anim = e.target.closest('[data-anim]');
    if (anim) {
      state.anims = new Set([anim.dataset.anim]);
      closeDetail();
      syncFilterInputs();
      update();
      $('#resultats').scrollIntoView({ block: 'start' });
      return;
    }
    const opener = e.target.closest('[data-open]');
    if (opener) { e.preventDefault(); openDetail(opener.dataset.open); }
  });
  window.addEventListener('hashchange', () => {
    readHash();
    syncFilterInputs();
    update();
    if (openId) openDetail(openId, { push: false }); else closeDetail();
  });

  // ------------------------------------------------------------ Démarrage
  // Dégradé partagé par les mini-profils des cartes
  document.body.insertAdjacentHTML('beforeend', `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <linearGradient id="spark-grad" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${cssVar('--c-cyan')}" stop-opacity=".28"/><stop offset="1" stop-color="${cssVar('--c-cyan')}" stop-opacity="0"/></linearGradient></defs></svg>`);
  readHash();
  buildFilters();
  syncFilterInputs();
  renderHeroStats();
  update();
  if (openId) openDetail(openId, { push: false });
})();
