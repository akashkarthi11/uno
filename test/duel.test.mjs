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
  const a = await call({ op: 'join', sys: await pub('Cyd'), room, create: true });
  await call({ op: 'join', sys: await pub('Hal'), room });
  await call({ op: 'join', sys: await pub('Ed'), room });
  assert.equal((await call({ op: 'duelStart', ...who(a, room) })).code, 400);
  const obs = (await call({ op: 'login', name: 'Watcher', password: '1102' })).body;
  if (obs.sys) {
    const o = await call({ op: 'join', sys: obs.sys, room });
    assert.equal((await call({ op: 'duelSignal', ...who(o, room), to: a.body.state.you, kind: 'hello' })).code, 400);
  }
});

test('the admin sees the 3D duel total score; each result counts once and impossible scores are refused', async () => {
  const room = 'duel-score';
  const admin = (await call({ op: 'login', name: 'Boss', password: '110299' })).body.sys;
  const a = await call({ op: 'join', sys: await pub('Gus'), room, create: true });
  const b = await call({ op: 'join', sys: await pub('Ivy'), room });
const A = who(a, room), B = who(b, room);
  assert.equal((await call({ op: 'duelResult', ...A, id: 'match0001', kills: 5, deaths: 3 })).body.ok, true);
  assert.equal((await call({ op: 'duelResult', ...B, id: 'match0001', kills: 3, deaths: 5 })).body.ok, true);
  assert.equal((await call({ op: 'duelResult', ...A, id: 'match0001', kills: 5, deaths: 3 })).body.ok, false, 'a repeat counts once');
  assert.equal((await call({ op: 'duelResult', ...A, id: 'match0002', kills: 7, deaths: 0 })).body.ok, false, 'more than 5 kills is impossible');
  assert.equal((await call({ op: 'duelResult', ...A, id: 'match0003', kills: 2, deaths: 2 })).body.ok, false, 'nobody reached 5');
  const st = (await call({ op: 'stats', ...A })).body.stats;
  assert.equal(st.duel, undefined, 'only the admin sees the table');
  const boss = await call({ op: 'join', sys: admin, room });
  const rows = (await call({ op: 'stats', ...who(boss, room) })).body.stats.duel;
  assert.deepEqual(rows.map((r) => [r.name, r.played, r.wins, r.losses, r.kills, r.deaths]), [['Gus', 1, 1, 0, 5, 3], ['Ivy', 1, 0, 1, 3, 5]]);
});

test('a player\'s duel button layout is saved by name, cleaned, and read back from Redis; other players keep their own', async () => {
  const room = 'duel-layout';
  const a = await call({ op: 'join', sys: await pub('Jon'), room, create: true });
  const b = await call({ op: 'join', sys: await pub('Kit'), room });
  const A = who(a, room), B = who(b, room);
  assert.deepEqual((await call({ op: 'duelLayout', ...A })).body.layout, {}, 'nothing saved: the default');
  const sent = { land: { duelFire: [0.9, 0.7, 1.4], duelBogus: [0.5, 0.5], duelJump: [2, 0.1], duelAim: [0.5, 0.5, 9] }, port: { duelAim: [0.2, 0.3] }, junk: 1 };
  const r = await call({ op: 'duelLayoutSave', ...A, layout: sent });
  assert.deepEqual(r.body.layout, { land: { duelFire: [0.9, 0.7, 1.4] }, port: { duelAim: [0.2, 0.3] } }, 'unknown buttons and out-of-range spots are dropped');
  assert.deepEqual((await call({ op: 'duelLayout', ...A })).body.layout, r.body.layout);
  assert.deepEqual((await call({ op: 'duelLayout', ...B })).body.layout, {}, 'the other player is not affected');
  assert.equal((await call({ op: 'duelLayoutSave', ...A, layout: 'nope' })).code, 400);
});

test('the real admin sets the 3D duel bot (difficulty and numbers); values are clamped; a co-admin and players cannot', async () => {
  const room = 'duel-botcfg';
  const admin = (await call({ op: 'login', name: 'Boss', password: '110299' })).body.sys;
  const boss = await call({ op: 'join', sys: admin, room, create: true });
  const pl = await call({ op: 'join', sys: await pub('Lex'), room });
  const A = who(boss, room), P = who(pl, room);
  const get = async (w) => (await call({ op: 'state', ...w })).body.state.settings.botDuel;
  assert.deepEqual(await get(P), { on: true, level: 'medium', react: 380, aim: 0.035, speed: 4.6, dmg: 100 }, 'the default is medium, and players can read it');
  const r = await call({ op: 'config', ...A, botDuel: { on: false, level: 'hard', react: 50, aim: 0.015, speed: 99, dmg: 120 } });
  assert.equal(r.code, 200);
  assert.deepEqual(await get(P), { on: false, level: 'hard', react: 100, aim: 0.015, speed: 9, dmg: 120 }, 'saved and clamped (reaction 100 ms at the least, speed 9 at the most)');
  assert.equal((await call({ op: 'config', ...P, botDuel: { level: 'easy' } })).code, 400, 'a player cannot');
  assert.equal((await call({ op: 'config', ...A, botDuel: 'x' })).code, 400, 'bad data is refused');
  assert.equal((await call({ op: 'config', ...A, botDuel: { level: 'easy', react: 700, aim: 0.07, speed: 3.6, dmg: 70, on: true } })).code, 200);
  assert.equal((await get(P)).level, 'easy');
});

test('the real admin sets the card game bot too (difficulty, thinking time, GrowX! chance, smartness); a player cannot', async () => {
  const room = 'card-botcfg';
  const admin = (await call({ op: 'login', name: 'Boss', password: '110299' })).body.sys;
  const boss = await call({ op: 'join', sys: admin, room, create: true });
  const A = who(boss, room);
  const get = async () => (await call({ op: 'state', ...A })).body.state.settings.botCard;
  assert.deepEqual(await get(), { level: 'medium', think: 1300, uno: 80, smart: 90 });
  assert.equal((await call({ op: 'config', ...A, botCard: { level: 'hard', think: 100, uno: 100, smart: 200 } })).code, 200);
  assert.deepEqual(await get(), { level: 'hard', think: 400, uno: 100, smart: 100 }, 'clamped: at least 400 ms, at most 100 %');
  const pl = await call({ op: 'join', sys: await pub('Max'), room });
  assert.equal((await call({ op: 'config', ...who(pl, room), botCard: { level: 'easy' } })).code, 400);
});
