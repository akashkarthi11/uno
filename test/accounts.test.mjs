// Own login for public players: 123456 only opens the door once; the person then chooses a password. Shared passwords are untouched.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GAME_USERS_MEMORY = '1';
const { default: handler } = await import('../api/game.js');
const { _memRows, checkPassword, hashPassword, upsertAuth0 } = await import('../api/_lib/users.js');

const call = (body) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
  handler({ method: 'POST', body }, res);
});

test('password hashes are salted and checked', () => {
  const h = hashPassword('hunter22');
  assert.ok(checkPassword('hunter22', h));
  assert.ok(!checkPassword('hunter23', h));
  assert.notEqual(h, hashPassword('hunter22'), 'a new salt each time');
  assert.ok(!h.includes('hunter22'));
});

test('first sign-in: 123456 asks for a new password; then only the new password works', async () => {
  const R = 'acc1';
  let r = await call({ op: 'join', room: R, name: 'Asha', password: '123456' });
  assert.deepEqual([r.code, r.body.needsPassword], [200, true], 'asked to choose a password');
  assert.equal(_memRows().length, 0, 'nothing saved until the password is chosen');

  for (const bad of ['12345', '123456', '110299', '281101']) {
    r = await call({ op: 'join', room: R, name: 'Asha', password: '123456', newPassword: bad });
    assert.equal(r.code, 400, 'refused: ' + bad);
  }
  r = await call({ op: 'join', room: R, name: 'Asha', password: '123456', newPassword: 'my-own-pw' });
  assert.equal(r.code, 200);
  assert.ok(r.body.state && r.body.token);
  assert.equal(_memRows()[0].username, 'Asha');
  assert.ok(!JSON.stringify(_memRows()).includes('my-own-pw'), 'only a hash is stored');

  // the shared password no longer signs this name in; the new one does, whatever the letter case
  assert.equal((await call({ op: 'join', room: R, name: 'Asha', password: '123456' })).code, 401);
  assert.equal((await call({ op: 'join', room: R, name: 'Asha', password: 'wrong-pw' })).code, 401);
  r = await call({ op: 'join', room: R, name: 'asha', password: 'my-own-pw' });
  assert.equal(r.code, 200);
  assert.equal(r.body.state.players.find((p) => p.id === r.body.state.you).name, 'Asha', 'the stored name is used');
  assert.equal(_memRows()[0].logins, 2);

  // another person cannot take the same name with the shared password: it asks them to choose, then refuses
  r = await call({ op: 'join', room: R, name: 'ASHA', password: '123456' });
  assert.equal(r.code, 401, 'name already has an account: the shared password is not enough');
});

test('a name is required; a wrong first password gets nothing', async () => {
  assert.equal((await call({ op: 'join', room: 'acc2', name: '  ', password: '123456' })).code, 400);
  assert.equal((await call({ op: 'join', room: 'acc2', name: 'Ravi', password: 'guess' })).code, 401);
  assert.equal(_memRows().filter((x) => x.username === 'Ravi').length, 0);
});

test('admin, co-admin, private and observer passwords skip accounts', async () => {
  const before = _memRows().length;
  for (const [pw, room] of [['110299', 'acc3'], ['1102', 'acc3']]) {
    const r = await call({ op: 'join', room, name: 'Someone', password: pw });
    assert.equal(r.code, 200, pw);
    assert.equal(r.body.needsPassword, undefined);
  }
  // make a private room, then the private password joins without an account
  const admin = (await call({ op: 'join', room: 'acc4', name: 'Boss', password: '110299' })).body.state.you;
  await call({ op: 'private', room: 'acc4', playerId: admin, on: true });
  const p = await call({ op: 'join', room: 'acc4', name: 'Friend', password: '281101' });
  assert.equal(p.code, 200);
  assert.equal(p.body.state.private, true);
  assert.equal(_memRows().length, before, 'no accounts were created');
});

test('the shutdown switch stops accounts too', async () => {
  const R = 'acc5';
  const admin = (await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state.you;
  await call({ op: 'shutdown', room: R, playerId: admin, on: true });
  assert.equal((await call({ op: 'join', room: 'acc6', name: 'Asha', password: 'my-own-pw' })).body.error, 'System down');
  // shutting down closed this room too: the admin signs in again before opening public play
  const again = (await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state.you;
  await call({ op: 'shutdown', room: R, playerId: again, on: false });
});

test('Auth0 users are saved with email and name, and kept up to date', async () => {
  await upsertAuth0({ sub: 'auth0|1', email: 'a@x.com', name: 'Asha K' });
  await upsertAuth0({ sub: 'auth0|1', email: 'a@x.com', name: 'Asha Kumar' });
  const rows = _memRows().filter((r) => r.auth0_sub === 'auth0|1');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].username, rows[0].email, rows[0].logins], ['Asha Kumar', 'a@x.com', 2]);
});

test('the first public player into a new public room is its co-admin; later ones are not', async () => {
  const R = 'first1';
  const a = await call({ op: 'join', room: R, name: 'Firsty', password: '123456' });
  assert.equal(a.body.needsPassword, true);
  const first = await call({ op: 'join', room: R, name: 'Firsty', password: '123456', newPassword: 'first-pw1' });
  assert.equal(first.body.state.canStart, true, 'can start the game');
  assert.equal(first.body.state.admin, false, 'but is not the real admin');
  await call({ op: 'join', room: R, name: 'Second', password: '123456', newPassword: 'second-pw' });
  const second = await call({ op: 'join', room: R, name: 'Second', password: 'second-pw' });
  assert.equal(second.body.state.canStart, false, 'the second player is an ordinary player');
  // the real admin can take it away
  const admin = (await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state.you;
  const firstId = first.body.state.you;
  await call({ op: 'starter', room: R, playerId: admin, targetId: firstId, on: false });
  assert.equal((await call({ op: 'join', room: R, name: 'Firsty', password: 'first-pw1', playerId: firstId })).body.state.canStart, false);
});

test('a private room has no co-admin from joining first; the admin joining first does not count', async () => {
  const R = 'first2';
  const admin = (await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state.you;
  await call({ op: 'private', room: R, playerId: admin, on: true });
  assert.equal((await call({ op: 'join', room: R, name: 'Friend', password: '281101' })).body.state.canStart, false);
  const R2 = 'first3';
  await call({ op: 'join', room: R2, name: 'Boss', password: '110299' });
  await call({ op: 'join', room: R2, name: 'Zed', password: '123456', newPassword: 'zed-pw12' });
  assert.equal((await call({ op: 'join', room: R2, name: 'Zed', password: 'zed-pw12' })).body.state.canStart, false, 'the room already had the admin in it');
});

test('the old co-admin password is not a shared password any more: it is just a wrong password, and an ordinary one to choose', async () => {
  assert.equal((await call({ op: 'join', room: 'old1', name: 'Co', password: '12345678' })).code, 401);
  const r = await call({ op: 'join', room: 'old1', name: 'Co', password: '123456', newPassword: '12345678' });
  assert.equal(r.code, 200, 'it is only a password like any other now');
  assert.equal(r.body.state.canStart, true, 'and this player is co-admin only because they were first into the room');
});
