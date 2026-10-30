// The real admin's one button: no public sign-in anywhere and every public room closed; private rooms and the admin carry on.
process.env.GAME_DEAL = 'off';
import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/game.js';

function call(body) {
  return new Promise((resolve) => {
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
    handler({ method: 'POST', body }, res);
  });
}

test('shutdown: public sign-in stops everywhere and public rooms close; private rooms and the admin are untouched; it can be undone', async () => {
  const P = 'pub' + (Date.now() % 100000), V = 'prv' + (Date.now() % 100000);
  const admin = await call({ op: 'join', room: P, name: 'Boss', password: '110299' });
  const aid = admin.body.state.you;
  const pat = await call({ op: 'join', room: P, name: 'Pat', password: '123456' });
  const co = await call({ op: 'join', room: P, name: 'Co', password: '12345678' });
  const vadmin = (await call({ op: 'join', room: V, name: 'Boss2', password: '110299' })).body.state.you;
  await call({ op: 'private', room: V, playerId: vadmin, on: true });
  const priv = await call({ op: 'join', room: V, name: 'Priv', password: '281101' });
  assert.equal(admin.body.state.shutdown, false, 'the admin is told it is off');

  // nobody but the real admin can press it
  for (const who of [pat, co]) assert.equal((await call({ op: 'shutdown', room: P, playerId: who.body.state.you, on: true })).code, 400);
  assert.equal((await call({ op: 'state', room: P, playerId: pat.body.state.you })).body.state.players.length, 3, 'nothing happened');

  const down = await call({ op: 'shutdown', room: P, playerId: aid, on: true });
  assert.equal(down.code, 200);
  assert.ok(down.body.closed >= 1, 'a public room was closed');

  // public players are told the system is down, in any room, new or old
  for (const [room, pw] of [[P, '123456'], ['brandnew' + P, '123456'], [P, '12345678']]) {
    const r = await call({ op: 'join', room, name: 'Late', password: pw });
    assert.equal(r.code, 401, room + ' ' + pw);
    assert.equal(r.body.error, 'System down');
  }
  assert.equal((await call({ op: 'session', room: P, token: pat.body.token })).code, 401, 'a refresh does not get them back in');
  assert.equal((await call({ op: 'session', room: P, token: co.body.token })).code, 401);
  assert.equal((await call({ op: 'state', room: P, playerId: pat.body.state.you })).body.closed, true, 'their room was closed');

  // private rooms, private players and the admin are not affected
  assert.equal((await call({ op: 'state', room: V, playerId: priv.body.state.you })).code, 200);
  assert.equal((await call({ op: 'join', room: V, name: 'Priv2', password: '281101' })).code, 200);
  assert.equal((await call({ op: 'join', room: P, name: 'Boss', password: '110299' })).code, 200, 'the admin can still sign in');
  assert.equal((await call({ op: 'rooms', room: V, playerId: vadmin })).body.shutdown, true);

  // open again
  assert.equal((await call({ op: 'shutdown', room: V, playerId: vadmin, on: false })).code, 200);
  assert.equal((await call({ op: 'join', room: P, name: 'Back', password: '123456' })).code, 200, 'public players can sign in again');
});

test('observer switch: off removes every observer and blocks the account; on lets it back; only the real admin', async () => {
  const R = 'obsw' + (Date.now() % 100000), R2 = 'obsx' + (Date.now() % 100000);
  const admin = (await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state.you;
  const pat = await call({ op: 'join', room: R, name: 'Pat', password: '123456' });
  const o1 = await call({ op: 'join', room: R, name: 'x', password: '1102' });
  const o2 = await call({ op: 'join', room: R2, name: 'x', password: '1102' });
  assert.equal(o1.code, 200);
  const list = (await call({ op: 'rooms', room: R, playerId: admin })).body;
  assert.equal(list.observerOff, false);
  assert.equal(list.rooms.find((r) => r.code === R).observers, 1, 'the admin sees who is observing');
  assert.equal(JSON.stringify(list.rooms.find((r) => r.code === R).names).includes('Observer'), false);

  assert.equal((await call({ op: 'observerSwitch', room: R, playerId: pat.body.state.you, off: true })).code, 400, 'a player cannot');
  assert.equal((await call({ op: 'observerSwitch', room: R, playerId: o1.body.state.you, off: true })).code, 400, 'nor an observer');

  const off = await call({ op: 'observerSwitch', room: R, playerId: admin, off: true });
  assert.equal(off.code, 200);
  assert.equal(off.body.removed, 2, 'both observers, in two rooms');
  assert.equal((await call({ op: 'state', room: R, playerId: o1.body.state.you })).body.kicked, true, 'they are told they were removed');
  assert.equal((await call({ op: 'state', room: R2, playerId: o2.body.state.you })).body.kicked, true);
  assert.equal((await call({ op: 'join', room: R, name: 'x', password: '1102' })).code, 401, 'the account cannot sign in');
  assert.equal((await call({ op: 'session', room: R, token: o1.body.token })).code, 401);
  assert.equal((await call({ op: 'state', room: R, playerId: pat.body.state.you })).code, 200, 'players are not affected');
  assert.equal((await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state.observerOff, true);

  assert.equal((await call({ op: 'observerSwitch', room: R, playerId: admin, off: false })).code, 200);
  assert.equal((await call({ op: 'join', room: R, name: 'x', password: '1102' })).code, 200, 'back on');
});
