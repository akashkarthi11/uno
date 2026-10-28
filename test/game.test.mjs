import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../api/_lib/game.js';
const DECK_SIZE = 123; // 108 classic cards + 15 super cards
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
      G.act(s, cur, { op: 'play', cardId: c.id, color: c.color === 'wild' ? 'blue' : undefined, target: other.id, rule: 'blast' }, now);
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

test('a player who goes offline pauses the game instead of being auto-played', () => {
  const s = G.newRoom('t');
  let now = 1000;
  const a = G.join(s, { name: 'A', admin: true }, now);
  const b = G.join(s, { name: 'B', admin: false }, now);
  const c = G.join(s, { name: 'C', admin: false }, now);
  G.act(s, a, { op: 'start' }, now);
  s.cur = s.seats.indexOf(b.id);
  const handBefore = b.hand.length;
  now += 30000; // B goes quiet; A and C keep polling
  a.lastSeen = now;
  c.lastSeen = now;
  assert.equal(G.tick(s, now), true);
  assert.equal(s.paused, true);
  assert.equal(s.seats[s.cur], b.id, 'nothing was played for B');
  assert.equal(b.hand.length, handBefore);
  assert.match(G.view(s, a, now).pauseNote, /B lost connection/);
  assert.throws(() => G.act(s, c, { op: 'draw' }, now), /paused/);
  G.act(s, a, { op: 'resume' }, now); // admin decides to wait
  assert.equal(s.paused, false);
  assert.equal(G.tick(s, now + 1000), false, 'a moment to act after resuming');
  G.act(s, a, { op: 'kick', targetId: b.id }, now + 2000);
  assert.equal(s.seats.includes(b.id), false);
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

test('super cards: the deck has 123 cards including the 15 super cards', () => {
  const s = G.newRoom('t');
  const a = G.join(s, { name: 'A', admin: true }, 1000);
  G.join(s, { name: 'B', admin: false }, 1000);
  G.act(s, a, { op: 'start' }, 1000);
  const all = [...s.deck, ...s.discard, ...s.members.flatMap((m) => m.hand)];
  assert.equal(all.length, DECK_SIZE);
  const count = (v) => all.filter((c) => c.value === v).length;
  assert.deepEqual([count('again'), count('sweep'), count('blast'), count('swap'), count('gift'), count('master')], [4, 4, 2, 2, 2, 1]);
  assert.ok(!['again', 'sweep', 'blast', 'swap', 'gift', 'master'].includes(s.discard[0].value), 'the first card is never a super card');
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

test('super card 🧹 Sweep: every other card of its colour goes down with it; wilds stay', () => {
  const { s, p, now } = threePlayers([
    { id: 9601, color: 'red', value: 'sweep' }, { id: 9602, color: 'red', value: '5' }, { id: 9603, color: 'red', value: 'skip' },
    { id: 9604, color: 'blue', value: '2' }, { id: 9605, color: 'wild', value: 'wild' },
  ]);
  G.act(s, p, { op: 'play', cardId: 9601 }, now);
  assert.deepEqual(p.hand.map((c) => c.id).sort(), [9604, 9605], 'only the blue card and the wild are left');
  assert.equal(s.discard.at(-1).id, 9601, 'the Sweep card itself is on top');
  const below = s.discard.slice(-3, -1).map((c) => c.id).sort();
  assert.deepEqual(below, [9602, 9603], 'the swept cards are underneath');
  assert.equal(s.color, 'red');
  assert.equal(s.discard.some((c) => c.id === 9603) && s.seats[s.cur] !== p.id, true, 'a swept Skip has no effect: play moves on normally');
  assert.ok(s.log.some((l) => /swept 2 more red cards/.test(l)));

  // sweeping everything you hold takes you out of the game
  const all = threePlayers([
    { id: 9701, color: 'red', value: 'sweep' }, { id: 9702, color: 'red', value: '5' }, { id: 9703, color: 'red', value: '9' },
  ]);
  G.act(all.s, all.p, { op: 'play', cardId: 9701 }, all.now);
  assert.equal(all.p.hand.length, 0);
  assert.equal(all.p.finished, true);
  assert.deepEqual(all.s.ranking, [all.p.name]);
  assert.ok(!all.s.over, 'two players are still holding cards, so the game goes on');

  // a Sweep can only be played on its colour (or another Sweep)
  const wrong = threePlayers([{ id: 9801, color: 'blue', value: 'sweep' }, { id: 9802, color: 'blue', value: '4' }, { id: 9803, color: 'green', value: '1' }]);
  assert.throws(() => G.act(wrong.s, wrong.p, { op: 'play', cardId: 9801 }, wrong.now), /can't play/);
});

const masterHand = () => [
  { id: 9901, color: 'wild', value: 'master' }, { id: 9902, color: 'red', value: '5' }, { id: 9903, color: 'blue', value: '2' },
];

test('✨ Master card: validates the player and the rule', () => {
  const { s, p, others, now } = threePlayers(masterHand());
  const play = (extra) => () => G.act(s, p, { op: 'play', cardId: 9901, color: 'red', ...extra }, now);
  assert.throws(play({}), /Choose a super rule/);
  assert.throws(play({ rule: 'sweep' }), /Choose a player/);
  assert.throws(play({ rule: 'nonsense', target: others[0].id }), /Choose a super rule/);
  for (const rule of ['blast', 'swap', 'gift', 'draw2', 'wild4']) {
    assert.throws(play({ rule, target: p.id }), /another player/, rule + ' cannot target yourself');
  }
  assert.equal(p.hand.length, 3, 'nothing was played by the refused attempts');
});

test('✨ Master card: 🔁 Play Again sends the turn to the chosen player (or back to you)', () => {
  const a = threePlayers(masterHand());
  const far = a.others[1];
  G.act(a.s, a.p, { op: 'play', cardId: 9901, color: 'red', target: far.id, rule: 'again' }, a.now);
  assert.equal(a.s.seats[a.s.cur], far.id, 'the turn jumped to the chosen player');

  const b = threePlayers(masterHand());
  G.act(b.s, b.p, { op: 'play', cardId: 9901, color: 'red', target: b.p.id, rule: 'again' }, b.now);
  assert.equal(b.s.seats[b.s.cur], b.p.id, 'choosing yourself means you go again');
});

test('✨ Master card: 🧹 Sweep puts down the chosen player\'s cards of the new colour', () => {
  const { s, p, others, now } = threePlayers(masterHand());
  const t = others[0];
  t.hand = [{ id: 9911, color: 'red', value: '1' }, { id: 9912, color: 'red', value: '7' }, { id: 9913, color: 'blue', value: '4' }];
  G.act(s, p, { op: 'play', cardId: 9901, color: 'red', target: t.id, rule: 'sweep' }, now);
  assert.deepEqual(t.hand.map((c) => c.id), [9913]);
  assert.equal(s.discard.at(-1).id, 9901, 'the Master card stays on top');

  const own = threePlayers(masterHand()); // sweeping yourself: your red 5 goes down
  G.act(own.s, own.p, { op: 'play', cardId: 9901, color: 'red', target: own.p.id, rule: 'sweep' }, own.now);
  assert.deepEqual(own.p.hand.map((c) => c.id), [9903]);

  const out = threePlayers(masterHand()); // sweeping away someone's whole hand takes them out of the game
  out.others[0].hand = [{ id: 9921, color: 'red', value: '1' }];
  G.act(out.s, out.p, { op: 'play', cardId: 9901, color: 'red', target: out.others[0].id, rule: 'sweep' }, out.now);
  assert.equal(out.others[0].finished, true);
  assert.deepEqual(out.s.ranking, [out.others[0].name]);
});

test('✨ Master card: 💥 draw 2, 🔄 swap, 🎁 gift 2 aimed at the chosen player', () => {
  const blast = threePlayers(masterHand());
  G.act(blast.s, blast.p, { op: 'play', cardId: 9901, color: 'red', target: blast.others[0].id, rule: 'blast' }, blast.now);
  assert.deepEqual(blast.others.map((o) => o.hand.length), [7, 5]);

  const swap = threePlayers(masterHand());
  const before = swap.others[1].hand.map((c) => c.id).sort();
  G.act(swap.s, swap.p, { op: 'play', cardId: 9901, color: 'red', target: swap.others[1].id, rule: 'swap' }, swap.now);
  assert.deepEqual(swap.p.hand.map((c) => c.id).sort(), before);
  assert.deepEqual(swap.others[1].hand.map((c) => c.id).sort(), [9902, 9903]);

  const gift = threePlayers([...masterHand(), { id: 9904, color: 'green', value: '1' }, { id: 9905, color: 'yellow', value: '3' }]);
  G.act(gift.s, gift.p, { op: 'play', cardId: 9901, color: 'red', target: gift.others[0].id, rule: 'gift' }, gift.now);
  assert.equal(gift.others[0].hand.length, 7, 'received 2 cards');
  assert.equal(gift.others[1].hand.length, 5, 'nobody else got anything');
  assert.equal(gift.p.hand.length, 2, '4 cards left after playing, 2 given away');

  const small = threePlayers(masterHand()); // only 2 cards left after playing: gives 1 and keeps at least 1
  G.act(small.s, small.p, { op: 'play', cardId: 9901, color: 'red', target: small.others[0].id, rule: 'gift' }, small.now);
  assert.equal(small.others[0].hand.length, 6);
  assert.equal(small.p.hand.length, 1);
});

test('✨ Master card: ➕2 / ➕4 make the chosen player draw and lose their next turn', () => {
  // chosen player is NOT next in line: they draw now and are skipped when the turn reaches them
  const far = threePlayers(masterHand());
  const nextP = far.s.members.find((m) => m.id === far.s.seats[(far.s.cur + 1) % 3]);
  const third = far.others.find((o) => o !== nextP);
  G.act(far.s, far.p, { op: 'play', cardId: 9901, color: 'red', target: third.id, rule: 'wild4' }, far.now);
  assert.equal(third.hand.length, 9, 'drew 4');
  assert.equal(third.skipNext, true);
  assert.equal(far.s.seats[far.s.cur], nextP.id, 'the next player in line still plays now');
  nextP.hand = [{ id: 9931, color: 'red', value: '9' }, { id: 9932, color: 'blue', value: '1' }];
  nextP.saidUno = true;
  G.act(far.s, nextP, { op: 'play', cardId: 9931 }, far.now + 1000);
  assert.equal(far.s.seats[far.s.cur], far.p.id, 'the chosen player was skipped, so it is back to the first player');
  assert.equal(third.skipNext, false);
  assert.ok(far.s.log.some((l) => /loses their turn/.test(l)));

  // chosen player IS next in line: same result as a classic +2
  const near = threePlayers(masterHand());
  const nextN = near.s.members.find((m) => m.id === near.s.seats[(near.s.cur + 1) % 3]);
  const after = near.others.find((o) => o !== nextN);
  G.act(near.s, near.p, { op: 'play', cardId: 9901, color: 'red', target: nextN.id, rule: 'draw2' }, near.now);
  assert.equal(nextN.hand.length, 7);
  assert.equal(near.s.seats[near.s.cur], after.id, 'next player skipped, turn goes to the one after');
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

test('lobby settings: unticked super cards are not in the deck, the picker or the Master rules', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'A', admin: true }, now);
  const b = G.join(s, { name: 'B', admin: false, role: 'public' }, now);
  assert.equal(G.view(s, b, now).settings.supers.sweep, true, 'everything is on by default and visible to everyone');

  assert.throws(() => G.act(s, b, { op: 'config', supers: { sweep: false } }, now), /Only the admin/);
  assert.throws(() => G.act(s, admin, { op: 'config' }, now), /Bad settings/);
  G.act(s, admin, { op: 'config', supers: { sweep: false, master: false, bogus: false } }, now);
  assert.deepEqual(G.view(s, b, now).settings.supers,
    { again: true, sweep: false, blast: true, swap: true, gift: true, master: false });

  G.act(s, admin, { op: 'start' }, now);
  const all = [...s.deck, ...s.discard, ...s.members.flatMap((m) => m.hand)];
  assert.equal(all.length, DECK_SIZE - 4 - 1, 'the 4 Sweep cards and the Master card are left out');
  assert.equal(all.filter((c) => c.value === 'sweep' || c.value === 'master').length, 0);
  assert.equal(all.filter((c) => c.value === 'again').length, 4, 'ticked cards are still there');

  assert.throws(() => G.act(s, admin, { op: 'config', supers: { sweep: true } }, now), /only be changed in the lobby/);
  s.cur = s.seats.indexOf(admin.id);
  assert.throws(() => G.act(s, admin, { op: 'draw', value: 'sweep', color: 'red' }, now), /switched off/);
  assert.throws(() => G.act(s, admin, { op: 'draw', value: 'master', color: 'wild' }, now), /switched off/);
  G.act(s, admin, { op: 'draw', value: 'again', color: 'red' }, now); // a ticked super card can still be picked
  assert.ok(admin.hand.some((c) => c.value === 'again'));
});

test('table theme: GrowX by default, only the admin can change it, everyone sees it, valid names only', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'A', admin: true }, now);
  const b = G.join(s, { name: 'B', admin: false }, now);
  assert.equal(G.view(s, b, now).settings.theme, 'growx', 'the default look is GrowX');
  assert.deepEqual(G.THEMES, ['growx', 'classic', 'midnight']);

  assert.throws(() => G.act(s, b, { op: 'config', theme: 'classic' }, now), /Only the admin/);
  assert.throws(() => G.act(s, admin, { op: 'config', theme: 'rainbow' }, now), /Unknown theme/);
  G.act(s, admin, { op: 'config', theme: 'classic' }, now);
  assert.equal(G.view(s, b, now).settings.theme, 'classic', 'a player sees what the admin chose');
  assert.equal(G.view(s, admin, now).settings.supers.sweep, true, 'changing the theme leaves the super-card ticks alone');

  G.act(s, admin, { op: 'config', supers: { sweep: false } }, now); // changing ticks must not reset the theme
  assert.equal(G.view(s, b, now).settings.theme, 'classic');
  assert.equal(G.view(s, b, now).settings.supers.sweep, false);

  G.act(s, admin, { op: 'start' }, now);
  G.act(s, admin, { op: 'config', theme: 'midnight' }, now); // cosmetic: allowed during a game
  assert.equal(G.view(s, b, now).settings.theme, 'midnight');
  assert.throws(() => G.act(s, admin, { op: 'config', supers: { sweep: true } }, now), /only be changed in the lobby/, 'card ticks are still lobby-only');
  G.act(s, admin, { op: 'lobby' }, now);
  assert.equal(G.view(s, b, now).settings.theme, 'midnight', 'the choice is kept for the room');
});

test('cards per player: 5 by default, admin sets 3-10 in the lobby, dealt that many', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'A', admin: true }, now);
  const b = G.join(s, { name: 'B', admin: false }, now);
  const c = G.join(s, { name: 'C', admin: false }, now);
  assert.equal(G.view(s, b, now).settings.handSize, 5, 'default is 5');
  assert.equal(G.HAND_MIN, 3);
  assert.equal(G.HAND_MAX, 10);

  assert.throws(() => G.act(s, b, { op: 'config', handSize: 7 }, now), /Only the admin/);
  for (const bad of [2, 11, 5.5, '7', null, NaN]) {
    assert.throws(() => G.act(s, admin, { op: 'config', handSize: bad }, now), /whole number from 3 to 10/, 'rejects ' + String(bad));
  }
  G.act(s, admin, { op: 'config', handSize: 8 }, now);
  assert.equal(G.view(s, c, now).settings.handSize, 8);
  G.act(s, admin, { op: 'config', theme: 'classic' }, now); // other settings leave it alone
  G.act(s, admin, { op: 'config', supers: { sweep: false } }, now);
  assert.equal(G.view(s, c, now).settings.handSize, 8);

  G.act(s, admin, { op: 'start' }, now);
  for (const p of [admin, b, c]) assert.equal(p.hand.length, 8, 'everyone is dealt 8');
  const all = [...s.deck, ...s.discard, ...s.members.flatMap((m) => m.hand)];
  assert.equal(all.length, DECK_SIZE - 4, 'card count is still conserved (the 4 Sweep cards were ticked off)');
  assert.throws(() => G.act(s, admin, { op: 'config', handSize: 4 }, now), /only be changed in the lobby/);

  G.act(s, admin, { op: 'lobby' }, now);
  G.act(s, admin, { op: 'config', handSize: 3 }, now);
  G.act(s, admin, { op: 'start' }, now);
  for (const p of [admin, b, c]) assert.equal(p.hand.length, 3, 'the minimum works too');
});

test('cards per player: the largest hand still deals fully with 8 players', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'P0', admin: true }, now);
  for (let i = 1; i < 8; i++) G.join(s, { name: 'P' + i, admin: false }, now);
  G.act(s, admin, { op: 'config', handSize: G.HAND_MAX, supers: { again: false, sweep: false, blast: false, swap: false, gift: false, master: false } }, now);
  G.act(s, admin, { op: 'start' }, now); // 8 x 10 + 1 = 81 cards needed from a plain 108-card deck
  assert.equal(s.seats.length, 8);
  assert.ok(s.members.every((m) => m.hand.length === 10));
  assert.ok(s.deck.length >= 20, 'plenty left to draw from');
});

test('lobby settings: a Master card cannot use the rule of a switched-off super card', () => {
  const { s, p, others, now } = threePlayers([
    { id: 9951, color: 'wild', value: 'master' }, { id: 9952, color: 'red', value: '5' }, { id: 9953, color: 'blue', value: '2' },
  ]);
  s.settings = { supers: { again: true, sweep: true, blast: true, swap: false, gift: true, master: true } };
  assert.throws(() => G.act(s, p, { op: 'play', cardId: 9951, color: 'red', target: others[0].id, rule: 'swap' }, now), /switched off/);
  G.act(s, p, { op: 'play', cardId: 9951, color: 'red', target: others[0].id, rule: 'wild4' }, now); // +4 is always allowed
  assert.equal(others[0].hand.length, 9);
});

test('lobby settings: all super cards off gives the plain 108-card deck and a playable game', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const a = G.join(s, { name: 'A', admin: true }, now);
  G.join(s, { name: 'B', admin: false }, now);
  G.act(s, a, { op: 'config', supers: { again: false, sweep: false, blast: false, swap: false, gift: false, master: false } }, now);
  G.act(s, a, { op: 'start' }, now);
  const all = [...s.deck, ...s.discard, ...s.members.flatMap((m) => m.hand)];
  assert.equal(all.length, 108);
  assert.ok(all.every((c) => !['again', 'sweep', 'blast', 'swap', 'gift', 'master'].includes(c.value)));
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
    const res = {
      code: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.code = c; return this; },
      json(o) { resolve({ code: this.code, body: o, headers: this.headers }); },
    };
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

  now += 25000; // a short drop-out keeps the place in the voice list
  admin.lastSeen = pub.lastSeen = now;
  assert.equal(G.tick(s, now), false);
  assert.deepEqual(s.voice.sort(), [admin.id, priv.id].sort());

  now += 70000; // really gone
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

test('API answers are never cacheable and always carry the deployed build id', async () => {
  const room = 'nc' + Math.floor(Math.random() * 1e6);
  const gone = await call({ op: 'state', room, playerId: 'nobody' });
  assert.equal(gone.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(typeof gone.body.build, 'string');
  assert.equal(gone.body.gone, true);

  const denied = await call({ op: 'join', room, name: 'X', password: 'wrong' });
  assert.equal(denied.code, 401);
  assert.equal(denied.headers['cache-control'], 'no-store, max-age=0', 'errors are not cacheable either');
  assert.equal(denied.body.build, gone.body.build, 'the same build id on every answer');

  const joined = await call({ op: 'join', room, name: 'A', password: '110299' });
  const poll = await call({ op: 'state', room, playerId: joined.body.state.you, since: joined.body.state.version, ps: joined.body.state.ps });
  assert.equal(poll.body.unchanged, true);
  assert.equal(poll.body.build, gone.body.build, "even the tiny 'nothing changed' answer says which build it is");

  // GET (the 405 page) is covered too
  const get = await new Promise((resolve) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status() { return this; }, json(o) { resolve({ body: o, headers: this.headers }); } };
    handler({ method: 'GET' }, res);
  });
  assert.equal(get.headers['cache-control'], 'no-store, max-age=0');
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
  const poll = await call({ op: 'state', room: 'api1', playerId: a.body.state.you, since: ok.body.state.version, ps: ok.body.state.ps });
  assert.equal(poll.body.unchanged, true);
});

test('switching public/private clears the chat (setting the same mode does not)', () => {
  const s = G.newRoom('t');
  const admin = G.join(s, { name: 'Boss', admin: true }, 1000);
  G.act(s, admin, { op: 'chat', text: 'one' }, 1000);
  G.act(s, admin, { op: 'private', on: false }, 2000); // already public: nothing changes
  assert.equal(s.chat.length, 1);
  G.act(s, admin, { op: 'private', on: true }, 3000);
  assert.equal(s.chat.length, 0);
  G.act(s, admin, { op: 'chat', text: 'two' }, 4000);
  G.act(s, admin, { op: 'private', on: false }, 5000);
  assert.equal(s.chat.length, 0);
});

test('a game with too few players connected pauses rather than ending', () => {
  const s = G.newRoom('t');
  let now = 1000;
  const admin = G.join(s, { name: 'Boss', admin: true }, now);
  G.join(s, { name: 'B', admin: false, role: 'public' }, now);
  G.act(s, admin, { op: 'start' }, now);
  now += 300000; // both phones asleep for five minutes
  G.tick(s, now);
  assert.equal(s.over, false);
  assert.equal(s.paused, true);
});

test('quiet polls: a heartbeat alone does not change the version, a change in who is online does', async () => {
  const room = 'qp' + Math.floor(Math.random() * 1e6);
  const a = await call({ op: 'join', room, name: 'A', password: '110299' });
  const b = await call({ op: 'join', room, name: 'B', password: '123456' });
  const A = a.body.state.you;
  const quiet = await call({ op: 'state', room, playerId: A, since: b.body.state.version, ps: b.body.state.ps });
  assert.equal(quiet.body.unchanged, true);
  // a stale ps (somebody's online status moved) is answered with a fresh state, not "unchanged"
  const moved = await call({ op: 'state', room, playerId: A, since: b.body.state.version, ps: '10' });
  assert.ok(moved.body.state, 'presence changed → full state');
});

test('co-admin: can start games and choose settings, nothing else; only the admin grants or drops it, any time', () => {
  const s = G.newRoom('t');
  let now = 1000;
  const admin = G.join(s, { name: 'Boss', admin: true }, now);
  const pub = G.join(s, { name: 'Pub', admin: false, role: 'public' }, now);
  const priv = G.join(s, { name: 'Priv', admin: false, role: 'private' }, now);

  assert.throws(() => G.act(s, pub, { op: 'start' }, now), /Only the admin/);
  assert.throws(() => G.act(s, pub, { op: 'starter', targetId: priv.id, on: true }, now), /Only the admin/);
  assert.throws(() => G.act(s, admin, { op: 'starter', targetId: admin.id, on: true }, now), /already an admin/);
  assert.equal(G.view(s, pub, now).canStart, false);

  G.act(s, admin, { op: 'starter', targetId: pub.id, on: true }, now);
  assert.equal(G.view(s, pub, now).canStart, true);
  assert.equal(G.view(s, pub, now).admin, false, 'still not an admin');
  assert.equal(G.view(s, admin, now).players.find((p) => p.id === pub.id).starter, true);

  // nothing but starting
  assert.throws(() => G.act(s, pub, { op: 'private', on: true }, now), /Only the admin/);
  // ...except the game settings: super cards, cards per player and theme
  G.act(s, pub, { op: 'config', handSize: 7 }, now);
  G.act(s, pub, { op: 'config', theme: 'midnight' }, now);
  G.act(s, pub, { op: 'config', supers: { blast: false } }, now);
  assert.equal(G.view(s, pub, now).settings.handSize, 7);
  assert.equal(G.view(s, pub, now).settings.theme, 'midnight');
  assert.equal(G.view(s, pub, now).settings.supers.blast, false);
  assert.throws(() => G.act(s, priv, { op: 'config', handSize: 6 }, now), /Only the admin/, 'an ordinary player still cannot');
  G.act(s, admin, { op: 'config', handSize: 5, theme: 'growx', supers: { blast: true } }, now);
  assert.throws(() => G.act(s, pub, { op: 'kick', targetId: priv.id }, now), /Only the admin/);
  assert.equal(G.canVoice(s, pub), false, 'a public co-admin gets no voice chat');

  G.act(s, pub, { op: 'start' }, now); // the co-admin starts the game
  assert.equal(s.started, true);
  assert.throws(() => G.act(s, pub, { op: 'pause' }, now), /Only the admin/);
  assert.throws(() => G.act(s, pub, { op: 'lobby' }, now), /Only the admin/);
  s.cur = s.seats.indexOf(pub.id);
  assert.throws(() => G.act(s, pub, { op: 'draw', value: 'skip', color: 'red' }, now), /Admin only/);

  G.act(s, admin, { op: 'starter', targetId: pub.id, on: false }, now); // dropped mid-game
  assert.equal(G.view(s, pub, now).canStart, false);
  s.over = true; // game over: the dropped co-admin can no longer start the next one
  assert.throws(() => G.act(s, pub, { op: 'start' }, now), /Only the admin/);
});

test('turn time: the admin sets it in the lobby (15-120 s), it is used for the timeout and shown to everyone', () => {
  const s = G.newRoom('t');
  let now = 1000;
  const admin = G.join(s, { name: 'Boss', admin: true }, now);
  const b = G.join(s, { name: 'B', admin: false, role: 'public' }, now);
  assert.equal(G.view(s, b, now).settings.turnSecs, 30, 'default is 30 seconds');
  assert.throws(() => G.act(s, b, { op: 'config', turnSecs: 20 }, now), /Only the admin/);
  for (const bad of [14, 121, 22.5, '30', null]) {
    assert.throws(() => G.act(s, admin, { op: 'config', turnSecs: bad }, now), /Turn time must be|Bad settings/);
  }
  G.act(s, admin, { op: 'config', turnSecs: 15 }, now);
  G.act(s, admin, { op: 'config', theme: 'classic' }, now); // other changes keep it
  assert.equal(G.view(s, b, now).settings.turnSecs, 15);

  G.act(s, admin, { op: 'start' }, now);
  assert.equal(G.view(s, b, now).turnMs, 15000);
  assert.throws(() => G.act(s, admin, { op: 'config', turnSecs: 60 }, now), /only be changed in the lobby/);
  const cur = s.members.find((m) => m.id === s.seats[s.cur]);
  const before = cur.hand.length;
  s.turnAt = now - 14000; // 14 s into a 15 s turn: still theirs
  admin.lastSeen = b.lastSeen = now;
  assert.equal(G.tick(s, now), false);
  s.turnAt = now - 16000; // 16 s: out of time
  assert.equal(G.tick(s, now), true);
  assert.equal(cur.hand.length, before + 1, 'penalty card after the shorter time');
});

test('refresh: a signed token puts the same player back at the table, and cannot be forged or reused elsewhere', async () => {
  const { signToken, verifyToken, TOKEN_TTL_MS } = await import('../api/_lib/token.js');
  const room = 'tk' + Math.floor(Math.random() * 1e6);
  const admin = await call({ op: 'join', room, name: 'Boss', password: '110299' });
  const pub = await call({ op: 'join', room, name: 'Pub', password: '123456' });
  assert.equal(typeof admin.body.token, 'string');

  // refresh as the admin: same seat, still the admin, no password involved
  const back = await call({ op: 'session', room, token: admin.body.token });
  assert.equal(back.code, 200);
  assert.equal(back.body.state.you, admin.body.state.you);
  assert.equal(back.body.state.admin, true);
  assert.equal(typeof back.body.token, 'string', 'a renewed token comes back');

  // forged, damaged, empty, or for another room
  const [body, sig] = pub.body.token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), role: 'admin' })).toString('base64url') + '.' + sig;
  assert.equal((await call({ op: 'session', room, token: forged })).code, 401, 'a changed role is rejected');
  assert.equal((await call({ op: 'session', room, token: pub.body.token + 'x' })).code, 401);
  assert.equal((await call({ op: 'session', room })).code, 401);
  assert.equal((await call({ op: 'session', room: room + 'z', token: pub.body.token })).code, 401, 'a token is for its own room');

  // expired
  const claim = { r: room, p: pub.body.state.you, role: 'public', n: 'Pub' };
  assert.equal(verifyToken(signToken(claim, 1000, 'salt'), room, 1000 + TOKEN_TTL_MS + 1, 'salt'), null);
  assert.ok(verifyToken(signToken(claim, 1000, 'salt'), room, 1000 + 5000, 'salt'));
  assert.equal(verifyToken(signToken(claim, 1000, 'salt'), room, 2000, 'other salt'), null, 'a different key does not validate');

  // removed players cannot come back with their old token
  const kicked = await call({ op: 'kick', room, playerId: admin.body.state.you, targetId: pub.body.state.you });
  assert.equal(kicked.code, 200);
  const denied = await call({ op: 'session', room, token: pub.body.token });
  assert.equal(denied.code, 401);
  assert.match(denied.body.error, /removed/);
});

test('refresh respects public/private: a public token is refused once the game is private (the player was removed)', async () => {
  const room = 'tk' + Math.floor(Math.random() * 1e6);
  const admin = await call({ op: 'join', room, name: 'Boss', password: '110299' });
  const pub = await call({ op: 'join', room, name: 'Pub', password: '123456' });
  await call({ op: 'private', room, playerId: admin.body.state.you, on: true });
  const r = await call({ op: 'session', room, token: pub.body.token });
  assert.equal(r.code, 401);
  assert.match(r.body.error, /removed by the admin|private password/);
  const priv = await call({ op: 'join', room, name: 'Priv', password: '281101' });
  assert.equal((await call({ op: 'session', room, token: priv.body.token })).code, 200);
  await call({ op: 'private', room, playerId: admin.body.state.you, on: false });
  assert.equal((await call({ op: 'session', room, token: priv.body.token })).code, 401, 'and the reverse');
  assert.equal((await call({ op: 'session', room, token: admin.body.token })).code, 200, 'the admin works either way');
});

test('API: the admin can pause and resume a game (resume must not be mistaken for a session check)', async () => {
  const room = 'ps' + Math.floor(Math.random() * 1e6);
  const admin = await call({ op: 'join', room, name: 'Boss', password: '110299' });
  await call({ op: 'join', room, name: 'B', password: '123456' });
  const A = admin.body.state.you;
  assert.equal((await call({ op: 'start', room, playerId: A })).code, 200);
  const paused = await call({ op: 'pause', room, playerId: A });
  assert.equal(paused.body.state.paused, true);
  const resumed = await call({ op: 'resume', room, playerId: A });
  assert.equal(resumed.code, 200, 'the un-pause works');
  assert.equal(resumed.body.state.paused, false);
});

test('public voice switch: off by default; the admin turns it on or off and public players follow', () => {
  const s = G.newRoom('t');
  let now = 1000;
  const admin = G.join(s, { name: 'Boss', admin: true }, now);
  const pub = G.join(s, { name: 'Pub', admin: false, role: 'public' }, now);
  assert.equal(G.view(s, admin, now).settings.publicVoice, false);
  assert.equal(G.view(s, pub, now).canVoice, false);
  assert.throws(() => G.act(s, pub, { op: 'voiceJoin' }, now), /private players and the admin/);
  assert.throws(() => G.act(s, pub, { op: 'config', publicVoice: true }, now), /Only the admin/);
  assert.throws(() => G.act(s, admin, { op: 'config', publicVoice: 'yes' }, now), /Bad settings/);

  G.act(s, admin, { op: 'config', publicVoice: true }, now);
  assert.equal(G.view(s, pub, now).canVoice, true);
  assert.equal(G.view(s, pub, now).settings.publicVoice, true);
  G.act(s, pub, { op: 'voiceJoin' }, now);
  G.act(s, admin, { op: 'voiceJoin' }, now);
  assert.deepEqual(G.view(s, pub, now).voice.sort(), [admin.id, pub.id].sort());
  G.act(s, admin, { op: 'config', theme: 'classic' }, now); // other changes keep the choice
  assert.equal(G.view(s, pub, now).settings.publicVoice, true);

  G.act(s, admin, { op: 'config', publicVoice: false }, now); // switched off: public players drop out of the list
  assert.equal(G.tick(s, now), true);
  assert.deepEqual(s.voice, [admin.id]);
  assert.equal(G.view(s, pub, now).canVoice, false);
  assert.deepEqual(G.view(s, pub, now).voice, []);
});

test('going private switches public voice off, and it cannot be switched on in a private game', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'Boss', admin: true }, now);
  const priv = G.join(s, { name: 'Priv', admin: false, role: 'private' }, now);
  G.act(s, admin, { op: 'config', publicVoice: true }, now);
  assert.equal(G.view(s, admin, now).settings.publicVoice, true);

  G.act(s, admin, { op: 'private', on: true }, now);
  assert.equal(G.view(s, admin, now).settings.publicVoice, false, 'reset when the game goes private');
  assert.throws(() => G.act(s, admin, { op: 'config', publicVoice: true }, now), /only for public games/);
  assert.equal(G.view(s, priv, now).canVoice, true, 'private players keep voice as always');

  G.act(s, admin, { op: 'private', on: false }, now);
  assert.equal(G.view(s, admin, now).settings.publicVoice, false, 'and it stays off when the game is public again');
});
