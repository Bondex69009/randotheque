#!/usr/bin/env node
// Récupère automatiquement les fichiers GPX publiés sur le blog des Godillots Ailés,
// avec les infos de chaque sortie (nom, date, IBP, animateurs, département, résumé audio...).
//
//   node scripts/scrape-blog.mjs            → met à jour (ne retélécharge que le nouveau)
//   node scripts/scrape-blog.mjs --refresh  → relit tous les articles
//
// Les articles modifiés sont relus (date de modification du flux). Pour les articles de la
// première page du blog, les GPX et audios sont en plus retéléchargés à chaque passage :
// un fichier remplacé sur Google Drive, ou un lien changé dans l'article, est donc repris.
//
// Résultat : fichiers dans gpx/blog/ et audio/blog/ + catalogue data/blog-catalog.json
import fs from 'node:fs';
import path from 'node:path';
import {
  BLOG_GPX_DIR, BLOG_AUDIO_DIR, CACHE_DIR, DATA_DIR, decodeEntities, fetchWithRetry, pool,
  readJSON, slugify, writeJSON, sleep,
} from './lib/util.mjs';

const BLOG = 'https://godillotsailes.blogspot.com';
const REFRESH = process.argv.includes('--refresh');
const POST_CACHE = path.join(CACHE_DIR, 'blog', 'posts');
const CATALOG_FILE = path.join(DATA_DIR, 'blog-catalog.json');
const FAILED_FILE = path.join(CACHE_DIR, 'blog', 'failed-downloads.json');
// Heure de la dernière vérification (non versionnée : elle change à chaque passage)
const LAST_CHECK_FILE = path.join(CACHE_DIR, 'blog', 'last-check.json');
const MAX_AUDIO_BYTES = 60 * 1024 * 1024;

const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];

// ---------------------------------------------------------------- Flux des articles
async function listPosts() {
  const posts = [];
  for (let start = 1; ; start += 150) {
    const url = `${BLOG}/feeds/posts/default?alt=json&max-results=150&start-index=${start}`;
    const res = await fetchWithRetry(url);
    const json = await res.json();
    const entries = json.feed.entry || [];
    for (const e of entries) {
      posts.push({
        id: e.id.$t.split('post-').pop(),
        title: decodeEntities(e.title.$t || '').trim(),
        published: e.published.$t,
        updated: e.updated.$t,
        url: (e.link.find((l) => l.rel === 'alternate') || {}).href,
        labels: (e.category || []).map((c) => c.term),
        thumb: e.media$thumbnail ? e.media$thumbnail.url : null,
      });
    }
    if (entries.length < 150) break;
  }
  return posts;
}

// Identifiants des articles affichés sur la première page du blog.
async function listFrontPage() {
  try {
    const res = await fetchWithRetry(`${BLOG}/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return new Set([...html.matchAll(/id=['"]post-body-(\d+)['"]/g)].map((m) => m[1]));
  } catch (e) {
    console.warn(`   ⚠️  Première page du blog illisible (${e.message}) : pas de revérification des fichiers`);
    return new Set();
  }
}

// On ne garde en cache que le corps de l'article (quelques Ko au lieu de ~150 Ko).
function slimPost(html) {
  const i = html.indexOf("class='post-body");
  if (i < 0) return html;
  const j = html.indexOf("class='post-footer", i);
  return html.slice(Math.max(0, i - 200), j > 0 ? j + 40 : undefined);
}

async function getPostHtml(post) {
  const file = path.join(POST_CACHE, `${post.id}.html`);
  const metaFile = file + '.updated';
  if (!REFRESH && fs.existsSync(file) && fs.existsSync(metaFile)
      && fs.readFileSync(metaFile, 'utf8') === post.updated) {
    return fs.readFileSync(file, 'utf8');
  }
  const res = await fetchWithRetry(post.url);
  const html = await res.text();
  fs.mkdirSync(POST_CACHE, { recursive: true });
  fs.writeFileSync(file, slimPost(html));
  fs.writeFileSync(metaFile, post.updated);
  return html;
}

// ---------------------------------------------------------------- Analyse d'un article
function extractBody(html) {
  const i = html.indexOf("class='post-body");
  if (i < 0) return '';
  const start = html.indexOf('>', i) + 1;
  let end = html.indexOf("class='post-footer", start);
  if (end < 0) end = html.length;
  return html.slice(start, end);
}

// Transforme le HTML en texte linéaire, en mémorisant la position de chaque lien.
function linearize(bodyHtml) {
  let text = '';
  const links = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>|<br\s*\/?>|<\/(?:div|p|li|h\d)>|<[^>]+>|([^<]+)/gi;
  let m;
  while ((m = re.exec(bodyHtml))) {
    if (m[1] !== undefined) {
      const inner = decodeEntities(m[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      links.push({ href: decodeEntities(m[1]), text: inner, pos: text.length });
      text += ` ${inner} `;
    } else if (m[3] !== undefined) {
      text += decodeEntities(m[3]).replace(/[ \t\r\n]+/g, ' ');
    } else if (/^<br|^<\/(div|p|li|h\d)/i.test(m[0])) {
      text += '\n';
    }
  }
  return { text, links };
}

const IBP_COLORS = { VERT: 'vert', BLEU: 'bleu', JAUNE: 'jaune', ROUGE: 'rouge', NOIR: 'noir' };

function findIbpMarks(text, links) {
  const marks = [];
  const add = (pos, value) => {
    const v = parseInt(value, 10);
    if (v > 0 && v < 300) marks.push({ pos, value: v });
  };
  for (const l of links) {
    if (/ibpindex\.com/i.test(l.href)) {
      const n = l.text.match(/(\d{1,3})/);
      if (n) add(l.pos, n[1]);
    }
  }
  const patterns = [
    /EFFORT\s*:?\s*(\d{1,3})\b/gi,
    /\b(\d{1,3})\s*HKG\b/gi,
    /\b(\d{1,3})\s*-\s*(?:VERT|BLEU|JAUNE|ROUGE|NOIR)\b/gi,
    /IBP(?:[\s-]*index)?\s*:?\s*(\d{1,3})\b/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) add(m.index, m[1]);
  }
  // un même chiffre détecté deux fois au même endroit → on dédoublonne
  marks.sort((a, b) => a.pos - b.pos);
  return marks.filter((m, i) => i === 0 || Math.abs(m.pos - marks[i - 1].pos) > 3 || m.value !== marks[i - 1].value);
}

function gpxDownloadUrl(href) {
  const drive = href.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([\w-]{20,})/);
  if (drive) return { url: `https://drive.google.com/uc?export=download&id=${drive[1]}`, key: `drive:${drive[1]}` };
  if (/dropbox\.com/.test(href)) {
    const u = href.replace(/([?&])dl=0/, '$1dl=1');
    return { url: /dl=1/.test(u) ? u : u + (u.includes('?') ? '&' : '?') + 'dl=1', key: `url:${href}` };
  }
  return { url: href, key: `url:${href}` };
}

function parseFrenchDate(s) {
  const n = (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const m = n.match(/(\d{1,2})(?:er)?\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(MONTHS.indexOf(m[2]) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function cleanName(line) {
  let s = line.replace(/\s+/g, ' ').trim();
  const cut = s.search(/\s(?:EFFORT\b|\d{1,3}\s*HKG\b|_\s*\d|Route\b|Trace\b|GPX\b|Reco\b|Carte\b|M[ée]t[ée]o|Animateurs?\b|Accompagnateurs?\b|\*{2,}|-\s*\d+(?:[.,]\d+)?\s*km|Participation\b)/i);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/[\s\-–:>_*.]+$/, '').replace(/^[\s\-–:"«]+/, '').replace(/["»]+$/, '').trim();
  // "GALICIAN 25" → "GALICIAN"
  s = s.replace(/\s+\d{1,3}$/, '').trim();
  return s;
}

function parseDeclared(segment) {
  const out = {};
  const km = segment.match(/(\d{1,2}(?:[.,]\d)?)\s*km/i);
  if (km) out.km = parseFloat(km[1].replace(',', '.'));
  const dplus = segment.match(/(\d{2,4})\s*m(?:\s*D\+|\b)/i);
  if (dplus) out.dplus = parseInt(dplus[1], 10);
  // durée annoncée du type "15 Km - 5h - 400 m" (on ignore "Rassemblement 13h00")
  const h = segment.match(/km\s*-\s*(\d{1,2})\s*h\s*(\d{2})?\b/i);
  if (h && +h[1] <= 12) out.hours = +h[1] + (h[2] ? +h[2] / 60 : 0);
  return Object.keys(out).length ? out : null;
}

function parsePost(post, html) {
  const body = extractBody(html);
  if (!body) return [];
  const { text, links } = linearize(body);

  const gpxLinks = links.filter((l) =>
    /^gpx$/i.test(l.text.replace(/[^\w]/g, ''))
    || /\.gpx(?:$|[?#])/i.test(l.href)
    || (/\bgpx\b/i.test(l.text) && /drive\.google|dropbox/.test(l.href) && l.text.length < 25));
  if (!gpxLinks.length) return [];

  const marks = findIbpMarks(text, links);
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => /[A-Za-zÀ-ÿ]{3}/.test(l)) || '';
  const baseName = cleanName(firstLine) || post.title;
  const animMatch = text.match(/(?:Animateurs?|Accompagnateurs?)\s*:\s*([^\n]+)/i);
  const animateurs = animMatch
    ? animMatch[1].split(/Rassemblement|R[ée]sum[ée]|Route|Vue|La Route|\(/i)[0].replace(/\s+/g, ' ').trim().replace(/[-–\s.]+$/, '')
    : null;
  const date = parseFrenchDate(post.title) || parseFrenchDate(firstLine) || post.published.slice(0, 10);
  const cancelled = post.labels.includes('ANNULEE') || /\bannul[ée]e?\b/i.test(post.title);
  const departements = post.labels.filter((l) => l !== 'ANNULEE');
  const image = post.thumb ? post.thumb.replace(/\/s72-[^/]*\//, '/w640-h360-c/') : null;
  // Résumé audio (« RESUME - Audio 1'22" », lien Google Drive) : commun à toutes les traces de l'article
  const audioSeen = new Set();
  const audio = links
    .filter((l) => /\baudio\b/i.test(l.text) && /drive\.google|dropbox/.test(l.href))
    .map((l) => {
      const dl = gpxDownloadUrl(l.href);
      const dur = l.text.match(/(\d{1,2})\s*['’]\s*(\d{2})/);
      return { key: dl.key, downloadUrl: dl.url, sourceUrl: l.href, label: l.text, seconds: dur ? +dur[1] * 60 + +dur[2] : null };
    })
    .filter((a) => !audioSeen.has(a.key) && audioSeen.add(a.key));

  const items = [];
  gpxLinks.forEach((link, k) => {
    const prevPos = k > 0 ? gpxLinks[k - 1].pos : -1;
    const nextPos = k < gpxLinks.length - 1 ? gpxLinks[k + 1].pos : Infinity;
    // IBP : le dernier repère placé avant ce lien GPX (et après le lien précédent),
    // sinon le premier qui suit, sinon le dernier repère disponible avant.
    let mark = [...marks].reverse().find((m) => m.pos < link.pos && m.pos > prevPos)
      || marks.find((m) => m.pos > link.pos && m.pos < nextPos)
      || [...marks].reverse().find((m) => m.pos < link.pos);
    const segStart = prevPos < 0 ? 0 : prevPos;
    const segment = text.slice(segStart, Math.min(text.length, (nextPos === Infinity ? link.pos + 300 : nextPos)));
    let variant = null;
    if (gpxLinks.length > 1) {
      const before = text.slice(segStart, link.pos);
      const v = before.match(/\b(Reco|Rando|Jour\s*\d|J\s*\d|Matin|Apr[èe]s[- ]midi|Variante|Court|Long)\b/i);
      variant = v ? v[1] : `Parcours ${k + 1}`;
    }
    const colorMatch = segment.match(/\b(VERT|BLEU|JAUNE|ROUGE|NOIR)\b/);
    const dl = gpxDownloadUrl(link.href);
    items.push({
      key: dl.key,
      downloadUrl: dl.url,
      sourceUrl: link.href,
      name: variant ? `${baseName} (${variant})` : baseName,
      date,
      ibp: mark ? mark.value : null,
      ibpColor: colorMatch ? IBP_COLORS[colorMatch[1]] : null,
      declared: parseDeclared(segment),
      animateurs: animateurs || null,
      departements,
      cancelled,
      image,
      audio: audio.length ? audio : null,
      post: { id: post.id, title: post.title, url: post.url, published: post.published },
    });
  });
  return items;
}

// ---------------------------------------------------------------- Téléchargement
function looksLikeGpx(buf) {
  const head = buf.subarray(0, 4000).toString('utf8');
  return /<gpx[\s>]/i.test(head) || (/<\?xml/i.test(head) && buf.toString('utf8').includes('<gpx'));
}

async function fetchGpx(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!looksLikeGpx(buf)) throw new Error('le fichier reçu n\'est pas un GPX (lien privé ou supprimé ?)');
  return buf;
}

const AUDIO_TYPES = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm',
};
async function fetchAudio(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const fileName = ((res.headers.get('content-disposition') || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i) || [])[1] || '';
  const nameExt = path.extname(fileName).slice(1).toLowerCase();
  const ext = AUDIO_TYPES[type] || (Object.values(AUDIO_TYPES).includes(nameExt) ? nameExt : null);
  if (!ext) throw new Error(`le fichier reçu n'est pas un audio (${type || 'type inconnu'})`);
  if (+res.headers.get('content-length') > MAX_AUDIO_BYTES) throw new Error('fichier audio trop lourd');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_AUDIO_BYTES) throw new Error('fichier audio trop lourd');
  return { buf, ext };
}

function uniqueName(base, ext, used) {
  let name = `${base}.${ext}`;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}.${ext}`;
  used.add(name.toLowerCase());
  return name;
}

// N'écrit le fichier que si son contenu a changé (évite des commits inutiles). Renvoie true si écrit.
function writeIfChanged(file, buf) {
  if (fs.existsSync(file) && fs.readFileSync(file).equals(buf)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return true;
}

const listLower = (dir) => new Set(fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => f.toLowerCase()) : []);

// ---------------------------------------------------------------- Programme principal
async function main() {
  console.log('📡 Lecture du flux du blog…');
  const [posts, frontPage] = await Promise.all([listPosts(), listFrontPage()]);
  console.log(`   ${posts.length} articles trouvés, dont ${frontPage.size} en première page (fichiers revérifiés)`);

  const catalog = readJSON(CATALOG_FILE, { generatedAt: null, items: [] });
  const byKey = new Map(catalog.items.map((it) => [it.key, it]));
  const knownAudio = new Map(catalog.items.flatMap((it) => (it.audio || []).filter((a) => a.file).map((a) => [a.key, a.file])));
  const failed = readJSON(FAILED_FILE, {});

  console.log('📖 Analyse des articles…');
  let done = 0;
  const parsedOk = new Set(); // articles lus correctement (sert à repérer les liens retirés)
  const parsed = await pool(posts, 6, async (post) => {
    try {
      const html = await getPostHtml(post);
      const items = parsePost(post, html);
      if (html.includes("class='post-body")) parsedOk.add(post.id);
      if (++done % 100 === 0) console.log(`   ${done}/${posts.length}`);
      return items;
    } catch (e) {
      console.warn(`   ⚠️  ${post.url} : ${e.message}`);
      return [];
    }
  });

  // Un même GPX peut être publié plusieurs fois (rando refaite) : on regroupe par lien.
  const found = new Map();
  for (const item of parsed.flat()) {
    const front = frontPage.has(item.post.id);
    const prev = found.get(item.key);
    if (!prev) { found.set(item.key, { ...item, outings: [item.date], front }); continue; }
    prev.outings.push(item.date);
    // On garde les infos de l'article le plus récent, en complétant ce qui manque.
    const [recent, old] = item.date > prev.date ? [item, prev] : [prev, item];
    const merged = { ...old, ...Object.fromEntries(Object.entries(recent).filter(([, v]) => v != null)) };
    merged.outings = prev.outings;
    merged.front = prev.front || front;
    found.set(item.key, merged);
  }
  console.log(`   ${found.size} liens GPX distincts`);
  if (process.argv.includes('--dry')) {
    writeJSON(path.join(CACHE_DIR, 'blog', 'dry-run.json'), [...found.values()]);
    console.log('   (--dry : aperçu écrit dans .cache/blog/dry-run.json, rien téléchargé)');
    return;
  }

  // ---- GPX : nouveaux liens, puis revérification de ceux de la première page
  const gpxPath = (f) => path.join(BLOG_GPX_DIR, f);
  const knownFile = (it) => { const k = byKey.get(it.key); return k && k.file && fs.existsSync(gpxPath(k.file)) ? k.file : null; };

  // Liens retirés d'un article de la première page, ou article récent supprimé (ex. « prochaine sortie »
  // remplacé par l'article définitif) : les fichiers devenus orphelins sont supprimés (sinon ils
  // réapparaîtraient comme des randos « perso » en double). C'est fait avant les téléchargements pour
  // que le GPX qui remplace l'ancien garde exactement le même nom de fichier.
  const postIds = new Set(posts.map((p) => p.id));
  const frontSince = posts.filter((p) => frontPage.has(p.id)).map((p) => p.published).sort()[0];
  const inScope = (old) => old.post && (
    (frontPage.has(old.post.id) && parsedOk.has(old.post.id))
    || (frontSince && !postIds.has(old.post.id) && old.post.published >= frontSince));
  const stillUsed = new Set([...found.values()].map(knownFile).filter(Boolean).map((f) => f.toLowerCase()));
  let removed = 0;
  for (const old of catalog.items) {
    if (!inScope(old) || !old.file || found.has(old.key) || stillUsed.has(old.file.toLowerCase())) continue;
    if (!fs.existsSync(gpxPath(old.file))) continue;
    fs.rmSync(gpxPath(old.file)); removed++;
    console.log(`   🗑️  GPX retiré du blog : ${old.name} (${old.file})`);
  }
  const usedNames = listLower(BLOG_GPX_DIR);
  const todo = [...found.values()].filter((it) => !knownFile(it) && (REFRESH || it.front || !failed[it.key]));
  const recheck = [...found.values()].filter((it) => it.front && knownFile(it));

  console.log(`⬇️  Téléchargement de ${todo.length} nouveaux GPX, revérification de ${recheck.length}…`);
  let ok = 0, ko = 0, updated = 0;
  await pool(todo, 4, async (it) => {
    try {
      const buf = await fetchGpx(it.downloadUrl);
      it.file = uniqueName(`${it.date}_${slugify(it.name) || 'rando'}`, 'gpx', usedNames);
      fs.mkdirSync(BLOG_GPX_DIR, { recursive: true });
      fs.writeFileSync(gpxPath(it.file), buf);
      ok++;
      delete failed[it.key];
    } catch (e) {
      ko++;
      failed[it.key] = { url: it.sourceUrl, post: it.post.url, error: e.message };
    }
    await sleep(150);
  });
  await pool(recheck, 4, async (it) => {
    try {
      if (writeIfChanged(gpxPath(knownFile(it)), await fetchGpx(it.downloadUrl))) {
        updated++;
        console.log(`   🔄 GPX modifié sur le blog : ${it.name}`);
      }
    } catch (e) {
      console.warn(`   ⚠️  ${it.name} : ${e.message} (on garde la version déjà téléchargée)`);
    }
    await sleep(150);
  });
  console.log(`   ✅ ${ok} téléchargés, 🔄 ${updated} mis à jour, ❌ ${ko} indisponibles`);

  // ---- Résumés audio
  const audioPath = (f) => path.join(BLOG_AUDIO_DIR, f);
  const audioJobs = new Map();
  for (const it of found.values()) {
    if (!it.file && !knownFile(it)) continue; // rando sans GPX : absente du catalogue, audio inutile
    for (const a of it.audio || []) if (!audioJobs.has(a.key) || it.front) audioJobs.set(a.key, { a, it });
  }
  const audioStillUsed = new Set([...audioJobs.keys()].map((k) => knownAudio.get(k)).filter(Boolean).map((f) => f.toLowerCase()));
  for (const old of catalog.items) {
    if (!inScope(old)) continue;
    for (const a of old.audio || []) {
      if (!a.file || audioJobs.has(a.key) || audioStillUsed.has(a.file.toLowerCase()) || !fs.existsSync(audioPath(a.file))) continue;
      fs.rmSync(audioPath(a.file)); removed++;
    }
  }
  const usedAudio = listLower(BLOG_AUDIO_DIR);
  const audioFile = new Map();
  let aNew = 0, aUpd = 0, aKo = 0;
  await pool([...audioJobs.values()], 3, async ({ a, it }) => {
    const known = knownAudio.get(a.key);
    const exists = !!known && fs.existsSync(audioPath(known));
    if (exists && !it.front && !REFRESH) { audioFile.set(a.key, known); return; }
    if (!exists && failed[a.key] && !it.front && !REFRESH) return;
    try {
      const { buf, ext } = await fetchAudio(a.downloadUrl);
      const base = `${it.date}_${slugify(it.name.replace(/\s*\([^)]*\)$/, '')) || 'audio'}`;
      const name = exists && path.extname(known).slice(1) === ext ? known : uniqueName(base, ext, usedAudio);
      if (writeIfChanged(audioPath(name), buf)) { if (exists) aUpd++; else aNew++; }
      if (exists && name !== known) fs.rmSync(audioPath(known), { force: true });
      audioFile.set(a.key, name);
      delete failed[a.key];
    } catch (e) {
      if (exists) audioFile.set(a.key, known);
      else { aKo++; failed[a.key] = { url: a.sourceUrl, post: it.post.url, error: e.message }; }
    }
    await sleep(150);
  });
  if (audioJobs.size) console.log(`🎧 ${audioFile.size} résumés audio (${aNew} nouveaux, ${aUpd} mis à jour, ${aKo} indisponibles)`);

  // ---- Catalogue
  const items = [];
  for (const it of found.values()) {
    const file = it.file || knownFile(it);
    if (!file || !fs.existsSync(gpxPath(file))) continue;
    it.outings = [...new Set(it.outings)].sort().reverse();
    const audio = (it.audio || []).filter((a) => audioFile.has(a.key)).map((a) => ({ ...a, file: audioFile.get(a.key) }));
    const { front, ...rest } = it;
    items.push({ ...rest, audio: audio.length ? audio : null, file });
  }
  items.sort((a, b) => b.date.localeCompare(a.date));

  // La date du catalogue ne bouge que s'il y a du nouveau : pas de commit inutile toutes les heures.
  const changed = updated || aNew || aUpd || removed || JSON.stringify(items) !== JSON.stringify(catalog.items);
  const now = new Date().toISOString();
  writeJSON(CATALOG_FILE, { generatedAt: changed || !catalog.generatedAt ? now : catalog.generatedAt, source: BLOG, items });
  writeJSON(FAILED_FILE, failed);
  writeJSON(LAST_CHECK_FILE, { checkedAt: now });
  console.log(`📚 Catalogue : ${items.length} randos du blog → ${path.relative(process.cwd(), CATALOG_FILE)}${changed ? '' : ' (aucun changement)'}`);
  const unavailable = Object.keys(failed).length;
  if (unavailable) console.log(`   (${unavailable} liens morts listés dans .cache/blog/failed-downloads.json)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
