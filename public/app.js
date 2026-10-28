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
function notePing(ms) {
  const el = $("ping");
  if (ms === null) { // the last check did not get through
    pingSamples.length = 0;
    el.className = "ping bad";
    el.lastChild.textContent = "offline";
    return;
  }
  pingSamples.push(ms);
  if (pingSamples.length > 5) pingSamples.shift();
  const mid = [...pingSamples].sort((a, b) => a - b)[Math.floor(pingSamples.length / 2)];
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
  state = { ...state, chat: [...(state.chat || []), { from: state.you, name: me ? me.name : "You", text, t: Date.now() }] };
  renderChat(state);
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
$("pubVoiceBtn").addEventListener("click", togglePublicVoice);

function renderRelayBtn(s) {
  const pv = $("pubVoiceBtn");
  pv.classList.toggle("hidden", !s.admin || s.private); // a private game has no public players, so the switch is not needed there
  const pvOn = Boolean(s.settings && s.settings.publicVoice);
  pv.textContent = "🎙 Public voice: " + (pvOn ? "on" : "off");
  pv.classList.toggle("on", pvOn);
  pv.title = pvOn
    ? "Public players can join voice chat too. Click to limit voice to you and private players."
    : "Only you and private players have voice chat. Click to let public players join it too.";
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
  const sym = LABEL[card.value] || card.value;
  const isSuper = SUPER.has(card.value);
  if (isSuper) el.classList.add("super");
  if (card.value === "master") el.classList.add("master"); // the plain blank-faced card
  el.innerHTML = (isSuper ? '<span class="star">★</span>' : "") +
    '<span class="c tl">' + sym + '</span><span class="v">' + sym + '</span><span class="c br">' + sym + "</span>";
  return el;
}

function render() {
  if (!state) return;
  const s = state;
  $("privateChip").classList.toggle("hidden", !s.private);
  renderSettings(s);
  renderRelayBtn(s);
  renderNotifyBtn(); // the alerts switch belongs to the kind of game on screen (public or private)
  applyTheme(s.settings && s.settings.theme); // every update carries the room's theme, so a change shows for everyone
  const inGame = s.started;
  // the sheet is only useful while it is still your turn and the card is still in your hand
  if (sheet && !(s.started && !s.over && !s.paused && s.cur === s.you && s.hand.some((c) => c.id === sheet.card.id))) closeSheet();
  document.body.classList.toggle("in-game", inGame); // on phones a running game fills the screen exactly, no page scrolling
  renderRotateHint();
  placeChat(inGame);
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
  const isHost = s.canStart; // the admin, or a player the admin allowed to start games
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
    d.style.top = ((upright ? 37 : 49) - (upright ? 24 : 32) * Math.sin(ang)).toFixed(1) + "%";
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
  if (s.pending) msg = "Playing…";
  else if (!s.seated) msg = "You joined mid-game — you'll be dealt in next game.";
  else if (s.over) msg = "Game over.";
  else if (s.paused) msg = s.pauseNote ? "⏸ Paused — " + s.pauseNote : "⏸ Paused by the admin — hang tight.";
  else if (me && me.finished) msg = "You're out (#" + (s.ranking.indexOf(me.name) + 1) + ")! Watching the rest play…";
  else if (s.catchable === s.you) msg = "🚨 One card left — press GrowX! before someone catches you!";
  else if (myTurn && s.pend) {
    msg = "+" + s.pend.n + " is waiting — " + (s.playable.length ? "play a " + (s.pend.kind === "wild4" ? "+4" : "+2") + " to stack it, " : "") +
      (s.pend.canChallenge ? "challenge it, " : "") + "or tap the pile to draw " + s.pend.n + ".";
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
  const canUno = s.seated && !s.over && me && me.count > 0 && me.count <= 2 && !s.saidUno;
  $("unoBtn").disabled = !canUno;
  $("unoBtn").textContent = s.saidUno && me && me.count <= 2 ? "GrowX! ✓" : "GrowX!";
  $("unoBtn").classList.toggle("pulse", canUno && (myTurn || s.catchable === s.you));
  const catchTarget = s.catchable && s.catchable !== s.you && s.seated && me && !me.finished && !s.paused && !s.over
    ? s.players.find((p) => p.id === s.catchable) : null;
  $("catchBtn").classList.toggle("hidden", !catchTarget);
  if (catchTarget) $("catchBtn").textContent = "🎯 Catch " + catchTarget.name + "!";
  $("challengeBtn").classList.toggle("hidden", !(myTurn && s.pend && s.pend.canChallenge && !s.paused));
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

function renderChat(s) {
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

function onCard(card) {
  if (!state || state.over || state.cur !== state.you) return;
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
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) settingsModal.classList.add("hidden"); });
["rulesBtn", "statsBtn", "leaveBtn"].forEach((id) => $(id).addEventListener("click", () => settingsModal.classList.add("hidden")));

/* ---------- landscape: the table is laid out wide; on a phone held upright we offer to turn it ---------- */
const maxBacks = () => (window.innerHeight > window.innerWidth ? 8 : 16); // an upright phone is narrow: fewer backs, then "+n"
let rotateDismissed = false;
function renderRotateHint() {
  const portrait = window.innerHeight > window.innerWidth;
  const touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  $("rotateHint").classList.toggle("hidden", !(document.body.classList.contains("in-game") && portrait && touch && !rotateDismissed));
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
  send({ op: "draw" });
});
$("pauseBtn").addEventListener("click", () => send({ op: state && state.paused ? "resume" : "pause" }));
$("restartBtn").addEventListener("click", () => {
  if (confirm("End this game and send everyone back to the lobby?")) send({ op: "lobby" });
});
$("toLobby").addEventListener("click", () => send({ op: "lobby" }));
$("passBtn").addEventListener("click", () => send({ op: "pass" }));
$("catchBtn").addEventListener("click", () => send({ op: "catch" }));
$("challengeBtn").addEventListener("click", () => send({ op: "challenge" }));
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
  ["Player", "Played", "Wins", "Lost"].forEach((h) => { const th = document.createElement("th"); th.textContent = h; head.appendChild(th); });
  for (const r of rows) {
    const tr = t.insertRow();
    [r.name, r.played, r.wins, r.losses].forEach((v) => { tr.insertCell().textContent = String(v); });
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
