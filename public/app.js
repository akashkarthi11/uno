"use strict";

const LABEL = { skip: "⊘", reverse: "⇄", draw2: "+2", wild: "W", wild4: "+4" };
const POLL_MS = 1500;
const REQUEST_TIMEOUT_MS = 8000;
const HEARTBEAT_MS = 8000;
const $ = (id) => document.getElementById(id);

let state = null;
let room = "main";
let myName = "";
let myPassword = "";
let playerId = null;
let pendingWild = null;
let polling = false;
let busy = false;
let toastTimer = null;

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (e) { /* storage may be blocked */ }
  return null;
}

/* ---------- server calls ---------- */

async function api(body) {
  // A request that hangs must not freeze the game, so every call has a timeout.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
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
  let data = {};
  try { data = await r.json(); } catch (e) { /* non-JSON error page */ }
  if (!r.ok) {
    const err = new Error(data.error || "Server error (" + r.status + ")");
    err.denied = !!data.denied;
    throw err;
  }
  return data;
}

function apply(data) {
  if (data.state) {
    // Responses can arrive out of order; never replace newer state with older.
    if (state && data.state.you === state.you && data.state.version < state.version) return;
    state = data.state;
    playerId = state.you;
    store("uno-id-" + room, playerId);
    render();
    if (typeof voiceSync === "function") voiceSync(state);
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
  history.replaceState(null, "", "?room=" + encodeURIComponent(room));
  $("roomName").textContent = room;
  $("roomInfo").classList.remove("hidden");
  $("joinScreen").classList.add("hidden");
  startPolling();
}

let inFlight = false;
let lastOk = Date.now();
let removed = false;

function removedByAdmin() {
  removed = true;
  if (typeof voiceStopLocal === "function") voiceStopLocal();
  state = null;
  playerId = null;
  store("uno-id-" + room, "");
  ["game", "lobby", "roomInfo", "endModal", "colorModal", "cheatModal", "chatToggle", "chatDock"].forEach((id) => $(id).classList.add("hidden"));
  $("joinScreen").classList.remove("hidden");
  toast("You were removed by the admin.");
}

async function pollOnce() {
  if (busy || inFlight || removed) return;
  inFlight = true;
  try {
    const data = await api({ op: "state", since: state ? state.version : undefined });
    if (data.kicked) {
      removedByAdmin();
    } else if (data.gone) {
      // The table forgot us (idle too long) — quietly rejoin with the same password.
      playerId = null;
      state = null;
      apply(await api({ op: "join", name: myName, password: myPassword }));
    } else if (!data.unchanged) {
      apply(data);
    }
    lastOk = Date.now();
  } catch (e) {
    if (Date.now() - lastOk > HEARTBEAT_MS) toast("Connection problem — retrying…");
  } finally {
    inFlight = false;
  }
}

function startPolling() {
  if (polling) return;
  polling = true;
  const tick = async () => {
    await pollOnce(); // never throws
    setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);
  // Background tabs throttle timers; catch up the moment the player looks again.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollOnce(); });
  window.addEventListener("focus", pollOnce);
  window.addEventListener("online", pollOnce);
}

async function send(body) {
  busy = true;
  try {
    apply(await api(body));
  } catch (e) {
    if (/removed by the admin/.test(e.message)) removedByAdmin();
    else toast(e.message);
  } finally {
    busy = false;
  }
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
  el.innerHTML = '<span class="c tl">' + sym + '</span><span class="v">' + sym + '</span><span class="c br">' + sym + "</span>";
  return el;
}

function render() {
  if (!state) return;
  const s = state;
  $("privateChip").classList.toggle("hidden", !s.private);
  const inGame = s.started;
  placeChat(inGame);
  renderChat(s);
  updateChatUi(s);
  $("lobby").classList.toggle("hidden", inGame);
  $("game").classList.toggle("hidden", !inGame);
  if (!inGame) {
    seenCards = null;
    lastTopId = null;
    turn = null;
    updateTimer();
    $("endModal").classList.add("hidden");
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
    if (s.admin && p.id !== s.you) {
      const x = document.createElement("button");
      x.className = "ghost remove";
      x.textContent = "Remove";
      x.addEventListener("click", () => removePlayer(p));
      li.appendChild(x);
    }
    if (p.id === s.host) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "admin";
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
  const isHost = s.you === s.host;
  $("privateBtn").classList.toggle("hidden", !s.admin);
  $("privateBtn").textContent = s.private ? "🔓 Make public" : "🔒 Make private";
  $("startBtn").classList.toggle("hidden", !isHost);
  $("startBtn").disabled = s.players.length < 2;
  $("lobbyHint").textContent = isHost
    ? (s.players.length < 2 ? "Waiting for at least one more player — send them the invite link." : "Everyone here will be dealt in when you press Start.")
    : (s.host ? "Waiting for the admin to start the game…" : "Waiting for the admin to join and start the game…");
}

function renderGame(s) {
  const me = s.players.find((p) => p.id === s.you);
  const myTurn = !s.over && s.cur === s.you;
  const curPlayer = s.players.find((p) => p.id === s.cur);

  const opp = $("opponents");
  opp.innerHTML = "";
  for (const p of s.players) {
    if (p.id === s.you) continue;
    const d = document.createElement("div");
    d.className = "opp" + (s.cur === p.id && !s.over ? " active" : "") + (p.connected ? "" : " offline");
    const rank = s.ranking.indexOf(p.name) + 1;
    d.innerHTML = '<div class="avatar"></div><div class="name"></div><div class="mini">' + "<span></span>".repeat(Math.min(p.count, 10)) +
      '</div><div class="count">' +
      (p.finished ? '<span class="uno-tag">✔ out (#' + rank + ")</span>" :
        p.count + " card" + (p.count === 1 ? "" : "s") + (p.count === 1 ? ' <span class="uno-tag">GrowX!</span>' : "")) +
      (p.connected ? "" : " · offline") + "</div>";
    d.querySelector(".name").textContent = p.name;
    d.dataset.pid = p.id;
    paintAvatar(d.querySelector(".avatar"), p.name);
    if (s.admin && !s.over) {
      const x = document.createElement("button");
      x.className = "ghost kick";
      x.title = "Remove " + p.name;
      x.textContent = "✕";
      x.addEventListener("click", () => removePlayer(p));
      d.appendChild(x);
    }
    opp.appendChild(d);
  }

  $("game").classList.toggle("myturn", myTurn);
  $("status").classList.toggle("mine", myTurn);

  const dp = $("discardPile");
  dp.innerHTML = "";
  dp.dataset.color = s.color;
  const topEl = cardEl(s.top);
  if (lastTopId !== null && lastTopId !== s.top.id) topEl.classList.add("pop");
  lastTopId = s.top.id;
  dp.appendChild(topEl);
  $("colorDot").style.background = "var(--" + (s.color === "yellow" ? "card-yellow" : s.color) + ")";
  $("drawCount").textContent = s.deck + " in pile";
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
    el.addEventListener("click", () => onCard(card));
    hand.appendChild(el);
  }

  seenCards = nowSeen;
  turn = s.over ? null : { deadline: Date.now() + s.turnLeft, frozen: s.turnLeft, paused: s.paused, total: s.turnMs, mine: myTurn, name: curPlayer ? curPlayer.name : "?" };
  $("pausedBanner").classList.toggle("hidden", !(s.paused && !s.over));
  $("pauseBtn").classList.toggle("hidden", !(s.admin && !s.over));
  $("pauseBtn").textContent = s.paused ? "▶ Resume" : "⏸ Pause";
  updateTimer();

  let msg;
  if (!s.seated) msg = "You joined mid-game — you'll be dealt in next game.";
  else if (s.over) msg = "Game over.";
  else if (s.paused) msg = "⏸ Paused by the admin — hang tight.";
  else if (me && me.finished) msg = "You're out (#" + (s.ranking.indexOf(me.name) + 1) + ")! Watching the rest play…";
  else if (myTurn && me && me.count === 2 && !s.saidUno) msg = "⚠ Press GrowX! before you play your second-to-last card — or you draw 1 extra card!";
  else if (myTurn) msg = s.drawn != null ? "You drew a playable card — play it or press Pass." : (s.playable.length ? "Your turn — play a highlighted card or draw." : "Your turn — no playable card, draw from the pile.");
  else msg = (curPlayer ? curPlayer.name : "?") + "'s turn…";
  $("message").textContent = msg;

  // Spectators (joined mid-game) see the table and card counts only: no hand, no play buttons.
  ["passBtn", "unoBtn"].forEach((id) => $(id).classList.toggle("hidden", !s.seated));
  $("hand").classList.toggle("hidden", !s.seated);
  $("drawPile").style.cursor = s.seated ? "pointer" : "default";
  $("restartBtn").classList.toggle("hidden", !s.admin);
  $("passBtn").disabled = !(myTurn && s.drawn != null) || s.paused;
  // GrowX! must be pressed while you hold 2 cards, i.e. before playing the second-to-last one.
  const canUno = s.seated && !s.over && me && me.count > 0 && me.count <= 2 && !s.saidUno;
  $("unoBtn").disabled = !canUno;
  $("unoBtn").textContent = s.saidUno && me && me.count <= 2 ? "GrowX! ✓" : "GrowX!";
  $("unoBtn").classList.toggle("pulse", canUno && myTurn);

  const log = $("log");
  log.innerHTML = "";
  for (const line of s.log.slice().reverse()) {
    const d = document.createElement("div");
    d.textContent = line;
    log.appendChild(d);
  }

  const end = $("endModal");
  if (s.over) {
    const mine = me && me.name;
    $("endTitle").textContent = s.loser
      ? (s.loser === mine ? "😬 You lose — last with cards!" : s.loser + " loses!")
      : "Game ended";
    const order = s.ranking.map((n, i) => (i + 1) + ". " + n).join("   ");
    $("endText").textContent = (s.notice || "") + (order ? "Finished: " + order : "") +
      (s.loser ? "   Last: " + s.loser : "");
    $("playAgain").classList.toggle("hidden", !s.admin);
    $("toLobby").classList.toggle("hidden", !s.admin);
    $("endHint").textContent = s.admin ? "" : "Waiting for the admin to start the next game…";
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

function updateTimer() {
  const bar = $("turnBar");
  const root = document.documentElement;
  if (!turn) {
    bar.classList.add("hidden");
    setTurnTheme(null);
    return;
  }
  const left = turn.paused ? turn.frozen : Math.max(0, turn.deadline - Date.now());
  const frac = Math.min(1, left / turn.total);
  const secs = Math.ceil(left / 1000);
  const fill = $("turnFill");
  bar.classList.remove("hidden");
  fill.style.width = frac * 100 + "%";
  if (turn.paused) {
    fill.style.background = "#98a2b3"; // frozen: grey, no green-to-red frame
    setTurnTheme(null);
    $("turnText").textContent = "⏸ Paused · " + secs + "s left";
  } else if (turn.mine) {
    const hue = Math.round(120 * frac); // 120 = green ... 0 = red
    const color = "hsl(" + hue + ", 78%, 42%)";
    fill.style.background = color;
    setTurnTheme(color, "hsla(" + hue + ", 78%, 42%, 0.12)");
    $("turnText").textContent = "Your turn · " + secs + "s";
  } else {
    fill.style.background = "";
    setTurnTheme(null);
    $("turnText").textContent = turn.name + "'s turn · " + secs + "s";
  }
}

/** Colours the screen frame, status bar, and the phone's browser bar; null restores the normal theme. */
function setTurnTheme(color, tint) {
  const root = document.documentElement;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (color) {
    root.style.setProperty("--turn-color", color);
    root.style.setProperty("--turn-tint", tint);
    $("turnFrame").classList.remove("hidden");
    if (meta) meta.setAttribute("content", color);
  } else {
    root.style.removeProperty("--turn-color");
    root.style.removeProperty("--turn-tint");
    $("turnFrame").classList.add("hidden");
    if (meta) meta.setAttribute("content", "#7c5cff");
  }
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
  b.addEventListener("click", () => send({ op: "chat", text: e }));
  $("emojiBar").appendChild(b);
});

$("chatForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  $("chatInput").value = "";
  send({ op: "chat", text });
});

/* ---------- small visual helpers ---------- */

let lastTopId = null;
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
    for (const v of ["skip", "reverse", "draw2"]) options.push({ color: c, value: v });
  }
  options.push({ color: "wild", value: "wild" }, { color: "wild", value: "wild4" });
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
$("cheatCancel").addEventListener("click", () => $("cheatModal").classList.add("hidden"));

function onCard(card) {
  if (!state || state.over || state.cur !== state.you) return;
  if (!state.playable.includes(card.id)) {
    toast(card.value === "wild4" ? "Wild Draw Four needs a hand with no card of the current colour." : "You can't play that card.");
    return;
  }
  if (card.color === "wild") {
    pendingWild = card;
    $("colorModal").classList.remove("hidden");
  } else {
    send({ op: "play", cardId: card.id });
  }
}

document.querySelectorAll("#colorModal button").forEach((b) =>
  b.addEventListener("click", () => {
    $("colorModal").classList.add("hidden");
    if (pendingWild) send({ op: "play", cardId: pendingWild.id, color: b.dataset.color });
    pendingWild = null;
  }));

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
$("unoBtn").addEventListener("click", () => send({ op: "uno" }));
$("rulesBtn").addEventListener("click", () => $("rulesModal").classList.remove("hidden"));
$("closeRules").addEventListener("click", () => $("rulesModal").classList.add("hidden"));
$("copyLink").addEventListener("click", () => {
  const link = location.origin + "/?room=" + encodeURIComponent(room);
  (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
    .then(() => toast("Invite link copied"), () => toast(link));
});

(function init() {
  const r = new URLSearchParams(location.search).get("room");
  if (r) $("roomInput").value = r;
  const n = store("uno-name");
  if (n) $("nameInput").value = n;
})();
