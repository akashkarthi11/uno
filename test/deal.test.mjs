// The deal: 5 to 10 seconds depending on how many cards go out; nobody can act until it is over; the first clock starts then.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../api/_lib/game.js';

delete process.env.GAME_DEAL;

function room(n, handSize) {
  const s = G.newRoom('t');
  const now = 1000;
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(G.join(s, { name: 'P' + i, admin: i === 0, role: i === 0 ? 'admin' : 'public' }, now));
  if (handSize) G.act(s, ps[0], { op: 'config', handSize }, now);
  G.act(s, ps[0], { op: 'start' }, now);
  return { s, ps, now };
}

test('the deal lasts 5 to 10 seconds, longer for more cards', () => {
  assert.equal(G.dealMsFor(14), 5000);
  assert.equal(G.dealMsFor(42), 6720);
  assert.equal(G.dealMsFor(80), 10000);
  assert.equal(G.dealMsFor(500), 10000);
  assert.equal(room(2, 3).s.dealMs, 5000);
  assert.equal(room(8, 10).s.dealMs, 10000);
});

test('nothing can be played or drawn while cards are being dealt, and the first clock starts afterwards', () => {
  const { s, ps, now } = room(3, 7);
  const cur = s.members.find((m) => m.id === s.seats[s.cur]);
  assert.throws(() => G.act(s, cur, { op: 'draw' }, now + 1000), /still being dealt/);
  assert.throws(() => G.act(s, cur, { op: 'play', cardId: cur.hand[0].id, color: 'red' }, now + 1000), /still being dealt/);
  const v = G.view(s, cur, now + 1000);
  assert.equal(v.dealMs, s.dealMs);
  assert.equal(v.dealLeft, s.dealMs - 1000);
  assert.equal(v.turnLeft, v.turnMs, 'the first turn has its whole time once the deal is over');
  // chat still works during the deal
  assert.doesNotThrow(() => G.act(s, ps[1], { op: 'chat', text: 'hi' }, now + 1000));
  // after the deal the clock has not run down and play is allowed
  const after = now + s.dealMs + 1;
  assert.equal(G.view(s, cur, after).dealLeft, 0);
  assert.ok(G.view(s, cur, after).turnLeft > G.view(s, cur, after).turnMs - 50);
  assert.doesNotThrow(() => G.act(s, cur, { op: 'draw' }, after));
});

test('a player who is slow to act is not timed out during the deal', () => {
  const { s, now } = room(2, 3);
  G.tick(s, now + s.dealMs - 1);
  assert.equal(s.seats.length, 2);
  assert.equal(s.members.every((m) => m.hand.length >= 3), true, 'nobody got a penalty card');
});
