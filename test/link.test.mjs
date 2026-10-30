// Linking an own-login account to an Auth0 account: proved with the old password, data merged, renamed when the Auth0 name is free.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GAME_USERS_MEMORY = '1';
process.env.AUTH0_DOMAIN = 'tenant.example.auth0.com';
process.env.AUTH0_CLIENT_ID = 'cid';
process.env.AUTH0_CLIENT_SECRET = 'not-a-real-secret';
const { default: handler } = await import('../api/game.js');
const { makeTicket, auth0Config } = await import('../api/_lib/auth0.js');
const { upsertAuth0, _memRows } = await import('../api/_lib/users.js');
const cfg = auth0Config();

const call = (body) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
  handler({ method: 'POST', body }, res);
});
const rows = () => _memRows();
const own = async (name, pw) => { await call({ op: 'login', name, password: '123456', newPassword: pw }); return (await call({ op: 'login', name, password: pw })).body; };
/** Signs in the way /api/auth0 hands over: saves the Auth0 user, then a ticket with the name and id. */
const viaAuth0 = async (sub, name) => {
  const saved = await upsertAuth0({ sub, email: sub + '@x.com', name });
  return (await call({ op: 'login', ticket: makeTicket('*', saved, cfg, Date.now(), false, sub) })).body;
};
const admin = async () => {
  const sys = (await call({ op: 'login', name: 'karthi', password: '110299' })).body.sys;
  const made = (await call({ op: 'join', sys, create: true })).body;
  return { room: made.room, id: made.state.you };
};

test('link: proved with the old password; renamed to the Auth0 name when it is free, else the old name is kept; one account, one row', async () => {
  const a = await admin();
  await call({ op: 'authSwitch', room: a.room, playerId: a.id, mode: 'current' });
  await own('Asha', 'asha-pw-1');
  await own('Ravi', 'ravi-pw-12');
  await call({ op: 'authSwitch', room: a.room, playerId: a.id, mode: 'auth0' });

  const ashaRow = () => rows().find((r) => r.username_key === 'asha');
  const before = ashaRow().logins;

  // Auth0 user "asha.k" (free name) links the old "Asha" account
  const me = await viaAuth0('auth0|ak', 'asha.k');
  assert.equal(me.a0, true);
  assert.equal((await call({ op: 'linkAccount', sys: me.sys, username: 'Asha', password: 'wrong' })).body.error, 'Wrong username or password.');
  assert.equal((await call({ op: 'linkAccount', sys: me.sys, username: 'nobody', password: 'x' })).body.error, 'Wrong username or password.', 'no hint whether the name exists');
  const linked = await call({ op: 'linkAccount', sys: me.sys, username: 'asha', password: 'asha-pw-1' });
  assert.equal(linked.code, 200);
  assert.deepEqual([linked.body.name, linked.body.renamed], ['asha.k', true]);

  const merged = rows().find((r) => r.auth0_sub === 'auth0|ak');
  assert.equal(merged.username, 'asha.k');
  assert.ok(merged.pw_hash, 'the old password came along');
  assert.ok(merged.logins >= before + 1, 'the sign-in counts were added');
  assert.equal(rows().filter((r) => r.username_key === 'asha').length, 0, 'the old own-login row is gone; its name is free');
  assert.equal(rows().filter((r) => r.username_key === 'asha.k').length, 1, 'one account, one row');

  // the fresh sys token carries the new name into rooms
  const made = await call({ op: 'join', sys: linked.body.sys, create: true });
  assert.equal(made.body.state.players.find((p) => p.id === made.body.state.you).name, 'asha.k');
  // it cannot be linked twice
  assert.equal((await call({ op: 'linkAccount', sys: linked.body.sys, username: 'Ravi', password: 'ravi-pw-12' })).body.error, 'This account is already linked to an own login.');
  // and the own-login row cannot be linked to a second Auth0 account any more (it is gone)
  const other = await viaAuth0('auth0|other', 'someone');
  assert.equal((await call({ op: 'linkAccount', sys: other.sys, username: 'Asha', password: 'asha-pw-1' })).body.error, 'Wrong username or password.');

  // when the Auth0 name is already used by another account the old name is kept
  const taken = await viaAuth0('auth0|rv', 'asha.k'); // asha.k belongs to the merged account: this one is "asha.k 2"
  assert.notEqual(taken.name, 'asha.k');
  const keep = await call({ op: 'linkAccount', sys: taken.sys, username: 'Ravi', password: 'ravi-pw-12' });
  assert.equal(keep.body.renamed, false, 'the Auth0 name is taken, so no rename');
  assert.equal(keep.body.name, 'Ravi', 'the old own-login name is kept');
  assert.equal(rows().filter((r) => r.username_key === 'ravi').length, 1);

  // the merged account also signs in with the old password, under its (new) username, when Auth0 mode is off
  await call({ op: 'authSwitch', room: a.room, playerId: a.id, mode: 'current' });
  const pw = await call({ op: 'login', name: 'ASHA.K', password: 'asha-pw-1' });
  assert.equal(pw.code, 200);
  assert.equal(pw.body.name, 'asha.k');
  assert.equal((await call({ op: 'login', name: 'asha.k', password: '123456' })).code, 401, 'the shared password never opens it');
  await call({ op: 'authSwitch', room: a.room, playerId: a.id, mode: 'auth0' });
});

test('only Auth0 public sign-ins can link; the admin account and password sign-ins cannot', async () => {
  const a = await admin();
  await call({ op: 'authSwitch', room: a.room, playerId: a.id, mode: 'current' });
  const pwUser = await own('Meena', 'meena-pw-1');
  assert.equal((await call({ op: 'linkAccount', sys: pwUser.sys, username: 'Meena', password: 'meena-pw-1' })).code, 400, 'not signed in with Auth0');
  assert.equal((await call({ op: 'linkAccount', sys: 'forged.token', username: 'a', password: 'b' })).code, 401);
  // the admin's own Auth0 account cannot be linked to anything
  rows().push({ id: 901, kind: 'auth0', username: 'karthi', username_key: 'karthi', auth0_sub: 'auth0|adm', auth0_name: 'karthi', logins: 1, created_at: 1, last_login: 1, is_admin: true });
  await call({ op: 'authSwitch', room: a.room, playerId: a.id, mode: 'auth0' });
  const adm = (await call({ op: 'login', ticket: makeTicket('*', 'karthi', cfg, Date.now(), true, 'auth0|adm') })).body;
  assert.equal(adm.role, 'admin');
  assert.equal((await call({ op: 'linkAccount', sys: adm.sys, username: 'Meena', password: 'meena-pw-1' })).code, 400, 'the admin is not a public sign-in');
  await call({ op: 'authSwitch', room: a.room, playerId: a.id, mode: 'current' });
});
