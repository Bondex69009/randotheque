#!/usr/bin/env node
// Récupère les articles du blog « "Reco" des Godillots Ailés » (reconnaissances des randos) pour la
// recherche « Chercher aussi sur » et leur fiche dans la randothèque (carte, profil, survol 3D).
//
//   node scripts/scrape-reco.mjs            (au plus 60 nouveaux GPX par passage)
//   node scripts/scrape-reco.mjs --max=400
//
// Ces articles ne sont PAS ajoutés aux randos du club : tout est rangé dans externes/reco/, jamais
// dans gpx/, data/randos.* ou le compteur. On ne garde pas les GPX eux-mêmes (ils restent sur le
// Google Drive ou le Dropbox du blog) mais seulement une trace simplifiée pour la carte et le profil.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, decodeEntities, fetchWithRetry, readJSON, writeJSON, sleep, pool } from './lib/util.mjs';
import { parseGpx, flatten, elevationStats, estimateDurationMin, simplifyTo, bbox, haversine } from './lib/gpx.mjs';

const BLOG = 'https://godillotsreco.blogspot.com';
const DIR = path.join(ROOT, 'externes', 'reco');
const TRACKS = path.join(DIR, 'tracks');
const STATE_FILE = path.join(DIR, 'etat.json');     // suivi interne (articles vus, essais de téléchargement)
const PUBLIC_FILE = path.join(DIR, 'reco.json');    // lu par la page (assets/ailleurs.js)
const GEO_FILE = path.join(DIR, 'communes.json');
const MAX_NEW = Number((process.argv.find((a) => a.startsWith('--max=')) || '').slice(6)) || 60;
const FULL_SCAN_EVERY_H = 24;
const RETRY_FAILED_DAYS = 7;

const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
const MONTH_RE = MONTHS.join('|');
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const htmlText = (h) => decodeEntities(String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, ' '))
  .replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const idOf = (s) => `rc${crypto.createHash('sha1').update(s).digest('hex').slice(0, 10)}`;
const pad = (n) => String(n).padStart(2, '0');

// « 3 décembre 2026 », « 1er décembre 2026 » ou « 24-9-2023 » → 2026-12-03
function dateIn(s) {
  const n = norm(s);
  let m = n.match(new RegExp(`(\\d{1,2})(?:er)?\\s+(${MONTH_RE})\\s+(\\d{4})`));
  if (m) return `${m[3]}-${pad(MONTHS.indexOf(m[2]) + 1)}-${pad(m[1])}`;
  m = n.match(/\b(\d{1,2})[-/](\d{1,2})[-/](20\d\d)\b/);
  return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null;
}

// Lien de téléchargement direct d'un GPX publié sur Google Drive ou Dropbox
function gpxSource(href) {
  const drive = href.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([\w-]{20,})/);
  if (drive) return { key: `drive:${drive[1]}`, view: `https://drive.google.com/file/d/${drive[1]}/view`, dl: `https://drive.google.com/uc?export=download&id=${drive[1]}` };
  if (/^https?:\/\/(www\.dropbox\.com|dl\.dropboxusercontent\.com)\//.test(href)) {
    const u = new URL(href);
    u.searchParams.delete('dl');
    const view = u.toString();
    if (u.hostname === 'www.dropbox.com') u.searchParams.set('dl', '1');
    return { key: `dropbox:${u.pathname}`, view, dl: u.toString() };
  }
  return null;
}

// ---------------------------------------------------------------- Lecture du blog
async function feedPage(start, max) {
  const res = await fetchWithRetry(`${BLOG}/feeds/posts/default?alt=json&start-index=${start}&max-results=${max}`);
  if (!res.ok) throw new Error(`flux du blog : HTTP ${res.status}`);
  return (await res.json()).feed;
}

function parsePost(e) {
  const url = (e.link || []).find((l) => l.rel === 'alternate')?.href;
  const title = (e.title?.$t || '').trim();
  const html = e.content?.$t || e.summary?.$t || '';
  const text = htmlText(html);
  const flat = text.replace(/\n/g, ' ');
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: decodeEntities(m[1]), text: htmlText(m[2]) }));
  const seen = new Set();
  const gpx = links.filter((l) => /(^|[^a-z])gpx(?![a-z])/i.test(l.text))
    .map((l) => gpxSource(l.href)).filter((g) => g && !seen.has(g.key) && seen.add(g.key));

  // Nom : début du texte, sans l'en-tête « Reco randonnée du … » et avant « EFFORT 37 », « Prévu >>> », « - Trace »…
  let name = flat
    .replace(/^[*\s]+/, '')
    .replace(/^(?:\*?\s*(?:reco(?:nnue)?|rand(?:onn[ée]e|o))\b[^]*?\d{4}(?:\s*-\s*\d{1,2}\s*h\s*\d*)?\s*(?:-\s*)?)+/i, '');
  const cut = name.search(/\s(?:-\s*)?(?:\(\s*Rand|Reconstitu|EFFORT\b|Cotation\b|Cette randonn|Accompagnat|Animat|D[ée]part\b|Reco\s*>|Pr[ée]vu\s*>|Retenu\b|_+\s*\d|\d+\s*HKG|\d+\s*-?\s*(?:Trace|Route|KMZ|GPX)\b|\d+-(?:VERT|BLEU|JAUNE|ORANGE|ROUGE|NOIR)\b|Route\b|Trace\b|KMZ\b|GPX\b|[EÉ]claireur)/i);
  if (cut > 0) name = name.slice(0, cut);
  name = name.replace(/[\s.…\-–:*]+$/, '').replace(/\s*\.\.\.\s*$/, '').trim();
  // Noms inutilisables (date, réunion, phrase coupée) : on prendra la commune de départ de la trace
  if (name.length < 6 || name.length > 110 || /^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b|[ée]valuation|r[ée]union|programmation/i.test(name)) name = '';

  // Date de la rando (« Randonnée du dimanche 2 juin 2024 »), sinon date de la reco (titre), sinon publication
  const randoDate = dateIn((`${title} ${flat}`.match(/rand(?:onn[ée]e|o)\s+du\s+[^()]{0,40}?\d{4}/i) || [])[0] || '');
  const recoDate = dateIn(title);
  const pub = (e.published?.$t || '').slice(0, 10);
  const ok = (d) => d && Math.abs(+d.slice(0, 4) - +pub.slice(0, 4)) <= 1;

  const effort = Number(
    flat.match(/EFFORT\s*:?\s*(\d{1,3})/i)?.[1] || flat.match(/Reco\s*>+\s*_*\s*(\d{1,3})/i)?.[1]
    || flat.match(/(\d{1,3})\s*HKG/i)?.[1] || flat.match(/Pr[ée]vu\s*>+\s*_*\s*(\d{1,3})/i)?.[1]
    || flat.match(/\b(\d{1,3})-(?:VERT|BLEU|JAUNE|ORANGE|ROUGE|NOIR)\b/i)?.[1],
  ) || null;
  const color = flat.match(/\b\d{1,3}-(VERT|BLEU|JAUNE|ORANGE|ROUGE|NOIR)\b/i)?.[1];
  // Prénoms séparés par « - », « , » ou « et » (« Bruno D - Alain - Jean ») ; on s'arrête au premier mot qui suit sans séparateur
  const P1 = "[A-ZÉÈÀÎ][a-zéèêëïîôûç'-]+(?:\\s[A-Z]\\.?(?=\\s|$))?";
  const ecl = flat.match(new RegExp(`(?:[EÉ]claireu(?:r|se)s?|Accompagnat(?:eur|rice)s?)\\s*:\\s*(${P1}(?:\\s*(?:-|–|,|\\bet\\b)\\s*${P1})*)`))?.[1];
  const img = html.match(/<img\b[^>]*src="([^"]+)"/i)?.[1] || null;
  return {
    url, title,
    name,
    date: ok(randoDate) ? randoDate : ok(recoDate) ? recoDate : pub,
    recoDate: ok(recoDate) ? recoDate : null,
    km: Number(flat.match(/(\d+(?:[.,]\d+)?)\s*km\b/i)?.[1]?.replace(',', '.')) || null,
    dplus: Number(flat.match(/(\d{2,4})\s*m\s*D\s*\+/i)?.[1]) || null,
    effort: effort && effort < 300 ? effort : null,
    ffr: color ? norm(color) : null,
    eclaireurs: ecl ? ecl.replace(/\s+/g, ' ').replace(/[\s\-–.]+$/, '').trim().slice(0, 80) : null,
    image: img ? img.replace(/\/s\d+(-[a-z0-9-]+)?\//, '/s640/').replace(/\/w\d+-h\d+(-[a-z0-9-]+)?\//, '/s640/') : null,
    photos: links.find((l) => /photos\.(app\.goo\.gl|google\.com)/.test(l.href))?.href || null,
    gpx,
  };
}

// ---------------------------------------------------------------- Traces
const geo = readJSON(GEO_FILE, {});
async function commune(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (key in geo) return geo[key];
  try {
    const res = await fetchWithRetry(`https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&fields=nom,codeDepartement,departement&format=json`);
    const c = res.ok ? (await res.json())[0] : null;
    geo[key] = c ? { commune: c.nom, deptCode: c.codeDepartement, deptName: c.departement?.nom || null } : null;
  } catch { return null; }
  return geo[key];
}

async function fetchTrack(src) {
  const res = await fetchWithRetry(src.dl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer()).toString('utf8');
  if (!/<gpx[\s>]/i.test(raw.slice(0, 4000))) throw new Error('pas un GPX (lien privé ou supprimé ?)');
  const pts = flatten(parseGpx(raw).segments);
  if (pts.length < 2) throw new Error('trace trop courte');
  const ele = elevationStats(pts);
  const distanceKm = +(pts[pts.length - 1].d / 1000).toFixed(2);
  const start = pts[0], end = pts[pts.length - 1];
  const where = await commune(start.lat, start.lon);
  const track = simplifyTo(pts, 800, 4).map((p) => [
    +p.lat.toFixed(5), +p.lon.toFixed(5), p.ele == null ? null : Math.round(p.ele), +(p.d / 1000).toFixed(3),
  ]);
  return {
    track,
    stats: {
      distanceKm,
      dplus: ele ? ele.dplus : null, dminus: ele ? ele.dminus : null,
      altMin: ele ? ele.altMin : null, altMax: ele ? ele.altMax : null,
      durationMin: estimateDurationMin(distanceKm, ele ? ele.dplus : 0, ele ? ele.dminus : 0),
      loop: haversine(start, end) < Math.max(250, distanceKm * 30),
      start: [+start.lat.toFixed(5), +start.lon.toFixed(5)],
      bbox: bbox(pts),
      commune: where?.commune || null, deptCode: where?.deptCode || null, deptName: where?.deptName || null,
    },
  };
}

// ---------------------------------------------------------------- Programme principal
const state = readJSON(STATE_FILE, { fullScanAt: null, posts: {} });
const now = new Date();
const fullScan = !state.fullScanAt || (now - new Date(state.fullScanAt)) / 36e5 >= FULL_SCAN_EVERY_H;

let entries = [];
try {
  const first = await feedPage(1, 150);
  entries = first.entry || [];
  const total = Number(first.openSearch$totalResults?.$t) || entries.length;
  if (fullScan) {
    for (let start = 151; start <= total; start += 150) {
      await sleep(400);
      entries.push(...((await feedPage(start, 150)).entry || []));
    }
    state.fullScanAt = now.toISOString();
  }
  console.log(`Reco : ${entries.length} article(s) lus${fullScan ? ' (relecture complète)' : ''} sur ${total}`);
} catch (e) {
  console.warn(`Reco : blog injoignable (${e.message}), données inchangées.`);
  process.exit(0);
}

for (const e of entries) {
  const p = parsePost(e);
  if (!p.url) continue;
  // Seulement les articles de randos (pas les réunions, annonces…)
  if ((!p.gpx.length && !p.effort) || (!p.gpx.length && /r[ée]union|programmation/i.test(p.title))) { delete state.posts[p.url]; continue; }
  const old = state.posts[p.url] || {};
  state.posts[p.url] = { ...p, tracks: old.tracks || {} };
}

const todo = [];
for (const post of Object.values(state.posts).sort((a, b) => b.date.localeCompare(a.date))) {
  for (const src of post.gpx) {
    const t = post.tracks[src.key];
    const id = idOf(src.key);
    if (t?.ok && fs.existsSync(path.join(TRACKS, `${id}.js`))) continue;
    if (t && !t.ok && (now - new Date(t.at)) / 864e5 < RETRY_FAILED_DAYS) continue;
    todo.push({ post, src, id });
  }
}
const batch = todo.slice(0, MAX_NEW);
fs.mkdirSync(TRACKS, { recursive: true });
let done = 0, failed = 0;
await pool(batch, 2, async ({ post, src, id }) => {
  try {
    const { track, stats } = await fetchTrack(src);
    fs.writeFileSync(path.join(TRACKS, `${id}.js`), `window.__rtTrack&&__rtTrack(${JSON.stringify(id)},${JSON.stringify(track)});`);
    post.tracks[src.key] = { ok: true, at: now.toISOString(), id, ...stats };
    done++;
  } catch (err) {
    post.tracks[src.key] = { ok: false, at: now.toISOString(), error: err.message };
    failed++;
  }
  await sleep(300);
});
console.log(`Reco : ${done} trace(s) ajoutée(s), ${failed} en échec, ${Math.max(0, todo.length - batch.length)} encore à récupérer.`);

// Fichier public : un élément par trace (ou par article sans trace)
const items = [];
for (const post of Object.values(state.posts).sort((a, b) => b.date.localeCompare(a.date))) {
  const base = {
    url: post.url, name: post.name, date: post.date, recoDate: post.recoDate,
    eclaireurs: post.eclaireurs, effort: post.effort, ffr: post.ffr, image: post.image, photos: post.photos,
  };
  const ok = post.gpx.map((src) => ({ src, t: post.tracks[src.key] })).filter((x) => x.t?.ok);
  if (!ok.length) {
    items.push({ ...base, name: post.name || post.title, km: post.km, dplus: post.dplus, gpx: post.gpx[0]?.view || null });
    continue;
  }
  ok.forEach(({ src, t }, i) => {
    const { at, ok: _ok, ...stats } = t;
    items.push({ ...base, ...stats, name: post.name || stats.commune || post.title, part: ok.length > 1 && post.name ? i + 1 : undefined, km: stats.distanceKm, gpx: src.view });
  });
}
writeJSON(PUBLIC_FILE, { source: BLOG, updated: now.toISOString(), items }, false);
writeJSON(STATE_FILE, state, false);
writeJSON(GEO_FILE, geo, false);
console.log(`Reco : ${items.length} rando(s) dans externes/reco/reco.json (${items.filter((i) => i.id).length} avec trace)`);
