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

test('admin can choose the special card they pick up; players cannot', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'A', admin: true }, now);
  const player = G.join(s, { name: 'B', admin: false }, now);
  G.act(s, admin, { op: 'start' }, now);
  const deckBefore = s.deck.length;

  s.cur = s.seats.indexOf(player.id);
  assert.throws(() => G.act(s, player, { op: 'draw', value: 'skip', color: 'red' }, now), /Admin only/);
  assert.equal(player.hand.length, 5, 'refused attempt changes nothing');

  s.cur = s.seats.indexOf(admin.id);
  assert.throws(() => G.act(s, admin, { op: 'draw', value: '7', color: 'red' }, now), /special/);
  G.act(s, admin, { op: 'draw', value: 'wild4', color: 'wild' }, now);
  assert.equal(admin.hand.length, 6);
  assert.ok(admin.hand.some((c) => c.value === 'wild4'));
  assert.equal(s.deck.length, deckBefore, 'the pile itself is untouched');
});

test('admin restart returns everyone to the lobby; mid-game joiner is a spectator without cards', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'A', admin: true }, now);
  const player = G.join(s, { name: 'B', admin: false }, now);
  G.act(s, admin, { op: 'start' }, now);

  const late = G.join(s, { name: 'Late', admin: false }, now);
  const lateView = G.view(s, late, now);
  assert.equal(lateView.seated, false);
  assert.equal(lateView.hand.length, 0);
  assert.equal(lateView.started, true);
  assert.ok(lateView.players.every((p) => p.id !== late.id));
  assert.ok(lateView.players.every((p) => typeof p.count === 'number' && !('hand' in p)), 'opponents show counts only');

  assert.throws(() => G.act(s, player, { op: 'lobby' }, now), /Only the admin/);
  G.act(s, admin, { op: 'lobby' }, now);
  const v = G.view(s, player, now);
  assert.equal(v.started, false);
  assert.equal(v.players.length, 3);
  assert.ok(s.members.every((m) => m.hand.length === 0));

  G.act(s, admin, { op: 'start' }, now); // late joiner is dealt in next game
  assert.equal(late.hand.length, 5);
});

test('admin can remove players in the lobby and mid-game; the game stays consistent', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'A', admin: true }, now);
  const b = G.join(s, { name: 'B', admin: false }, now);
  const c = G.join(s, { name: 'C', admin: false }, now);
  const d = G.join(s, { name: 'D', admin: false }, now);
  assert.throws(() => G.act(s, b, { op: 'kick', targetId: c.id }, now), /Only the admin/);
  assert.throws(() => G.act(s, admin, { op: 'kick', targetId: admin.id }, now), /cannot remove an admin/);

  G.act(s, admin, { op: 'kick', targetId: d.id }, now); // lobby removal
  assert.equal(s.members.length, 3);
  assert.ok(s.kicked.includes(d.id));

  G.act(s, admin, { op: 'start' }, now);
  const total = () => s.deck.length + s.discard.length + s.members.reduce((a, m) => a + m.hand.length, 0);
  assert.equal(total(), 108);
  s.cur = s.seats.indexOf(b.id); // remove the player whose turn it is
  G.act(s, admin, { op: 'kick', targetId: b.id }, now);
  assert.equal(s.seats.length, 2);
  assert.ok(!s.members.some((m) => m.id === b.id));
  assert.ok(s.seats[s.cur] !== undefined && !s.over);
  assert.equal(total(), 108, 'removed player\'s cards return to the pile');

  G.act(s, admin, { op: 'kick', targetId: c.id }, now); // leaves only the admin
  assert.equal(s.over, true);
});

test('a turn left idle for 30s passes to the next player without playing or drawing', () => {
  const s = G.newRoom('t');
  let now = 1000;
  const a = G.join(s, { name: 'A', admin: true }, now);
  const b = G.join(s, { name: 'B', admin: false }, now);
  G.act(s, a, { op: 'start' }, now);
  const idleId = s.seats[s.cur];

  now += 29000;
  a.lastSeen = b.lastSeen = now;
  assert.equal(G.tick(s, now), false, 'still within 30s');
  assert.ok(G.view(s, a, now).turnLeft <= 1000);

  now += 2000;
  a.lastSeen = b.lastSeen = now;
  assert.equal(G.tick(s, now), true);
  assert.notEqual(s.seats[s.cur], idleId, 'turn moved on');
  assert.ok(s.log.some((l) => /ran out of time/.test(l)));
  const idle = s.members.find((m) => m.id === idleId);
  assert.equal(idle.hand.length, 5, 'the idle player kept their 5 cards: nothing played or drawn');

  // a timeout after drawing a playable card also just passes; the drawn card stays in hand
  const p = s.members.find((m) => m.id === s.seats[s.cur]);
  s.color = 'red';
  s.discard.push({ id: 7000, color: 'red', value: '4' });
  const drawn = { id: 7001, color: 'red', value: '8' };
  p.hand = [{ id: 7002, color: 'red', value: '1' }, drawn];
  s.drawnId = drawn.id;
  s.turnAt = now;
  now += 31000;
  a.lastSeen = b.lastSeen = now;
  G.tick(s, now);
  assert.notEqual(s.seats[s.cur], p.id, 'turn moved on');
  assert.equal(s.drawnId, null);
  assert.ok(p.hand.some((c) => c.id === 7001) && p.hand.some((c) => c.id === 7002), 'both cards stay in hand');
});

function twoCardSetup() {
  const s = G.newRoom('t');
  const now = 1000;
  const a = G.join(s, { name: 'A', admin: true }, now);
  G.join(s, { name: 'B', admin: false }, now);
  G.act(s, a, { op: 'start' }, now);
  const p = s.members.find((m) => m.id === s.seats[s.cur]);
  s.color = 'red';
  s.discard.push({ id: 8000, color: 'red', value: '3' });
  p.hand = [{ id: 8001, color: 'red', value: '9' }, { id: 8002, color: 'blue', value: '2' }];
  p.saidUno = false;
  return { s, p, now };
}

test('GrowX! button: playing the second-to-last card without pressing it costs 1 extra card', () => {
  const { s, p, now } = twoCardSetup();
  G.act(s, p, { op: 'play', cardId: 8001 }, now);
  assert.equal(p.hand.length, 2, 'one card left + 1 penalty card');
  assert.ok(s.log.some((l) => /forgot to press GrowX/.test(l)));
});

test('GrowX! button: pressing it before the second-to-last card avoids the penalty', () => {
  const { s, p, now } = twoCardSetup();
  G.act(s, p, { op: 'uno' }, now);
  G.act(s, p, { op: 'play', cardId: 8001 }, now);
  assert.equal(p.hand.length, 1);
});

test('admin chosen card with no matching colour is kept and turn passes when unplayable', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'A', admin: true }, now);
  G.join(s, { name: 'B', admin: false }, now);
  G.act(s, admin, { op: 'start' }, now);
  s.cur = s.seats.indexOf(admin.id);
  s.color = 'red';
  s.discard.push({ id: 5000, color: 'red', value: '3' });
  admin.hand = [{ id: 5001, color: 'red', value: '9' }]; // holds red, so a Wild Draw Four is illegal
  G.act(s, admin, { op: 'draw', value: 'wild4', color: 'wild' }, now);
  assert.equal(admin.hand.length, 2);
  assert.notEqual(s.seats[s.cur], admin.id, 'unplayable draw passes the turn');
});

function call(body) {
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
    handler({ method: 'POST', body }, res);
  });
}

test('API: public games admit public players, private games admit private players only', async () => {
  const room = 'priv' + Math.floor(Math.random() * 1e6);
  const admin = await call({ op: 'join', room, name: 'Boss', password: '110299' });
  const early = await call({ op: 'join', room, name: 'Early', password: '123456' });
  assert.equal(early.code, 200);
  assert.equal((await call({ op: 'private', room, playerId: early.body.state.you, on: true })).code, 400, 'players cannot');
  const set = await call({ op: 'private', room, playerId: admin.body.state.you, on: true });
  assert.equal(set.body.state.private, true);

  const refused = await call({ op: 'join', room, name: 'New', password: '123456' });
  assert.equal(refused.code, 401, 'player password no longer enough');
  assert.equal(refused.body.error, 'Ask the admin to start the game and share the private password.');
  assert.equal((await call({ op: 'join', room, name: 'New', password: 'nope' })).body.error, 'Wrong password.');
  const joined = await call({ op: 'join', room, name: 'New', password: '281101' });
  assert.equal(joined.code, 200);
  const back = await call({ op: 'join', room, name: 'Early', password: '123456', playerId: early.body.state.you });
  assert.equal(back.code, 401, 'a public player cannot get back into a game that became private');
  assert.equal((await call({ op: 'join', room, name: 'Boss', password: '110299', playerId: admin.body.state.you })).code, 200, 'admin always');

  assert.equal((await call({ op: 'join', room: room + 'x', name: 'N', password: '281101' })).code, 401, 'private players cannot enter a public game');
  await call({ op: 'private', room, playerId: admin.body.state.you, on: false });
  assert.equal((await call({ op: 'join', room, name: 'Late', password: '123456' })).code, 200, 'public again');
});

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
