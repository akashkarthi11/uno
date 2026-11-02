/* 3D duel: two players, third-person, one arena, one rifle, first to 5 kills.
   The server only carries the invite and the connection set-up (ops duelStart / duelEnd / duelSignal / duelSignals).
   The match itself runs between the two browsers over a WebRTC data channel; each browser is the referee for its own player
   (position, health), so it suits friends, not ranked play. Needs app.js first (api, state, room, playerId, toast, $). */
"use strict";

const DUEL_THREE = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
const DUEL_WIN = 5, DUEL_HP = 100, DUEL_BODY = 25, DUEL_HEAD = 40, DUEL_FIRE_MS = 110, DUEL_RESPAWN_MS = 2200, DUEL_SAFE_MS = 1500;
const DUEL_MAG = 30, DUEL_RELOAD_MS = 1700, DUEL_JUMP = 8.5, DUEL_GRAV = 22, DUEL_WALK = 6, DUEL_RUN = 9.5;
const DUEL_HALF = 30; // the arena is 60 x 60
// cover: x, z, width, depth, height, kind (k container, c crate, w wall, t tree)
const DUEL_BOXES = [[0, 0, 6, 6, 3, "k"], [-15, -12, 8, 2, 2.5, "w"], [15, 12, 8, 2, 2.5, "w"], [-14, 14, 2, 8, 2.5, "k"], [14, -14, 2, 8, 2.5, "k"],
  [0, -20, 10, 2, 2, "w"], [0, 20, 10, 2, 2, "w"], [-22, 0, 2, 6, 2, "k"], [22, 0, 2, 6, 2, "k"], [-8, 8, 3, 3, 1.4, "c"], [8, -8, 3, 3, 1.4, "c"],
  [4, 10, 1.6, 1.6, 1.2, "c"], [-4, -10, 1.6, 1.6, 1.2, "c"], [-8, -20, 1.5, 1.5, 1.2, "c"], [8, 20, 1.5, 1.5, 1.2, "c"],
  [-6, -14, 1, 1, 6, "t"], [6, 14, 1, 1, 6, "t"], [-18, -4, 1, 1, 6, "t"], [18, 4, 1, 1, 6, "t"], [-26, 6, 1, 1, 6, "t"], [26, -6, 1, 1, 6, "t"],
  [-10, 24, 1, 1, 6, "t"], [10, -24, 1, 1, 6, "t"], [-24, -14, 1, 1, 6, "t"], [24, 14, 1, 1, 6, "t"]];
const DUEL_SPAWNS = [[-25, -25], [25, 25], [-25, 25], [25, -25]];
const DUEL_STUN = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
const DUEL_TEAMS = [ // the host is the navy team, the guest the desert team
  { shirt: 0x2f3f5f, vest: 0x25324a, pants: 0x2a3550, helmet: 0x34476b, pack: 0x1f2b42, band: 0x4da3ff },
  { shirt: 0xb69c68, vest: 0x8f7b4e, pants: 0x9d8758, helmet: 0xa38d5b, pack: 0x7b6a43, band: 0xff8a3d },
];

let duel = null; // the running match, or null
let duelInviteSeen = 0;

/** Called by app.js with every new room state: shows the lobby button and tells about an invite. */
function duelSync(s) {
  let b = document.getElementById("duelBtn");
  if (!b) {
    b = document.createElement("button");
    b.id = "duelBtn";
    b.type = "button";
    b.className = "ghost hidden";
    b.addEventListener("click", duelClick);
    document.getElementById("botBtn").after(b);
  }
  const invited = s.duel && s.duel.by !== s.you;
  b.classList.toggle("hidden", !s.canDuel || Boolean(duel));
  b.textContent = invited ? "🎯 Join 3D duel from " + (s.duel.byName || "your opponent") : "🎯 3D duel";
  b.classList.toggle("on", Boolean(invited));
  if (invited && s.duel.by !== duelInviteSeen) { duelInviteSeen = s.duel.by; toast((s.duel.byName || "Your opponent") + " invites you to a 3D duel."); }
  if (!s.duel) duelInviteSeen = 0;
}

async function duelClick() {
  if (duel || !state) return;
  const guest = Boolean(state.duel && state.duel.by !== state.you);
  const other = (state.players || []).find((p) => p.id !== state.you);
  if (!other) { toast("A 3D duel needs exactly two players in the room."); return; }
  try {
    if (!guest) await api({ op: "duelStart" });
    duelOpen({ host: !guest, oppId: guest ? state.duel.by : other.id, oppName: guest ? state.duel.byName || other.name : other.name });
  } catch (e) { toast(e.message); }
}

function duelLoadThree() {
  if (window.THREE) return Promise.resolve();
  return new Promise((ok, no) => {
    const el = document.createElement("script");
    el.src = DUEL_THREE;
    el.onload = ok;
    el.onerror = () => no(new Error("The 3D engine could not be loaded. Check your connection."));
    document.head.appendChild(el);
  });
}

const duelPref = (k, def) => { try { const v = localStorage.getItem("duel-" + k); return v === null ? def : v; } catch (e) { return def; } };
const duelSetPref = (k, v) => { try { localStorage.setItem("duel-" + k, String(v)); } catch (e) { /* not available */ } };

/** Opens the match. `solo` (tests only) runs the arena with a still dummy and no connection. */
async function duelOpen({ host, oppId, oppName, solo }) {
  if (duel) return;
  const d = duel = {
    host, oppId, oppName: oppName || "Opponent", solo: Boolean(solo), closed: false,
    me: { x: 0, y: 0, z: 0, vy: 0, yaw: 0, el: -0.2, hp: DUEL_HP, dead: false, safeUntil: 0, moving: false, speed: 0, ammo: DUEL_MAG, reloadUntil: 0, grounded: true, phase: 0 },
    opp: { x: 0, y: 0, z: 0, yaw: 0, tx: 0, ty: 0, tz: 0, tyaw: 0, hp: DUEL_HP, dead: false, seen: false, speed: 0, phase: 0 },
    kills: 0, deaths: 0, over: false, rematch: [false, false], keys: {}, fireDown: false, lastShot: 0, lastSend: 0, lastHeadHit: false,
    joy: null, look: null, tracers: [], status: "Loading the arena…", pc: null, sid: "", chFast: null, chSafe: null,
    connected: false, relayTried: false, startedAt: 0, queue: [], timers: [], listeners: [], flash: 0, marker: 0, kick: 0, fov: 65,
    sens: Number(duelPref("sens", 1)) || 1, sound: duelPref("snd", "1") === "1", sprintTouch: false, jumpTouch: false, ammoShown: -1, lastMsg: "",
  };
  duelBuildUi(d);
  try { await duelLoadThree(); } catch (e) { toast(e.message); duelClose(); return; }
  if (d.closed) return;
  try { duelBuildWorld(d); } catch (e) { toast("This browser could not start 3D graphics, so the duel cannot open."); duelClose(true); return; }
  duelSpawn(d, host ? 0 : 1);
  d.opp.x = d.opp.tx = DUEL_SPAWNS[host ? 1 : 0][0];
  d.opp.z = d.opp.tz = DUEL_SPAWNS[host ? 1 : 0][1];
  try { d.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { d.audio = null; }
  duelBind(d);
  d.last = performance.now();
  d.raf = requestAnimationFrame((t) => duelFrame(d, t));
  if (d.solo) { d.status = ""; d.connected = true; } else { await duelStartMic(d); if (!d.closed) duelConnect(d); }
  duelHud(d);
}

/* ---------------- screen ---------------- */

function duelBuildUi(d) {
  const root = document.createElement("div");
  root.id = "duel";
  root.innerHTML =
    '<canvas id="duelCanvas"></canvas>' +
    '<div id="duelDmg"></div><div id="duelFlash"></div><div id="duelLow"></div>' +
    '<div class="duel-top"><canvas id="duelMap" width="120" height="120"></canvas><div id="duelScore"></div>' +
    '<div class="duel-btns"><button id="duelMic" type="button" aria-label="Microphone">🎤</button><button id="duelGear" type="button" aria-label="Settings">⚙</button><button id="duelLeave" type="button">✕</button></div></div>' +
    '<div id="duelSet" class="hidden"><label>Sensitivity <input id="duelSens" type="range" min="0.4" max="2.2" step="0.1"></label>' +
    '<label class="duel-chk"><input id="duelSnd" type="checkbox"> Sound</label></div>' +
    '<ul id="duelFeed"></ul>' +
    '<div id="duelCross"><i></i><i></i><i></i><i></i></div><div id="duelHit"></div>' +
    '<div id="duelMsg"></div>' +
    '<div class="duel-hp"><div class="duel-hp-top"><b>HP</b><span id="duelHpTxt"></span></div><div class="duel-hp-bar"><div id="duelHpBar"></div></div></div>' +
    '<div class="duel-ammo"><span id="duelAmmo"></span><small id="duelAmmoHint"></small><div class="duel-rel"><div id="duelRelBar"></div></div></div>' +
    '<button id="duelFire" type="button" aria-label="Fire">🔫</button>' +
    '<button id="duelJump" type="button" aria-label="Jump">⤒</button>' +
    '<button id="duelReload" type="button" aria-label="Reload">⟳</button>' +
    '<div id="duelStick"><i></i></div>' +
    '<div id="duelOver" class="hidden"><h2 id="duelOverTitle"></h2><p id="duelOverSub"></p>' +
    '<button id="duelAgain" type="button">Rematch</button><button id="duelOut" type="button" class="ghost">Back to lobby</button></div>' +
    '<div id="duelHelp">WASD move · Shift run · Space jump · R reload · click to shoot · Esc frees the mouse</div>';
  document.body.appendChild(root);
  d.root = root;
  d.touch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  root.classList.toggle("touch", d.touch);
  d.map = root.querySelector("#duelMap").getContext("2d");
  const q = (id) => root.querySelector(id);
  q("#duelLeave").addEventListener("click", () => duelClose(true));
  q("#duelOut").addEventListener("click", () => duelClose(true));
  q("#duelMic").addEventListener("click", () => {
    if (!d.mic) { toast("Microphone not allowed. Allow it in the browser, then reopen the duel."); return; }
    d.micOn = !d.micOn;
    d.mic.getAudioTracks().forEach((tr) => { tr.enabled = d.micOn; });
    duelMicHud(d);
  });
  q("#duelGear").addEventListener("click", () => q("#duelSet").classList.toggle("hidden"));
  q("#duelSens").value = d.sens;
  q("#duelSens").addEventListener("input", (e) => { d.sens = Number(e.target.value) || 1; duelSetPref("sens", d.sens); });
  q("#duelSnd").checked = d.sound;
  q("#duelSnd").addEventListener("change", (e) => { d.sound = e.target.checked; duelSetPref("snd", d.sound ? "1" : "0"); });
  q("#duelAgain").addEventListener("click", () => {
    d.rematch[0] = true;
    duelSend(d, "safe", { t: "rematch" });
    d.status = "Waiting for " + d.oppName + "…";
    duelRematchCheck(d);
    duelHud(d);
  });
}

function duelHud(d) {
  const r = d.root;
  if (!r) return;
  r.querySelector("#duelScore").innerHTML = '<span class="me">You</span> <b>' + d.kills + '</b><em>–</em><b>' + d.deaths + '</b> <span class="op"></span><small>first to ' + DUEL_WIN + "</small>";
  r.querySelector("#duelScore .op").textContent = d.oppName;
  const hp = Math.max(0, Math.round(d.me.hp));
  const bar = r.querySelector("#duelHpBar");
  bar.style.width = hp + "%";
  bar.style.background = hp > 50 ? "#7ddc5a" : hp > 25 ? "#f0c030" : "#ef4444";
  r.querySelector("#duelHpTxt").textContent = hp;
  r.querySelector("#duelLow").style.opacity = hp > 0 && hp <= 30 ? 1 : 0;
  const m = r.querySelector("#duelMsg");
  const txt = d.me.dead && !d.over ? "Eliminated — back in a moment…" : d.status;
  if (txt !== d.lastMsg) { m.textContent = txt; d.lastMsg = txt; }
  m.classList.toggle("hidden", !txt);
  const o = r.querySelector("#duelOver");
  o.classList.toggle("hidden", !d.over);
  if (d.over) {
    const won = d.kills >= DUEL_WIN;
    r.querySelector("#duelOverTitle").textContent = won ? "🏆 WINNER WINNER" : d.oppName + " wins";
    r.querySelector("#duelOverSub").textContent = d.kills + " – " + d.deaths + (d.rematch[0] ? "  ·  waiting for " + d.oppName + " to accept the rematch" : "");
    r.querySelector("#duelAgain").disabled = d.rematch[0] || !d.connected;
  }
}

function duelAmmoHud(d, now) {
  const me = d.me, reloading = now < me.reloadUntil;
  const key = reloading ? -1 : me.ammo;
  const bar = d.root.querySelector("#duelRelBar");
  if (reloading) bar.style.width = (100 - ((me.reloadUntil - now) / DUEL_RELOAD_MS) * 100) + "%";
  else if (d.ammoShown === -1 || bar.style.width !== "0%") bar.style.width = "0%";
  if (key === d.ammoShown) return;
  d.ammoShown = key;
  d.root.querySelector("#duelAmmo").innerHTML = "<b>" + me.ammo + "</b> / " + DUEL_MAG;
  d.root.querySelector("#duelAmmoHint").textContent = reloading ? "Reloading…" : me.ammo === 0 ? "Empty — reload" : me.ammo <= 8 ? "Low" : "";
}

function duelFeed(d, html, cls) {
  const ul = d.root && d.root.querySelector("#duelFeed");
  if (!ul) return;
  const li = document.createElement("li");
  li.className = cls || "";
  li.innerHTML = html;
  ul.prepend(li);
  while (ul.children.length > 4) ul.lastChild.remove();
  d.timers.push(setTimeout(() => li.remove(), 5000));
}

function duelClose(tell) {
  const d = duel;
  if (!d) return;
  d.closed = true;
  duel = null;
  if (tell && !d.solo) { duelSend(d, "safe", { t: "bye" }); if (d.host) api({ op: "duelEnd" }).catch(() => {}); }
  cancelAnimationFrame(d.raf);
  d.timers.forEach(clearInterval);
  d.timers.forEach(clearTimeout);
  for (const [t, ev, fn, opt] of d.listeners) t.removeEventListener(ev, fn, opt);
  try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) { /* ignore */ }
  try { if (d.pc) d.pc.close(); } catch (e) { /* ignore */ }
  try { if (d.mic) d.mic.getTracks().forEach((tr) => tr.stop()); } catch (e) { /* ignore */ }
  try { if (d.renderer) { d.renderer.dispose(); } } catch (e) { /* ignore */ }
  try { if (d.audio) d.audio.close(); } catch (e) { /* ignore */ }
  if (d.root) d.root.remove();
  if (state) duelSync(state);
}

/* ---------------- voice (the same direct connection carries it) ---------------- */

async function duelStartMic(d) {
  try {
    d.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    d.micOn = true;
    if (d.closed) d.mic.getTracks().forEach((tr) => tr.stop());
  } catch (e) {
    d.mic = null;
    d.micOn = false;
    toast("The microphone is off. Allow it in the browser to talk during the duel.");
  }
  duelMicHud(d);
}

function duelMicHud(d) {
  const b = d.root && d.root.querySelector("#duelMic");
  if (!b) return;
  b.textContent = d.micOn ? "🎤" : "🔇";
  b.classList.toggle("off", !d.micOn);
  b.title = d.micOn ? "Mute your microphone" : d.mic ? "Unmute your microphone" : "Microphone not allowed";
}

/** The other player's voice: played from an audio element; a level meter lights their name while they talk. */
function duelRemoteVoice(d, stream) {
  let a = d.remoteAudio;
  if (!a) { a = d.remoteAudio = document.createElement("audio"); a.autoplay = true; a.playsInline = true; d.root.appendChild(a); }
  a.srcObject = stream;
  a.play().catch(() => {});
  try {
    if (d.audio && !d.meter) {
      const src = d.audio.createMediaStreamSource(stream), an = d.audio.createAnalyser();
      an.fftSize = 256;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      d.meter = { an, buf };
    }
  } catch (e) { /* the name just will not light up */ }
}

function duelTalking(d) {
  const m = d.meter;
  if (!m) return;
  m.an.getByteTimeDomainData(m.buf);
  let peak = 0;
  for (let i = 0; i < m.buf.length; i++) peak = Math.max(peak, Math.abs(m.buf[i] - 128));
  const op = d.root.querySelector("#duelScore .op");
  if (op) op.classList.toggle("talk", peak > 14);
}

/* ---------------- sound (made in the browser, no files) ---------------- */

function duelSound(d, kind, vol) {
  const ac = d.audio;
  if (!ac || !d.sound || d.closed) return;
  try {
    if (ac.state === "suspended") ac.resume();
    const t = ac.currentTime, v = vol === undefined ? 1 : vol;
    const g = ac.createGain();
    g.connect(ac.destination);
    const noise = (len, f0, f1) => {
      const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * len), ac.sampleRate), ch = buf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length);
      const src = ac.createBufferSource(), fl = ac.createBiquadFilter();
      src.buffer = buf; fl.type = "lowpass"; fl.frequency.setValueAtTime(f0, t); fl.frequency.exponentialRampToValueAtTime(f1, t + len);
      src.connect(fl); fl.connect(g); src.start(t);
    };
    const tone = (type, f0, f1, len) => {
      const o = ac.createOscillator();
      o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + len);
      o.connect(g); o.start(t); o.stop(t + len);
    };
    if (kind === "shot") { g.gain.setValueAtTime(0.5 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.14); noise(0.14, 5000, 300); tone("sine", 140, 50, 0.1); }
    else if (kind === "hit") { g.gain.setValueAtTime(0.22 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08); tone("square", 900, 700, 0.08); }
    else if (kind === "head") { g.gain.setValueAtTime(0.25 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22); tone("triangle", 1500, 1900, 0.22); }
    else if (kind === "hurt") { g.gain.setValueAtTime(0.4 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18); tone("sine", 160, 60, 0.18); }
    else if (kind === "empty") { g.gain.setValueAtTime(0.18 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.04); noise(0.04, 3000, 1500); }
    else if (kind === "reload") { g.gain.setValueAtTime(0.25 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05); noise(0.05, 3500, 1200); d.timers.push(setTimeout(() => duelSound(d, "click"), 1100)); }
    else if (kind === "click") { g.gain.setValueAtTime(0.3 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.07); noise(0.07, 4000, 800); }
    else if (kind === "die") { g.gain.setValueAtTime(0.4 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.7); tone("sawtooth", 260, 40, 0.7); }
    else if (kind === "win") { g.gain.setValueAtTime(0.3 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.9); tone("triangle", 523, 1046, 0.9); }
  } catch (e) { /* sound is optional */ }
}

/* ---------------- the arena ---------------- */

/** A small painted texture (made on a canvas): `paint(ctx, size)` draws it. */
function duelTexture(T, size, paint, repeatX, repeatY) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  paint(c.getContext("2d"), size);
  const t = new T.CanvasTexture(c);
  t.wrapS = t.wrapT = T.RepeatWrapping;
  t.repeat.set(repeatX || 1, repeatY || repeatX || 1);
  return t;
}

function duelBuildWorld(d) {
  const T = window.THREE;
  const canvas = d.root.querySelector("#duelCanvas");
  const r = d.renderer = new T.WebGLRenderer({ canvas, antialias: !d.touch });
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, d.touch ? 1.5 : 2));
  const sc = d.scene = new T.Scene();
  const sky = duelTexture(T, 256, (x, s) => {
    const g = x.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0, "#3d7fd8"); g.addColorStop(0.55, "#9cc8f5"); g.addColorStop(1, "#e8f3ff");
    x.fillStyle = g; x.fillRect(0, 0, s, s);
    x.fillStyle = "rgba(255,255,255,.55)";
    for (let i = 0; i < 9; i++) { const cx = Math.random() * s, cy = 30 + Math.random() * 90; for (let k = 0; k < 5; k++) { x.beginPath(); x.ellipse(cx + k * 14 - 28, cy + Math.random() * 8, 22 + Math.random() * 12, 8 + Math.random() * 4, 0, 0, 6.3); x.fill(); } }
  });
  sky.wrapS = sky.wrapT = T.ClampToEdgeWrapping;
  sc.background = sky;
  sc.fog = new T.Fog(0xcfe4fa, 45, 125);
  sc.add(new T.HemisphereLight(0xdcecff, 0x58704a, 0.72));
  const sun = new T.DirectionalLight(0xfff1d6, 0.6);
  sun.position.set(30, 50, 20);
  sc.add(sun);
  d.cam = new T.PerspectiveCamera(65, 1, 0.1, 220);

  const grass = duelTexture(T, 256, (x, s) => {
    x.fillStyle = "#5e9a4c"; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) { x.fillStyle = ["#6cab58", "#4f8a40", "#76b560", "#548f45"][i % 4]; x.fillRect(Math.random() * s, Math.random() * s, 2, 3 + Math.random() * 3); }
  }, 14);
  const ground = new T.Mesh(new T.PlaneGeometry(DUEL_HALF * 2, DUEL_HALF * 2), new T.MeshLambertMaterial({ map: grass }));
  ground.rotation.x = -Math.PI / 2;
  sc.add(ground);
  const dirt = duelTexture(T, 128, (x, s) => { x.fillStyle = "#a08a64"; x.fillRect(0, 0, s, s); for (let i = 0; i < 500; i++) { x.fillStyle = i % 2 ? "#8f7a55" : "#b09a73"; x.fillRect(Math.random() * s, Math.random() * s, 3, 3); } }, 3, 1);
  const road = new T.Mesh(new T.PlaneGeometry(DUEL_HALF * 2, 5), new T.MeshLambertMaterial({ map: dirt }));
  road.rotation.x = -Math.PI / 2; road.position.y = 0.01;
  sc.add(road);
  const apron = new T.Mesh(new T.PlaneGeometry(400, 400), new T.MeshLambertMaterial({ color: 0x4a7a44 }));
  apron.rotation.x = -Math.PI / 2; apron.position.y = -0.05;
  sc.add(apron);

  const wood = duelTexture(T, 128, (x, s) => {
    x.fillStyle = "#b58a4f"; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? "#a47a43" : "#c09459"; x.fillRect(0, i * 16, s, 15); }
    x.strokeStyle = "#6e4f27"; x.lineWidth = 6; x.strokeRect(3, 3, s - 6, s - 6);
    x.beginPath(); x.moveTo(0, 0); x.lineTo(s, s); x.moveTo(s, 0); x.lineTo(0, s); x.stroke();
  });
  const concrete = duelTexture(T, 128, (x, s) => {
    x.fillStyle = "#8d9299"; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 700; i++) { x.fillStyle = i % 2 ? "#7c8188" : "#9ea3aa"; x.fillRect(Math.random() * s, Math.random() * s, 2 + Math.random() * 3, 2); }
    x.strokeStyle = "#6c7178"; x.lineWidth = 2; for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo(0, i * 32); x.lineTo(s, i * 32); x.stroke(); }
  });
  const container = (c1, c2) => duelTexture(T, 128, (x, s) => {
    x.fillStyle = c1; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 16; i++) { x.fillStyle = c2; x.fillRect(i * 8 + 2, 0, 3, s); }
    x.fillStyle = "rgba(255,255,255,.12)"; x.fillRect(0, 0, s, 10); x.fillStyle = "rgba(0,0,0,.25)"; x.fillRect(0, s - 8, s, 8);
  });
  const mats = {
    c: new T.MeshLambertMaterial({ map: wood }), w: new T.MeshLambertMaterial({ map: concrete }),
    k1: new T.MeshLambertMaterial({ map: container("#b34a3a", "#9a3d30") }), k2: new T.MeshLambertMaterial({ map: container("#3f6fa8", "#335d90") }),
  };
  d.solids = [];
  let kc = 0;
  DUEL_BOXES.forEach(([x, z, w, dp, h, kind]) => {
    if (kind === "t") {
      const tree = new T.Group();
      const trunk = new T.Mesh(new T.CylinderGeometry(0.28, 0.4, 3, 8), new T.MeshLambertMaterial({ color: 0x6b4a2b }));
      trunk.position.y = 1.5; tree.add(trunk);
      [[3.4, 2.1, 0x2f7a3a], [4.6, 1.7, 0x388a43], [5.7, 1.2, 0x43a050]].forEach(([y, rad, col]) => {
        const cone = new T.Mesh(new T.ConeGeometry(rad, 2.4, 9), new T.MeshLambertMaterial({ color: col }));
        cone.position.y = y; tree.add(cone);
      });
      tree.position.set(x, 0, z);
      sc.add(tree);
      const hit = new T.Mesh(new T.BoxGeometry(w, h, dp), new T.MeshBasicMaterial({ visible: false }));
      hit.position.set(x, h / 2, z);
      sc.add(hit);
      d.solids.push(hit);
      return;
    }
    const mat = kind === "k" ? (kc++ % 2 ? mats.k2 : mats.k1) : mats[kind];
    const m = new T.Mesh(new T.BoxGeometry(w, h, dp), mat);
    m.position.set(x, h / 2, z);
    sc.add(m);
    d.solids.push(m);
  });
  const wallMat = new T.MeshLambertMaterial({ map: concrete });
  [[0, -DUEL_HALF, DUEL_HALF * 2, 1], [0, DUEL_HALF, DUEL_HALF * 2, 1], [-DUEL_HALF, 0, 1, DUEL_HALF * 2], [DUEL_HALF, 0, 1, DUEL_HALF * 2]].forEach(([x, z, w, dp]) => {
    const m = new T.Mesh(new T.BoxGeometry(w, 3.4, dp), wallMat);
    m.position.set(x, 1.7, z);
    sc.add(m);
    d.solids.push(m);
  });
  for (let i = 0; i < 16; i++) { // far hills for depth
    const a = (i / 16) * Math.PI * 2, rad = 78 + (i % 3) * 8;
    const hill = new T.Mesh(new T.ConeGeometry(15 + (i % 4) * 3, 16 + (i % 5) * 4, 7), new T.MeshLambertMaterial({ color: i % 2 ? 0x4b6e58 : 0x58805f }));
    hill.position.set(Math.cos(a) * rad, 6, Math.sin(a) * rad);
    sc.add(hill);
  }
  sc.updateMatrixWorld(true);
  d.meFig = duelFigure(T, DUEL_TEAMS[d.host ? 0 : 1]);
  d.oppFig = duelFigure(T, DUEL_TEAMS[d.host ? 1 : 0]);
  d.oppTag = duelTag(T, d.oppName);
  d.oppTag.sprite.position.set(0, 2.1, 0);
  d.oppFig.root.add(d.oppTag.sprite);
  sc.add(d.meFig.root, d.oppFig.root);
  duelResize(d);
}

/** A soldier: helmet, goggles, vest, backpack, legs and arms that move, and a rifle. Faces -Z. */
function duelFigure(T, pal) {
  const root = new T.Group(), body = new T.Group();
  root.add(body);
  const mat = (c) => new T.MeshLambertMaterial({ color: c });
  const box = (w, h, dp, c, x, y, z, parent) => { const m = new T.Mesh(new T.BoxGeometry(w, h, dp), mat(c)); m.position.set(x, y, z); (parent || body).add(m); return m; };
  box(0.5, 0.6, 0.3, pal.shirt, 0, 1.1, 0);
  box(0.55, 0.42, 0.35, pal.vest, 0, 1.15, 0);
  box(0.15, 0.12, 0.07, 0x1c1c1c, -0.13, 1.06, -0.2);
  box(0.15, 0.12, 0.07, 0x1c1c1c, 0.13, 1.06, -0.2);
  box(0.46, 0.22, 0.29, pal.pants, 0, 0.77, 0);
  box(0.56, 0.05, 0.31, 0x2a2a2a, 0, 0.88, 0); // belt
  box(0.4, 0.52, 0.2, pal.pack, 0, 1.18, 0.27);
  box(0.32, 0.1, 0.22, pal.pack, 0, 0.9, 0.28);
  const head = new T.Mesh(new T.SphereGeometry(0.17, 14, 12), mat(0xe2b98f));
  head.position.set(0, 1.6, 0); body.add(head);
  const helmet = new T.Mesh(new T.SphereGeometry(0.215, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.56), mat(pal.helmet));
  helmet.position.set(0, 1.62, 0); body.add(helmet);
  box(0.27, 0.075, 0.07, 0x101418, 0, 1.6, -0.16); // goggles
  box(0.05, 0.05, 0.02, pal.band, 0, 1.6, -0.2);
  const legs = [];
  [-0.12, 0.12].forEach((sx) => {
    const piv = new T.Group();
    piv.position.set(sx, 0.7, 0);
    box(0.17, 0.72, 0.2, pal.pants, 0, -0.36, 0, piv);
    box(0.19, 0.13, 0.3, 0x202020, 0, -0.72, -0.04, piv);
    body.add(piv);
    legs.push(piv);
  });
  const arm = (sx, rx, ry) => {
    const piv = new T.Group();
    piv.position.set(sx, 1.34, 0);
    piv.rotation.set(rx, ry, 0);
    box(0.13, 0.56, 0.14, pal.shirt, 0, -0.28, 0, piv);
    box(0.13, 0.12, 0.14, 0x1b1b1b, 0, -0.6, 0, piv);
    body.add(piv);
    return piv;
  };
  arm(0.33, -1.35, 0.12);
  arm(-0.33, -1.5, -0.5);
  box(0.12, 0.12, 0.05, pal.band, 0.335, 1.1, -0.01).rotation.y = 0; // armband
  const rifle = new T.Group();
  rifle.position.set(0.17, 1.17, -0.4);
  body.add(rifle);
  box(0.07, 0.11, 0.62, 0x2b2b2b, 0, 0, 0, rifle);
  box(0.06, 0.07, 0.3, 0x1c1c1c, 0, 0.02, -0.4, rifle);
  box(0.05, 0.14, 0.2, 0x3a2f25, 0, -0.02, 0.36, rifle);
  box(0.055, 0.22, 0.08, 0x202020, 0, -0.15, 0.04, rifle).rotation.x = 0.18;
  box(0.05, 0.05, 0.12, 0x111111, 0, 0.08, -0.06, rifle);
  const flash = new T.Mesh(new T.SphereGeometry(0.1, 8, 8), new T.MeshBasicMaterial({ color: 0xffd25a }));
  flash.position.set(0, 0.02, -0.62);
  flash.visible = false;
  rifle.add(flash);
  return { root, body, legs, flash, flashUntil: 0 };
}

/** Legs swing with the speed; the body bobs; a defeated soldier falls backwards. */
function duelPose(fig, p, dt, now) {
  const run = Math.min(1, p.speed / DUEL_RUN);
  p.phase += dt * (3 + p.speed * 1.25);
  const sw = Math.sin(p.phase) * (0.25 + 0.65 * run) * Math.min(1, p.speed / 2);
  fig.legs[0].rotation.x = sw;
  fig.legs[1].rotation.x = -sw;
  fig.body.position.y = Math.abs(Math.sin(p.phase)) * 0.06 * Math.min(1, p.speed / 3) + (p.grounded === false ? 0.05 : 0);
  const target = p.dead ? 1.45 : 0;
  fig.body.rotation.x += (target - fig.body.rotation.x) * Math.min(1, dt * 9);
  fig.body.position.y += p.dead ? 0.22 * Math.min(1, fig.body.rotation.x) : 0;
  fig.flash.visible = now < fig.flashUntil;
}

/** A floating name and health bar over the opponent. */
function duelTag(T, name) {
  const c = document.createElement("canvas");
  c.width = 160; c.height = 44;
  const tex = new T.CanvasTexture(c);
  const sprite = new T.Sprite(new T.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(1.6, 0.44, 1);
  const draw = (hp) => {
    const x = c.getContext("2d");
    x.clearRect(0, 0, 160, 44);
    x.fillStyle = "#fff"; x.font = "bold 18px sans-serif"; x.textAlign = "center";
    x.fillText(String(name).slice(0, 14), 80, 17);
    x.fillStyle = "rgba(0,0,0,.6)"; x.fillRect(10, 26, 140, 10);
    x.fillStyle = hp > 50 ? "#7ddc5a" : hp > 25 ? "#f0c030" : "#ef4444"; x.fillRect(10, 26, 1.4 * Math.max(0, hp), 10);
    tex.needsUpdate = true;
  };
  draw(DUEL_HP);
  return { sprite, draw, hp: DUEL_HP };
}

function duelResize(d) {
  if (!d.renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  d.renderer.setSize(w, h, false);
  d.cam.aspect = w / h;
  d.cam.updateProjectionMatrix();
}

/* ---------------- input ---------------- */

function duelOn(d, t, ev, fn, opt) { t.addEventListener(ev, fn, opt); d.listeners.push([t, ev, fn, opt]); }

function duelBind(d) {
  const canvas = d.root.querySelector("#duelCanvas");
  duelOn(d, window, "resize", () => duelResize(d));
  duelOn(d, window, "keydown", (e) => {
    if (d.over) return;
    d.keys[e.code] = true;
    if (e.code === "KeyR") duelReload(d);
    if (/^(Space|Arrow)/.test(e.code)) e.preventDefault();
  });
  duelOn(d, window, "keyup", (e) => { d.keys[e.code] = false; });
  duelOn(d, window, "blur", () => { d.keys = {}; d.fireDown = false; });
  duelOn(d, canvas, "mousedown", (e) => {
    if (e.button !== 0 || d.touch) return;
    if (document.pointerLockElement !== canvas) { try { canvas.requestPointerLock(); } catch (er) { /* ignore */ } }
    d.fireDown = true;
  });
  duelOn(d, window, "mouseup", () => { d.fireDown = false; });
  duelOn(d, document, "mousemove", (e) => {
    if (document.pointerLockElement !== canvas) return;
    d.me.yaw -= e.movementX * 0.0025 * d.sens;
    d.me.el = Math.max(-0.9, Math.min(0.6, d.me.el - e.movementY * 0.0025 * d.sens));
  });
  // touch: left side is a stick (push it to the edge to run), right side turns the view, buttons fire / jump / reload
  const q = (id) => d.root.querySelector(id);
  const hold = (el, on, off) => {
    duelOn(d, el, "touchstart", (e) => { on(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
    duelOn(d, el, "touchend", (e) => { off(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
    duelOn(d, el, "touchcancel", off);
  };
  hold(q("#duelFire"), () => { d.fireDown = true; }, () => { d.fireDown = false; });
  hold(q("#duelJump"), () => { d.jumpTouch = true; }, () => { d.jumpTouch = false; });
  hold(q("#duelReload"), () => duelReload(d), () => {});
  const stick = q("#duelStick");
  duelOn(d, canvas, "touchstart", (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.clientX < window.innerWidth * 0.45 && !d.joy) {
        d.joy = { id: t.identifier, x: t.clientX, y: t.clientY, dx: 0, dy: 0 };
        stick.style.cssText = "display:block;left:" + (t.clientX - 55) + "px;top:" + (t.clientY - 55) + "px";
        stick.firstChild.style.transform = "translate(0,0)";
      } else if (t.clientX >= window.innerWidth * 0.45 && !d.look) d.look = { id: t.identifier, x: t.clientX, y: t.clientY };
    }
  }, { passive: false });
  duelOn(d, canvas, "touchmove", (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (d.joy && t.identifier === d.joy.id) {
        let dx = (t.clientX - d.joy.x) / 55, dy = (t.clientY - d.joy.y) / 55;
        const m = Math.hypot(dx, dy);
        d.sprintTouch = m > 1.25;
        if (m > 1) { dx /= m; dy /= m; }
        d.joy.dx = dx; d.joy.dy = dy;
        stick.firstChild.style.transform = "translate(" + dx * 32 + "px," + dy * 32 + "px)";
        stick.classList.toggle("run", d.sprintTouch);
      } else if (d.look && t.identifier === d.look.id) {
        d.me.yaw -= (t.clientX - d.look.x) * 0.006 * d.sens;
        d.me.el = Math.max(-0.9, Math.min(0.6, d.me.el - (t.clientY - d.look.y) * 0.006 * d.sens));
        d.look.x = t.clientX; d.look.y = t.clientY;
      }
    }
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) {
      if (d.joy && t.identifier === d.joy.id) { d.joy = null; d.sprintTouch = false; stick.style.display = "none"; stick.classList.remove("run"); }
      if (d.look && t.identifier === d.look.id) d.look = null;
    }
  };
  duelOn(d, canvas, "touchend", end);
  duelOn(d, canvas, "touchcancel", end);
}

/* ---------------- the game loop ---------------- */

/** The highest cover top under a circle at x, z (0 on open ground). */
function duelGround(x, z, r) {
  let h = 0;
  for (const b of DUEL_BOXES) if (Math.abs(x - b[0]) < b[2] / 2 + r && Math.abs(z - b[1]) < b[3] / 2 + r && b[4] > h) h = b[4];
  return h;
}

function duelSpawn(d, i) {
  const me = d.me;
  me.x = DUEL_SPAWNS[i][0];
  me.z = DUEL_SPAWNS[i][1];
  me.y = 0; me.vy = 0;
  me.yaw = Math.atan2(me.x, me.z); // facing the middle: forward is (-sin yaw, -cos yaw)
  me.el = -0.2;
  me.hp = DUEL_HP;
  me.dead = false;
  me.ammo = DUEL_MAG;
  me.reloadUntil = 0;
  me.safeUntil = performance.now() + DUEL_SAFE_MS;
}

function duelReload(d) {
  const me = d.me, now = performance.now();
  if (me.dead || d.over || now < me.reloadUntil || me.ammo >= DUEL_MAG) return;
  me.reloadUntil = now + DUEL_RELOAD_MS;
  duelSound(d, "reload");
  d.timers.push(setTimeout(() => { if (!d.closed && d.me.reloadUntil > 0 && !d.me.dead) { d.me.ammo = DUEL_MAG; d.me.reloadUntil = 0; d.ammoShown = -2; } }, DUEL_RELOAD_MS));
}

function duelFrame(d, now) {
  if (d.closed) return;
  d.raf = requestAnimationFrame((t) => duelFrame(d, t));
  const dt = Math.min(0.05, (now - d.last) / 1000);
  d.last = now;
  const me = d.me;
  let sp = 0;
  if (!me.dead && !d.over) {
    let fx = 0, fz = 0; // forward / strafe input
    if (d.keys.KeyW || d.keys.ArrowUp) fz += 1;
    if (d.keys.KeyS || d.keys.ArrowDown) fz -= 1;
    if (d.keys.KeyD || d.keys.ArrowRight) fx += 1;
    if (d.keys.KeyA || d.keys.ArrowLeft) fx -= 1;
    if (d.joy) { fx += d.joy.dx; fz -= d.joy.dy; }
    const m = Math.hypot(fx, fz);
    me.moving = m > 0.05;
    const running = me.moving && (d.keys.ShiftLeft || d.keys.ShiftRight || d.sprintTouch) && fz > -0.1;
    if (me.moving) {
      if (m > 1) { fx /= m; fz /= m; }
      sp = running ? DUEL_RUN : DUEL_WALK;
      const step = sp * dt, sy = Math.sin(me.yaw), cy = Math.cos(me.yaw);
      const dx = (-sy * fz + cy * fx) * step, dz = (-cy * fz - sy * fx) * step;
      const lim = DUEL_HALF - 0.8;
      const nx = Math.max(-lim, Math.min(lim, me.x + dx));
      if (duelGround(nx, me.z, 0.45) <= me.y + 0.35) me.x = nx;
      const nz = Math.max(-lim, Math.min(lim, me.z + dz));
      if (duelGround(me.x, nz, 0.45) <= me.y + 0.35) me.z = nz;
      sp *= Math.min(1, m);
    }
    me.running = running;
    if ((d.keys.Space || d.jumpTouch) && me.grounded) { me.vy = DUEL_JUMP; me.grounded = false; }
    if (d.fireDown && now - d.lastShot >= DUEL_FIRE_MS && d.connected) duelShoot(d, now);
  }
  me.vy -= DUEL_GRAV * dt;
  me.y += me.vy * dt;
  const gnd = duelGround(me.x, me.z, 0.3);
  if (me.y <= gnd) { me.y = gnd; me.vy = 0; me.grounded = true; } else me.grounded = false;
  me.speed = sp;
  // the opponent glides to the last place they reported
  const o = d.opp, k = Math.min(1, dt * 14);
  o.x += (o.tx - o.x) * k;
  o.y += (o.ty - o.y) * k;
  o.z += (o.tz - o.z) * k;
  let dy = o.tyaw - o.yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  o.yaw += dy * k;
  duelDraw(d, now, dt);
  if (now - d.lastSend > 50 && d.connected && !d.solo) {
    d.lastSend = now;
    duelSend(d, "fast", { t: "p", x: +me.x.toFixed(2), z: +me.z.toFixed(2), y: +me.y.toFixed(2), yaw: +me.yaw.toFixed(3), hp: me.hp, d: me.dead ? 1 : 0, sp: +me.speed.toFixed(1) });
  }
  d.flash = Math.max(0, d.flash - dt * 2.2);
  d.marker = Math.max(0, d.marker - dt * 4);
  d.kick = Math.max(0, d.kick - dt * 6);
  const r = d.root;
  r.querySelector("#duelFlash").style.opacity = d.flash;
  r.querySelector("#duelDmg").style.opacity = Math.max(0, d.flash * 1.2 - 0.1);
  r.querySelector("#duelHit").style.opacity = d.marker;
  r.querySelector("#duelCross").style.setProperty("--gap", (6 + (me.moving ? (me.running ? 12 : 5) : 0) + (me.grounded ? 0 : 8) + d.kick * 14) + "px");
  duelAmmoHud(d, now);
  duelMap(d);
  if ((d.frames = (d.frames || 0) + 1) % 6 === 0) duelTalking(d);
  if (me.ammo === 0 && d.fireDown && now - d.lastShot > 300 && !me.dead && now >= me.reloadUntil) { d.lastShot = now; duelSound(d, "empty"); duelReload(d); }
}

function duelAim(d) {
  const me = d.me, ce = Math.cos(me.el);
  return { a: [-Math.sin(me.yaw) * ce, Math.sin(me.el), -Math.cos(me.yaw) * ce], right: [Math.cos(me.yaw), 0, -Math.sin(me.yaw)] };
}

/** Over the player's right shoulder, 4.2 behind; the crosshair is the middle of this view. */
function duelCamPos(d) {
  const me = d.me, { a, right } = duelAim(d), dist = 4.2, lim = DUEL_HALF - 0.3;
  return [Math.max(-lim, Math.min(lim, me.x - a[0] * dist + right[0] * 0.8)), Math.max(me.y + 0.5, me.y + 1.6 - a[1] * dist), Math.max(-lim, Math.min(lim, me.z - a[2] * dist + right[2] * 0.8))];
}

function duelDraw(d, now, dt) {
  const T = window.THREE, me = d.me, o = d.opp;
  const blink = now < me.safeUntil && Math.floor(now / 120) % 2;
  d.meFig.root.position.set(me.x, me.y, me.z);
  d.meFig.root.rotation.y = me.yaw;
  d.meFig.root.visible = !blink;
  duelPose(d.meFig, { speed: me.speed, phase: me.phase, dead: me.dead, grounded: me.grounded }, dt, now);
  me.phase += dt * (3 + me.speed * 1.25);
  d.oppFig.root.position.set(o.x, o.y, o.z);
  d.oppFig.root.rotation.y = o.yaw;
  d.oppFig.root.visible = d.connected || d.solo;
  o.speed += ((o.sp || 0) - o.speed) * Math.min(1, dt * 8);
  duelPose(d.oppFig, o, dt, now);
  d.oppTag.sprite.visible = !o.dead;
  if (d.oppTag.hp !== o.hp) { d.oppTag.hp = o.hp; d.oppTag.draw(o.hp); }
  const cp = duelCamPos(d);
  const { a } = duelAim(d);
  // the camera pulls in when a wall is behind the player
  const head = new T.Vector3(me.x, me.y + 1.5, me.z), to = new T.Vector3(cp[0] - me.x, cp[1] - me.y - 1.5, cp[2] - me.z);
  const len = to.length();
  if (len > 0.01) {
    to.normalize();
    const wall = new T.Raycaster(head, to, 0, len + 0.3).intersectObjects(d.solids, false)[0];
    if (wall && wall.distance < len + 0.3) { const k = Math.max(0.15, (wall.distance - 0.3) / len); cp[0] = me.x + (cp[0] - me.x) * k; cp[1] = me.y + 1.5 + (cp[1] - me.y - 1.5) * k; cp[2] = me.z + (cp[2] - me.z) * k; }
  }
  d.cam.position.set(cp[0], cp[1], cp[2]);
  const targetFov = me.running && me.moving ? 74 : 65;
  d.fov += (targetFov - d.fov) * Math.min(1, dt * 8);
  if (Math.abs(d.cam.fov - d.fov) > 0.05) { d.cam.fov = d.fov; d.cam.updateProjectionMatrix(); }
  const kick = d.kick * 0.03;
  d.cam.lookAt(d.cam.position.x + a[0] * 50, d.cam.position.y + (a[1] + kick) * 50, d.cam.position.z + a[2] * 50);
  d.tracers = d.tracers.filter((t) => {
    t.life -= 1;
    if (t.life <= 0) { d.scene.remove(t.line); t.line.geometry.dispose(); return false; }
    t.line.material.opacity = t.life / 7;
    return true;
  });
  d.renderer.render(d.scene, d.cam);
}

/** The corner map: cover, you (arrow) and the other player. */
function duelMap(d) {
  const c = d.map, S = 120, k = S / (DUEL_HALF * 2), me = d.me, o = d.opp;
  c.clearRect(0, 0, S, S);
  c.fillStyle = "rgba(20,40,25,.72)"; c.fillRect(0, 0, S, S);
  for (const [x, z, w, dp, , kind] of DUEL_BOXES) {
    c.fillStyle = kind === "t" ? "#2f7a3a" : kind === "c" ? "#b58a4f" : kind === "k" ? "#b34a3a" : "#9aa0a8";
    if (kind === "t") { c.beginPath(); c.arc((x + DUEL_HALF) * k, (z + DUEL_HALF) * k, 2.2, 0, 6.3); c.fill(); } else c.fillRect((x - w / 2 + DUEL_HALF) * k, (z - dp / 2 + DUEL_HALF) * k, w * k, dp * k);
  }
  if (!o.dead && (d.connected || d.solo)) { c.fillStyle = "#ff4d4d"; c.beginPath(); c.arc((o.x + DUEL_HALF) * k, (o.z + DUEL_HALF) * k, 4, 0, 6.3); c.fill(); }
  c.save();
  c.translate((me.x + DUEL_HALF) * k, (me.z + DUEL_HALF) * k);
  c.rotate(-me.yaw); // forward is (-sin yaw, -cos yaw); an arrow drawn pointing up turns to it
  c.fillStyle = "#fff"; c.strokeStyle = "#111"; c.lineWidth = 1;
  c.beginPath(); c.moveTo(0, -7); c.lineTo(5, 5); c.lineTo(0, 2); c.lineTo(-5, 5); c.closePath(); c.fill(); c.stroke();
  c.restore();
  c.strokeStyle = "rgba(255,255,255,.55)"; c.lineWidth = 2; c.strokeRect(0, 0, S, S);
}

/* ---------------- shooting and health ---------------- */

function duelRaySphere(o, dir, c, r) {
  const ox = o[0] - c[0], oy = o[1] - c[1], oz = o[2] - c[2];
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -1;
}

function duelShoot(d, now) {
  const T = window.THREE, me = d.me, o = d.opp;
  now = now || performance.now();
  if (me.dead || d.over || now < me.reloadUntil) return;
  if (me.ammo <= 0) { duelReload(d); return; }
  me.ammo--;
  d.lastShot = now;
  const aim = duelAim(d), right = aim.right;
  // the shot spreads more when running, jumping or moving, and the view kicks up a little
  const spread = 0.004 + (me.moving ? 0.008 : 0) + (me.running ? 0.012 : 0) + (me.grounded ? 0 : 0.02);
  const a0 = aim.a, a = [a0[0] + (Math.random() - 0.5) * spread * 2, a0[1] + (Math.random() - 0.5) * spread * 2, a0[2] + (Math.random() - 0.5) * spread * 2];
  const al = Math.hypot(a[0], a[1], a[2]);
  a[0] /= al; a[1] /= al; a[2] /= al;
  d.kick = Math.min(1.2, d.kick + 0.35);
  const cam = duelCamPos(d), dist = 4.2;
  const origin = [cam[0] + a[0] * dist, cam[1] + a[1] * dist, cam[2] + a[2] * dist];
  const ray = new T.Raycaster(new T.Vector3(...origin), new T.Vector3(...a), 0, 90);
  const wall = ray.intersectObjects(d.solids, false)[0];
  let tMax = wall ? wall.distance : 90, hit = 0, head = false;
  if (!o.dead) {
    const h = duelRaySphere(origin, a, [o.x, o.y + 1.58, o.z], 0.27);
    const b = duelRaySphere(origin, a, [o.x, o.y + 0.85, o.z], 0.5);
    if (h >= 0 && h < tMax) { tMax = h; hit = DUEL_HEAD; head = true; }
    else if (b >= 0 && b < tMax) { tMax = b; hit = DUEL_BODY; }
  }
  const muzzle = [me.x + right[0] * 0.2 - Math.sin(me.yaw) * 1.0, me.y + 1.2, me.z + right[2] * 0.2 - Math.cos(me.yaw) * 1.0];
  const end = [origin[0] + a[0] * tMax, origin[1] + a[1] * tMax, origin[2] + a[2] * tMax];
  duelTracer(d, muzzle, end);
  d.meFig.flashUntil = now + 55;
  duelSound(d, "shot");
  duelSend(d, "fast", { t: "shot", a: muzzle, b: end });
  if (hit) {
    d.marker = 1;
    o.hp = Math.max(0, o.hp - hit);
    d.root.querySelector("#duelHit").className = head ? "head" : "";
    duelSound(d, head ? "head" : "hit");
    duelDamageNumber(d, hit, head);
    duelSend(d, "safe", { t: "hit", d: hit });
  }
}

/** A number floating up from the opponent when you hit them. */
function duelDamageNumber(d, dmg, head) {
  const T = window.THREE, o = d.opp;
  const v = new T.Vector3(o.x, o.y + 2.0, o.z).project(d.cam);
  const el = document.createElement("div");
  el.className = "duel-dmgnum" + (head ? " head" : "");
  el.textContent = (head ? "HEADSHOT " : "") + dmg;
  el.style.left = (v.x * 0.5 + 0.5) * window.innerWidth + "px";
  el.style.top = (-v.y * 0.5 + 0.5) * window.innerHeight + "px";
  d.root.appendChild(el);
  d.timers.push(setTimeout(() => el.remove(), 800));
}

function duelTracer(d, a, b) {
  const T = window.THREE;
  const g = new T.BufferGeometry().setFromPoints([new T.Vector3(...a), new T.Vector3(...b)]);
  const line = new T.Line(g, new T.LineBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 1 }));
  d.scene.add(line);
  d.tracers.push({ line, life: 7 });
}

function duelGotHit(d, dmg) {
  const me = d.me, now = performance.now();
  if (me.dead || d.over || now < me.safeUntil) return;
  me.hp = Math.max(0, me.hp - dmg);
  d.lastHeadHit = dmg === DUEL_HEAD;
  d.flash = 1;
  // a red wedge on the side the shot came from
  const dx = d.opp.x - me.x, dz = d.opp.z - me.z;
  const lx = dx * Math.cos(me.yaw) - dz * Math.sin(me.yaw), ly = -dx * Math.sin(me.yaw) - dz * Math.cos(me.yaw);
  d.root.querySelector("#duelDmg").style.transform = "translate(-50%,-50%) rotate(" + (Math.atan2(lx, ly) * 180 / Math.PI) + "deg)";
  duelSound(d, "hurt");
  if (me.hp > 0) { duelHud(d); return; }
  me.dead = true;
  me.reloadUntil = 0;
  d.deaths++;
  duelSend(d, "safe", { t: "died", hs: d.lastHeadHit ? 1 : 0 });
  duelFeed(d, "<b>" + duelEsc(d.oppName) + "</b> eliminated you" + (d.lastHeadHit ? " 💀" : ""), "bad");
  duelSound(d, "die");
  if (d.deaths >= DUEL_WIN) { d.over = true; document.exitPointerLock && document.exitPointerLock(); }
  else {
    const spot = DUEL_SPAWNS.map((p, i) => [Math.hypot(p[0] - d.opp.x, p[1] - d.opp.z), i]).sort((x, y) => y[0] - x[0])[0][1];
    d.timers.push(setTimeout(() => { if (!d.closed && !d.over) { duelSpawn(d, spot); d.ammoShown = -2; duelHud(d); } }, DUEL_RESPAWN_MS));
  }
  duelHud(d);
}

const duelEsc = (s) => String(s).replace(/[<>&"']/g, "");

/* ---------------- messages from the other browser ---------------- */

function duelOnMessage(d, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  const o = d.opp;
  switch (m.t) {
    case "p":
      o.tx = +m.x || 0; o.tz = +m.z || 0; o.ty = +m.y || 0; o.tyaw = +m.yaw || 0; o.hp = +m.hp; o.dead = Boolean(m.d); o.sp = +m.sp || 0;
      if (!o.seen) { o.seen = true; o.x = o.tx; o.z = o.tz; o.y = o.ty; o.yaw = o.tyaw; }
      break;
    case "shot":
      if (Array.isArray(m.a) && Array.isArray(m.b)) {
        duelTracer(d, m.a.map(Number), m.b.map(Number));
        d.oppFig.flashUntil = performance.now() + 55;
        duelSound(d, "shot", Math.max(0.15, 1 - Math.hypot(o.x - d.me.x, o.z - d.me.z) / 50));
      }
      break;
    case "hit": duelGotHit(d, m.d === DUEL_HEAD ? DUEL_HEAD : DUEL_BODY); break;
    case "died":
      if (!d.over) {
        d.kills++; o.dead = true;
        duelFeed(d, "You eliminated <b>" + duelEsc(d.oppName) + "</b>" + (m.hs ? " 💀 headshot" : ""), "good");
        d.root.querySelector("#duelHit").className = "kill";
        d.marker = 1;
        if (d.kills >= DUEL_WIN) { d.over = true; duelSound(d, "win"); document.exitPointerLock && document.exitPointerLock(); }
      }
      duelHud(d);
      break;
    case "rematch": d.rematch[1] = true; duelRematchCheck(d); break;
    case "bye": d.connected = false; d.status = d.oppName + " left the duel."; duelHud(d); break;
  }
}

function duelRematchCheck(d) {
  if (!(d.rematch[0] && d.rematch[1])) { duelHud(d); return; }
  d.rematch = [false, false];
  d.kills = 0; d.deaths = 0; d.over = false; d.status = "";
  d.opp.hp = DUEL_HP; d.opp.dead = false;
  duelSpawn(d, d.host ? 0 : 1);
  d.ammoShown = -2;
  duelHud(d);
}

function duelSend(d, ch, obj) {
  const c = ch === "fast" ? d.chFast : d.chSafe;
  if (c && c.readyState === "open") { try { c.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } }
}

/* ---------------- connection ---------------- */

function duelSignal(d, kind, data) { api({ op: "duelSignal", to: d.oppId, kind, data }).catch(() => {}); }

function duelConnect(d) {
  d.status = d.host ? "Waiting for " + d.oppName + " to join…" : "Connecting to " + d.oppName + "…";
  const poll = async () => {
    if (d.closed || d.connected) return;
    try {
      const r = await api({ op: "duelSignals" });
      for (const s of r.signals || []) await duelHandle(d, s);
    } catch (e) { /* try again next time */ }
  };
  d.timers.push(setInterval(poll, 700));
  if (!d.host) {
    const hello = () => { if (!d.connected && !d.closed) duelSignal(d, "hello", null); };
    hello();
    d.timers.push(setInterval(hello, 2500));
  }
  d.timers.push(setInterval(() => { // nothing after a while: try through the relay, then give up
    if (d.connected || d.closed || !d.host || !d.pc) return;
    const waited = performance.now() - d.startedAt;
    if (waited > 8000 && !d.relayTried && state && state.relayServers && state.relayServers.length) { d.relayTried = true; duelStartPeer(d, true); }
    else if (waited > 25000 && d.status.indexOf("could not") < 0) { d.status = "Could not connect to " + d.oppName + " (strict network?). Leave and try again."; duelHud(d); }
  }, 1000));
}

function duelPeer(d, viaRelay) {
  const base = state && state.iceServers && state.iceServers.length ? state.iceServers : DUEL_STUN;
  const relay = viaRelay && state && state.relayServers ? state.relayServers : [];
  if (d.pc) { try { d.pc.close(); } catch (e) { /* ignore */ } }
  const pc = d.pc = new RTCPeerConnection({ iceServers: [...base, ...relay] });
  const sid = d.sid;
  d.queue = [];
  if (d.mic) d.mic.getTracks().forEach((tr) => pc.addTrack(tr, d.mic));
  pc.ontrack = (e) => { if (e.streams && e.streams[0]) duelRemoteVoice(d, e.streams[0]); };
  pc.onicecandidate = (e) => { if (e.candidate && d.pc === pc) duelSignal(d, "ice", { sid, c: e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (d.pc !== pc || d.closed) return;
    if (pc.connectionState === "failed" && d.host && !d.relayTried && state && state.relayServers && state.relayServers.length) { d.relayTried = true; duelStartPeer(d, true); }
    else if (pc.connectionState === "failed" || pc.connectionState === "closed") { d.connected = false; d.status = "Connection lost."; duelHud(d); }
  };
  return pc;
}

function duelChannels(d, pc) {
  const wire = (ch, which) => {
    ch.onmessage = (e) => duelOnMessage(d, e.data);
    ch.onopen = () => {
      if (d.pc !== pc) return;
      if (which === "fast") d.chFast = ch; else d.chSafe = ch;
      if (d.chFast && d.chFast.readyState === "open" && d.chSafe && d.chSafe.readyState === "open" && !d.connected) {
        d.connected = true; d.status = ""; duelHud(d);
      }
    };
    ch.onclose = () => { if (d.pc === pc && !d.closed && d.connected) { d.connected = false; d.status = d.oppName + " disconnected."; duelHud(d); } };
  };
  return wire;
}

async function duelStartPeer(d, viaRelay) {
  d.sid = Math.random().toString(36).slice(2, 8);
  d.startedAt = performance.now();
  d.status = "Connecting to " + d.oppName + (viaRelay ? " through the relay…" : "…");
  duelHud(d);
  const pc = duelPeer(d, viaRelay);
  const wire = duelChannels(d, pc);
  wire(pc.createDataChannel("fast", { ordered: false, maxRetransmits: 0 }), "fast");
  wire(pc.createDataChannel("safe"), "safe");
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  duelSignal(d, "offer", { sid: d.sid, sdp: pc.localDescription, relay: Boolean(viaRelay) });
}

async function duelHandle(d, s) {
  if (d.closed || s.from !== d.oppId) return;
  const data = s.data || {};
  if (s.kind === "hello" && d.host) {
    if (!d.connected && (!d.pc || performance.now() - d.startedAt > 6000)) await duelStartPeer(d, d.relayTried);
  } else if (s.kind === "offer" && !d.host) {
    d.sid = data.sid;
    const pc = duelPeer(d, Boolean(data.relay));
    const wire = duelChannels(d, pc);
    pc.ondatachannel = (e) => wire(e.channel, e.channel.label);
    await pc.setRemoteDescription(data.sdp);
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    duelSignal(d, "answer", { sid: d.sid, sdp: pc.localDescription });
    d.status = "Connecting to " + d.oppName + "…";
    for (const c of d.queue.splice(0)) pc.addIceCandidate(c).catch(() => {});
  } else if (s.kind === "answer" && d.host && data.sid === d.sid && d.pc) {
    await d.pc.setRemoteDescription(data.sdp);
    for (const c of d.queue.splice(0)) d.pc.addIceCandidate(c).catch(() => {});
  } else if (s.kind === "ice" && data.sid === d.sid && d.pc) {
    if (d.pc.remoteDescription) d.pc.addIceCandidate(data.c).catch(() => {});
    else d.queue.push(data.c);
  }
}
