#!/usr/bin/env node
// Décide si la tâche programmée doit synchroniser le blog maintenant.
// Affiche « true » ou « false ».
//
// GitHub ne garantit pas ses tâches programmées (retards, voire abandons à l'heure pile).
// On programme donc plusieurs créneaux (4h07, 5h07, 6h07, 7h37 heure de Paris) et
// le premier qui passe fait la mise à jour du jour ; les suivants ne font rien.
//
// Règle pour un déclenchement programmé : il est au moins 4h à Paris, et la dernière
// synchronisation (data/blog-catalog.json) date d'avant 4h aujourd'hui (heure de Paris).
// Tout autre déclenchement (bouton « Run workflow », envoi de code) synchronise toujours.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 4;

// Date et heure murales à Paris, comparables entre elles : « 2026-11-02 04 »
function parisStamp(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

export function shouldSync({ event, now, lastSync }) {
  if (event !== 'schedule') return true;
  const n = parisStamp(now);
  if (n.hour < HOUR) return false;           // trop tôt (créneau d'été vu en hiver)
  if (!lastSync) return true;
  const l = parisStamp(lastSync);
  return l.day < n.day || (l.day === n.day && l.hour < HOUR);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let lastSync = null;
  try {
    const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'blog-catalog.json'), 'utf8'));
    if (cat.generatedAt) lastSync = new Date(cat.generatedAt);
  } catch { /* pas de catalogue : on synchronise */ }
  const now = process.env.NOW ? new Date(process.env.NOW) : new Date();
  const event = process.env.GITHUB_EVENT_NAME || 'manual';
  const go = shouldSync({ event, now, lastSync });
  console.error(`Déclenchement : ${event} | maintenant (Paris) : ${JSON.stringify(parisStamp(now))} | dernière synchro : ${lastSync ? lastSync.toISOString() : 'aucune'} → ${go ? 'on synchronise' : 'rien à faire'}`);
  console.log(go ? 'true' : 'false');
}
