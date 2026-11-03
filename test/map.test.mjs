// The private location radar: opt-in, private rooms only, the admin and private players only.
import test from 'node:test';
process.env.GAME_ADMIN_ANY_NAME = '1';
import assert from 'node:assert/strict';

process.env.GAME_USERS_MEMORY = '1';
const { default: handler } = await import('../api/game.js');
const call = (body) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
  handler({ method: 'POST', body }, res);
});

test('radar: private rooms only, opt-in, positions are checked, public players get nothing', async () => {
  const admin = (await call({ op: 'login', name: 'Boss', password: '110299' })).body.sys;
  const priv = (await call({ op: 'login', name: 'Pia', password: '281101' })).body.sys;
  const pub = (await call({ op: 'login', name: 'Pub', password: '123456', newPassword: 'pub-pass-1' })).body.sys;
  const a = await call({ op: 'join', sys: admin, room: 'mp1', create: true });
  const mk = (r) => ({ room: 'mp1', token: r.body.token, playerId: r.body.state.you });
  assert.deepEqual([a.body.state.map.people.length, a.body.state.map.mine], [0, false], 'a public room has the radar too');
  const pubJoin = await call({ op: 'join', sys: pub, room: 'mp1' });
  assert.equal((await call({ op: 'mapPos', ...mk(pubJoin), lat: 12.97, lon: 77.59, acc: 8 })).code, 200, 'and a public player can share');
  assert.equal((await call({ op: 'mapPos', ...mk(pubJoin), stop: true })).code, 200);
  await call({ op: 'private', ...mk(a), on: true });
  const p = await call({ op: 'join', sys: priv, room: 'mp1' });
  const s0 = (await call({ op: 'state', ...mk(a) })).body.state;
  assert.deepEqual([s0.map.people.length, s0.map.mine], [0, false], 'nobody is on it until they choose to share');
  assert.equal((await call({ op: 'mapPos', ...mk(p), lat: 120, lon: 77.59 })).code, 400, 'a made-up position is refused');
  assert.equal((await call({ op: 'mapPos', ...mk(p), lat: 'x', lon: 1 })).code, 400);
  const sent = await call({ op: 'mapPos', ...mk(p), lat: 12.971234567, lon: 77.59, acc: 8.4 });
  assert.deepEqual(sent.body.state.map.people.map((x) => [x.name, x.lat, x.lon, x.acc]), [['Pia', 12.97123, 77.59, 8]], 'rounded to about a metre');
  await call({ op: 'mapPos', ...mk(p), lat: 12.9715, lon: 77.5905, acc: 6 });
  const seen = (await call({ op: 'state', ...mk(a) })).body.state.map;
  assert.equal(seen.people[0].lat, 12.9715, 'the admin sees the new position');
  assert.deepEqual(seen.log.filter((e) => e.name === 'Pia').map((e) => e.what), ['started sharing'], 'only start and stop are logged, not every step');
  await call({ op: 'mapPos', ...mk(p), stop: true });
  const off = (await call({ op: 'state', ...mk(a) })).body.state.map;
  assert.deepEqual([off.people.length, off.log.filter((e) => e.name === 'Pia').map((e) => e.what)], [0, ['started sharing', 'stopped sharing']]);
  const obs = await call({ op: 'login', name: 'Watcher', password: '1102' });
  const o = await call({ op: 'join', sys: obs.body.sys, room: 'mp1' });
  assert.equal(o.body.state.map, undefined, 'the observer account gets no radar');
  assert.equal((await call({ op: 'mapPos', ...mk(o), lat: 1, lon: 1 })).code, 400, 'and cannot share');
});

test('radar: a phone that stops reporting drops off', async () => {
  const priv = (await call({ op: 'login', name: 'Quin', password: '281101' })).body.sys;
  const admin = (await call({ op: 'login', name: 'Boss', password: '110299' })).body.sys;
  const a = await call({ op: 'join', sys: admin, room: 'mp2', create: true });
  const mk = (r) => ({ room: 'mp2', token: r.body.token, playerId: r.body.state.you });
  await call({ op: 'private', ...mk(a), on: true });
  const q = await call({ op: 'join', sys: priv, room: 'mp2' });
  await call({ op: 'mapPos', ...mk(q), lat: 1, lon: 1 });
  const { withRoom } = await import('../api/_lib/store.js');
  await withRoom('mp2', (s) => { for (const m of s.members) if (m.pos) m.pos.at -= 120000; });
  assert.equal((await call({ op: 'state', ...mk(a) })).body.state.map.people.length, 0, 'stale after 90 seconds');
});
