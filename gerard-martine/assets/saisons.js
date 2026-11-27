/* Habillage des saisons, choisi d'après la date :
     Noël       25 novembre au 5 janvier : flocons + bonnet de Père Noël
     hiver      6 janvier au 19 mars     : flocons seuls
     printemps  20 mars au 20 juin       : pétales, soleil, oiseaux de passage + petite fleur
     le reste de l'année : rien.
   ?saison=noel|hiver|printemps pour voir une saison, ?saison=aucune pour tout couper. Réglages sur la balise :
     data-chute="14"                nombre de flocons ou de pétales (0 = aucun)
     data-chute-dans="#poster"      limités à ce bloc (sinon toute la fenêtre)
     data-chute-dialogues="#detail" fenêtres modales au-dessus desquelles l'habillage reste visible
     data-deco=".a, .b@g"           éléments coiffés d'un bonnet ou d'une fleur (@g : à gauche) ; ajoutés plus tard aussi
   Fichier identique dans godillots-ailes/ et gerard-martine/ (à modifier dans les deux). */
(() => {
  const me = document.currentScript;
  if (!me) return;
  const d = new Date(), md = (d.getMonth() + 1) * 100 + d.getDate();
  const parDate = md >= 1125 || md <= 105 ? 'noel' : md <= 319 ? 'hiver' : md >= 320 && md <= 620 ? 'printemps' : '';
  const demande = new URLSearchParams(location.search).get('saison');
  const saison = ['noel', 'hiver', 'printemps'].includes(demande) ? demande : demande === 'aucune' ? '' : parDate;
  if (!saison) return;
  const neige = saison !== 'printemps';
  const calme = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const css = `
.sa-ciel { position: fixed; inset: 0; z-index: 2147482000; pointer-events: none; overflow: hidden; }
.sa-ciel--bloc { position: absolute !important; inset: 0 !important; margin: 0 !important; z-index: 5; border-radius: inherit; }
.sa-chute { position: absolute; top: -16px; animation: sa-chute var(--t) linear var(--r) infinite; }
.sa-chute svg { display: block; width: 100%; height: 100%; animation: sa-vrille var(--v) ease-in-out infinite alternate; }
.sa-flocon { color: rgb(255 255 255 / .9); filter: drop-shadow(0 0 3px rgb(255 255 255 / .55)); }
[data-theme="light"] .sa-flocon, [data-theme="clair"] .sa-flocon { color: #8fb3d9; filter: drop-shadow(0 0 2px rgb(143 179 217 / .6)); }
.sa-petale svg { animation-name: sa-volte; }
@keyframes sa-chute { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(var(--x), var(--h), 0); } }
@keyframes sa-vrille { from { transform: translateX(-6px) rotate(0); } to { transform: translateX(6px) rotate(140deg); } }
@keyframes sa-volte { from { transform: translateX(-14px) rotate(-40deg) scaleX(1); } to { transform: translateX(14px) rotate(220deg) scaleX(.45); } }
.sa-soleil { position: absolute; top: calc(var(--s) * -.5); right: calc(var(--s) * -.5); width: var(--s); height: var(--s); border-radius: 50%;
  background: radial-gradient(circle, rgb(255 222 120 / .55) 0 14%, rgb(255 205 90 / .22) 30%, transparent 68%); }
.sa-soleil::before { content: ""; position: absolute; inset: 0; border-radius: 50%; animation: sa-tourne 90s linear infinite;
  background: repeating-conic-gradient(rgb(255 220 120 / .2) 0 5deg, transparent 5deg 22.5deg);
  -webkit-mask: radial-gradient(circle, transparent 16%, #000 22%, transparent 66%); mask: radial-gradient(circle, transparent 16%, #000 22%, transparent 66%); }
[data-theme="light"] .sa-soleil, [data-theme="clair"] .sa-soleil { filter: saturate(1.4); opacity: .85; }
@keyframes sa-tourne { to { transform: rotate(360deg); } }
.sa-oiseau { position: absolute; left: 0; width: var(--w); color: rgb(225 232 220 / .75); animation: sa-vol var(--t) linear forwards; }
[data-theme="light"] .sa-oiseau, [data-theme="clair"] .sa-oiseau { color: rgb(45 58 40 / .6); }
.sa-oiseau svg { display: block; width: 100%; overflow: visible; animation: sa-plane 3s ease-in-out infinite alternate; }
.sa-oiseau .sa-aile { transform-box: fill-box; transform-origin: 50% 100%; animation: sa-bat .32s ease-in-out infinite alternate; }
@keyframes sa-vol { from { transform: translateX(-60px); } to { transform: translateX(calc(var(--l) + 60px)); } }
@keyframes sa-plane { from { transform: translateY(-8px); } to { transform: translateY(8px); } }
@keyframes sa-bat { to { transform: scaleY(-.55); } }
.sa-hote { position: relative; display: inline-block; line-height: 0; flex: none; }
.sa-deco { position: absolute; z-index: 3; pointer-events: none; transform-origin: 30% 92%;
  transform: rotate(var(--a)); animation: sa-hop 7s ease-in-out 2s infinite; filter: drop-shadow(0 2px 2px rgb(0 0 0 / .35)); }
.sa-deco--fleur { transform-origin: 50% 100%; }
.sa-deco svg { display: block; width: 100%; height: auto; overflow: visible; }
:hover > .sa-deco, :focus-visible > .sa-deco, .sa-hote:hover > .sa-deco, a:hover .sa-deco, button:hover .sa-deco { animation: sa-hop .9s ease-in-out; }
@keyframes sa-hop { 0%, 86%, 100% { transform: rotate(var(--a)); } 90% { transform: rotate(calc(var(--a) - 9deg)) translateY(-2px); }
  95% { transform: rotate(calc(var(--a) + 5deg)); } }
@media (prefers-reduced-motion: reduce) { .sa-deco, .sa-chute, .sa-chute svg, .sa-soleil::before { animation: none !important; } .sa-oiseau { display: none; } }`;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  // Flocon à six branches, trait fin
  const FLOCON = '<svg viewBox="-10 -10 20 20" aria-hidden="true"><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none">'
    + [0, 60, 120].map((a) => `<g transform="rotate(${a})"><path d="M0-9V9M0-6l-2.4-2.4M0-6l2.4-2.4M0 6l-2.4 2.4M0 6l2.4 2.4"/></g>`).join('')
    + '</g></svg>';
  // Pétale de cerisier, en rose, blanc rosé ou jaune
  const PETALES = ['#f6a5c0', '#fbd3e0', '#fff1f6', '#ffd76e'];
  const petale = (c) => `<svg viewBox="-10 -10 20 20" aria-hidden="true"><path d="M0-9C6-6 7 3 0 9-7 3-6-6 0-9Z" fill="${c}"/>`
    + '<path d="M0-5V5" stroke="rgb(0 0 0 / .12)" stroke-width="1" stroke-linecap="round"/></svg>';
  // Oiseau vu de loin : deux ailes qui battent
  const OISEAU = '<svg viewBox="0 0 24 10" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">'
    + '<path class="sa-aile" d="M1 4.5Q6 0 12 6"/><path class="sa-aile" d="M12 6Q18 0 23 4.5"/></g></svg>';
  // Bonnet : pointe retombante, bord en fourrure, pompon
  const BONNET = '<svg viewBox="0 0 44 36" aria-hidden="true">'
    + '<path d="M5 27C6 15 13 5 24 4c7-.6 12 3 14 9-3-2.5-6-3-8-1.5C33 16 36 21 38 27Z" fill="#d42b2b"/>'
    + '<path d="M24 4c7-.6 12 3 14 9-3-2.5-6-3-8-1.5C28 8 26 5.5 24 4Z" fill="#a51d1d"/>'
    + '<path d="M13 12c3-4 7-6 10-6" stroke="#ff6b6b" stroke-width="1.6" stroke-linecap="round" fill="none" opacity=".6"/>'
    + '<rect x="2" y="25" width="39" height="9" rx="4.5" fill="#fbfbf7"/>'
    + '<path d="M6 28.5h31" stroke="#dfe3ea" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="1.5 3"/>'
    + '<circle cx="38.5" cy="15.5" r="4.2" fill="#fbfbf7"/><circle cx="37.3" cy="14.3" r="1.3" fill="#fff"/>'
    + '</svg>';
  // Pâquerette sur sa tige, avec une feuille
  const FLEUR = '<svg viewBox="0 0 30 40" aria-hidden="true">'
    + '<path d="M15 38C15 30 14 24 15 17" stroke="#4f9a2a" stroke-width="2.2" stroke-linecap="round" fill="none"/>'
    + '<path d="M15 31C10 30 7 26 7 23c4 0 7 3 8 8Z" fill="#6cbf3a"/>'
    + '<g transform="translate(15 12)">'
    + [0, 40, 80, 120, 160, 200, 240, 280, 320].map((a) => `<ellipse rx="2.6" ry="6" cy="-6.2" transform="rotate(${a})" fill="#fffdf6" stroke="#f2d9e3" stroke-width=".6"/>`).join('')
    + '<circle r="3.6" fill="#ffc93c"/><circle r="3.6" fill="none" stroke="#e8a516" stroke-width=".8"/></g></svg>';

  function ciel() {
    const n = Math.max(0, parseInt(me.dataset.chute ?? '14', 10) || 0);
    const bloc = me.dataset.chuteDans && document.querySelector(me.dataset.chuteDans);
    if (me.dataset.chuteDans && !bloc) return;
    const c = document.createElement('div');
    c.className = 'sa-ciel' + (bloc ? ' sa-ciel--bloc' : '');
    c.setAttribute('aria-hidden', 'true');
    if (bloc && getComputedStyle(bloc).position === 'static') bloc.style.position = 'relative';
    const haut = bloc ? bloc.offsetHeight : innerHeight;
    const larg = bloc ? bloc.offsetWidth : innerWidth;

    if (!neige) {
      const s = document.createElement('span');
      s.className = 'sa-soleil';
      s.style.setProperty('--s', `${Math.round(Math.max(120, Math.min(340, Math.min(larg, haut * 2) * 0.45)))}px`);
      c.appendChild(s);
    }
    const total = innerWidth < 600 ? Math.ceil(n * 0.6) : n;
    for (let i = 0; i < total; i++) {
      const f = document.createElement('span');
      const taille = (neige ? 6 : 7) + Math.random() * 9;
      f.className = `sa-chute ${neige ? 'sa-flocon' : 'sa-petale'}`;
      f.innerHTML = neige ? FLOCON : petale(PETALES[i % PETALES.length]);
      f.style.cssText = `left:${(i + Math.random()) / total * 100}%;width:${taille}px;height:${taille}px;opacity:${neige ? 0.35 + taille / 30 : 0.8};`
        + `--t:${((neige ? 16 : 19) - taille * 0.5 + Math.random() * 6).toFixed(1)}s;--r:-${(Math.random() * 20).toFixed(1)}s;`
        + `--v:${(2.5 + Math.random() * 2.5).toFixed(1)}s;--x:${Math.round(Math.random() * (neige ? 60 : 160) - (neige ? 30 : 40))}px;`
        + `--h:${bloc ? Math.round(haut * 1.15 + 20) + 'px' : '112vh'};`
        + (calme ? `top:${Math.random() * 90}%;` : '');
      c.appendChild(f);
    }
    (bloc || document.body).appendChild(c);
    // Au printemps, de temps en temps un oiseau (ou deux) traverse le ciel, sur la page ou un grand bloc
    if (!neige && !calme && larg > 480) {
      const vol = () => {
        const nb = Math.random() < 0.4 ? 2 : 1, y = 6 + Math.random() * 22, t = 13 + Math.random() * 6;
        for (let k = 0; k < nb; k++) {
          const o = document.createElement('span');
          o.className = 'sa-oiseau';
          o.innerHTML = OISEAU;
          o.style.cssText = `top:${y + k * 3}%;--w:${18 + Math.random() * 8 - k * 4}px;--t:${t}s;--l:${larg}px;animation-delay:${k * 0.7}s;`;
          o.addEventListener('animationend', (e) => { if (e.target === o) o.remove(); });
          c.appendChild(o);
        }
        setTimeout(vol, (25 + Math.random() * 35) * 1000);
      };
      setTimeout(vol, 4000);
    }
    // Une fenêtre modale (fiche d'une rando) passe au-dessus de tout : l'habillage la suit tant qu'elle est ouverte
    const dlgs = !bloc && me.dataset.chuteDialogues ? [...document.querySelectorAll(me.dataset.chuteDialogues)] : [];
    if (!dlgs.length) return;
    const suit = () => {
      const parent = dlgs.find((dl) => dl.open) || document.body;
      if (c.parentNode !== parent) parent.appendChild(c);
    };
    const obs = new MutationObserver(suit);
    dlgs.forEach((dl) => obs.observe(dl, { attributes: true, attributeFilter: ['open'] }));
  }

  // Bonnet (Noël) ou fleur (printemps) sur le coin haut de l'élément ; une image est d'abord enveloppée
  function pose(el, gauche) {
    if (el.dataset.saison) return;
    el.dataset.saison = saison;
    let hote = el;
    if (el.tagName === 'IMG') {
      hote = document.createElement('span');
      hote.className = 'sa-hote';
      el.replaceWith(hote);
      hote.appendChild(el);
    } else if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const h = el.getBoundingClientRect().height || 40;
    const fleur = saison === 'printemps';
    const larg = Math.round(Math.max(fleur ? 14 : 18, Math.min(fleur ? 30 : 46, h * (fleur ? 0.48 : 0.72))));
    const b = document.createElement('span');
    b.className = `sa-deco${fleur ? ' sa-deco--fleur' : ''}`;
    b.setAttribute('aria-hidden', 'true');
    b.innerHTML = fleur ? FLEUR : BONNET;
    b.style.width = `${larg}px`;
    b.style.top = `${-Math.round(larg * (fleur ? 0.9 : 0.5))}px`;
    const cote = gauche ? 'left' : 'right';
    b.style[cote] = `${-Math.round(larg * (fleur ? 0.15 : 0.3))}px`;
    b.style.setProperty('--a', `${(gauche ? -1 : 1) * (fleur ? 12 : 16)}deg`);
    if (gauche && !fleur) b.firstChild.style.transform = 'scaleX(-1)';
    hote.appendChild(b);
  }

  function decos() {
    if (saison === 'hiver') return;
    const cibles = (me.dataset.deco || '').split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => ({ sel: s.replace(/@g$/, ''), gauche: /@g$/.test(s) }));
    if (!cibles.length) return;
    const tout = () => cibles.forEach(({ sel, gauche }) => document.querySelectorAll(sel).forEach((el) => pose(el, gauche)));
    tout();
    // Éléments créés plus tard par la page (compteur du site affiché après lecture des données)
    const obs = new MutationObserver(tout);
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 15000);
  }

  const go = () => { ciel(); decos(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();
