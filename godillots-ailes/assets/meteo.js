/* Randothèque – météo du jour de la rando et heure du coucher du soleil (même fichier dans les deux sites).
   - Météo : Open-Meteo (gratuit, sans clé). Prévisions jusqu'à 15 jours, météo observée pour les randos passées
     (archives depuis 1940). Rien n'est envoyé d'autre que la position du départ et la date.
   - Soleil : lever, coucher et nuit (fin du crépuscule civil) calculés ici, sans réseau, d'après la date et le départ.
   - Heure de départ réglable (retenue sur l'appareil) : arrivée estimée, pauses comprises, comparée au coucher.
   Utilisation par app.js : RTMeteo.html(r) dans la fiche, puis RTMeteo.mount(racine, r). */
(() => {
  'use strict';

  const TZ = 'Europe/Paris';
  const STORE = `rt-depart:${location.pathname}`;
  const hm = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hhmm = (ms) => hm.format(new Date(ms)).replace(':', 'h');
  const dur = (min) => { min = Math.max(0, Math.round(min)); const h = Math.floor(min / 60), m = min % 60; return h ? `${h} h${m ? ` ${String(m).padStart(2, '0')}` : ''}` : `${m} min`; };
  const todayParis = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
  };

  // ------------------------------------------------------------ Soleil (équation du lever du soleil)
  // Instant (ms UTC) où le centre du soleil passe à l'angle donné sous l'horizon, le matin et le soir.
  function sunTimes(date, lat, lon) {
    const rad = Math.PI / 180;
    const J = Date.parse(`${date}T12:00:00Z`) / 864e5 + 2440587.5;
    const n = Math.round(J - 2451545.0); // J tombe à midi UTC du jour voulu
    const Js = n - lon / 360;
    const M = (357.5291 + 0.98560028 * Js) % 360;
    const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
    const lam = (M + C + 180 + 102.9372) % 360;
    const Jt = 2451545.0 + Js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lam * rad);
    const sinD = Math.sin(lam * rad) * Math.sin(23.4397 * rad);
    const cosD = Math.cos(Math.asin(sinD));
    const toMs = (j) => (j - 2440587.5) * 864e5;
    const at = (deg) => {
      const c = (Math.sin(deg * rad) - Math.sin(lat * rad) * sinD) / (Math.cos(lat * rad) * cosD);
      if (c > 1 || c < -1) return null; // nuit ou jour polaire
      const w = Math.acos(c) / rad / 360;
      return [toMs(Jt - w), toMs(Jt + w)];
    };
    const sun = at(-0.833), civil = at(-6);
    return sun ? { rise: sun[0], set: sun[1], dusk: civil ? civil[1] : null, noon: toMs(Jt) } : null;
  }

  // Minuit (heure de Paris) du jour donné, en ms UTC
  function parisMidnight(date) {
    const guess = Date.parse(`${date}T00:00:00Z`);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(guess)).split(':').map(Number);
    const off = parts[0] * 60 + parts[1]; // décalage de Paris à minuit UTC (60 ou 120 min)
    return guess - (off > 720 ? off - 1440 : off) * 6e4;
  }

  // ------------------------------------------------------------ Pictos météo (SVG animés)
  // Codes WMO d'Open-Meteo -> [picto, libellé]
  const WMO = {
    0: ['sun', 'Grand soleil'], 1: ['sun-cloud', 'Plutôt ensoleillé'], 2: ['sun-cloud', 'Éclaircies'], 3: ['cloud', 'Couvert'],
    45: ['fog', 'Brouillard'], 48: ['fog', 'Brouillard givrant'],
    51: ['drizzle', 'Bruine légère'], 53: ['drizzle', 'Bruine'], 55: ['drizzle', 'Bruine dense'],
    56: ['sleet', 'Bruine verglaçante'], 57: ['sleet', 'Bruine verglaçante'],
    61: ['rain', 'Pluie faible'], 63: ['rain', 'Pluie'], 65: ['rain-heavy', 'Forte pluie'],
    66: ['sleet', 'Pluie verglaçante'], 67: ['sleet', 'Pluie verglaçante'],
    71: ['snow', 'Neige faible'], 73: ['snow', 'Neige'], 75: ['snow', 'Forte neige'], 77: ['snow', 'Grains de neige'],
    80: ['showers', 'Averses'], 81: ['showers', 'Averses'], 82: ['rain-heavy', 'Averses violentes'],
    85: ['snow', 'Averses de neige'], 86: ['snow', 'Averses de neige'],
    95: ['storm', 'Orage'], 96: ['storm', 'Orage et grêle'], 99: ['storm', 'Orage et grêle'],
  };
  const wmo = (code) => WMO[code] || ['cloud', 'Temps variable'];

  const CLOUD = 'M19 50h27a11 11 0 0 0 1.5-21.9A15 15 0 0 0 19.3 24 13 13 0 0 0 19 50Z';
  const SMALL_CLOUD = 'M24 52h22a9 9 0 0 0 1.2-17.9A12.5 12.5 0 0 0 24.3 31 10.5 10.5 0 0 0 24 52Z';
  const sunG = (cx, cy, r) => `<g class="wx-sun"><g class="wx-rays">${Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4, x1 = cx + Math.cos(a) * (r + 4), y1 = cy + Math.sin(a) * (r + 4), x2 = cx + Math.cos(a) * (r + 9), y2 = cy + Math.sin(a) * (r + 9);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }).join('')}</g><circle cx="${cx}" cy="${cy}" r="${r}"/></g>`;
  const moonG = (cx, cy) => `<path class="wx-moon" d="M${cx + 4} ${cy - 12}a12 12 0 1 0 10 17 10 10 0 0 1-10-17Z"/>`;
  const drops = (n, cls = 'wx-drop') => Array.from({ length: n }, (_, i) => {
    const x = 24 + i * (18 / Math.max(1, n - 1)) + (n === 1 ? 9 : 0);
    return `<line class="${cls}" style="animation-delay:${(i * 0.27).toFixed(2)}s" x1="${x.toFixed(1)}" y1="53" x2="${(x - 3).toFixed(1)}" y2="60"/>`;
  }).join('');
  const flakes = (n) => Array.from({ length: n }, (_, i) => `<circle class="wx-flake" style="animation-delay:${(i * 0.4).toFixed(1)}s" cx="${24 + i * 9}" cy="56" r="2.2"/>`).join('');

  function picto(kind, { night = false, size = 64, label = '' } = {}) {
    const sky = night ? moonG(23, 22) : sunG(23, 22, 9);
    let body;
    switch (kind) {
      case 'sun': body = night ? moonG(32, 30) : sunG(32, 32, 12); break;
      case 'sun-cloud': body = `${sky}<path class="wx-cloud wx-drift" d="${SMALL_CLOUD}"/>`; break;
      case 'cloud': body = `<path class="wx-cloud wx-cloud--back wx-drift-slow" d="${SMALL_CLOUD}" transform="translate(-10 -9) scale(.95)"/><path class="wx-cloud wx-drift" d="${CLOUD}"/>`; break;
      case 'fog': body = `<path class="wx-cloud" d="${CLOUD}" transform="translate(0 -6)"/>${[48, 54, 60].map((y, i) => `<line class="wx-fog" style="animation-delay:${i * 0.5}s" x1="${14 + i * 3}" y1="${y}" x2="${50 - i * 2}" y2="${y}"/>`).join('')}`; break;
      case 'drizzle': body = `<path class="wx-cloud wx-cloud--grey" d="${CLOUD}" transform="translate(0 -4)"/>${drops(3, 'wx-drop wx-drop--small')}`; break;
      case 'rain': body = `<path class="wx-cloud wx-cloud--grey" d="${CLOUD}" transform="translate(0 -4)"/>${drops(3)}`; break;
      case 'rain-heavy': body = `<path class="wx-cloud wx-cloud--dark" d="${CLOUD}" transform="translate(0 -4)"/>${drops(4)}`; break;
      case 'showers': body = `${sky}<path class="wx-cloud wx-cloud--grey wx-drift" d="${SMALL_CLOUD}" transform="translate(0 -4)"/>${drops(2)}`; break;
      case 'sleet': body = `<path class="wx-cloud wx-cloud--grey" d="${CLOUD}" transform="translate(0 -4)"/>${drops(2)}<circle class="wx-flake" cx="40" cy="57" r="2.2"/>`; break;
      case 'snow': body = `<path class="wx-cloud" d="${CLOUD}" transform="translate(0 -4)"/>${flakes(3)}`; break;
      case 'storm': body = `<path class="wx-cloud wx-cloud--dark" d="${CLOUD}" transform="translate(0 -6)"/><path class="wx-bolt" d="M34 42 27 54h6l-3 9 10-13h-6l4-8Z"/>${drops(2)}`; break;
      default: body = `<path class="wx-cloud" d="${CLOUD}"/>`;
    }
    return `<svg class="wx" viewBox="0 0 64 64" width="${size}" height="${size}" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${body}</svg>`;
  }

  // ------------------------------------------------------------ Données Open-Meteo (mises en cache pendant la visite)
  const memo = new Map();
  async function fetchWeather(lat, lon, date) {
    const ahead = daysBetween(todayParis(), date);
    if (ahead > 15) return { status: 'far', ahead };
    const recent = ahead >= -60;
    const key = `rt-wx:${lat.toFixed(2)},${lon.toFixed(2)},${date}`;
    if (memo.has(key)) return memo.get(key);
    // Copie gardée sur l'appareil : fraîche (moins d'une heure, ou météo passée), sinon secours hors ligne
    let stale = null;
    try {
      const hit = JSON.parse(localStorage.getItem(key) || 'null');
      if (hit && (!recent || Date.now() - hit.at < 3600e3)) { memo.set(key, hit.data); return hit.data; }
      if (hit) stale = { ...hit.data, staleAt: hit.at };
    } catch { /* stockage indisponible */ }
    const base = recent ? 'https://api.open-meteo.com/v1/forecast' : 'https://archive-api.open-meteo.com/v1/archive';
    const daily = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'wind_speed_10m_max', 'wind_gusts_10m_max']
      .concat(recent ? ['precipitation_probability_max'] : []);
    const hourly = ['temperature_2m', 'weather_code', 'precipitation', 'wind_speed_10m', 'is_day']
      .concat(recent ? ['precipitation_probability'] : []);
    const url = `${base}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&start_date=${date}&end_date=${date}`
      + `&daily=${daily.join(',')}&hourly=${hourly.join(',')}&timezone=Europe%2FParis&wind_speed_unit=kmh`;
    const p = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
      return res.json();
    }).then((j) => {
      const d = j.daily || {};
      if (!d.time || !d.time.length || d.weather_code[0] == null) return { status: 'none' };
      const data = {
        status: ahead >= 0 ? 'forecast' : 'observed',
        code: d.weather_code[0], tmax: d.temperature_2m_max[0], tmin: d.temperature_2m_min[0],
        rain: d.precipitation_sum[0], rainProb: d.precipitation_probability_max ? d.precipitation_probability_max[0] : null,
        wind: d.wind_speed_10m_max[0], gusts: d.wind_gusts_10m_max[0],
        hours: (j.hourly && j.hourly.time || []).map((t, i) => ({
          h: +t.slice(11, 13), temp: j.hourly.temperature_2m[i], code: j.hourly.weather_code[i],
          rain: j.hourly.precipitation[i], prob: j.hourly.precipitation_probability ? j.hourly.precipitation_probability[i] : null,
          wind: j.hourly.wind_speed_10m[i], night: j.hourly.is_day[i] === 0,
        })),
      };
      try {
        // On ne garde que les 40 dernières météos consultées
        const keys = Object.keys(localStorage).filter((k) => k.startsWith('rt-wx:'));
        if (keys.length > 40) keys.slice(0, keys.length - 40).forEach((k) => localStorage.removeItem(k));
        localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
      } catch { /* plein ou indisponible */ }
      return data;
    }).catch((e) => { if (stale) return stale; throw e; });
    memo.set(key, p);
    p.catch(() => memo.delete(key));
    return p;
  }

  // Petit conseil selon le temps prévu (le plus important d'abord)
  function advice(w) {
    const out = [];
    const [kind] = wmo(w.code);
    if (kind === 'storm') out.push(['warn', 'Risque d\'orage : évitez les crêtes et les sommets.']);
    if ((w.gusts ?? 0) >= 60) out.push(['warn', `Rafales jusqu'à ${Math.round(w.gusts)} km/h : prudence sur les crêtes.`]);
    if (kind === 'snow' || kind === 'sleet') out.push(['warn', 'Sol glissant possible : bâtons et bonnes semelles.']);
    if ((w.rainProb ?? 0) >= 60 || (w.rain ?? 0) >= 3) out.push(['info', 'Cape de pluie et vêtements de rechange dans le sac.']);
    else if ((w.rainProb ?? 0) >= 30) out.push(['info', 'Quelques gouttes possibles : un coupe-vent suffira.']);
    if ((w.tmax ?? 0) >= 30) out.push(['warn', 'Forte chaleur : partez tôt et prenez au moins 2 L d\'eau.']);
    else if ((w.tmin ?? 10) <= 2) out.push(['info', 'Ça caille au départ : bonnet et gants.']);
    if (!out.length && (kind === 'sun' || kind === 'sun-cloud')) out.push(['ok', 'Belle journée pour marcher : lunettes et crème solaire.']);
    if (!out.length) out.push(['ok', 'Temps correct pour randonner.']);
    return out.slice(0, 2);
  }

  // ------------------------------------------------------------ Heure de départ et arrivée estimée
  // Pauses ajoutées au temps de marche (norme DIN, hors pauses), d'après les sorties réellement enregistrées
  // du site : durée totale / temps estimé, valeur médiane (environ 1,1). 15 % si les données manquent.
  let ratio = null;
  function clubRatio() {
    if (ratio) return ratio;
    const list = ((window.RANDOTHEQUE && window.RANDOTHEQUE.randos) || [])
      .filter((r) => r.recorded && r.recorded.totalMin > 60 && r.durationMin > 60)
      .map((r) => r.recorded.totalMin / r.durationMin).filter((x) => x > 0.6 && x < 2).sort((a, b) => a - b);
    ratio = list.length >= 20 ? list[list.length >> 1] : 1.15;
    return ratio;
  }
  const pausesFor = (walkMin) => Math.round((walkMin * Math.max(0.05, clubRatio() - 1)) / 5) * 5;
  // Pique-nique d'environ 1 h, compté quand la rando passe midi (départ avant 12 h 30, arrivée après 12 h 15
  // sans compter le repas). Une sortie de l'après-midi ou finie avant midi n'en a pas.
  const PICNIC = 60;
  const picnicFor = (depMin, walkMin) => (depMin <= 12 * 60 + 30 && depMin + walkMin + pausesFor(walkMin) >= 12 * 60 + 15 ? PICNIC : 0);
  function defaultDeparture(r) {
    const saved = store.get(STORE);
    if (saved && /^\d{2}:\d{2}$/.test(saved)) return { time: saved, from: 'saved' };
    if (r.recorded && r.recorded.start) {
      const t = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(r.recorded.start));
      const [h, m] = t.split(':').map(Number);
      const mins = Math.round((h * 60 + m) / 15) * 15;
      if (mins >= 5 * 60 && mins <= 16 * 60) return { time: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`, from: 'trace' };
    }
    return { time: '09:00', from: 'default' };
  }

  // ------------------------------------------------------------ Affichage
  function html(r) {
    if (!r || !r.start || !r.date) return '';
    return `<section class="panel meteo" aria-labelledby="meteo-title" data-meteo="${esc(r.id)}">
      <h3 class="panel__title meteo__title" id="meteo-title">Météo et soleil <small class="meteo__day">${esc(dayFmt.format(new Date(`${r.date}T12:00:00Z`)))}</small></h3>
      <div class="meteo__wx" data-wx><div class="meteo__loading">${picto('sun-cloud', { size: 40 })}<span>Météo en chargement…</span></div></div>
      <div class="meteo__sun" data-sun></div>
    </section>`;
  }

  function hoursStrip(w, depMs, arrMs, mid) {
    const h0 = Math.max(0, Math.floor((depMs - mid) / 36e5)), h1 = Math.min(23, Math.ceil((arrMs - mid) / 36e5));
    const hours = w.hours.filter((x) => x.h >= h0 && x.h <= h1);
    if (hours.length < 2) return '';
    return `<ol class="meteo__hours" aria-label="Heure par heure pendant la rando">${hours.map((x) => `
      <li class="meteo__hour">
        <span class="meteo__h">${x.h}h</span>
        ${picto(wmo(x.code)[0], { night: x.night, size: 30, label: wmo(x.code)[1] })}
        <span class="meteo__t">${Math.round(x.temp)}°</span>
        <span class="meteo__p">${x.prob != null ? `${x.prob} %` : x.rain ? `${String(+x.rain.toFixed(1)).replace('.', ',')} mm` : '–'}</span>
      </li>`).join('')}</ol>`;
  }

  function renderWeather(box, w, ctx) {
    if (w.status === 'far') {
      const from = new Date(Date.parse(`${ctx.r.date}T12:00:00Z`) - 15 * 864e5);
      box.innerHTML = `<p class="meteo__note">${picto('sun-cloud', { size: 36 })}<span>Prévisions disponibles à partir du ${esc(dayFmt.format(from))}.</span></p>`;
      return;
    }
    if (w.status === 'none') { box.innerHTML = '<p class="meteo__note">Pas de données météo pour ce jour et ce lieu.</p>'; return; }
    const [kind, label] = wmo(w.code);
    box.innerHTML = `
      <div class="meteo__now">
        ${picto(kind, { size: 72, label })}
        <div class="meteo__main">
          <p class="meteo__label">${esc(label)} <span class="meteo__src">${w.status === 'forecast' ? 'prévision' : 'observé ce jour-là'}${w.staleAt ? ` · reçue le ${new Date(w.staleAt).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}, sans réseau depuis` : ''}</span></p>
          <p class="meteo__temps"><span class="meteo__tmax">${Math.round(w.tmax)}°</span><span class="meteo__tmin">${Math.round(w.tmin)}°</span></p>
        </div>
      </div>
      <div data-hours></div>`;
    ctx.weather = w;
    paintHours(ctx);
  }

  // Pluie et vent pendant la rando (heures entre le départ et l'arrivée), sinon sur la journée
  function windowStats(w, ctx) {
    const h0 = Math.floor((ctx.depMs - ctx.mid) / 36e5), h1 = Math.ceil((ctx.arrMs - ctx.mid) / 36e5);
    const hrs = w.hours.filter((x) => x.h >= h0 && x.h <= h1);
    if (hrs.length < 2) return { ...w, scope: 'la journée' };
    const max = (k) => Math.max(...hrs.map((x) => x[k] ?? 0));
    return {
      ...w, scope: 'la rando',
      rainProb: w.rainProb != null ? max('prob') : null,
      rain: hrs.reduce((t, x) => t + (x.rain || 0), 0),
      wind: max('wind'),
      tmax: max('temp'), tmin: Math.min(...hrs.map((x) => x.temp)),
    };
  }

  function paintHours(ctx) {
    const w = ctx.weather;
    const slot = ctx.root.querySelector('[data-hours]');
    if (!slot || !w) return;
    const st = windowStats(w, ctx);
    const num = (v) => String(+(v || 0).toFixed(1)).replace('.', ',');
    slot.innerHTML = `
      <dl class="meteo__facts">
        <div><dt>${st.rainProb != null ? 'Risque de pluie' : 'Pluie'}</dt><dd>${st.rainProb != null ? `${st.rainProb} %` : `${num(st.rain)} mm`}</dd></div>
        <div><dt>Vent</dt><dd>${Math.round(st.wind)} km/h</dd></div>
        <div><dt>Rafales</dt><dd>${Math.round(w.gusts)} km/h</dd></div>
      </dl>
      <p class="meteo__scope">${st.scope === 'la rando' ? 'Pendant la rando, d\'après l\'heure de départ' : 'Sur la journée'} · rafales : maximum du jour</p>
      ${hoursStrip(w, ctx.depMs, ctx.arrMs, ctx.mid)}
      ${w.status === 'forecast' ? `<ul class="meteo__advice">${advice({ ...st, gusts: w.gusts, code: w.code }).map(([lvl, t]) => `<li class="meteo__tip meteo__tip--${lvl}">${esc(t)}</li>`).join('')}</ul>` : ''}`;
  }

  function plan(ctx) {
    const walk = ctx.r.durationMin || 0, pauses = pausesFor(walk);
    const [h, m] = ctx.dep.split(':').map(Number);
    const picnic = picnicFor(h * 60 + m, walk);
    ctx.depMs = ctx.mid + (h * 60 + m) * 6e4;
    ctx.arrMs = ctx.depMs + (walk + pauses + picnic) * 6e4;
    const margin = ctx.sun ? (ctx.sun.set - ctx.arrMs) / 6e4 : null;
    const lvl = margin == null ? 'ok' : margin < 0 ? 'bad' : margin < 60 ? 'warn' : 'ok';
    const verdict = margin == null ? ''
      : margin < 0 ? `Arrivée ${dur(-margin)} après le coucher du soleil : partez plus tôt ou prévoyez une frontale.`
        : margin < 60 ? `Juste : ${dur(margin)} de marge avant le coucher du soleil.`
          : `${dur(margin)} de marge avant le coucher du soleil.`;
    return { walk, pauses, picnic, lvl, verdict };
  }
  // Frise de la journée (position en % de 0 h à 24 h)
  const pct = (ctx, t) => Math.max(0, Math.min(100, ((t - ctx.mid) / 864e5) * 100)).toFixed(2);

  function renderSun(ctx) {
    const { box, sun } = ctx;
    const p = plan(ctx);
    box.innerHTML = `
      ${sun ? `<div class="sunbar" aria-hidden="true">
        <span class="sunbar__day" style="left:${pct(ctx, sun.rise)}%;right:${(100 - pct(ctx, sun.set)).toFixed(2)}%"></span>
        <span class="sunbar__hike" data-hike></span>
        <span class="sunbar__tick" style="left:${pct(ctx, sun.rise)}%">${hhmm(sun.rise)}</span>
        <span class="sunbar__tick sunbar__tick--end" style="left:${pct(ctx, sun.set)}%">${hhmm(sun.set)}</span>
      </div>
      <dl class="meteo__facts meteo__facts--sun">
        <div><dt>Lever</dt><dd>${hhmm(sun.rise)}</dd></div>
        <div><dt>Coucher</dt><dd>${hhmm(sun.set)}</dd></div>
        <div><dt>Nuit</dt><dd>${sun.dusk ? hhmm(sun.dusk) : '–'}</dd></div>
      </dl>` : ''}
      <div class="meteo__plan">
        <label class="meteo__dep">Départ <input type="time" value="${ctx.dep}" step="300" data-dep aria-describedby="meteo-dep-hint"></label>
        <p class="meteo__arr" aria-live="polite">Arrivée vers <strong data-arr></strong></p>
      </div>
      <p class="meteo__hint" id="meteo-dep-hint"><span data-pauses></span><span data-from></span>${sun ? ` · jour de ${dur((sun.set - sun.rise) / 6e4)}` : ''}</p>
      <p class="meteo__verdict" data-verdict></p>`;
    paintPlan(ctx);
  }

  // Mise à jour sans tout redessiner (le champ de l'heure garde la main pendant la saisie)
  function paintPlan(ctx) {
    const { box } = ctx;
    const p = plan(ctx);
    const q = (s) => box.querySelector(s);
    q('[data-arr]').textContent = hhmm(ctx.arrMs);
    q('[data-pauses]').textContent = `${dur(p.walk)} de marche + ${dur(p.pauses)} de petites pauses`
      + (p.picnic ? ` + ${dur(p.picnic)} de pique-nique` : ' (pas de pique-nique : la rando ne passe pas midi)');
    q('[data-from]').textContent = ctx.depFrom === 'trace' ? ' · départ à l\'heure de la trace enregistrée' : '';
    const v = q('[data-verdict]');
    v.textContent = p.verdict; v.hidden = !p.verdict;
    v.className = `meteo__verdict meteo__verdict--${p.lvl}`;
    const hike = q('[data-hike]');
    if (hike) {
      hike.className = `sunbar__hike sunbar__hike--${p.lvl}`;
      hike.style.left = `${pct(ctx, ctx.depMs)}%`;
      hike.style.right = `${(100 - pct(ctx, ctx.arrMs)).toFixed(2)}%`;
    }
  }

  function mount(root, r) {
    const sec = root && root.querySelector(`[data-meteo="${CSS.escape(r.id)}"]`);
    if (!sec) return;
    const wxBox = sec.querySelector('[data-wx]'), sunBox = sec.querySelector('[data-sun]');
    const lat = r.start[0], lon = r.start[1];
    const d = defaultDeparture(r);
    const ctx = { r, root: sec, box: sunBox, sun: sunTimes(r.date, lat, lon), mid: parisMidnight(r.date), dep: d.time, depFrom: d.from, weather: null };
    renderSun(ctx);
    sunBox.addEventListener('input', (e) => {
      const inp = e.target.closest('[data-dep]');
      if (!inp || !/^\d{2}:\d{2}$/.test(inp.value)) return;
      ctx.dep = inp.value; ctx.depFrom = 'saved';
      store.set(STORE, inp.value);
      paintPlan(ctx);
      paintHours(ctx);
    });
    fetchWeather(lat, lon, r.date).then((w) => { if (sec.isConnected) renderWeather(wxBox, w, ctx); }, () => {
      if (sec.isConnected) wxBox.innerHTML = `<p class="meteo__note">${picto('cloud', { size: 36 })}<span>Météo indisponible pour le moment (connexion internet nécessaire).</span></p>`;
    });
  }

  // Résumé de la météo du jour de la rando, pour l'image et la vidéo de partage (assets/share.js) :
  // { kind, label, tmax, tmin, status } ou null (trop loin dans le futur, pas de données, hors connexion)
  async function summary(r) {
    if (!r || !r.start || !r.date) return null;
    try {
      const w = await fetchWeather(r.start[0], r.start[1], r.date);
      if (!w || (w.status !== 'forecast' && w.status !== 'observed')) return null;
      const [kind, label] = wmo(w.code);
      return { kind, label, tmax: Math.round(w.tmax), tmin: Math.round(w.tmin), status: w.status };
    } catch { return null; }
  }
  // Picto sans animation, couleurs comprises : en image SVG autonome (à dessiner sur un canvas)
  const STATIC_CSS = '.wx-sun circle{fill:#ffc83d}.wx-rays line{stroke:#ffc83d;stroke-width:3.2;stroke-linecap:round}'
    + '.wx-moon{fill:#f3e7b5}.wx-cloud{fill:#eef3f8;stroke:#9fb0c2;stroke-width:1.4}.wx-cloud--back{fill:#cfd9e4}'
    + '.wx-cloud--grey{fill:#c9d3de;stroke:#8797a9}.wx-cloud--dark{fill:#8392a5;stroke:#5f6d80}'
    + '.wx-drop{stroke:#4fb3ff;stroke-width:3;stroke-linecap:round}.wx-drop--small{stroke-width:2}'
    + '.wx-flake{fill:#fff;stroke:#8fb6d8;stroke-width:1}.wx-bolt{fill:#ffd43b;stroke:#e0a800;stroke-width:1;stroke-linejoin:round}'
    + '.wx-fog{stroke:#b6c3d1;stroke-width:3;stroke-linecap:round}';
  function pictoImage(kind, size = 128) {
    const svgTxt = picto(kind, { size }).replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" `).replace('>', `><style>${STATIC_CSS}</style>`);
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgTxt)}`;
    });
  }

  window.RTMeteo = { html, mount, sunTimes, parisMidnight, picto, pausesFor, picnicFor, summary, pictoImage };
})();
