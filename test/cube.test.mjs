// The cube puzzle's best times: one per player, only a personal best is kept, implausible results are refused.
import test from 'node:test';
process.env.GAME_ADMIN_ANY_NAME = '1';
import assert from 'node:assert/strict';
process.env.GAME_USERS_MEMORY = '1';
const { default: handler } = await import('../api/game.js');
const call = (body) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
  handler({ method: 'POST', body }, res);
});

test('cube: best times are kept per player, fastest first, shared with the room', async () => {
  const pub = async (name) => (await call({ op: 'login', name, password: '123456', newPassword: name + '-pw-1' })).body.sys;
  const a = await call({ op: 'join', sys: await pub('Cubea'), room: 'cb1', create: true });
  const b = await call({ op: 'join', sys: await pub('Cubeb'), room: 'cb1' });
  const mk = (r) => ({ room: 'cb1', token: r.body.token, playerId: r.body.state.you });
  assert.deepEqual(a.body.state.cube, [], 'an empty list to start with');
  assert.equal((await call({ op: 'cubeTime', ...mk(a), ms: 900, moves: 40 })).code, 400, 'too fast to be real');
  assert.equal((await call({ op: 'cubeTime', ...mk(a), ms: 60000, moves: 2 })).code, 400, 'too few moves');
  assert.equal((await call({ op: 'cubeTime', ...mk(a), ms: 'x', moves: 40 })).code, 400);
  await call({ op: 'cubeTime', ...mk(a), ms: 90000, moves: 80 });
  await call({ op: 'cubeTime', ...mk(b), ms: 45000, moves: 60 });
  await call({ op: 'cubeTime', ...mk(a), ms: 120000, moves: 90 }); // slower: not kept
  const list = (await call({ op: 'state', ...mk(b) })).body.state.cube;
  assert.deepEqual(list.map((e) => [e.name, e.ms]), [['Cubeb', 45000], ['Cubea', 90000]]);
  await call({ op: 'cubeTime', ...mk(a), ms: 30000, moves: 50 });
  assert.equal((await call({ op: 'state', ...mk(b) })).body.state.cube[0].name, 'Cubea', 'a personal best moves you up');
});
