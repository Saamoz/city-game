#!/usr/bin/env node
// Loads a challenge set file (see sagnik-bday.json) into a running Saadventure server through its
// admin API: finds the set by name (or creates it), switches it to point placement, then creates or
// updates each challenge by title. Dry run by default; pass --apply to write.
//
//   node scripts/challenge-sets/import.mjs scripts/challenge-sets/sagnik-bday.json \
//     --base https://adventure.saamoz.com [--apply] [--replace] [--map-id <uuid>] [--token <admin token>]
//
// --replace also deletes challenges in the set that are not in the file.
// --map-id picks the set's map (where pins and areas go); otherwise it reuses the set's map, or the
// first map with "Chicago" in its name.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--') && !isFlagValue(arg));
const base = (flag('--base') ?? 'http://localhost:3000').replace(/\/$/, '') + '/api/v1';
const apply = args.includes('--apply');
const replace = args.includes('--replace');
const token = flag('--token') ?? process.env.ADMIN_TOKEN ?? null;

if (!file) {
  console.error('Usage: node scripts/challenge-sets/import.mjs <file.json> --base <url> [--apply] [--replace] [--map-id <uuid>]');
  process.exit(1);
}

const definition = JSON.parse(await readFile(file, 'utf8'));
console.log(`${apply ? 'Applying' : 'Dry run'}: ${definition.items.length} challenges → ${base}`);

const { challengeSets } = await api('GET', '/challenge-sets');
const matches = challengeSets.filter((set) => set.name.toLowerCase().includes(definition.setName.toLowerCase()));
if (matches.length > 1) {
  console.error('More than one challenge set matches "' + definition.setName + '": ' + matches.map((set) => set.name).join(', '));
  process.exit(1);
}

let set = matches[0] ?? null;
if (!set) {
  console.log(`No set named like "${definition.setName}" yet; it will be created.`);
  if (apply) set = (await api('POST', '/challenge-sets', { name: definition.setName, locationMode: 'point' })).challengeSet;
} else {
  console.log(`Set: ${set.name} (${set.id}), placement ${set.locationMode}`);
}

const existing = set ? (await api('GET', `/challenge-sets/${set.id}/items`)).items : [];
if (set && set.locationMode !== 'point') {
  console.log('Switching the set to point placement (pins, areas and anywhere challenges).');
  if (apply) set = (await api('PATCH', `/challenge-sets/${set.id}`, { locationMode: 'point' })).challengeSet;
}

const needsMap = definition.items.some((item) => item.where.placement !== 'anywhere');
const mapId = needsMap ? await resolveMapId(existing) : null;
if (set && mapId && set.mapId !== mapId) {
  console.log(`Tying the set to map ${mapId}.`);
  if (apply) set = (await api('PATCH', `/challenge-sets/${set.id}`, { mapId })).challengeSet;
}

const byTitle = new Map(existing.map((item) => [item.title.trim().toLowerCase(), item]));
const seen = new Set();
for (const [index, item] of definition.items.entries()) {
  const payload = buildPayload(item, index, mapId);
  const current = byTitle.get(item.title.trim().toLowerCase());
  seen.add(item.title.trim().toLowerCase());
  console.log(`${current ? 'update' : 'create'}  ${describe(item)}  ${item.title}`);
  if (!apply) continue;
  if (current) await api('PATCH', `/challenge-set-items/${current.id}`, payload);
  else await api('POST', `/challenge-sets/${set.id}/items`, payload);
}

for (const item of existing.filter((entry) => !seen.has(entry.title.trim().toLowerCase()))) {
  console.log(`${replace ? 'delete' : 'keep  '}  (not in file)  ${item.title}`);
  if (apply && replace) await api('DELETE', `/challenge-set-items/${item.id}`);
}

console.log(apply ? 'Done.' : 'Nothing written. Re-run with --apply to save.');

function buildPayload(item, index, sourceMapId) {
  const { where } = item;
  const config = {
    short_description: item.shortDescription,
    ...(item.longDescription ? { long_description: item.longDescription } : {}),
    ...(where.placement === 'pin' ? { point_radius_meters: where.radiusMeters ?? 40 } : {}),
    ...(where.placement === 'anywhere' && where.hint ? { location_hint: where.hint } : {}),
    ...(where.placement === 'area' ? { area: where.area } : {}),
    ...(item.bonuses?.length ? { bonuses: item.bonuses } : {}),
    ...(item.judged ? { judged: true, judging_type: 'pass_fail' } : {}),
  };
  return {
    mapZoneId: null,
    mapPoint: where.placement === 'pin' ? { type: 'Point', coordinates: where.point } : null,
    title: item.title,
    description: item.longDescription ?? item.shortDescription,
    config,
    scoring: { points: item.points ?? 1 },
    difficulty: null,
    sortOrder: index,
    metadata: where.placement === 'anywhere' ? {} : { sourceMapId },
  };
}

async function resolveMapId(items) {
  const explicit = flag('--map-id');
  if (explicit) return explicit;
  const reused = set?.mapId ?? items.map((item) => item.metadata?.sourceMapId).find(Boolean);
  if (reused) return reused;
  const { maps } = await api('GET', '/maps');
  const chicago = maps.find((map) => /chicago/i.test(map.name));
  if (!chicago) {
    console.error('No source map found for the pinned challenges. Pass --map-id. Maps: ' + maps.map((map) => `${map.name} (${map.id})`).join(', '));
    process.exit(1);
  }
  console.log(`Source map for pins: ${chicago.name} (${chicago.id})`);
  return chicago.id;
}

async function api(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      // The server requires one on every write.
      ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function describe(item) {
  const { where } = item;
  const label = where.placement === 'pin' ? `pin ${where.radiusMeters}m` : where.placement === 'area' ? 'area' : 'anywhere';
  return label.padEnd(10);
}

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function isFlagValue(arg) {
  const index = args.indexOf(arg);
  return index > 0 && ['--base', '--map-id', '--token'].includes(args[index - 1]);
}
