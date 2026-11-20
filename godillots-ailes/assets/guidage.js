/* Randothèque – guidage pas à pas du mode terrain, à l'écran et à la voix (même fichier dans les deux sites).
   Le guidage ne parle qu'aux endroits où l'on peut se tromper : les croisements et fourches trouvés le long
   de la trace (scripts/carrefours.mjs, BD TOPO de l'IGN ou OpenStreetMap, rangés dans le fichier de la trace).
   Quand le chemin tourne tout seul, rien d'autre que la distance jusqu'au prochain croisement.
   - À chaque croisement : tourner, prendre l'épingle, rester à gauche/droite à une fourche, ou tout droit.
   - Trace dont les croisements ne sont pas encore connus : seuls les virages francs (60° et plus) sont annoncés.
   - Entre deux croisements : distance et relief (« en montée de 80 m », « en descente raide »…).
   - Voix : synthèse vocale du téléphone (speechSynthesis, voix française), qui marche aussi sans réseau.
     Annonces à 200 m, au virage, puis la consigne suivante ; alertes hors trace et mauvais sens.
   Utilisation par terrain.js : const g = RTGuide.create({ G, root, map, L }) ; g.update(loc, état) ; g.destroy(). */
(() => {
  'use strict';

  const STEP = 10;              // rééchantillonnage de la trace (m)
  const WIN = 3;                // fenêtre de cap : 3 pas = 30 m avant et après
  const TURN_MIN = 45;          // en dessous (degrés) : simple courbe du chemin, on continue tout droit
  const VOICE_KEY = 'rt-guide-voice';
  const nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* indisponible */ } },
  };
  const norm = (a) => ((a + 540) % 360) - 180;

  // ------------------------------------------------------------ Lecture de la trace
  // G vient de terrain.js : xs/ys en mètres, up/down cumulés, track [lat, lon, alt, km]
  function resample(G) {
    const T = G.track, out = [];
    let j = 0;
    const totalM = G.total * 1000;
    for (let d = 0; d <= totalM; d += STEP) {
      while (j < T.length - 2 && T[j + 1][3] * 1000 < d) j++;
      const a = T[j], b = T[j + 1] || a;
      const da = a[3] * 1000, db = b[3] * 1000;
      const t = db > da ? Math.max(0, Math.min(1, (d - da) / (db - da))) : 0;
      out.push({
        x: G.xs[j] + (G.xs[j + 1 < T.length ? j + 1 : j] - G.xs[j]) * t,
        y: G.ys[j] + (G.ys[j + 1 < T.length ? j + 1 : j] - G.ys[j]) * t,
        lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t,
        km: d / 1000,
        up: G.up[j] + ((G.up[j + 1] ?? G.up[j]) - G.up[j]) * t,
        down: G.down[j] + ((G.down[j + 1] ?? G.down[j]) - G.down[j]) * t,
      });
    }
    return out;
  }
  const bearing = (a, b) => (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;

  function kindOf(delta) {
    const a = Math.abs(delta), side = delta > 0 ? 'droite' : 'gauche';
    if (a >= 125) return { type: 'sharp', side, text: `Virage en épingle à ${side}` };
    if (a >= 60) return { type: 'turn', side, text: `Tournez à ${side}` };
    return { type: 'slight', side, text: `Légèrement à ${side}` };
  }

  // Consigne à un croisement : t = virage de la trace (degrés, + à droite), alts = autres branches possibles
  function atJunction(t, alts) {
    const side = t > 0 ? 'droite' : 'gauche', a = Math.abs(t);
    if (a >= 125) return { type: 'sharp', side, text: `Au croisement, prenez le chemin en épingle à ${side}` };
    if (a >= 50) return { type: 'turn', side, text: `Au croisement, tournez à ${side}` };
    const twin = alts.filter((b) => Math.abs(norm(b - t)) < 35).sort((x, y) => Math.abs(norm(x - t)) - Math.abs(norm(y - t)))[0];
    if (twin != null) { const keep = norm(twin - t) > 0 ? 'gauche' : 'droite'; return { type: 'keep', side: keep, text: `À la fourche, restez à ${keep}` }; }
    if (a >= 20) return { type: 'slight', side, text: `Au croisement, prenez légèrement à ${side}` };
    return { type: 'straight', side: null, text: 'Tout droit au croisement' };
  }

  function junctionSteps(P, junctions) {
    // Deux nœuds du même carrefour (moins de 20 m) : un seul croisement, le virage le plus net
    const merged = [];
    for (const [km, t, alts] of junctions) {
      const prev = merged[merged.length - 1];
      if (prev && km - prev.km < 0.02) {
        if (Math.abs(t) > Math.abs(prev.t)) prev.t = t;
        prev.alts = prev.alts.concat(alts);
      } else merged.push({ km, t, alts: alts.slice() });
    }
    return merged.map((j) => {
      const i = Math.min(P.length - 1, Math.round((j.km * 1000) / STEP));
      return { i, end: i, km: P[i].km, endKm: P[i].km, ...atJunction(j.t, j.alts), lat: P[i].lat, lon: P[i].lon };
    });
  }

  function buildSteps(G, junctions) {
    const P = resample(G);
    if (P.length < WIN * 2 + 2) return { P, steps: [] };
    if (Array.isArray(junctions)) return finish(P, junctionSteps(P, junctions), true);
    // 1. Changement de cap en chaque point
    const delta = P.map((_, i) => (i < WIN || i >= P.length - WIN ? 0
      : norm(bearing(P[i], P[i + WIN]) - bearing(P[i - WIN], P[i]))));
    // 2. Groupes de points qui tournent dans le même sens
    let raw = [];
    for (let i = WIN; i < P.length - WIN; i++) {
      if (Math.abs(delta[i]) < TURN_MIN / 2) continue;
      const s = Math.sign(delta[i]);
      let j = i;
      while (j + 1 < P.length - WIN && Math.sign(delta[j + 1]) === s && Math.abs(delta[j + 1]) >= TURN_MIN / 3) j++;
      // cap avant le groupe (30 m) et après le groupe (30 m)
      const turn = norm(bearing(P[j], P[Math.min(P.length - 1, j + WIN)]) - bearing(P[Math.max(0, i - WIN)], P[i]));
      // Longue courbe régulière (le chemin suit le relief) : pas une consigne, sauf vrai changement de direction
      const gradual = (j - i) * STEP > 80 && Math.abs(turn) < 70;
      if (Math.abs(turn) >= TURN_MIN && !gradual) {
        let peak = i;
        for (let k = i; k <= j; k++) if (Math.abs(delta[k]) > Math.abs(delta[peak])) peak = k;
        raw.push({ i: peak, delta: turn });
      }
      i = j;
    }
    // 3. Chicanes (gauche puis droite aussitôt, sans vrai changement de direction) : ignorées
    const clean = [];
    for (let k = 0; k < raw.length; k++) {
      const a = raw[k], b = raw[k + 1];
      if (b && (b.i - a.i) * STEP < 50 && Math.sign(a.delta) !== Math.sign(b.delta)
        && Math.abs(a.delta + b.delta) < 30 && Math.abs(a.delta) < 90) { k++; continue; }
      // Deux virages du même côté à moins de 60 m : un seul virage plus franc
      if (clean.length && (a.i - clean[clean.length - 1].i) * STEP < 60 && Math.sign(a.delta) === Math.sign(clean[clean.length - 1].delta)) {
        clean[clean.length - 1].delta = norm(clean[clean.length - 1].delta + a.delta);
        continue;
      }
      clean.push({ ...a });
    }
    // 4. Lacets : au moins 4 virages serrés alternés, rapprochés
    const steps = [];
    for (let k = 0; k < clean.length; k++) {
      if (Math.abs(clean[k].delta) < 60) continue; // sans croisements connus : seulement les virages francs
      let e = k;
      while (e + 1 < clean.length && Math.abs(clean[e + 1].delta) >= 80 && Math.abs(clean[e].delta) >= 80
        && Math.sign(clean[e + 1].delta) !== Math.sign(clean[e].delta)
        && (clean[e + 1].i - clean[e].i) * STEP <= 150 && (clean[e + 1].i - clean[e].i) * STEP >= 20) e++;
      if (e - k + 1 >= 4) {
        const a = P[clean[k].i], b = P[clean[e].i];
        steps.push({ i: clean[k].i, end: clean[e].i, km: a.km, endKm: b.km, type: 'lacets', count: e - k + 1,
          side: clean[k].delta > 0 ? 'droite' : 'gauche',
          text: `Lacets en ${b.up - a.up >= b.down - a.down ? 'montée' : 'descente'}`, lat: a.lat, lon: a.lon });
        k = e;
      } else {
        const p = P[clean[k].i];
        steps.push({ i: clean[k].i, end: clean[k].i, km: p.km, endKm: p.km, ...kindOf(clean[k].delta), lat: p.lat, lon: p.lon });
      }
    }
    return finish(P, steps, false);
  }

  function finish(P, steps, junctionsKnown) {
    const last = P[P.length - 1];
    steps.push({ i: P.length - 1, end: P.length - 1, km: last.km, endKm: last.km, type: 'arrive', text: 'Arrivée', lat: last.lat, lon: last.lon });
    // 5. Relief entre chaque consigne et la suivante (et du départ à la première)
    let from = 0;
    for (const s of steps) {
      const a = P[from], b = P[s.i];
      s.legFromKm = a.km;
      s.legUp = b.up - a.up; s.legDown = b.down - a.down;
      from = s.end;
    }
    // Départ : direction de la marche sur les 60 premiers mètres
    const dir = bearing(P[0], P[Math.min(P.length - 1, 6)]);
    return { P, steps, junctionsKnown, startDir: CARD[Math.round(((dir + 360) % 360) / 45) % 8] };
  }
  const CARD = ['le nord', 'le nord-est', 'l\'est', 'le sud-est', 'le sud', 'le sud-ouest', 'l\'ouest', 'le nord-ouest'];

  // ------------------------------------------------------------ Mots
  const distTxt = (m, oral) => {
    if (m >= 950) {
      const km = Math.round(m / 100) / 10;
      return oral ? `${String(km).replace('.', ',')} kilomètre${km >= 2 ? 's' : ''}` : `${nf1.format(km)} km`;
    }
    const r = m >= 300 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10);
    return oral ? `${r} mètres` : `${r} m`;
  };
  function reliefTxt(up, down, lenM) {
    const u = Math.round(up / 10) * 10, d = Math.round(down / 10) * 10;
    const steep = (v) => lenM > 0 && v / lenM > 0.14;
    if (u >= 20 && u >= 2 * d) return `en montée${steep(up) ? ' raide' : ''} de ${u} m`;
    if (d >= 20 && d >= 2 * u) return `en descente${steep(down) ? ' raide' : ''} de ${d} m`;
    if (u >= 20 && d >= 20) return `${u} m de montée et ${d} m de descente`;
    return ''; // à peu près plat : rien à signaler
  }
  const oralRelief = (t) => t.replace(/(\d+) m\b/g, '$1 mètres');
  function stepPhrase(s, oral = false) {
    if (s.type === 'lacets') return `${s.text} : ${s.count} virages sur ${distTxt((s.endKm - s.km) * 1000, oral)}`;
    return s.text;
  }
  // Forme courte pour enchaîner : « puis tout de suite à droite »
  function shortPhrase(s, oral = false) {
    if (s.type === 'straight') return 'tout droit';
    if (s.type === 'keep') return `restez à ${s.side}`;
    if (s.type === 'turn') return `à ${s.side}`;
    if (s.type === 'slight') return `légèrement à ${s.side}`;
    if (s.type === 'sharp') return `l'épingle à ${s.side}`;
    return stepPhrase(s, oral).toLowerCase();
  }

  // ------------------------------------------------------------ Pictos
  function arrow(s) {
    const flip = s && s.side === 'gauche' ? ' transform="translate(48 0) scale(-1 1)"' : '';
    const t = s ? s.type : 'straight';
    let d;
    if (t === 'arrive') return '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 42V7" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M15 8h22l-5 7 5 7H15Z" fill="currentColor"/></svg>';
    if (t === 'turn') d = 'M16 42V24a6 6 0 0 1 6-6h12m-7-7 8 7-8 7';
    else if (t === 'slight') d = 'M18 42V28L32 14m-10 0h10v10';
    else if (t === 'keep') d = 'M24 42V26L14 12m20 0-6 9m6-9v8m0-8h-8';
    else if (t === 'sharp') d = 'M18 42V14a7 7 0 0 1 14 0v14m-7-6 7 8 7-8';
    else if (t === 'lacets') d = 'M24 44c-10-3 10-6 0-9s10-6 0-9 10-6 0-9 0-9 0-9m-6 6 6-7 6 7';
    else d = 'M24 42V8m-9 9 9-9 9 9';
    return `<svg viewBox="0 0 48 48" aria-hidden="true"><g${flip}><path d="${d}" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
  }

  // ------------------------------------------------------------ Voix
  let voiceFr = null;
  function pickVoice() {
    if (!('speechSynthesis' in window)) return null;
    const vs = speechSynthesis.getVoices().filter((v) => /^fr(-|_|$)/i.test(v.lang));
    voiceFr = vs.find((v) => v.localService && /fr-FR/i.test(v.lang)) || vs.find((v) => v.localService) || vs[0] || null;
    return voiceFr;
  }
  if ('speechSynthesis' in window) {
    pickVoice();
    speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', pickVoice);
  }
  const spoken = []; // pour les tests
  function say(text, { urgent = false } = {}) {
    spoken.push(text);
    if (!('speechSynthesis' in window)) return;
    if (urgent) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    if (voiceFr || pickVoice()) u.voice = voiceFr;
    u.rate = 1; u.pitch = 1;
    speechSynthesis.speak(u);
  }

  // ------------------------------------------------------------ Guidage en cours
  function create({ G, root, map, L, junctions }) {
    const { P, steps, startDir, junctionsKnown } = buildSteps(G, junctions);
    const NEXT = junctionsKnown ? 'jusqu\'au prochain croisement' : 'jusqu\'au prochain virage';
    const box = root.querySelector('[data-guide]');
    const sheet = root.querySelector('[data-guide-list]');
    let voice = store.get(VOICE_KEY) === '1';
    const done = new Map(); // index de consigne -> annonces déjà faites
    let cur = -1, lastKm = null, back = 0, wasOff = false, arrived = false;
    const marker = L.circleMarker([0, 0], { radius: 9, color: '#fff', weight: 3, fillColor: '#1c7ed6', fillOpacity: 1, interactive: false });

    const nextIndex = (km) => steps.findIndex((s) => s.km > km + 0.008 || (s.type === 'arrive' && s.km >= km));
    const legText = (s, fromKm) => {
      const len = Math.max(0, (s.km - fromKm) * 1000);
      return { len, relief: reliefTxt(s.legUp * (len / Math.max(1, (s.km - s.legFromKm) * 1000)), s.legDown * (len / Math.max(1, (s.km - s.legFromKm) * 1000)), len) };
    };

    function paint(idx, distM, km) {
      const s = steps[idx];
      if (!s) { box.hidden = true; return; }
      const after = steps[idx + 1];
      const { relief } = legText(s, km);
      box.hidden = false;
      box.className = `guide guide--${s.type}${distM <= 40 ? ' is-now' : ''}`;
      const thenTxt = after && s.type !== 'arrive' ? (after.km - s.endKm) * 1000 < 120
        ? `puis tout de suite ${shortPhrase(after)}`
        : `puis ${distTxt((after.km - s.endKm) * 1000)} ${reliefTxt(after.legUp, after.legDown, (after.km - after.legFromKm) * 1000)}`.trim() : '';
      box.innerHTML = `
        <div class="guide__arrow">${arrow(s)}</div>
        <div class="guide__main">
          <p class="guide__dist">${distM <= 15 ? 'Maintenant' : distTxt(distM)}</p>
          <p class="guide__text">${esc(stepPhrase(s))}</p>
          <p class="guide__sub">${[distM > 15 && relief ? `Jusque-là : ${relief}` : '', thenTxt].filter(Boolean).map(esc).join(' · ')}</p>
        </div>`;
      if (s.type !== 'arrive') { marker.setLatLng([s.lat, s.lon]); if (!map.hasLayer(marker)) marker.addTo(map); }
      else if (map.hasLayer(marker)) marker.remove();
    }

    function preview() {
      // Avant d'être sur la trace : la première consigne depuis le départ
      const s = steps[0];
      if (!s) return;
      box.hidden = false;
      box.className = 'guide guide--start';
      box.innerHTML = `<div class="guide__arrow">${arrow(null)}</div><div class="guide__main">
        <p class="guide__dist">Départ</p><p class="guide__text">Partez vers ${esc(startDir)}</p>
        <p class="guide__sub">${esc(`${`${distTxt(s.km * 1000)} ${reliefTxt(s.legUp, s.legDown, s.km * 1000)}`.trim()}, puis ${stepPhrase(s).toLowerCase()}`)}</p></div>`;
    }

    function speakLeg(idx, km) {
      const s = steps[idx];
      if (!s || !voice) return;
      const { len, relief } = legText(s, km);
      const rel = relief ? `, ${oralRelief(relief)}` : '';
      if (s.type === 'arrive') say(`Continuez sur ${distTxt(len, true)} jusqu'à l'arrivée${rel}.`);
      else if (len >= 250) say(`Continuez sur ${distTxt(len, true)} ${NEXT}${rel}.`);
    }

    function update(loc, { off, tooFar }) {
      if (tooFar || !loc) { preview(); return; }
      const km = loc.km;
      // Mauvais sens : la position recule nettement le long de la trace
      // (grand saut d'un coup : boucle qui se referme ou GPS retrouvé ailleurs, pas un demi-tour)
      const jump = lastKm != null && Math.abs(km - lastKm) > 0.5;
      if (jump) { back = 0; cur = nextIndex(km); }
      else if (lastKm != null) back = km < lastKm - 0.005 ? back + (lastKm - km) : Math.max(0, back - (km - lastKm));
      lastKm = km;
      if (back > 0.06 && !off) {
        if (!done.get('wrong')) { done.set('wrong', true); if (voice) say('Attention, vous semblez marcher dans le mauvais sens.', { urgent: true }); if (navigator.vibrate) navigator.vibrate([150, 80, 150]); }
      } else if (back < 0.02 && done.get('wrong')) {
        done.delete('wrong');
        if (voice) say('C\'est reparti dans le bon sens.');
      }
      // Hors trace / retour sur la trace
      if (off && !wasOff && voice) say('Attention, vous quittez le parcours.', { urgent: true });
      if (!off && wasOff && voice) say('Vous avez retrouvé le parcours.');
      wasOff = off;

      const idx = nextIndex(km);
      if (idx < 0) return;
      const quiet = !voice || !!done.get('wrong'); // à contre-sens : on n'annonce plus les virages
      const s = steps[idx];
      const distM = Math.max(0, (s.km - km) * 1000);
      if (idx !== cur) {
        const first = cur === -1;
        const prev = steps[cur === -1 ? -1 : idx - 1];
        cur = idx;
        // Virage dépassé entre deux positions GPS sans avoir été annoncé : on le dit quand même
        const missed = !first && prev && prev.type !== 'arrive' && !(done.get(idx - 1) || {}).now && (km - prev.endKm) * 1000 < 80;
        if (first && !quiet) say(`Guidage activé. ${distM > 40 ? `Dans ${distTxt(distM, true)}, ${stepPhrase(s, true).toLowerCase()}.` : `${stepPhrase(s, true)}.`}`);
        else if (missed && !quiet) { say(`${stepPhrase(prev, true)}.`, { urgent: true }); speakLeg(idx, km); }
        else if (!quiet) speakLeg(idx, km);
      }
      paint(idx, distM, km);
      const st = done.get(idx) || {};
      if (!quiet && s.type !== 'arrive') {
        const legLen = (s.km - s.legFromKm) * 1000;
        if (distM <= 200 && distM > 60 && !st.far && legLen > 300 && s.type !== 'straight') { st.far = true; say(`Dans ${distTxt(Math.round(distM / 50) * 50 || 50, true)}, ${stepPhrase(s, true).toLowerCase()}.`); }
        if (distM <= 45 && !st.now) {
          st.now = st.far = true;
          const after = steps[idx + 1];
          const soon = after && after.type !== 'arrive' && (after.km - s.endKm) * 1000 < 120;
          say(`${stepPhrase(s, true)}${soon ? `, puis tout de suite ${shortPhrase(after, true)}` : ''}.`, { urgent: true });
          if (soon) done.set(idx + 1, { far: true, now: true }); // déjà annoncé avec celui-ci
          if (navigator.vibrate) navigator.vibrate(120);
        }
      }
      if (s.type === 'arrive' && distM <= 40 && !arrived) {
        arrived = true;
        if (voice) say('Vous êtes arrivé. Bravo pour cette belle rando !', { urgent: true });
      }
      done.set(idx, st);
    }

    function list() {
      if (!sheet) return;
      let from = 0;
      sheet.innerHTML = (junctionsKnown ? '' : '<li class="guide-list__note">Croisements pas encore connus pour cette trace : seuls les virages francs sont indiqués.</li>')
        + `<li class="guide-list__item"><span class="guide-list__ico">${arrow(null)}</span><span><b>Départ</b> vers ${esc(startDir)}</span><span class="guide-list__km">0 km</span></li>`
        + steps.map((s, k) => {
          const leg = `${distTxt((s.km - from) * 1000)} ${reliefTxt(s.legUp, s.legDown, (s.km - s.legFromKm) * 1000)}`.trim();
          from = s.endKm;
          return `<li class="guide-list__leg">${esc(leg)}</li>
            <li class="guide-list__item"><button type="button" data-guide-go="${k}"><span class="guide-list__ico">${arrow(s)}</span><span>${esc(stepPhrase(s))}</span><span class="guide-list__km">km ${nf1.format(s.km)}</span></button></li>`;
        }).join('');
    }
    list();
    preview();

    root.addEventListener('click', onClick);
    function onClick(e) {
      const go = e.target.closest('[data-guide-go]');
      if (go) { const s = steps[+go.dataset.guideGo]; map.setView([s.lat, s.lon], 17); root.dispatchEvent(new CustomEvent('guide:goto')); }
    }

    return {
      steps, update,
      voiceOn: () => voice,
      setVoice(on) {
        voice = on;
        store.set(VOICE_KEY, on ? '1' : '0');
        if (on) {
          if (!('speechSynthesis' in window)) return false;
          // Le premier son doit partir d'un geste (iPhone) : petite phrase de confirmation
          say(cur >= 0 && steps[cur] ? `Guidage vocal activé. ${stepPhrase(steps[cur], true)} dans ${distTxt(Math.max(0, (steps[cur].km - (lastKm || 0)) * 1000), true)}.` : 'Guidage vocal activé.', { urgent: true });
        } else if ('speechSynthesis' in window) speechSynthesis.cancel();
        return true;
      },
      destroy() {
        root.removeEventListener('click', onClick);
        if (map.hasLayer(marker)) marker.remove();
        if ('speechSynthesis' in window) speechSynthesis.cancel();
        box.hidden = true;
      },
    };
  }

  window.RTGuide = { create, buildSteps, spoken, hasVoice: () => 'speechSynthesis' in window };
})();
