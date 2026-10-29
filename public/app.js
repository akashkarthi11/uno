"use strict";

const LABEL = { skip: "⊘", reverse: "⇄", draw2: "+2", wild: "W", wild4: "+4", again: "🔁", sweep: "🧹", blast: "💥", swap: "🔄", gift: "🎁", master: "✨" };
const SUPER = new Set(["again", "sweep", "blast", "swap", "gift", "master"]); // super cards get a golden look
// Every poll is one database read, so calm screens slow down: the delay grows while nothing changes and snaps back on news.
const POLL_MS = 2000; // lobby / results screen, first polls
const POLL_QUIET_MS = 6000; // lobby / results / paused after a long quiet spell
const POLL_GAME_MS = 1500; // while a game is running
const POLL_GAME_QUIET_MS = 2500; // game running but nothing has moved for a while
const POLL_HIDDEN_MS = 8000; // tab not visible (still well inside the 27 s "online" window)
const REQUEST_TIMEOUT_MS = 8000;
const HEARTBEAT_MS = 8000;
const $ = (id) => document.getElementById(id);

let state = null;
let room = "main";
let myName = "";
let myPassword = "";
let playerId = null;
let polling = false;
let busy = false;
let toastTimer = null;

/**
 * The sign-in token lives in sessionStorage: it survives a refresh of this tab and is gone when the tab is closed,
 * so a shared computer never keeps someone's seat (or admin rights) around.
 */
function session(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch (e) { /* storage may be blocked */ }
  return null;
}
const tokenKey = () => "uno-token-" + room;

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (e) { /* storage may be blocked */ }
  return null;
}

/* ---------- server calls ---------- */

/** Ping badge: the middle value of the last 5 quiet checks (so one slow start does not show), green/orange/red like a game. */
const pingSamples = [];
let pingMid = null; // the ping badge's middle value in ms (null: unknown / offline); the camera picks its quality from it
function notePing(ms) {
  const el = $("ping");
  if (ms === null) { // the last check did not get through
    pingSamples.length = 0;
    pingMid = null;
    el.className = "ping bad";
    el.lastChild.textContent = "offline";
    return;
  }
  pingSamples.push(ms);
  if (pingSamples.length > 5) pingSamples.shift();
  const mid = [...pingSamples].sort((a, b) => a - b)[Math.floor(pingSamples.length / 2)];
  pingMid = mid;
  el.className = "ping " + (mid <= 100 ? "good" : mid <= 200 ? "mid" : "bad");
  el.lastChild.textContent = Math.round(mid) + " ms";
}

async function api(body) {
  // A request that hangs must not freeze the game, so every call has a timeout.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  const t0 = performance.now();
  let r;
  try {
    r = await fetch("/api/game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room, playerId, ...body }),
      cache: "no-store",
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (body.op === "state" && !document.hidden) notePing(performance.now() - t0); // polls are the same small request every time
  let data = {};
  try { data = await r.json(); } catch (e) { /* non-JSON error page */ }
  if (data.build) noteBuild(data.build);
  if (!r.ok) {
    const err = new Error(data.error || "Server error (" + r.status + ")");
    err.denied = !!data.denied;
    throw err;
  }
  return data;
}

/** The first answer tells us which version of the game server we are talking to; a different one later means a new deploy. */
let serverBuild = null;
function noteBuild(build) {
  if (serverBuild === null) serverBuild = build;
  else if (build !== serverBuild) $("updateBanner").classList.remove("hidden");
}
$("reloadBtn").addEventListener("click", () => location.reload());

/** ‹ › buttons appear only when the hand is wider than the screen; they scroll it by most of a screenful. */
function updateHandArrows() {
  const hand = $("hand");
  const more = hand.scrollWidth > hand.clientWidth + 2;
  $("handLeft").classList.toggle("hidden", !(more && hand.scrollLeft > 2));
  $("handRight").classList.toggle("hidden", !(more && hand.scrollLeft + hand.clientWidth < hand.scrollWidth - 2));
}
/** "▼ Your cards": shown while a game is running and the hand is below the visible part of the screen. */
function updateCardsPill() {
  const wrap = $("handWrap");
  const inGame = document.body.classList.contains("in-game");
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const hidden = inGame && wrap.getBoundingClientRect().top > vh - 36;
  $("cardsPill").classList.toggle("hidden", !hidden);
}
$("cardsPill").addEventListener("click", () => {
  $("handWrap").scrollIntoView({ behavior: "smooth", block: "end" });
  [150, 500, 1000].forEach((ms) => setTimeout(updateCardsPill, ms));
});
window.addEventListener("scroll", updateCardsPill, { passive: true });
window.addEventListener("resize", updateCardsPill);
setInterval(updateCardsPill, 700); // layouts change as the game moves on; a cheap check keeps the button honest

$("hand").addEventListener("scroll", updateHandArrows, { passive: true });
window.addEventListener("resize", updateHandArrows);
function scrollHand(direction) {
  const hand = $("hand");
  const calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  hand.scrollBy({ left: direction * Math.round(hand.clientWidth * 0.7), behavior: calm ? "auto" : "smooth" });
  // refresh the arrows once the scroll has finished (and again later, in case the animation is slow)
  [120, 450, 900].forEach((ms) => setTimeout(updateHandArrows, ms));
}
$("handLeft").addEventListener("click", () => scrollHand(-1));
$("handRight").addEventListener("click", () => scrollHand(1));

/** The real visible height of the screen (browser bars excluded), kept in a CSS variable the phone layout uses. */
function setAppHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-h", Math.round(h) + "px");
}
setAppHeight();
window.addEventListener("resize", setAppHeight);
window.addEventListener("orientationchange", setAppHeight);
if (window.visualViewport) window.visualViewport.addEventListener("resize", setAppHeight);

/** Forget everything remembered about the previous table (used when joining again or after being removed). */
function resetScreenCaches() {
  chatSig = "";
  hangul = null; // the letters are fetched again after a new sign-in, so they never outlive the right to see them
  if (typeof closeLearn === "function") closeLearn();
  floatSeenT = null;
  seenCards = null;
  lastTopId = null;
  celebrated = null;
  chatOpen = false;
  chatSeenT = 0;
  lastCur = null;
  flyFrom = null;
}

/**
 * One light tap whenever a new turn of yours starts: it passed to you, or you go again (🔁 Play Again, a Master card
 * aimed at yourself, a skip that comes back round). Not on the first screen after a refresh, not at the start of a game
 * and not when a pause ends. Judged on answers from the server only, never on the instant on-screen guesses.
 */
function buzzIfMyTurnStarted(prev, s) {
  if (!prev || !prev.started || prev.over || prev.paused || !s.started || s.over || s.paused) return;
  if (s.cur !== s.you || !(s.turnLeft > 0)) return;
  if (prev.cur === s.you && prev.turnAt === s.turnAt) return; // the same turn is still running
  notifyTurn(); // a notification (only when this page is in the background and alerts are on)
  try { if (navigator.vibrate) navigator.vibrate(90); } catch (e) { /* vibration not allowed here */ }
}

function apply(data) {
  if (data.token) session(tokenKey(), data.token); // renewed on every sign-in / resume
  if (data.state) {
    // Responses can arrive out of order; never replace newer state with older.
    if (state && data.state.you === state.you && data.state.version < state.version) return;
    const prev = state;
    state = data.state;
    buzzIfMyTurnStarted(prev, state);
    playerId = state.you;
    store("uno-id-" + room, playerId);
    render();
    if (state.canVoice) ensureVoice().then(() => voiceSync(state)).catch(() => {});
    else if (typeof voiceSync === "function") voiceSync(state); // lets a loaded voice.js hang up if access was lost
  }
}

async function join() {
  myName = $("nameInput").value.trim();
  myPassword = $("pwInput").value;
  if (!myPassword) { toast("Enter the password"); return; }
  room = $("roomInput").value.trim() || "main";
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(room)) { toast("Room: letters, digits, - and _ only"); return; }
  $("joinBtn").disabled = true;
  removed = false;
  resetScreenCaches();
  wantOrientation("portrait"); // the tap on Join is the permission the browser wants for full screen
  try {
    playerId = store("uno-id-" + room) || null;
    apply(await api({ op: "join", name: myName, password: myPassword }));
  } catch (e) {
    $("joinBtn").disabled = false;
    toast(e.message);
    return;
  }
  $("joinBtn").disabled = false;
  store("uno-name", myName);
  enterRoom();
}

function enterRoom() {
  history.replaceState(null, "", "?room=" + encodeURIComponent(room));
  $("roomName").textContent = room;
  $("roomInfo").classList.remove("hidden");
  $("joinScreen").classList.add("hidden");
  startPolling();
}

/** After a refresh: show the token from the earlier sign-in; the server checks it and puts this player back at the table. */
async function resumeSession() {
  const token = session(tokenKey());
  if (!token) return;
  $("joinScreen").classList.add("hidden"); // no flash of the sign-in form while the check runs
  toast("Reconnecting…");
  removed = false;
  resetScreenCaches();
  try {
    playerId = store("uno-id-" + room) || null;
    apply(await api({ op: "session", token }));
    const me = state && state.players.find((p) => p.id === state.you);
    myName = (me && me.name) || store("uno-name") || "";
    enterRoom();
  } catch (e) {
    // expired, signed out by a password change, or removed: show the normal sign-in form
    if (e.denied || /Session expired/.test(e.message)) session(tokenKey(), null);
    $("joinScreen").classList.remove("hidden");
    if (e.denied) toast(e.message);
  }
}

let inFlight = false;
let quiet = 0; // polls in a row that brought nothing new
let lastOk = Date.now();
let removed = false;

/** Keeps the screen awake while a game or voice chat is on, so the phone does not freeze the page and drop out. */
let wakeLock = null;
async function keepAwake() {
  try {
    if (!("wakeLock" in navigator) || wakeLock || document.hidden) return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (e) { /* not allowed (e.g. low battery); the game still works */ }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && polling) keepAwake(); });

function removedByAdmin(message = "You were removed by the admin.") {
  removed = true;
  applyTheme("growx"); // back on the sign-in screen: default look
  document.body.classList.remove("in-game");
  resetScreenCaches();
  if (typeof voiceStopLocal === "function") voiceStopLocal();
  state = null;
  playerId = null;
  store("uno-id-" + room, "");
  session(tokenKey(), null);
  ["game", "lobby", "roomInfo", "endModal", "playSheet", "sheetPill", "cheatModal", "chatToggle", "chatDock", "settingsModal"].forEach((id) => $(id).classList.add("hidden"));
  $("joinScreen").classList.remove("hidden");
  toast(message);
}

/** The Leave button: out of the game for good; signing in again joins as a new player. */
async function leaveGame() {
  if (!state) return;
  if (!confirm(state.started && !state.over ? "Leave the game? Your cards go back into the pile." : "Leave this room?")) return;
  try {
    await api({ op: "leave" });
  } catch (e) {
    toast(e.message);
    return;
  }
  removedByAdmin("You left the game.");
}
$("leaveBtn").addEventListener("click", leaveGame);

async function pollOnce() {
  if (busy || inFlight || removed) return;
  inFlight = true;
  try {
    const data = await api({ op: "state", since: state ? state.version : undefined, ps: state ? state.ps : undefined });
    if (data.kicked) {
      removedByAdmin();
    } else if (data.left) {
      removedByAdmin("You left the game.");
    } else if (data.closed) {
      removedByAdmin("This room was closed by the admin.");
    } else if (data.gone) {
      // The table forgot us (idle too long) — quietly rejoin: with the password if this page typed it, else with the token.
      playerId = null;
      state = null;
      apply(myPassword
        ? await api({ op: "join", name: myName, password: myPassword })
        : await api({ op: "session", token: session(tokenKey()) }));
    } else if (!data.unchanged) {
      quiet = 0;
      apply(data);
    } else {
      quiet++;
    }
    lastOk = Date.now();
    checkJoins();
  } catch (e) {
    notePing(null);
    if (Date.now() - lastOk > HEARTBEAT_MS) toast("Connection problem — retrying…");
  } finally {
    inFlight = false;
  }
}

function startPolling() {
  if (polling) return;
  polling = true;
  keepAwake();
  const tick = async () => {
    await pollOnce(); // never throws
    setTimeout(tick, pollDelay());
  };
  setTimeout(tick, pollDelay());
  // Background tabs throttle timers; catch up the moment the player looks again.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollOnce(); });
  window.addEventListener("focus", pollOnce);
  window.addEventListener("online", pollOnce);
  // A page restored from the back/forward cache is a frozen old copy: refresh it straight away.
  window.addEventListener("pageshow", (e) => { if (e.persisted) pollOnce(); });
}

/** Poll faster while a game is running (that is when waiting for someone's move is felt), slower in a hidden tab. */
function pollDelay() {
  // In voice chat a newcomer must be noticed quickly, so the quiet-screen slowdown is off and a hidden tab still checks often.
  const inVoice = typeof voice !== "undefined" && voice.active;
  if (document.hidden) return inVoice || notifyOn() ? 3000 : POLL_HIDDEN_MS;
  if (state && state.started && !state.over && !state.paused) return quiet > 20 && !inVoice ? POLL_GAME_QUIET_MS : POLL_GAME_MS;
  return quiet > 10 && !inVoice ? POLL_QUIET_MS : POLL_MS;
}

async function send(body, onFail) {
  if (busy) return; // ignore a second click while the first action is still on its way
  busy = true;
  quiet = 0;
  try {
    apply(await api(body));
  } catch (e) {
    if (onFail) onFail(); // undo any instant (optimistic) screen update
    if (/removed by the admin/.test(e.message)) removedByAdmin();
    else toast(e.message);
  } finally {
    busy = false;
  }
}

/** A chat message appears in your own chat box immediately; the server's reply then replaces it with the real one. */
function sendChat(text) {
  if (busy || !state) return;
  const before = state;
  const me = state.players.find((p) => p.id === state.you);
  const mine = { from: state.you, name: me ? me.name : "You", text, t: Date.now() };
  state = { ...state, chat: [...(state.chat || []), mine] };
  renderChat(state);
  floatOne(mine, state.you);
  send({ op: "chat", text }, () => {
    state = before; // refused (for example: too fast, or the game just ended): take it back
    chatSig = "";
    renderChat(state);
  });
}

/** Playing a plain card: show it on the pile at once; the server's reply (about a third of a second later) replaces it. */
function playNow(card) {
  const before = state;
  state = {
    ...state,
    hand: state.hand.filter((c) => c.id !== card.id),
    top: card,
    color: card.color,
    playable: [],
    pending: true, // cleared when the server's reply arrives
  };
  render();
  send({ op: "play", cardId: card.id }, () => {
    state = before; // the server refused it: put everything back
    render();
  });
}

/** voice.js is only needed by the admin and private players, so it is fetched on demand. */
let voiceLoading = null;
function ensureVoice() {
  if (typeof voiceSync === "function") return Promise.resolve();
  if (!voiceLoading) {
    voiceLoading = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = "voice.js";
      el.onload = resolve;
      el.onerror = () => { voiceLoading = null; reject(new Error("voice.js failed to load")); };
      document.head.appendChild(el);
    });
  }
  return voiceLoading;
}

/** Admin: voice goes straight between phones ("off", the original way) or may fall back to a relay server ("on"). */
function toggleRelay() {
  if (busy || !state || !state.admin) return;
  const on = !(state.settings && state.settings.voiceRelay);
  const before = state;
  state = { ...state, settings: { ...state.settings, voiceRelay: on } };
  render();
  send({ op: "config", voiceRelay: on }, () => { state = before; render(); });
}
$("relayBtn").addEventListener("click", toggleRelay);

/** Admin: may public players use voice chat too? (off by default: only the admin and private players) */
function togglePublicVoice() {
  if (busy || !state || !state.admin) return;
  const on = !(state.settings && state.settings.publicVoice);
  const before = state;
  state = { ...state, settings: { ...state.settings, publicVoice: on } };
  render();
  send({ op: "config", publicVoice: on }, () => { state = before; render(); });
}
/** Admin: may public players use their camera? (on by default; off hides public players' video) */
function togglePublicVideo() {
  if (busy || !state || !state.admin) return;
  const on = !(state.settings && state.settings.publicVideo);
  const before = state;
  state = { ...state, settings: { ...state.settings, publicVideo: on } };
  render();
  send({ op: "config", publicVideo: on }, () => { state = before; render(); });
}
$("pubVoiceBtn").addEventListener("click", togglePublicVoice);
$("pubVideoBtn").addEventListener("click", togglePublicVideo);

function renderRelayBtn(s) {
  const pv = $("pubVoiceBtn");
  pv.classList.toggle("hidden", !s.admin || s.private); // a private game has no public players, so the switch is not needed there
  const pvOn = Boolean(s.settings && s.settings.publicVoice);
  pv.textContent = "🎙 Public voice: " + (pvOn ? "on" : "off");
  pv.classList.toggle("on", pvOn);
  pv.title = pvOn
    ? "Public players can join voice chat too. Click to limit voice to you and private players."
    : "Only you and private players have voice chat. Click to let public players join it too.";
  const pvid = $("pubVideoBtn");
  pvid.classList.toggle("hidden", !s.admin || s.private);
  const pvidOn = !(s.settings && s.settings.publicVideo === false);
  pvid.textContent = "📷 Public video: " + (pvidOn ? "on" : "off");
  pvid.classList.toggle("on", pvidOn);
  pvid.title = pvidOn
    ? "Public players can use their camera. Click to hide public video (you and private players keep it)."
    : "Public players cannot use a camera. Click to allow it again.";
  const btn = $("relayBtn");
  btn.classList.toggle("hidden", !s.admin); // only the real admin, not a co-admin
  const on = Boolean(s.settings && s.settings.voiceRelay);
  btn.textContent = "📡 Relay: " + (on ? "on" : "off");
  btn.classList.toggle("on", on);
  btn.title = on
    ? "Voice may use a relay server when two phones cannot connect directly. Click to go back to direct only."
    : "Voice goes straight between phones. Click to also allow a relay server if some players cannot connect.";
}

function toggleStarter(p) {
  send({ op: "starter", targetId: p.id, on: !p.starter });
}

function removePlayer(p) {
  if (confirm("Remove " + p.name + " from the game?")) send({ op: "kick", targetId: p.id });
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3000);
}

/* ---------- rendering ---------- */

function cardEl(card) {
  const el = document.createElement("div");
  el.className = "card " + card.color;
  const plainWild = card.value === "wild"; // the official Wild: a black card with the four-colour oval and no symbol
  const sym = plainWild ? "" : LABEL[card.value] || card.value;
  const under = card.value === "6" || card.value === "9" ? " u" : ""; // real cards underline 6 and 9 so they cannot be mixed up
  const isSuper = SUPER.has(card.value);
  if (isSuper) el.classList.add("super");
  if (card.value === "master") el.classList.add("master"); // the plain blank-faced card
  el.innerHTML = (isSuper ? '<span class="star">★</span>' : "") +
    '<span class="c tl">' + sym + '</span><span class="v' + under + '">' + sym + '</span><span class="c br">' + sym + "</span>";
  return el;
}

/**
 * While the server says the cards are still being handed out (5 to 10 seconds), show them arriving one at a time, round the
 * table, and keep every card unplayable. The same clock the server uses, so everyone's deal ends together.
 */
let dealTimer = null;
function dealView(st) {
  if (!st.started || st.over || !(st.dealLeft > 0)) return st;
  if (!st._dealEnd) st._dealEnd = Date.now() + st.dealLeft;
  const left = st._dealEnd - Date.now();
  if (left <= 0) return st;
  const seats = st.players.length;
  const per = Math.max(1, ...st.players.map((p) => p.count)); // hand size (the first player may hold 2 more)
  const dealt = Math.floor((1 - left / st.dealMs) * seats * per); // cards handed out so far, one to each seat in turn
  const shown = (i) => Math.max(0, Math.floor((dealt - i + seats - 1) / seats));
  const mine = st.players.findIndex((p) => p.id === st.you);
  const players = st.players.map((p, i) => ({ ...p, count: Math.min(p.count, shown(i)) }));
  if (!dealTimer) dealTimer = setInterval(() => { if (state) render(); }, 200);
  return { ...st, players, hand: mine < 0 ? st.hand : st.hand.slice(0, players[mine].count), playable: [], dealing: true, turnLeft: st.turnMs, deck: st.deck + Math.max(0, seats * per - dealt) };
}

function render() {
  if (!state) return;
  const s = dealView(state);
  if (!s.dealing && dealTimer) { clearInterval(dealTimer); dealTimer = null; }
  $("privateChip").classList.toggle("hidden", !s.private);
  renderSettings(s);
  renderRelayBtn(s);
  renderNotifyBtn(); // the alerts switch belongs to the kind of game on screen (public or private)
  applyTheme(s.settings && s.settings.theme); // every update carries the room's theme, so a change shows for everyone
  const inGame = s.started;
  if (learnOpen) { if (inGame || !s.private) closeLearn(); else renderLearn(s); } // a starting game (or a game turned public) takes everyone out of the lesson
  // the sheet is only useful while it is still your turn and the card is still in your hand
  if (sheet && !(s.started && !s.over && !s.paused && s.cur === s.you && s.hand.some((c) => c.id === sheet.card.id))) closeSheet();
  document.body.classList.toggle("in-game", inGame); // on phones a running game fills the screen exactly, no page scrolling
  renderRotateHint();
  placeChat(inGame);
  wantOrientation(inGame && !document.body.classList.contains("learning") ? "landscape" : "portrait");
  renderChat(s);
  updateChatUi(s);
  $("lobby").classList.toggle("hidden", inGame);
  $("game").classList.toggle("hidden", !inGame);
  if (!inGame) {
    seenCards = null;
    lastTopId = null;
    lastCur = null;
    turn = null;
    updateTimer();
    $("endModal").classList.add("hidden");
    $("pauseBtn").classList.add("hidden"); // these two only exist during a game
    $("restartBtn").classList.add("hidden");
    return renderLobby(s);
  }
  renderGame(s);
  if (typeof layoutTiles === "function") layoutTiles(); // video tiles follow the freshly drawn seats
}

function renderLobby(s) {
  const ul = $("lobbyPlayers");
  ul.innerHTML = "";
  for (const p of s.players) {
    const li = document.createElement("li");
    li.dataset.pid = p.id;
    const av = document.createElement("span");
    av.className = "avatar";
    paintAvatar(av, p.name);
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = p.name + (p.id === s.you ? " (you)" : "");
    li.append(av, who);
    if (s.admin && p.id !== s.you && !p.isAdmin) {
      const c = document.createElement("button");
      c.className = "ghost cadm-lobby";
      c.textContent = p.starter ? "Drop admin" : "Make admin";
      c.title = p.starter ? "They can no longer start games" : "Lets them start games, nothing else";
      c.addEventListener("click", () => toggleStarter(p));
      li.appendChild(c);
    }
    if (s.admin && p.id !== s.you) {
      const x = document.createElement("button");
      x.className = "ghost remove";
      x.textContent = "Remove";
      x.addEventListener("click", () => removePlayer(p));
      li.appendChild(x);
    }
    // Players see the person allowed to start games as "admin"; the real admin carries no label.
    if (p.starter) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "admin";
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
  $("koreanBtn").classList.toggle("hidden", !s.private); // private games only: they hold the real admin and private players, nobody else
  const isHost = s.canStart; // the admin, or a player the admin allowed to start games
  $("lobbyCount").textContent = s.players.length + (s.players.length === 1 ? " player" : " players");
  $("startBtn").classList.toggle("hidden", !isHost);
  $("startBtn").disabled = s.players.length < 2;
  $("lobbyHint").textContent = isHost
    ? (s.players.length < 2 ? "Waiting for at least one more player — send them the invite link." : "Everyone here will be dealt in when you press Start.")
    : (s.host || s.players.some((p) => p.starter) ? "Waiting for the admin to start the game…" : "Waiting for the admin to join and start the game…");
}

/**
 * The drop: a copy of the card flies from where it was played (my hand, or an opponent's avatar) to the pile, lifts a
 * little just before landing, and the real card on the pile appears when it lands. Returns false if there is nothing
 * to animate (no start spot, reduced motion), so the plain "pop" is used instead.
 */
function flyCard(card, topEl, start, who) {
  if (!start || !start.width || !topEl.isConnected) return false;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const end = topEl.getBoundingClientRect();
  if (!end.width || !end.height || !fly_ok()) return false;
  const fly = cardEl(card);
  fly.classList.add("fly");
  Object.assign(fly.style, {
    position: "fixed", left: end.left + "px", top: end.top + "px", width: end.width + "px", height: end.height + "px",
    margin: "0", zIndex: "70", pointerEvents: "none", transformOrigin: "center",
  });
  if (who) {
    const tag = document.createElement("div");
    tag.className = "fly-tag";
    tag.textContent = who;
    fly.appendChild(tag);
  }
  document.body.appendChild(fly);
  topEl.style.visibility = "hidden";
  const dx = start.left + start.width / 2 - (end.left + end.width / 2);
  const dy = start.top + start.height / 2 - (end.top + end.height / 2);
  const sx = Math.max(0.15, start.width / end.width);
  const sy = Math.max(0.15, start.height / end.height);
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    fly.remove();
    topEl.style.visibility = "";
    topEl.classList.add("land");
  };
  try {
    const anim = fly.animate([
      { transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ") rotate(" + (who ? -28 : 10) + "deg)", opacity: who ? 0.55 : 1, offset: 0 },
      { transform: "translate(" + dx * 0.1 + "px," + (dy * 0.1 - 26) + "px) scale(1.14) rotate(-7deg)", opacity: 1, offset: 0.72 },
      { transform: "translate(0,0) scale(1) rotate(0deg)", opacity: 1, offset: 1 },
    ], { duration: who ? 520 : 420, easing: "cubic-bezier(.25,.8,.3,1)", fill: "forwards" });
    anim.onfinish = done;
    anim.oncancel = done;
  } catch (e) {
    done();
    return false;
  }
  setTimeout(done, 1000); // never leave a card hanging if the animation is interrupted
  return true;
}
const fly_ok = () => typeof Element !== "undefined" && typeof Element.prototype.animate === "function";

function renderGame(s) {
  const prevCur = lastCur;
  lastCur = s.cur;
  const me = s.players.find((p) => p.id === s.you);
  const myTurn = !s.over && s.cur === s.you;
  const curPlayer = s.players.find((p) => p.id === s.cur);

  const opp = $("opponents");
  opp.innerHTML = "";
  const others = s.players.filter((p) => p.id !== s.you);
  opp.dataset.n = String(others.length);
  others.forEach((p, i) => {
    const d = document.createElement("div");
    d.className = "opp" + (s.cur === p.id && !s.over ? " active" : "") + (p.connected ? "" : " offline");
    const rank = s.ranking.indexOf(p.name) + 1;
    // their cards, face down, so you can see and count them (a very long hand shows the first 16 and "+n")
    const shown = Math.min(p.count, maxBacks());
    d.innerHTML = '<div class="seat-top"><div class="avatar"></div><div class="name"></div><span class="count">' +
      (p.finished ? '<span class="uno-tag">✔ #' + rank + "</span>" :
        p.count + (p.count === 1 ? ' <span class="uno-tag">GrowX!</span>' : "")) +
      (p.connected ? "" : " · offline") + '</span></div><div class="mini">' + "<span></span>".repeat(shown) +
      (p.count > shown ? '<em class="more">+' + (p.count - shown) + "</em>" : "") + "</div>";
    // seats are spread along an arc over the top of the table: one opponent sits at the top, more fan out to the sides
    const ang = (160 - (others.length === 1 ? 70 : (140 * i) / (others.length - 1))) * (Math.PI / 180);
    const upright = window.innerHeight > window.innerWidth; // a tall, narrow table: a tighter, higher arc
    d.style.left = (50 + 36 * Math.cos(ang)).toFixed(1) + "%";
    d.style.top = ((upright ? 44 : 55) - (upright ? 24 : 32) * Math.sin(ang)).toFixed(1) + "%";
    d.querySelector(".name").textContent = p.name;
    d.dataset.pid = p.id;
    paintAvatar(d.querySelector(".avatar"), p.name);
    if (s.admin && !p.isAdmin) {
      const c = document.createElement("button");
      c.className = "ghost cadm" + (p.starter ? " on" : "");
      c.title = p.starter ? "Drop admin (can start games)" : "Make admin (can start games)";
      c.textContent = "★";
      c.addEventListener("click", () => toggleStarter(p));
      d.appendChild(c);
    }
    if (s.admin && !s.over) {
      const x = document.createElement("button");
      x.className = "ghost kick";
      x.title = "Remove " + p.name;
      x.textContent = "✕";
      x.addEventListener("click", () => removePlayer(p));
      d.appendChild(x);
    }
    opp.appendChild(d);
  });

  $("game").classList.toggle("myturn", myTurn);
  $("status").classList.toggle("mine", myTurn);

  const dp = $("discardPile");
  dp.innerHTML = "";
  dp.dataset.color = s.color;
  const topEl = cardEl(s.top);
  dp.appendChild(topEl);
  if (lastTopId !== null && lastTopId !== s.top.id) {
    // A card was played. Whoever's turn it was at the previous screen played it: my card drops from my hand, an
    // opponent's flies in from their avatar with their name on it.
    let start = null;
    let who = null;
    if (prevCur === s.you) {
      if (flyFrom && flyFrom.id === s.top.id && Date.now() - flyFrom.at < 15000) start = flyFrom.rect;
    } else if (prevCur) {
      const av = $("opponents").querySelector('[data-pid="' + prevCur + '"] .avatar');
      const pl = s.players.find((p) => p.id === prevCur);
      if (av) { start = av.getBoundingClientRect(); who = pl ? pl.name : ""; }
    }
    flyFrom = null;
    if (!flyCard(s.top, topEl, start, who)) topEl.classList.add("pop");
  }
  lastTopId = s.top.id;
  $("colorDot").style.background = "var(--" + (s.color === "yellow" ? "card-yellow" : s.color) + ")";
  $("drawCount").textContent = s.pend && myTurn ? "tap to draw " + s.pend.n : s.deck + " in pile";
  $("dirInfo").textContent = s.dir === 1 ? "↻" : "↺";

  const hand = $("hand");
  hand.innerHTML = "";
  const ok = new Set(s.playable);
  const firstRender = seenCards === null;
  const nowSeen = new Set();
  for (const card of s.hand) {
    const el = cardEl(card);
    nowSeen.add(card.id);
    if (!firstRender && !seenCards.has(card.id)) el.classList.add("deal"); // newly drawn card slides in
    if (ok.has(card.id)) el.classList.add("playable");
    el.addEventListener("click", () => {
      flyFrom = { id: card.id, rect: el.getBoundingClientRect(), at: Date.now() };
      onCard(card);
    });
    hand.appendChild(el);
  }
  if (!s.hand.length) {
    // never leave the hand area silently empty: say why
    const note = document.createElement("div");
    note.className = "hand-note";
    note.textContent = !s.seated
      ? "👀 You joined while a game was running — you'll get your cards in the next game."
      : "✔ You're out of cards.";
    hand.appendChild(note);
  }
  requestAnimationFrame(updateHandArrows); // after layout, so the arrows know whether the hand overflows

  seenCards = nowSeen;
  turn = s.over ? null : { deadline: Date.now() + s.turnLeft, frozen: s.turnLeft, paused: s.paused, total: s.turnMs, mine: myTurn, name: curPlayer ? curPlayer.name : "?" };
  $("pausedBanner").classList.toggle("hidden", !(s.paused && !s.over));
  $("pausedBanner").textContent = s.pauseNote ? "⏸ Game paused — " + s.pauseNote + (s.admin ? " Resume, remove them, or restart." : s.canStart ? " Resume or restart." : " Waiting for the admin.") : "⏸ Game paused by the admin";
  $("pauseBtn").classList.toggle("hidden", !(s.canStart && !s.over));
  $("pauseBtn").textContent = s.paused ? "▶" : "⏸";
  $("pauseBtn").title = s.paused ? "Resume the game" : "Pause the game";
  updateTimer();

  let msg;
  if (s.dealing) msg = "🃏 Dealing the cards…";
  else if (s.pending) msg = "Playing…";
  else if (!s.seated) msg = "You joined mid-game — you'll be dealt in next game.";
  else if (s.over) msg = "Game over.";
  else if (s.paused) msg = s.pauseNote ? "⏸ Paused — " + s.pauseNote : "⏸ Paused by the admin — hang tight.";
  else if (me && me.finished) msg = "You're out (#" + (s.ranking.indexOf(me.name) + 1) + ")! Watching the rest play…";
  else if (s.catchable === s.you) msg = "🚨 One card left — press GrowX! before someone catches you!";
  else if (myTurn && s.pend && s.pend.canChallenge && pendKey(s) !== cqDismissed) {
    msg = "⚔ Challenge question: does " + s.pend.by + " have a " + s.pend.colour + " card?";
  } else if (myTurn && s.pend) {
    msg = "+" + s.pend.n + " is waiting — " + (s.playable.length ? "play a " + (s.pend.kind === "wild4" ? "+4" : "+2") + " to stack it, " : "") +
      "or tap the pile to draw " + s.pend.n + ".";
  } else if (s.pend) msg = (curPlayer ? curPlayer.name : "?") + "'s turn… (+" + s.pend.n + " waiting)";
  else if (myTurn && me && me.count === 2 && !s.saidUno) msg = "⚠ Press GrowX! before you play your second-to-last card — or others can catch you (+2)!";
  else if (myTurn) msg = s.drawn != null ? "You drew a playable card — play it or press Pass." : (s.playable.length ? "Your turn — play a highlighted card or draw." : "Your turn — no playable card, draw from the pile.");
  else msg = (curPlayer ? curPlayer.name : "?") + "'s turn…";
  $("message").textContent = msg;

  // Spectators (joined mid-game) see the table and card counts only: no hand, no play buttons.
  ["passBtn", "unoBtn"].forEach((id) => $(id).classList.toggle("hidden", !s.seated));
  $("hand").classList.remove("hidden"); // the hand area is always there; it explains itself when it has no cards
  $("drawPile").style.cursor = s.seated ? "pointer" : "default";
  $("restartBtn").classList.toggle("hidden", !s.canStart);
  $("passBtn").disabled = !(myTurn && s.drawn != null) || s.paused;
  // GrowX! must be pressed while you hold 2 cards, i.e. before playing the second-to-last one.
  const canUno = s.seated && !s.over && !s.dealing && me && me.count > 0 && me.count <= 2 && !s.saidUno;
  $("unoBtn").disabled = !canUno;
  $("unoBtn").textContent = s.saidUno && me && me.count <= 2 ? "GrowX! ✓" : "GrowX!";
  $("unoBtn").classList.toggle("pulse", canUno && (myTurn || s.catchable === s.you));
  const catchTarget = s.catchable && s.catchable !== s.you && s.seated && me && !me.finished && !s.paused && !s.over
    ? s.players.find((p) => p.id === s.catchable) : null;
  $("catchBtn").classList.toggle("hidden", !catchTarget);
  if (catchTarget) $("catchBtn").textContent = "🎯 Catch " + catchTarget.name + "!";
  renderChallenge(s, myTurn);
  renderReveal(s);
  if (me) recordDeviceStats(s, me);

  const end = $("endModal");
  if (s.over) {
    const mine = me && me.name;
    $("endTitle").textContent = s.loser
      ? (s.loser === mine ? "😬 You lose — last with cards!" : s.loser + " loses!")
      : "Game ended";
    // one line per finisher, then who was left holding cards (shown with line breaks, see #endText in the CSS)
    const lines = [];
    if (s.notice) lines.push(s.notice);
    s.ranking.forEach((n, i) => lines.push((i + 1) + ". " + n));
    if (s.loser) lines.push("Last with cards: " + s.loser);
    $("endText").textContent = lines.join("\n");
    const sc = s.scoring || {};
    const score = [];
    if (sc.roundWinner) score.push("🏅 " + sc.roundWinner + " scores " + sc.roundPoints + " point" + (sc.roundPoints === 1 ? "" : "s") + " (the cards left in the others' hands)");
    const totals = Object.entries(sc.totals || {}).sort((a, b) => b[1] - a[1]);
    if (totals.length) score.push("Match (first to " + (sc.target || 500) + "): " + totals.map(([n, v]) => n + " " + v).join(" · "));
    if (sc.matchWinner) score.push("🏆 " + sc.matchWinner + " wins the match! A new match starts with the next game.");
    $("endScore").textContent = score.join("\n");
    $("playAgain").classList.toggle("hidden", !s.canStart);
    $("toLobby").classList.toggle("hidden", !s.canStart);
    $("endHint").textContent = s.canStart ? "" : "Waiting for the admin to start the next game…";
    end.classList.remove("hidden");
    const key = s.ranking.join("|") + "|" + (s.loser || "");
    if (celebrated !== key) {
      celebrated = key;
      if (s.loser && s.loser !== mine) confetti(); // anyone who didn't lose gets confetti
    }
  } else {
    end.classList.add("hidden");
    celebrated = null;
  }
}

/* ---------- turn timer ---------- */

let turn = null; // { deadline, total, mine, name } while a game is running

// The countdown never relies on colour: the bar shrinks, the number counts down, and the last seconds pulse
// (plus one short vibration on phones), so it works for colour-blind players and isn't a screen-wide flash.
const URGENT_SECS = 10;
const BUZZ_SECS = 5;
let buzzed = false;

function updateTimer() {
  const bar = $("turnBar");
  if (!turn) {
    bar.classList.add("hidden", "urgent");
    buzzed = false;
    return;
  }
  const left = turn.paused ? turn.frozen : Math.max(0, turn.deadline - Date.now());
  const frac = Math.min(1, left / turn.total);
  const secs = Math.ceil(left / 1000);
  bar.classList.remove("hidden");
  $("turnFill").style.width = frac * 100 + "%";
  $("turnFill").style.background = turn.paused ? "#98a2b3" : ""; // grey while frozen, brand purple otherwise

  const urgent = turn.mine && !turn.paused && secs <= URGENT_SECS;
  bar.classList.toggle("urgent", urgent);
  if (turn.paused) $("turnText").textContent = "⏸ Paused · " + secs + "s left";
  else if (turn.mine) $("turnText").textContent = (urgent ? "⏰ Hurry! " : "Your turn · ") + secs + "s";
  else $("turnText").textContent = turn.name + "'s turn · " + secs + "s";

  if (turn.mine && !turn.paused && secs <= BUZZ_SECS && secs > 0 && !buzzed) {
    buzzed = true;
    if (navigator.vibrate) navigator.vibrate(150);
  }
  if (!turn.mine || secs > URGENT_SECS) buzzed = false;
}
setInterval(updateTimer, 250);

/* ---------- lobby chat ---------- */

const EMOJIS = ["😀", "😂", "😎", "👍", "👏", "🔥", "🎉", "🙌", "❤️", "😮", "😭", "🤝"];
let chatSig = "";
let chatOpen = false; // the floating panel during a game
let chatSeenT = 0; // newest message the player has had a chance to read
let chatInGame = false;

/** The chat sits in the lobby card; during a game it moves into a floating panel opened by the 💬 button. */
function placeChat(inGame) {
  chatInGame = inGame;
  const chat = $("chat");
  if (inGame) {
    if (chat.parentElement !== $("chatDock")) $("chatDock").appendChild(chat);
  } else {
    if (chat.parentElement !== $("lobby")) $("lobby").appendChild(chat);
    chatOpen = false;
  }
  $("chatToggle").classList.toggle("hidden", !inGame);
  $("chatDock").classList.toggle("hidden", !(inGame && chatOpen));
}

function updateChatUi(s) {
  const msgs = s.chat || [];
  const newest = msgs.length ? msgs[msgs.length - 1].t : 0;
  if (!chatInGame || chatOpen) chatSeenT = Math.max(chatSeenT, newest);
  const unread = msgs.filter((m) => m.t > chatSeenT && m.from !== s.you).length;
  const badge = $("chatBadge");
  badge.textContent = unread > 9 ? "9+" : String(unread);
  badge.classList.toggle("hidden", unread === 0);
  // chat belongs to one game: once it has finished, writing waits for the next one
  $("chatInput").disabled = s.over;
  $("chatInput").placeholder = s.over ? "Chat starts fresh with the next game" : "Say something…";
}

$("chatToggle").addEventListener("click", () => {
  chatOpen = !chatOpen;
  $("chatDock").classList.toggle("hidden", !chatOpen);
  if (chatOpen) {
    const log = $("chatLog");
    log.scrollTop = log.scrollHeight;
    $("chatInput").focus();
  }
  if (state) updateChatUi(state);
});

function isEmojiOnly(text) {
  return text.length <= 8 && !/[A-Za-z0-9]/.test(text);
}

/** Every new message floats over the table for a few seconds with the sender's name, whether or not the chat panel is open. */
let floatSeenT = null; // null until the first screen is drawn, so old messages do not all pop up after a refresh
function floatNewMessages(s) {
  const msgs = s.chat || [];
  const newest = msgs.length ? msgs[msgs.length - 1].t : 0;
  if (floatSeenT === null) { floatSeenT = newest; return; }
  // your own messages float once, the moment you send them (sendChat); the server's copy of them is not floated again
  for (const m of msgs.filter((x) => x.t > floatSeenT && x.from !== s.you).slice(-4)) floatOne(m, s.you);
  floatSeenT = Math.max(floatSeenT, newest);
}
function floatOne(m, you) {
  const box = $("chatFloat");
  const el = document.createElement("div");
  el.className = "float-msg" + (m.from === you ? " mine" : "");
  const who = document.createElement("b");
  who.textContent = (m.from === you ? "You" : m.name) + " ";
  el.append(who, document.createTextNode(m.text));
  box.appendChild(el);
  setTimeout(() => el.remove(), 6000);
  while (box.children.length > 4) box.firstChild.remove();
}

function renderChat(s) {
  floatNewMessages(s);
  const msgs = s.chat || [];
  const sig = msgs.length + ":" + (msgs.length ? msgs[msgs.length - 1].t : 0);
  if (sig === chatSig) return; // nothing new: leave the scroll position alone
  chatSig = sig;
  const log = $("chatLog");
  log.innerHTML = "";
  if (!msgs.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No messages yet — say hi 👋";
    log.appendChild(e);
    return;
  }
  for (const m of msgs) {
    const row = document.createElement("div");
    row.className = "msg" + (m.from === s.you ? " mine" : "") + (isEmojiOnly(m.text) ? " big" : "");
    const av = document.createElement("span");
    av.className = "avatar";
    paintAvatar(av, m.name);
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = m.from === s.you ? "You" : m.name;
    bubble.append(who, document.createTextNode(m.text));
    row.append(av, bubble);
    log.appendChild(row);
  }
  log.scrollTop = log.scrollHeight;
}

EMOJIS.forEach((e) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = e;
  b.title = "Send " + e;
  b.addEventListener("click", () => sendChat(e));
  $("emojiBar").appendChild(b);
});

$("chatForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  $("chatInput").value = "";
  sendChat(text);
});

/* ---------- small visual helpers ---------- */

let lastTopId = null;
let lastCur = null; // whose turn it was at the previous game screen
let flyFrom = null; // { id, rect, at }: where my last tapped card was, so it can drop from there
let seenCards = null;
let celebrated = null;

function paintAvatar(el, name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  el.style.background = "linear-gradient(135deg, hsl(" + h + " 70% 58%), hsl(" + ((h + 40) % 360) + " 70% 45%))";
  el.textContent = name.trim().slice(0, 2).toUpperCase();
}

function confetti() {
  const box = document.createElement("div");
  box.className = "confetti";
  const colors = ["#7c5cff", "#2f6bff", "#12b76a", "#f5b800", "#f04438"];
  for (let i = 0; i < 70; i++) {
    const p = document.createElement("span");
    p.style.left = Math.random() * 100 + "%";
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = 2 + Math.random() * 2.5 + "s";
    p.style.animationDelay = Math.random() * 0.6 + "s";
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 5500);
}

/* ---------- actions ---------- */

/* ---------- admin long-press on the draw pile: choose the special card you pick up ---------- */

const LONG_PRESS_MS = 600;
let pressTimer = null;
let suppressClick = false;

function cancelPress() {
  clearTimeout(pressTimer);
  pressTimer = null;
}

function attachLongPress(el) {
  el.addEventListener("pointerdown", () => {
    suppressClick = false;
    cancelPress();
    if (!state || !state.admin) return; // only the admin gets the menu
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressClick = true; // the release after a long press must not also draw a normal card
      openCheat();
    }, LONG_PRESS_MS);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => el.addEventListener(ev, cancelPress));
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

function openCheat() {
  const box = $("cheatOptions");
  box.innerHTML = "";
  const options = [];
  for (const c of ["red", "yellow", "green", "blue"]) {
    for (const v of ["skip", "reverse", "draw2", "again", "sweep"]) {
      if (!SUPER.has(v) || superOn(v)) options.push({ color: c, value: v }); // switched-off super cards are not offered
    }
  }
  for (const v of ["wild", "wild4", "blast", "swap", "gift", "master"]) {
    if (!SUPER.has(v) || superOn(v)) options.push({ color: "wild", value: v });
  }
  for (const o of options) {
    const el = cardEl(o);
    el.addEventListener("click", () => {
      $("cheatModal").classList.add("hidden");
      send({ op: "draw", value: o.value, color: o.color });
    });
    box.appendChild(el);
  }
  $("cheatModal").classList.remove("hidden");
}

document.addEventListener("pointerup", cancelPress);

const dealingNow = () => Boolean(state && state.dealLeft > 0 && state._dealEnd && state._dealEnd > Date.now());
function onCard(card) {
  if (!state || state.over || state.cur !== state.you) return;
  if (dealingNow()) { toast("The cards are still being dealt."); return; }
  if (!state.playable.includes(card.id)) {
    toast(card.value === "wild4" ? "Wild Draw Four needs a hand with no card of the current colour." : "You can't play that card.");
    return;
  }
  if (sheet) closeSheet(); // tapping a card while peeking starts over with that card
  if (card.color === "wild") {
    openSheet(card);
  } else {
    playNow(card);
  }
}

/* ---------- lobby: choose which super cards are in the game (admin) ---------- */

const SUPER_INFO = [
  { k: "again", icon: "🔁", name: "Play Again", n: 4, text: "go again" },
  { k: "sweep", icon: "🧹", name: "Sweep", n: 4, text: "put down all of its colour" },
  { k: "blast", icon: "💥", name: "Blast", n: 2, text: "everyone else draws 1" },
  { k: "swap", icon: "🔄", name: "Swap Hands", n: 2, text: "trade hands" },
  { k: "gift", icon: "🎁", name: "Gift", n: 2, text: "give 1 card to everyone" },
  { k: "master", icon: "✨", name: "Master card", n: 1, text: "pick a player + a rule" },
];

function superOn(k) {
  return !state || !state.settings || state.settings.supers[k] !== false;
}

function sendSupers(next) {
  send({ op: "config", supers: next });
}

/* ---------- table themes: the admin chooses, everyone at the table sees it ---------- */

const THEME_INFO = [
  { k: "growx", name: "GrowX", note: "default", colors: ["#f04438", "#f5b800", "#12b76a", "#2f6bff"], meta: "#7c5cff" },
  { k: "classic", name: "Classic", note: "felt table", colors: ["#ed1c24", "#ffde16", "#50aa44", "#0072bc"], meta: "#0e3f25" },
  { k: "midnight", name: "Midnight", note: "dark mode", colors: ["#2b3262", "#9b82ff", "#10142a", "#e7eaf3"], meta: "#0c0f1c" },
];

/** Puts the room's theme on the page (the CSS does the rest) and tints the phone's browser bar to match. */
function applyTheme(key) {
  const info = THEME_INFO.find((t) => t.k === key) || THEME_INFO[0];
  document.documentElement.dataset.theme = info.k;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", info.meta);
}

function renderThemePicker(s) {
  const list = $("themeList");
  const current = (s.settings && s.settings.theme) || "growx";
  if (!list.children.length) {
    for (const t of THEME_INFO) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "theme-opt";
      b.dataset.k = t.k;
      b.innerHTML = '<span class="sw">' + t.colors.map((c) => '<i style="background:' + c + '"></i>').join("") + "</span><span></span><small></small>";
      b.children[1].textContent = t.name;
      b.querySelector("small").textContent = t.note;
      b.addEventListener("click", () => {
        if (busy || !state || !state.canStart || ((state.settings && state.settings.theme) || "growx") === t.k) return;
        const before = state;
        state = { ...state, settings: { ...state.settings, theme: t.k } }; // the new look appears at once
        applyTheme(t.k);
        render();
        send({ op: "config", theme: t.k }, () => { state = before; applyTheme((before.settings && before.settings.theme) || "growx"); render(); });
      });
      list.appendChild(b);
    }
  }
  for (const b of list.children) {
    b.setAttribute("aria-pressed", String(b.dataset.k === current));
    b.disabled = !s.canStart; // only the admin can change it; everyone else sees what is in use
  }
}

/** How many cards each player is dealt: a − / + stepper (admin only, lobby only). */
function setHandSize(n) {
  if (busy || !state || !state.canStart) return;
  const cur = (state.settings && state.settings.handSize) || 5;
  const next = Math.max(3, Math.min(10, n));
  if (next === cur) return;
  const before = state;
  state = { ...state, settings: { ...state.settings, handSize: next } };
  render();
  send({ op: "config", handSize: next }, () => { state = before; render(); });
}
/** Seconds each player gets per turn: − / + in steps of 5 (admin only, lobby only). */
function setTurnSecs(n) {
  if (busy || !state || !state.canStart) return;
  const cur = (state.settings && state.settings.turnSecs) || 30;
  const next = Math.max(15, Math.min(120, n));
  if (next === cur) return;
  const before = state;
  state = { ...state, settings: { ...state.settings, turnSecs: next } };
  render();
  send({ op: "config", turnSecs: next }, () => { state = before; render(); });
}
$("turnMinus").addEventListener("click", () => setTurnSecs(((state && state.settings && state.settings.turnSecs) || 30) - 5));
$("turnPlus").addEventListener("click", () => setTurnSecs(((state && state.settings && state.settings.turnSecs) || 30) + 5));
$("handMinus").addEventListener("click", () => setHandSize(((state && state.settings && state.settings.handSize) || 5) - 1));
$("handPlus").addEventListener("click", () => setHandSize(((state && state.settings && state.settings.handSize) || 5) + 1));

function sendRule(body) {
  if (busy || !state || !state.canStart) return;
  send({ op: "config", ...body }, () => render());
}
$("stackingBox").addEventListener("change", (e) => sendRule({ stacking: e.target.checked }));
$("challengeBox").addEventListener("change", (e) => sendRule({ challenge: e.target.checked }));

function renderSettings(s) {
  // The game settings are the admin's: other players only see the "For you" part of the Settings window.
  $("roomsBtn").classList.toggle("hidden", !s.admin); // the real admin only
  $("joinAlertBtn").classList.toggle("hidden", !s.admin);
  $("privateBtn").classList.toggle("hidden", !s.admin);
  $("privateBtn").textContent = s.private ? "🔓 Make public" : "🔒 Make private";
  $("settings").classList.toggle("hidden", !s.canStart);
  if (!s.canStart) return;
  const locked = s.started && !s.over; // cards, turn time, house rules and super cards: lobby only
  $("settingsLock").classList.toggle("hidden", !locked);
  const hs = (s.settings && s.settings.handSize) || 5;
  $("handSizeVal").textContent = hs;
  $("handMinus").disabled = locked || hs <= 3;
  $("handPlus").disabled = locked || hs >= 10;
  $("stackingBox").checked = Boolean(s.settings && s.settings.stacking);
  $("challengeBox").checked = Boolean(s.settings && s.settings.challenge);
  $("stackingBox").disabled = locked;
  $("challengeBox").disabled = locked;
  const ts = (s.settings && s.settings.turnSecs) || 30;
  $("turnSecsVal").textContent = ts;
  $("turnMinus").disabled = locked || ts <= 15;
  $("turnPlus").disabled = locked || ts >= 120;
  renderThemePicker(s);
  const list = $("superList");
  if (!list.children.length) {
    for (const info of SUPER_INFO) {
      const row = document.createElement("label");
      row.dataset.k = info.k;
      row.innerHTML = '<input type="checkbox"><span class="t"></span><small></small>';
      row.querySelector(".t").textContent = info.icon + " " + info.name + " ×" + info.n;
      row.querySelector("small").textContent = info.text;
      row.querySelector("input").addEventListener("change", (e) => {
        const next = Object.fromEntries(SUPER_INFO.map((i) => [i.k, superOn(i.k)]));
        next[info.k] = e.target.checked;
        sendSupers(next);
      });
      list.appendChild(row);
    }
  }
  let total = 108;
  for (const info of SUPER_INFO) {
    const on = s.settings ? s.settings.supers[info.k] !== false : true;
    const row = list.querySelector('[data-k="' + info.k + '"]');
    const box = row.querySelector("input");
    box.checked = on;
    box.disabled = !s.canStart || locked; // only the admin can change it, and only in the lobby
    row.classList.toggle("off", !on);
    if (on) total += info.n;
  }
  $("deckCount").textContent = "Deck: " + total + " cards";
  $("supersAll").classList.toggle("hidden", !s.canStart || locked);
  $("supersNone").classList.toggle("hidden", !s.canStart || locked);
}

/* ---------- the Settings window (one button; everything else hides behind it) ---------- */
const settingsModal = $("settingsModal");
$("settingsBtn").addEventListener("click", () => settingsModal.classList.remove("hidden"));
$("settingsX").addEventListener("click", () => settingsModal.classList.add("hidden"));
$("settingsClose").addEventListener("click", () => settingsModal.classList.add("hidden"));
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) settingsModal.classList.add("hidden"); });
["rulesBtn", "statsBtn", "leaveBtn", "roomsBtn"].forEach((id) => $(id).addEventListener("click", () => settingsModal.classList.add("hidden")));

/* ---------- the real admin's Rooms window ---------- */
const ago = (t) => {
  if (!t) return "never";
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  return sec < 60 ? sec + "s ago" : sec < 3600 ? Math.round(sec / 60) + " min ago" : Math.round(sec / 3600) + " h ago";
};

function renderRooms(r) {
  $("roomsSummary").textContent = r.total + (r.total === 1 ? " room" : " rooms") + " in total · " + r.active + " active now";
  const list = $("roomsList");
  list.textContent = "";
  for (const room of r.rooms) {
    const row = document.createElement("div");
    row.className = "room-row" + (room.online > 0 ? " live" : "");
    const info = document.createElement("div");
    info.className = "info";
    const code = document.createElement("b");
    code.textContent = room.code + (room.code === roomNow() ? " (this room)" : "");
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = (room.mode === "private" ? "🔒 private" : "public") + " · " + room.phase;
    const stat = document.createElement("div");
    stat.textContent = room.online + " online of " + room.players + " · last seen " + ago(room.last) + (room.gameNo ? " · game #" + room.gameNo : "");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = room.names.join(", ") || "—";
    info.append(code, badge, stat, who);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "ghost remove";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => closeRoomNow(room));
    const watch = document.createElement("button");
    watch.type = "button";
    watch.className = "ghost";
    watch.textContent = "👁 Watch";
    watch.addEventListener("click", () => openWatch(room.code));
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ghost";
    save.textContent = "💾 Backup";
    save.addEventListener("click", () => backupRoom(room));
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(watch, save, rm);
    row.append(info, actions);
    list.appendChild(row);
  }
  if (!r.rooms.length) { const n = document.createElement("div"); n.className = "none hint"; n.textContent = "No rooms."; list.appendChild(n); }
}
const roomNow = () => room;

async function loadRooms() {
  $("roomsSummary").textContent = "Loading…";
  try { renderRooms(await api({ op: "rooms" })); } catch (e) { $("roomsSummary").textContent = e.message; }
  loadBackups();
}

/* backups: kept with no time limit until the admin removes them */
const fmtAt = (t) => new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
async function loadBackups() {
  let r;
  try { r = await api({ op: "backupList" }); } catch (e) { return; }
  $("backupCount").textContent = "(" + r.backups.length + " of " + r.max + ")";
  const list = $("backupList");
  list.textContent = "";
  for (const b of r.backups) {
    const row = document.createElement("div");
    row.className = "room-row";
    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("b");
    name.textContent = b.room + (b.label ? " — " + b.label : "");
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = (b.mode === "private" ? "🔒 private" : "public") + " · " + b.phase;
    const line = document.createElement("div");
    line.textContent = "saved " + fmtAt(b.at) + (b.gameNo ? " · game #" + b.gameNo : "");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = b.players.join(", ") || "—";
    info.append(name, badge, line, who);
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "ghost";
    restore.textContent = "↩ Restore";
    restore.addEventListener("click", async () => {
      if (!confirm("Restore room " + b.room + " to how it was on " + fmtAt(b.at) + "? What is in the room now is replaced.")) return;
      try { await api({ op: "backupRestore", id: b.id }); } catch (e) { toast(e.message); return; }
      toast("Room " + b.room + " restored.");
      loadRooms();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost remove";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm("Delete this backup for good?")) return;
      try { await api({ op: "backupDelete", id: b.id }); } catch (e) { toast(e.message); return; }
      loadBackups();
    });
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(restore, del);
    row.append(info, actions);
    list.appendChild(row);
  }
  if (!r.backups.length) { const n = document.createElement("div"); n.className = "none hint"; n.textContent = "No backups yet."; list.appendChild(n); }
}
async function backupRoom(r) {
  const label = prompt("Name for this backup (optional):", "");
  if (label === null) return;
  try { await api({ op: "backupSave", target: r.code, label }); } catch (e) { toast(e.message); return; }
  toast("Backed up " + r.code + ".");
  loadBackups();
}
async function closeRoomNow(r) {
  const here = r.code === roomNow();
  if (!confirm("Remove room " + r.code + "?" + (r.online ? " " + r.online + " online player(s) in it will be sent out." : "") + (here ? " This is the room you are in." : ""))) return;
  try { await api({ op: "closeRoom", target: r.code }); } catch (e) { toast(e.message); return; }
  if (here) { removedByAdmin("You removed this room."); $("roomsModal").classList.add("hidden"); return; }
  loadRooms();
}
/* Watching a room without joining it: the server answers with the table only (no cards), and nothing is written to the room. */
let watchCode = null;
let watchTimer = null;
const cardText = (c) => (c ? ({ red: "🟥", yellow: "🟨", green: "🟩", blue: "🟦", wild: "🌈" }[c.color] || "") + " " + c.value : "—");

function renderWatch(p) {
  $("watchTitle").textContent = "👁 " + p.code + " · " + (p.mode === "private" ? "🔒 private" : "public");
  let line = p.phase + (p.gameNo ? " · game #" + p.gameNo : "");
  if (p.started && !p.over) line += " · top " + cardText(p.top) + (p.color && p.top && p.top.color === "wild" ? " (" + p.color + ")" : "") + " · pile " + p.deck + (p.cur ? " · turn: " + p.cur : "");
  if (p.over) line += " · winner " + (p.ranking[0] || "—");
  $("watchSummary").textContent = line;
  const list = $("watchPlayers");
  list.textContent = "";
  for (const pl of p.players) {
    const row = document.createElement("div");
    row.className = "wp" + (pl.name === p.cur ? " turn" : "") + (pl.connected ? "" : " off");
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = (pl.connected ? "🟢 " : "⚪ ") + pl.name + (pl.admin ? " 👑" : pl.starter ? " (admin)" : "");
    const c = document.createElement("span");
    c.textContent = p.started ? (pl.finished ? "out" : pl.count + " 🂠") : "";
    const sc = p.totals[pl.name];
    row.append(n, c);
    if (sc) { const t = document.createElement("span"); t.textContent = sc + " pts"; row.append(t); }
    list.appendChild(row);
  }
  const chat = $("watchChat");
  chat.textContent = "";
  for (const m of p.chat) { const d = document.createElement("div"); d.textContent = m.name + ": " + m.text; chat.appendChild(d); }
  chat.classList.toggle("hidden", !p.chat.length);
}

async function pollWatch() {
  if (!watchCode) return;
  try {
    const r = await api({ op: "peek", target: watchCode });
    if (watchCode) renderWatch(r.peek);
  } catch (e) {
    if (watchCode) $("watchSummary").textContent = e.message;
  }
}
function openWatch(code) {
  watchCode = code;
  $("watchSummary").textContent = "Loading…";
  $("watchPlayers").textContent = "";
  $("watchChat").textContent = "";
  $("watchModal").classList.remove("hidden");
  $("roomsModal").classList.add("hidden");
  pollWatch();
  clearInterval(watchTimer);
  watchTimer = setInterval(pollWatch, 2500);
}
function closeWatch() {
  watchCode = null;
  clearInterval(watchTimer);
  $("watchModal").classList.add("hidden");
  $("roomsModal").classList.remove("hidden");
  loadRooms();
}
$("watchX").addEventListener("click", closeWatch);
$("watchClose").addEventListener("click", closeWatch);

$("roomsBtn").addEventListener("click", () => { $("roomsModal").classList.remove("hidden"); loadRooms(); });
$("roomsRefresh").addEventListener("click", loadRooms);
$("roomsX").addEventListener("click", () => $("roomsModal").classList.add("hidden"));
$("roomsClose").addEventListener("click", () => $("roomsModal").classList.add("hidden"));
$("roomsModal").addEventListener("click", (e) => { if (e.target === $("roomsModal")) $("roomsModal").classList.add("hidden"); });

/* ---------- landscape: the table is laid out wide; on a phone held upright we offer to turn it ---------- */
const maxBacks = () => (window.innerHeight > window.innerWidth ? 8 : 16); // an upright phone is narrow: fewer backs, then "+n"
let rotateDismissed = false;
function renderRotateHint() {
  const portrait = window.innerHeight > window.innerWidth;
  const touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  $("rotateHint").classList.toggle("hidden", !(document.body.classList.contains("in-game") && portrait && touch && !rotateDismissed));
}
/**
 * Phones: the lobby and sign-in are full screen and upright; a game that starts goes full screen and sideways on its own.
 * Browsers only allow fullscreen / rotation right after a tap, so when there was none (a refresh, a game started by
 * someone else) the very next tap anywhere does it. Computers are left alone.
 */
let orientHave = null; // "portrait" | "landscape": what this page has already asked for
let orientArmed = null;
const coarse = () => Boolean(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
async function lockOrientation(mode) {
  if (!coarse()) return true;
  try { if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen({ navigationUI: "hide" }); } catch (e) { return false; }
  try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock(mode); } catch (e) { /* this browser cannot lock the rotation: the rotate hint covers it */ }
  return true;
}
function wantOrientation(mode) {
  if (!coarse() || orientHave === mode) return;
  orientHave = mode;
  const go = () => lockOrientation(mode).then((ok) => { if (!ok && orientHave === mode) arm(); });
  const arm = () => {
    if (orientArmed) document.removeEventListener("pointerup", orientArmed);
    orientArmed = () => { document.removeEventListener("pointerup", orientArmed); orientArmed = null; if (orientHave === mode) go(); };
    document.addEventListener("pointerup", orientArmed);
  };
  go();
}
async function enterLandscape() {
  try { if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); } catch (e) { /* not allowed */ }
  try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock("landscape"); } catch (e) { toast("Turn your phone sideways to play in landscape."); }
  renderRotateHint();
}
$("landscapeBtn").addEventListener("click", enterLandscape);
$("fsBtn").addEventListener("click", () => { settingsModal.classList.add("hidden"); enterLandscape(); });
$("rotateX").addEventListener("click", () => { rotateDismissed = true; renderRotateHint(); });
window.addEventListener("resize", renderRotateHint);
window.addEventListener("orientationchange", renderRotateHint);

/* the chat is a side panel: close button */
$("chatCloseX").addEventListener("click", () => {
  chatOpen = false;
  $("chatDock").classList.add("hidden");
  if (state) updateChatUi(state);
});

$("supersAll").addEventListener("click", () => sendSupers(Object.fromEntries(SUPER_INFO.map((i) => [i.k, true]))));
$("supersNone").addEventListener("click", () => sendSupers(Object.fromEntries(SUPER_INFO.map((i) => [i.k, false]))));

/* ---------- choosing for a wild-type card: ONE sheet with Back / Peek / Close ---------- */
/* Wild, +4, Blast, Gift: colour. Swap Hands: colour, player. Master card: colour, player, then a rule.
   ✕ (or a tap outside, or Escape) closes it and shows the card screen; tap the card again to choose once more.
   👁 hides the sheet for a moment so you can look at the table, and a pill brings it back at the same step. */

const STEPS = { wild: ["colour"], wild4: ["colour"], blast: ["colour"], gift: ["colour"], swap: ["colour", "player"], master: ["colour", "player", "rule"] };
const COLOUR_NAMES = { red: "Red", yellow: "Yellow", green: "Green", blue: "Blue" };
let sheet = null; // { card, steps, i, color, target, rule }

function openSheet(card) {
  sheet = { card, steps: STEPS[card.value] || ["colour"], i: 0, color: null, target: null };
  $("sheetPill").classList.add("hidden");
  $("playSheet").classList.remove("hidden");
  renderSheet();
}

function closeSheet() {
  sheet = null;
  $("playSheet").classList.add("hidden");
  $("sheetPill").classList.add("hidden");
}

function peekSheet(on) {
  if (!sheet) return;
  $("playSheet").classList.toggle("hidden", on);
  $("sheetPill").classList.toggle("hidden", !on);
}

function sheetBackTo(i) {
  if (!sheet) return;
  sheet.i = i;
  if (i <= 0) sheet.color = null;
  if (i <= 1) sheet.target = null;
  renderSheet();
}

function sheetNext() {
  if (sheet.i < sheet.steps.length - 1) {
    sheet.i += 1;
    renderSheet();
    return;
  }
  const { card, color, target, rule } = sheet;
  closeSheet();
  const body = { op: "play", cardId: card.id, color };
  if (target) body.target = target.id;
  if (rule) body.rule = rule;
  send(body);
}

function renderSheet() {
  const step = sheet.steps[sheet.i];
  const card = sheet.card;
  const self = sheet.target && sheet.target.id === state.you;
  $("sheetBack").classList.toggle("invisible", sheet.i === 0);
  $("sheetTitle").textContent =
    step === "colour" ? "Choose a colour" :
    step === "player" ? (card.value === "master" ? "✨ Choose a player" : "🔄 Swap hands with…") :
    "Rule for " + (self ? "yourself" : sheet.target.name);

  // chips: what is chosen so far; tap one to go back to that step
  const chips = $("sheetChips");
  chips.innerHTML = "";
  const addChip = (text, stepIndex) => {
    const c = document.createElement(stepIndex === undefined ? "span" : "button");
    c.className = "chip" + (stepIndex === undefined ? " fixed" : "");
    c.textContent = text;
    if (stepIndex !== undefined) { c.type = "button"; c.addEventListener("click", () => sheetBackTo(stepIndex)); }
    chips.appendChild(c);
  };
  addChip((LABEL[card.value] || card.value) + " " + (SUPER.has(card.value) ? "" : "card"));
  if (sheet.color) addChip("● " + COLOUR_NAMES[sheet.color] + " ✎", 0);
  if (sheet.target) addChip((self ? "You" : sheet.target.name) + " ✎", 1);

  const body = $("sheetBody");
  body.innerHTML = "";
  if (step === "colour") {
    const grid = document.createElement("div");
    grid.className = "swatch-grid";
    for (const c of ["red", "yellow", "green", "blue"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch " + c;
      b.textContent = COLOUR_NAMES[c];
      b.addEventListener("click", () => { sheet.color = c; sheetNext(); });
      grid.appendChild(b);
    }
    body.appendChild(grid);
  } else if (step === "player") {
    const master = card.value === "master";
    for (const p of state.players.filter((x) => !x.finished && (master || x.id !== state.you))) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ghost target";
      b.textContent = (p.id === state.you ? "You" : p.name) + " · " + p.count + " card" + (p.count === 1 ? "" : "s");
      b.addEventListener("click", () => { sheet.target = { id: p.id, name: p.name }; sheetNext(); });
      body.appendChild(b);
    }
  } else {
    const who = self ? "you" : sheet.target.name;
    const name = sheet.target.name;
    const rules = [
      { id: "again", label: "🔁 Play Again", text: self ? "you play again" : name + " plays next", needsOther: false },
      { id: "sweep", label: "🧹 Sweep", text: who + " put" + (self ? "" : "s") + " down all " + (self ? "your" : "their") + " " + sheet.color + " cards", needsOther: false },
      { id: "blast", label: "💥 Blast", text: name + " draws 2 cards", needsOther: true },
      { id: "swap", label: "🔄 Swap Hands", text: "you swap hands with " + name, needsOther: true },
      { id: "gift", label: "🎁 Gift", text: "you give " + name + " 2 random cards", needsOther: true },
      { id: "draw2", label: "+2 Draw Two", text: name + " draws 2 cards and loses their next turn", needsOther: true },
      { id: "wild4", label: "+4 Draw Four", text: name + " draws 4 cards and loses their next turn", needsOther: true },
    ];
    // rules that belong to a switched-off super card are not offered (+2 / +4 are always available)
    for (const r of rules.filter((x) => x.id === "draw2" || x.id === "wild4" || superOn(x.id))) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ghost target";
      b.disabled = self && r.needsOther; // those rules need another player
      b.innerHTML = "<b></b><small></small>";
      b.querySelector("b").textContent = r.label;
      b.querySelector("small").textContent = r.text;
      b.addEventListener("click", () => { sheet.rule = r.id; sheetNext(); });
      body.appendChild(b);
    }
  }
}

$("sheetClose").addEventListener("click", closeSheet);
$("sheetBack").addEventListener("click", () => sheetBackTo(sheet.i - 1));
$("sheetPeek").addEventListener("click", () => peekSheet(true));
$("sheetPill").addEventListener("click", () => peekSheet(false));
$("playSheet").addEventListener("click", (e) => { if (e.target === $("playSheet")) closeSheet(); }); // tap outside
$("cheatModal").addEventListener("click", (e) => { if (e.target === $("cheatModal")) $("cheatModal").classList.add("hidden"); });
$("cheatX").addEventListener("click", () => $("cheatModal").classList.add("hidden"));
$("cheatClose").addEventListener("click", () => $("cheatModal").classList.add("hidden"));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeSheet();
  $("cheatModal").classList.add("hidden");
});

$("joinBtn").addEventListener("click", join);
$("nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
$("pwInput").addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
$("startBtn").addEventListener("click", () => send({ op: "start" }));
$("privateBtn").addEventListener("click", () => {
  if (!state) return;
  const toPrivate = !state.private;
  const want = toPrivate ? "private" : "public";
  const n = state.players.filter((p) => p.id !== state.you && p.role && p.role !== "admin" && p.role !== want).length;
  if (n && !confirm("Making the game " + want + " removes " + n + " player" + (n === 1 ? "" : "s") +
      " who joined with the " + (toPrivate ? "public" : "private") + " password. Continue?")) return;
  send({ op: "private", on: toPrivate });
});
$("playAgain").addEventListener("click", () => send({ op: "start" }));
attachLongPress($("drawPile"));
$("drawPile").addEventListener("click", () => {
  if (suppressClick) { suppressClick = false; return; }
  if (state && !state.seated) return; // spectators can't draw
  if (dealingNow()) { toast("The cards are still being dealt."); return; }
  send({ op: "draw" });
});
$("pauseBtn").addEventListener("click", () => send({ op: state && state.paused ? "resume" : "pause" }));
$("restartBtn").addEventListener("click", () => {
  if (confirm("End this game and send everyone back to the lobby?")) send({ op: "lobby" });
});
$("toLobby").addEventListener("click", () => send({ op: "lobby" }));
$("passBtn").addEventListener("click", () => send({ op: "pass" }));
$("catchBtn").addEventListener("click", () => send({ op: "catch" }));
/* ---------- the challenge question for a +2 / +4 ---------- */
let cqDismissed = ""; // the waiting +2 / +4 the player chose to stack on instead of answering
const pendKey = (s) => (s.pend ? [s.pend.kind, s.pend.n, s.pend.by, s.turnAt].join("|") : "");

function renderChallenge(s, myTurn) {
  const box = $("challengeQ");
  const show = Boolean(myTurn && s.pend && s.pend.canChallenge && !s.paused && !s.over && s.seated && pendKey(s) !== cqDismissed);
  box.classList.toggle("hidden", !show);
  if (!show) return;
  const p = s.pend;
  const sign = p.kind === "wild4" ? "+4" : "+2";
  const colour = p.colour || ""; // red, yellow, green or blue
  $("cqTitle").textContent = "⚔ " + p.by + " played " + sign + (p.n > (p.kind === "wild4" ? 4 : 2) ? " (" + p.n + " in all)" : "");
  const q = $("cqQuestion");
  q.textContent = "";
  const dot = document.createElement("i");
  dot.className = "cq-dot " + (p.colour || "");
  q.append("Does " + p.by + " have a ", dot, " " + colour + " card?");
  $("cqNote").textContent = "Yes: if they do, they draw " + p.n + "; if not, you draw " + p.n + ". No or Skip: you draw " + p.n + " and miss your turn.";
  $("cqStack").classList.toggle("hidden", !(s.playable && s.playable.length)); // only when a card can be stacked on it
}
$("cqYes").addEventListener("click", () => send({ op: "challenge" }));
$("cqNo").addEventListener("click", () => send({ op: "draw" }));
$("cqSkip").addEventListener("click", () => send({ op: "draw" }));
$("cqStack").addEventListener("click", () => { if (state) { cqDismissed = pendKey(state); render(); } });

/** The result of the last challenge, shown to everybody for a few seconds. */
let lastReveal = 0;
let revealTimer = null;
function renderReveal(s) {
  const r = s.reveal;
  if (!r || r.id === lastReveal) return;
  lastReveal = r.id;
  const box = $("reveal");
  box.className = r.ok ? "ok" : "fail";
  box.textContent = r.ok
    ? "✅ Challenge successful! " + r.target + " had a " + r.colour + " card — they draw " + r.n + "."
    : "❌ Challenge failed! " + r.target + " had no " + r.colour + " card — " + r.challenger + " draws " + r.n + ".";
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => box.classList.add("hidden"), Math.max(1500, 5000 - (r.age || 0)));
}
$("unoBtn").addEventListener("click", () => {
  if (busy || !state) return;
  const before = state;
  state = { ...state, saidUno: true }; // the button flips to "GrowX! ✓" straight away
  render();
  send({ op: "uno" }, () => { state = before; render(); });
});
$("rulesBtn").addEventListener("click", () => $("rulesModal").classList.remove("hidden"));
$("closeRules").addEventListener("click", () => $("rulesModal").classList.add("hidden"));
$("copyLink").addEventListener("click", () => {
  const link = location.origin + "/?room=" + encodeURIComponent(room);
  (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
    .then(() => toast("Invite link copied"), () => toast(link));
});

/* ---------- alerts: a notification when it is my turn and this page is in the background ---------- */

// Public and private games are separate everywhere: each has its own alerts switch, its own notifications (they never
// replace each other) and its own stats.
const BASE_TITLE = document.title;
const modeOf = (s) => (s && s.private ? "private" : "public");
const modeName = (m) => (m === "private" ? "Private game" : "Public game");
const notifyKey = () => "uno-notify-" + modeOf(state);
const notifyOn = () => store(notifyKey()) === "1" && typeof Notification !== "undefined" && Notification.permission === "granted";

function renderNotifyBtn() {
  const btn = $("notifyBtn");
  btn.textContent = "🔔 Alerts: " + (notifyOn() ? "on" : "off");
  btn.classList.toggle("on", notifyOn());
  btn.title = typeof Notification === "undefined"
    ? "This browser cannot show notifications."
    : "A notification when it is your turn in a " + modeName(modeOf(state)).toLowerCase() + ", while this page is in the background (keep the page open). Public and private games have separate switches.";
}

async function toggleNotify() {
  if (typeof Notification === "undefined") { toast("This browser cannot show notifications."); return; }
  if (notifyOn()) {
    store(notifyKey(), "0");
  } else {
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (perm !== "granted") { toast("Notifications are blocked — allow them in the browser's site settings."); renderNotifyBtn(); return; }
    store(notifyKey(), "1");
    registerAlertWorker();
    toast("Alerts on for " + modeName(modeOf(state)).toLowerCase() + "s.");
  }
  renderNotifyBtn();
}
$("notifyBtn").addEventListener("click", toggleNotify);

function registerAlertWorker() {
  try { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {}); } catch (e) { /* not available */ }
}

/** Called when a new turn of mine starts. Only does anything while the page is hidden. */
function notifyTurn() {
  if (!document.hidden || !notifyOn()) return;
  const mode = modeOf(state);
  const label = modeName(mode);
  document.title = "🔔 Your turn · " + label;
  // a different tag per kind of game and room, so a public and a private notification never replace each other
  const opts = { body: label + ": it's your turn!", tag: "turn-" + mode + "-" + room, renotify: true, vibrate: [120, 60, 120] };
  const title = BASE_TITLE + " · " + label;
  const fallback = () => { try { new Notification(title, opts); } catch (e) { /* e.g. Android needs the worker */ } };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistration().then((reg) => (reg ? reg.showNotification(title, opts) : fallback())).catch(fallback);
  } else fallback();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = BASE_TITLE; });
renderNotifyBtn();
if (notifyOn()) registerAlertWorker();

/* ---------- Learn Korean: a page of its own, shared live. The real admin teaches, private players follow; the letters come from the
   server, which only answers the admin and private players. What each person has seen / got right is kept on this phone only. ---------- */

const K_TABS = [["consonants", "Consonants"], ["double", "Double"], ["vowels", "Vowels"], ["compound", "Combined vowels"]];
let hangul = null;
let learnOpen = false;
let kTab = "consonants";
let kIdx = -1; // the letter this person is looking at on their own (when not following the teacher)
let kSpeech = "";
let kQuizDone = 0; // the newest quiz question already counted in this phone's progress

const learnProgress = () => { try { return JSON.parse(store("uno-hangul") || "{}"); } catch (e) { return {}; } };
function markLetter(ch, field) {
  const p = learnProgress();
  p[ch] = { seen: 0, right: 0, ...(p[ch] || {}) };
  p[ch][field] += 1;
  store("uno-hangul", JSON.stringify(p));
}

/** What to show: the teacher's letter for followers (and for the teacher), else the letter this person picked. */
function learnSel(s) {
  const L = s.learn;
  const follow = s.admin || $("learnFollow").checked;
  if (L && follow) return { tab: L.tab, idx: L.idx };
  return { tab: kTab, idx: kIdx };
}

let learnPane = "letters";
function setPane(p) {
  learnPane = p;
  document.querySelectorAll(".learn-nav button").forEach((b) => {
    b.classList.toggle("on", b.dataset.pane === p);
    b.setAttribute("aria-current", b.dataset.pane === p ? "page" : "false");
  });
  [["letters", "paneLetters"], ["quiz", "paneQuiz"], ["words", "paneWords"], ["ask", "paneAsk"]].forEach(([k, id]) => $(id).classList.toggle("hidden", k !== p));
  const page = $("learnPage");
  if (page) page.scrollTo({ top: 0 });
}
document.querySelectorAll(".learn-nav button").forEach((b) => b.addEventListener("click", () => setPane(b.dataset.pane)));

/** A short buzz on a result: a right answer feels different from a wrong one. */
function learnFeedback(ok) {
  try { if (navigator.vibrate) navigator.vibrate(ok ? [40] : [30, 40, 30]); } catch (e) { /* not allowed */ }
}

/** Short, kind lines that change with how far along this person is. */
function cheerFor(seen, total, points) {
  if (!seen) return "Little steps, big progress.";
  if (seen >= total) return "You have seen every letter — amazing!";
  if (points > 0 && seen > 5) return "You’re doing great! " + points + " points so far.";
  return "You’re doing great — " + seen + " of " + total + " letters seen.";
}

function renderLearn(s) {
  if (!hangul) return;
  const L = s.learn;
  const sel = learnSel(s);
  const following = Boolean(L) && (s.admin || $("learnFollow").checked);
  const me = s.players.find((p) => p.id === s.you);
  const prog = learnProgress();
  const total = Object.values(hangul).reduce((n, rows) => n + rows.length, 0);
  const seenAll = Object.values(hangul).reduce((n, rows) => n + rows.filter((r) => prog[r[0]] && prog[r[0]].seen).length, 0);
  $("learnRole").textContent = s.admin ? "Teacher" : "Student";
  $("learnFollowRow").classList.toggle("hidden", s.admin);
  $("learnTeacher").classList.toggle("hidden", !s.admin);
  const myPts = (L && me && L.scores[me.name]) || 0;
  $("learnPts").textContent = String(myPts);
  $("learnPts").classList.toggle("hidden", !(L && Object.keys(L.scores).length));
  $("learnStatus").textContent = s.admin
    ? "You are the teacher. Tap a letter and everyone sees it."
    : L ? (following ? "Following the teacher live." : "Exploring on your own.") : (s.host ? "Waiting for the teacher to begin — look around meanwhile." : "The teacher has not arrived yet — look around meanwhile.");
  $("learnCheer").textContent = cheerFor(seenAll, total, myPts);

  // a question is open: the letter grid (it shows every letter's sound) and the highlighted letter would give the answer away
  const openQ = Boolean(L && L.mode === "quiz" && L.q && !L.q.revealed);
  ["koreanTabs", "koreanGrid", "groupProgress"].forEach((id) => $(id).classList.toggle("hidden", openQ));
  $("lettersHint").textContent = openQ
    ? "A quiz question is open — the letters come back when the answers are shown."
    : "Tap a letter to hear and see how it sounds. A green edge means you have seen it, a peach tile means you got it right in a quiz (kept on this phone only).";

  // switch to the quiz when a new question starts, and back to the letters when the quiz ends
  const qn = L && L.q ? L.q.n : 0;
  if (qn && renderLearn.autoQ !== qn) { renderLearn.autoQ = qn; setPane("quiz"); }
  if (L && L.mode === "learn" && renderLearn.wasQuiz) setPane("letters");
  renderLearn.wasQuiz = Boolean(L && L.mode === "quiz");

  // groups, each with how many letters of it have been seen
  const tabs = $("koreanTabs");
  tabs.textContent = "";
  for (const [key, label] of K_TABS) {
    const rows = hangul[key];
    const done = rows.filter((r) => prog[r[0]] && prog[r[0]].seen).length;
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", key === sel.tab ? "true" : "false");
    b.className = key === sel.tab ? "on" : "";
    b.textContent = label + " · " + done + "/" + rows.length;
    b.addEventListener("click", () => {
      if (s.admin) { learnSend({ op: "learnShow", tab: key, idx: 0 }); return; }
      if (following) { toast("You are following the teacher — switch off “Follow teacher” to explore."); return; }
      kTab = key; kIdx = -1; renderLearn(state);
    });
    tabs.appendChild(b);
  }
  const groupRows = hangul[sel.tab];
  const groupDone = groupRows.filter((r) => prog[r[0]] && prog[r[0]].seen).length;
  const pct = Math.round((groupDone / groupRows.length) * 100);
  $("groupProgressText").textContent = (K_TABS.find((t) => t[0] === sel.tab) || [0, ""])[1] + ": " + groupDone + " of " + groupRows.length + " learned";
  $("allProgressText").textContent = seenAll + " / " + total + " overall";
  $("groupBarFill").style.width = pct + "%";
  $("groupBar").setAttribute("aria-valuenow", String(pct));

  // letters, with this phone's marks
  const grid = $("koreanGrid");
  grid.textContent = "";
  groupRows.forEach((row, i) => {
    const b = document.createElement("button");
    const pr = prog[row[0]];
    b.type = "button";
    b.className = (i === sel.idx ? "on " : "") + (pr && pr.right >= 2 ? "star" : pr && pr.seen ? "seen" : "");
    b.setAttribute("aria-label", row[0] + ", " + row[1]);
    b.setAttribute("aria-pressed", i === sel.idx ? "true" : "false");
    b.lang = "ko";
    b.append(row[0]);
    const sm = document.createElement("small");
    sm.textContent = row[1];
    b.appendChild(sm);
    b.addEventListener("click", () => {
      if (s.admin) { learnSend({ op: "learnShow", tab: sel.tab, idx: i }); return; }
      if (following) { toast("You are following the teacher — switch off “Follow teacher” to explore."); return; }
      kTab = sel.tab; kIdx = i; renderLearn(state);
    });
    grid.appendChild(b);
  });

  // the letter in detail (not while a question is open: that would give the answer away)
  const quiz = L && L.mode === "quiz" && L.q;
  const row = !quiz && sel.idx >= 0 ? groupRows[sel.idx] : null;
  $("koreanDetail").classList.toggle("hidden", !row);
  if (row) {
    const [ch, roman, sound, word, wordRoman, meaning] = row;
    $("kLetter").textContent = ch;
    $("kRoman").textContent = roman;
    $("kSound").textContent = sound;
    $("kExample").textContent = word + " · " + wordRoman + " · " + meaning;
    $("kCount").textContent = (sel.idx + 1) + " of " + groupRows.length;
    kSpeech = ch === "ㅇ" ? "응" : word;
    const canStep = s.admin || !following;
    $("kPrev").classList.toggle("hidden", !canStep);
    $("kNext").classList.toggle("hidden", !canStep);
    $("kPrev").disabled = sel.idx <= 0;
    $("kNext").disabled = sel.idx >= groupRows.length - 1;
    const key = ch + ":" + (L ? L.at : 0) + ":" + sel.tab + sel.idx;
    if (renderLearn.lastSeen !== key) { renderLearn.lastSeen = key; markLetter(ch, "seen"); }
  }

  // the live quiz
  $("learnQuiz").classList.toggle("hidden", !quiz);
  $("learnQuizEmpty").classList.toggle("hidden", Boolean(quiz));
  $("quizEmptyTitle").textContent = s.admin ? "Ready when you are" : "Waiting for a quiz";
  $("quizEmptyText").textContent = s.admin
    ? "Press “Start a quiz” and everyone in the group gets the same question at the same time."
    : "When the teacher starts a quiz it appears here by itself, and everyone gets the same question at the same time.";
  if (quiz) {
    const q = L.q;
    $("qCount").textContent = "Question " + q.n;
    $("qLetter").textContent = q.letter;
    const opts = $("qOpts");
    opts.textContent = "";
    q.opts.forEach((o, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = (q.mine === i ? "mine " : "") + (q.revealed && i === q.correct ? "right " : "") + (q.revealed && q.mine === i && i !== q.correct ? "wrong" : "");
      b.textContent = o;
      b.disabled = q.mine !== null || q.revealed;
      b.addEventListener("click", () => learnSend({ op: "learnAnswer", choice: i }));
      opts.appendChild(b);
    });
    const info = $("qInfo");
    if (q.revealed) {
      const right = q.mine !== null && q.mine === q.correct;
      const head = q.mine === null ? "Time is up — the answer was " + q.opts[q.correct] + "." : right ? "Correct! +10 points" : "Not this time — it is " + q.opts[q.correct] + ". Keep going!";
      info.textContent = head + "   " + q.results.map((r) => (r.ok ? "✅ " : "❌ ") + r.name).join("  ");
      info.className = "q-info " + (right ? "ok" : "bad");
    } else {
      info.textContent = q.mine !== null ? "Answer sent — waiting for the others (" + q.answered + " answered)…" : "Pick the sound you hear. " + q.answered + " answered so far.";
      info.className = "q-info";
    }
    if (q.revealed && kQuizDone !== q.n) {
      kQuizDone = q.n;
      const right = q.mine !== null && q.mine === q.correct;
      if (right) markLetter(q.letter, "right");
      if (q.mine !== null) learnFeedback(right);
    }
  }
  $("learnQuizBtn").classList.toggle("hidden", Boolean(quiz && !L.q.revealed));
  $("learnRevealBtn").classList.toggle("hidden", !(quiz && !L.q.revealed));
  $("learnNextBtn").classList.toggle("hidden", !(quiz && L.q.revealed));
  $("learnStopBtn").classList.toggle("hidden", !quiz);

  renderAsks(s);
  renderWords(s);

  // a number on the Ask tab when somebody is waiting for my answer
  const waiting = ((L && L.asks) || []).filter((a) => !a.mine && !a.myAnswer).length;
  $("askBadge").textContent = String(waiting);
  $("askBadge").classList.toggle("hidden", !waiting);

  // everyone's points in this lesson
  const sc = $("learnScores");
  sc.textContent = "";
  const entries = Object.entries((L && L.scores) || {}).sort((a, b) => b[1] - a[1]);
  const medals = ["🥇", "🥈", "🥉"];
  entries.forEach(([name, pts], i) => {
    const c = document.createElement("span");
    c.className = "lchip";
    c.textContent = (medals[i] || "★") + " " + name + " " + pts;
    sc.appendChild(c);
  });
}

$("kPrev").addEventListener("click", () => stepLetter(-1));
$("kNext").addEventListener("click", () => stepLetter(1));
function stepLetter(d) {
  if (!state) return;
  const sel = learnSel(state);
  const idx = Math.max(0, Math.min(hangul[sel.tab].length - 1, sel.idx + d));
  if (state.admin) learnSend({ op: "learnShow", tab: sel.tab, idx });
  else { kTab = sel.tab; kIdx = idx; renderLearn(state); }
}

/* ---- questions between members: "write this word" ---- */
let asksSig = "";
const askDrafts = {}; // what someone has typed into an answer box but not sent yet, kept while the list redraws

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function renderAsks(s) {
  const others = s.players.filter((p) => p.id !== s.you);
  const sel = $("askTo");
  const optSig = others.map((p) => p.id + p.name).join("|");
  if (sel.dataset.sig !== optSig) {
    const keep = sel.value;
    sel.textContent = "";
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "Everyone";
    sel.appendChild(all);
    for (const p of others) { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name; sel.appendChild(o); }
    sel.dataset.sig = optSig;
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
  const asks = (s.learn && s.learn.asks) || [];
  const sig = JSON.stringify(asks);
  if (sig === asksSig) return;
  asksSig = sig;
  for (const inp of $("askList").querySelectorAll("input[data-ask]")) askDrafts[inp.dataset.ask] = inp.value;
  const list = $("askList");
  list.textContent = "";
  $("askEmptyCard").classList.toggle("hidden", asks.length > 0);
  for (const a of [...asks].reverse()) {
    const card = mk("div", "ask-card" + (!a.mine && !a.myAnswer ? " for-me" : ""));
    card.appendChild(mk("div", "ask-q", a.mine ? "You asked " + a.toName + ": " + a.text : a.fromName + " asks " + (a.to === "all" ? "everyone" : "you") + ": " + a.text));
    if (a.mine) {
      if (a.auto) card.appendChild(mk("div", "hint-line", "Right answer: " + a.expect + " — checked for you"));
      if (!a.answers.length) card.appendChild(mk("div", "hint-line", "Waiting for an answer…"));
      for (const ans of a.answers) {
        const row = mk("div", "ask-row");
        row.appendChild(mk("span", "", ans.name + ": " + ans.text + (ans.ok === true ? " ✅" : ans.ok === false ? " ❌" : "")));
        if (ans.ok === null) {
          for (const [label, ok, cls] of [["Right", true, "l-btn primary"], ["Wrong", false, "l-btn soft"]]) {
            const b = mk("button", cls, label);
            b.type = "button";
            b.addEventListener("click", () => learnSend({ op: "learnMark", id: a.id, who: ans.id, ok }));
            row.appendChild(b);
          }
        }
        card.appendChild(row);
      }
      const rm = mk("button", "l-btn soft", "Remove question");
      rm.type = "button";
      rm.style.marginTop = "8px";
      rm.addEventListener("click", () => learnSend({ op: "learnRemoveAsk", id: a.id }));
      card.appendChild(rm);
    } else if (a.myAnswer) {
      card.appendChild(mk("div", "hint-line", "Your answer: " + a.myAnswer.text + (a.myAnswer.ok === true ? " ✅ Correct!" : a.myAnswer.ok === false ? " ❌ Not quite" : " — waiting for " + a.fromName + " to check it")));
    } else {
      const row = mk("div", "ask-row");
      const inp = mk("input");
      inp.type = "text";
      inp.maxLength = 60;
      inp.placeholder = "Write your answer";
      inp.setAttribute("aria-label", "Your answer");
      inp.lang = "ko";
      inp.dataset.ask = a.id;
      inp.autocomplete = "off";
      inp.value = askDrafts[a.id] || "";
      const send = mk("button", "l-btn primary", "Send");
      send.type = "button";
      const go = () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } delete askDrafts[a.id]; learnSend({ op: "learnWrite", id: a.id, text: v }); };
      send.addEventListener("click", go);
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      row.append(inp, send);
      card.appendChild(row);
    }
    list.appendChild(card);
  }
}

/* ---- the shared word list: add words, read them, hear them ---- */
let wordsSig = "";

/** Says a Korean word aloud; `done` runs when it ends (used to read the whole list one after another). */
function speakKo(text, btn, done) {
  try {
    if (!window.speechSynthesis) { toast("This browser cannot speak."); return false; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ko-KR";
    u.rate = 0.8;
    const end = () => { if (btn) btn.classList.remove("playing"); if (done) done(); };
    u.onstart = () => { if (btn) btn.classList.add("playing"); };
    u.onend = end;
    u.onerror = end;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    return true;
  } catch (e) { toast("This browser cannot speak."); return false; }
}

function renderWords(s) {
  const words = (s.learn && s.learn.words) || [];
  const sig = JSON.stringify(words);
  if (sig === wordsSig) return;
  wordsSig = sig;
  const list = $("wordList");
  list.textContent = "";
  $("wordEmptyCard").classList.toggle("hidden", words.length > 0);
  $("wordReadAll").classList.toggle("hidden", !words.length);
  $("wordCount").textContent = words.length ? "· " + words.length : "";
  for (const w of [...words].reverse()) {
    const card = mk("div", "word-card");
    const ko = mk("div", "w-ko", w.ko);
    ko.lang = "ko";
    const text = mk("div", "w-text");
    if (w.roman) text.appendChild(mk("div", "w-roman", w.roman));
    text.appendChild(mk("div", "w-meaning", w.meaning));
    text.appendChild(mk("div", "w-by", "added by " + (w.mine ? "you" : w.byName)));
    const hear = mk("button", "l-icon-btn speak");
    hear.type = "button";
    hear.setAttribute("aria-label", "Hear " + w.ko);
    hear.innerHTML = '<svg class="ico"><use href="#i-speaker"/></svg>';
    hear.addEventListener("click", () => speakKo(w.ko, hear));
    card.append(ko, text, hear);
    if (w.canRemove) {
      const del = mk("button", "l-icon-btn w-del", "✕");
      del.type = "button";
      del.setAttribute("aria-label", "Remove " + w.ko);
      del.addEventListener("click", () => learnSend({ op: "learnWordRemove", id: w.id }));
      card.appendChild(del);
    }
    list.appendChild(card);
  }
}

/* ---- teaching words: a built-in dictionary, an online lookup, and a letter-by-letter "why it sounds like this" ---- */
let dict = null;
let wordTopic = "greetings";
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];

/** The sound of one letter from the letter table ("g / k" is g at the start, k at the end). */
function letterSound(ch, final) {
  if (ch === "ㅇ") return final ? "ng" : "silent here";
  for (const rows of Object.values(hangul || {})) {
    const r = rows.find((x) => x[0] === ch);
    if (r) { const parts = r[1].split(" / "); return final && parts[1] ? parts[1] : parts[0]; }
  }
  return "";
}

/** Splits every Korean syllable into its starting consonant, vowel and optional ending consonant, with each letter's sound. */
function breakdown(ko) {
  const lines = [];
  for (const c of ko) {
    const n = c.charCodeAt(0) - 0xac00;
    if (n < 0 || n > 11171) continue;
    const parts = [[CHO[Math.floor(n / 588)], false], [JUNG[Math.floor((n % 588) / 28)], false]];
    const t = JONG[n % 28];
    if (t) parts.push([t, true]);
    lines.push({ syl: c, parts: parts.map(([ch, fin]) => { const snd = letterSound(ch, fin); return ch + (snd ? " (" + snd + ")" : ""); }) });
  }
  return lines;
}

function wordCard(ko, roman, en, opts = {}) {
  const wrap = mk("div", "word-card tall");
  const top = mk("div", "w-top");
  const k = mk("div", "w-ko", ko);
  k.lang = "ko";
  const text = mk("div", "w-text");
  if (roman) text.appendChild(mk("div", "w-roman", roman));
  text.appendChild(mk("div", "w-meaning", en));
  const hear = mk("button", "l-icon-btn speak");
  hear.type = "button";
  hear.setAttribute("aria-label", "Hear " + ko);
  hear.innerHTML = '<svg class="ico"><use href="#i-speaker"/></svg>';
  hear.addEventListener("click", () => speakKo(ko, hear));
  top.append(k, text, hear);
  wrap.appendChild(top);
  const why = mk("div", "w-why hidden");
  why.appendChild(mk("div", "w-why-h", "Why it sounds like this"));
  for (const l of breakdown(ko)) why.appendChild(mk("div", "w-why-row", l.syl + "  =  " + l.parts.join("  +  ")));
  why.appendChild(mk("div", "w-why-note", "Each Korean block is a starting consonant, then a vowel, and sometimes an ending consonant. Say the sounds together, smoothly."));
  const acts = mk("div", "w-acts");
  const whyBtn = mk("button", "l-btn soft", "Why?");
  whyBtn.type = "button";
  whyBtn.addEventListener("click", () => { why.classList.toggle("hidden"); whyBtn.textContent = why.classList.contains("hidden") ? "Why?" : "Hide"; });
  acts.appendChild(whyBtn);
  const inList = (((state && state.learn && state.learn.words) || []).some((w) => w.ko === ko));
  const add = mk("button", "l-btn soft", inList ? "In our list ✓" : "Add to our list");
  add.type = "button";
  add.disabled = inList;
  add.addEventListener("click", async () => {
    add.disabled = true;
    try { apply(await api({ op: "learnWordAdd", ko, roman: roman || "", meaning: en })); add.textContent = "In our list ✓"; } catch (e) { toast(e.message); add.disabled = false; }
  });
  acts.appendChild(add);
  wrap.append(acts, why);
  return wrap;
}

function renderTopics() {
  if (!dict) return;
  const tabs = $("wordTopics");
  tabs.textContent = "";
  for (const [key, [label, rows]] of Object.entries(dict)) {
    const b = mk("button", key === wordTopic ? "on" : "", label + " · " + rows.length);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", key === wordTopic ? "true" : "false");
    b.addEventListener("click", () => { wordTopic = key; renderTopics(); });
    tabs.appendChild(b);
  }
  const list = $("wordTopicList");
  list.textContent = "";
  for (const [ko, roman, en] of dict[wordTopic][1]) list.appendChild(wordCard(ko, roman, en));
}

async function findWord() {
  const q = $("wordQ").value.trim();
  const out = $("wordResults");
  out.textContent = "";
  if (!q) { out.appendChild(mk("p", "form-msg err", "Type an English word first, like “water”.")); return; }
  const low = q.toLowerCase();
  const hits = [];
  for (const [, [, rows]] of Object.entries(dict || {})) for (const r of rows) if (r[2].toLowerCase().includes(low) || r[1] === low) hits.push(r);
  if (hits.length) {
    for (const [ko, roman, en] of hits.slice(0, 8)) out.appendChild(wordCard(ko, roman, en));
    return;
  }
  const note = mk("p", "muted", "Not in the starter dictionary. Looking it up online…");
  out.appendChild(note);
  try {
    const r = await api({ op: "translate", q });
    out.textContent = "";
    out.appendChild(wordCard(r.ko, "", r.q));
    out.appendChild(mk("p", "muted w-warn", "From an online dictionary (machine translation) — double-check it before relying on it. Tap Why? to see how to read it, letter by letter."));
  } catch (e) {
    out.textContent = "";
    out.appendChild(mk("p", "form-msg err", e.message));
  }
}
$("wordFind").addEventListener("click", findWord);
$("wordQ").addEventListener("keydown", (e) => { if (e.key === "Enter") findWord(); });

function wordMessage(kind, text) {
  const m = $("wordMsg");
  m.textContent = text;
  m.className = "form-msg " + kind;
  clearTimeout(wordMessage.t);
  wordMessage.t = setTimeout(() => m.classList.add("hidden"), 5000);
}
$("wordAdd").addEventListener("click", async () => {
  const ko = $("wordKo").value.trim();
  const meaning = $("wordMeaning").value.trim();
  if (!ko) { wordMessage("err", "Write the Korean word first."); $("wordKo").focus(); return; }
  if (!meaning) { wordMessage("err", "Write what the word means."); $("wordMeaning").focus(); return; }
  const btn = $("wordAdd");
  btn.disabled = true;
  try {
    apply(await api({ op: "learnWordAdd", ko, roman: $("wordRoman").value, meaning }));
  } catch (e) {
    wordMessage("err", e.message);
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  ["wordKo", "wordRoman", "wordMeaning"].forEach((id) => { $(id).value = ""; });
  wordMessage("ok", "Added! Everyone in the lesson can read it now.");
  $("wordKo").focus();
});
$("wordReadAll").addEventListener("click", () => {
  const words = ((state && state.learn && state.learn.words) || []).map((w) => w.ko);
  const next = (i) => { if (i < words.length && learnOpen) speakKo(words[i], null, () => setTimeout(() => next(i + 1), 500)); };
  next(0);
});

function askMessage(kind, text) {
  const m = $("askMsg");
  m.textContent = text;
  m.className = "form-msg " + kind;
  clearTimeout(askMessage.t);
  askMessage.t = setTimeout(() => m.classList.add("hidden"), 5000);
}
const counter = (inputId, countId, max) => $(inputId).addEventListener("input", () => { $(countId).textContent = $(inputId).value.length + " / " + max; });
counter("askText", "askTextCount", 120);
counter("askExpect", "askExpectCount", 60);
$("askSend").addEventListener("click", async () => {
  const text = $("askText").value.trim();
  if (!text) { askMessage("err", "Write your question first."); $("askText").focus(); return; }
  const btn = $("askSend");
  btn.disabled = true;
  try {
    apply(await api({ op: "learnAsk", to: $("askTo").value, text, expect: $("askExpect").value }));
  } catch (e) {
    askMessage("err", e.message);
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  $("askText").value = "";
  $("askExpect").value = "";
  $("askTextCount").textContent = "0 / 120";
  $("askExpectCount").textContent = "0 / 60";
  askMessage("ok", "Sent! The answer will show up in the list below.");
});

async function learnSend(body) {
  try { apply(await api(body)); } catch (e) { toast(e.message); }
}
$("learnFollow").addEventListener("change", () => { if (state) renderLearn(state); });
$("learnQuizBtn").addEventListener("click", () => { const s = state; learnSend({ op: "learnQuiz", tab: s.learn ? s.learn.tab : kTab }); });
$("learnRevealBtn").addEventListener("click", () => learnSend({ op: "learnReveal" }));
$("learnNextBtn").addEventListener("click", () => learnSend({ op: "learnQuiz", tab: state.learn ? state.learn.tab : kTab }));
$("learnStopBtn").addEventListener("click", () => learnSend({ op: "learnShow", tab: state.learn.tab, idx: state.learn.idx }));

$("kSpeak").addEventListener("click", () => {
  const btn = $("kSpeak");
  try {
    if (!kSpeech || !window.speechSynthesis) { toast("This browser cannot speak."); return; }
    const u = new SpeechSynthesisUtterance(kSpeech);
    u.lang = "ko-KR";
    u.rate = 0.8;
    const done = () => btn.classList.remove("playing");
    u.onstart = () => btn.classList.add("playing");
    u.onend = done;
    u.onerror = done;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) { toast("This browser cannot speak."); }
});

function closeLearn() {
  learnOpen = false;
  $("learnPage").classList.add("hidden");
  document.body.classList.remove("learning");
  try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) { /* nothing speaking */ }
}

/** Opens the page straight away (with a loading state), then fetches the letters; a failure shows a retry card instead of a blank page. */
async function openLearn() {
  learnOpen = true;
  renderLearn.autoQ = 0;
  document.body.classList.add("learning");
  $("learnPage").classList.remove("hidden");
  setPane("letters");
  $("learnError").classList.add("hidden");
  if (!hangul) {
    ["paneLetters", "paneQuiz", "paneWords", "paneAsk"].forEach((id) => $(id).classList.add("hidden"));
    $("learnLoading").classList.remove("hidden");
    try {
      const k = await api({ op: "korean" });
      hangul = k.hangul;
      dict = k.words;
    } catch (e) {
      $("learnLoading").classList.add("hidden");
      $("learnErrorText").textContent = e.message || "Check your connection and try again.";
      $("learnError").classList.remove("hidden");
      return;
    }
    $("learnLoading").classList.add("hidden");
    setPane("letters");
    renderTopics();
  }
  renderLearn(state);
}
$("koreanBtn").addEventListener("click", openLearn);
$("learnRetry").addEventListener("click", openLearn);
$("learnBack").addEventListener("click", closeLearn);

/* ---------- the real admin: told whenever anybody signs in to any room ---------- */

const joinAlertsOn = () => store("uno-joinalerts") === "1";
function renderJoinAlertBtn() {
  const on = joinAlertsOn() && typeof Notification !== "undefined" && Notification.permission === "granted";
  $("joinAlertBtn").textContent = "👤 Join alerts: " + (on ? "on" : "off");
  $("joinAlertBtn").classList.toggle("on", on);
}
$("joinAlertBtn").addEventListener("click", async () => {
  if (joinAlertsOn()) { store("uno-joinalerts", "0"); renderJoinAlertBtn(); return; }
  if (typeof Notification === "undefined") { toast("This browser cannot show notifications."); return; }
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") { toast("Notifications are blocked — allow them in the browser's site settings."); renderJoinAlertBtn(); return; }
  store("uno-joinalerts", "1");
  registerAlertWorker();
  renderJoinAlertBtn();
  toast("You will be told whenever anybody signs in (keep this page open).");
});

let lastJoinCheck = 0;
async function checkJoins() {
  if (!state || !state.admin || !joinAlertsOn() || Date.now() - lastJoinCheck < 6000) return;
  lastJoinCheck = Date.now();
  let r;
  try { r = await api({ op: "joins" }); } catch (e) { return; }
  for (const j of r.joins || []) {
    const text = j.n + " joined " + j.r + " (" + j.role + ")";
    toast("👤 " + text);
    if (typeof Notification === "undefined" || Notification.permission !== "granted") continue;
    const opts = { body: text, tag: "join-" + j.r + "-" + j.n + "-" + j.t, vibrate: [100, 50, 100] };
    const title = BASE_TITLE + " · New player";
    const fallback = () => { try { new Notification(title, opts); } catch (e) { /* needs the worker */ } };
    if ("serviceWorker" in navigator) navigator.serviceWorker.getRegistration().then((reg) => (reg ? reg.showNotification(title, opts) : fallback())).catch(fallback);
    else fallback();
  }
}
renderJoinAlertBtn();
if (joinAlertsOn()) registerAlertWorker();

/* ---------- stats and history (public and private kept apart) ---------- */

const emptyStats = () => ({ played: 0, wins: 0, losses: 0, streak: 0, best: 0, keys: [] });

/** Totals kept on this device, one set for public games and one for private games. */
function deviceStatsAll() {
  let raw;
  try { raw = JSON.parse(store("uno-stats") || "{}"); } catch (e) { raw = {}; }
  if (typeof raw.played === "number") raw = { public: raw }; // totals saved before the two were kept apart
  return { public: { ...emptyStats(), ...(raw.public || {}) }, private: { ...emptyStats(), ...(raw.private || {}) } };
}

/** Counted once per finished game I played in, under the kind of game it was. */
function recordDeviceStats(s, me) {
  if (!s.over || !s.gameNo || !s.seated) return;
  const mode = s.gameMode === "private" ? "private" : "public";
  const key = room + "#" + s.gameNo;
  const all = deviceStatsAll();
  const st = all[mode];
  if (st.keys.includes(key)) return;
  st.keys = [...st.keys, key].slice(-30);
  st.played += 1;
  if (s.ranking[0] === me.name) {
    st.wins += 1;
    st.streak += 1;
    st.best = Math.max(st.best, st.streak);
  } else st.streak = 0;
  if (s.loser === me.name) st.losses += 1;
  store("uno-stats", JSON.stringify(all));
}

function statsTable(rows) {
  const t = document.createElement("table");
  const head = t.insertRow();
  const pts = rows.some((r) => r.points !== undefined);
  ["Player", "Played", "Wins", "Lost"].concat(pts ? ["Points"] : []).forEach((h) => { const th = document.createElement("th"); th.textContent = h; head.appendChild(th); });
  for (const r of rows) {
    const tr = t.insertRow();
    [r.name, r.played, r.wins, r.losses].concat(pts ? [r.points || 0] : []).forEach((v) => { tr.insertCell().textContent = String(v); });
  }
  return t;
}

let statsData = null; // what the server sent: { current, modes: { public?, private? } }
let statsMode = "public";

function renderStats() {
  if (!statsData) return;
  const modes = Object.keys(statsData.modes);
  if (!modes.includes(statsMode)) statsMode = modes.includes(statsData.current) ? statsData.current : modes[0];
  // only the admin can see both kinds; everyone else sees just the kind of game they are in
  const tabs = $("statsTabs");
  tabs.textContent = "";
  tabs.classList.toggle("hidden", modes.length < 2);
  if (modes.length > 1) {
    for (const m of modes) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ghost" + (m === statsMode ? " on" : "");
      b.textContent = m === "private" ? "🔒 Private" : "🌐 Public";
      b.addEventListener("click", () => { statsMode = m; renderStats(); });
      tabs.appendChild(b);
    }
  }
  $("statsModeNote").textContent = modeName(statsMode) + "s only — public and private are never mixed.";
  const d = statsData.modes[statsMode];
  const roomBox = $("statsRoom");
  roomBox.textContent = "";
  if (!d.table.length) { roomBox.className = "none"; roomBox.textContent = "No finished " + statsMode + " games in this room yet."; } else {
    roomBox.className = "";
    roomBox.appendChild(statsTable(d.table));
  }
  const hist = $("statsHistory");
  hist.textContent = "";
  for (const g of d.history) {
    const row = document.createElement("div");
    row.className = "game";
    const when = new Date(g.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const order = g.ranking.map((n, i) => (i + 1) + ". " + n).join("  ");
    const head = document.createElement("b");
    head.textContent = "#" + g.no + " · " + when;
    row.append(head, document.createTextNode("  " + (order || "ended early") + (g.loser ? "  — last: " + g.loser : "")));
    hist.appendChild(row);
  }
  if (!d.history.length) { const n = document.createElement("div"); n.className = "none"; n.textContent = "—"; hist.appendChild(n); }
  renderDeviceStats(statsMode);
}

function renderDeviceStats(mode) {
  const st = deviceStatsAll()[mode];
  const box = $("statsDevice");
  box.textContent = "";
  if (!st.played) { box.className = "none"; box.textContent = "No " + mode + " games played on this device yet."; return; }
  box.className = "";
  box.appendChild(statsTable([{ name: "You", played: st.played, wins: st.wins, losses: st.losses }]));
  const line = document.createElement("div");
  line.className = "none";
  line.textContent = "Win rate " + Math.round((100 * st.wins) / st.played) + "% · current streak " + (st.streak || 0) + " · best streak " + (st.best || 0);
  box.appendChild(line);
}

async function openStats() {
  $("statsModal").classList.remove("hidden");
  statsData = null;
  statsMode = modeOf(state);
  $("statsTabs").classList.add("hidden");
  $("statsModeNote").textContent = "";
  $("statsRoom").className = "none";
  $("statsRoom").textContent = "Loading…";
  $("statsHistory").textContent = "";
  renderDeviceStats(statsMode);
  try {
    statsData = (await api({ op: "stats" })).stats;
    renderStats();
  } catch (e) {
    $("statsRoom").textContent = e.message;
  }
}
$("statsBtn").addEventListener("click", openStats);
["statsX", "statsClose"].forEach((id) => $(id).addEventListener("click", () => $("statsModal").classList.add("hidden")));
$("statsModal").addEventListener("click", (e) => { if (e.target === $("statsModal")) $("statsModal").classList.add("hidden"); });

(function init() {
  const r = new URLSearchParams(location.search).get("room");
  if (r) $("roomInput").value = r;
  const n = store("uno-name");
  if (n) $("nameInput").value = n;
  const wanted = (r || "main").trim();
  if (/^[A-Za-z0-9_-]{1,24}$/.test(wanted)) {
    room = wanted;
    resumeSession(); // a refresh goes straight back to the table when this tab already signed in
  }
})();

/* ---------- phone helpers: "Desktop site" hint and ?debug=1 diagnostics ---------- */

/** True when a small phone screen is showing a desktop-width page (the browser's "Desktop site" option is on). A phone held
 *  sideways is NOT this: its screen is wide too, so the page width matches the screen width. */
function desktopOnPhone(screenW, screenH, innerW) {
  return Math.min(screenW, screenH) <= 600 && innerW > 700 && innerW > screenW * 1.3;
}

(function phoneHelpers() {
  if (desktopOnPhone(screen.width, screen.height, window.innerWidth)) {
    $("desktopHint").classList.remove("hidden");
    $("desktopHintOk").addEventListener("click", () => $("desktopHint").classList.add("hidden"));
  }
  if (new URLSearchParams(location.search).get("debug") !== "1") return;
  const box = document.createElement("div");
  box.id = "debugBox";
  document.body.appendChild(box);
  let brave = "no";
  if (navigator.brave && navigator.brave.isBrave) navigator.brave.isBrave().then((b) => { brave = b ? "yes" : "no"; });
  const tick = () => {
    const hand = $("hand"), doc = document.documentElement, vv = window.visualViewport;
    const hr = hand.getBoundingClientRect();
    box.textContent = [
      "window " + window.innerWidth + "x" + window.innerHeight + "  visual " + (vv ? Math.round(vv.width) + "x" + Math.round(vv.height) : "n/a"),
      "screen " + screen.width + "x" + screen.height + "  dpr " + window.devicePixelRatio,
      "brave: " + brave + "  desktop-site? " + desktopOnPhone(screen.width, screen.height, window.innerWidth),
      "in-game class: " + document.body.classList.contains("in-game") + "  --app-h: " + doc.style.getPropertyValue("--app-h"),
      "page scrollable: " + (doc.scrollHeight > doc.clientHeight + 1) + " (" + doc.scrollHeight + " vs " + doc.clientHeight + ")",
      "hand: cards " + hand.querySelectorAll(".card").length + "  top " + Math.round(hr.top) + "  bottom " + Math.round(hr.bottom) + "  scrollW " + hand.scrollWidth + "/" + hand.clientWidth,
      "state: " + (state ? (state.started ? "game" : "lobby") + " seated=" + state.seated + " hand=" + (state.hand ? state.hand.length : "-") : "none"),
    ].join("\n");
  };
  tick();
  setInterval(tick, 1000);
})();
