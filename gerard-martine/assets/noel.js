/* Habillage de fin d'année : quelques flocons qui tombent et un bonnet de Père Noël posé sur un élément.
   Actif du 25 novembre au 6 janvier (?noel=1 pour le forcer, ?noel=0 pour le couper). Tout est sur la balise :
     data-neige="14"            nombre de flocons (0 = pas de neige)
     data-neige-dans="#poster"  flocons limités à ce bloc (sinon toute la fenêtre)
     data-neige-dialogues="#detail"  fenêtres modales au-dessus desquelles la neige reste visible
     data-bonnet=".a, .b@g"     éléments coiffés d'un bonnet (@g : posé à gauche) ; ajoutés plus tard par la page aussi
   Fichier identique dans godillots-ailes/ et gerard-martine/ (à modifier dans les deux). */
(() => {
  const me = document.currentScript;
  const force = new URLSearchParams(location.search).get('noel');
  const d = new Date(), m = d.getMonth() + 1, j = d.getDate();
  const saison = (m === 11 && j >= 25) || m === 12 || (m === 1 && j <= 6);
  if (force === '0' || (!saison && force !== '1') || !me) return;

  const calme = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css = `
.noel-neige { position: fixed; inset: 0; z-index: 2147482000; pointer-events: none; overflow: hidden; }
.noel-neige--bloc { position: absolute !important; inset: 0 !important; margin: 0 !important; z-index: 5; border-radius: inherit; }
.noel-flocon { position: absolute; top: -16px; color: rgb(255 255 255 / .9); filter: drop-shadow(0 0 3px rgb(255 255 255 / .55));
  animation: noel-chute var(--t) linear var(--r) infinite; }
.noel-flocon svg { display: block; width: 100%; height: 100%; animation: noel-vrille var(--v) ease-in-out infinite alternate; }
[data-theme="light"] .noel-flocon, [data-theme="clair"] .noel-flocon { color: #8fb3d9; filter: drop-shadow(0 0 2px rgb(143 179 217 / .6)); }
@keyframes noel-chute { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(var(--x), var(--h), 0); } }
@keyframes noel-vrille { from { transform: translateX(-6px) rotate(0); } to { transform: translateX(6px) rotate(140deg); } }
.noel-hote { position: relative; display: inline-block; line-height: 0; flex: none; }
.noel-bonnet { position: absolute; z-index: 3; pointer-events: none; transform-origin: 30% 92%;
  transform: rotate(var(--a)); animation: noel-hop 7s ease-in-out 2s infinite; filter: drop-shadow(0 2px 2px rgb(0 0 0 / .35)); }
.noel-bonnet svg { display: block; width: 100%; height: auto; overflow: visible; }
.noel-bonnet .noel-pompon { transform-box: fill-box; transform-origin: 50% 0; }
:hover > .noel-bonnet, :focus-visible > .noel-bonnet, .noel-hote:hover > .noel-bonnet, a:hover .noel-bonnet, button:hover .noel-bonnet { animation: noel-hop .9s ease-in-out; }
@keyframes noel-hop { 0%, 86%, 100% { transform: rotate(var(--a)); } 90% { transform: rotate(calc(var(--a) - 9deg)) translateY(-2px); }
  95% { transform: rotate(calc(var(--a) + 5deg)); } }
@media (prefers-reduced-motion: reduce) { .noel-bonnet, .noel-flocon, .noel-flocon svg { animation: none !important; } }`;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  // Flocon à six branches, trait fin
  const FLOCON = '<svg viewBox="-10 -10 20 20" aria-hidden="true"><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none">'
    + [0, 60, 120].map((a) => `<g transform="rotate(${a})"><path d="M0-9V9M0-6l-2.4-2.4M0-6l2.4-2.4M0 6l-2.4 2.4M0 6l2.4 2.4"/></g>`).join('')
    + '</g></svg>';
  // Bonnet : pointe retombante, bord en fourrure, pompon
  const BONNET = '<svg viewBox="0 0 44 36" aria-hidden="true">'
    + '<path d="M5 27C6 15 13 5 24 4c7-.6 12 3 14 9-3-2.5-6-3-8-1.5C33 16 36 21 38 27Z" fill="#d42b2b"/>'
    + '<path d="M24 4c7-.6 12 3 14 9-3-2.5-6-3-8-1.5C28 8 26 5.5 24 4Z" fill="#a51d1d"/>'
    + '<path d="M13 12c3-4 7-6 10-6" stroke="#ff6b6b" stroke-width="1.6" stroke-linecap="round" fill="none" opacity=".6"/>'
    + '<rect x="2" y="25" width="39" height="9" rx="4.5" fill="#fbfbf7"/>'
    + '<path d="M6 28.5h31" stroke="#dfe3ea" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="1.5 3"/>'
    + '<g class="noel-pompon"><circle cx="38.5" cy="15.5" r="4.2" fill="#fbfbf7"/><circle cx="37.3" cy="14.3" r="1.3" fill="#fff"/></g>'
    + '</svg>';

  function neige() {
    const n = Math.max(0, parseInt(me.dataset.neige ?? '14', 10) || 0);
    if (!n) return;
    const bloc = me.dataset.neigeDans && document.querySelector(me.dataset.neigeDans);
    if (me.dataset.neigeDans && !bloc) return;
    const ciel = document.createElement('div');
    ciel.className = 'noel-neige' + (bloc ? ' noel-neige--bloc' : '');
    ciel.setAttribute('aria-hidden', 'true');
    const total = innerWidth < 600 ? Math.ceil(n * 0.6) : n;
    for (let i = 0; i < total; i++) {
      const f = document.createElement('span');
      const taille = 6 + Math.random() * 9;
      f.className = 'noel-flocon';
      f.innerHTML = FLOCON;
      f.style.cssText = `left:${(i + Math.random()) / total * 100}%;width:${taille}px;height:${taille}px;opacity:${0.35 + taille / 30};`
        + `--t:${(16 - taille * 0.5 + Math.random() * 6).toFixed(1)}s;--r:-${(Math.random() * 20).toFixed(1)}s;`
        + `--v:${(2.5 + Math.random() * 2.5).toFixed(1)}s;--x:${Math.round(Math.random() * 60 - 30)}px;--h:${bloc ? Math.round(bloc.offsetHeight * 1.15 + 20) + 'px' : '112vh'};`
        + (calme ? `top:${Math.random() * 90}%;` : '');
      ciel.appendChild(f);
    }
    if (bloc && getComputedStyle(bloc).position === 'static') bloc.style.position = 'relative';
    (bloc || document.body).appendChild(ciel);
    // Une fenêtre modale (fiche d'une rando) passe au-dessus de tout : la neige la suit tant qu'elle est ouverte
    const dlgs = !bloc && me.dataset.neigeDialogues ? [...document.querySelectorAll(me.dataset.neigeDialogues)] : [];
    if (!dlgs.length) return;
    const suit = () => {
      const ouverte = dlgs.find((dl) => dl.open);
      const parent = ouverte || document.body;
      if (ciel.parentNode !== parent) parent.appendChild(ciel);
    };
    const obs = new MutationObserver(suit);
    dlgs.forEach((dl) => obs.observe(dl, { attributes: true, attributeFilter: ['open'] }));
  }

  // Bonnet posé sur le coin haut de l'élément (une image est d'abord enveloppée, elle ne peut rien contenir)
  function coiffe(el, gauche) {
    if (el.dataset.noel) return;
    el.dataset.noel = '1';
    let hote = el;
    if (el.tagName === 'IMG') {
      hote = document.createElement('span');
      hote.className = 'noel-hote';
      el.replaceWith(hote);
      hote.appendChild(el);
    } else if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const r = el.getBoundingClientRect();
    const larg = Math.round(Math.max(18, Math.min(46, (r.height || 40) * 0.72)));
    const b = document.createElement('span');
    b.className = 'noel-bonnet';
    b.setAttribute('aria-hidden', 'true');
    b.innerHTML = BONNET;
    b.style.width = `${larg}px`;
    b.style.top = `${-Math.round(larg * 0.5)}px`;
    if (gauche) {
      b.style.left = `${-Math.round(larg * 0.32)}px`;
      b.style.setProperty('--a', '-16deg');
      b.firstChild.style.transform = 'scaleX(-1)';
    } else {
      b.style.right = `${-Math.round(larg * 0.3)}px`;
      b.style.setProperty('--a', '16deg');
    }
    hote.appendChild(b);
  }

  function bonnets() {
    const cibles = (me.dataset.bonnet || '').split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => ({ sel: s.replace(/@g$/, ''), gauche: /@g$/.test(s) }));
    if (!cibles.length) return;
    const pose = () => cibles.forEach(({ sel, gauche }) => document.querySelectorAll(sel).forEach((el) => coiffe(el, gauche)));
    pose();
    // Éléments créés plus tard par la page (compteur du site affiché après lecture des données)
    const obs = new MutationObserver(pose);
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 15000);
  }

  const go = () => { neige(); bonnets(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();
