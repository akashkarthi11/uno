// Stats live in the database: every finished game is saved, the Stats window reads it, and a player's totals span every room.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GAME_USERS_MEMORY = '1';
process.env.GAME_ADMIN_ANY_NAME = '1';
process.env.GAME_DEAL = 'off'; // no dealing animation
const G = await import('../api/_lib/game.js');
const { default: handler } = await import('../api/game.js'); // registers the recorder that writes finished games
const { roomStats, playerTotals, _memGames } = await import('../api/_lib/stats.js');

const card = (id, color, value) => ({ id, color, value });
function finishWith(s, winner, now) {
  s.cur = s.seats.indexOf(winner.id);
  s.color = 'red';
  s.discard.push(card(9100 + (s.gameNo || 0), 'red', '3'));
  winner.hand = [card(9200 + s.gameNo, 'red', '8')];
  winner.saidUno = false;
  G.act(s, winner, { op: 'play', cardId: 9200 + s.gameNo }, now);
}
const call = (body) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
  handler({ method: 'POST', body }, res);
});

test('every finished game is saved with its players; the room table and last 10 come from the saved games', async () => {
  const s = G.newRoom('sx1');
  const a = G.join(s, { name: 'Ann', admin: true }, 1000);
  const b = G.join(s, { name: 'Bob', admin: false }, 1000);
  for (let i = 1; i <= 12; i++) {
    G.act(s, a, { op: 'start' }, 1000);
    finishWith(s, i % 4 === 0 ? b : a, 1000); // Ann wins 9, Bob wins 3
  }
  assert.equal(_memGames().filter((g) => g.room === 'sx1').length, 12, 'all 12 are kept, not only the last 10');
  const r = await roomStats('sx1', 'public');
  assert.equal(r.history.length, 10, 'the window still shows the last 10');
  assert.equal(r.history[0].no, 12, 'newest first');
  const row = (n) => { const { points, ...rest } = r.table.find((x) => x.name === n); assert.ok(points >= 0); return rest; };
  assert.deepEqual(row('Ann'), { name: 'Ann', played: 12, wins: 9, losses: 3 });
  assert.deepEqual(row('Bob'), { name: 'Bob', played: 12, wins: 3, losses: 9 });
  assert.equal(r.table[0].name, 'Ann', 'most wins first');
  assert.deepEqual((await roomStats('another-room', 'public')).table, [], 'rooms are kept apart');
  assert.deepEqual((await roomStats('sx1', 'private')).table, [], 'and so are public and private games');
});

test('a player\'s totals span every room, with the current and the best winning streak', async () => {
  const mk = (room, wins) => {
    const s = G.newRoom(room);
    const a = G.join(s, { name: 'Streaky', admin: true }, 1000);
    const b = G.join(s, { name: 'Other', admin: false }, 1000);
    for (const w of wins) { G.act(s, a, { op: 'start' }, 1000); finishWith(s, w ? a : b, 1000); }
  };
  mk('sx2', [true, true, true, false]); // best streak 3, then a loss
  mk('sx3', [true, true]); // two more wins in another room: the current streak is 2
  const t = await playerTotals('streaky', 'public'); // any letter case
  assert.deepEqual([t.played, t.wins, t.best, t.streak], [6, 5, 3, 2]);
  assert.ok(t.points >= 0);
  assert.equal((await playerTotals('nobody-here', 'public')).played, 0);
});

test('the Stats window gets the saved numbers and the viewer\'s own totals', async () => {
  const sys = await call({ op: 'join', room: 'sx4', name: 'Viewer', password: '110299' });
  assert.equal(sys.code, 200);
  const r = await call({ op: 'stats', room: 'sx4', playerId: sys.body.state.you });
  assert.equal(r.code, 200);
  for (const mode of ['public', 'private']) {
    assert.deepEqual(r.body.stats.modes[mode].mine, { played: 0, wins: 0, losses: 0, points: 0, streak: 0, best: 0 }, mode + ' totals start at zero');
  }
});
