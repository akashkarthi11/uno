import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../api/_lib/game.js';
const DECK_SIZE = 118; // 108 classic cards + 10 super cards
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
      const other = ps.find((p) => p !== cur && !p.finished);
      G.act(s, cur, { op: 'play', cardId: c.id, color: c.color === 'wild' ? 'blue' : undefined, target: other.id }, now);
    } else if (s.drawnId != null) {
      G.act(s, cur, { op: 'pass' }, now);
    } else {
      G.act(s, cur, { op: 'draw' }, now);
    }
    const total = s.deck.length + s.discard.length + s.members.reduce((a, m) => a + m.hand.length, 0);
    assert.equal(total, DECK_SIZE, 'card count must stay constant');
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
  assert.equal(total(), DECK_SIZE);
  s.cur = s.seats.indexOf(b.id); // remove the player whose turn it is
  G.act(s, admin, { op: 'kick', targetId: b.id }, now);
  assert.equal(s.seats.length, 2);
  assert.ok(!s.members.some((m) => m.id === b.id));
  assert.ok(s.seats[s.cur] !== undefined && !s.over);
  assert.equal(total(), DECK_SIZE, 'removed player\'s cards return to the pile');

  G.act(s, admin, { op: 'kick', targetId: c.id }, now); // leaves only the admin
  assert.equal(s.over, true);
});

test('a turn left idle for 30s: the player draws 1 penalty card and the turn moves on', () => {
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
  assert.equal(idle.hand.length, 6, 'the idle player got 1 extra card (5 + 1)');
  assert.ok(s.log.some((l) => /draws 1 card/.test(l)));

  // a timeout after already drawing a card passes without a second penalty; the drawn card stays in hand
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
  assert.equal(p.hand.length, 2, 'no extra penalty card after already drawing');
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

function threePlayers(handFor) {
  const s = G.newRoom('t');
  const now = 1000;
  const a = G.join(s, { name: 'A', admin: true }, now);
  const b = G.join(s, { name: 'B', admin: false }, now);
  const c = G.join(s, { name: 'C', admin: false }, now);
  G.act(s, a, { op: 'start' }, now);
  const p = s.members.find((m) => m.id === s.seats[s.cur]);
  s.color = 'red';
  s.discard.push({ id: 9000, color: 'red', value: '3' });
  p.hand = handFor;
  const others = [a, b, c].filter((m) => m !== p);
  return { s, p, others, now };
}

test('super cards: the deck has 118 cards including the 10 new ones', () => {
  const s = G.newRoom('t');
  const a = G.join(s, { name: 'A', admin: true }, 1000);
  G.join(s, { name: 'B', admin: false }, 1000);
  G.act(s, a, { op: 'start' }, 1000);
  const all = [...s.deck, ...s.discard, ...s.members.flatMap((m) => m.hand)];
  assert.equal(all.length, DECK_SIZE);
  const count = (v) => all.filter((c) => c.value === v).length;
  assert.deepEqual([count('again'), count('blast'), count('swap'), count('gift')], [4, 2, 2, 2]);
  assert.ok(!['again', 'blast', 'swap', 'gift'].includes(s.discard[0].value), 'the first card is never a super card');
});

test('super card 🔁 Play Again: the same player takes another turn', () => {
  const { s, p, now } = threePlayers([
    { id: 9101, color: 'red', value: 'again' }, { id: 9102, color: 'blue', value: '2' }, { id: 9103, color: 'green', value: '5' },
  ]);
  G.act(s, p, { op: 'play', cardId: 9101 }, now);
  assert.equal(s.seats[s.cur], p.id, 'still their turn');
  assert.equal(p.hand.length, 2);
  assert.equal(s.color, 'red');
});

test('super card 💥 Blast: every other player draws 1, then the turn moves on', () => {
  const { s, p, others, now } = threePlayers([
    { id: 9201, color: 'wild', value: 'blast' }, { id: 9202, color: 'blue', value: '2' }, { id: 9203, color: 'green', value: '5' },
  ]);
  assert.throws(() => G.act(s, p, { op: 'play', cardId: 9201 }, now), /Choose a colour/);
  G.act(s, p, { op: 'play', cardId: 9201, color: 'blue' }, now);
  assert.deepEqual(others.map((o) => o.hand.length), [6, 6]);
  assert.equal(p.hand.length, 2);
  assert.equal(s.color, 'blue');
  assert.notEqual(s.seats[s.cur], p.id);
});

test('super card 🔄 Swap Hands: needs a target, then the two hands trade places', () => {
  const { s, p, others, now } = threePlayers([
    { id: 9301, color: 'wild', value: 'swap' }, { id: 9302, color: 'blue', value: '2' }, { id: 9303, color: 'green', value: '5' },
  ]);
  const target = others[0];
  const targetCards = target.hand.map((c) => c.id).sort();
  assert.throws(() => G.act(s, p, { op: 'play', cardId: 9301, color: 'blue' }, now), /Choose a player/);
  assert.throws(() => G.act(s, p, { op: 'play', cardId: 9301, color: 'blue', target: p.id }, now), /Choose a player/);
  G.act(s, p, { op: 'play', cardId: 9301, color: 'blue', target: target.id }, now);
  assert.deepEqual(p.hand.map((c) => c.id).sort(), targetCards, 'got the other player\'s hand');
  assert.deepEqual(target.hand.map((c) => c.id).sort(), [9302, 9303], 'the other player got the leftover cards');
});

test('super card 🎁 Gift: one random card to each other player, always keeping at least 1', () => {
  const four = [9401, 9402, 9403, 9404];
  const { s, p, others, now } = threePlayers([
    { id: 9401, color: 'wild', value: 'gift' }, { id: 9402, color: 'blue', value: '2' }, { id: 9403, color: 'green', value: '5' },
    { id: 9404, color: 'yellow', value: '7' },
  ]);
  G.act(s, p, { op: 'play', cardId: 9401, color: 'green' }, now);
  assert.equal(p.hand.length, 1, '3 cards left, 2 given away');
  assert.deepEqual(others.map((o) => o.hand.length), [6, 6]);
  const allIds = [...p.hand, ...others.flatMap((o) => o.hand)].map((c) => c.id);
  assert.ok([9402, 9403, 9404].every((id) => allIds.includes(id)), 'no card was lost');
  assert.ok(four.length === 4);

  // with only 1 card left after playing, nothing can be given and the player keeps it
  const t = threePlayers([{ id: 9501, color: 'wild', value: 'gift' }, { id: 9502, color: 'blue', value: '2' }]);
  t.p.saidUno = true;
  G.act(t.s, t.p, { op: 'play', cardId: 9501, color: 'blue' }, t.now);
  assert.equal(t.p.hand.length, 1);
  assert.deepEqual(t.others.map((o) => o.hand.length), [5, 5]);
});

test('admin card picker offers the super cards too', () => {
  const s = G.newRoom('t');
  const a = G.join(s, { name: 'A', admin: true }, 1000);
  G.join(s, { name: 'B', admin: false }, 1000);
  G.act(s, a, { op: 'start' }, 1000);
  s.cur = s.seats.indexOf(a.id);
  G.act(s, a, { op: 'draw', value: 'swap', color: 'wild' }, 1000);
  assert.ok(a.hand.some((c) => c.value === 'swap' && c.color === 'wild'));
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

test('switching public/private removes players who no longer qualify (lobby and mid-game)', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'Boss', admin: true }, now);
  const pub1 = G.join(s, { name: 'Pub1', admin: false, role: 'public' }, now);
  const pub2 = G.join(s, { name: 'Pub2', admin: false, role: 'public' }, now);
  const priv = G.join(s, { name: 'Priv', admin: false, role: 'private' }, now);
  assert.equal(G.view(s, admin, now).players.find((p) => p.id === priv.id).role, 'private');
  assert.equal(G.view(s, pub1, now).players[0].role, undefined, 'only the admin sees roles');

  G.act(s, admin, { op: 'private', on: true }, now); // lobby: public players are removed
  assert.deepEqual(s.members.map((m) => m.name).sort(), ['Boss', 'Priv']);
  assert.ok(s.kicked.includes(pub1.id) && s.kicked.includes(pub2.id));

  const late = G.join(s, { name: 'Priv2', admin: false, role: 'private' }, now);
  G.act(s, admin, { op: 'start' }, now);
  const total = () => s.deck.length + s.discard.length + s.members.reduce((a, m) => a + m.hand.length, 0);
  assert.equal(total(), DECK_SIZE);
  G.act(s, admin, { op: 'private', on: false }, now); // mid-game: private players are removed, game ends
  assert.deepEqual(s.members.map((m) => m.name), ['Boss']);
  assert.equal(s.over, true);
  assert.equal(total(), DECK_SIZE, 'removed players\' cards return to the pile');
  assert.ok(s.kicked.includes(priv.id) && s.kicked.includes(late.id));
});

test('chat: trimmed, length-limited, rate-limited', () => {
  const s = G.newRoom('t');
  const admin = G.join(s, { name: 'A', admin: true }, 1000);
  const b = G.join(s, { name: 'B', admin: false, role: 'public' }, 1000);
  G.act(s, b, { op: 'chat', text: '  hi 👋  ' }, 1000);
  assert.equal(s.chat[0].text, 'hi 👋');
  assert.throws(() => G.act(s, b, { op: 'chat', text: 'again' }, 1100), /Slow down/);
  assert.throws(() => G.act(s, b, { op: 'chat', text: '   ' }, 2000), /Type a message/);
  G.act(s, b, { op: 'chat', text: 'x'.repeat(500) }, 3000);
  assert.equal(s.chat[1].text.length, 200);
  assert.equal(G.view(s, admin, 3000).chat.length, 2);
});

test('chat works during a game and is cleared when the game finishes or restarts', () => {
  const s = G.newRoom('t');
  let now = 1000;
  const admin = G.join(s, { name: 'A', admin: true }, now);
  const b = G.join(s, { name: 'B', admin: false, role: 'public' }, now);
  G.act(s, admin, { op: 'chat', text: 'lobby hello' }, now);
  G.act(s, admin, { op: 'start' }, now);
  assert.deepEqual(G.view(s, b, now).chat, [], 'a new game starts with a clean chat');

  now += 1000;
  G.act(s, b, { op: 'chat', text: 'gg 👍' }, now); // chatting mid-game works
  assert.equal(G.view(s, admin, now).chat.length, 1);
  assert.equal(G.view(s, admin, now).chat[0].text, 'gg 👍');

  // finish the game: the player on turn plays their last card
  const p = s.members.find((m) => m.id === s.seats[s.cur]);
  s.color = 'red';
  s.discard.push({ id: 9000, color: 'red', value: '3' });
  p.hand = [{ id: 9001, color: 'red', value: '9' }];
  G.act(s, p, { op: 'play', cardId: 9001 }, now);
  assert.equal(s.over, true);
  assert.deepEqual(G.view(s, b, now).chat, [], 'chat is reset when the game finishes');
  now += 1000;
  assert.throws(() => G.act(s, b, { op: 'chat', text: 'late' }, now), /finished/);

  // restart: start again, chat, then send everyone back to the lobby
  G.act(s, admin, { op: 'start' }, now);
  now += 1000;
  G.act(s, admin, { op: 'chat', text: 'round two' }, now);
  assert.equal(G.view(s, b, now).chat.length, 1);
  G.act(s, admin, { op: 'lobby' }, now);
  assert.deepEqual(G.view(s, b, now).chat, [], 'restart clears the chat');
});

test('admin can pause and resume: no plays, no timeouts, time left is kept', () => {
  const s = G.newRoom('t');
  let now = 1000;
  const admin = G.join(s, { name: 'A', admin: true }, now);
  const b = G.join(s, { name: 'B', admin: false, role: 'public' }, now);
  G.act(s, admin, { op: 'start' }, now);
  const cur = s.members.find((m) => m.id === s.seats[s.cur]);

  now += 10000; // 20s left on the clock
  admin.lastSeen = b.lastSeen = now;
  assert.throws(() => G.act(s, b, { op: 'pause' }, now), /Only the admin/);
  G.act(s, admin, { op: 'pause' }, now);
  assert.equal(G.view(s, cur, now).paused, true);
  assert.deepEqual(G.view(s, cur, now).playable, []);
  assert.throws(() => G.act(s, cur, { op: 'draw' }, now), /paused/);

  now += 120000; // two minutes later nothing has timed out or been played
  admin.lastSeen = b.lastSeen = now;
  assert.equal(G.tick(s, now), false);
  assert.equal(s.seats[s.cur], cur.id);
  assert.ok(Math.abs(G.view(s, cur, now).turnLeft - 20000) < 50, 'the clock is frozen at 20s');

  G.act(s, admin, { op: 'resume' }, now);
  assert.equal(G.view(s, cur, now).paused, false);
  assert.ok(Math.abs(G.view(s, cur, now).turnLeft - 20000) < 50, 'player still has 20s after resuming');
  G.act(s, cur, { op: 'draw' }, now); // play carries on
  G.act(s, admin, { op: 'resume' }, now); // resuming a game that is not paused is harmless
  assert.equal(G.view(s, admin, now).paused, false);
});

test('voice chat: only admin and private players; list drops people who go offline', () => {
  const s = G.newRoom('t');
  let now = 1000;
  const admin = G.join(s, { name: 'A', admin: true }, now);
  const priv = G.join(s, { name: 'P', admin: false, role: 'private' }, now);
  const pub = G.join(s, { name: 'U', admin: false, role: 'public' }, now);
  assert.throws(() => G.act(s, pub, { op: 'voiceJoin' }, now), /private players and the admin/);
  G.act(s, admin, { op: 'voiceJoin' }, now);
  G.act(s, priv, { op: 'voiceJoin' }, now);
  assert.deepEqual(G.view(s, admin, now).voice.sort(), [admin.id, priv.id].sort());
  assert.equal(G.view(s, pub, now).canVoice, false);
  assert.deepEqual(G.view(s, pub, now).voice, [], 'public players do not even see who is in voice');

  now += 25000; // the private player goes quiet
  admin.lastSeen = pub.lastSeen = now;
  assert.equal(G.tick(s, now), true);
  assert.deepEqual(s.voice, [admin.id]);
  G.act(s, admin, { op: 'voiceLeave' }, now);
  assert.deepEqual(s.voice, []);
});

test('API: voice signals travel only between voice members', async () => {
  const room = 'vc' + Math.floor(Math.random() * 1e6);
  const admin = await call({ op: 'join', room, name: 'Boss', password: '110299' });
  await call({ op: 'private', room, playerId: admin.body.state.you, on: true });
  const p1 = await call({ op: 'join', room, name: 'P1', password: '281101' });
  const A = admin.body.state.you;
  const P = p1.body.state.you;
  assert.ok(admin.body.state.canVoice && Array.isArray(p1.body.state.iceServers) && p1.body.state.iceServers.length > 0);

  assert.equal((await call({ op: 'signal', room, playerId: A, to: P, kind: 'offer', data: { sdp: 'x' } })).code, 400, 'not in voice yet');
  await call({ op: 'voiceJoin', room, playerId: A });
  await call({ op: 'voiceJoin', room, playerId: P });
  assert.equal((await call({ op: 'signal', room, playerId: A, to: P, kind: 'offer', data: { sdp: 'x' } })).code, 200);
  assert.equal((await call({ op: 'signal', room, playerId: A, to: P, kind: 'bogus', data: {} })).code, 400);
  const got = await call({ op: 'signals', room, playerId: P });
  assert.equal(got.body.signals.length, 1);
  assert.deepEqual([got.body.signals[0].from, got.body.signals[0].kind], [A, 'offer']);
  assert.equal((await call({ op: 'signals', room, playerId: P })).body.signals.length, 0, 'mailbox is emptied once read');

  const pubRoom = 'vp' + Math.floor(Math.random() * 1e6);
  await call({ op: 'join', room: pubRoom, name: 'Boss', password: '110299' });
  const pub = await call({ op: 'join', room: pubRoom, name: 'Pub', password: '123456' });
  assert.equal(pub.body.state.canVoice, false);
  assert.equal(pub.body.state.iceServers, undefined);
  assert.equal((await call({ op: 'voiceJoin', room: pubRoom, playerId: pub.body.state.you })).code, 400);
});

test('API: public games admit public players, private games admit private players only', async () => {
  const room = 'priv' + Math.floor(Math.random() * 1e6);
  const admin = await call({ op: 'join', room, name: 'Boss', password: '110299' });
  const early = await call({ op: 'join', room, name: 'Early', password: '123456' });
  assert.equal(early.code, 200);
  assert.equal((await call({ op: 'private', room, playerId: early.body.state.you, on: true })).code, 400, 'players cannot');
  const set = await call({ op: 'private', room, playerId: admin.body.state.you, on: true });
  assert.equal(set.body.state.private, true);
  assert.equal((await call({ op: 'state', room, playerId: early.body.state.you })).body.kicked, true, 'public player already in the lobby is removed');

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
