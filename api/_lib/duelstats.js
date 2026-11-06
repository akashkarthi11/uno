// The 3D duel's total score, kept in Redis (no schema change). Each browser reports its own finished match; the admin reads the table.
// A duel is refereed by the two browsers (friends-only), so these numbers are self-reported: good for a friendly scoreboard, not for ranking.
import { kvGet, kvSet } from './dbqueue.js';

const KEY = 'growx:duel:totals';
const TTL = 365 * 24 * 60 * 60; // refreshed on every result
const WIN = 5; // first to 5 kills, as in public/duel.js
const key = (n) => String(n).trim().toLowerCase();

/** One player's finished match: kills and deaths (one of them is 5). `id` makes a retry count once. Returns false for a repeat or an impossible score. */
export async function recordDuel(name, id, kills, deaths) {
  if (!/^[a-z0-9]{6,24}$/.test(String(id)) || !Number.isInteger(kills) || !Number.isInteger(deaths)) return false;
  if (kills < 0 || deaths < 0 || kills > WIN || deaths > WIN || (kills === WIN) === (deaths === WIN)) return false;
  if (!(await kvSet(`growx:duel:seen:${key(name)}:${id}`, 1, 24 * 60 * 60, { nx: true }))) return false;
  const all = (await kvGet(KEY)) || {};
  const row = all[key(name)] || { name, played: 0, wins: 0, losses: 0, kills: 0, deaths: 0 };
  row.name = name;
  row.played++; row.kills += kills; row.deaths += deaths;
  if (kills === WIN) row.wins++; else row.losses++;
  all[key(name)] = row;
  await kvSet(KEY, all, TTL);
  return true;
}

/** Every player's totals, best first (wins, then kills). */
export async function duelTotals() {
  const all = (await kvGet(KEY)) || {};
  return Object.values(all).sort((a, c) => c.wins - a.wins || c.kills - a.kills || a.deaths - c.deaths || a.name.localeCompare(c.name)).slice(0, 50);
}
