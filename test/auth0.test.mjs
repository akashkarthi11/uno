// The Auth0 switch: the admin chooses how public players sign in; the admin password works either way.
import test from 'node:test';
process.env.GAME_ADMIN_ANY_NAME = '1'; // these tests sign the admin in under made-up names; adminname.test.mjs checks the real rule
import assert from 'node:assert/strict';

process.env.AUTH0_DOMAIN = 'tenant.example.auth0.com';
process.env.AUTH0_CLIENT_ID = 'cid';
process.env.AUTH0_CLIENT_SECRET = 'not-a-real-secret';
const { default: handler } = await import('../api/game.js');
const { default: auth0Handler } = await import('../api/auth0.js');
const { makeTicket, makeState, auth0Config } = await import('../api/_lib/auth0.js');

const call = (body) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
  handler({ method: 'POST', body }, res);
});
const get = (url) => new Promise((resolve) => {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() { resolve({ code: this.statusCode, location: this.headers.Location }); } };
  auth0Handler({ url, headers: { host: 'game.test' } }, res);
});
const adminIn = async (room) => (await call({ op: 'join', room, name: 'Boss', password: '110299' })).body.state.you;

test('auth switch: only the real admin; the public password is refused in Auth0 mode; the admin password always works', async () => {
  const R = 'a0room';
  const admin = await adminIn(R);
  assert.equal((await call({ op: 'authInfo' })).body.mode, 'current');
  assert.equal((await call({ op: 'login', name: 'Pub', password: '123456' })).code, 200, 'public password works in current mode');

  const pub = (await call({ op: 'join', room: R, name: 'Pub2', password: '123456' })).body.state.you;
  assert.equal((await call({ op: 'authSwitch', room: R, playerId: pub, mode: 'auth0' })).code, 400, 'not the admin');
  assert.equal((await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'auth0' })).body.authMode, 'auth0');
  assert.equal((await call({ op: 'authInfo' })).body.mode, 'auth0');

  const refused = await call({ op: 'login', name: 'Pub3', password: '123456' });
  assert.equal(refused.code, 401);
  assert.equal(refused.body.error, 'Sign in with Auth0.');
  assert.equal((await call({ op: 'login', name: 'Boss', password: '110299' })).code, 200, 'admin password still works');
  assert.equal((await call({ op: 'login', name: 'Priv', password: '281101' })).code, 200, 'and the private password');

  const view = (await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state;
  assert.equal(view.authMode, 'auth0');
  assert.equal(view.auth0Ready, true);

  // a ticket from the callback signs in as a public player (no room); a forged, old or room-bound ticket does not
  const now = Date.now();
  const cfg = auth0Config();
  const signed = await call({ op: 'login', ticket: makeTicket('*', 'Asha', cfg, now) });
  assert.equal(signed.code, 200);
  assert.deepEqual([signed.body.name, signed.body.role], ['Asha', 'public']);
  assert.equal((await call({ op: 'login', ticket: makeTicket('*', 'Asha', cfg, now - 3 * 60 * 1000) })).code, 401, 'too old');
  assert.equal((await call({ op: 'login', ticket: makeTicket(R, 'Asha', cfg, now) })).code, 401, 'made for a room, not the system');
  assert.equal((await call({ op: 'login', ticket: 'abc.def' })).code, 401, 'forged');

  // ...and then joins the admin's room as a public player
  const joined = await call({ op: 'join', sys: signed.body.sys, room: R });
  assert.equal(joined.code, 200);
  assert.equal(joined.body.state.players.find((p) => p.id === joined.body.state.you).name, 'Asha');
  assert.equal(joined.body.state.admin, false);

  // a password session ends when the switch flips; the Auth0 one continues
  await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'current' });
  const pwLogin = await call({ op: 'login', name: 'Pub4', password: '123456' });
  const pwJoin = await call({ op: 'join', sys: pwLogin.body.sys, room: R });
  await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'auth0' });
  assert.equal((await call({ op: 'session', room: R, token: pwJoin.body.token })).code, 401, 'password session ends in Auth0 mode');
  assert.equal((await call({ op: 'join', sys: pwLogin.body.sys, room: R })).code, 401, 'and so does the password sign-in token');
  assert.equal((await call({ op: 'session', room: R, token: joined.body.token })).code, 200, 'Auth0 session continues');
  await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'current' });
});

test('the login redirect and the callback', async () => {
  const R = 'a0cb';
  const admin = await adminIn(R);
  assert.match((await get('/api/auth0')).location, /^\/\?a0err=/, 'off: back to the game with a message');
  await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'auth0' });
  const go = await get('/api/auth0');
  assert.equal(go.code, 302);
  const u = new URL(go.location);
  assert.equal(u.host, 'tenant.example.auth0.com');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://game.test/api/auth0');
  assert.match(u.searchParams.get('scope'), /email/);
  assert.ok(u.searchParams.get('state'));
  // a forged state is turned away, and a real state with a bad code fails cleanly (no network in tests)
  assert.match((await get('/api/auth0?code=x&state=forged.state')).location, /a0err=Sign-in\+expired/);
  const st = makeState('*', auth0Config(), Date.now());
  assert.match((await get('/api/auth0?code=bad&state=' + encodeURIComponent(st))).location, /a0err=/);
  await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'current' });
});

test('switching to Auth0 needs the keys', async () => {
  const keep = process.env.AUTH0_CLIENT_SECRET;
  delete process.env.AUTH0_CLIENT_SECRET;
  const R = 'a0nokeys';
  const admin = await adminIn(R);
  const r = await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'auth0' });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /not set up/);
  assert.equal((await call({ op: 'authInfo' })).body.mode, 'current');
  process.env.AUTH0_CLIENT_SECRET = keep;
});
