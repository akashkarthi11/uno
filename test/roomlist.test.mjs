// The room screen's list of active rooms, and turning a room off from it.
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
const codes = async (sys) => (await call({ op: 'roomList', sys })).body.rooms.map((r) => r.code).sort();

test('public players see active public rooms, never private ones; private players see private rooms', async () => {
  const ann = await pub('Ann');
  const bob = await pub('Bob');
  const admin = (await call({ op: 'login', name: 'Boss', password: '110299' })).body.sys;
  const priv = (await call({ op: 'login', name: 'P', password: '281101' })).body.sys;
  assert.deepEqual(await codes(ann), [], 'nothing active yet');
  await call({ op: 'join', sys: ann, room: 'rl-open', create: true });
  const hidden = await call({ op: 'join', sys: admin, room: 'rl-secret', create: true });
  await call({ op: 'private', room: 'rl-secret', playerId: hidden.body.state.you, on: true });
  assert.deepEqual(await codes(bob), ['rl-open'], 'a public player sees only the public room');
  assert.deepEqual(await codes(priv), ['rl-secret'], 'a private player sees the private room');
  assert.deepEqual(await codes(admin), ['rl-open', 'rl-secret'], 'the admin sees both');
  const row = (await call({ op: 'roomList', sys: bob })).body.rooms[0];
  assert.deepEqual([row.mode, row.online, row.canOff], ['public', 1, false], 'an ordinary player cannot turn it off');
  assert.equal((await call({ op: 'roomList', sys: 'bad.token' })).code, 401);
});

test('turning a room off locks it: it leaves other lists and a new person needs the PIN; players inside carry on', async () => {
  const cat = await pub('Cat');
  const dan = await pub('Dan');
  const fay = await pub('Fay');
  const admin = (await call({ op: 'login', name: 'Boss', password: '110299' })).body.sys;
  const made = await call({ op: 'join', sys: cat, room: 'rl-cat', create: true });
  const danIn = await call({ op: 'join', sys: dan, room: 'rl-cat' });
  const mine = (await call({ op: 'roomList', sys: cat })).body.rooms.find((r) => r.code === 'rl-cat');
  const theirs = (await call({ op: 'roomList', sys: dan })).body.rooms.find((r) => r.code === 'rl-cat');
  assert.deepEqual([mine.canOff, theirs.canOff, mine.locked], [true, false, false], 'only the room\'s co-admin gets the button');
  assert.equal((await call({ op: 'roomOff', sys: dan, target: 'rl-cat', pin: '4321' })).code, 401, 'refused for another player');
  assert.equal((await call({ op: 'roomOff', sys: cat, target: 'rl-cat', pin: '12' })).code, 400, 'the PIN is 4 to 8 digits');
  assert.equal((await call({ op: 'roomOff', sys: cat, target: 'rl-cat', pin: 'abcd' })).code, 400);
  assert.equal((await call({ op: 'roomOff', sys: cat, target: 'rl-cat', pin: '4321' })).code, 200);

  assert.equal((await codes(fay)).includes('rl-cat'), false, 'a locked room leaves everyone else\'s list');
  const own = (await call({ op: 'roomList', sys: cat })).body.rooms.find((r) => r.code === 'rl-cat');
  assert.deepEqual([own.locked, own.canOff], [true, true], 'but the one who can turn it on still sees it');
  const noPin = await call({ op: 'join', sys: fay, room: 'rl-cat' });
  assert.deepEqual([noPin.code, noPin.body.needsPin], [401, true], 'a new person needs the PIN');
  assert.equal((await call({ op: 'join', sys: fay, room: 'rl-cat', pin: '9999' })).body.error, 'Wrong PIN.');
  // players inside, the co-admin's own seat and the admin are not asked
  assert.equal((await call({ op: 'join', sys: dan, room: 'rl-cat', playerId: danIn.body.state.you })).code, 200, 'a member coming back is not asked');
  assert.equal((await call({ op: 'session', room: 'rl-cat', token: danIn.body.token })).code, 200, 'and their session carries on');
  assert.equal((await call({ op: 'join', sys: admin, room: 'rl-cat' })).code, 200, 'the real admin needs no PIN');
  const ok = await call({ op: 'join', sys: fay, room: 'rl-cat', pin: '4321' });
  assert.equal(ok.code, 200, 'the right PIN lets a new person in');

  // five wrong tries stop all guessing, even the right PIN, for a while
  const gus = await pub('Gus');
  for (let i = 0; i < 5; i++) await call({ op: 'join', sys: gus, room: 'rl-cat', pin: '000' + i });
  const stuck = await call({ op: 'join', sys: gus, room: 'rl-cat', pin: '4321' });
  assert.deepEqual([stuck.code, stuck.body.needsPin], [429, true]);

  // turning it on again removes the PIN
  assert.equal((await call({ op: 'roomOn', sys: dan, target: 'rl-cat' })).code, 401, 'not for another player');
  assert.equal((await call({ op: 'roomOn', sys: cat, target: 'rl-cat' })).code, 200);
  assert.equal((await call({ op: 'join', sys: gus, room: 'rl-cat' })).code, 200, 'open to everyone again, and the tries are forgotten');

  // only the creator can lock a room: not another player, and not the admin account either when a player made it; no such room
  const eve = await pub('Eve');
  await call({ op: 'join', sys: eve, room: 'rl-eve', create: true });
  assert.equal((await call({ op: 'roomOff', sys: cat, target: 'rl-eve', pin: '1111' })).code, 401);
  assert.equal((await call({ op: 'roomOff', sys: admin, target: 'rl-eve', pin: '1111' })).code, 401, 'the admin did not create it');
  assert.equal((await call({ op: 'roomOff', sys: eve, target: 'rl-eve', pin: '1111' })).code, 200, 'its creator can');
  // a room the admin made belongs to the admin account; a player who joined it cannot lock it
  await call({ op: 'join', sys: admin, room: 'rl-adm', create: true });
  await call({ op: 'join', sys: eve, room: 'rl-adm' });
  assert.equal((await call({ op: 'roomOff', sys: eve, target: 'rl-adm', pin: '1111' })).code, 401);
  assert.equal((await call({ op: 'roomOff', sys: admin, target: 'rl-adm', pin: '1111' })).code, 200);
  assert.equal((await call({ op: 'roomOff', sys: admin, target: 'rl-nope', pin: '1111' })).code, 400, 'no such room');
});

test('a room whose admin is out of it stays in their list (with Turn off), but not in other people\'s', async () => {
  const gil = await pub('Gil');
  const hal = await pub('Hal');
  const admin = (await call({ op: 'login', name: 'Boss', password: '110299' })).body.sys;
  await call({ op: 'join', sys: gil, room: 'rl-idle', create: true });
  const { withRoom } = await import('../api/_lib/store.js');
  await withRoom('rl-idle', (s) => { for (const m of s.members) m.lastSeen = 0; }); // everybody has left
  const idle = (await call({ op: 'roomList', sys: gil })).body.rooms.find((r) => r.code === 'rl-idle');
  assert.deepEqual([idle.online, idle.canOff], [0, true], 'its own co-admin still sees it, with the button');
  assert.equal((await codes(admin)).includes('rl-idle'), false, 'the admin account did not create it, so it is not in their list');
  assert.equal((await codes(hal)).includes('rl-idle'), false, 'an empty room is not offered to anybody else');
  // everybody leaves for good: the room is empty, so it is no longer offered to anyone
  await call({ op: 'leave', room: 'rl-idle', playerId: (await call({ op: 'join', sys: gil, room: 'rl-idle' })).body.state.you });
  assert.equal((await codes(admin)).includes('rl-idle'), false, 'an empty room is not listed, not even for the admin');
});

test('a room made before owners were recorded (like main) belongs to whoever joined it first; the admin account is the admin of its rooms', async () => {
  const admin = (await call({ op: 'login', name: 'Boss', password: '110299' })).body.sys;
  const ivy = await pub('Ivy');
  await call({ op: 'join', sys: admin, room: 'rl-main', create: true });
  const { withRoom } = await import('../api/_lib/store.js');
  await withRoom('rl-main', (s) => { delete s.owner; delete s.ownerRole; });
  const row = (await call({ op: 'roomList', sys: admin })).body.rooms.find((r) => r.code === 'rl-main');
  assert.equal(row.canOff, true, 'first member was the admin account, so the admin account owns it');
  await call({ op: 'join', sys: ivy, room: 'rl-main' });
  assert.equal((await call({ op: 'roomOff', sys: ivy, target: 'rl-main', pin: '1234' })).code, 401, 'a later player does not');
});

test('from inside the room: only its creator is told they own it, and can lock and unlock it', async () => {
  const jo = await pub('Jo');
  const kim = await pub('Kim');
  const a = await call({ op: 'join', sys: jo, room: 'rl-in', create: true });
  const b = await call({ op: 'join', sys: kim, room: 'rl-in' });
  assert.deepEqual([a.body.state.owns, b.body.state.owns, a.body.state.locked], [true, false, false]);
  const tok = (r) => ({ room: 'rl-in', token: r.body.token, playerId: r.body.state.you });
  assert.equal((await call({ op: 'lockRoom', ...tok(b), pin: '1234' })).code, 400, 'not for another player');
  assert.equal((await call({ op: 'lockRoom', ...tok(a), pin: '12' })).code, 400, 'PIN of 4 to 8 digits');
  const off = await call({ op: 'lockRoom', ...tok(a), pin: '1234' });
  assert.deepEqual([off.code, off.body.state.locked], [200, true]);
  const lee = await pub('Lee');
  assert.equal((await call({ op: 'join', sys: lee, room: 'rl-in' })).body.needsPin, true, 'a new person needs the PIN');
  assert.equal((await call({ op: 'unlockRoom', ...tok(a) })).body.state.locked, false);
});
