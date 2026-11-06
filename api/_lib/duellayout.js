// Where each player likes their 3D duel buttons. Saved in the database (one row per player name), copied into Redis when a duel starts
// so the match never waits for Postgres: Redis first, a miss reads the database once and fills Redis.
import { dbQuery, dbIsMemory } from './users.js';
import { kvGet, kvSet } from './dbqueue.js';

const mem = new Map();
const key = (n) => String(n).trim().toLowerCase();
const rkey = (n) => `growx:duel:layout:${key(n)}`;
const TTL = 24 * 60 * 60;
const IDS = ['duelFire', 'duelFireL', 'duelAim', 'duelJump', 'duelCrouch', 'duelProne', 'duelReload', 'duelSwitch', 'duelScopeBtn'];

/** A layout is { land?: { <button id>: [x, y] }, port?: { … } }: x and y are the button's centre as a fraction (0 to 1) of the screen. Returns a clean copy, or null. */
export function cleanLayout(v) {
  if (!v || typeof v !== 'object') return null;
  const out = {};
  for (const o of ['land', 'port']) {
    if (!v[o] || typeof v[o] !== 'object') continue;
    const m = {};
    for (const id of IDS) {
      const p = v[o][id];
      if (Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) m[id] = [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];
    }
    if (Object.keys(m).length) out[o] = m;
  }
  return out;
}

async function dbGet(name) {
  if (dbIsMemory()) return mem.get(key(name)) || null;
  const r = await dbQuery('SELECT layout FROM growx_duel_layout WHERE name_key = $1', [key(name)]);
  return r[0] ? r[0].layout : null;
}

/** The saved layout ({} when the player never changed it): Redis first, then the database (which fills Redis). */
export async function getLayout(name) {
  const hit = await kvGet(rkey(name));
  if (hit) return hit;
  const l = (await dbGet(name)) || {};
  await kvSet(rkey(name), l, TTL);
  return l;
}

/** Saves to the database, then to Redis. An empty layout means "back to the default". */
export async function saveLayout(name, layout) {
  const l = cleanLayout(layout);
  if (!l) return null;
  if (dbIsMemory()) mem.set(key(name), l);
  else {
    await dbQuery(
      `INSERT INTO growx_duel_layout (name_key, name, layout, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (name_key) DO UPDATE SET name = EXCLUDED.name, layout = EXCLUDED.layout, updated_at = now()`, [key(name), name, JSON.stringify(l)]);
  }
  await kvSet(rkey(name), l, TTL);
  return l;
}

/** A duel is starting: have both players' layouts in Redis. */
export async function warmLayouts(names) {
  await Promise.all([...new Set(names.map(key))].slice(0, 6).map((n) => getLayout(n)));
}
