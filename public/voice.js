"use strict";
/*
 * Voice chat: browser-to-browser audio (WebRTC, one connection per pair of people).
 * The game server only passes the small set-up messages; the audio never goes through it.
 * The admin and private players can use it, and public players too while the admin has "Public voice" on; the server enforces that (state.canVoice).
 * Uses $, api, send, state and toast from app.js.
 */

const voice = {
  active: false,
  muted: false,
  mic: false, // my microphone is on (it and the camera are independent: either one alone puts me in the call)
  cam: false,
  stream: null,
  peers: new Map(), // playerId -> { pc, queue, audio }
  members: [],
  ice: [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }],
  timer: null,
  ctx: null,
  meters: new Map(), // playerId -> { analyser, buf }
  speaking: new Set(),
  meterTimer: null,
};

// Voice starts by itself for everyone allowed to use it. Leaving voice yourself is remembered for this tab, so a
// refresh does not pull you back in; the button joins again. If the microphone is refused we ask only once.
let autoJoinTried = false;
const voiceOffKey = () => "uno-voice-off-" + room;

/** Called by app.js whenever a fresh game state arrives. */
function voiceSync(s) {
  const btn = $("voiceBtn");
  btn.classList.toggle("hidden", !s.canVoice);
  if (!s.canVoice) {
    if (voice.active) voiceStopLocal();
    $("muteBtn").classList.add("hidden");
    $("camBtn").classList.add("hidden");
    autoJoinTried = false; // allowed again later (e.g. the room became private): join then
    return;
  }
  if (!voice.active && !autoJoinTried && !session(voiceOffKey())) {
    autoJoinTried = true;
    voiceJoin();
  }
  if (s.iceServers) voice.ice = s.iceServers;
  const relayNow = Boolean(s.settings && s.settings.voiceRelay);
  if (voice.active && voice.relay !== undefined && voice.relay !== relayNow) {
    // The admin switched the route. Turning the relay on only helps pairs that are not connected; turning it off starts
    // every pair over so no call keeps going through the relay.
    for (const [id, p] of [...voice.peers]) {
      if (!relayNow || p.pc.connectionState !== "connected") rebuildPeer(id, true);
    }
  }
  voice.relay = relayNow;
  const before = new Set(voice.members);
  voice.members = s.voice || [];
  if (voice.active) {
    if (!voice.members.includes(s.you)) {
      rejoinVoice(); // dropped by the server (e.g. the phone slept): step back in with the same microphone
    } else {
      for (const id of [...voice.peers.keys()]) if (!voice.members.includes(id)) closePeer(id);
      if (voice.members.some((id) => !before.has(id))) pollSignals(); // someone new: look for their offer now
    }
  }
  btn.classList.toggle("on", voice.mic);
  btn.textContent = "🎤";
  btn.title = voice.mic ? "Turn microphone off" : "Turn microphone on" + (voice.members.length ? " (" + voice.members.length + " in the call)" : "");
  btn.dataset.count = String(voice.members.length);
  $("muteBtn").classList.toggle("hidden", !voice.mic);
  $("camBtn").classList.toggle("hidden", !s.canVoice || s.canVideo === false); // the mic button's permission, unless the admin hid public video
  if (s.canVideo === false && voice.active && voice.cam) toggleDevice("video"); // the admin switched public video off: the camera stops
  $("camBtn").classList.toggle("on", voice.cam);
  $("camBtn").title = voice.cam ? "Turn camera off" : "Turn camera on";
  $("muteBtn").textContent = voice.muted ? "🔇" : "🎙";
  $("muteBtn").title = voice.muted ? "Unmute" : "Mute";
}

const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const CAM = { width: 320, height: 240, frameRate: 15, facingMode: "user" }; // small and slow on purpose: every person you see is one more upload

/** Joins the call with a microphone, a camera, or both (opts.audio / opts.video); the automatic join uses the microphone only. */
async function voiceJoin(opts = { audio: true }) {
  if (voice.active) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("This browser can't use the microphone or camera here.");
    return;
  }
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: opts.audio ? MIC : false, video: opts.video ? CAM : false });
  } catch (e) {
    toast(opts.video && !opts.audio ? "Camera blocked — allow it in the browser to share video." : "Microphone blocked — allow it in the browser to join voice.");
    return;
  }
  await send({ op: "voiceJoin" });
  if (!state || !state.voice.includes(state.you)) {
    stopStream();
    setTimeout(() => { autoJoinTried = false; }, 3000); // maybe another request was still in flight: the next update tries again
    return; // the server refused (the error toast is already shown)
  }
  voice.active = true;
  voice.muted = false;
  voice.mic = Boolean(opts.audio);
  voice.cam = Boolean(opts.video);
  voice.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (voice.mic) addMeter(state.you, voice.stream);
  if (voice.cam) showTile(state.you, voice.stream, true);
  voice.meterTimer = setInterval(updateMeters, 200);
  // The newcomer starts the connection to everyone already in voice.
  for (const id of state.voice) if (id !== state.you) createPeer(id, true);
  sigLoop();
  voiceSync(state);
}

let rejoining = false;
/** The server forgot us after a long silence. Re-enter the voice list and reconnect to everyone, no new mic prompt. */
async function rejoinVoice() {
  if (rejoining || !voice.active || !voice.stream) return;
  rejoining = true;
  try {
    await api({ op: "voiceJoin" }).then((r) => { if (r.state) apply(r); });
    if (state && state.voice.includes(state.you)) {
      for (const id of state.voice) if (id !== state.you) createPeer(id, true);
      pollSignals();
    } else {
      voiceStopLocal();
    }
  } catch (e) {
    /* network is still down: the next state update tries again */
  }
  rejoining = false;
}

/** Phones pause audio when the screen sleeps or a tap hasn't happened yet; wake everything up. */
function unlockAudio() {
  if (!voice.active) return;
  if (voice.ctx && voice.ctx.state === "suspended") voice.ctx.resume().catch(() => {});
  for (const p of voice.peers.values()) if (p.audio && p.audio.paused) p.audio.play().catch(() => {});
}
["click", "touchstart", "keydown"].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !voice.active) return;
  unlockAudio();
  pollSignals();
  // a connection that died while the page was away is rebuilt
  for (const [id, p] of voice.peers) {
    if (["failed", "disconnected", "closed"].includes(p.pc.connectionState)) rebuildPeer(id);
  }
});
window.addEventListener("online", () => { if (voice.active) { unlockAudio(); pollSignals(); } });

async function voiceLeave() {
  session(voiceOffKey(), "1"); // the player chose to leave: no automatic re-join in this tab
  voiceStopLocal();
  await send({ op: "voiceLeave" });
  if (state) voiceSync(state);
}

function stopStream() {
  if (voice.stream) voice.stream.getTracks().forEach((t) => t.stop());
  voice.stream = null;
}

function voiceStopLocal() {
  clearTimeout(voice.timer);
  clearInterval(voice.meterTimer);
  for (const id of [...voice.peers.keys()]) closePeer(id);
  stopStream();
  if (voice.ctx) voice.ctx.close().catch(() => {});
  voice.ctx = null;
  voice.meters.clear();
  voice.speaking.clear();
  voice.active = false;
  voice.mic = false;
  voice.cam = false;
  $("vTiles").textContent = "";
  tileState.clear();
  updateVideoChip();
  paintSpeaking();
}

/* ---------- peers ---------- */

function createPeer(id, initiator) {
  closePeer(id);
  const pc = new RTCPeerConnection({ iceServers: voice.ice });
  const peer = { pc, queue: [], audio: null };
  voice.peers.set(id, peer);
  voice.stream.getTracks().forEach((t) => pc.addTrack(t, voice.stream));
  // someone with only a microphone still has to receive the other person's camera, and the other way round
  for (const kind of ["audio", "video"]) if (!voice.stream.getTracks().some((t) => t.kind === kind)) pc.addTransceiver(kind, { direction: "recvonly" });
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal(id, "ice", e.candidate.toJSON()); };
  pc.ontrack = (e) => {
    attachRemote(id, peer, e.streams[0]);
    if (e.track.kind === "video") showTile(id, e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    clearTimeout(peer.fix);
    if (pc.connectionState === "failed") rebuildPeer(id);
    // "disconnected" often heals by itself; give it a few seconds, then start over
    else if (pc.connectionState === "disconnected") peer.fix = setTimeout(() => rebuildPeer(id), 4000);
  };
  if (initiator) {
    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(id, "offer", pc.localDescription.toJSON());
    })().catch(() => {});
  }
  return peer;
}

/**
 * Start a broken pairing over. Only the person with the smaller id sends the new offer, so the two sides never
 * both offer at the same moment; the other side answers when it arrives.
 */
function rebuildPeer(id, force) {
  if (!voice.active || !voice.stream || !state || !voice.members.includes(id)) return;
  const peer = voice.peers.get(id);
  if (!force && peer && ["connected", "connecting", "new"].includes(peer.pc.connectionState) && peer.pc.iceConnectionState !== "disconnected") return;
  if (state.you < id) createPeer(id, true);
  else closePeer(id); // wait for their offer
}

function closePeer(id) {
  const peer = voice.peers.get(id);
  if (!peer) return;
  clearTimeout(peer.fix);
  try { peer.pc.close(); } catch (e) { /* ignore */ }
  if (peer.audio) peer.audio.remove();
  removeTile(id);
  voice.meters.delete(id);
  voice.speaking.delete(id);
  voice.peers.delete(id);
}

function attachRemote(id, peer, stream) {
  if (!peer.audio) {
    peer.audio = document.createElement("audio");
    peer.audio.autoplay = true;
    peer.audio.playsInline = true;
    document.body.appendChild(peer.audio);
  }
  peer.audio.srcObject = stream;
  peer.audio.play().catch(() => {});
  if (voice.ctx) addMeter(id, stream);
}

async function flushQueue(peer) {
  const queued = peer.queue.splice(0);
  for (const c of queued) await peer.pc.addIceCandidate(c).catch(() => {});
}

async function handleSignal(m) {
  if (!voice.active) return;
  if (m.kind === "offer") {
    // both sides offered at once (both switched the camera together): the smaller id keeps its offer, the other answers it
    const mine = voice.peers.get(m.from);
    if (mine && mine.pc.signalingState === "have-local-offer" && state && state.you < m.from) return;
    const peer = createPeer(m.from, false); // a fresh connection for someone (re)joining
    await peer.pc.setRemoteDescription(m.data);
    await flushQueue(peer);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    sendSignal(m.from, "answer", peer.pc.localDescription.toJSON());
    return;
  }
  const peer = voice.peers.get(m.from);
  if (!peer) return;
  if (m.kind === "answer") {
    await peer.pc.setRemoteDescription(m.data);
    await flushQueue(peer);
  } else if (m.kind === "ice") {
    if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(m.data).catch(() => {});
    else peer.queue.push(m.data);
  }
}

/* ---------- signalling through the game server ---------- */

function sendSignal(to, kind, data) {
  api({ op: "signal", to, kind, data }).catch(() => {});
}

let sigBusy = false;
async function sigLoop() {
  if (!voice.active || sigBusy) return;
  sigBusy = true;
  try {
    const r = await api({ op: "signals" });
    for (const m of r.signals || []) {
      try { await handleSignal(m); } catch (e) { /* one bad message must not stop the rest */ }
    }
  } catch (e) { /* retry on the next round */ }
  sigBusy = false;
  if (!voice.active) return;
  // poll quickly while connections are being made, slowly once everyone is connected
  // Alone in voice, or everyone connected: look rarely (a new arrival triggers an immediate look anyway).
  const alone = voice.members.filter((id) => id !== (state && state.you)).length === 0;
  const settled = alone || (voice.peers.size > 0 && [...voice.peers.values()].every((p) => p.pc.connectionState === "connected"));
  voice.timer = setTimeout(sigLoop, settled ? 5000 : 400); // quick while connections are being made
}

function pollSignals() {
  clearTimeout(voice.timer);
  sigLoop();
}

/* ---------- mute + who is speaking ---------- */

function toggleMute() {
  if (!voice.active || !voice.stream) return;
  voice.muted = !voice.muted;
  voice.stream.getAudioTracks().forEach((t) => { t.enabled = !voice.muted; });
  if (state) voiceSync(state);
}

/* ---------- camera (optional, only while in voice) ---------- */

/**
 * Video tiles. Each one first sits on the board next to its player's cards (an opponent's seat; my own just above my hand).
 * Drag a tile and it floats wherever you drop it (📌 puts it back by the seat); tap it to make it big or small; ✕ hides it
 * on your screen and the 📹 chip brings hidden ones back (or folds them all away). Your own tile has a 🔄 flip button for
 * the front / back camera. A green ring shows who is talking; a spinner shows until the picture arrives.
 * Seats are redrawn on every update, so tiles live in their own layer and are placed over the seat by layoutTiles().
 */
let facing = "user";
const tileState = new Map(); // playerId -> { floating, left, top, hidden } (kept when a tile is rebuilt)
const tileOf = (id) => $("vTiles").querySelector('[data-vid="' + CSS.escape(id) + '"]');

function updateVideoChip() {
  const tiles = [...$("vTiles").children];
  const hiddenN = tiles.filter((x) => x.classList.contains("gone")).length;
  const chip = $("vToggle");
  chip.classList.toggle("hidden", tiles.length === 0);
  const folded = $("videoStrip").classList.contains("collapsed");
  chip.textContent = folded || hiddenN ? "📹 " + (tiles.length - (folded ? 0 : hiddenN)) + "/" + tiles.length + " ▾" : "📹 ▴";
}

function showTile(id, stream, self) {
  removeTile(id, true);
  const st = tileState.get(id) || { floating: false, hidden: false };
  tileState.set(id, st);
  const tile = document.createElement("div");
  tile.className = "vtile loading" + (self ? " self" : "") + (self && facing === "environment" ? " back" : "") + (st.hidden ? " gone" : "") + (st.floating ? " floating" : "");
  tile.dataset.vid = id;
  tile.dataset.pid = id; // so the speaking ring (paintSpeaking) lands on it too
  const v = document.createElement("video");
  v.autoplay = true;
  v.playsInline = true;
  v.muted = true; // the sound already plays through the audio element
  v.srcObject = new MediaStream(stream.getVideoTracks());
  v.addEventListener("playing", () => tile.classList.remove("loading"));
  v.play().catch(() => {});
  const p = state && state.players.find((x) => x.id === id);
  const name = document.createElement("span");
  name.className = "vname";
  name.textContent = self ? "You" : (p ? p.name : "");
  const ctl = document.createElement("div");
  ctl.className = "vctl";
  ctl.addEventListener("pointerdown", (e) => e.stopPropagation()); // a button press is not a drag or an enlarge
  const btn = (cls, title, text, fn) => {
    const x = document.createElement("button");
    x.type = "button";
    x.className = cls;
    x.title = title;
    x.textContent = text;
    x.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    ctl.appendChild(x);
  };
  btn("vhide", "Hide this video", "✕", () => { st.hidden = true; tile.classList.add("gone"); updateVideoChip(); });
  btn("vdock", "Put back by the seat", "📌", () => { st.floating = false; tile.classList.remove("floating"); layoutTiles(); });
  if (self) btn("vflip", "Switch camera", "🔄", flipCamera);
  tile.append(v, name, ctl);
  enableTileDrag(tile, st);
  $("vTiles").appendChild(tile);
  updateVideoChip();
  layoutTiles();
}

function removeTile(id, keepState) {
  const t = tileOf(id);
  if (t) t.remove();
  if (!keepState) tileState.delete(id);
  updateVideoChip();
}

/** Puts every tile where it belongs: floating ones where they were dropped, the rest by their player's seat. */
function layoutTiles() {
  const tiles = [...$("vTiles").children];
  if (!tiles.length) return;
  const W = window.innerWidth, H = window.innerHeight;
  let spare = 0; // tiles with no seat on screen (the lobby) stack down the right edge
  for (const tile of tiles) {
    const st = tileState.get(tile.dataset.vid) || {};
    const w = tile.offsetWidth, h = tile.offsetHeight;
    let left, top;
    if (st.floating && st.left !== undefined) {
      left = st.left; top = st.top;
    } else {
      const self = tile.classList.contains("self");
      const seat = self ? ($("game").classList.contains("hidden") ? null : $("handWrap")) : document.querySelector('#opponents [data-pid="' + CSS.escape(tile.dataset.vid) + '"]');
      const r = seat && seat.getBoundingClientRect();
      if (r && r.width) {
        left = self ? r.left + 8 : r.left + r.width / 2 - w / 2;
        top = r.top - h - 4;
        if (top < 2) top = r.bottom + 4; // no room above the seat: below it
      } else {
        left = W - w - 8; top = 100 + spare * (h + 8); spare++;
      }
    }
    tile.style.left = Math.max(0, Math.min(W - w, left)) + "px";
    tile.style.top = Math.max(0, Math.min(H - h, top)) + "px";
  }
}
window.addEventListener("resize", layoutTiles);
setInterval(layoutTiles, 500); // seats move when the table changes; a cheap check keeps the tiles with them

function enableTileDrag(tile, st) {
  let drag = null;
  tile.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, left: tile.offsetLeft, top: tile.offsetTop, moved: false };
    tile.setPointerCapture(e.pointerId);
  });
  tile.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    st.floating = true; // dropped somewhere of your choosing: it stays there
    tile.classList.add("floating");
    st.left = Math.max(0, Math.min(window.innerWidth - tile.offsetWidth, drag.left + dx));
    st.top = Math.max(0, Math.min(window.innerHeight - tile.offsetHeight, drag.top + dy));
    layoutTiles();
  });
  tile.addEventListener("pointerup", () => {
    if (drag && !drag.moved) {
      const big = !tile.classList.contains("big");
      $("vTiles").querySelectorAll(".big").forEach((x) => x.classList.remove("big"));
      tile.classList.toggle("big", big);
      layoutTiles();
    }
    drag = null;
  });
  tile.addEventListener("pointercancel", () => { drag = null; });
}

$("vToggle").addEventListener("click", () => {
  const gone = [...$("vTiles").children].filter((x) => x.classList.contains("gone"));
  if (gone.length && !$("videoStrip").classList.contains("collapsed")) { // first bring hidden ones back
    gone.forEach((x) => { x.classList.remove("gone"); (tileState.get(x.dataset.vid) || {}).hidden = false; });
  } else {
    $("videoStrip").classList.toggle("collapsed");
  }
  updateVideoChip();
  layoutTiles();
});

/** Front / back camera: the new picture replaces the old one on every connection, nobody has to reconnect. */
async function flipCamera() {
  if (!voice.cam || !voice.stream) return;
  const next = facing === "user" ? "environment" : "user";
  let track;
  try {
    track = (await navigator.mediaDevices.getUserMedia({ video: { ...CAM, facingMode: { ideal: next } } })).getVideoTracks()[0];
  } catch (e) {
    toast("This device has no other camera.");
    return;
  }
  facing = next;
  voice.stream.getVideoTracks().forEach((o) => { o.stop(); voice.stream.removeTrack(o); });
  voice.stream.addTrack(track);
  for (const peer of voice.peers.values()) {
    const sender = peer.pc.getSenders().find((x) => x.track && x.track.kind === "video");
    if (sender) sender.replaceTrack(track).catch(() => {});
  }
  showTile(state.you, voice.stream, true); // a back camera is not mirrored (the tile gets the "back" class)
}

/** The microphone and the camera are switched on and off separately; the call is left when both are off. */
async function toggleDevice(kind) {
  const audio = kind === "audio";
  if (!voice.active) {
    session(voiceOffKey(), null);
    return voiceJoin(audio ? { audio: true } : { video: true });
  }
  if (!voice.stream) return;
  const on = audio ? voice.mic : voice.cam;
  if (on) {
    (audio ? voice.stream.getAudioTracks() : voice.stream.getVideoTracks()).forEach((t) => { t.stop(); voice.stream.removeTrack(t); });
    if (audio) { voice.mic = false; voice.muted = false; voice.meters.delete(state.you); voice.speaking.delete(state.you); }
    else { voice.cam = false; removeTile(state.you); }
    if (!voice.mic && !voice.cam) return voiceLeave();
  } else {
    try {
      const got = await navigator.mediaDevices.getUserMedia(audio ? { audio: MIC } : { video: CAM });
      voice.stream.addTrack(got.getTracks()[0]);
    } catch (e) {
      toast(audio ? "Microphone blocked — allow it in the browser." : "Camera blocked — allow it in the browser to share video.");
      return;
    }
    if (audio) { voice.mic = true; voice.muted = false; addMeter(state.you, voice.stream); }
    else { voice.cam = true; showTile(state.you, voice.stream, true); }
  }
  // start every pairing over with the new set of tracks (the other side builds a fresh connection when the offer arrives)
  for (const id of [...voice.peers.keys()]) createPeer(id, true);
  voiceSync(state);
}

function addMeter(id, stream) {
  try {
    const analyser = voice.ctx.createAnalyser();
    analyser.fftSize = 256;
    voice.ctx.createMediaStreamSource(stream).connect(analyser);
    voice.meters.set(id, { analyser, buf: new Uint8Array(analyser.fftSize) });
  } catch (e) { /* speaking indicator is optional */ }
}

function updateMeters() {
  voice.speaking.clear();
  for (const [id, m] of voice.meters) {
    if (state && id === state.you && voice.muted) continue;
    m.analyser.getByteTimeDomainData(m.buf);
    let sum = 0;
    for (const v of m.buf) sum += (v - 128) * (v - 128);
    if (Math.sqrt(sum / m.buf.length) > 6) voice.speaking.add(id);
  }
  paintSpeaking();
}

function paintSpeaking() {
  document.querySelectorAll("[data-pid]").forEach((el) => el.classList.toggle("speaking", voice.speaking.has(el.dataset.pid)));
  $("voiceBtn").classList.toggle("speaking", Boolean(state && voice.speaking.has(state.you)));
}

$("voiceBtn").addEventListener("click", () => toggleDevice("audio"));
$("muteBtn").addEventListener("click", toggleMute);
$("camBtn").addEventListener("click", () => toggleDevice("video"));
