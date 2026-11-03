// The private location map: opt-in, private rooms only, the admin and private players only.
import test from 'node:test';
process.env.GAME_ADMIN_ANY_NAME = '1';
import assert from 'node:assert/strict';

process.env.GAME_USERS_MEMORY = '1';
const { default: handler } = await import('../api/game.js');
const call = (body) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
  handler({ method: 'POST', body }, res);
});

test('map: private rooms only, opt-in, moves are logged, public players get nothing', async () => {
  const admin = (await call({ op: 'login', name: 'Boss', password: '110299' })).body.sys;
  const priv = (await call({ op: 'login', name: 'Pia', password: '281101' })).body.sys;
  const a = await call({ op: 'join', sys: admin, room: 'mp1', create: true });
  const mk = (r) => ({ room: 'mp1', token: r.body.token, playerId: r.body.state.you });
  assert.equal(a.body.state.map, undefined, 'a public room has no map');
  assert.equal((await call({ op: 'mapMove', ...mk(a), zone: 'Kitchen' })).code, 400, 'and refuses moves');
  await call({ op: 'private', ...mk(a), on: true });
  const p = await call({ op: 'join', sys: priv, room: 'mp1' });
  const s0 = (await call({ op: 'state', ...mk(a) })).body.state;
  assert.deepEqual([s0.map.people.length, s0.map.mine], [0, ''], 'nobody is on the map until they choose to be');
  const moved = await call({ op: 'mapMove', ...mk(p), zone: 'Kitchen' });
  assert.deepEqual(moved.body.state.map.people.map((x) => [x.name, x.zone]), [['Pia', 'Kitchen']]);
  await call({ op: 'mapMove', ...mk(p), zone: 'Lounge' });
  const seen = (await call({ op: 'state', ...mk(a) })).body.state.map;
  assert.equal(seen.people[0].zone, 'Lounge', 'the admin sees the dot in the new place');
  assert.deepEqual(seen.log.map((e) => [e.from, e.to]), [['', 'Kitchen'], ['Kitchen', 'Lounge']]);
  assert.equal((await call({ op: 'mapMove', ...mk(p), zone: 'Roof' })).code, 400, 'only places on the map');
  await call({ op: 'mapMove', ...mk(p), zone: '' });
  assert.equal((await call({ op: 'state', ...mk(a) })).body.state.map.people.length, 0, 'stop sharing: off the map');
  await call({ op: 'mapMove', ...mk(p), zone: 'Office' });
  await call({ op: 'private', ...mk(a), on: false });
  assert.equal((await call({ op: 'state', ...mk(a) })).body.state.map, undefined, 'going public clears and hides the map');
});
