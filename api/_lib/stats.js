// Game stats, kept in Postgres (the same Neon database as the users): one row per finished game and one row per player in it.
// They used to live inside the room (gone with the room after 6 hours, only the last 10 games and 30 players). Now nothing expires:
// the room's table and recent games come from here, and so do a player's totals across every room. Players are told apart by name,
// as before. Without the database (local runs, tests) a plain in-memory list does the same job.
import { dbQuery, dbIsMemory } from './users.js';

const mem = { games: [], seq: 1 };
const key = (n) => String(n).trim().toLowerCase();

/** One finished game: { room, mode, gameNo, at, players, ranking, loser, notice, winner, points } */
export async function saveGame(g) {
  const names = [...new Set(g.players)];
  const rows = names.map((name) => ({ name, won: g.ranking[0] === name, lost: g.loser === name, points: g.ranking[0] === name ? g.points || 0 : 0 }));
  if (dbIsMemory()) {
    mem.games.push({ id: mem.seq++, room: g.room, mode: g.mode, gameNo: g.gameNo, at: g.at, players: names, ranking: g.ranking, loser: g.loser || null, notice: g.notice || null, rows });
    return;
  }
  await dbQuery(
    `WITH g AS (INSERT INTO growx_games (room, mode, game_no, played_at, players, ranking, loser, notice, winner, round_points)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5::jsonb, $6::jsonb, $7, $8, $9, $10) RETURNING id)
     INSERT INTO growx_game_players (game_id, name, name_key, won, lost, points)
     SELECT g.id, t.n, lower(btrim(t.n)), t.w, t.l, t.p FROM g, unnest($11::text[], $12::bool[], $13::bool[], $14::int[]) AS t(n, w, l, p)`,
    [g.room, g.mode, g.gameNo, g.at, JSON.stringify(names), JSON.stringify(g.ranking), g.loser || null, g.notice || null, g.ranking[0] || null, g.points || 0,
      rows.map((r) => r.name), rows.map((r) => r.won), rows.map((r) => r.lost), rows.map((r) => r.points)],
  );
}

const byRank = (a, c) => c.wins - a.wins || (c.points || 0) - (a.points || 0) || a.losses - c.losses || a.name.localeCompare(c.name);

/** This room's table (up to 30 players) and its last 10 games, for one kind of game. */
export async function roomStats(room, mode) {
  if (dbIsMemory()) {
    const games = mem.games.filter((g) => g.room === room && g.mode === mode);
    const t = {};
    for (const g of games) for (const r of g.rows) {
      const x = t[r.name] || (t[r.name] = { name: r.name, played: 0, wins: 0, losses: 0, points: 0 });
      x.played++; x.wins += r.won ? 1 : 0; x.losses += r.lost ? 1 : 0; x.points += r.points;
    }
    return { table: Object.values(t).sort(byRank).slice(0, 30), history: games.slice(-10).reverse().map((g) => ({ no: g.gameNo, at: g.at, players: g.players, ranking: g.ranking, loser: g.loser, notice: g.notice })) };
  }
  const table = await dbQuery(
    `SELECT max(p.name) AS name, count(*)::int AS played, sum(p.won::int)::int AS wins, sum(p.lost::int)::int AS losses, sum(p.points)::int AS points
     FROM growx_game_players p JOIN growx_games g ON g.id = p.game_id WHERE g.room = $1 AND g.mode = $2 GROUP BY p.name_key`, [room, mode]);
  const history = await dbQuery(
    'SELECT game_no, extract(epoch FROM played_at) * 1000 AS at, players, ranking, loser, notice FROM growx_games WHERE room = $1 AND mode = $2 ORDER BY played_at DESC, id DESC LIMIT 10', [room, mode]);
  return {
    table: table.sort(byRank).slice(0, 30),
    history: history.map((h) => ({ no: h.game_no, at: Math.round(Number(h.at)), players: h.players, ranking: h.ranking, loser: h.loser, notice: h.notice })),
  };
}

/** One player's totals across every room for one kind of game: played, wins, losses, points, current and best winning streak. */
export async function playerTotals(name, mode) {
  let results; // oldest first: { won, lost, points }
  if (dbIsMemory()) {
    results = mem.games.filter((g) => g.mode === mode).flatMap((g) => g.rows.filter((r) => key(r.name) === key(name)));
  } else {
    results = await dbQuery(
      `SELECT p.won, p.lost, p.points FROM growx_game_players p JOIN growx_games g ON g.id = p.game_id
       WHERE p.name_key = $1 AND g.mode = $2 ORDER BY g.played_at, g.id`, [key(name), mode]);
  }
  const t = { played: 0, wins: 0, losses: 0, points: 0, streak: 0, best: 0 };
  for (const r of results) {
    t.played++; t.losses += r.lost ? 1 : 0; t.points += r.points || 0;
    if (r.won) { t.wins++; t.streak++; t.best = Math.max(t.best, t.streak); } else t.streak = 0;
  }
  return t;
}

/** Test helper. */
export const _memGames = () => mem.games;
