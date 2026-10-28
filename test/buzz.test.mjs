import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The browser function, run here with a fake navigator that counts vibrations.
const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const body = /function buzzIfMyTurnStarted\(prev, s\) \{[\s\S]*?\n\}\n/.exec(src)[0];
let buzzes = 0;
const navigator = { vibrate: () => { buzzes++; return true; } };
let notified = 0;
const buzz = new Function('navigator', 'notifyTurn', `${body}; return buzzIfMyTurnStarted;`)(navigator, () => { notified++; });

const st = (o) => ({ started: true, over: false, paused: false, you: 'me', cur: 'x', turnAt: 1000, turnLeft: 20000, ...o });
const run = (prev, next) => { buzzes = 0; notified = 0; buzz(prev, next); assert.equal(notified, buzzes, 'a notification is attempted exactly when there is a buzz'); return buzzes; };

test('buzz when a turn of mine starts', () => {
  assert.equal(run(st({ cur: 'x' }), st({ cur: 'me', turnAt: 2000 })), 1, 'the turn passed to me');
  assert.equal(run(st({ cur: 'me', turnAt: 1000 }), st({ cur: 'me', turnAt: 2000 })), 1, 'I go again (🔁 Play Again, a skip that comes back round)');
});

test('no buzz when nothing new started', () => {
  assert.equal(run(st({ cur: 'me', turnAt: 1000 }), st({ cur: 'me', turnAt: 1000 })), 0, 'same turn, another update (chat, heartbeat, my own play)');
  assert.equal(run(st({ cur: 'me' }), st({ cur: 'x', turnAt: 2000 })), 0, 'my turn ended');
  assert.equal(run(st({ cur: 'x' }), st({ cur: 'y', turnAt: 2000 })), 0, "somebody else's turn");
  assert.equal(run(null, st({ cur: 'me' })), 0, 'first screen after a refresh');
  assert.equal(run(st({ started: false }), st({ cur: 'me' })), 0, 'game just started');
  assert.equal(run(st({ over: true }), st({ cur: 'me', turnAt: 2000 })), 0, 'previous game had ended');
  assert.equal(run(st({ cur: 'me', paused: true }), st({ cur: 'me', turnAt: 2000 })), 0, 'a pause ending');
  assert.equal(run(st({ cur: 'x' }), st({ cur: 'me', turnAt: 2000, paused: true })), 0, 'paused');
  assert.equal(run(st({ cur: 'x' }), st({ cur: 'me', turnAt: 2000, over: true })), 0, 'game over');
});
