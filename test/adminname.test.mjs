// The admin password (110299) belongs to one username: karthickkeyan303. No other name can use it.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GAME_USERS_MEMORY = '1';
delete process.env.GAME_ADMIN_ANY_NAME; // the real rule
const { default: handler } = await import('../api/game.js');
const { _memRows } = await import('../api/_lib/users.js');

const call = (body) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
  handler({ method: 'POST', body }, res);
});

test('110299 with any other username is just a wrong password', async () => {
  for (const name of ['Boss', 'admin', 'karthickkeyan', 'karthickkeyan3030', '']) {
    const r = await call({ op: 'login', name, password: '110299' });
    assert.equal(r.code, 401, JSON.stringify(name));
    assert.equal(r.body.error, 'Wrong password.');
    assert.equal(r.body.sys, undefined);
  }
  // the older per-room sign-in follows the same rule, and the admin diagnostics too
  const room = await call({ op: 'join', room: 'adminname1', name: 'Boss', password: '110299' });
  assert.equal(room.code, 401);
  assert.equal(room.body.state, undefined);
  assert.equal((await call({ op: 'bench', password: '110299', name: 'Boss' })).code, 401);
  assert.equal(_memRows().length, 0, 'nothing was saved');
});

test('karthickkeyan303 with 110299 is the admin, whatever the letter case, and is recorded on that user', async () => {
  for (const name of ['karthickkeyan303', 'KarthickKeyan303', '  karthickkeyan303 ']) {
    const r = await call({ op: 'login', name, password: '110299' });
    assert.equal(r.code, 200, name);
    assert.deepEqual([r.body.role, r.body.name], ['admin', 'karthickkeyan303']);
  }
  const admin = (await call({ op: 'login', name: 'KARTHICKKEYAN303', password: '110299' })).body.sys;
  const made = await call({ op: 'join', sys: admin, create: true });
  assert.equal(made.code, 200);
  assert.equal(made.body.state.admin, true);
  assert.equal(made.body.state.players.find((p) => p.id === made.body.state.you).name, 'karthickkeyan303');
  const row = _memRows().find((r) => r.username === 'karthickkeyan303');
  assert.ok(row && row.is_admin && row.logins >= 4, 'one user row, marked as the admin, counting every sign-in');
  // the per-room sign-in works for the admin's username too
  assert.equal((await call({ op: 'join', room: 'adminname2', name: 'karthickkeyan303', password: '110299' })).body.state.admin, true);
  assert.equal((await call({ op: 'bench', password: '110299', name: 'karthickkeyan303' })).code !== 401, true);
});

test('nobody else can register the admin\'s username, and the other shared passwords are unchanged', async () => {
  assert.equal((await call({ op: 'login', name: 'karthickkeyan303', password: '123456' })).body.error, 'That name is taken.');
  assert.equal((await call({ op: 'login', name: 'karthickkeyan303', password: '123456', newPassword: 'abcdef12' })).code, 401);
  assert.equal((await call({ op: 'login', name: 'Friend', password: '281101' })).body.role, 'private');
  assert.equal((await call({ op: 'login', name: 'x', password: '1102' })).body.role, 'observer');
});

test('the admin\'s own Auth0 account signs in as the admin; a lookalike Auth0 account never does', async () => {
  process.env.AUTH0_DOMAIN = 'tenant.example.auth0.com';
  process.env.AUTH0_CLIENT_ID = 'cid';
  process.env.AUTH0_CLIENT_SECRET = 'not-a-real-secret';
  const { makeTicket, auth0Config } = await import('../api/_lib/auth0.js');
  const { upsertAuth0 } = await import('../api/_lib/users.js');
  const cfg = auth0Config();
  const adminRoom = (await call({ op: 'join', sys: (await call({ op: 'login', name: 'karthickkeyan303', password: '110299' })).body.sys, create: true })).body;
  await call({ op: 'authSwitch', room: adminRoom.room, playerId: adminRoom.state.you, mode: 'auth0' });

  // the admin's Auth0 account (saved once, as in production) is the only one that keeps the name
  const rows = _memRows();
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === 'admin') rows.splice(i, 1); // production already holds the Auth0 row, not a password-only one
  rows.push({ id: 900, kind: 'auth0', username: 'karthickkeyan303', username_key: 'karthickkeyan303', auth0_sub: 'auth0|mine', email: 'k@x.com', logins: 2, created_at: 1, last_login: 1 });
  const mine = await upsertAuth0({ sub: 'auth0|mine', email: 'k@x.com', name: 'karthickkeyan303' });
  assert.equal(mine, 'karthickkeyan303');
  const fake = await upsertAuth0({ sub: 'auth0|fake', email: 'karthickkeyan303@evil.com', name: 'karthickkeyan303' });
  assert.notEqual(fake, 'karthickkeyan303', 'the lookalike gets a different name');

  // what /api/auth0 would hand over: an admin ticket for the owner only
  const asOwner = await call({ op: 'login', ticket: makeTicket('*', mine, cfg, Date.now(), true) });
  assert.deepEqual([asOwner.code, asOwner.body.role, asOwner.body.name], [200, 'admin', 'karthickkeyan303']);
  const joined = await call({ op: 'join', sys: asOwner.body.sys, create: true });
  assert.equal(joined.body.state.admin, true, 'real admin in the room');
  assert.equal((await call({ op: 'shutdown', room: joined.body.room, playerId: joined.body.state.you, on: false })).code, 200, 'with the admin switches');

  const asFake = await call({ op: 'login', ticket: makeTicket('*', fake, cfg, Date.now(), false) });
  assert.equal(asFake.body.role, 'public');
  // a forged admin flag on a name that is not the admin's changes nothing
  const forged = await call({ op: 'login', ticket: makeTicket('*', fake, cfg, Date.now(), true) });
  assert.equal(forged.body.role, 'public');
  // password sign-in still works for the admin in Auth0 mode
  assert.equal((await call({ op: 'login', name: 'karthickkeyan303', password: '110299' })).body.role, 'admin');
  const row = _memRows().find((r) => r.auth0_sub === 'auth0|mine');
  assert.equal(row.is_admin, true);
  await call({ op: 'authSwitch', room: joined.body.room, playerId: joined.body.state.you, mode: 'current' });
});
