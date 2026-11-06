// Redis first, database behind: the queue, the cached accounts and the cached stats (all in memory here).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GAME_USERS_MEMORY = '1';
const Q = await import('../api/_lib/dbqueue.js');
const { saveGame, roomStats, playerTotals, _memGames } = await import('../api/_lib/stats.js');
const U = await import('../api/_lib/users.js');

test('the queue applies jobs oldest first and ends up empty', async () => {
  const seen = [];
  Q.registerJob('t-order', (d) => { seen.push(d.n); });
  for (let n = 1; n <= 5; n++) await Q.enqueue('t-order', { n });
  assert.equal(await Q.queueLength(), 5);
  assert.equal(await Q.drain(), 5);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(await Q.queueLength(), 0);
});

test('a job that fails is kept and retried, nothing behind it is lost', async () => {
  let calls = 0;
  const seen = [];
  Q.registerJob('t-flaky', () => { if (++calls < 3) throw new Error('database down'); seen.push('flaky'); });
  Q.registerJob('t-after', () => { seen.push('after'); });
  await Q.enqueue('t-flaky', {});
  await Q.enqueue('t-after', {});
  await Q.drain(); // round 1: the first job fails, the round stops
  assert.deepEqual(seen, []);
  assert.equal(await Q.queueLength(), 2);
  await Q.drain();
  await Q.drain();
  assert.equal(await Q.queueLength(), 0);
  assert.deepEqual(seen.sort(), ['after', 'flaky']);
});

test('a job that never works ends on the dead list, not in the void', async () => {
  Q.registerJob('t-bad', () => { throw new Error('constraint'); });
  const before = await Q.deadLength();
  await Q.enqueue('t-bad', {});
  for (let i = 0; i < 40; i++) await Q.drain();
  assert.equal(await Q.deadLength(), before + 1);
  assert.equal(await Q.queueLength(), 0);
});

test('only one drain runs at a time', async () => {
  let inside = 0;
  let most = 0;
  Q.registerJob('t-slow', async () => { inside++; most = Math.max(most, inside); await new Promise((r) => setTimeout(r, 20)); inside--; });
  for (let n = 0; n < 4; n++) await Q.enqueue('t-slow', {});
  await Promise.all([Q.drain(), Q.drain(), Q.drain()]);
  await Q.drain();
  assert.equal(most, 1);
  assert.equal(await Q.queueLength(), 0);
});

test('cached stats equal stats rebuilt from the database', async () => {
  const game = (n, ranking, loser) => ({ room: 'qa1', mode: 'public', gameNo: n, at: 1000 + n, players: ['Ann', 'Bob', 'Cy'], ranking, loser, notice: null, points: 10 * n });
  await saveGame(game(1, ['Ann', 'Bob', 'Cy'], 'Cy'));
  await saveGame(game(2, ['Bob', 'Ann', 'Cy'], 'Cy'));
  await roomStats('qa1', 'public'); // fills the cache from the database
  await playerTotals('Ann', 'public');
  await saveGame(game(3, ['Ann', 'Cy', 'Bob'], 'Bob')); // these go into the cache as they happen
  await saveGame(game(4, ['Ann', 'Bob', 'Cy'], 'Cy'));
  const live = { room: await roomStats('qa1', 'public'), ann: await playerTotals('Ann', 'public'), cy: await playerTotals('Cy', 'public') };
  assert.equal(_memGames().filter((g) => g.room === 'qa1').length, 4, 'every game also reached the database');
  Q._reset(); // empty Redis: everything is read from the database again
  const rebuilt = { room: await roomStats('qa1', 'public'), ann: await playerTotals('Ann', 'public'), cy: await playerTotals('Cy', 'public') };
  assert.deepEqual(live, rebuilt);
  assert.equal(live.ann.played, 4);
  assert.equal(live.ann.wins, 3);
  assert.equal(live.room.history[0].no, 4, 'newest game first');
});

test('accounts: a name is claimed once, read from Redis, and written to the database from the queue', async () => {
  const a = await U.createLocal('Quinn', 'my-own-pw');
  assert.ok(a);
  assert.equal(await U.createLocal('quinn', 'other-pw'), null, 'the name is taken, any letter case');
  const got = await U.findLocal('QUINN');
  assert.equal(got.username, 'Quinn');
  assert.ok(U.checkPassword('my-own-pw', got.pw_hash));
  assert.equal(await U.nameTaken('Quinn'), false, 'taken means: belongs to somebody without a password');
  await U.touchLocal('Quinn');
  const row = U._memRows().find((r) => r.username === 'Quinn');
  assert.ok(row, 'the database row was written');
  assert.equal(row.logins, 2);
  Q._reset(); // Redis lost: the account is found again in the database
  assert.equal((await U.findLocal('quinn')).username, 'Quinn');
});
