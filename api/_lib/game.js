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
export const TURN_MS = 30000; // time a player has for their turn before it is played for them
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
    deck: [], discard: [], color: null, dir: 1, cur: 0, drawnId: null,
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
    add(c, 'again'); // super card: one per colour
    add(c, 'sweep'); // super card: one per colour
  }
  for (let i = 0; i < 4; i++) {
    add('wild', 'wild');
    add('wild', 'wild4');
  }
  for (let i = 0; i < 2; i++) {
    // super cards played like a Wild (you also choose the next colour)
    add('wild', 'blast');
    add('wild', 'swap');
    add('wild', 'gift');
  }
  add('wild', 'master'); // the one plain Master card: pick a player, then pick a super rule for them
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
  // a player marked to lose a turn (Master card +2 / +4) is skipped when the turn reaches them
  for (let guard = 0; guard < s.seats.length; guard++) {
    const next = byId(s, s.seats[s.cur]);
    if (!next.skipNext) break;
    next.skipNext = false;
    addLog(s, `${next.name} loses their turn.`);
    s.cur = index(s, s.cur, 1);
  }
  s.drawnId = null;
  s.turnAt = now;
}

/* ---------------- membership ---------------- */

export function join(s, { name, admin, role, playerId }, now) {
  let p = playerId ? byId(s, playerId) : null;
  if (!p) {
    p = { id: randomUUID(), name: cleanName(name), admin: false, lastSeen: now, hand: [], saidUno: false, finished: false };
    s.members.push(p);
    addLog(s, p.name + ' joined' + (s.started && !s.over ? ' (waiting for the next game).' : '.'));
  } else if (!online(p, now)) {
    addLog(s, p.name + ' reconnected.');
  }
  p.admin = !!admin;
  p.role = admin ? 'admin' : role || 'public'; // which password they used: admin | public | private
  p.lastSeen = now;
  return p;
}

/* ---------------- lobby chat ---------------- */

/** A short text or emoji message to everyone in the room (shown in the lobby). */
function chat(s, p, raw, now) {
  if (s.over) fail('The game has finished — the chat starts fresh with the next game.');
  const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
  if (!text) fail('Type a message first.');
  if (p.lastChat && now - p.lastChat < 600) fail('Slow down a little.');
  p.lastChat = now;
  s.chat = [...(s.chat || []), { from: p.id, name: p.name, text, t: now }].slice(-50);
}

/* ---------------- voice chat (membership only; audio is browser-to-browser) ---------------- */

/** Voice chat is for the admin and private players. */
export const canVoice = (p) => Boolean(p.admin || p.role === 'private');

function voiceJoin(s, p) {
  if (!canVoice(p)) fail('Voice chat is for private players and the admin.');
  s.voice = s.voice || [];
  if (!s.voice.includes(p.id)) s.voice.push(p.id);
}

function voiceLeave(s, p) {
  s.voice = (s.voice || []).filter((id) => id !== p.id);
}

/** Drops people from the voice list who left, went offline, were removed, or no longer qualify. */
function cleanVoice(s, now) {
  const before = s.voice || [];
  const keep = before.filter((id) => {
    const m = byId(s, id);
    return m && canVoice(m) && online(m, now);
  });
  if (keep.length === before.length) return false;
  s.voice = keep;
  return true;
}

/** Housekeeping run at the start of every request. Returns true if it changed the room. */
export function tick(s, now) {
  const voiceChanged = cleanVoice(s, now);
  const gameChanged = tickGame(s, now);
  const chatCleared = settle(s);
  return gameChanged || voiceChanged || chatCleared;
}

function tickGame(s, now) {
  if (!s.started) {
    const before = s.members.length;
    s.members = s.members.filter((m) => now - m.lastSeen < PRUNE_MS);
    return s.members.length !== before;
  }
  if (s.over) return false;
  if (s.paused) return false; // nothing times out or auto-plays while the admin has the game paused
  if (active(s).filter((p) => online(p, now)).length < 2) {
    s.over = true;
    s.winner = null;
    s.loser = null;
    s.notice = 'Game ended: not enough players left.';
    return true;
  }
  const p = byId(s, s.seats[s.cur]);
  const idle = now - s.turnAt;
  if (!online(p, now) && idle > AUTO_MS) {
    autoPlay(s, p, now);
    return true;
  }
  if (idle > TURN_MS) {
    // time is up: nothing is played for them. If they never picked up a card this turn they get 1 penalty card,
    // then the turn moves to the next player.
    if (s.drawnId == null) {
      give(s, p, 1);
      addLog(s, p.name + ' ran out of time — draws 1 card, turn passes.');
    } else {
      addLog(s, p.name + ' ran out of time — turn passes.');
    }
    advance(s, 1, now);
    return true;
  }
  return false;
}

/* ---------------- actions ---------------- */

export function act(s, me, b, now) {
  const result = dispatch(s, me, b, now);
  settle(s);
  return result;
}

/** The chat belongs to one game: once a game has finished it is cleared. Returns true if it changed anything. */
function settle(s) {
  if (s.over && s.chat && s.chat.length) {
    s.chat = [];
    return true;
  }
  return false;
}

function dispatch(s, me, b, now) {
  switch (b.op) {
    case 'start': return start(s, me, now);
    case 'play': return play(s, me, Number.isInteger(b.cardId) ? b.cardId : -1, String(b.color ?? ''), now, String(b.target ?? ''), String(b.rule ?? ''));
    case 'draw': return draw(s, me, now, b);
    case 'pass': return pass(s, me, now);
    case 'uno': return sayUno(s, me);
    case 'lobby': return toLobby(s, me);
    case 'private': return setPrivate(s, me, b.on === true, now);
    case 'chat': return chat(s, me, b.text, now);
    case 'pause': return setPaused(s, me, true, now);
    case 'resume': return setPaused(s, me, false, now);
    case 'voiceJoin': return voiceJoin(s, me);
    case 'voiceLeave': return voiceLeave(s, me);
    case 'kick': return kick(s, me, String(b.targetId ?? ''), now);
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
    m.skipNext = false;
  });
  s.seats = s.members.slice(0, MAX_SEATS).map((m) => m.id);
  s.deck = shuffle(buildDeck());
  s.discard = [];
  seated(s).forEach((m) => give(s, m, INITIAL_HAND));
  let first = s.deck.pop();
  while (first.color === 'wild' || ['skip', 'reverse', 'draw2', 'again', 'sweep'].includes(first.value)) {
    s.deck.unshift(first);
    shuffle(s.deck);
    first = s.deck.pop();
  }
  s.discard.push(first);
  s.color = first.color;
  s.dir = 1;
  s.cur = rnd(s.seats.length);
  s.drawnId = null;
  s.winner = null;
  s.loser = null;
  s.ranking = [];
  s.notice = null;
  s.started = true;
  s.over = false;
  s.turnAt = now;
  s.log = [];
  s.chat = []; // a new game starts with a clean chat
  s.paused = false;
  addLog(s, `Game started with ${s.seats.length} players. First card: ${first.color} ${first.value}`);
  addLog(s, `${byId(s, s.seats[s.cur]).name} goes first.`);
}

/**
 * Admin makes the game private (private players, password 281101) or public (public players, password 123456).
 * Players already in the room who joined with the other password no longer qualify and are removed.
 */
function setPrivate(s, p, on, now) {
  if (!p.admin) fail('Only the admin can do that.');
  s.private = on;
  addLog(s, on ? 'The admin made this game private.' : 'The admin made this game public.');
  const want = on ? 'private' : 'public';
  for (const m of [...s.members]) {
    if (!m.admin && (m.role ?? 'public') !== want) {
      removeMember(s, m, now);
      addLog(s, `${m.name} was removed (this game is now ${want}).`);
    }
  }
}

/** Admin removes a player (lobby or mid-game). Their cards go back into the draw pile. */
function kick(s, admin, targetId, now) {
  if (!admin.admin) fail('Only the admin can do that.');
  const t = byId(s, targetId);
  if (!t) fail('That player is not here.');
  if (t.admin) fail('You cannot remove an admin.');
  removeMember(s, t, now);
  addLog(s, `${t.name} was removed by the admin.`);
}

/** Takes a player out of the room, lobby or mid-game. Their cards go back into the draw pile. */
function removeMember(s, t, now) {
  s.voice = (s.voice || []).filter((id) => id !== t.id);
  const idx = s.seats.indexOf(t.id);
  if (s.started && !s.over && idx !== -1) {
    s.deck.unshift(...t.hand); // bottom of the pile (cards are drawn from the end)
    t.hand = [];
    const wasCurrent = idx === s.cur;
    s.seats.splice(idx, 1);
    const n = s.seats.length;
    s.members = s.members.filter((m) => m.id !== t.id);
    const left = active(s);
    if (left.length <= 1) {
      s.over = true;
      s.winner = s.ranking[0] ?? null;
      s.loser = s.ranking.length && left.length ? left[0].name : null;
      s.notice = s.loser ? null : 'Game ended: not enough players left.';
    } else {
      if (idx < s.cur) s.cur -= 1;
      if (wasCurrent) s.cur = s.dir === 1 ? idx % n : (idx - 1 + n) % n;
      while (byId(s, s.seats[s.cur]).finished) s.cur = (s.cur + s.dir + n) % n;
      if (wasCurrent) {
        s.drawnId = null;
        s.turnAt = now;
      }
    }
  } else {
    s.seats = s.seats.filter((id) => id !== t.id);
    s.members = s.members.filter((m) => m.id !== t.id);
  }
  s.kicked = [...(s.kicked || []), t.id].slice(-50);
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
    m.skipNext = false;
  });
  s.deck = [];
  s.discard = [];
  s.winner = null;
  s.loser = null;
  s.ranking = [];
  s.notice = null;
  s.drawnId = null;
  s.log = [];
  s.chat = []; // restart clears the chat
  s.paused = false;
  addLog(s, 'Back in the lobby.');
}

/** Admin freezes the game (no plays, draws or timeouts); resuming gives the player back the time they had left. */
function setPaused(s, p, on, now) {
  if (!p.admin) fail('Only the admin can do that.');
  if (!s.started || s.over) fail('No game running.');
  if (on === Boolean(s.paused)) return;
  if (on) {
    s.paused = true;
    s.pausedAt = now;
    addLog(s, 'The admin paused the game.');
  } else {
    s.turnAt = Math.min(now, s.turnAt + (now - s.pausedAt));
    s.paused = false;
    addLog(s, 'The admin resumed the game.');
  }
}

function requireTurn(s, p) {
  if (!s.started || s.over) fail('No game running.');
  if (s.paused) fail('The game is paused by the admin.');
  if (s.seats[s.cur] !== p.id) fail('It is not your turn.');
}

function play(s, p, cardId, chosen, now, targetId = '', ruleId = '') {
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
  let swapWith = null;
  if (c.value === 'swap') {
    swapWith = byId(s, targetId);
    if (!swapWith || swapWith === p || !s.seats.includes(swapWith.id) || swapWith.finished) {
      fail('Choose a player to swap hands with.');
    }
  }
  let rule = '';
  if (c.value === 'master') {
    // the Master card names a player (swapWith holds the chosen player) and one super rule to apply to them
    rule = ruleId;
    if (!MASTER_RULES.includes(rule)) fail('Choose a super rule for the Master card.');
    swapWith = byId(s, targetId);
    if (!swapWith || !s.seats.includes(swapWith.id) || swapWith.finished) fail('Choose a player for the Master card.');
    if (swapWith === p && !['again', 'sweep'].includes(rule)) fail('That rule needs another player — choose someone else.');
  }
  doPlay(s, p, c, chosen, now, swapWith, rule);
}

function draw(s, p, now, b = {}) {
  requireTurn(s, p);
  if (s.drawnId != null) fail('You already drew a card this turn.');
  const chosen = b.value ? chosenCard(s, p, b) : null; // validates before anything changes
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
  addLog(s, p.name + ' passes.');
  advance(s, 1, now);
}

function sayUno(s, p) {
  if (!s.started || s.over || !s.seats.includes(p.id)) fail('No game running.');
  if (p.hand.length > 2) fail('You can call GrowX when you have 2 or fewer cards.');
  p.saidUno = true;
  addLog(s, p.name + ' says GrowX!');
}

const SPECIALS = ['skip', 'reverse', 'draw2', 'again', 'sweep', 'wild', 'wild4', 'blast', 'swap', 'gift', 'master'];
const WILD_KINDS = ['wild', 'wild4', 'blast', 'swap', 'gift', 'master']; // cards with no colour of their own
const SUPER_NAMES = {
  again: '🔁 Play Again', sweep: '🧹 Sweep', blast: '💥 Blast', swap: '🔄 Swap Hands', gift: '🎁 Gift', master: '✨ Master Card',
};
// the rules a Master card can apply to a chosen player ('draw2' = +2, 'wild4' = +4)
const MASTER_RULES = ['again', 'sweep', 'blast', 'swap', 'gift', 'draw2', 'wild4'];

/** Admin-only: the card picked up is the special card the admin chose instead of the top of the pile. */
function chosenCard(s, p, b) {
  if (!p.admin) fail('Admin only.');
  const value = String(b.value ?? '');
  if (!SPECIALS.includes(value)) fail('Not a special card.');
  let color = String(b.color ?? '');
  if (WILD_KINDS.includes(value)) color = 'wild';
  else if (!COLORS.includes(color)) fail('Choose a colour.');
  s.nextId = (s.nextId ?? 1000) + 1;
  return { id: s.nextId, color, value };
}

/** Marks a player as out of cards. Returns true if that ended the game. */
function finishPlayer(s, t) {
  t.finished = true;
  t.saidUno = false;
  s.ranking.push(t.name);
  addLog(s, `${t.name} is out of cards — #${s.ranking.length}!`);
  const left = active(s);
  if (left.length > 1) return false;
  s.over = true;
  s.winner = s.ranking[0];
  s.loser = left.length ? left[0].name : null;
  s.notice = null;
  addLog(s, s.loser ? `${s.loser} is left holding cards and loses!` : 'Game over.');
  return true;
}

/**
 * ✨ Master card: apply the chosen super rule to the chosen player t (t may be p for Play Again / Sweep).
 * Returns 'again' (p plays again), 'jump' (the turn went to t), 'over' (the game ended) or null.
 */
function masterEffect(s, p, t, rule, now) {
  switch (rule) {
    case 'again':
      if (t === p) return 'again';
      t.skipNext = false; // they are about to play, so any pending lost turn is cancelled
      s.cur = s.seats.indexOf(t.id);
      s.drawnId = null;
      s.turnAt = now;
      addLog(s, `🔁 ${t.name} plays next.`);
      return 'jump';
    case 'sweep': {
      const swept = t.hand.filter((h) => h.color === s.color);
      if (!swept.length) {
        addLog(s, `🧹 ${t.name} has no ${s.color} cards to put down.`);
        return null;
      }
      t.hand = t.hand.filter((h) => h.color !== s.color);
      s.discard.splice(s.discard.length - 1, 0, ...swept); // under the Master card on top
      addLog(s, `🧹 ${t.name} put down ${swept.length} ${s.color} card${swept.length === 1 ? '' : 's'}.`);
      return t.hand.length === 0 && !t.finished && finishPlayer(s, t) ? 'over' : null;
    }
    case 'blast':
      give(s, t, 2);
      addLog(s, `💥 ${t.name} draws 2 cards.`);
      return null;
    case 'draw2':
    case 'wild4': {
      // +2 / +4 like the classic cards: the player draws and also loses their next turn
      const n = rule === 'wild4' ? 4 : 2;
      give(s, t, n);
      t.skipNext = true;
      addLog(s, `+${n} ${t.name} draws ${n} cards and loses their next turn.`);
      return null;
    }
    case 'swap':
      if (!p.finished && !t.finished) {
        [p.hand, t.hand] = [t.hand, p.hand];
        p.saidUno = false;
        t.saidUno = false;
        addLog(s, `🔄 ${p.name} swapped hands with ${t.name}.`);
      }
      return null;
    case 'gift': {
      const n = p.finished ? 0 : Math.min(2, p.hand.length - 1); // you always keep at least 1 card
      if (n > 0) {
        const given = shuffle([...p.hand]).slice(0, n);
        const ids = new Set(given.map((x) => x.id));
        p.hand = p.hand.filter((x) => !ids.has(x.id));
        t.hand.push(...given);
        t.saidUno = false;
        addLog(s, `🎁 ${p.name} gave ${t.name} ${n} card${n === 1 ? '' : 's'}.`);
      }
      return null;
    }
    default:
      return null;
  }
}

function doPlay(s, p, c, chosen, now, swapWith = null, rule = '') {
  const hadTwo = p.hand.length === 2; // playing from two cards is the moment GrowX! must already have been pressed
  p.hand = p.hand.filter((h) => h !== c && h.id !== c.id);
  let swept = [];
  if (c.value === 'sweep') {
    // 🧹 Sweep: every other card of the same colour in the hand goes down too (no effects; wilds are never swept)
    swept = p.hand.filter((h) => h.color === c.color);
    p.hand = p.hand.filter((h) => h.color !== c.color);
    s.discard.push(...swept); // the Sweep card itself lands on top
  }
  s.discard.push(c);
  s.color = c.color === 'wild' ? chosen : c.color;
  s.drawnId = null;
  const label = SUPER_NAMES[c.value] || c.value;
  addLog(s, `${p.name} played ${c.color === 'wild' ? '' : c.color + ' '}${label}${c.color === 'wild' ? ' → ' + s.color : ''}`);
  if (swept.length) addLog(s, `🧹 ${p.name} swept ${swept.length} more ${c.color} card${swept.length === 1 ? '' : 's'}.`);

  if (p.hand.length === 0) {
    if (finishPlayer(s, p)) return;
  } else if (p.hand.length === 1) {
    if (hadTwo && !p.saidUno) {
      give(s, p, 1);
      addLog(s, p.name + ' forgot to press GrowX! — draws 1 extra card.');
    } else {
      addLog(s, p.name + ' has one card left!');
    }
  } else if (p.hand.length > 2) {
    p.saidUno = false;
  }

  const target = byId(s, s.seats[index(s, s.cur, 1)]);
  let skip = false;
  let again = false;
  let jumped = false;
  switch (c.value) {
    case 'master': {
      const result = masterEffect(s, p, swapWith, rule, now);
      if (result === 'over') return;
      again = result === 'again';
      jumped = result === 'jump';
      break;
    }
    case 'again':
      again = true;
      break;
    case 'blast':
      for (const o of active(s)) {
        if (o !== p) give(s, o, 1);
      }
      addLog(s, '💥 Everyone else draws 1 card.');
      break;
    case 'swap':
      if (!p.finished && swapWith && !swapWith.finished) {
        [p.hand, swapWith.hand] = [swapWith.hand, p.hand];
        p.saidUno = false;
        swapWith.saidUno = false;
        addLog(s, `🔄 ${p.name} swapped hands with ${swapWith.name}.`);
      }
      break;
    case 'gift': {
      // give 1 random card to every other player, but always keep at least 1 card
      const others = active(s).filter((o) => o !== p);
      const n = Math.min(others.length, p.hand.length - 1);
      if (!p.finished && n > 0) {
        const pool = shuffle([...p.hand]);
        shuffle(others).slice(0, n).forEach((o, i) => {
          o.hand.push(pool[i]);
          o.saidUno = false;
        });
        const given = new Set(pool.slice(0, n).map((x) => x.id));
        p.hand = p.hand.filter((x) => !given.has(x.id));
        addLog(s, `🎁 ${p.name} gave ${n} card${n === 1 ? '' : 's'} away.`);
      }
      break;
    }
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
  if (jumped) return; // the Master card already handed the turn to the chosen player
  if (again && !p.finished) {
    // Play Again: the same player goes again with a fresh clock
    s.drawnId = null;
    s.turnAt = now;
    addLog(s, `🔁 ${p.name} plays again.`);
    return;
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

/** Plays a card for an automatic turn; Swap Hands needs someone to swap with, so pick a random opponent. */
function autoCard(s, p, c, now) {
  const opponents = active(s).filter((o) => o !== p);
  if (c.value === 'master') return doPlay(s, p, c, commonColor(p), now, p, 'sweep'); // harmless: sweeps their own colour
  const swapWith = c.value === 'swap' && opponents.length ? opponents[rnd(opponents.length)] : null;
  return doPlay(s, p, c, commonColor(p), now, swapWith);
}

/** An offline player's turn is played automatically so the table never stalls. */
function autoPlay(s, p, now) {
  if (p.hand.length <= 2) p.saidUno = true; // automatic turns never earn the GrowX! penalty
  if (s.drawnId != null) {
    // already drew this turn: the only legal card is the one just drawn
    return autoCard(s, p, p.hand.find((c) => c.id === s.drawnId), now);
  }
  const options = p.hand.filter((c) => playable(s, c, p)).sort((a, b) => (a.color === 'wild') - (b.color === 'wild'));
  if (options.length) return autoCard(s, p, options[0], now);
  drawOne(s, p, now);
  if (s.drawnId != null) autoCard(s, p, p.hand.find((c) => c.id === s.drawnId), now);
  return undefined;
}

/* ---------------- output ---------------- */

/** What one player is allowed to see (own hand only). */
export function view(s, me, now) {
  const out = {
    room: s.code, version: s.version, you: me.id, admin: me.admin, private: !!s.private,
    host: me.admin ? me.id : (s.members.find((m) => m.admin && online(m, now)) || {}).id || null,
    started: s.started, over: s.over, winner: s.winner, loser: s.loser, ranking: s.ranking, notice: s.notice,
    seated: s.started && s.seats.includes(me.id),
    players: (s.started ? seated(s) : s.members.filter((m) => online(m, now))).map((p) => ({
      id: p.id, name: p.name, count: p.hand.length, finished: s.started && p.finished, connected: online(p, now),
      role: me.admin ? p.role || 'public' : undefined, // only the admin needs to know who joined how
    })),
    log: s.log,
    chat: (s.chat || []).slice(-30),
    canVoice: canVoice(me),
    voice: canVoice(me) ? (s.voice || []).filter((id) => byId(s, id)) : [],
  };
  if (!s.started) return out;
  const myTurn = !s.over && s.seats[s.cur] === me.id;
  return {
    ...out,
    top: top(s), color: s.color, dir: s.dir, cur: s.seats[s.cur], deck: s.deck.length, drawn: s.drawnId,
    paused: Boolean(s.paused),
    turnMs: TURN_MS, turnLeft: s.over ? 0 : Math.max(0, TURN_MS - ((s.paused ? s.pausedAt : now) - s.turnAt)),
    hand: [...me.hand].sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || a.value.localeCompare(b.value)),
    playable: myTurn && !s.paused
      ? me.hand.filter((c) => (s.drawnId == null || c.id === s.drawnId) && playable(s, c, me)).map((c) => c.id)
      : [],
    saidUno: me.saidUno,
  };
}
