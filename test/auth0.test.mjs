// The Auth0 switch: the admin chooses how public players sign in; the admin password works either way.
import test from 'node:test';
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

test('auth switch: only the real admin; public password refused in Auth0 mode; admin password always works', async () => {
  const R = 'a0room';
  const admin = (await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state.you;
  assert.equal((await call({ op: 'authInfo', room: R })).body.mode, 'current');
  assert.equal((await call({ op: 'join', room: R, name: 'Pub', password: '123456' })).code, 200, 'public password works in current mode');

  const pub = (await call({ op: 'join', room: R, name: 'Pub2', password: '123456' })).body.state.you;
  assert.equal((await call({ op: 'authSwitch', room: R, playerId: pub, mode: 'auth0' })).code, 400, 'not the admin');
  assert.equal((await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'auth0' })).body.authMode, 'auth0');
  assert.equal((await call({ op: 'authInfo', room: R })).body.mode, 'auth0');

  const refused = await call({ op: 'join', room: R, name: 'Pub3', password: '123456' });
  assert.equal(refused.code, 401);
  assert.equal(refused.body.error, 'Sign in with Auth0.');
  assert.equal((await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).code, 200, 'admin password still works');

  const view = (await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state;
  assert.equal(view.authMode, 'auth0');
  assert.equal(view.auth0Ready, true);

  // a ticket from the callback joins as a public player; a wrong-room, forged or old ticket does not
  const now = Date.now();
  const cfg = auth0Config();
  const joined = await call({ op: 'join', room: R, name: 'x', ticket: makeTicket(R, 'Asha', cfg, now) });
  assert.equal(joined.code, 200);
  assert.equal(joined.body.state.players.find((p) => p.id === joined.body.state.you).name, 'Asha');
  assert.equal(joined.body.state.admin, false);
  assert.equal((await call({ op: 'join', room: 'other', ticket: makeTicket(R, 'Asha', cfg, now) })).code, 401, 'wrong room');
  assert.equal((await call({ op: 'join', room: R, ticket: makeTicket(R, 'Asha', cfg, now - 3 * 60 * 1000) })).code, 401, 'too old');
  assert.equal((await call({ op: 'join', room: R, ticket: 'abc.def' })).code, 401, 'forged');

  // a session from the password sign-in ends when the switch flips; the Auth0 one stays
  const oldTok = (await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'current' })).code;
  assert.equal(oldTok, 200);
  const back = await call({ op: 'join', room: R, name: 'Pub4', password: '123456' });
  assert.equal(back.code, 200, 'password sign-in is back');
  await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'auth0' });
  assert.equal((await call({ op: 'session', room: R, token: back.body.token })).code, 401, 'password session ends in Auth0 mode');
  assert.equal((await call({ op: 'session', room: R, token: joined.body.token })).code, 200, 'Auth0 session continues');
  await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'current' });
});

test('the login redirect and the callback', async () => {
  const R = 'a0cb';
  const admin = (await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state.you;
  assert.match((await get('/api/auth0?room=' + R)).location, /^\/\?room=a0cb&a0err=/, 'off: back to the game with a message');
  await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'auth0' });
  const go = await get('/api/auth0?room=' + R);
  assert.equal(go.code, 302);
  const u = new URL(go.location);
  assert.equal(u.host, 'tenant.example.auth0.com');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://game.test/api/auth0');
  assert.ok(u.searchParams.get('state'));
  // a forged state is turned away, and a real state with a bad code fails cleanly (no network in tests)
  assert.match((await get('/api/auth0?code=x&state=forged.state')).location, /a0err=Sign-in\+expired/);
  const st = makeState(R, auth0Config(), Date.now());
  assert.match((await get('/api/auth0?code=bad&state=' + encodeURIComponent(st))).location, /a0err=/);
  await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'current' });
});

test('switching to Auth0 needs the keys', async () => {
  const keep = process.env.AUTH0_CLIENT_SECRET;
  delete process.env.AUTH0_CLIENT_SECRET;
  const R = 'a0nokeys';
  const admin = (await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state.you;
  const r = await call({ op: 'authSwitch', room: R, playerId: admin, mode: 'auth0' });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /not set up/);
  assert.equal((await call({ op: 'authInfo', room: R })).body.mode, 'current');
  process.env.AUTH0_CLIENT_SECRET = keep;
});
