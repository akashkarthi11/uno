// The 3D duel: the invite lives on the room, the connection set-up goes through a mailbox; the match itself is between the two browsers.
import test from 'node:test';
process.env.GAME_ADMIN_ANY_NAME = '1';
import assert from 'node:assert/strict';

process.env.GAME_USERS_MEMORY = '1';
const { default: handler } = await import('../api/game.js');
const call = (body) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
  handler({ method: 'POST', body }, res);
});
const pub = async (name) => (await call({ op: 'login', name, password: '123456', newPassword: name + '-pw-1' })).body.sys;
const who = (r, room) => ({ room, token: r.body.token, playerId: r.body.state.you });

test('a duel needs exactly two players; the other sees the invite; set-up messages reach only the other player', async () => {
  const room = 'duel-a';
  const a = await call({ op: 'join', sys: await pub('Ada'), room, create: true });
  assert.equal(a.body.state.canDuel, false, 'alone: no duel');
  assert.equal((await call({ op: 'duelStart', ...who(a, room) })).code, 400);
  const b = await call({ op: 'join', sys: await pub('Bo'), room });
  const st = await call({ op: 'state', ...who(a, room) });
  assert.equal(st.body.state.canDuel, true);
  const inv = await call({ op: 'duelStart', ...who(a, room) });
  assert.equal(inv.code, 200);
  const seen = (await call({ op: 'state', ...who(b, room) })).body.state;
  assert.deepEqual([seen.duel.by, seen.duel.byName], [a.body.state.you, 'Ada'], 'the other player sees who invited');

  const A = who(a, room), B = who(b, room);
  assert.equal((await call({ op: 'duelSignal', ...B, to: A.playerId, kind: 'hello', data: null })).code, 200);
  assert.equal((await call({ op: 'duelSignal', ...B, to: A.playerId, kind: 'nope', data: null })).code, 400, 'only the known kinds');
  assert.deepEqual((await call({ op: 'duelSignals', ...A })).body.signals.map((x) => [x.from, x.kind]), [[B.playerId, 'hello']]);
  assert.deepEqual((await call({ op: 'duelSignals', ...A })).body.signals, [], 'taken once');
  assert.deepEqual((await call({ op: 'duelSignals', ...B })).body.signals, [], 'it never went to the sender');

  await call({ op: 'duelEnd', ...A });
  assert.equal((await call({ op: 'state', ...who(b, room) })).body.state.duel, null);
});

test('three players in the room: no duel; an observer cannot take part', async () => {
  const room = 'duel-b';
  const a = await call({ op: 'join', sys: await pub('Cy'), room, create: true });
  await call({ op: 'join', sys: await pub('Di'), room });
  await call({ op: 'join', sys: await pub('Ed'), room });
  assert.equal((await call({ op: 'duelStart', ...who(a, room) })).code, 400);
  const obs = (await call({ op: 'login', name: 'Watcher', password: '1102' })).body;
  if (obs.sys) {
    const o = await call({ op: 'join', sys: obs.sys, room });
    assert.equal((await call({ op: 'duelSignal', ...who(o, room), to: a.body.state.you, kind: 'hello' })).code, 400);
  }
});
