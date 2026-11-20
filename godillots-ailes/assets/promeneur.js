/* Randothèque – le randonneur qui se promène sur la page : il marche sur le bord haut des éléments visibles
   (cartes, boutons, titres…), fait des pauses, change de sens et saute d'un élément à l'autre.
   Purement décoratif : ne capte aucun clic, se cache si l'élément est recouvert (fenêtre, menu) et ne bouge pas
   du tout quand le visiteur a demandé moins d'animations. */
(() => {
  if (!window.rtHiker || !window.requestAnimationFrame) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce && reduce.matches) return;

  const SIZE = 30;            // taille du randonneur (px)
  const SPEED = 34;           // vitesse de marche (px/s)
  const HOP_MS = 750;         // durée d'un saut vers un autre élément
  const SELECTORS = [
    '.card', '.hero-total', '.hero-stats > div', '.btn', '.chip', '.segmented', '.search', '.toolbar',
    '.overview-map', '.evo', '.elsewhere', '.detail h2', 'main h1', 'main h2', 'main h3', '.site-footer', '.brand',
  ].join(',');

  const el = document.createElement('div');
  el.className = 'rt-promeneur';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<div class="rt-promeneur__flip">${window.rtHiker()}</div>`;
  document.body.appendChild(el);
  const flip = el.firstElementChild;

  const rand = (a, b) => a + Math.random() * (b - a);
  const vh = () => window.innerHeight;
  const vw = () => document.documentElement.clientWidth;

  // Un élément est praticable s'il est assez large, visible dans la fenêtre et non recouvert à l'endroit visé
  const reachable = (t, x) => {
    if (!t || !t.isConnected) return false;
    const r = t.getBoundingClientRect();
    if (r.width < 70 || r.height < 14) return false;
    if (r.top < SIZE + 8 || r.top > vh() - 20 || r.right < 10 || r.left > vw() - 10) return false;
    const px = Math.min(Math.max(x == null ? r.left + r.width / 2 : x, r.left + 2), r.right - 2);
    if (px < 0 || px > vw()) return false;
    const hit = document.elementFromPoint(px, r.top + 3);
    return !!hit && (hit === t || t.contains(hit));
  };

  const pickTarget = (avoid) => {
    const list = [...document.querySelectorAll(SELECTORS)].filter((t) => t !== avoid && reachable(t));
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
  };

  // État : 'walk' (sur un élément), 'rest' (pause), 'hop' (saut), 'away' (aucun élément praticable)
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

  const face = (d) => { dir = d; flip.style.transform = d < 0 ? 'scaleX(-1)' : ''; };
  const show = (on) => el.classList.toggle('is-visible', on);
  const rest = (on) => el.classList.toggle('is-resting', on);

  const newGoal = (r) => {
    const margin = Math.min(12, r.width / 4);
    goal = rand(margin, r.width - margin);
    face(goal >= offset ? 1 : -1);
  };

  const jumpTo = (now) => {
    const next = pickTarget(target);
    if (!next) { mode = 'away'; show(false); until = now + 1500; return; }
    const r = next.getBoundingClientRect();
    const toOffset = rand(Math.min(12, r.width / 4), r.width - Math.min(12, r.width / 4));
    if (mode === 'away' || x < -SIZE || x > vw() + SIZE || y < -SIZE || y > vh()) {
      // Pas de saut possible depuis l'extérieur de l'écran : il apparaît directement
      target = next; offset = toOffset; mode = 'rest'; rest(true); until = now + rand(400, 900);
      show(true); return;
    }
    face(r.left + toOffset >= x ? 1 : -1);
    hop = { from: { x, y }, to: next, toOffset, start: now };
    mode = 'hop'; rest(false);
  };

  const place = (px, py) => {
    x = px; y = py;
    el.style.transform = `translate3d(${Math.round(px - SIZE / 2)}px, ${Math.round(py - SIZE + 2)}px, 0)`;
  };

  const tick = (now) => {
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;

    if (document.hidden) { requestAnimationFrame(tick); return; }

    if (mode === 'away') {
      if (now >= until) jumpTo(now);
    } else if (mode === 'hop') {
      const r = hop.to.getBoundingClientRect();
      const tx = r.left + hop.toOffset, ty = r.top;
      const k = Math.min(1, (now - hop.start) / HOP_MS);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const arc = Math.min(140, 40 + Math.abs(tx - hop.from.x) * 0.25 + Math.abs(ty - hop.from.y) * 0.2);
      place(hop.from.x + (tx - hop.from.x) * e, hop.from.y + (ty - hop.from.y) * e - Math.sin(Math.PI * k) * arc);
      if (k >= 1) {
        target = hop.to; offset = hop.toOffset; hop = null;
        if (!reachable(target, tx)) { mode = 'away'; until = now; }
        else { mode = 'walk'; newGoal(r); }
      }
    } else {
      const r = target && target.isConnected ? target.getBoundingClientRect() : null;
      if (!r || r.width < 30) { mode = 'away'; show(false); until = now + 600; requestAnimationFrame(tick); return; }
      offset = Math.min(Math.max(offset, 0), r.width);
      if (mode === 'walk') {
        offset += dir * SPEED * dt;
        if ((dir > 0 && offset >= goal) || (dir < 0 && offset <= goal)) {
          offset = goal;
          const roll = Math.random();
          if (roll < 0.35) { mode = 'rest'; rest(true); until = now + rand(800, 2600); }
          else if (roll < 0.7) jumpTo(now);
          else newGoal(r);
        }
      } else if (mode === 'rest' && now >= until) {
        rest(false);
        if (Math.random() < 0.5) jumpTo(now); else { mode = 'walk'; newGoal(r); }
      }
      if (mode === 'walk' || mode === 'rest') {
        place(r.left + offset, r.top);
        // Élément sorti de l'écran (défilement) ou recouvert : il part ailleurs
        if (now >= nextCheck) {
          nextCheck = now + 250;
          if (!reachable(target, r.left + offset)) {
            rest(false);
            if (r.top < SIZE + 8 || r.top > vh() - 20) jumpTo(now);
            else { mode = 'away'; show(false); until = now + 800; }
          }
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
