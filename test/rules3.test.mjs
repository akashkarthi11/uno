// The challenge question for +2 and +4, the result reveal, official scoring, and the official first-card actions.
process.env.GAME_DEAL = 'off'; // no dealing pause in these tests (dealing has its own test)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../api/_lib/game.js';

const card = (id, color, value) => ({ id, color, value });
const turnOf = (s) => s.members.find((m) => m.id === s.seats[s.cur]);

/** n players (P0 is the admin) with P0 to move, going clockwise, red in play. Options go in through the lobby settings. */
function table(n, options = {}) {
  const s = G.newRoom('t');
  const now = 1000;
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(G.join(s, { name: 'P' + i, admin: i === 0 }, now));
  if (Object.keys(options).length) G.act(s, ps[0], { op: 'config', ...options }, now);
  G.act(s, ps[0], { op: 'start' }, now);
  // a clean table: the first-card action (if any) is undone, P0 moves, clockwise, red in play
  for (const m of s.members) if (m.hand.length > 7) s.deck.push(...m.hand.splice(7));
  s.dir = 1;
  s.cur = s.seats.indexOf(ps[0].id);
  s.turnAt = now;
  s.color = 'red';
  s.discard.push(card(9000, 'red', '3'));
  return { s, ps, now };
}

/* ---------- the challenge question ---------- */

test('+2: the next player is asked about the colour that was in play; Yes and the opponent has it: the cards go back to them', () => {
  const { s, ps, now } = table(3);
  ps[0].hand = [card(1, 'red', 'draw2'), card(2, 'red', '5')]; // after playing, P0 still holds a red card
  const h1 = ps[1].hand.length;
  const h0 = ps[0].hand.length - 1;
  G.act(s, ps[0], { op: 'play', cardId: 1 }, now);
  assert.equal(turnOf(s), ps[1], 'the +2 waits for P1 to answer');
  assert.equal(ps[1].hand.length, h1, 'nothing is drawn yet');
  const q = G.view(s, ps[1], now).pend;
  assert.deepEqual(q, { kind: 'draw2', n: 2, by: 'P0', canChallenge: true, colour: 'red' }, 'the question: does P0 have a red card?');

  G.act(s, ps[1], { op: 'challenge' }, now); // Yes
  assert.equal(ps[0].hand.length, h0 + 2, 'successful: the player who played the +2 draws the 2');
  assert.equal(ps[1].hand.length, h1, 'the challenger draws nothing');
  assert.equal(turnOf(s), ps[1], 'and plays on');
  const rv = G.view(s, ps[2], now).reveal; // everybody sees the result
  assert.deepEqual([rv.ok, rv.colour, rv.n, rv.challenger, rv.target, rv.kind], [true, 'red', 2, 'P1', 'P0', 'draw2']);
});

test('+2: Yes but the opponent has no card of that colour: the challenger draws the 2 and loses the turn', () => {
  const { s, ps, now } = table(3);
  ps[0].hand = [card(1, 'red', 'draw2'), card(2, 'blue', '5')]; // no red left
  const h1 = ps[1].hand.length;
  G.act(s, ps[0], { op: 'play', cardId: 1 }, now);
  G.act(s, ps[1], { op: 'challenge' }, now);
  assert.equal(ps[1].hand.length, h1 + 2, 'failed: the challenger draws the 2 (2 in total)');
  assert.equal(turnOf(s), ps[2], 'and misses the turn');
  const rv = G.view(s, ps[2], now).reveal;
  assert.deepEqual([rv.ok, rv.colour, rv.n, rv.challenger, rv.target], [false, 'red', 2, 'P1', 'P0']);
});

test('+4: the same question (on the colour in play before), 4 in total either way', () => {
  const win = table(3);
  win.ps[0].hand = [card(1, 'wild', 'wild4'), card(2, 'red', '5')]; // holds red: a bluff
  const h0 = win.ps[0].hand.length - 1;
  G.act(win.s, win.ps[0], { op: 'play', cardId: 1, color: 'blue' }, win.now);
  assert.equal(G.view(win.s, win.ps[1], win.now).pend.colour, 'red', 'asked about red, not the colour the player chose');
  G.act(win.s, win.ps[1], { op: 'challenge' }, win.now);
  assert.equal(win.ps[0].hand.length, h0 + 4);
  assert.equal(turnOf(win.s), win.ps[1]);

  const lose = table(3);
  lose.ps[0].hand = [card(1, 'wild', 'wild4'), card(2, 'blue', '5')]; // no red: a legal +4
  const h1 = lose.ps[1].hand.length;
  G.act(lose.s, lose.ps[0], { op: 'play', cardId: 1, color: 'green' }, lose.now);
  G.act(lose.s, lose.ps[1], { op: 'challenge' }, lose.now);
  assert.equal(lose.ps[1].hand.length, h1 + 4, '4 in total, not 6');
  assert.equal(turnOf(lose.s), lose.ps[2]);
});

test('declining (No or Skip challenge): draw the cards and lose the turn as usual, and no result is shown', () => {
  for (const kind of ['draw2', 'wild4']) {
    const { s, ps, now } = table(3);
    ps[0].hand = [kind === 'draw2' ? card(1, 'red', 'draw2') : card(1, 'wild', 'wild4'), card(2, 'red', '5')];
    const h1 = ps[1].hand.length;
    G.act(s, ps[0], { op: 'play', cardId: 1, color: 'blue' }, now);
    G.act(s, ps[1], { op: 'draw' }, now); // the popup's No / Skip challenge
    assert.equal(ps[1].hand.length, h1 + (kind === 'draw2' ? 2 : 4));
    assert.equal(turnOf(s), ps[2]);
    assert.equal(G.view(s, ps[2], now).reveal, null, 'nothing to reveal when nobody challenged');
  }
});

test('the result is shown for a few seconds only', () => {
  const { s, ps, now } = table(3);
  ps[0].hand = [card(1, 'red', 'draw2'), card(2, 'red', '5')];
  G.act(s, ps[0], { op: 'play', cardId: 1 }, now);
  G.act(s, ps[1], { op: 'challenge' }, now);
  assert.ok(G.view(s, ps[2], now + 7000).reveal, 'still there after 7 s');
  assert.equal(G.view(s, ps[2], now + 9000).reveal, null, 'gone after 8 s');
});

test('a +2 / +4 played as the very last card makes the next player draw at once and cannot be challenged', () => {
  const { s, ps, now } = table(2);
  ps[0].hand = [card(1, 'red', 'draw2')];
  ps[1].hand = [card(3, 'red', '5')];
  s.deck.push(card(50, 'green', '1'), card(51, 'green', '2')); // what P1 will draw
  G.act(s, ps[0], { op: 'play', cardId: 1 }, now);
  assert.equal(s.over, true);
  assert.equal(ps[1].hand.length, 3, 'P1 drew the 2 cards before the points were counted');
  assert.equal(s.roundPoints, 5 + 1 + 2, 'points = the cards left in P1 hand: 5 + 1 + 2');
});

test('challenges can be switched off: a +2 takes effect at once and a +4 keeps the strict rule', () => {
  const { s, ps, now } = table(3, { challenge: false });
  ps[0].hand = [card(1, 'red', 'draw2'), card(2, 'red', '5')];
  const h1 = ps[1].hand.length;
  G.act(s, ps[0], { op: 'play', cardId: 1 }, now);
  assert.equal(s.pend ?? null, null);
  assert.equal(ps[1].hand.length, h1 + 2);
  assert.equal(turnOf(s), ps[2]);
  assert.throws(() => G.act(s, ps[2], { op: 'challenge' }, now), /nothing to challenge|not your turn/);
});

/* ---------- official scoring ---------- */

test('official card values: numbers face value, Skip / Reverse / Draw Two 20, Wild and Wild Draw Four 50', () => {
  assert.equal(G.cardPoints(card(1, 'red', '0')), 0);
  assert.equal(G.cardPoints(card(1, 'blue', '7')), 7);
  for (const v of ['skip', 'reverse', 'draw2']) assert.equal(G.cardPoints(card(1, 'green', v)), 20);
  assert.equal(G.cardPoints(card(1, 'wild', 'wild')), 50);
  assert.equal(G.cardPoints(card(1, 'wild', 'wild4')), 50);
});

test('the first player out scores the cards left in the other hands, and points add up over a match to 500', () => {
  const { s, ps, now } = table(3);
  ps[0].hand = [card(1, 'red', '7')];
  ps[1].hand = [card(2, 'red', 'skip'), card(3, 'blue', '9')]; // 20 + 9
  ps[2].hand = [card(4, 'wild', 'wild'), card(5, 'green', '4')]; // 50 + 4
  G.act(s, ps[0], { op: 'play', cardId: 1 }, now);
  assert.equal(s.roundWinner, 'P0');
  assert.equal(s.roundPoints, 20 + 9 + 50 + 4);
  assert.equal(s.over, false, 'play goes on for the rest, as before');
  const sc = G.view(s, ps[1], now).scoring;
  assert.deepEqual([sc.target, sc.roundWinner, sc.roundPoints], [500, 'P0', 83]);

  // the game ends: the round is recorded and the totals count
  s.cur = s.seats.indexOf(ps[1].id);
  ps[1].hand = [card(6, 'red', '1')];
  G.act(s, ps[1], { op: 'play', cardId: 6 }, now);
  assert.equal(s.over, true);
  assert.equal(G.view(s, ps[2], now).scoring.totals.P0, 83, 'P0 has 83 points in the match');
  assert.equal(G.statsView(s, ps[0]).modes.public.table.find((r) => r.name === 'P0').points, 83, 'and the stats table shows them');

  // a player who reaches 500 wins the match; the next game starts a new one
  s.match = { P0: 480 };
  G.act(s, ps[0], { op: 'lobby' }, now);
  G.act(s, ps[0], { op: 'start' }, now);
  s.cur = s.seats.indexOf(ps[0].id);
  ps[0].hand = [card(11, 'red', '7')];
  ps[1].hand = [card(12, 'red', '9'), card(13, 'red', '8')]; // 17
  ps[2].hand = [card(14, 'red', '1')];
  s.color = 'red';
  G.act(s, ps[0], { op: 'play', cardId: 11 }, now);
  assert.equal(s.roundPoints, 17 + 1);
  assert.equal(s.match.P0, 480);
  s.cur = s.seats.indexOf(ps[1].id);
  G.act(s, ps[1], { op: 'play', cardId: 12 }, now); // keep the game going until it ends
  s.cur = s.seats.indexOf(ps[1].id);
  G.act(s, ps[1], { op: 'play', cardId: 13 }, now);
  assert.equal(s.over, true);
  assert.equal(s.match.P0, 498, '480 + 18');
  assert.equal(s.matchWinner ?? null, null, 'not yet 500');
  s.match.P0 = 495;
  s.roundWinner = 'P0';
  s.roundPoints = 10;
  s.recordedNo = null;
  // recording again would count the round once more; do it through a real game instead
  G.act(s, ps[0], { op: 'lobby' }, now);
  G.act(s, ps[0], { op: 'start' }, now);
  s.cur = s.seats.indexOf(ps[0].id);
  ps[0].hand = [card(21, 'red', '7')];
  ps[1].hand = [card(22, 'wild', 'wild'), card(23, 'wild', 'wild4')]; // 100
  ps[2].hand = [card(24, 'red', '1')];
  s.color = 'red';
  G.act(s, ps[0], { op: 'play', cardId: 21 }, now);
  s.cur = s.seats.indexOf(ps[1].id);
  G.act(s, ps[1], { op: 'play', cardId: 22, color: 'red' }, now);
  s.cur = s.seats.indexOf(ps[1].id);
  s.pend = null;
  G.act(s, ps[1], { op: 'play', cardId: 23, color: 'red' }, now);
  assert.equal(s.over, true);
  assert.ok(s.match.P0 >= 500, 'P0 passed 500');
  assert.equal(G.view(s, ps[2], now).scoring.matchWinner, 'P0');
  G.act(s, ps[0], { op: 'lobby' }, now);
  G.act(s, ps[0], { op: 'start' }, now);
  assert.deepEqual(s.match, {}, 'a new match starts from zero');
  assert.equal(s.matchWinner, null);
});

/* ---------- official first-card actions ---------- */

test('the first card turned over: never a Wild; Skip, Reverse and Draw Two act as in the official rules', () => {
  const seen = { skip: false, reverse: false, draw2: false };
  for (let i = 0; i < 700 && !(seen.skip && seen.reverse && seen.draw2); i++) {
    const s = G.newRoom('t');
    const now = 1000;
    const a = G.join(s, { name: 'A', admin: true }, now);
    G.join(s, { name: 'B', admin: false }, now);
    G.join(s, { name: 'C', admin: false }, now);
    G.act(s, a, { op: 'start' }, now);
    const first = s.discard[0];
    assert.notEqual(first.color, 'wild', 'a Wild cannot start the pile');
    assert.ok(!['again', 'sweep'].includes(first.value));
    const hands = s.members.map((m) => m.hand.length);
    const name = s.members.find((m) => m.id === s.seats[s.cur]).name;
    assert.ok(s.log.some((l) => l === name + ' goes first.'));
    if (first.value === 'skip') {
      seen.skip = true;
      assert.ok(s.log.some((l) => /is skipped/.test(l)), 'the first player is skipped');
      assert.deepEqual(hands, [7, 7, 7]);
    } else if (first.value === 'reverse') {
      seen.reverse = true;
      assert.equal(s.dir, -1, 'play runs the other way');
      assert.deepEqual(hands, [7, 7, 7]);
    } else if (first.value === 'draw2') {
      seen.draw2 = true;
      assert.deepEqual([...hands].sort(), [7, 7, 9], 'the first player drew 2');
      assert.ok(s.log.some((l) => /draws 2/.test(l)));
    } else {
      assert.deepEqual(hands, [7, 7, 7]);
      assert.equal(s.dir, 1);
    }
  }
  assert.deepEqual(seen, { skip: true, reverse: true, draw2: true }, 'all three were seen and did their job');
});

test('Skip skips exactly the next player who is still in, Reverse with 2 players acts like Skip', () => {
  const { s, ps, now } = table(4, { challenge: false });
  ps[0].hand = [card(1, 'red', 'skip'), card(2, 'red', '5')];
  G.act(s, ps[0], { op: 'play', cardId: 1 }, now);
  assert.equal(turnOf(s), ps[2], 'P1 was skipped');

  const two = table(2, { challenge: false });
  two.ps[0].hand = [card(3, 'red', 'reverse'), card(4, 'red', '5')];
  G.act(two.s, two.ps[0], { op: 'play', cardId: 3 }, two.now);
  assert.equal(turnOf(two.s), two.ps[0], 'with two players Reverse is a Skip: P0 goes again');

  const three = table(3, { challenge: false });
  three.ps[0].hand = [card(5, 'red', 'reverse'), card(6, 'red', '5')];
  G.act(three.s, three.ps[0], { op: 'play', cardId: 5 }, three.now);
  assert.equal(turnOf(three.s), three.ps[2], 'with three the direction flips: P2 is next');
});

/* ---------- defaults ---------- */

test('defaults follow the official rules: 7 cards each and the challenge question on', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const a = G.join(s, { name: 'A', admin: true }, now);
  G.join(s, { name: 'B', admin: false }, now);
  const st = G.view(s, a, now).settings;
  assert.equal(st.handSize, 7);
  assert.equal(st.challenge, true);
});
