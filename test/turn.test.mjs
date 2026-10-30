import test from 'node:test';
process.env.GAME_ADMIN_ANY_NAME = '1'; // these tests sign the admin in under made-up names; adminname.test.mjs checks the real rule
import assert from 'node:assert/strict';
import http from 'node:http';

// A stand-in for Cloudflare's credential service.
let mode = 'ok';
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    assert.match(req.url, /^\/v1\/turn\/keys\/KEY123\/credentials\/generate-ice-servers$/);
    assert.equal(req.headers.authorization, 'Bearer TOKEN456');
    if (mode === 'fail') { res.statusCode = 500; return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u1', credential: 'c1' },
    ] }));
  });
});
await new Promise((r) => server.listen(0, r));
process.env.CF_TURN_KEY_ID = 'KEY123';
process.env.CF_TURN_API_TOKEN = 'TOKEN456';
process.env.CF_TURN_API = `http://127.0.0.1:${server.address().port}`;
const { default: handler } = await import('../api/game.js');

const call = (b) => new Promise((resolve) => {
  const res = { headers: {}, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code || 200, body: o }); } };
  handler({ method: 'POST', body: b }, res);
});

test('relay credentials are minted by the server, handed to voice users only, and cached', async () => {
  const room = 'turn' + Math.floor(Math.random() * 1e6);
  const admin = await call({ op: 'join', room, name: 'A', password: '110299' });
  assert.equal(admin.body.state.settings.voiceRelay, false, 'relay is off by default (the original direct way)');
  assert.ok(!admin.body.state.iceServers.some((s) => s.username), 'off: no relay entry is handed out');
  const switched = await call({ op: 'config', room, playerId: admin.body.state.you, voiceRelay: true });
  const ice = switched.body.state.iceServers;
  const relay = ice.find((s) => s.username);
  assert.ok(relay, 'a relay entry is present');
  assert.equal(relay.username, 'u1');
  assert.ok(ice.some((s) => String(s.urls).includes('stun.l.google.com')), 'our own STUN servers stay');
  const pub = await call({ op: 'join', room, name: 'P', password: '123456' });
  assert.equal(pub.body.state.iceServers, undefined, 'public players get no voice details');
  const refused = await call({ op: 'config', room, playerId: pub.body.state.you, voiceRelay: false });
  assert.equal(refused.code, 400, 'an ordinary player cannot switch the route');
  const back = await call({ op: 'config', room, playerId: admin.body.state.you, voiceRelay: false });
  assert.ok(!back.body.state.iceServers.some((s) => s.username), 'switched off again: relay entries disappear');
  await call({ op: 'config', room, playerId: admin.body.state.you, voiceRelay: true });
  await call({ op: 'state', room, playerId: admin.body.state.you });
  assert.equal(hits, 1, 'minted once, then served from the cache');
});

test('the game keeps working (and keeps the cached relay entry) after the relay service goes away', async () => {
  server.close();
  const room = 'turn' + Math.floor(Math.random() * 1e6);
  const admin = await call({ op: 'join', room, name: 'A', password: '110299' });
  assert.equal(admin.code, 200);
  assert.ok(admin.body.state.iceServers.length >= 1);
});
