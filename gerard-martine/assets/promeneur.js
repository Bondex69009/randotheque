/* Randothèque – le randonneur qui se promène sur la page : il marche sur le bord haut des éléments visibles
   (cartes, boutons, titres…), change de sens, saute de temps en temps sur un bloc voisin et fait des pauses
   (boire un coup, lire la carte, regarder son GPS, observer aux jumelles, refaire ses lacets).
   S'il doit changer de coin (élément sorti de l'écran), il disparaît en fondu et réapparaît ailleurs : jamais
   de grand saut à travers la page.
   Décoratif : se cache si l'élément est recouvert (fenêtre, menu) et ne bouge pas du tout quand le visiteur a
   demandé moins d'animations. Un clic (ou un toucher) sur lui : il s'arrête, marche sur place et chante la
   vieille comptine de marche dans une bulle, avec une petite mélodie ; un kilomètre de plus à chaque fois.
   Autonome (dessin et styles inclus) : le même fichier sert sur le blog des Godillots, chargé par le code
   d'intégration du compteur avec l'attribut data-blog ; il part alors du compteur et se promène sur les widgets,
   les articles et les photos du blog. */
(() => {
  if (!window.requestAnimationFrame || document.querySelector('.rt-promeneur')) return;
  const script = document.currentScript;
  const BLOG = !!(script && script.hasAttribute('data-blog'));
  // Sur le blog, ce fichier amène aussi l'habillage des saisons (neige, printemps…) sur toute la page :
  // le code déjà collé dans Blogger n'a pas à changer.
  if (BLOG && script.src && !document.querySelector('script[src*="saisons.js"]')) {
    const s = document.createElement('script');
    s.src = new URL('saisons.js?v=2', script.src).href;
    s.dataset.chute = '14';
    document.head.appendChild(s);
  }
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce && reduce.matches) return;

  const SIZE = 46;            // taille du randonneur (px)
  const SPEED = 48;           // vitesse de marche (px/s)
  const HOP_MS = 650;         // durée d'un saut vers un bloc voisin
  const HOP_DX = 110;         // écart horizontal maximal entre deux blocs pour sauter (px)
  const HOP_DY = 150;         // écart vertical maximal (px)
  const STAY = [9000, 16000]; // temps maximal sur un même bloc avant d'aller voir ailleurs (ms)
  // Éléments candidats ; seuls ceux dont le bord haut est réellement dessiné (fond, bordure, photo) servent de sol
  const SELECTORS = (BLOG ? [
    '#ga-compteur', '.date-outer', '.widget', '.widget-content li', '.blog-pager', '.post-body img', '.widget img',
    'iframe.embedly-embed', '.gsc-input',
  ] : [
    '.card', '.card__visual', '.hero-total', '.hero-stats > div', '.btn', '.chip', '.segmented', '.search', '.toolbar',
    '.filters', '.overview-map', '.evo', '.elsewhere', '.site-footer', '.site-header',
  ]).join(',');

  // Dessin du randonneur (le même que celui des chargements du site)
  const HIKER = '<svg class="hiker" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path class="hiker__ground" d="M-6 30.8H38"/><g class="hiker__body"><g class="hiker__arm hiker__arm--b"><path d="M15.7 10.8C15.8 12.6 16.1 14.2 16.3 15.3L17.6 15.1C17.7 13.6 17.6 12.2 17.5 10.8Z"/><path d="M16.3 14.6C17.1 15.4 18 16 19.1 16.7L19.8 15.8C18.8 15.2 18.1 14.6 17.5 14.1Z"/><circle cx="19.6" cy="16.3" r=".85"/></g><g class="hiker__leg hiker__leg--b"><path d="M13.5 17.4C13.6 19.8 13.9 21.9 14.1 23.7H15.9C16.3 21.9 16.9 19.7 17 17.4Z"/><g class="hiker__shin"><path d="M14.1 23.2C13.6 24.6 13.9 26.9 14.3 28.6H15.7C15.9 26.9 16.2 24.9 15.9 23.2Z"/><path d="M14.2 28.1H15.8C16.7 28.4 17.9 28.7 18.2 29.4 18.3 29.9 18 30.1 17.5 30.1H14.3C13.9 30.1 13.9 29.3 14.2 28.1Z"/></g></g><path class="hiker__pack" d="M11.2 11.6C11.1 9.9 13.9 9.3 15.1 10.4L15.6 16.3C15.7 17.6 11.9 17.9 11.5 16.7Z"/><path d="M11.6 9.8C12.3 9 13.9 8.9 14.6 9.6L14.4 10.4C13.6 10 12.6 10.1 11.9 10.6Z"/><path d="M14.8 10C16.2 9.3 18.1 9.6 18.5 11.2 18.6 12.9 18 15.4 17.6 17.4 17.3 18.8 13.4 18.9 13.5 17.4 13.6 15 14 12.2 14.8 10Z"/><path d="M16.6 8.2L17.8 8.3 17.7 9.9 16.4 9.8Z"/><circle cx="17.9" cy="6.6" r="2"/><path d="M14.9 5.6C16.4 5.1 19.5 5 21.1 5.5 21.4 5.7 21.2 6 20.9 6 19.2 5.9 16.6 6 15 6.3 14.6 6.3 14.5 5.8 14.9 5.6ZM16.2 5.3C16.2 3.7 19.6 3.6 19.7 5.2Z"/><g class="hiker__leg hiker__leg--a"><path d="M13.5 17.4C13.6 19.8 13.9 21.9 14.1 23.7H15.9C16.3 21.9 16.9 19.7 17 17.4Z"/><g class="hiker__shin"><path d="M14.1 23.2C13.6 24.6 13.9 26.9 14.3 28.6H15.7C15.9 26.9 16.2 24.9 15.9 23.2Z"/><path d="M14.2 28.1H15.8C16.7 28.4 17.9 28.7 18.2 29.4 18.3 29.9 18 30.1 17.5 30.1H14.3C13.9 30.1 13.9 29.3 14.2 28.1Z"/></g></g><g class="hiker__arm hiker__arm--a"><path d="M15.7 10.8C15.8 12.6 16.1 14.2 16.3 15.3L17.6 15.1C17.7 13.6 17.6 12.2 17.5 10.8Z"/><path d="M16.3 14.6C17.1 15.4 18 16 19.1 16.7L19.8 15.8C18.8 15.2 18.1 14.6 17.5 14.1Z"/><circle cx="19.6" cy="16.3" r=".85"/><path class="hiker__stick" d="M19.9 13.4L21.2 29.8"/></g></g></svg>';
  // Styles, tous limités à .rt-promeneur (rien ne déborde sur la page qui l'accueille)
  const CSS = `
.rt-promeneur { position: fixed; left: 0; top: 0; z-index: ${BLOG ? 9999 : 50}; width: 46px; height: 46px; pointer-events: none;
  color: var(--c-accent, #87f700); opacity: 0; transition: opacity .35s; will-change: transform; filter: drop-shadow(0 1px 1px rgb(0 0 0 / .6)); }
.rt-promeneur.is-visible { opacity: 1; }
.rt-hit { position: absolute; left: 12px; top: 6px; width: 24px; height: 38px; border-radius: 12px; pointer-events: none; cursor: pointer; }
.rt-promeneur.is-visible .rt-hit { pointer-events: auto; }
.rt-promeneur.is-singing .rt-promeneur__flip { animation: rtp-hop .44s ease-in-out infinite alternate; }
@keyframes rtp-hop { from { transform: translateY(0); } to { transform: translateY(-3px); } }
.rt-bulle { position: absolute; left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%) scale(.6); transform-origin: 50% 100%;
  min-width: 11.5rem; max-width: 15rem; padding: .5rem .75rem .55rem; border-radius: 14px; background: #fffdf5; color: #1f2a17;
  font: 600 13px/1.35 "Plus Jakarta Sans", system-ui, sans-serif; text-align: center; box-shadow: 0 6px 22px rgb(0 0 0 / .35);
  opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; }
.rt-bulle::after { content: ""; position: absolute; left: 50%; top: 100%; margin-left: -7px; border: 7px solid transparent; border-top-color: #fffdf5; }
.rt-promeneur.is-singing .rt-bulle { opacity: 1; transform: translateX(-50%) scale(1); }
.rt-bulle b { display: block; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #3a8500; margin-bottom: 2px; }
.rt-bulle span { display: block; opacity: .35; transition: opacity .15s, color .15s; }
.rt-bulle span.is-on { opacity: 1; color: #000; }
.rt-note { position: absolute; left: 60%; top: -4px; font: 700 15px/1 system-ui, sans-serif; color: currentColor; pointer-events: none;
  animation: rtp-note 1.4s ease-out forwards; }
@keyframes rtp-note { from { opacity: 1; transform: translate(0, 0) rotate(0); } to { opacity: 0; transform: translate(18px, -38px) rotate(20deg); } }
.rt-promeneur__flip { position: relative; width: 100%; height: 100%; }
.rt-promeneur .hiker { display: block; width: 100%; height: 100%; overflow: hidden; fill: currentColor; stroke: none; }
.rt-promeneur .hiker g, .rt-promeneur .hiker path, .rt-pose g, .rt-pose path { transform-box: view-box; }
.rt-promeneur .hiker__pack, .rt-pose .pack { opacity: .85; }
.rt-promeneur .hiker__ground { display: none; }
.rt-promeneur .hiker__stick { fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 1.1; }
.rt-promeneur .hiker__arm--b, .rt-promeneur .hiker__leg--b { opacity: .55; }
.rt-promeneur .hiker__body { animation: rtp-bob .6s ease-in-out infinite alternate; }
.rt-promeneur .hiker__leg { transform-origin: 15px 18px; animation: rtp-thigh 1.2s ease-in-out infinite; }
.rt-promeneur .hiker__shin { transform-origin: 15px 23.4px; animation: rtp-knee 1.2s ease-in-out infinite; }
.rt-promeneur .hiker__arm { transform-origin: 16.6px 11.2px; animation: rtp-arm 1.2s ease-in-out infinite; }
.rt-promeneur .hiker__leg--b, .rt-promeneur .hiker__leg--b .hiker__shin, .rt-promeneur .hiker__arm--a { animation-delay: -.6s; }
.rt-promeneur.is-resting .hiker, .rt-promeneur.is-resting .hiker * { animation: none; }
.rt-pose { position: absolute; inset: 0; display: none; width: 100%; height: 100%; overflow: visible; fill: currentColor; }
.rt-promeneur[data-pose] .rt-pose { display: block; }
.rt-promeneur[data-pose] .hiker__arm--a { display: none; }
.rt-promeneur[data-pose="lacets"] .hiker { visibility: hidden; }
.rt-pose .arm, .rt-pose .limb, .rt-pose .torso, .rt-pose .fold, .rt-pose .trk { fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; }
.rt-pose .arm { stroke-width: 1.5; }
.rt-pose .limb { stroke-width: 2.6; }
.rt-pose .torso { stroke-width: 3.6; }
.rt-pose .fold { stroke-width: .5; }
.rt-pose .paper { fill: currentColor; fill-opacity: .35; stroke: currentColor; stroke-width: .5; }
.rt-pose .trk { stroke: #0b0f0a; stroke-width: .6; }
.rt-pose .screen { fill: #0b0f0a; }
.rt-pose .fidget { transform-origin: 16.6px 11.2px; animation: rtp-fidget 1.6s ease-in-out infinite alternate; }
.rt-pose .lace { animation: rtp-lace .45s ease-in-out infinite alternate; }
@keyframes rtp-thigh { 0%, 100% { transform: rotate(-26deg); } 50% { transform: rotate(22deg); } }
@keyframes rtp-knee { 0%, 100% { transform: rotate(4deg); } 40% { transform: rotate(8deg); } 62% { transform: rotate(58deg); } 85% { transform: rotate(18deg); } }
@keyframes rtp-arm { 0%, 100% { transform: rotate(22deg); } 50% { transform: rotate(-20deg); } }
@keyframes rtp-bob { from { transform: translateY(.5px); } to { transform: translateY(-.5px); } }
@keyframes rtp-fidget { from { transform: rotate(-3deg); } to { transform: rotate(3deg); } }
@keyframes rtp-lace { from { transform: translate(0, 0); } to { transform: translate(.4px, -.7px); } }
@media print { .rt-promeneur { display: none; } }`;

  // Pauses : accessoires dessinés dans le même repère 32 × 32 que le randonneur (tourné vers la droite)
  const POSES = {
    boire: '<g class="fidget"><path class="arm" d="M16.6 11.2L19.3 13.6L20.4 9.8"/><g transform="translate(21.6 8.8) rotate(-35)"><rect x="-1" y="-2.6" width="2" height="4.6" rx=".7"/><rect x="-.6" y="-3.4" width="1.2" height=".9" rx=".2"/></g></g>',
    carte: '<g class="fidget"><path class="arm" d="M16.6 11.2L19 14.4L20.4 13.4"/><path class="paper" d="M19.6 10.6L23 10.2L26.4 10.8L26 15.4L22.6 14.8L19.2 15.2Z"/><path class="fold" d="M23 10.2L22.6 14.8"/><path class="trk" d="M20.4 13.8C21.6 12.4 23.6 13.6 25.2 11.8"/></g>',
    gps: '<g class="fidget"><path class="arm" d="M16.6 11.2L18.4 14.8L20.6 12.6"/><g transform="rotate(-12 21.2 11.2)"><rect x="20" y="9.2" width="2.4" height="4" rx=".45"/><rect class="screen" x="20.45" y="9.7" width="1.5" height="1.7" rx=".2"/><path class="fold" d="M20.6 9.4V7.8"/></g></g>',
    jumelles: '<g class="fidget"><path class="arm" d="M16.6 11.2L19.2 12.8L20.2 8.4"/><rect x="19.3" y="6" width="3.6" height="1.4" rx=".55"/><rect x="19.3" y="7.7" width="3.6" height="1.4" rx=".55"/></g>',
    lacets: '<path class="limb" d="M14.2 20.6L15 29.4L10.6 29.6"/><path d="M8.6 29.1H11.2V30.3H8.6C8.2 30.3 8.2 29.4 8.6 29.1Z"/>'
      + '<path class="limb" d="M14.2 20.6L20 21.8L20.4 28.8"/><path d="M19.2 28.6H21.6C22.6 28.9 23.6 29.2 23.8 29.8 23.8 30.2 23.5 30.3 23 30.3H19.3C19 30.3 18.9 29.4 19.2 28.6Z"/>'
      + '<path class="torso" d="M14.2 20.6L19.6 15"/><path class="pack" d="M12.4 16.2C12.6 13.6 15.6 12.2 17.2 13.4L17 14.6 13.8 19.4C12.8 19.6 12.3 18 12.4 16.2Z"/>'
      + '<circle cx="21.4" cy="12.6" r="2"/><path d="M18.6 11.4C20 10.2 23 9.6 24.4 9.8 24.8 10 24.6 10.3 24.3 10.4 22.6 10.7 20.2 11.4 19 12 18.6 12.1 18.3 11.7 18.6 11.4ZM19.6 10.9C19.3 9.4 22.4 8.4 22.9 9.9Z"/>'
      + '<g class="lace"><path class="arm" d="M19.4 15.4L20.8 22.2L21.4 28.2"/><path class="arm" d="M19.6 15.2L22.4 21.6L22.2 28.1"/></g>',
  };
  const POSE_NAMES = Object.keys(POSES);

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.className = 'rt-promeneur';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<div class="rt-promeneur__flip">${HIKER}<svg class="rt-pose" viewBox="0 0 32 32" aria-hidden="true" focusable="false"></svg></div><div class="rt-bulle" aria-live="polite"></div><span class="rt-hit" title="Fais-moi chanter !"></span>`;
  document.body.appendChild(el);
  const flip = el.firstElementChild;
  const poseSvg = flip.querySelector('.rt-pose');

  const rand = (a, b) => a + Math.random() * (b - a);
  const vh = () => window.innerHeight;
  const vw = () => document.documentElement.clientWidth;

  // Sol : le bord haut doit être une vraie ligne visible (bordure, fond opaque, dégradé).
  // Renvoie les retraits gauche/droite à respecter à cause des coins arrondis, ou null si l'élément n'a pas de sol.
  const alpha = (c) => {
    if (!c || c === 'transparent') return 0;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length > 3 ? parseFloat(parts[3]) * (parts[3].endsWith('%') ? 0.01 : 1) : 1;
  };
  // Couleur de fond visible derrière l'élément (un fond noir sur une page noire ne fait pas un sol)
  const behind = (t) => {
    for (let e = t.parentElement; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (alpha(c) > 0) return c;
    }
    return 'rgb(255, 255, 255)';
  };
  const groundCache = new WeakMap();
  const ground = (t) => {
    const hit = groundCache.get(t);
    const now = performance.now();
    if (hit && now - hit.at < 3000) return hit.g;
    const cs = getComputedStyle(t);
    let ok = BLOG && /^(IMG|IFRAME)$/.test(t.tagName);
    if (!ok && parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none' && alpha(cs.borderTopColor) >= 0.2) ok = true;
    if (!ok && alpha(cs.backgroundColor) >= 0.15 && cs.backgroundColor !== behind(t)) ok = true;
    if (!ok && cs.backgroundImage !== 'none') ok = true;
    if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.5) ok = false;
    // Compteur intégré : la carte arrondie est dans l'iframe, avec ses propres coins
    const round = t.id === 'ga-compteur' ? 20 : 0;
    const g = ok ? { l: Math.max(10, round, parseFloat(cs.borderTopLeftRadius) || 0), r: Math.max(10, round, parseFloat(cs.borderTopRightRadius) || 0) } : null;
    groundCache.set(t, { g, at: now });
    return g;
  };
  // Hauteur du sol : le bord haut, sauf pour le compteur intégré dont la carte est décalée de la marge de l'iframe
  const topOf = (t, r) => (t.id === 'ga-compteur' ? r.top + (r.width <= 348 ? 2 : 4) : r.top);
  // Portion praticable du bord haut (px depuis le bord gauche de l'élément), coins arrondis exclus
  const span = (t, r) => { const g = ground(t) || { l: 10, r: 10 }; return [g.l, r.width - g.r]; };

  // Un élément est praticable s'il est assez large, visible dans la fenêtre et non recouvert à l'endroit visé
  const reachable = (t, x) => {
    if (!t || !t.isConnected) return false;
    const r = t.getBoundingClientRect();
    if (r.width < 100 || r.height < 14) return false;
    const g = ground(t);
    if (!g || r.width - g.l - g.r < 50) return false;
    if (r.top < SIZE + 8 || r.top > vh() - 20 || r.right < 10 || r.left > vw() - 10) return false;
    const px = Math.min(Math.max(x == null ? r.left + r.width / 2 : x, r.left + 2), r.right - 2);
    if (px < 0 || px > vw()) return false;
    const hit = document.elementFromPoint(px, r.top + 3);
    return !!hit && (hit === t || t.contains(hit));
  };

  const candidates = (avoid) => [...document.querySelectorAll(SELECTORS)]
    .filter((t) => t !== avoid && !(avoid && (t.contains(avoid) || avoid.contains(t))));

  // Bloc voisin : un bord haut tout proche de l'endroit où il se trouve (devant lui de préférence)
  const nearTarget = (aheadOnly) => {
    const near = candidates(target).map((t) => {
      const r = t.getBoundingClientRect();
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.abs(topOf(t, r) - y);
      if (dx > HOP_DX || dy > HOP_DY || (dx < 4 && dy < 6)) return null;
      const [lo, hi] = span(t, r);
      const land = Math.min(Math.max(x, r.left + lo + 4), r.left + hi - 4);
      if (!reachable(t, land)) return null;
      const ahead = (land - x) * dir >= 0;
      if (aheadOnly && !ahead) return null;
      return { t, land: Math.min(Math.max(land - r.left + dir * rand(0, 24), lo), hi), score: dx + dy + (ahead ? 0 : 60) + rand(0, 30) };
    }).filter(Boolean).sort((a, b) => a.score - b.score);
    return near[0] || null;
  };

  // État : 'walk' (sur un élément), 'rest' (pause), 'hop' (saut vers un voisin), 'away' (caché)
  let target = null;
  let offset = 0;          // position horizontale sur l'élément (px depuis son bord gauche)
  let goal = 0;            // prochaine position visée sur l'élément
  let dir = 1;
  let mode = 'away';
  let until = 0;
  let hop = null;
  let x = -100, y = -100;
  let last = 0;
  let nextCheck = 0;
  let leaveAt = 0;         // moment où il cherche à quitter le bloc

  const face = (d) => { dir = d; flip.style.transform = d < 0 ? 'scaleX(-1)' : ''; };
  const show = (on) => el.classList.toggle('is-visible', on);
  const pose = (name) => {
    if (name) { poseSvg.innerHTML = POSES[name]; el.dataset.pose = name; } else { poseSvg.innerHTML = ''; delete el.dataset.pose; }
  };
  const rest = (on, name) => { el.classList.toggle('is-resting', on); pose(on ? name : null); };

  const newGoal = (r) => {
    // Plutôt loin de là où il est : il traverse le bloc au lieu de piétiner
    const [lo, hi] = span(target, r);
    const far = offset - lo > hi - offset ? [lo, lo + (hi - lo) * 0.35] : [hi - (hi - lo) * 0.35, hi];
    // Souvent jusqu'au bout du sol : arrivé au bord, il saute sur le bloc voisin s'il y en a un
    const roll = Math.random();
    goal = roll < 0.4 ? (far[0] === lo ? lo : hi) : roll < 0.8 ? rand(far[0], far[1]) : rand(lo, hi);
    face(goal >= offset ? 1 : -1);
  };

  const goAway = (now, delay) => { mode = 'away'; rest(false); show(false); until = now + delay; };

  // Réapparition (fondu) sur un élément visible au hasard ; sur le blog, la première fois sur le compteur
  let appeared = false;
  const appear = (now) => {
    const start = BLOG && !appeared && document.getElementById('ga-compteur');
    const list = start && reachable(start) ? [start] : candidates(null).filter((t) => reachable(t));
    if (!list.length) { until = now + 1500; return; }
    appeared = true;
    target = list[Math.floor(Math.random() * list.length)];
    leaveAt = now + rand(STAY[0], STAY[1]);
    const r = target.getBoundingClientRect();
    const [lo, hi] = span(target, r);
    offset = rand(lo, hi);
    face(Math.random() < 0.5 ? 1 : -1);
    mode = 'rest'; rest(true); until = now + rand(300, 700);
    place(r.left + offset, topOf(target, r));
    show(true);
  };

  const hopToNeighbour = (now, aheadOnly) => {
    const n = nearTarget(aheadOnly);
    if (!n) return false;
    const r = n.t.getBoundingClientRect();
    face(r.left + n.land >= x ? 1 : -1);
    hop = { from: { x, y }, to: n.t, toOffset: n.land, start: now };
    mode = 'hop'; rest(false);
    return true;
  };

  const startPause = (now) => {
    const name = Math.random() < 0.8 ? POSE_NAMES[Math.floor(Math.random() * POSE_NAMES.length)] : null;
    mode = 'rest'; rest(true, name);
    until = now + (name ? rand(2000, 3800) : rand(600, 1300));
  };

  function place(px, py) {
    x = px; y = py;
    el.style.transform = `translate3d(${Math.round(px - SIZE / 2)}px, ${Math.round(py - SIZE + 2)}px, 0)`;
  }

  // ------------------------------------------------------------ La chanson (comptine traditionnelle)
  const NOMBRES = ['Un', 'Deux', 'Trois', 'Quatre', 'Cinq', 'Six', 'Sept', 'Huit', 'Neuf', 'Dix'];
  let couplet = 1;
  try { couplet = Math.max(1, +sessionStorage.getItem('rt-chanson') || 1); } catch { /* indisponible */ }
  const bulle = el.querySelector('.rt-bulle');
  // Petite mélodie de marche (notes en Hz, une par syllabe ; la dernière de chaque vers est tenue)
  const C = 262, D = 294, E = 330, F = 349, G = 392, A = 440;
  const AIR = [[C, C, C, E, G, G, E], [G, G, E, G, G, E], [C, C, C, E, G, G, A], [G, F, E, D, D, C]];
  let audio = null;
  function jouer(onLine) {
    let t0 = 0;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      t0 = audio.currentTime + 0.08;
    } catch { audio = null; }
    let t = 0;
    AIR.forEach((vers, v) => {
      setTimeout(() => onLine(v), t * 1000);
      vers.forEach((f, k) => {
        const len = k === vers.length - 1 ? 0.46 : 0.23;
        if (audio) {
          const o = audio.createOscillator(), g = audio.createGain();
          o.type = 'triangle'; o.frequency.value = f;
          const s0 = t0 + t;
          g.gain.setValueAtTime(0, s0);
          g.gain.linearRampToValueAtTime(0.16, s0 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.001, s0 + len * 0.95);
          o.connect(g).connect(audio.destination);
          o.start(s0); o.stop(s0 + len);
        }
        if (k === 2 || k === vers.length - 1) setTimeout(note, (t + 0.05) * 1000);
        t += len;
      });
      t += 0.12;
    });
    return t;
  }
  function note() {
    const n = document.createElement('i');
    n.className = 'rt-note'; n.textContent = Math.random() < 0.5 ? '♪' : '♫';
    el.appendChild(n);
    setTimeout(() => n.remove(), 1500);
  }
  function chanter() {
    if (mode === 'sing' || mode === 'away' || mode === 'hop') return;
    const n = couplet, nb = NOMBRES[n - 1] || String(n), km = `kilomètre${n > 1 ? 's' : ''}`;
    const vers = [`${nb} ${km} à pied,`, 'ça use, ça use,', `${nb} ${km} à pied,`, 'ça use les souliers !'];
    bulle.innerHTML = `<b>♪ En avant, marche !</b>${vers.map((l) => `<span>${l}</span>`).join('')}`;
    const lines = bulle.querySelectorAll('span');
    rest(false); el.classList.add('is-singing');
    mode = 'sing';
    const dur = jouer((v) => lines.forEach((l, i) => l.classList.toggle('is-on', i === v)));
    until = performance.now() + dur * 1000 + 900;
    couplet = n + 1;
    try { sessionStorage.setItem('rt-chanson', String(couplet)); } catch { /* indisponible */ }
    if (window.rtStat) window.rtStat('ui', 'Randonneur qui chante');
  }
  // Seul son corps est cliquable (petite zone) : il ne gêne pas les boutons sur lesquels il marche
  el.querySelector('.rt-hit').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); chanter(); });

  const tick = (now) => {
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;

    if (document.hidden) { requestAnimationFrame(tick); return; }

    if (mode === 'sing') {
      // Il chante en marchant sur place, posé sur son bloc
      const r = target && target.isConnected ? target.getBoundingClientRect() : null;
      if (r) place(r.left + offset, topOf(target, r));
      if (now >= until) { el.classList.remove('is-singing'); mode = 'walk'; leaveAt = Math.max(leaveAt, now + 4000); if (r) newGoal(r); }
    } else if (mode === 'away') {
      if (now >= until) appear(now);
    } else if (mode === 'hop') {
      const r = hop.to.getBoundingClientRect();
      const tx = r.left + hop.toOffset, ty = topOf(hop.to, r);
      const k = Math.min(1, (now - hop.start) / HOP_MS);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const arc = Math.min(45, 18 + Math.hypot(tx - hop.from.x, ty - hop.from.y) * 0.25) + Math.max(0, hop.from.y - ty) * 0.5;
      place(hop.from.x + (tx - hop.from.x) * e, hop.from.y + (ty - hop.from.y) * e - Math.sin(Math.PI * k) * arc);
      if (k >= 1) {
        target = hop.to; offset = hop.toOffset; hop = null; leaveAt = now + rand(STAY[0], STAY[1]);
        if (!reachable(target, tx)) goAway(now, 600);
        else { mode = 'walk'; newGoal(r); }
      }
    } else {
      const r = target && target.isConnected ? target.getBoundingClientRect() : null;
      if (!r || r.width < 30) { goAway(now, 600); requestAnimationFrame(tick); return; }
      const [lo, hi] = span(target, r);
      offset = Math.min(Math.max(offset, lo), hi);
      if (mode === 'walk') {
        offset += dir * SPEED * dt;
        if ((dir > 0 && offset >= goal) || (dir < 0 && offset <= goal)) {
          offset = goal;
          const roll = Math.random();
          if (now >= leaveAt) {
            // Assez vu ce bloc : il passe sur un voisin, ou à défaut s'éclipse pour réapparaître ailleurs
            if (!hopToNeighbour(now)) goAway(now, rand(400, 900));
          } else if ((goal - lo < 6 || hi - goal < 6) && Math.random() < 0.8 && hopToNeighbour(now, true)) {
            // Bout du sol : saut sur le bloc d'à côté (sinon demi-tour plus bas)
          } else if (roll < 0.22) startPause(now);
          else if (!(roll < 0.4 && hopToNeighbour(now))) newGoal(r);
        }
      } else if (mode === 'rest' && now >= until) {
        rest(false);
        if (!(Math.random() < 0.35 && hopToNeighbour(now))) { mode = 'walk'; newGoal(r); }
      }
      if (mode === 'walk' || mode === 'rest') {
        place(r.left + offset, topOf(target, r));
        // Élément sorti de l'écran (défilement) ou recouvert : il s'efface et réapparaît ailleurs
        if (now >= nextCheck) {
          nextCheck = now + 250;
          // Plus de sol sous ses pieds : il saute sur un voisin, sinon il s'efface
          if (!reachable(target, r.left + offset)) { rest(false); if (!hopToNeighbour(now)) goAway(now, 700); }
        }
      }
    }
    requestAnimationFrame(tick);
  };

  if (reduce && reduce.addEventListener) {
    reduce.addEventListener('change', (e) => { if (e.matches) el.remove(); });
  }
  // On laisse la page se mettre en place avant la première apparition
  until = performance.now() + 1500;
  requestAnimationFrame(tick);
})();
