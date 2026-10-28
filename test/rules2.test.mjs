// Stacking, +4 challenge, catching a missed GrowX!, leaving a game, and stats / history.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../api/_lib/game.js';
import handler from '../api/game.js';

function call(body) {
  return new Promise((resolve) => {
    const res = {
      code: 200,
      headers: {},
      setHeader() {},
      status(c) { this.code = c; return this; },
      json(o) { resolve({ code: this.code, body: o }); },
    };
    handler({ method: 'POST', body }, res);
  });
}

/** n players, the admin first; options go in through the lobby settings. Returns the room with a known table. */
function table(n, options = {}) {
  const s = G.newRoom('t');
  const now = 1000;
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(G.join(s, { name: 'P' + i, admin: i === 0 }, now));
  if (Object.keys(options).length) G.act(s, ps[0], { op: 'config', ...options }, now);
  G.act(s, ps[0], { op: 'start' }, now);
  // seat order = join order from index 0; let P0 move first, the others follow in order
  s.cur = s.seats.indexOf(ps[0].id);
  s.dir = 1;
  s.color = 'red';
  s.discard.push({ id: 9000, color: 'red', value: '3' });
  return { s, ps, now };
}
const card = (id, color, value) => ({ id, color, value });
const turnOf = (s) => s.members.find((m) => m.id === s.seats[s.cur]);

/* ---------- stacking ---------- */

test('stacking: +2 on +2 adds up, the one who cannot stack draws everything and loses the turn', () => {
  const { s, ps, now } = table(3, { stacking: true });
  ps[0].hand = [card(1, 'red', 'draw2'), card(2, 'red', '5')];
  ps[1].hand = [card(3, 'blue', 'draw2'), card(4, 'blue', '1')];
  ps[2].hand = [card(5, 'green', '1'), card(6, 'green', '2')];
  const before2 = ps[2].hand.length;

  G.act(s, ps[0], { op: 'play', cardId: 1 }, now);
  assert.equal(s.pend.n, 2);
  assert.equal(turnOf(s), ps[1], 'the +2 waits for the next player');
  assert.equal(ps[1].hand.length, 2, 'nothing drawn yet');
  const v = G.view(s, ps[1], now);
  assert.deepEqual(v.pend, { kind: 'draw2', n: 2, by: 'P0', canChallenge: false });
  assert.deepEqual(v.playable, [3], 'only a +2 can be played now');
  assert.throws(() => G.act(s, ps[1], { op: 'play', cardId: 4 }, now), /Play another \+2 to stack it, or draw 2/);

  G.act(s, ps[1], { op: 'play', cardId: 3 }, now); // stack
  assert.equal(s.pend.n, 4);
  assert.equal(turnOf(s), ps[2]);
  assert.deepEqual(G.view(s, ps[2], now).playable, []);

  G.act(s, ps[2], { op: 'draw' }, now); // cannot stack: takes all 4
  assert.equal(ps[2].hand.length, before2 + 4);
  assert.equal(s.pend, null);
  assert.equal(turnOf(s), ps[0], 'and the turn moves on');
});

test('stacking: +4 stacks on +4 only (a +2 cannot be put on a +4), and a timeout takes the cards', () => {
  const { s, ps, now } = table(3, { stacking: true });
  ps[0].hand = [card(1, 'wild', 'wild4'), card(2, 'blue', '5')]; // no red: a legal +4 under the strict rule
  ps[1].hand = [card(3, 'red', 'draw2'), card(4, 'wild', 'wild4')];
  G.act(s, ps[0], { op: 'play', cardId: 1, color: 'blue' }, now);
  assert.equal(s.pend.n, 4);
  assert.deepEqual(G.view(s, ps[1], now).playable, [4], 'a +2 is not allowed on a +4');
  const h = ps[1].hand.length;
  s.turnAt = now - 31000; // time is up for P1
  assert.equal(G.tick(s, now), true);
  assert.equal(ps[1].hand.length, h + 4, 'takes the 4 on timeout');
  assert.equal(s.pend, null);
});

test('stacking off: a +2 still makes the next player draw 2 at once (the old rule)', () => {
  const { s, ps, now } = table(3);
  ps[0].hand = [card(1, 'red', 'draw2'), card(2, 'red', '5')];
  const h = ps[1].hand.length;
  G.act(s, ps[0], { op: 'play', cardId: 1 }, now);
  assert.equal(s.pend ?? null, null);
  assert.equal(ps[1].hand.length, h + 2);
  assert.equal(turnOf(s), ps[2], 'and they lose the turn');
});

/* ---------- +4 challenge ---------- */

test('challenge: a bluffed +4 makes the bluffer draw 4 and the challenger plays on', () => {
  const { s, ps, now } = table(3, { challenge: true });
  ps[0].hand = [card(1, 'wild', 'wild4'), card(2, 'red', '5'), card(7, 'green', '1')]; // holds red: a bluff
  ps[1].hand = [card(3, 'blue', '1'), card(4, 'green', '2')];
  G.act(s, ps[0], { op: 'play', cardId: 1, color: 'blue' }, now);
  assert.equal(G.view(s, ps[1], now).pend.canChallenge, true);
  assert.equal(ps[1].hand.length, 2, 'the +4 waits');
  const h0 = ps[0].hand.length;
  G.act(s, ps[1], { op: 'challenge' }, now);
  assert.equal(ps[0].hand.length, h0 + 4, 'the bluffer draws 4');
  assert.equal(ps[1].hand.length, 2, 'the challenger draws nothing');
  assert.equal(turnOf(s), ps[1], 'and plays on');
  assert.equal(s.pend, null);
});

test('challenge: a legal +4 costs the challenger 6 and the turn', () => {
  const { s, ps, now } = table(3, { challenge: true });
  ps[0].hand = [card(1, 'wild', 'wild4'), card(2, 'blue', '5'), card(7, 'green', '1')]; // no red: legal
  ps[1].hand = [card(3, 'blue', '1'), card(4, 'green', '2')];
  G.act(s, ps[0], { op: 'play', cardId: 1, color: 'blue' }, now);
  G.act(s, ps[1], { op: 'challenge' }, now);
  assert.equal(ps[1].hand.length, 2 + 6);
  assert.equal(turnOf(s), ps[2]);
});

test('challenge: not challenging means drawing the 4; and challenge needs the setting and a waiting +4', () => {
  const on = table(3, { challenge: true });
  on.ps[0].hand = [card(1, 'wild', 'wild4'), card(2, 'red', '5')];
  G.act(on.s, on.ps[0], { op: 'play', cardId: 1, color: 'blue' }, on.now);
  const h = on.ps[1].hand.length;
  G.act(on.s, on.ps[1], { op: 'draw' }, on.now);
  assert.equal(on.ps[1].hand.length, h + 4);

  const nothing = table(3, { challenge: true });
  assert.throws(() => G.act(nothing.s, nothing.ps[0], { op: 'challenge' }, nothing.now), /nothing to challenge/);

  const off = table(3); // challenges off: the strict rule stays — a +4 only without the current colour
  off.ps[0].hand = [card(1, 'wild', 'wild4'), card(2, 'red', '5')];
  assert.throws(() => G.act(off.s, off.ps[0], { op: 'play', cardId: 1, color: 'blue' }, off.now), /only legal when you hold no card/);
});

test('settings: stacking and challenge are lobby-only admin switches', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'Boss', admin: true }, now);
  const b = G.join(s, { name: 'B', admin: false }, now);
  assert.equal(G.view(s, b, now).settings.stacking, false);
  assert.equal(G.view(s, b, now).settings.challenge, false);
  assert.throws(() => G.act(s, b, { op: 'config', stacking: true }, now), /Only the admin/);
  assert.throws(() => G.act(s, admin, { op: 'config', stacking: 'yes' }, now), /Bad settings/);
  G.act(s, admin, { op: 'config', stacking: true, challenge: true }, now);
  G.act(s, admin, { op: 'config', theme: 'classic' }, now);
  assert.equal(G.view(s, b, now).settings.stacking, true);
  assert.equal(G.view(s, b, now).settings.challenge, true);
  G.act(s, admin, { op: 'start' }, now);
  assert.throws(() => G.act(s, admin, { op: 'config', stacking: false }, now), /only be changed in the lobby/);
});

test('games with stacking and challenges on still always finish (random play)', () => {
  for (let round = 0; round < 25; round++) {
    const { s, ps } = table(4, { stacking: true, challenge: true });
    let now = 5000;
    let guard = 0;
    while (!s.over) {
      assert.ok(guard++ < 6000, 'game did not finish');
      const cur = turnOf(s);
      const v = G.view(s, cur, now);
      now += 10;
      if (cur.hand.length <= 2) { try { G.act(s, cur, { op: 'uno' }, now); } catch { /* fine */ } }
      if (v.pend && v.pend.canChallenge && Math.random() < 0.4) { G.act(s, cur, { op: 'challenge' }, now); continue; }
      const options = v.playable.map((id) => cur.hand.find((c) => c.id === id)).filter(Boolean);
      if (options.length) {
        const c = options[Math.floor(Math.random() * options.length)];
        const others = ps.filter((p) => p !== cur && s.seats.includes(p.id) && !p.finished);
        const body = { op: 'play', cardId: c.id, color: ['red', 'green', 'blue', 'yellow'][Math.floor(Math.random() * 4)] };
        if (c.value === 'swap' || c.value === 'master') {
          body.target = others[0].id;
          body.rule = c.value === 'master' ? 'blast' : undefined;
        }
        try { G.act(s, cur, body, now); } catch { G.act(s, cur, { op: 'draw' }, now); }
      } else if (s.drawnId != null) G.act(s, cur, { op: 'pass' }, now);
      else G.act(s, cur, { op: 'draw' }, now);
    }
    assert.ok(s.ranking.length >= 1);
  }
});

/* ---------- catching a missed GrowX! ---------- */

test('catch: the window closes when the next player acts, pressing GrowX! in time saves you, you cannot catch yourself', () => {
  const { s, ps, now } = table(3);
  ps[0].hand = [card(1, 'red', '9'), card(2, 'blue', '2')];
  ps[0].saidUno = false;
  ps[1].hand = [card(3, 'red', '1'), card(4, 'blue', '1'), card(10, 'green', '4')]; // three cards: nothing to catch after a play
  ps[2].hand = [card(5, 'red', '2'), card(6, 'green', '2')];
  G.act(s, ps[0], { op: 'play', cardId: 1 }, now);
  assert.equal(G.view(s, ps[2], now).catchable, ps[0].id);
  assert.throws(() => G.act(s, ps[0], { op: 'catch' }, now), /cannot catch yourself/);

  const saved = JSON.parse(JSON.stringify(s)); // branch 1: P0 presses GrowX! in time
  G.act(saved, saved.members[0], { op: 'uno' }, now);
  assert.equal(G.view(saved, saved.members[2], now).catchable, null);
  assert.throws(() => G.act(saved, saved.members[2], { op: 'catch' }, now), /Nobody to catch/);

  G.act(s, ps[1], { op: 'play', cardId: 3 }, now); // branch 2: the next player acts first — too late
  assert.equal(G.view(s, ps[2], now).catchable, null);
  assert.throws(() => G.act(s, ps[2], { op: 'catch' }, now), /Nobody to catch/);
});

test('catch: not while paused, and not for someone who already has more cards', () => {
  const { s, ps, now } = table(3);
  ps[0].hand = [card(1, 'red', '9'), card(2, 'blue', '2')];
  G.act(s, ps[0], { op: 'play', cardId: 1 }, now);
  G.act(s, ps[0], { op: 'pause' }, now);
  assert.throws(() => G.act(s, ps[2], { op: 'catch' }, now), /paused/);
  G.act(s, ps[0], { op: 'resume' }, now);
  ps[0].hand.push(card(8, 'red', '4')); // two cards now: nothing to catch
  assert.equal(G.view(s, ps[2], now).catchable, null);
});

/* ---------- leaving ---------- */

test('leave: the player goes, their cards return to the pile, and the table carries on', () => {
  const { s, ps, now } = table(3);
  const deckBefore = s.deck.length;
  const hand = ps[2].hand.length;
  G.act(s, ps[2], { op: 'leave' }, now);
  assert.equal(s.seats.includes(ps[2].id), false);
  assert.equal(s.members.some((m) => m.id === ps[2].id), false);
  assert.equal(s.deck.length, deckBefore + hand);
  assert.ok(s.left.includes(ps[2].id) && !(s.kicked || []).includes(ps[2].id), 'recorded as left, not as removed by the admin');
  assert.equal(s.over, false, 'two players are still playing');
  G.act(s, ps[1], { op: 'leave' }, now);
  assert.equal(s.over, true, 'with one player left the game ends');
});

test('API: leave answers "left" to later checks, blocks the old token, and signing in again works', async () => {
  const room = 'lv' + Math.floor(Math.random() * 1e6);
  const a = await call({ op: 'join', room, name: 'Boss', password: '110299' });
  const b = await call({ op: 'join', room, name: 'B', password: '123456' });
  assert.equal((await call({ op: 'leave', room, playerId: b.body.state.you })).code, 200);
  const after = await call({ op: 'state', room, playerId: b.body.state.you });
  assert.equal(after.body.left, true);
  const token = await call({ op: 'session', room, token: b.body.token });
  assert.equal(token.code, 401);
  assert.match(token.body.error, /left this game/);
  const back = await call({ op: 'join', room, name: 'B', password: '123456', playerId: b.body.state.you });
  assert.equal(back.code, 200, 'a fresh sign-in is fine');
  assert.notEqual(back.body.state.you, b.body.state.you, 'as a new player');
  assert.ok(a.body.state);
});

/* ---------- stats and history ---------- */

function finishWith(s, winner, loser, now) {
  s.cur = s.seats.indexOf(winner.id);
  s.color = 'red';
  s.discard.push(card(9100 + (s.gameNo || 0), 'red', '3'));
  winner.hand = [card(9200 + s.gameNo, 'red', '8')];
  winner.saidUno = false;
  G.act(s, winner, { op: 'play', cardId: 9200 + s.gameNo }, now);
}

test('stats: every finished game is kept (last 10) and the room table counts wins and losses', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const a = G.join(s, { name: 'Ann', admin: true }, now);
  const b = G.join(s, { name: 'Bob', admin: false }, now);
  for (let i = 1; i <= 3; i++) {
    G.act(s, a, { op: 'start' }, now);
    assert.equal(G.view(s, a, now).gameNo, i);
    finishWith(s, i === 3 ? b : a, i === 3 ? a : b, now);
    assert.equal(s.over, true);
  }
  const st = G.statsView(s, a).modes.public;
  assert.equal(st.history.length, 3);
  assert.equal(st.history[0].no, 3, 'newest first');
  assert.deepEqual(st.history[0].players.sort(), ['Ann', 'Bob']);
  assert.equal(st.history[0].ranking[0], 'Bob');
  assert.deepEqual(st.table.find((r) => r.name === 'Ann'), { name: 'Ann', played: 3, wins: 2, losses: 1 });
  assert.deepEqual(st.table.find((r) => r.name === 'Bob'), { name: 'Bob', played: 3, wins: 1, losses: 2 });
  assert.equal(st.table[0].name, 'Ann', 'most wins first');

  // a game that ends when someone leaves is recorded once; going back to the lobby does not add a game
  G.act(s, a, { op: 'start' }, now);
  G.act(s, b, { op: 'leave' }, now);
  assert.equal(G.statsView(s, a).modes.public.history.length, 4);
  G.act(s, a, { op: 'lobby' }, now);
  assert.equal(G.statsView(s, a).modes.public.history.length, 4);
  const bob2 = G.join(s, { name: 'Bob', admin: false }, now);
  for (let i = 0; i < 12; i++) { G.act(s, a, { op: 'start' }, now); finishWith(s, a, bob2, now); }
  assert.equal(G.statsView(s, a).modes.public.history.length, 10, 'only the last 10 games are kept');
});

test('API: stats are available to members of the room only', async () => {
  const room = 'st' + Math.floor(Math.random() * 1e6);
  const a = await call({ op: 'join', room, name: 'Boss', password: '110299' });
  const r = await call({ op: 'stats', room, playerId: a.body.state.you });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.stats, { current: 'public', modes: { public: { table: [], history: [] }, private: { table: [], history: [] } } }, 'the admin sees both, each empty');
  assert.equal((await call({ op: 'stats', room, playerId: 'nobody' })).code, 400);
});

test('stats: public and private games are kept apart, and each kind of player sees only their own', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'Boss', admin: true }, now);
  const pub = G.join(s, { name: 'Pub', admin: false, role: 'public' }, now);

  G.act(s, admin, { op: 'start' }, now); // a public game, won by Boss
  assert.equal(G.view(s, admin, now).gameMode, 'public');
  finishWith(s, admin, pub, now);

  G.act(s, admin, { op: 'lobby' }, now);
  G.act(s, admin, { op: 'private', on: true }, now); // the public player is removed
  const priv = G.join(s, { name: 'Priv', admin: false, role: 'private' }, now);
  G.act(s, admin, { op: 'start' }, now);
  assert.equal(G.view(s, admin, now).gameMode, 'private');
  finishWith(s, priv, admin, now); // a private game, won by Priv

  const both = G.statsView(s, admin);
  assert.equal(both.current, 'private');
  assert.deepEqual(both.modes.public.table.map((r) => [r.name, r.wins, r.losses]), [['Boss', 1, 0], ['Pub', 0, 1]]);
  assert.deepEqual(both.modes.private.table.map((r) => [r.name, r.wins, r.losses]), [['Priv', 1, 0], ['Boss', 0, 1]]);
  assert.equal(both.modes.public.history.length, 1);
  assert.equal(both.modes.private.history.length, 1);
  assert.equal(both.modes.public.history[0].players.includes('Priv'), false, 'nothing from the private game leaks into public');
  assert.equal(both.modes.private.history[0].players.includes('Pub'), false);

  const asPriv = G.statsView(s, priv);
  assert.deepEqual(Object.keys(asPriv.modes), ['private'], 'a private player sees private games only');
  const asPub = G.statsView(s, G.join(s, { name: 'Pub2', admin: false, role: 'public' }, now));
  assert.deepEqual(Object.keys(asPub.modes), ['public'], 'a public player sees public games only');
});

test('co-admin: can pause, resume and restart the game (back to the lobby), an ordinary player cannot', () => {
  const s = G.newRoom('t');
  const now = 1000;
  const admin = G.join(s, { name: 'Boss', admin: true }, now);
  const co = G.join(s, { name: 'Co', admin: false, role: 'public' }, now);
  const other = G.join(s, { name: 'Other', admin: false, role: 'public' }, now);
  G.act(s, admin, { op: 'starter', targetId: co.id, on: true }, now);
  G.act(s, co, { op: 'start' }, now);
  G.act(s, co, { op: 'pause' }, now);
  assert.equal(G.view(s, other, now).paused, true);
  G.act(s, co, { op: 'resume' }, now);
  assert.equal(G.view(s, other, now).paused, false);
  assert.throws(() => G.act(s, other, { op: 'pause' }, now), /Only the admin/);
  assert.throws(() => G.act(s, other, { op: 'lobby' }, now), /Only the admin/);
  G.act(s, co, { op: 'lobby' }, now);
  assert.equal(G.view(s, other, now).started, false, 'restart: everyone is back in the lobby');
  G.act(s, admin, { op: 'starter', targetId: co.id, on: false }, now);
  G.act(s, admin, { op: 'start' }, now);
  assert.throws(() => G.act(s, co, { op: 'pause' }, now), /Only the admin/, 'dropped co-admin loses it at once');
});
