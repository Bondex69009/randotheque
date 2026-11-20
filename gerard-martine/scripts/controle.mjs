#!/usr/bin/env node
// Contrôle qualité des données (même fichier dans les deux Randothèques), lancé à chaque mise à jour
// horaire juste après « npm run build ». Rien n'est corrigé ni bloqué : le script dresse la liste des
// points à vérifier dans data/controle.json, affichée dans l'espace stats du site (« Contrôle des données »),
// et en résumé dans le journal de la mise à jour GitHub.
//
// Vérifie : GPX ignorés par la génération, liens GPX morts sur le blog, traces sans altitude, sauts dans
// la trace (coupure du GPS), distances ou durées anormales, IBP publié très loin de l'estimation,
// doublons, commune introuvable, dates suspectes, randos du blog sans animateur ni IBP.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR, CACHE_DIR, readJSON, writeJSON } from './lib/util.mjs';
import { parseGpx, flatten, haversine } from './lib/gpx.mjs';

const JUMP_M = 800;          // deux points consécutifs plus éloignés : coupure ou saut du GPS
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const payload = readJSON(path.join(DATA_DIR, 'randos.json'), null);
if (!payload || !Array.isArray(payload.randos)) {
  console.error('data/randos.json manquant : lancez d\'abord « npm run build ».');
  process.exit(1);
}
const admin = readJSON(path.join(DATA_DIR, 'admin.json'), { errors: [] });
const failed = readJSON(path.join(CACHE_DIR, 'blog', 'failed-downloads.json'), {});
const randos = payload.randos;
const coef = payload.ibpModel && payload.ibpModel.coef;
// Écart entre l'IBP publié et l'estimation au-delà duquel on signale : 12 points, ou 3 fois l'écart moyen
// de l'estimation sur ce site si elle est moins précise (randos de montagne de Gérard & Martine)
const IBP_GAP = Math.max(12, 3 * ((payload.ibpModel && payload.ibpModel.mae) || 4));
const problems = [];
const add = (level, code, r, detail) => problems.push({
  level, code,
  rando: r ? { id: r.id, name: r.name, date: r.date, blog: r.blog ? r.blog.url : null, file: r.file } : null,
  detail,
});

// 1. Fichiers GPX que la génération n'a pas pu lire
for (const e of admin.errors || []) add('erreur', 'gpx-illisible', null, e);

// 2. Liens GPX du blog qui ne donnent pas de fichier (privé, supprimé, Dropbox fermé…)
for (const f of Object.values(failed)) {
  add(/20(2[4-9]|3\d)\//.test(f.post || '') ? 'erreur' : 'info', 'lien-mort', null,
    `${f.error || 'téléchargement impossible'} : ${f.url} (article ${f.post})`);
}

// 3. Contrôles rando par rando
const seen = new Map();
for (const r of randos) {
  if (r.eleSource == null) add('attention', 'sans-altitude', r, 'Aucune altitude (ni dans le GPX, ni auprès de l\'IGN) : dénivelés et IBP inconnus.');
  else if (r.eleSource === 'ign') add('info', 'altitude-ign', r, 'Altitudes absentes du GPX, complétées par le service de l\'IGN.');

  if (r.distanceKm < 2) add('attention', 'trop-court', r, `Seulement ${r.distanceKm} km : trace incomplète ?`);
  if (r.distanceKm > 45) add('attention', 'trop-long', r, `${r.distanceKm} km : plusieurs jours dans un même fichier ?`);
  if (r.points < 60) add('attention', 'peu-de-points', r, `Trace de ${r.points} points seulement : tracé approximatif.`);
  if (r.dplus != null && r.distanceKm > 3 && r.dplus / r.distanceKm > 180) {
    add('attention', 'denivele-suspect', r, `${r.dplus} m de D+ pour ${r.distanceKm} km : altitudes bruitées ?`);
  }

  // IBP publié très différent de ce que donneraient la distance et les dénivelés
  if (coef && r.ibpSource === 'blog' && r.dplus != null) {
    const est = coef[0] + coef[1] * r.distanceKm + coef[2] * (r.dplus / 100) + coef[3] * (r.dminus / 100);
    if (Math.abs(r.ibp - est) > IBP_GAP) {
      add('attention', 'ibp-ecart', r, `IBP publié ${r.ibp}, estimation ${Math.round(est)} : faute de frappe, ou trace qui ne correspond pas à la sortie ?`);
    }
  }

  if (!r.commune) add('info', 'sans-commune', r, `Commune du départ introuvable (${r.start.join(', ')}).`);
  if (r.date > addDays(today, 90)) add('attention', 'date-future', r, `Date au ${r.date} : plus de 3 mois à l'avance.`);
  if (r.date < '1990-01-01') add('attention', 'date-ancienne', r, `Date au ${r.date} : date du fichier plutôt que de la sortie ?`);
  if (r.source === 'blog' && !r.ibp) add('info', 'sans-ibp', r, 'Pas d\'IBP sur le blog.');

  // Doublons : même jour et même distance (au 100 m près)
  // (même nom hors parenthèses, comme « (Reco) » et « (Rando) » d'un même article : simple info)
  const key = `${r.date}|${Math.round(r.distanceKm * 10)}`;
  const base = (x) => x.name.replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();
  if (seen.has(key)) {
    const o = seen.get(key);
    if (base(o) === base(r)) add('info', 'doublon', r, `Même trace que « ${o.name} » (même jour) : deux parcours du même article ?`);
    else add('attention', 'doublon', r, `Même date et même distance que « ${o.name} » : publiée deux fois ?`);
  } else seen.set(key, r);

  // Sauts dans la trace d'origine (GPS coupé, morceaux de traces différentes)
  try {
    const pts = flatten(parseGpx(fs.readFileSync(path.join(ROOT, r.file), 'utf8')).segments);
    let worst = 0, at = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = haversine(pts[i - 1], pts[i]);
      if (d > worst) { worst = d; at = pts[i - 1].d; }
    }
    if (worst > JUMP_M) {
      add(worst > 3000 ? 'attention' : 'info', 'saut-trace', r,
        `Saut de ${(worst / 1000).toFixed(1).replace('.', ',')} km d'un point au suivant vers le km ${(at / 1000).toFixed(1).replace('.', ',')} : GPS coupé ?`);
    }
  } catch (e) {
    add('erreur', 'gpx-illisible', r, `Fichier GPX illisible : ${e.message}`);
  }
}

const ORDER = { erreur: 0, attention: 1, info: 2 };
problems.sort((a, b) => ORDER[a.level] - ORDER[b.level] || (b.rando?.date || '').localeCompare(a.rando?.date || ''));
const counts = { erreur: 0, attention: 0, info: 0 };
for (const p of problems) counts[p.level]++;
const LABELS = {
  'gpx-illisible': 'GPX illisible', 'lien-mort': 'Lien GPX mort sur le blog', 'sans-altitude': 'Trace sans altitude',
  'altitude-ign': 'Altitudes ajoutées par l\'IGN', 'trop-court': 'Rando très courte', 'trop-long': 'Rando très longue',
  'peu-de-points': 'Trace très simplifiée', 'denivele-suspect': 'Dénivelé suspect', 'ibp-ecart': 'IBP à vérifier',
  'sans-commune': 'Commune introuvable', 'date-future': 'Date lointaine', 'date-ancienne': 'Date douteuse',
  'sans-ibp': 'IBP manquant', doublon: 'Doublon possible', 'saut-trace': 'Saut dans la trace',
};
writeJSON(path.join(DATA_DIR, 'controle.json'), {
  generatedAt: new Date().toISOString(), randos: randos.length, counts, labels: LABELS, problems,
}, false);

console.log(`🔎 Contrôle des données : ${randos.length} randos, ${counts.erreur} erreur(s), ${counts.attention} point(s) à vérifier, ${counts.info} info(s) → data/controle.json`);
const byCode = {};
for (const p of problems) byCode[p.code] = (byCode[p.code] || 0) + 1;
for (const [code, n] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) console.log(`   - ${LABELS[code] || code} : ${n}`);
// Dans GitHub Actions : un avertissement par erreur (10 au plus), visible sur la page de la mise à jour
if (process.env.GITHUB_ACTIONS) {
  for (const p of problems.filter((x) => x.level === 'erreur').slice(0, 10)) {
    console.log(`::warning title=${path.basename(ROOT)} : ${LABELS[p.code]}::${p.rando ? `${p.rando.name} (${p.rando.date}) : ` : ''}${p.detail}`);
  }
}
