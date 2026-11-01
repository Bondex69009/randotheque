#!/usr/bin/env node
// Récupère automatiquement les fichiers GPX publiés sur le blog des Godillots Ailés,
// avec les infos de chaque sortie (nom, date, IBP, animateurs, département...).
//
//   node scripts/scrape-blog.mjs            → met à jour (ne retélécharge que le nouveau)
//   node scripts/scrape-blog.mjs --refresh  → relit tous les articles
//
// Résultat : fichiers dans gpx/blog/ + catalogue data/blog-catalog.json
import fs from 'node:fs';
import path from 'node:path';
import {
  BLOG_GPX_DIR, CACHE_DIR, DATA_DIR, decodeEntities, fetchWithRetry, pool,
  readJSON, slugify, writeJSON, sleep,
} from './lib/util.mjs';

const BLOG = 'https://godillotsailes.blogspot.com';
const REFRESH = process.argv.includes('--refresh');
const POST_CACHE = path.join(CACHE_DIR, 'blog', 'posts');
const CATALOG_FILE = path.join(DATA_DIR, 'blog-catalog.json');
const FAILED_FILE = path.join(CACHE_DIR, 'blog', 'failed-downloads.json');

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

async function download(item, usedNames) {
  const res = await fetchWithRetry(item.downloadUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!looksLikeGpx(buf)) throw new Error('le fichier reçu n\'est pas un GPX (lien privé ou supprimé ?)');
  let base = `${item.date}_${slugify(item.name) || 'rando'}`;
  let name = `${base}.gpx`;
  for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${base}-${n}.gpx`;
  usedNames.add(name.toLowerCase());
  fs.mkdirSync(BLOG_GPX_DIR, { recursive: true });
  fs.writeFileSync(path.join(BLOG_GPX_DIR, name), buf);
  return name;
}

// ---------------------------------------------------------------- Programme principal
async function main() {
  console.log('📡 Lecture du flux du blog…');
  const posts = await listPosts();
  console.log(`   ${posts.length} articles trouvés`);

  const catalog = readJSON(CATALOG_FILE, { generatedAt: null, items: [] });
  const byKey = new Map(catalog.items.map((it) => [it.key, it]));
  const failed = readJSON(FAILED_FILE, {});

  console.log('📖 Analyse des articles…');
  let done = 0;
  const parsed = await pool(posts, 6, async (post) => {
    try {
      const html = await getPostHtml(post);
      const items = parsePost(post, html);
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
    const prev = found.get(item.key);
    if (!prev) { found.set(item.key, { ...item, outings: [item.date] }); continue; }
    prev.outings.push(item.date);
    // On garde les infos de l'article le plus récent, en complétant ce qui manque.
    const [recent, old] = item.date > prev.date ? [item, prev] : [prev, item];
    const merged = { ...old, ...Object.fromEntries(Object.entries(recent).filter(([, v]) => v != null)) };
    merged.outings = prev.outings;
    found.set(item.key, merged);
  }
  console.log(`   ${found.size} liens GPX distincts`);
  if (process.argv.includes('--dry')) {
    writeJSON(path.join(CACHE_DIR, 'blog', 'dry-run.json'), [...found.values()]);
    console.log('   (--dry : aperçu écrit dans .cache/blog/dry-run.json, rien téléchargé)');
    return;
  }

  const usedNames = new Set(fs.existsSync(BLOG_GPX_DIR) ? fs.readdirSync(BLOG_GPX_DIR).map((f) => f.toLowerCase()) : []);
  const todo = [...found.values()].filter((it) => {
    const known = byKey.get(it.key);
    return !(known && known.file && fs.existsSync(path.join(BLOG_GPX_DIR, known.file)));
  }).filter((it) => REFRESH || !failed[it.key]);

  console.log(`⬇️  Téléchargement de ${todo.length} nouveaux GPX…`);
  let ok = 0, ko = 0;
  await pool(todo, 4, async (it) => {
    try {
      it.file = await download(it, usedNames);
      ok++;
      delete failed[it.key];
    } catch (e) {
      ko++;
      failed[it.key] = { url: it.sourceUrl, post: it.post.url, error: e.message };
    }
    await sleep(150);
  });
  console.log(`   ✅ ${ok} téléchargés, ❌ ${ko} indisponibles`);

  const items = [];
  for (const it of found.values()) {
    const known = byKey.get(it.key);
    const file = it.file || (known && known.file);
    if (!file || !fs.existsSync(path.join(BLOG_GPX_DIR, file))) continue;
    it.outings = [...new Set(it.outings)].sort().reverse();
    items.push({ ...it, file });
  }
  items.sort((a, b) => b.date.localeCompare(a.date));
  writeJSON(CATALOG_FILE, { generatedAt: new Date().toISOString(), source: BLOG, items });
  writeJSON(FAILED_FILE, failed);
  console.log(`📚 Catalogue : ${items.length} randos du blog → ${path.relative(process.cwd(), CATALOG_FILE)}`);
  const unavailable = Object.keys(failed).length;
  if (unavailable) console.log(`   (${unavailable} liens morts listés dans .cache/blog/failed-downloads.json)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
