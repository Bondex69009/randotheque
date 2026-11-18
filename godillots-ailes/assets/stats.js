/* Randothèque – mesure d'audience maison, sans cookie ni stockage dans le navigateur.
   Rien n'est écrit sur l'appareil du visiteur ; l'adresse IP n'est jamais enregistrée par le serveur.
   Les autres scripts signalent une action avec window.rtStat('gpx', 'Nom de la rando', 'id'). */
(function () {
  'use strict';
  var me = document.currentScript;
  var noop = function () {};
  window.rtStat = noop;
  if (!me || !window.fetch || !window.JSON || !window.URLSearchParams) return;

  // Réception des visites : dossier /stats/ du même sous-domaine (stats-serveur/ du dépôt),
  // voisin des dossiers des deux sites -> « ../stats/collect.php » depuis chaque page.
  var END = me.getAttribute('data-endpoint') || new URL('../stats/collect.php', location.href).href;
  var SITE = me.getAttribute('data-site');
  if (!END || !SITE) return;

  // Robots et navigateurs pilotés par un programme : rien n'est envoyé.
  var n = navigator, d = document, ua = n.userAgent || '';
  if (n.webdriver || /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|pagespeed|gtmetrix|pingdom|prerender|phantom|selenium|puppeteer|playwright|electron/i.test(ua)) return;
  if (!/^Mozilla\/5\.0 \(/.test(ua)) return;

  function send(data, beacon) {
    data.s = SITE;
    var body = JSON.stringify(data);
    if (beacon && n.sendBeacon) {
      try { if (n.sendBeacon(END, new Blob([body], { type: 'text/plain' }))) return null; } catch (e) { /* repli fetch */ }
    }
    return fetch(END, {
      method: 'POST', body: body, keepalive: true, credentials: 'omit', mode: 'cors',
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Compteur intégré au blog : un simple affichage, sans visite.
  if (me.hasAttribute('data-widget')) {
    send({ t: 'wd', tc: n.maxTouchPoints || 0 });
    return;
  }

  var q = new URLSearchParams(location.search);
  var h = new URLSearchParams(location.hash.slice(1));
  var utm = {
    source: q.get('utm_source') || q.get('ref') || '',
    medium: q.get('utm_medium') || '',
    campaign: q.get('utm_campaign') || '',
    gclid: q.has('gclid') || q.has('gbraid') || q.has('wbraid') ? 1 : 0,
    msclkid: q.has('msclkid') ? 1 : 0,
    fbclid: q.has('fbclid') ? 1 : 0,
  };
  // Porte d'entrée de la visite (le site tient en une page : la suite est dans l'adresse après #)
  var landing = h.get('rando') ? 'fiche' : h.get('vs') ? 'vs' : h.get('q') ? 'recherche'
    : h.get('view') === 'map' ? 'carte' : Array.from(h.keys()).length ? 'filtres' : 'accueil';
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || n.standalone === true;
  var dark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;

  // Les actions attendent la réponse de la page vue (sinon le serveur ne saurait pas à quelle visite les rattacher).
  var hit = null, ready = false, queue = [];
  var shown = 0, since = 0;
  function startClock() { since = d.visibilityState === 'visible' ? Date.now() : 0; }
  function stopClock() { if (since) { shown += Date.now() - since; since = 0; } }

  function flush() { ready = true; var list = queue; queue = []; list.forEach(function (x) { send(x, true); }); }
  // Infos détaillées sur l'appareil (Chrome, Edge, Samsung Internet : modèle exact, version du système).
  // Rien n'est stocké sur l'appareil ; ces infos ne servent qu'aux statistiques d'ensemble.
  function hints() {
    var u = n.userAgentData;
    if (!u || !u.getHighEntropyValues) return Promise.resolve({});
    var t = new Promise(function (ok) { setTimeout(function () { ok({}); }, 400); });
    return Promise.race([u.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']).then(function (v) {
      var main = (v.fullVersionList || []).filter(function (b) { return !/Not.?A.?Brand|Chromium/i.test(b.brand); })[0] || {};
      return { model: v.model || '', pv: v.platformVersion || '', bn: main.brand || '', bv: main.version || '' };
    }, function () { return {}; }), t]);
  }

  function pageview() {
    shown = 0; startClock();
    var conn = n.connection || {};
    hints().then(function (ch) {
      var r = send({
        t: 'pv', r: d.referrer, u: utm, lg: standalone ? 'appli' : landing, id: h.get('rando') || h.get('vs') || '',
        tc: n.maxTouchPoints || 0, w: screen.width || 0, sh: screen.height || 0, dpr: window.devicePixelRatio || 1,
        vw: window.innerWidth || 0, net: conn.effectiveType || '', ch: ch,
        lang: (n.languages && n.languages[0]) || n.language || '', th: dark ? 'dark' : 'light', a: standalone ? 1 : 0,
      });
      if (!r) { flush(); return; }
      r.then(function (res) { return res.status === 200 ? res.json() : null; })
        .then(function (j) { hit = j; flush(); }, flush);
    });
  }

  // Profondeur de lecture : jusqu'où la page a été descendue (en %).
  var depth = 0;
  function measureDepth() {
    var max = Math.max(1, d.documentElement.scrollHeight - innerHeight);
    depth = Math.max(depth, Math.min(100, Math.round((100 * scrollY) / max)));
  }
  addEventListener('scroll', measureDepth, { passive: true });

  function ping() {
    stopClock();
    measureDepth();
    if (hit && hit.id) send({ t: 'ping', id: hit.id, k: hit.k, d: Math.round(shown / 1000), sd: depth }, true);
  }
  d.addEventListener('visibilitychange', function () { if (d.visibilityState === 'hidden') ping(); else startClock(); });
  addEventListener('pagehide', ping);

  // Une même action répétée dans la seconde (double clic) n'est comptée qu'une fois.
  var lastKey = '', lastAt = 0;
  window.rtStat = function (event, label, id) {
    var key = event + '|' + (id || label || '');
    var now = Date.now();
    if (key === lastKey && now - lastAt < 1000) return;
    lastKey = key; lastAt = now;
    var data = { t: 'ev', e: String(event), l: String(label || '').slice(0, 200), id: String(id || '').slice(0, 120) };
    if (ready) send(data, true); else queue.push(data);
  };

  // ------------------------------------------------------------ Toutes les autres interactions
  // Rando ouverte (fiche) : pour savoir à quelle rando se rapporte un clic.
  function rando() {
    var t = d.querySelector('dialog[open] #detail-title');
    var id = new URLSearchParams(location.hash.slice(1)).get('rando') || '';
    return { name: t ? t.textContent.trim() : '', id: t ? id : '' };
  }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80); }
  // Où se trouve l'élément cliqué.
  var PLACES = [
    ['#detail', 'Fiche'], ['.fo', 'Survol 3D'], ['.sh', 'Partage'], ['.cmp', 'Duel VS'], ['.cmp-tray', 'Duel VS'],
    ['#evo', 'Évolution'], ['#embed', 'Compteur'], ['.install-help', 'Installation'], ['#filters', 'Filtres'],
    ['.elsewhere', 'Chercher aussi sur'], ['.leaflet-container', 'Carte'], ['.site-header', 'En-tête'], ['.hero', 'Accueil'],
    ['#resultats', 'Résultats'],
  ];
  function place(el) {
    for (var i = 0; i < PLACES.length; i++) if (el.closest(PLACES[i][0])) return PLACES[i][1];
    return '';
  }
  // Lien externe : rangé par destination (blog, photos, Relive…).
  function linkKind(url) {
    var host = url.hostname.replace(/^www\./, ''), p = url.pathname;
    if (/blogspot\.|blogger\.com$/.test(host)) return 'blog';
    if (/^photos\.(google\.com|app\.goo\.gl)$/.test(host) || (host === 'goo.gl' && /^\/photos/.test(p))) return 'photos';
    if (/(^|\.)relive\.(cc|com)$/.test(host)) return 'relive';
    if (/^(drive|docs)\.google\.com$/.test(host)) return 'drive';
    if ((/(^|\.)google\.[a-z.]+$/.test(host) && /^\/maps/.test(p)) || /^maps\.app\.goo\.gl$|^maps\.google\./.test(host)) return 'route';
    if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/.test(host)) return 'video';
    if (/(^|\.)(visorando\.com|randogps\.net|altituderando\.com|alltrails\.com|komoot\.[a-z]+|strava\.com|openrunner\.com)$/.test(host)) return 'ext_site';
    return 'outbound';
  }
  // Boutons déjà comptés par app.js sous un nom précis.
  var KNOWN = '[data-fly],[data-share],[data-png],[data-ibp],[data-open],[data-anim],#open-embed,#open-evo,#hero-stats,#hero-total,a[download]';

  d.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    if (t.closest(KNOWN)) return; // déjà compté par app.js (GPX, IBP, survol 3D, partage…)
    var a = t.closest('a[href]');
    if (a) {
      var url;
      try { url = new URL(a.href, location.href); } catch (err) { return; }
      if (/^https?:$/.test(url.protocol) && url.host !== location.host) {
        var kind = linkKind(url), r = rando();
        var dest = url.hostname.replace(/^www\./, '');
        window.rtStat(kind, kind === 'outbound' || kind === 'ext_site' ? dest : (r.name || clean(a.textContent) || dest), r.id);
        return;
      }
    }
    var el = t.closest('button, [role="button"], a[href], summary, label.chip, [data-src]');
    if (!el) return;
    var label = clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent);
    if (!label) return;
    var where = place(el);
    window.rtStat('ui', (where ? where + ' : ' : '') + label);
  }, true);

  // Réglages : fond de carte, vitesse de lecture, cases et listes (hors champs de saisie).
  d.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !el.matches || el.matches('input[type="text"], input[type="search"], input[type="password"], textarea, #q')) return;
    if (el.closest('#filters') || el.id === 'sort') return; // déjà comptés comme filtres par app.js
    var lab = el.closest('label');
    var text = el.tagName === 'SELECT' ? (el.options[el.selectedIndex] || {}).text : (lab ? lab.textContent : el.value);
    var where = place(el);
    window.rtStat('ui', (where ? where + ' : ' : '') + clean(text));
  }, true);

  // Lecture des vidéos et audios (Relive intégré, résumés audio déjà comptés par app.js).
  d.addEventListener('play', function (e) {
    if (e.target && e.target.tagName === 'VIDEO') { var r = rando(); window.rtStat('video', r.name || 'Vidéo', r.id); }
  }, true);
  // Texte copié (adresse, coordonnées…).
  d.addEventListener('copy', function () { window.rtStat('ui', 'Texte copié'); });
  addEventListener('appinstalled', function () { window.rtStat('install', 'Appli installée'); });

  if (d.prerendering) d.addEventListener('prerenderingchange', pageview, { once: true });
  else pageview();
})();
