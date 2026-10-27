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
  }
}

async function join() {
  myName = $("nameInput").value.trim();
  myPassword = $("pwInput").value;
  if (!myPassword) { toast("Enter the password"); return; }
  room = $("roomInput").value.trim() || "main";
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(room)) { toast("Room: letters, digits, - and _ only"); return; }
  $("joinBtn").disabled = true;
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

async function pollOnce() {
  if (busy || inFlight) return;
  inFlight = true;
  try {
    const data = await api({ op: "state", since: state ? state.version : undefined });
    if (data.gone) {
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
    toast(e.message);
  } finally {
    busy = false;
  }
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
  const inGame = s.started;
  $("lobby").classList.toggle("hidden", inGame);
  $("game").classList.toggle("hidden", !inGame);
  if (!inGame) {
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
    li.textContent = p.name + (p.id === s.you ? " (you)" : "");
    if (p.id === s.host) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "admin";
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
  const isHost = s.you === s.host;
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
    d.innerHTML = '<div class="name"></div><div class="mini">' + "<span></span>".repeat(Math.min(p.count, 10)) +
      '</div><div class="count">' +
      (p.finished ? '<span class="uno-tag">✔ out (#' + rank + ")</span>" :
        p.count + " card" + (p.count === 1 ? "" : "s") + (p.count === 1 ? ' <span class="uno-tag">GrowX!</span>' : "")) +
      (p.connected ? "" : " · offline") + "</div>";
    d.querySelector(".name").textContent = p.name;
    opp.appendChild(d);
  }

  const dp = $("discardPile");
  dp.innerHTML = "";
  dp.appendChild(cardEl(s.top));
  $("colorDot").style.background = "var(--" + (s.color === "yellow" ? "card-yellow" : s.color) + ")";
  $("drawCount").textContent = s.deck + " in pile";
  $("dirInfo").textContent = s.dir === 1 ? "↻" : "↺";

  const hand = $("hand");
  hand.innerHTML = "";
  const ok = new Set(s.playable);
  for (const card of s.hand) {
    const el = cardEl(card);
    if (ok.has(card.id)) el.classList.add("playable");
    el.addEventListener("click", () => onCard(card));
    hand.appendChild(el);
  }

  let msg;
  if (!s.seated) msg = "You joined mid-game — you'll be dealt in next game.";
  else if (s.over) msg = "Game over.";
  else if (me && me.finished) msg = "You're out (#" + (s.ranking.indexOf(me.name) + 1) + ")! Watching the rest play…";
  else if (myTurn) msg = s.drawn != null ? "You drew a playable card — play it or press Pass." : (s.playable.length ? "Your turn — play a highlighted card or draw." : "Your turn — no playable card, draw from the pile.");
  else msg = (curPlayer ? curPlayer.name : "?") + "'s turn…";
  $("message").textContent = msg;

  $("passBtn").disabled = !(myTurn && s.drawn != null);
  const canUno = s.seated && !s.over && me && me.count > 0 && me.count <= 2;
  $("unoBtn").disabled = !canUno;
  $("unoBtn").classList.toggle("pulse", canUno && me.count === 1);
  $("catchBtn").classList.toggle("hidden", !s.canCatch);

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
    const isHost = s.you === s.host;
    $("playAgain").classList.toggle("hidden", !isHost);
    $("endHint").textContent = isHost ? "" : "Waiting for the admin to start the next game…";
    end.classList.remove("hidden");
  } else {
    end.classList.add("hidden");
  }
}

/* ---------- actions ---------- */

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
$("playAgain").addEventListener("click", () => send({ op: "start" }));
$("drawPile").addEventListener("click", () => send({ op: "draw" }));
$("passBtn").addEventListener("click", () => send({ op: "pass" }));
$("unoBtn").addEventListener("click", () => send({ op: "uno" }));
$("catchBtn").addEventListener("click", () => send({ op: "catch" }));
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
