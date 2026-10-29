// Pure game rules. A room is one plain JSON object; every function mutates it and throws GameError
// on a rule violation (the caller then discards the mutated copy and saves nothing).
import { randomUUID } from 'node:crypto';
import { HANGUL } from './korean.js';

export class GameError extends Error {}

export const COLORS = ['red', 'yellow', 'green', 'blue'];
const MAX_SEATS = 8;
const DEFAULT_HAND = 7; // the official deal (the admin can choose 3-10)
export const HAND_MIN = 3;
export const HAND_MAX = 10;
const MAX_LOG = 40;
export const ONLINE_MS = 27000; // a player not heard from for this long counts as offline (kept under the 30 s turn)
export const HEARTBEAT_MS = 12000; // how often an idle client refreshes its presence (each refresh is a few database commands)
export const TURN_MS = 30000; // default time a player has for their turn; the admin can change it in the lobby
export const TURN_MIN_SECS = 15;
export const TURN_MAX_SECS = 120;
const PRUNE_MS = 120000; // lobby members unseen this long are dropped (a locked phone must not lose its seat)
const VOICE_GRACE_MS = 60000; // a short drop-out keeps your place in the voice list

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

export const online = (p, now) => Boolean(p.bot) || now - p.lastSeen < ONLINE_MS; // the bot never goes offline

/** Who is online right now, as a short string: lets a quiet poll tell "nothing changed" without a database write. */
export const presenceSig = (s, now) => s.members.map((m) => (online(m, now) ? 1 : 0)).join('');

export function newRoom(code) {
  return {
    code, version: 0, members: [], seats: [], started: false, over: false,
    winner: null, loser: null, ranking: [], notice: null,
    deck: [], discard: [], color: null, dir: 1, cur: 0, drawnId: null,
    turnAt: 0,
  };
}

/* ---------------- helpers ---------------- */

const byId = (s, id) => s.members.find((m) => m.id === id);
const seated = (s) => s.seats.map((id) => byId(s, id));
const active = (s) => seated(s).filter((p) => !p.finished);
const top = (s) => s.discard[s.discard.length - 1];

/** The event log lives only for the length of one request (for tests and debugging); the store never saves it. */
function addLog(s, msg) {
  (s.log ||= []).push(msg);
  while (s.log.length > MAX_LOG) s.log.shift();
}

function cleanName(raw) {
  let n = String(raw ?? '').trim().replace(/[<>&"']/g, '');
  if (!n) n = 'Player' + (100 + rnd(900));
  return n.slice(0, 16);
}

/** The six super-card kinds the admin can switch on or off in the lobby (all on by default). */
export const SUPER_KINDS = ['again', 'sweep', 'blast', 'swap', 'gift', 'master'];
/** Table looks the admin can choose from (the first is the default). The styling itself lives in the page's CSS. */
export const THEMES = ['growx', 'classic', 'midnight'];
/** How many cards each player is dealt (the admin sets it in the lobby; 5 unless changed). */
const handSizeOf = (s) => (s.settings && Number.isInteger(s.settings.handSize) ? s.settings.handSize : DEFAULT_HAND);
/**
 * The deal takes 5 to 15 seconds, longer the more cards go out (cards per player times players). Nobody can act until it is
 * over, and the first turn's clock starts then. GAME_DEAL=off (tests) skips it.
 */
export const dealMsFor = (cards) => (process.env.GAME_DEAL === 'off' ? 0 : Math.min(15000, Math.max(5000, cards * 240)));
const turnMsOf = (s) => (s.settings && Number.isInteger(s.settings.turnSecs) ? s.settings.turnSecs * 1000 : TURN_MS);
export const MATCH_TARGET = 500; // official: first to 500 points wins the match
/** Official card values: numbers = face value, Skip / Reverse / Draw Two = 20, Wild / Wild Draw Four = 50 (our extra cards: 20 / 50). */
export const cardPoints = (c) => (/^[0-9]$/.test(c.value) ? Number(c.value) : ['skip', 'reverse', 'draw2', 'again', 'sweep'].includes(c.value) ? 20 : 50);
const stackingOf = (s) => Boolean(s.settings && s.settings.stacking);
const challengeOf = (s) => !(s.settings && s.settings.challenge === false); // on by default, like the official rules
const voiceRelayOf = (s) => Boolean(s.settings && s.settings.voiceRelay);
const themeOf = (s) => (s.settings && THEMES.includes(s.settings.theme) ? s.settings.theme : THEMES[0]);
const superOn = (s, kind) => !(s.settings && s.settings.supers && s.settings.supers[kind] === false);
const superSettings = (s) => Object.fromEntries(SUPER_KINDS.map((k) => [k, superOn(s, k)]));

function buildDeck(on = () => true) {
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
    if (on('again')) add(c, 'again'); // super card: one per colour
    if (on('sweep')) add(c, 'sweep'); // super card: one per colour
  }
  for (let i = 0; i < 4; i++) {
    add('wild', 'wild');
    add('wild', 'wild4');
  }
  for (let i = 0; i < 2; i++) {
    // super cards played like a Wild (you also choose the next colour)
    if (on('blast')) add('wild', 'blast');
    if (on('swap')) add('wild', 'swap');
    if (on('gift')) add('wild', 'gift');
  }
  if (on('master')) add('wild', 'master'); // the one plain Master card: pick a player, then pick a super rule for them
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
  if (s.pend) return stackingOf(s) && c.value === s.pend.kind; // a penalty is waiting: only a card that stacks on it
  if (c.value === 'wild4') return challengeOf(s) || !p.hand.some((h) => h.color === s.color); // with challenges on, a +4 may be bluffed
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

export function join(s, { name, admin, role, playerId, coadmin }, now) {
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
  if (coadmin && !admin) {
    p.starter = true; // the co-admin password: the same rights as a co-admin the admin appointed
    p.auto = true;
  } else if (p.auto) {
    p.auto = false; // signed in again with an ordinary password: no longer a co-admin
    p.starter = false;
  }
  p.lastSeen = now;
  return p;
}

/* ---------------- lobby chat ---------------- */

/** A short text or emoji message to everyone in the room (shown in the lobby). */
/* ---------------- live Korean lesson (private games only) ---------------- */

const LEARN_TABS = Object.keys(HANGUL);
const LEARN_POINTS = 10;
/** Only the real admin and private players; anybody else gets what a made-up action gets, so there is nothing to find. */
export const canLearn = (p) => Boolean(p && (p.admin || p.role === 'private'));
const letterAt = (tab, idx) => (HANGUL[tab] || [])[idx];

/** The real admin teaches (picks the letter, starts and reveals quizzes); private players follow and answer. */
function learn(s, p, b, now) {
  if (!canLearn(p)) fail('Unknown action.');
  const L = s.learn || (s.learn = { tab: 'consonants', idx: 0, mode: 'learn', q: null, qn: 0, scores: {}, at: now });
  if (['learnAsk', 'learnWrite', 'learnMark', 'learnRemoveAsk'].includes(b.op)) return learnAsks(s, p, b, L, now);
  if (['learnWordAdd', 'learnWordRemove'].includes(b.op)) return learnWords(s, p, b, L, now);
  if (b.op === 'learnAnswer') {
    const q = L.q;
    if (!q || q.revealed) fail('There is no open question.');
    const choice = b.choice;
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.opts.length) fail('Bad answer.');
    if (q.answers[p.id] !== undefined) fail('You already answered.');
    q.answers[p.id] = choice;
    const waiting = s.members.filter((m) => canLearn(m) && online(m, now) && q.answers[m.id] === undefined);
    if (!waiting.length) revealQuestion(s, L);
    return;
  }
  if (!p.admin) fail('Only the teacher can do that.');
  if (b.op === 'learnShow') {
    if (!LEARN_TABS.includes(b.tab) || !Number.isInteger(b.idx) || !letterAt(b.tab, b.idx)) fail('Bad letter.');
    Object.assign(L, { tab: b.tab, idx: b.idx, mode: 'learn', q: null, at: now });
  } else if (b.op === 'learnQuiz') {
    const tab = LEARN_TABS.includes(b.tab) ? b.tab : L.tab;
    const rows = HANGUL[tab];
    const idx = rnd(rows.length);
    // the answers are the sounds of this letter and three other letters of the same group (all different)
    const others = shuffle(rows.map((_, i) => i).filter((i) => i !== idx && rows[i][1] !== rows[idx][1])).slice(0, 3);
    const order = shuffle([idx, ...others]);
    L.qn += 1;
    Object.assign(L, { tab, idx, mode: 'quiz', at: now, q: { n: L.qn, letter: rows[idx][0], opts: order.map((i) => rows[i][1]), correct: order.indexOf(idx), answers: {}, revealed: false } });
  } else if (b.op === 'learnReveal') {
    if (!L.q || L.q.revealed) fail('There is no open question.');
    revealQuestion(s, L);
  } else if (b.op === 'learnEnd') {
    s.learn = null;
  }
}

/**
 * Questions between members of the lesson ("write this word"): anybody in the lesson can ask one person, or everyone, to write
 * something. If the asker also types the expected answer the server checks it (the expected answer is only ever shown to the
 * asker); otherwise the asker marks each answer right or wrong. A right answer is worth the same points as a quiz answer.
 */
const MAX_ASKS = 20;
const norm = (t) => String(t).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
const award = (s, L, name) => { L.scores[name] = (L.scores[name] || 0) + LEARN_POINTS; };

function learnAsks(s, p, b, L, now) {
  L.asks = L.asks || [];
  if (b.op === 'learnAsk') {
    const text = String(b.text ?? '').trim().slice(0, 120);
    if (!text) fail('Write the question first.');
    const to = String(b.to ?? '');
    if (to !== 'all') {
      const t = byId(s, to);
      if (!t || t.id === p.id || !canLearn(t)) fail('Pick who to ask.');
    }
    const expect = String(b.expect ?? '').trim().slice(0, 60);
    L.asks.push({ id: (L.askSeq = (L.askSeq || 0) + 1), from: p.id, to, text, expect, answers: {}, at: now });
    L.asks = L.asks.slice(-MAX_ASKS);
    return;
  }
  const ask = L.asks.find((a) => a.id === b.id);
  if (!ask) fail('That question is gone.');
  if (b.op === 'learnWrite') {
    if (ask.from === p.id) fail('You asked this one.');
    if (ask.to !== 'all' && ask.to !== p.id) fail('That question is not for you.');
    if (ask.answers[p.id]) fail('You already answered.');
    const text = String(b.text ?? '').trim().slice(0, 60);
    if (!text) fail('Write your answer first.');
    const ans = { text, ok: null };
    if (ask.expect) {
      ans.ok = norm(text) === norm(ask.expect);
      if (ans.ok) award(s, L, p.name);
    }
    ask.answers[p.id] = ans;
    return;
  }
  if (ask.from !== p.id) fail('Only the one who asked can do that.');
  if (b.op === 'learnRemoveAsk') {
    L.asks = L.asks.filter((a) => a.id !== ask.id);
    return;
  }
  // learnMark: the asker says whether an answer is right (for questions with no expected answer)
  const ans = ask.answers[String(b.who ?? '')];
  if (!ans) fail('No such answer.');
  if (ask.expect) fail('This question is checked automatically.');
  if (ans.ok !== null) fail('Already marked.');
  ans.ok = b.ok === true;
  const who = byId(s, String(b.who));
  if (ans.ok && who) award(s, L, who.name);
}

/**
 * The word list: anybody in the lesson can add a Korean word (with an optional romanization and a meaning) and everybody in the
 * lesson reads the list. The one who added a word can remove it; the teacher can remove any.
 */
const MAX_WORDS = 60;
const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const clean = (t, n) => String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function learnWords(s, p, b, L, now) {
  L.words = L.words || [];
  if (b.op === 'learnWordAdd') {
    const ko = clean(b.ko, 30);
    const meaning = clean(b.meaning, 60);
    if (!ko) fail('Write the Korean word first.');
    if (!HANGUL_RE.test(ko)) fail('The word must be written in Korean letters (Hangul).');
    if (!meaning) fail('Write what the word means.');
    if (L.words.some((w) => norm(w.ko) === norm(ko))) fail('That word is already in the list.');
    if (L.words.length >= MAX_WORDS) fail('The list is full (' + MAX_WORDS + ' words) — remove one first.');
    L.words.push({ id: (L.wordSeq = (L.wordSeq || 0) + 1), ko, roman: clean(b.roman, 40), meaning, by: p.id, at: now });
    return;
  }
  const w = L.words.find((x) => x.id === b.id);
  if (!w) fail('That word is gone.');
  if (w.by !== p.id && !p.admin) fail('Only the one who added it, or the teacher, can remove it.');
  L.words = L.words.filter((x) => x.id !== w.id);
}

function revealQuestion(s, L) {
  const q = L.q;
  q.revealed = true;
  for (const [id, choice] of Object.entries(q.answers)) {
    const m = byId(s, id);
    if (m && choice === q.correct) L.scores[m.name] = (L.scores[m.name] || 0) + LEARN_POINTS;
  }
}

/** What a member of the lesson sees (nobody else gets the field at all). The right answer stays hidden until the reveal. */
function learnView(s, me) {
  if (!canLearn(me) || !s.learn) return undefined;
  const L = s.learn;
  const q = L.q;
  return {
    tab: L.tab, idx: L.idx, mode: L.mode, scores: L.scores, at: L.at,
    words: (L.words || []).map((w) => ({ id: w.id, ko: w.ko, roman: w.roman, meaning: w.meaning, byName: (byId(s, w.by) || {}).name || '?', mine: w.by === me.id, canRemove: w.by === me.id || Boolean(me.admin) })),
    asks: (L.asks || []).filter((a) => a.from === me.id || a.to === 'all' || a.to === me.id).map((a) => {
      const mineAsk = a.from === me.id;
      return {
        id: a.id, from: a.from, fromName: (byId(s, a.from) || {}).name || '?', to: a.to,
        toName: a.to === 'all' ? 'everyone' : (byId(s, a.to) || {}).name || '?', text: a.text,
        auto: Boolean(a.expect), expect: mineAsk ? a.expect : undefined, // the expected answer is for the asker's eyes only
        mine: mineAsk, myAnswer: a.answers[me.id] || null,
        answers: mineAsk ? Object.entries(a.answers).map(([id, x]) => ({ id, name: (byId(s, id) || {}).name || '?', text: x.text, ok: x.ok })) : undefined,
      };
    }),
    q: q ? {
      n: q.n, letter: q.letter, opts: q.opts, revealed: q.revealed,
      mine: q.answers[me.id] ?? null,
      answered: Object.keys(q.answers).length,
      correct: q.revealed ? q.correct : undefined,
      results: q.revealed ? Object.entries(q.answers).map(([id, c]) => ({ name: (byId(s, id) || {}).name || '?', ok: c === q.correct })) : undefined,
    } : null,
  };
}

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
export const canVoice = (s, p) => Boolean(p.admin || p.role === 'private' || publicVoiceOf(s));
// Public players' camera: allowed unless the real admin switched it off (the admin and private players always may).
export const publicVideoOf = (s) => !(s.settings && s.settings.publicVideo === false);
export const canVideo = (s, p) => canVoice(s, p) && Boolean(p.admin || p.role === 'private' || publicVideoOf(s));
export const publicVoiceOf = (s) => Boolean(s.settings && s.settings.publicVoice && !s.private); // never in a private game

function voiceJoin(s, p) {
  if (!canVoice(s, p)) fail('Voice chat is for private players and the admin.');
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
    return m && canVoice(s, m) && now - m.lastSeen < VOICE_GRACE_MS;
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
    s.members = s.members.filter((m) => m.bot || now - m.lastSeen < PRUNE_MS);
    return s.members.length !== before;
  }
  if (s.over) return false;
  if (s.paused) return false; // nothing times out or auto-plays while the admin has the game paused
  // Nobody plays for an absent player. If it is their turn, or too few people are left, the game pauses and
  // the admin decides: wait and resume, remove them, or restart.
  const p = byId(s, s.seats[s.cur]);
  const settled = now - (s.resumedAt || 0) > ONLINE_MS; // after a resume the admin gets a moment to act
  const fewLeft = active(s).filter((q) => online(q, now)).length < 2;
  if (settled && (!online(p, now) || fewLeft)) {
    s.paused = true;
    s.pausedAt = now;
    s.pauseNote = fewLeft ? 'Not enough players are connected.' : `${p.name} lost connection.`;
    addLog(s, 'Game paused: ' + s.pauseNote);
    return true;
  }
  if (p.bot && now >= Math.max(s.turnAt, s.botAt || 0) + BOT_THINK_MS) { // the bot's turn: it thinks for a moment, then makes one move
    s.botAt = now;
    botMove(s, p, now);
    return true;
  }
  const idle = now - s.turnAt;
  if (idle > turnMsOf(s)) {
    s.catchId = null;
    if (s.pend) {
      addLog(s, p.name + ' ran out of time.');
      takePend(s, p, now);
      return true;
    }
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

const DEAL_BLOCKED = ['play', 'draw', 'pass', 'uno', 'challenge', 'catch'];

function dispatch(s, me, b, now) {
  if (s.started && !s.over && now < (s.dealUntil || 0) && DEAL_BLOCKED.includes(b.op)) fail('The cards are still being dealt.');
  switch (b.op) {
    case 'start': return start(s, me, now);
    case 'botMatch': return botMatch(s, me, now);
    case 'play': return play(s, me, Number.isInteger(b.cardId) ? b.cardId : -1, String(b.color ?? ''), now, String(b.target ?? ''), String(b.rule ?? ''));
    case 'draw': return draw(s, me, now, b);
    case 'pass': return pass(s, me, now);
    case 'uno': return sayUno(s, me);
    case 'lobby': return toLobby(s, me);
    case 'private': return setPrivate(s, me, b.on === true, now);
    case 'config': return setConfig(s, me, b);
    case 'chat': return chat(s, me, b.text, now);
    case 'learnShow': case 'learnQuiz': case 'learnReveal': case 'learnAnswer': case 'learnEnd':
    case 'learnAsk': case 'learnWrite': case 'learnMark': case 'learnRemoveAsk': case 'learnWordAdd': case 'learnWordRemove': return learn(s, me, b, now);
    case 'pause': return setPaused(s, me, true, now);
    case 'resume': return setPaused(s, me, false, now);
    case 'voiceJoin': return voiceJoin(s, me);
    case 'voiceLeave': return voiceLeave(s, me);
    case 'kick': return kick(s, me, String(b.targetId ?? ''), now);
    case 'challenge': return challenge(s, me, now);
    case 'catch': return catchUno(s, me);
    case 'leave': return leave(s, me, now);
    case 'starter': return setStarter(s, me, String(b.targetId ?? ''), b.on === true);
    default: return fail('Unknown action.');
  }
}

function start(s, p, now, only = null) {
  if (!only && !p.admin && !p.starter) {
    if (s.botGame && s.botHost === p.id) return botMatch(s, p, now); // the player who began a bot match plays the next one the same way
    fail('Only the admin can start the game.');
  }
  if (s.started && !s.over) fail('A game is already running.');
  if (!only) {
    s.members = s.members.filter((m) => !m.bot && (m.id === p.id || online(m, now)));
    s.botGame = false;
    s.botHost = null;
  }
  if (s.members.length < 2) fail('At least 2 players are needed.');
  s.members.forEach((m) => {
    m.hand = [];
    m.saidUno = false;
    m.finished = false;
    m.skipNext = false;
  });
  s.seats = (only || s.members.slice(0, MAX_SEATS)).map((m) => m.id);
  s.deck = shuffle(buildDeck((kind) => superOn(s, kind))); // only the super cards the admin left ticked
  s.discard = [];
  const handSize = handSizeOf(s);
  if (s.seats.length * handSize + 1 > s.deck.length) fail('Not enough cards for that many players — lower the cards per player.');
  seated(s).forEach((m) => give(s, m, handSize));
  let first = s.deck.pop();
  // official: a Wild (or Wild Draw Four) cannot start the pile, so it goes back and another card is turned over. Our own
  // colour super cards are kept out too. Skip, Reverse and Draw Two are allowed and do their job (below).
  while (first.color === 'wild' || ['again', 'sweep'].includes(first.value)) {
    s.deck.unshift(first);
    shuffle(s.deck);
    first = s.deck.pop();
  }
  s.discard.push(first);
  s.color = first.color;
  s.dir = 1;
  s.cur = rnd(s.seats.length);
  if (s.matchWinner) { // the previous match was won: a new one starts from zero
    s.match = {};
    s.matchWinner = null;
  }
  s.roundWinner = null;
  s.roundPoints = 0;
  s.reveal = null;
  s.drawnId = null;
  s.winner = null;
  s.loser = null;
  s.ranking = [];
  s.notice = null;
  s.started = true;
  s.over = false;
  s.pend = null;
  s.catchId = null;
  s.gameNo = (s.gameNo || 0) + 1;
  s.gameNames = seated(s).map((m) => m.name);
  s.gameMode = s.private ? 'private' : 'public'; // which kind of game this is, for its stats and history
  s.dealMs = dealMsFor(s.seats.length * handSize);
  s.dealUntil = now + s.dealMs;
  s.turnAt = s.dealUntil; // the first turn's clock starts when the last card lands
  s.log = [];
  s.chat = []; // a new game starts with a clean chat
  s.paused = false;
  addLog(s, `Game started with ${s.seats.length} players. First card: ${first.color} ${first.value}`);
  const firstPlayer = byId(s, s.seats[s.cur]);
  if (first.value === 'skip') { // official: the first player misses their turn
    addLog(s, `${firstPlayer.name} is skipped.`);
    s.cur = index(s, s.cur, 1);
  } else if (first.value === 'reverse') { // official: play runs the other way round
    s.dir = -1;
    addLog(s, 'Direction reversed.');
  } else if (first.value === 'draw2') { // official: the first player draws two and misses their turn
    give(s, firstPlayer, 2);
    addLog(s, `${firstPlayer.name} draws 2.`);
    s.cur = index(s, s.cur, 1);
  }
  addLog(s, `${byId(s, s.seats[s.cur]).name} goes first.`);
}

/** Admin chooses which super cards are in the deck. Only possible before a game starts (lobby or results screen). */
function setConfig(s, p, b) {
  if (!p.admin && !p.starter) fail('Only the admin can do that.'); // the admin, or a player the admin allowed to start games
  const { supers, theme, handSize, voiceRelay, turnSecs, publicVoice, publicVideo, stacking, challenge: challengeOpt } = b || {};
  const hasSupers = supers && typeof supers === 'object';
  // the voice route and public voice are the real admin's alone (a co-admin has the rest of the game settings)
  if ((voiceRelay !== undefined || publicVoice !== undefined || publicVideo !== undefined) && !p.admin) fail('Only the admin can do that.');
  if (!hasSupers && theme === undefined && handSize === undefined && voiceRelay === undefined && turnSecs === undefined && publicVoice === undefined && publicVideo === undefined && stacking === undefined && challengeOpt === undefined) fail('Bad settings.');
  if (stacking !== undefined && typeof stacking !== 'boolean') fail('Bad settings.');
  if (challengeOpt !== undefined && typeof challengeOpt !== 'boolean') fail('Bad settings.');
  if (publicVoice !== undefined && typeof publicVoice !== 'boolean') fail('Bad settings.');
  if (publicVideo !== undefined && typeof publicVideo !== 'boolean') fail('Bad settings.');
  if (publicVoice === true && s.private) fail('Public voice is only for public games.');
  if (turnSecs !== undefined && !(Number.isInteger(turnSecs) && turnSecs >= TURN_MIN_SECS && turnSecs <= TURN_MAX_SECS)) {
    fail(`Turn time must be a whole number of seconds from ${TURN_MIN_SECS} to ${TURN_MAX_SECS}.`);
  }
  if (voiceRelay !== undefined && typeof voiceRelay !== 'boolean') fail('Bad settings.');
  if (theme !== undefined && !THEMES.includes(theme)) fail('Unknown theme.');
  if (handSize !== undefined && !(Number.isInteger(handSize) && handSize >= HAND_MIN && handSize <= HAND_MAX)) {
    fail(`Cards per player must be a whole number from ${HAND_MIN} to ${HAND_MAX}.`);
  }
  if ((hasSupers || handSize !== undefined || turnSecs !== undefined || stacking !== undefined || challengeOpt !== undefined) && s.started && !s.over) fail('Game settings can only be changed in the lobby.');
  const next = superSettings(s);
  if (hasSupers) {
    for (const kind of SUPER_KINDS) {
      if (typeof supers[kind] === 'boolean') next[kind] = supers[kind];
    }
  }
  // the theme and the voice route can be changed at any time, even during a game
  s.settings = {
    voiceRelay: voiceRelay !== undefined ? voiceRelay : voiceRelayOf(s),
    publicVoice: publicVoice !== undefined ? publicVoice : publicVoiceOf(s),
    publicVideo: publicVideo !== undefined ? publicVideo : publicVideoOf(s),
    stacking: stacking !== undefined ? stacking : stackingOf(s),
    challenge: challengeOpt !== undefined ? challengeOpt : challengeOf(s),
    turnSecs: turnSecs !== undefined ? turnSecs : turnMsOf(s) / 1000,
    supers: next,
    theme: theme !== undefined ? theme : themeOf(s),
    handSize: handSize !== undefined ? handSize : handSizeOf(s),
  };
}

/**
 * Admin makes the game private (private players, password 281101) or public (public players, password 123456).
 * Players already in the room who joined with the other password no longer qualify and are removed.
 */
function setPrivate(s, p, on, now) {
  if (!p.admin) fail('Only the admin can do that.');
  const changed = !!s.private !== !!on;
  s.private = on;
  if (on && s.settings) s.settings = { ...s.settings, publicVoice: false }; // a private game has no public voice, and it stays off when the game goes public again
  if (changed) s.chat = []; // switching public/private starts a clean chat
  if (!on) s.learn = null; // the Korean lesson belongs to private games
  addLog(s, on ? 'The admin made this game private.' : 'The admin made this game public.');
  const want = on ? 'private' : 'public';
  for (const m of [...s.members]) {
    if (!m.admin && (m.role ?? 'public') !== want) {
      removeMember(s, m, now);
      addLog(s, `${m.name} was removed (this game is now ${want}).`);
    }
  }
}

/**
 * The admin (110299) lets any public or private player start games, or takes that back at any time.
 * On screen that player is labelled "admin" and the real admin carries no label. A co-admin can start a game, choose the game settings,
 * pause / resume and restart it (back to the lobby), and nothing else: no public/private switch, no removing players,
 * no special-card pick-up, and no voice chat unless they joined with the private password.
 */
function setStarter(s, admin, targetId, on) {
  if (!admin.admin) fail('Only the admin can do that.');
  const t = byId(s, targetId);
  if (!t) fail('That player is not here.');
  if (t.admin) fail('That player is already an admin.');
  if (on === Boolean(t.starter)) return;
  t.starter = on;
  addLog(s, on ? `${t.name} can now start games.` : `${t.name} can no longer start games.`);
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
function removeMember(s, t, now, left = false) {
  s.voice = (s.voice || []).filter((id) => id !== t.id);
  s.pend = null; // a waiting +2 / +4 or catch does not survive a change of players
  s.catchId = null;
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
      recordGame(s);
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
  if (left) s.left = [...(s.left || []), t.id].slice(-50);
  else s.kicked = [...(s.kicked || []), t.id].slice(-50);
}

/** Admin ends the current game (running or finished) and sends everyone back to the lobby. */
function toLobby(s, p) {
  if (!p.admin && !p.starter && !isBotHost(s, p)) fail('Only the admin can do that.'); // the admin, or a player the admin allowed to run the game
  s.members = s.members.filter((m) => !m.bot);
  s.botGame = false;
  s.botHost = null;
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
  s.pend = null;
  s.catchId = null;
  s.log = [];
  s.chat = []; // restart clears the chat
  s.paused = false;
  addLog(s, 'Back in the lobby.');
}

/** Admin freezes the game (no plays, draws or timeouts); resuming gives the player back the time they had left. */
function setPaused(s, p, on, now) {
  if (!p.admin && !p.starter && !isBotHost(s, p)) fail('Only the admin can do that.'); // the admin, or a player the admin allowed to run the game
  if (!s.started || s.over) fail('No game running.');
  if (on === Boolean(s.paused)) return;
  if (on) {
    s.paused = true;
    s.pausedAt = now;
    s.pauseNote = '';
    addLog(s, 'The admin paused the game.');
  } else {
    // after an automatic pause (someone dropped) the player gets a fresh turn; after a manual one, the time they had left
    s.turnAt = s.pauseNote ? now : Math.min(now, s.turnAt + (now - s.pausedAt));
    s.paused = false;
    s.pauseNote = '';
    s.resumedAt = now;
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
    fail(s.pend
      ? (stackingOf(s) ? `Play another +${s.pend.kind === 'wild4' ? 4 : 2} to stack it, or draw ${s.pend.n}.` : `Draw ${s.pend.n}.`)
      : c.value === 'wild4'
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
    if (SUPER_KINDS.includes(rule) && !superOn(s, rule)) fail('That rule is switched off for this game.');
    swapWith = byId(s, targetId);
    if (!swapWith || !s.seats.includes(swapWith.id) || swapWith.finished) fail('Choose a player for the Master card.');
    if (swapWith === p && !['again', 'sweep'].includes(rule)) fail('That rule needs another player — choose someone else.');
  }
  s.catchId = null; // whoever acts after the catchable player closes the catching window
  doPlay(s, p, c, chosen, now, swapWith, rule);
}

function draw(s, p, now, b = {}) {
  requireTurn(s, p);
  if (s.drawnId != null) fail('You already drew a card this turn.');
  if (s.pend) {
    s.catchId = null;
    return takePend(s, p, now); // a +2 / +4 is waiting for you and you did not stack it: take the cards
  }
  const chosen = b.value ? chosenCard(s, p, b) : null; // validates before anything changes
  s.catchId = null;
  drawOne(s, p, now, chosen);
}

/** A waiting +2 / +4 is taken: the player draws everything stacked so far and loses the turn. */
function takePend(s, p, now) {
  const n = s.pend.n;
  s.pend = null;
  give(s, p, n);
  addLog(s, `${p.name} draws ${n}.`);
  advance(s, 1, now);
}

/** Wild Draw Four challenge (when the admin allowed it): was the +4 a bluff? */
function challenge(s, p, now) {
  requireTurn(s, p);
  const pd = s.pend;
  if (!pd || !challengeOf(s)) fail('There is nothing to challenge.');
  const by = byId(s, pd.by);
  if (!by || by.finished || !s.seats.includes(by.id)) fail('That player is already out of the game — nothing to challenge.');
  s.pend = null;
  s.catchId = null;
  const colour = pd.prevColor;
  const sign = pd.kind === 'wild4' ? '+4' : '+2';
  // everyone sees the result for a few seconds ("They had a red card" / "They had no red card")
  s.reveal = { id: (s.revealNo = (s.revealNo || 0) + 1), ok: Boolean(pd.bluff), challenger: p.name, target: by.name, colour, n: pd.n, kind: pd.kind, at: now };
  if (pd.bluff) {
    // successful: the cards go back to the player who played them, and the challenger plays on
    give(s, by, pd.n);
    s.drawnId = null;
    s.turnAt = now; // a fresh clock
    addLog(s, `⚔ ${p.name} challenged ${by.name}'s ${sign} — successful! ${by.name} had a ${colour} card and draws ${pd.n}.`);
  } else {
    // failed: the challenger takes the cards (the amount of the card, nothing extra) and loses the turn
    give(s, p, pd.n);
    addLog(s, `⚔ ${p.name} challenged ${by.name}'s ${sign} — failed! ${by.name} had no ${colour} card, so ${p.name} draws ${pd.n}.`);
    advance(s, 1, now);
  }
}

/** Anyone else may catch a player who is down to one card without having said GrowX!: they draw 2. */
function catchUno(s, p) {
  if (!s.started || s.over || !s.seats.includes(p.id) || p.finished) fail('No game running.');
  if (s.paused) fail('The game is paused by the admin.');
  const t = catchValid(s) ? byId(s, s.catchId) : null;
  if (!t) fail('Nobody to catch right now.');
  if (t.id === p.id) fail('You cannot catch yourself — press GrowX!');
  s.catchId = null;
  give(s, t, 2);
  addLog(s, `🎯 ${p.name} caught ${t.name} without GrowX! — ${t.name} draws 2.`);
}
const catchValid = (s) => {
  const t = s.catchId ? byId(s, s.catchId) : null;
  return Boolean(t && !s.over && !t.finished && t.hand.length === 1 && !t.saidUno);
};

/** A player leaves the game for good (their cards go back into the pile). They can sign in again as a new player. */
function leave(s, p, now) {
  addLog(s, `${p.name} left the game.`);
  removeMember(s, p, now, true);
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
  s.catchId = null;
  addLog(s, p.name + ' passes.');
  advance(s, 1, now);
}

function sayUno(s, p) {
  if (!s.started || s.over || !s.seats.includes(p.id)) fail('No game running.');
  if (p.hand.length > 2) fail('You can call GrowX when you have 2 or fewer cards.');
  p.saidUno = true;
  if (s.catchId === p.id) s.catchId = null; // said in time: nothing left to catch
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
  if (SUPER_KINDS.includes(value) && !superOn(s, value)) fail('That super card is switched off for this game.');
  let color = String(b.color ?? '');
  if (WILD_KINDS.includes(value)) color = 'wild';
  else if (!COLORS.includes(color)) fail('Choose a colour.');
  s.nextId = (s.nextId ?? 1000) + 1;
  return { id: s.nextId, color, value };
}

/** Marks a player as out of cards. Returns true if that ended the game. */
function finishPlayer(s, t) {
  const firstOut = s.ranking.length === 0;
  t.finished = true;
  t.saidUno = false;
  s.ranking.push(t.name);
  if (firstOut) {
    // official scoring: the winner of the round scores the value of every card still in the other players' hands
    s.roundWinner = t.name;
    s.roundPoints = active(s).reduce((sum, o) => sum + o.hand.reduce((a, c) => a + cardPoints(c), 0), 0);
  }
  addLog(s, `${t.name} is out of cards — #${s.ranking.length}!`);
  const left = active(s);
  if (left.length > 1) return false;
  s.over = true;
  s.winner = s.ranking[0];
  s.loser = left.length ? left[0].name : null;
  s.notice = null;
  addLog(s, s.loser ? `${s.loser} is left holding cards and loses!` : 'Game over.');
  recordGame(s);
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
  const prevColor = s.color; // the colour in play before this card (what a challenge asks about)
  const hadTwo = p.hand.length === 2; // playing from two cards is the moment GrowX! must already have been pressed
  p.hand = p.hand.filter((h) => h !== c && h.id !== c.id);
  const holdsColour = p.hand.some((h) => h.color === prevColor); // still holding that colour after playing = a challenge would succeed
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

  let lastPenalty = false;
  if (p.hand.length === 0) {
    // the winning card still does its job before the points are counted: a +2 / +4 played to go out makes the next player draw
    if (c.value === 'draw2' || c.value === 'wild4') {
      const nxt = byId(s, s.seats[index(s, s.cur, 1)]);
      const n = c.value === 'draw2' ? 2 : 4;
      if (nxt && nxt !== p && !nxt.finished) {
        give(s, nxt, n);
        addLog(s, nxt.name + ' draws ' + n + '.');
        lastPenalty = true;
      }
    }
    if (finishPlayer(s, p)) return;
  } else if (p.hand.length === 1) {
    if (hadTwo && !p.saidUno) {
      s.catchId = p.id; // anyone may catch it until the next player acts
      addLog(s, p.name + ' has one card left and did not say GrowX!');
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
      if (lastPenalty) {
        skip = true;
      } else if (stackingOf(s) || challengeOf(s)) {
        setPend(s, 'draw2', 2, p, holdsColour, target, prevColor);
      } else {
        give(s, target, 2);
        skip = true;
        addLog(s, target.name + ' draws 2.');
      }
      break;
    case 'wild4':
      if (lastPenalty) {
        skip = true;
      } else if (stackingOf(s) || challengeOf(s)) {
        setPend(s, 'wild4', 4, p, holdsColour, target, prevColor);
      } else {
        give(s, target, 4);
        skip = true;
        addLog(s, target.name + ' draws 4.');
      }
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

/**
 * A +2 / +4 that waits for the next player (stacking and/or challenges are on): they may stack the same card, challenge
 * a +4, or draw everything stacked so far. Only the same kind stacks (+2 on +2, +4 on +4).
 */
function setPend(s, kind, add, p, bluff, target, prevColor) {
  const prior = s.pend && s.pend.kind === kind ? s.pend.n : 0;
  s.pend = { kind, n: prior + add, by: p.id, bluff: Boolean(bluff), prevColor };
  addLog(s, `${target.name} must stack a +${add} or draw ${s.pend.n}.`);
}

const canChallenge = (s) => {
  const by = s.pend && challengeOf(s) ? byId(s, s.pend.by) : null;
  return Boolean(by && !by.finished && s.seats.includes(by.id));
};

/* ---------------- practice match against the bot ---------------- */

const BOT_NAME = 'GrowX Bot';
const BOT_THINK_MS = 1300; // the bot waits a moment before each move, so the table can be followed
const isBotHost = (s, p) => Boolean(s.botGame && s.botHost === p.id);

/**
 * Anyone in the room can play a single-player match against the bot: no admin or co-admin needed. Only the player and the
 * bot are dealt in; anybody else in the room watches. The match is not counted in the table's stats.
 */
function botMatch(s, p, now) {
  if (s.started && !s.over) fail('A game is already running.');
  s.members = s.members.filter((m) => !m.bot);
  const bot = { id: 'bot-' + randomUUID(), name: BOT_NAME, admin: false, role: 'public', bot: true, lastSeen: now, hand: [], saidUno: false, finished: false };
  s.members.push(bot);
  start(s, p, now, [p, bot]);
  s.botGame = true;
  s.botHost = p.id;
  s.botAt = 0;
}

/** One move for the bot: say GrowX when it should, answer a waiting +2/+4, play a card (wilds last), or draw. */
function botMove(s, p, now) {
  try {
    if (p.hand.length <= 2 && Math.random() < 0.8) sayUno(s, p); // now and then it forgets, so it can be caught
    const other = active(s).find((q) => q.id !== p.id);
    if (s.pend) {
      if (challengeOf(s) && canChallenge(s) && Math.random() < 0.3) return challenge(s, p, now);
      const stack = stackingOf(s) ? p.hand.find((c) => c.value === s.pend.kind) : null;
      if (stack) return botPlay(s, p, stack, other, now);
      return draw(s, p, now);
    }
    const ok = p.hand.filter((c) => (s.drawnId == null || c.id === s.drawnId) && playable(s, c, p));
    if (!ok.length) return s.drawnId != null ? pass(s, p, now) : draw(s, p, now);
    const plain = ok.filter((c) => c.color !== 'wild');
    const simpleWild = ok.filter((c) => ['wild', 'wild4', 'blast', 'gift'].includes(c.value));
    const pool = plain.length ? plain : simpleWild.length ? simpleWild : ok;
    // action cards first now and then, otherwise the highest number (it sheds the most points)
    const acts = pool.filter((c) => !/^[0-9]$/.test(c.value));
    const pick = acts.length && Math.random() < 0.4 ? acts[rnd(acts.length)] : [...pool].sort((a, b) => cardPoints(b) - cardPoints(a))[0];
    return botPlay(s, p, pick, other, now);
  } catch (e) {
    if (!(e instanceof GameError)) throw e;
    // whatever it tried was refused: fall back to the plain moves so the game can never get stuck on the bot
    try { return s.pend || s.drawnId == null ? draw(s, p, now) : pass(s, p, now); } catch (e2) { advance(s, 1, now); }
  }
}

function botPlay(s, p, c, other, now) {
  const counts = {};
  for (const h of p.hand) if (h.color !== 'wild' && h.id !== c.id) counts[h.color] = (counts[h.color] || 0) + 1;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const colour = best ? best[0] : COLORS[rnd(COLORS.length)];
  return play(s, p, c.id, c.color === 'wild' ? colour : '', now, other ? other.id : '', c.value === 'master' ? 'draw2' : '');
}

/** One line about a room for the admin's Rooms window. */
export function roomSummary(s, code, now) {
  const members = (s.members || []).filter((m) => !m.bot);
  return {
    code,
    mode: s.private ? 'private' : 'public',
    phase: !s.started ? 'lobby' : s.over ? 'finished' : s.paused ? 'paused' : 'playing',
    players: members.length,
    online: members.filter((m) => online(m, now)).length,
    names: members.slice(0, 8).map((m) => m.name),
    gameNo: s.gameNo || 0,
    last: members.reduce((t, m) => Math.max(t, m.lastSeen || 0), 0),
  };
}

/**
 * What the real admin sees when they watch a room from the Rooms window without joining it: the table, card counts and chat,
 * never anyone's cards. Nothing is written, so the admin is not a member and nobody in the room can tell.
 */
export function peekView(s, code, now) {
  const members = s.members || [];
  const seatedNow = s.started ? s.seats.map((id) => members.find((m) => m.id === id)).filter(Boolean) : members;
  const cur = s.started && !s.over ? members.find((m) => m.id === s.seats[s.cur]) : null;
  return {
    code, mode: s.private ? 'private' : 'public',
    phase: !s.started ? 'lobby' : s.over ? 'finished' : s.paused ? 'paused' : 'playing',
    gameNo: s.gameNo || 0, started: Boolean(s.started), over: Boolean(s.over),
    top: s.started ? top(s) : null, color: s.started ? s.color : null, dir: s.dir, deck: s.started ? s.deck.length : 0,
    cur: cur ? cur.name : null, ranking: s.ranking || [], loser: s.loser || null,
    totals: s.match || {}, target: MATCH_TARGET,
    players: seatedNow.map((p) => ({
      name: p.name, count: p.hand.length, finished: Boolean(s.started && p.finished), connected: online(p, now),
      admin: Boolean(p.admin), starter: Boolean(p.starter), role: p.role || 'public',
    })),
    chat: (s.chat || []).slice(-30),
  };
}

/* ---------------- stats and history ---------------- */

/**
 * Called once when a game ends. Public and private games are kept completely apart: each has its own table of wins and
 * losses and its own last 10 games, filed under the mode the game was started in.
 */
function recordGame(s) {
  if (s.recordedNo === s.gameNo) return;
  if (s.botGame) return; // a practice match against the bot is not part of the table's stats
  s.recordedNo = s.gameNo;
  const mode = s.gameMode === 'private' ? 'private' : 'public';
  const names = s.gameNames || [];
  s.stats = s.stats || {};
  const bucket = s.stats[mode] || { scores: {}, history: [] };
  bucket.history = [...bucket.history, {
    no: s.gameNo, at: Date.now(), players: names, ranking: [...s.ranking], loser: s.loser || null, notice: s.notice || null,
  }].slice(-10);
  const scores = { ...bucket.scores };
  for (const name of names) {
    const row = { played: 0, wins: 0, losses: 0, points: 0, ...(scores[name] || {}) };
    row.played += 1;
    if (s.ranking[0] === name) {
      row.wins += 1;
      row.points += s.roundPoints || 0;
    }
    if (s.loser === name) row.losses += 1;
    scores[name] = row;
  }
  bucket.scores = Object.fromEntries(Object.entries(scores).slice(-30));
  s.stats[mode] = bucket;
  // the match: points add up from game to game until somebody reaches 500
  if (s.roundWinner && s.roundPoints > 0) {
    s.match = { ...(s.match || {}) };
    s.match[s.roundWinner] = (s.match[s.roundWinner] || 0) + s.roundPoints;
    if (s.match[s.roundWinner] >= MATCH_TARGET) s.matchWinner = s.roundWinner;
  }
}

/**
 * What the Stats window shows. A public player sees only public games, a private player only private games; the admin
 * sees both, each on its own. Kept as long as the room lives.
 */
export function statsView(s, me) {
  const modes = me.admin ? ['public', 'private'] : [me.role === 'private' ? 'private' : 'public'];
  const out = {};
  for (const m of modes) {
    const b = (s.stats && s.stats[m]) || { scores: {}, history: [] };
    out[m] = {
      table: Object.entries(b.scores)
        .map(([name, r]) => ({ name, ...r }))
        .sort((a, c) => c.wins - a.wins || (c.points || 0) - (a.points || 0) || a.losses - c.losses || a.name.localeCompare(c.name)),
      history: [...b.history].reverse(),
    };
  }
  return { current: s.private ? 'private' : 'public', modes: out };
}

/* ---------------- output ---------------- */

/** What one player is allowed to see (own hand only). */
export function view(s, me, now) {
  const out = {
    room: s.code, version: s.version, ps: presenceSig(s, now), you: me.id, admin: me.admin, private: !!s.private,
    canStart: Boolean(me.admin || me.starter),
    host: me.admin ? me.id : (s.members.find((m) => m.admin && online(m, now)) || {}).id || null,
    started: s.started, over: s.over, winner: s.winner, loser: s.loser, ranking: s.ranking, notice: s.notice,
    seated: s.started && s.seats.includes(me.id),
    botHost: isBotHost(s, me), // the player running a bot match may pause it, restart it and play again
    players: (s.started ? seated(s) : s.members.filter((m) => !m.bot && online(m, now))).map((p) => ({
      id: p.id, name: p.name, count: p.hand.length, finished: s.started && p.finished, connected: online(p, now),
      isAdmin: me.admin ? Boolean(p.admin) : undefined, starter: Boolean(p.starter), // who the real admin is stays private
      role: me.admin ? p.role || 'public' : undefined, // only the admin needs to know who joined how
    })),
    chat: (s.chat || []).slice(-30),
    settings: { supers: superSettings(s), theme: themeOf(s), handSize: handSizeOf(s), voiceRelay: voiceRelayOf(s), publicVoice: publicVoiceOf(s), publicVideo: publicVideoOf(s), turnSecs: turnMsOf(s) / 1000, stacking: stackingOf(s), challenge: challengeOf(s) },
    learn: learnView(s, me), // the live Korean lesson: undefined (not even sent) for anyone but the admin and private players
    canVoice: canVoice(s, me),
    canVideo: canVideo(s, me),
    voice: canVoice(s, me) ? (s.voice || []).filter((id) => byId(s, id)) : [],
  };
  if (!s.started) return out;
  const myTurn = !s.over && s.seats[s.cur] === me.id;
  return {
    ...out,
    top: top(s), color: s.color, dir: s.dir, cur: s.seats[s.cur], deck: s.deck.length, drawn: s.drawnId,
    gameNo: s.gameNo || 0,
    gameMode: s.gameMode || (s.private ? 'private' : 'public'),
    pend: s.pend ? { kind: s.pend.kind, n: s.pend.n, by: (byId(s, s.pend.by) || {}).name || '', canChallenge: canChallenge(s), colour: s.pend.prevColor } : null,
    reveal: s.reveal && now - s.reveal.at < 8000 ? { ...s.reveal, age: now - s.reveal.at } : null, // the result of the last challenge, for a few seconds
    scoring: { target: MATCH_TARGET, roundWinner: s.roundWinner || null, roundPoints: s.roundPoints || 0, totals: s.match || {}, matchWinner: s.matchWinner || null },
    catchable: catchValid(s) ? s.catchId : null, // someone with one card left who did not say GrowX!
    turnAt: s.turnAt, // changes whenever a new turn starts, even when the same player goes again (🔁 Play Again)
    paused: Boolean(s.paused), pauseNote: s.paused ? s.pauseNote || '' : '',
    turnMs: turnMsOf(s), turnLeft: s.over ? 0 : Math.min(turnMsOf(s), Math.max(0, turnMsOf(s) - ((s.paused ? s.pausedAt : now) - s.turnAt))),
    dealLeft: Math.max(0, (s.dealUntil || 0) - now), dealMs: s.dealMs || 0, // the cards are still being handed out for this long
    hand: [...me.hand].sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || a.value.localeCompare(b.value)),
    playable: myTurn && !s.paused
      ? me.hand.filter((c) => (s.drawnId == null || c.id === s.drawnId) && playable(s, c, me)).map((c) => c.id)
      : [],
    saidUno: me.saidUno,
  };
}
