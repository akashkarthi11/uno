import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../api/_lib/game.js';
import handler from '../api/game.js';

function playOut(n) {
  const s = G.newRoom('t');
  let now = 1000;
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(G.join(s, { name: 'P' + i, admin: i === 0 }, now));
  G.act(s, ps[0], { op: 'start' }, now);
  for (const p of ps) assert.equal(p.hand.length, 5);
  let guard = 0;
  while (!s.over) {
    assert.ok(guard++ < 5000, 'game did not finish');
    now += 100;
    ps.forEach((p) => { p.lastSeen = now; });
    const cur = ps.find((p) => p.id === s.seats[s.cur]);
    if (cur.hand.length <= 2 && !cur.saidUno) G.act(s, cur, { op: 'uno' }, now); // call it like a real player
    const v = G.view(s, cur, now);
    if (v.playable.length) {
      const c = v.hand.find((h) => h.id === v.playable[0]);
      G.act(s, cur, { op: 'play', cardId: c.id, color: c.color === 'wild' ? 'blue' : undefined }, now);
    } else if (s.drawnId != null) {
      G.act(s, cur, { op: 'pass' }, now);
    } else {
      G.act(s, cur, { op: 'draw' }, now);
    }
    const total = s.deck.length + s.discard.length + s.members.reduce((a, m) => a + m.hand.length, 0);
    assert.equal(total, 108, 'card count must stay 108');
  }
  return s;
}

test('games finish with exactly one loser, for 2-6 players', () => {
  for (let n = 2; n <= 6; n++) {
    for (let g = 0; g < 40; g++) {
      const s = playOut(n);
      assert.equal(s.ranking.length, n - 1);
      assert.ok(s.loser, 'a loser exists');
      assert.equal(s.winner, s.ranking[0]);
      assert.ok(!s.ranking.includes(s.loser));
    }
  }
});

test('only the admin can start; needs 2 players', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'A', admin: true }, now);
  assert.throws(() => G.act(s, admin, { op: 'start' }, now), /At least 2/);
  const p = G.join(s, { name: 'B', admin: false }, now);
  assert.throws(() => G.act(s, p, { op: 'start' }, now), /Only the admin/);
  G.act(s, admin, { op: 'start' }, now);
  assert.equal(s.started, true);
});

test('wild draw four is refused while holding the current colour', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const a = G.join(s, { name: 'A', admin: true }, now);
  G.join(s, { name: 'B', admin: false }, now);
  G.act(s, a, { op: 'start' }, now);
  const cur = s.members.find((m) => m.id === s.seats[s.cur]);
  cur.hand = [{ id: 900, color: 'wild', value: 'wild4' }, { id: 901, color: s.color, value: '5' }];
  assert.throws(() => G.act(s, cur, { op: 'play', cardId: 900, color: 'red' }, now), /Wild Draw Four/);
});

test('offline player is auto-played so the table never stalls', () => {
  const s = G.newRoom('t');
  let now = 1000;
  const a = G.join(s, { name: 'A', admin: true }, now);
  const b = G.join(s, { name: 'B', admin: false }, now);
  const c = G.join(s, { name: 'C', admin: false }, now);
  G.act(s, a, { op: 'start' }, now);
  s.cur = s.seats.indexOf(b.id);
  now += 25000; // B goes quiet; A and C keep polling
  a.lastSeen = now;
  c.lastSeen = now;
  assert.equal(G.tick(s, now), true);
  assert.notEqual(s.seats[s.cur], b.id);
});

test('admin can swap a card for a special one; players cannot', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'A', admin: true }, now);
  const player = G.join(s, { name: 'B', admin: false }, now);
  G.act(s, admin, { op: 'start' }, now);
  const target = admin.hand[0];
  G.act(s, admin, { op: 'swap', cardId: target.id, value: 'wild4', color: 'wild' }, now);
  assert.equal(admin.hand.length, 5);
  assert.ok(admin.hand.some((c) => c.value === 'wild4'));
  assert.ok(!admin.hand.some((c) => c.id === target.id));
  assert.ok(s.deck.some((c) => c.id === target.id), 'old card returns to the draw pile');
  assert.throws(() => G.act(s, player, { op: 'swap', cardId: player.hand[0].id, value: 'skip', color: 'red' }, now), /Admin only/);
  assert.throws(() => G.act(s, admin, { op: 'swap', cardId: admin.hand[0].id, value: '7', color: 'red' }, now), /special/);
});

function call(body) {
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
    handler({ method: 'POST', body }, res);
  });
}

test('API: password gate and admin start', async () => {
  const bad = await call({ op: 'join', room: 'api1', name: 'X', password: 'nope' });
  assert.equal(bad.code, 401);
  const p = await call({ op: 'join', room: 'api1', name: 'P', password: '123456' });
  const a = await call({ op: 'join', room: 'api1', name: 'A', password: '110299' });
  assert.equal(p.code, 200);
  const deny = await call({ op: 'start', room: 'api1', playerId: p.body.state.you });
  assert.equal(deny.code, 400);
  const ok = await call({ op: 'start', room: 'api1', playerId: a.body.state.you });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.state.hand.length, 5);
  const poll = await call({ op: 'state', room: 'api1', playerId: a.body.state.you, since: ok.body.state.version });
  assert.equal(poll.body.unchanged, true);
});
