// System sign-in (no room), then create a room or join one.
import test from 'node:test';
process.env.GAME_ADMIN_ANY_NAME = '1'; // these tests sign the admin in under made-up names; adminname.test.mjs checks the real rule
import assert from 'node:assert/strict';

process.env.GAME_USERS_MEMORY = '1';
const { default: handler } = await import('../api/game.js');
const { _memRows } = await import('../api/_lib/users.js');

const call = (body) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
  handler({ method: 'POST', body }, res);
});
const login = async (name, password, newPassword) => (await call({ op: 'login', name, password, newPassword })).body;

test('login names no room: public players choose their own password the first time', async () => {
  let r = await call({ op: 'login', name: 'Meena', password: '123456' });
  assert.deepEqual([r.code, r.body.needsPassword], [200, true]);
  assert.equal(_memRows().length, 0, 'nothing saved yet');
  assert.equal((await call({ op: 'login', name: 'Meena', password: '123456', newPassword: '123456' })).code, 400, 'not a shared password');
  r = await call({ op: 'login', name: 'Meena', password: '123456', newPassword: 'meena-pw1' });
  assert.deepEqual([r.code, r.body.name, r.body.role], [200, 'Meena', 'public']);
  assert.ok(r.body.sys);
  assert.equal((await call({ op: 'login', name: 'meena', password: '123456' })).code, 401, 'the shared password no longer opens this name');
  assert.equal((await call({ op: 'login', name: 'MEENA', password: 'meena-pw1' })).body.name, 'Meena');
  assert.equal((await call({ op: 'login', name: '  ', password: '123456' })).code, 400, 'a name is required');
});

test('the other passwords sign in as their own role, with no account', async () => {
  const before = _memRows().length;
  assert.equal((await login('Boss', '110299')).role, 'admin');
  assert.equal((await login('anything', '281101')).role, 'private');
  assert.equal((await login('x', '1102')).name, 'Observer');
  assert.equal((await call({ op: 'login', name: 'x', password: '12345678' })).code, 401, 'the old co-admin password is gone');
  assert.equal(_memRows().length, before);
});

test('create a room, join it by its code; nothing joins a room that does not exist', async () => {
  const meena = (await login('Meena', 'meena-pw1')).sys;
  const made = await call({ op: 'join', sys: meena, create: true });
  assert.equal(made.code, 200);
  assert.match(made.body.room, /^[0-9a-f]{6}$/, 'a random code');
  assert.equal(made.body.state.canStart, true, 'the creator is first in: co-admin of the new room');

  const named = await call({ op: 'join', sys: meena, create: true, room: 'friends-1' });
  assert.equal(named.body.room, 'friends-1');
  assert.equal((await call({ op: 'join', sys: meena, create: true, room: 'friends-1' })).code, 400, 'that room name is taken');

  await login('Ravi', '123456', 'ravi-pw12');
  const ravi = (await login('Ravi', 'ravi-pw12')).sys;
  const joined = await call({ op: 'join', sys: ravi, room: made.body.room });
  assert.equal(joined.code, 200);
  assert.equal(joined.body.state.canStart, false);
  assert.equal(joined.body.state.players.length, 2);
  const none = await call({ op: 'join', sys: ravi, room: 'nosuchroom' });
  assert.equal(none.code, 400);
  assert.equal(none.body.error, 'No room with that code.');
  assert.equal((await call({ op: 'join', sys: ravi, room: '' })).code, 400, 'a code is needed');
  assert.equal((await call({ op: 'join', sys: 'forged.token', room: made.body.room })).code, 401);
  // the room token that comes back resumes the session as before
  assert.equal((await call({ op: 'session', room: made.body.room, token: joined.body.token })).code, 200);
});

test('the admin makes it private; private players join it, public players are told the system is down', async () => {
  const admin = (await login('Boss', '110299')).sys;
  const room = (await call({ op: 'join', sys: admin, create: true })).body;
  await call({ op: 'private', room: room.room, playerId: room.state.you, on: true });
  const priv = (await login('Friend', '281101')).sys;
  const pj = await call({ op: 'join', sys: priv, room: room.room });
  assert.equal(pj.code, 200);
  assert.equal(pj.body.state.private, true);
  const pub = (await login('Meena', 'meena-pw1')).sys;
  const refused = await call({ op: 'join', sys: pub, room: room.room });
  assert.equal(refused.code, 401);
  assert.equal(refused.body.error, 'System down', 'no hint that the game is private');
  // private players and observers cannot create rooms, and a private player cannot enter a public room
  assert.equal((await call({ op: 'join', sys: priv, create: true })).code, 400);
  const pubRoom = (await call({ op: 'join', sys: pub, create: true })).body.room;
  assert.equal((await call({ op: 'join', sys: priv, room: pubRoom })).code, 401);
  // the observer can sit in any room, private or public, without creating
  const obs = (await login('x', '1102')).sys;
  assert.equal((await call({ op: 'join', sys: obs, room: room.room })).code, 200);
  assert.equal((await call({ op: 'join', sys: obs, create: true })).code, 400);
});

test('the shutdown switch stops public players signing in and entering rooms; the admin is not affected', async () => {
  const admin = await call({ op: 'join', sys: (await login('Boss', '110299')).sys, create: true });
  const meena = (await login('Meena', 'meena-pw1')).sys;
  await call({ op: 'shutdown', room: admin.body.room, playerId: admin.body.state.you, on: true });
  assert.equal((await call({ op: 'login', name: 'Meena', password: 'meena-pw1' })).body.error, 'System down');
  assert.equal((await call({ op: 'join', sys: meena, create: true })).body.error, 'System down', 'an earlier sign-in cannot enter a room either');
  assert.equal((await call({ op: 'login', name: 'Boss', password: '110299' })).code, 200);
  const back = await call({ op: 'join', sys: (await login('Boss', '110299')).sys, create: true });
  await call({ op: 'shutdown', room: back.body.room, playerId: back.body.state.you, on: false });
  assert.equal((await call({ op: 'login', name: 'Meena', password: 'meena-pw1' })).code, 200);
});

test('without the user database, the shared password still signs in (as before) and creates rooms', async () => {
  const keep = process.env.GAME_USERS_MEMORY;
  delete process.env.GAME_USERS_MEMORY;
  const r = await call({ op: 'login', name: 'Plain', password: '123456' });
  assert.deepEqual([r.code, r.body.name, r.body.role], [200, 'Plain', 'public']);
  assert.equal((await call({ op: 'join', sys: r.body.sys, create: true })).code, 200);
  process.env.GAME_USERS_MEMORY = keep;
});
