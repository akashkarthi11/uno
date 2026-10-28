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
  btn.classList.toggle("on", voice.active);
  btn.textContent = "🎤";
  btn.title = voice.active ? "Leave voice" : "Join voice" + (voice.members.length ? " (" + voice.members.length + " in voice)" : "");
  btn.dataset.count = String(voice.members.length);
  $("muteBtn").classList.toggle("hidden", !voice.active);
  $("muteBtn").textContent = voice.muted ? "🔇" : "🎙";
  $("muteBtn").title = voice.muted ? "Unmute" : "Mute";
}

async function voiceJoin() {
  if (voice.active) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("This browser can't use the microphone here.");
    return;
  }
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    toast("Microphone blocked — allow it in the browser to join voice.");
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
  voice.ctx = new (window.AudioContext || window.webkitAudioContext)();
  addMeter(state.you, voice.stream);
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
  paintSpeaking();
}

/* ---------- peers ---------- */

function createPeer(id, initiator) {
  closePeer(id);
  const pc = new RTCPeerConnection({ iceServers: voice.ice });
  const peer = { pc, queue: [], audio: null };
  voice.peers.set(id, peer);
  voice.stream.getTracks().forEach((t) => pc.addTrack(t, voice.stream));
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal(id, "ice", e.candidate.toJSON()); };
  pc.ontrack = (e) => attachRemote(id, peer, e.streams[0]);
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

$("voiceBtn").addEventListener("click", () => {
  if (voice.active) return voiceLeave();
  session(voiceOffKey(), null);
  return voiceJoin();
});
$("muteBtn").addEventListener("click", toggleMute);
