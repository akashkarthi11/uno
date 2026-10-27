// Pure game rules. A room is one plain JSON object; every function mutates it and throws GameError
// on a rule violation (the caller then discards the mutated copy and saves nothing).
import { randomUUID } from 'node:crypto';

export class GameError extends Error {}

export const COLORS = ['red', 'yellow', 'green', 'blue'];
const MAX_SEATS = 8;
const INITIAL_HAND = 5;
const MAX_LOG = 40;
export const ONLINE_MS = 20000; // a player not heard from for this long counts as offline
export const HEARTBEAT_MS = 8000; // how often an idle client refreshes its presence
const AUTO_MS = 3000; // wait before playing an offline player's turn
const PRUNE_MS = 30000; // lobby members unseen this long are dropped

const fail = (msg) => {
  throw new GameError(msg);
};
const rnd = (n) => Math.floor(Math.random() * n);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const online = (p, now) => now - p.lastSeen < ONLINE_MS;

export function newRoom(code) {
  return {
    code, version: 0, members: [], seats: [], started: false, over: false,
    winner: null, loser: null, ranking: [], notice: null,
    deck: [], discard: [], color: null, dir: 1, cur: 0, drawnId: null, unoId: null,
    log: [], turnAt: 0,
  };
}

/* ---------------- helpers ---------------- */

const byId = (s, id) => s.members.find((m) => m.id === id);
const seated = (s) => s.seats.map((id) => byId(s, id));
const active = (s) => seated(s).filter((p) => !p.finished);
const top = (s) => s.discard[s.discard.length - 1];

function addLog(s, msg) {
  s.log.push(msg);
  while (s.log.length > MAX_LOG) s.log.shift();
}

function cleanName(raw) {
  let n = String(raw ?? '').trim().replace(/[<>&"']/g, '');
  if (!n) n = 'Player' + (100 + rnd(900));
  return n.slice(0, 16);
}

function buildDeck() {
  const d = [];
  let id = 0;
  const add = (color, value) => d.push({ id: id++, color, value });
  for (const c of COLORS) {
    add(c, '0');
    for (let n = 1; n <= 9; n++) {
      add(c, String(n));
      add(c, String(n));
    }
    for (const v of ['skip', 'reverse', 'draw2']) {
      add(c, v);
      add(c, v);
    }
  }
  for (let i = 0; i < 4; i++) {
    add('wild', 'wild');
    add('wild', 'wild4');
  }
  return d;
}

/** Moves `steps` active seats in the current direction, skipping players who are already out. */
function index(s, from, steps) {
  const n = s.seats.length;
  let i = from;
  for (let k = 0; k < steps; k++) {
    do {
      i = (((i + s.dir) % n) + n) % n;
    } while (byId(s, s.seats[i]).finished);
  }
  return i;
}

function takeFromDeck(s) {
  if (s.deck.length === 0) {
    const t = s.discard.pop();
    s.deck = shuffle(s.discard.splice(0));
    s.discard.push(t);
    addLog(s, 'Draw pile reshuffled.');
  }
  return s.deck.pop();
}

function give(s, p, n) {
  for (let i = 0; i < n && !(s.deck.length === 0 && s.discard.length <= 1); i++) {
    p.hand.push(takeFromDeck(s));
  }
  if (p.hand.length > 2) p.saidUno = false;
}

function playable(s, c, p) {
  if (c.value === 'wild4') return !p.hand.some((h) => h.color === s.color);
  if (c.color === 'wild') return true;
  return c.color === s.color || c.value === top(s).value;
}

function advance(s, steps, now) {
  s.cur = index(s, s.cur, steps);
  s.drawnId = null;
  s.turnAt = now;
}

/* ---------------- membership ---------------- */

export function join(s, { name, admin, playerId }, now) {
  let p = playerId ? byId(s, playerId) : null;
  if (!p) {
    p = { id: randomUUID(), name: cleanName(name), admin: false, lastSeen: now, hand: [], saidUno: false, finished: false };
    s.members.push(p);
    addLog(s, p.name + ' joined' + (s.started && !s.over ? ' (waiting for the next game).' : '.'));
  } else if (!online(p, now)) {
    addLog(s, p.name + ' reconnected.');
  }
  p.admin = !!admin;
  p.lastSeen = now;
  return p;
}

/** Housekeeping run at the start of every request. Returns true if it changed the room. */
export function tick(s, now) {
  if (!s.started) {
    const before = s.members.length;
    s.members = s.members.filter((m) => now - m.lastSeen < PRUNE_MS);
    return s.members.length !== before;
  }
  if (s.over) return false;
  if (active(s).filter((p) => online(p, now)).length < 2) {
    s.over = true;
    s.winner = null;
    s.loser = null;
    s.notice = 'Game ended: not enough players left.';
    return true;
  }
  const p = byId(s, s.seats[s.cur]);
  if (!online(p, now) && now - s.turnAt > AUTO_MS) {
    autoPlay(s, p, now);
    return true;
  }
  return false;
}

/* ---------------- actions ---------------- */

export function act(s, me, b, now) {
  switch (b.op) {
    case 'start': return start(s, me, now);
    case 'play': return play(s, me, Number.isInteger(b.cardId) ? b.cardId : -1, String(b.color ?? ''), now);
    case 'draw': return draw(s, me, now, b);
    case 'pass': return pass(s, me, now);
    case 'uno': return sayUno(s, me);
    case 'catch': return catchUno(s, me);
    case 'lobby': return toLobby(s, me);
    default: return fail('Unknown action.');
  }
}

function start(s, p, now) {
  if (!p.admin) fail('Only the admin can start the game.');
  if (s.started && !s.over) fail('A game is already running.');
  s.members = s.members.filter((m) => m.id === p.id || online(m, now));
  if (s.members.length < 2) fail('At least 2 players are needed.');
  s.members.forEach((m) => {
    m.hand = [];
    m.saidUno = false;
    m.finished = false;
  });
  s.seats = s.members.slice(0, MAX_SEATS).map((m) => m.id);
  s.deck = shuffle(buildDeck());
  s.discard = [];
  seated(s).forEach((m) => give(s, m, INITIAL_HAND));
  let first = s.deck.pop();
  while (first.color === 'wild' || ['skip', 'reverse', 'draw2'].includes(first.value)) {
    s.deck.unshift(first);
    shuffle(s.deck);
    first = s.deck.pop();
  }
  s.discard.push(first);
  s.color = first.color;
  s.dir = 1;
  s.cur = rnd(s.seats.length);
  s.drawnId = null;
  s.unoId = null;
  s.winner = null;
  s.loser = null;
  s.ranking = [];
  s.notice = null;
  s.started = true;
  s.over = false;
  s.turnAt = now;
  s.log = [];
  addLog(s, `Game started with ${s.seats.length} players. First card: ${first.color} ${first.value}`);
  addLog(s, `${byId(s, s.seats[s.cur]).name} goes first.`);
}

/** Admin ends the current game (running or finished) and sends everyone back to the lobby. */
function toLobby(s, p) {
  if (!p.admin) fail('Only the admin can do that.');
  s.started = false;
  s.over = false;
  s.seats = [];
  s.members.forEach((m) => {
    m.hand = [];
    m.finished = false;
    m.saidUno = false;
  });
  s.deck = [];
  s.discard = [];
  s.winner = null;
  s.loser = null;
  s.ranking = [];
  s.notice = null;
  s.unoId = null;
  s.drawnId = null;
  s.log = [];
  addLog(s, 'Back in the lobby.');
}

function requireTurn(s, p) {
  if (!s.started || s.over) fail('No game running.');
  if (s.seats[s.cur] !== p.id) fail('It is not your turn.');
}

function play(s, p, cardId, chosen, now) {
  requireTurn(s, p);
  const c = p.hand.find((h) => h.id === cardId);
  if (!c) fail('That card is not in your hand.');
  if (s.drawnId != null && c.id !== s.drawnId) fail('You may only play the card you just drew.');
  if (!playable(s, c, p)) {
    fail(c.value === 'wild4'
      ? 'Wild Draw Four is only legal when you hold no card of the current colour.'
      : "You can't play that card.");
  }
  if (c.color === 'wild' && !COLORS.includes(chosen)) fail('Choose a colour.');
  beforeAction(s, p);
  doPlay(s, p, c, chosen, now);
}

function draw(s, p, now, b = {}) {
  requireTurn(s, p);
  if (s.drawnId != null) fail('You already drew a card this turn.');
  const chosen = b.value ? chosenCard(s, p, b) : null; // validates before anything changes
  beforeAction(s, p);
  drawOne(s, p, now, chosen);
}

function drawOne(s, p, now, card = null) {
  const c = card || takeFromDeck(s);
  p.hand.push(c);
  addLog(s, p.name + ' draws a card.');
  if (playable(s, c, p)) s.drawnId = c.id;
  else advance(s, 1, now);
}

function pass(s, p, now) {
  requireTurn(s, p);
  if (s.drawnId == null) fail('Draw a card before passing.');
  beforeAction(s, p);
  addLog(s, p.name + ' passes.');
  advance(s, 1, now);
}

function sayUno(s, p) {
  if (!s.started || s.over || !s.seats.includes(p.id)) fail('No game running.');
  if (p.hand.length > 2) fail('You can call GrowX when you have 2 or fewer cards.');
  p.saidUno = true;
  if (s.unoId === p.id) s.unoId = null;
  addLog(s, p.name + ' says GrowX!');
}

function catchUno(s, p) {
  const target = s.unoId ? byId(s, s.unoId) : null;
  if (!target || target === p || target.hand.length !== 1) fail('Nobody to catch.');
  give(s, target, 2);
  s.unoId = null;
  addLog(s, `${p.name} caught ${target.name} without calling GrowX — draws 2.`);
}

const SPECIALS = ['skip', 'reverse', 'draw2', 'wild', 'wild4'];

/** Admin-only: the card picked up is the special card the admin chose instead of the top of the pile. */
function chosenCard(s, p, b) {
  if (!p.admin) fail('Admin only.');
  const value = String(b.value ?? '');
  if (!SPECIALS.includes(value)) fail('Not a special card.');
  let color = String(b.color ?? '');
  if (value === 'wild' || value === 'wild4') color = 'wild';
  else if (!COLORS.includes(color)) fail('Choose a colour.');
  s.nextId = (s.nextId ?? 1000) + 1;
  return { id: s.nextId, color, value };
}

/** Anyone acting after a player dropped to one card without calling it makes that player draw 2. */
function beforeAction(s, actor) {
  if (!s.unoId) return;
  const u = byId(s, s.unoId);
  if (u && u !== actor && u.hand.length === 1 && !u.saidUno) {
    give(s, u, 2);
    addLog(s, u.name + ' forgot to call GrowX — draws 2.');
  }
  s.unoId = null;
}

function doPlay(s, p, c, chosen, now) {
  p.hand = p.hand.filter((h) => h !== c && h.id !== c.id);
  s.discard.push(c);
  s.color = c.color === 'wild' ? chosen : c.color;
  s.drawnId = null;
  addLog(s, `${p.name} played ${c.color === 'wild' ? '' : c.color + ' '}${c.value}${c.color === 'wild' ? ' → ' + s.color : ''}`);

  if (p.hand.length === 0) {
    p.finished = true;
    s.ranking.push(p.name);
    addLog(s, `${p.name} is out of cards — #${s.ranking.length}!`);
    const left = active(s);
    if (left.length <= 1) {
      s.over = true;
      s.winner = s.ranking[0];
      s.loser = left.length ? left[0].name : null;
      s.notice = null;
      addLog(s, s.loser ? `${s.loser} is left holding cards and loses!` : 'Game over.');
      return;
    }
  } else if (p.hand.length === 1) {
    if (p.saidUno) addLog(s, p.name + ' has one card left!');
    else s.unoId = p.id;
  } else if (p.hand.length > 2) {
    p.saidUno = false;
  }

  const target = byId(s, s.seats[index(s, s.cur, 1)]);
  let skip = false;
  switch (c.value) {
    case 'skip':
      skip = true;
      addLog(s, target.name + ' is skipped.');
      break;
    case 'reverse':
      s.dir = -s.dir;
      skip = !p.finished && active(s).length === 2;
      addLog(s, 'Direction reversed.');
      break;
    case 'draw2':
      give(s, target, 2);
      skip = true;
      addLog(s, target.name + ' draws 2.');
      break;
    case 'wild4':
      give(s, target, 4);
      skip = true;
      addLog(s, target.name + ' draws 4.');
      break;
    default:
  }
  advance(s, skip ? 2 : 1, now);
}

/* ---------------- offline players ---------------- */

function commonColor(p) {
  const count = Object.fromEntries(COLORS.map((c) => [c, 0]));
  p.hand.forEach((c) => {
    if (c.color !== 'wild') count[c.color]++;
  });
  return COLORS.reduce((a, b) => (count[b] > count[a] ? b : a), COLORS[0]);
}

/** An offline player's turn is played automatically so the table never stalls. */
function autoPlay(s, p, now) {
  beforeAction(s, p);
  const options = p.hand.filter((c) => playable(s, c, p)).sort((a, b) => (a.color === 'wild') - (b.color === 'wild'));
  if (options.length) return doPlay(s, p, options[0], commonColor(p), now);
  drawOne(s, p, now);
  if (s.drawnId != null) doPlay(s, p, p.hand.find((c) => c.id === s.drawnId), commonColor(p), now);
  return undefined;
}

/* ---------------- output ---------------- */

/** What one player is allowed to see (own hand only). */
export function view(s, me, now) {
  const out = {
    room: s.code, version: s.version, you: me.id, admin: me.admin,
    host: me.admin ? me.id : (s.members.find((m) => m.admin && online(m, now)) || {}).id || null,
    started: s.started, over: s.over, winner: s.winner, loser: s.loser, ranking: s.ranking, notice: s.notice,
    seated: s.started && s.seats.includes(me.id),
    players: (s.started ? seated(s) : s.members.filter((m) => online(m, now))).map((p) => ({
      id: p.id, name: p.name, count: p.hand.length, finished: s.started && p.finished, connected: online(p, now),
    })),
    log: s.log,
  };
  if (!s.started) return out;
  const myTurn = !s.over && s.seats[s.cur] === me.id;
  const u = s.unoId ? byId(s, s.unoId) : null;
  return {
    ...out,
    top: top(s), color: s.color, dir: s.dir, cur: s.seats[s.cur], deck: s.deck.length, drawn: s.drawnId,
    hand: [...me.hand].sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || a.value.localeCompare(b.value)),
    playable: myTurn
      ? me.hand.filter((c) => (s.drawnId == null || c.id === s.drawnId) && playable(s, c, me)).map((c) => c.id)
      : [],
    canCatch: !s.over && !!u && u !== me && s.seats.includes(me.id) && u.hand.length === 1,
  };
}
