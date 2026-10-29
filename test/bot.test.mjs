// A single-player match against the bot: anyone can start it, the bot plays by itself, and it never gets stuck.
process.env.GAME_DEAL = 'off';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../api/_lib/game.js';

function room() {
  const s = G.newRoom('b');
  const now = 1000;
  const admin = G.join(s, { name: 'Boss', admin: true, role: 'admin' }, now);
  const pub = G.join(s, { name: 'Pat', admin: false, role: 'public' }, now);
  const watcher = G.join(s, { name: 'Wes', admin: false, role: 'public' }, now);
  return { s, admin, pub, watcher, now };
}

test('bot: any player starts a match, only they and the bot are dealt in, the bot is hidden from the lobby', () => {
  const { s, admin, pub, watcher, now } = room();
  assert.throws(() => G.act(s, pub, { op: 'start' }, now), /Only the admin/, 'a plain start still needs the admin');
  G.act(s, pub, { op: 'botMatch' }, now);
  assert.equal(s.started, true);
  assert.equal(s.seats.length, 2);
  assert.ok(s.seats.includes(pub.id));
  const bot = s.members.find((m) => m.bot);
  assert.ok(bot && s.seats.includes(bot.id));
  assert.equal(G.view(s, watcher, now).seated, false, 'others only watch');
  assert.equal(G.view(s, pub, now).hand.length, 7);
  assert.equal(G.view(s, pub, now).botHost, true);
  assert.equal(G.view(s, admin, now).botHost, false);
  assert.equal(G.online(bot, now + 10 * 60 * 1000), true, 'the bot is never offline');
  assert.throws(() => G.act(s, watcher, { op: 'botMatch' }, now), /already running/);
});

test('bot: the bot plays its turns by itself and a whole match finishes without getting stuck', () => {
  for (let round = 0; round < 15; round++) {
    const { s, pub } = room();
    let now = 1000;
    G.act(s, pub, { op: 'botMatch' }, now);
    let steps = 0;
    while (!s.over && steps++ < 1500) {
      now += 1500;
      for (const m of s.members) if (!m.bot) m.lastSeen = now; // the people stay connected
      G.tick(s, now);
      if (s.over) break;
      if (s.seats[s.cur] !== pub.id) continue;
      const v = G.view(s, pub, now);
      if (v.pend && v.pend.canChallenge && Math.random() < 0.5) G.act(s, pub, { op: 'challenge' }, now);
      else if (v.playable.length) {
        const c = v.hand.find((h) => h.id === v.playable[0]);
        const others = s.seats.filter((id) => id !== pub.id);
        G.act(s, pub, { op: 'play', cardId: c.id, color: c.color === 'wild' ? 'blue' : undefined, target: others[0], rule: 'draw2' }, now);
      } else if (v.drawn != null) G.act(s, pub, { op: 'pass' }, now);
      else G.act(s, pub, { op: 'draw' }, now);
    }
    assert.equal(s.over, true, 'the match ended (round ' + round + ', ' + steps + ' steps)');
    assert.ok(s.ranking.length >= 1);
    assert.equal(s.stats, undefined, 'a bot match is not recorded in the table stats');
  }
});

test('bot: the player can pause, go back to the lobby and play again; the bot never shows in a normal lobby or start', () => {
  const { s, admin, pub, now } = room();
  G.act(s, pub, { op: 'botMatch' }, now);
  G.act(s, pub, { op: 'pause' }, now);
  assert.equal(s.paused, true);
  G.act(s, pub, { op: 'resume' }, now);
  G.act(s, pub, { op: 'lobby' }, now); // restart: back to the lobby
  assert.equal(s.members.some((m) => m.bot), false);
  assert.equal(G.view(s, admin, now).players.some((p) => /Bot/.test(p.name)), false);
  G.act(s, pub, { op: 'botMatch' }, now);
  G.act(s, admin, { op: 'lobby' }, now); // the admin can end it too
  assert.throws(() => G.act(s, pub, { op: 'lobby' }, now), /Only the admin/, 'no longer the bot host');
  G.act(s, admin, { op: 'start' }, now); // a normal game: the people only, no bot
  assert.equal(s.members.some((m) => m.bot), false);
  assert.equal(s.seats.length, 3);
});

test('bot: only the real admin can switch it off; off, players cannot start one but the admin still can', () => {
  const { s, admin, pub, now } = room();
  assert.equal(G.view(s, pub, now).canBot, true, 'on by default');
  assert.equal(G.view(s, admin, now).settings.botMatch, true);
  assert.throws(() => G.act(s, pub, { op: 'config', botMatch: false }, now), /Only the admin/);
  assert.throws(() => G.act(s, admin, { op: 'config', botMatch: 'no' }, now), /Bad settings/);
  G.act(s, admin, { op: 'config', botMatch: false }, now);
  assert.equal(G.view(s, pub, now).canBot, false);
  assert.equal(G.view(s, admin, now).canBot, true);
  assert.throws(() => G.act(s, pub, { op: 'botMatch' }, now), /switched off/);
  G.act(s, admin, { op: 'config', botMatch: true }, now);
  G.act(s, pub, { op: 'botMatch' }, now);
  assert.equal(s.started, true);
});
