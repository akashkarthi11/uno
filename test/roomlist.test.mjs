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

  // another room's co-admin cannot lock it; the real admin can lock any room; no such room
  const eve = await pub('Eve');
  await call({ op: 'join', sys: eve, room: 'rl-eve', create: true });
  assert.equal((await call({ op: 'roomOff', sys: cat, target: 'rl-eve', pin: '1111' })).code, 401);
  assert.equal((await call({ op: 'roomOff', sys: admin, target: 'rl-eve', pin: '1111' })).code, 200, 'the admin can lock any room');
  assert.equal((await call({ op: 'roomOff', sys: admin, target: 'rl-nope', pin: '1111' })).code, 400, 'no such room');
});
