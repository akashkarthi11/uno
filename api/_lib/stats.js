// Game stats, kept in Postgres (the same Neon database as the users): one row per finished game and one row per player in it.
// Redis comes first (see dbqueue.js): a finished game is applied to the cached tables at once and queued for the database;
// the stats window reads the cached tables (one or two Redis reads), and only a miss goes to Postgres, once, to fill the cache.
// Nothing expires in the database: the room's table and recent games come from there, and so do a player's totals across every room.
// Players are told apart by name. Without the database (local runs, tests) a plain in-memory list plays the database's part.
import { dbQuery, dbIsMemory } from './users.js';
import { kvGet, kvSet, enqueue, flush, registerJob } from './dbqueue.js';

const mem = { games: [], seq: 1 };
const key = (n) => String(n).trim().toLowerCase();
const TTL = 60 * 60; // an hour: a cached table that drifted (two games ending in the same instant) is rebuilt from the database after that

const rowsOf = (g, names) => names.map((name) => ({ name, won: g.ranking[0] === name, lost: g.loser === name, points: g.ranking[0] === name ? g.points || 0 : 0 }));

/* ---- the database ---- */

/** One finished game: { room, mode, gameNo, at, players, ranking, loser, notice, winner, points }. Safe to run twice (jobId). */
async function dbSaveGame(g, jobId) {
  const names = [...new Set(g.players)];
  const rows = rowsOf(g, names);
  if (dbIsMemory()) {
    if (mem.games.some((x) => x.jobId === jobId)) return;
    mem.games.push({ id: mem.seq++, jobId, room: g.room, mode: g.mode, gameNo: g.gameNo, at: g.at, players: names, ranking: g.ranking, loser: g.loser || null, notice: g.notice || null, rows });
    return;
  }
  await dbQuery(
    `WITH g AS (INSERT INTO growx_games (room, mode, game_no, played_at, players, ranking, loser, notice, winner, round_points, job_id)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5::jsonb, $6::jsonb, $7, $8, $9, $10, $15) ON CONFLICT (job_id) WHERE job_id IS NOT NULL DO NOTHING RETURNING id)
     INSERT INTO growx_game_players (game_id, name, name_key, won, lost, points)
     SELECT g.id, t.n, lower(btrim(t.n)), t.w, t.l, t.p FROM g, unnest($11::text[], $12::bool[], $13::bool[], $14::int[]) AS t(n, w, l, p)`,
    [g.room, g.mode, g.gameNo, g.at, JSON.stringify(names), JSON.stringify(g.ranking), g.loser || null, g.notice || null, g.ranking[0] || null, g.points || 0,
      rows.map((r) => r.name), rows.map((r) => r.won), rows.map((r) => r.lost), rows.map((r) => r.points), jobId],
  );
}
registerJob('saveGame', (d, job) => dbSaveGame(d.g, job.id));

function add(p, r) {
  const x = p[key(r.name)] || (p[key(r.name)] = { name: r.name, played: 0, wins: 0, losses: 0, points: 0 });
  x.played++; x.wins += r.won ? 1 : 0; x.losses += r.lost ? 1 : 0; x.points += r.points || 0;
}

/** Every player of one room and kind of game, and the last 10 games, straight from the database. */
async function dbRoom(room, mode) {
  const p = {};
  let history;
  if (dbIsMemory()) {
    const games = mem.games.filter((g) => g.room === room && g.mode === mode);
    for (const g of games) for (const r of g.rows) add(p, r);
    history = games.slice(-10).reverse().map((g) => ({ no: g.gameNo, at: g.at, players: g.players, ranking: g.ranking, loser: g.loser, notice: g.notice }));
  } else {
    const [table, h] = await Promise.all([
      dbQuery(
        `SELECT max(p.name) AS name, count(*)::int AS played, sum(p.won::int)::int AS wins, sum(p.lost::int)::int AS losses, sum(p.points)::int AS points
         FROM growx_game_players p JOIN growx_games g ON g.id = p.game_id WHERE g.room = $1 AND g.mode = $2 GROUP BY p.name_key`, [room, mode]),
      dbQuery(
        'SELECT game_no, extract(epoch FROM played_at) * 1000 AS at, players, ranking, loser, notice FROM growx_games WHERE room = $1 AND mode = $2 ORDER BY played_at DESC, id DESC LIMIT 10', [room, mode]),
    ]);
    for (const t of table) p[key(t.name)] = { name: t.name, played: t.played, wins: t.wins, losses: t.losses, points: t.points };
    history = h.map((x) => ({ no: x.game_no, at: Math.round(Number(x.at)), players: x.players, ranking: x.ranking, loser: x.loser, notice: x.notice }));
  }
  return { p, h: history };
}

/** One player's results in order, oldest first, straight from the database. */
async function dbResults(name, mode) {
  if (dbIsMemory()) return mem.games.filter((g) => g.mode === mode).flatMap((g) => g.rows.filter((r) => key(r.name) === key(name)));
  return dbQuery(
    `SELECT p.won, p.lost, p.points FROM growx_game_players p JOIN growx_games g ON g.id = p.game_id
     WHERE p.name_key = $1 AND g.mode = $2 ORDER BY g.played_at, g.id`, [key(name), mode]);
}
function bumpTotals(t, r) {
  t.played++; t.losses += r.lost ? 1 : 0; t.points += r.points || 0;
  if (r.won) { t.wins++; t.streak++; t.best = Math.max(t.best, t.streak); } else t.streak = 0;
}

/* ---- Redis first ---- */

const roomKey = (room, mode) => `growx:rs:${room}:${mode}`;
const totalsKey = (name, mode) => `growx:pt:${key(name)}:${mode}`;

/** A finished game: queued for the database, and added to the cached tables that exist. Never waits for Postgres. */
export async function saveGame(g) {
  const names = [...new Set(g.players)];
  const rows = rowsOf(g, names);
  await enqueue('saveGame', { g }, { inline: dbIsMemory() });
  const tasks = [(async () => {
    const room = await kvGet(roomKey(g.room, g.mode));
    if (!room) return;
    for (const r of rows) add(room.p, r);
    room.h = [{ no: g.gameNo, at: g.at, players: names, ranking: g.ranking, loser: g.loser || null, notice: g.notice || null }, ...room.h].slice(0, 10);
    await kvSet(roomKey(g.room, g.mode), room, TTL);
  })()];
  for (const r of rows) {
    tasks.push((async () => {
      const t = await kvGet(totalsKey(r.name, g.mode));
      if (t) { bumpTotals(t, r); await kvSet(totalsKey(r.name, g.mode), t, TTL); }
    })());
  }
  await Promise.all(tasks);
}

const byRank = (a, c) => c.wins - a.wins || (c.points || 0) - (a.points || 0) || a.losses - c.losses || a.name.localeCompare(c.name);

/** This room's table (up to 30 players) and its last 10 games, for one kind of game. */
export async function roomStats(room, mode) {
  let v = await kvGet(roomKey(room, mode));
  if (!v) {
    await flush(); // the database must hold every queued game before it is read
    v = await dbRoom(room, mode);
    await kvSet(roomKey(room, mode), v, TTL);
  }
  return { table: Object.values(v.p).sort(byRank).slice(0, 30), history: v.h };
}

/** One player's totals across every room for one kind of game: played, wins, losses, points, current and best winning streak. */
export async function playerTotals(name, mode) {
  const cached = await kvGet(totalsKey(name, mode));
  if (cached) return cached;
  await flush();
  const t = { played: 0, wins: 0, losses: 0, points: 0, streak: 0, best: 0 };
  for (const r of await dbResults(name, mode)) bumpTotals(t, r);
  await kvSet(totalsKey(name, mode), t, TTL);
  return t;
}

/** Test helper. */
export const _memGames = () => mem.games;
