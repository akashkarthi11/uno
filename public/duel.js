/* 3D duel: two players, third-person, one arena, first to 5 kills.
   The server only carries the invite and the connection set-up (ops duelStart / duelEnd / duelSignal / duelSignals).
   The match itself runs between the two browsers over a WebRTC data channel; each browser is the referee for its own player
   (position, health), so it suits friends, not ranked play. Needs app.js first (api, state, room, playerId, toast, $). */
"use strict";

const DUEL_THREE = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
const DUEL_WIN = 5, DUEL_HP = 100, DUEL_RESPAWN_MS = 2200, DUEL_SAFE_MS = 1500, DUEL_SWITCH_MS = 400;
const DUEL_JUMP = 8.5, DUEL_GRAV = 22, DUEL_WALK = 6, DUEL_RUN = 9.5;
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
// weapons: damage to the body / head, ms between shots, magazine, reload ms, spread, view kick, barrel length, rounds carried at the start, ammo-box refill, carry cap
const DUEL_WEAPONS = {
  ar: { name: "AR", dmg: 25, head: 40, rate: 110, mag: 30, reload: 1700, spread: 0.004, kick: 0.35, len: 1.0, start: 90, pack: 30, cap: 180 },
  smg: { name: "SMG", dmg: 18, head: 28, rate: 70, mag: 35, reload: 1500, spread: 0.010, kick: 0.22, len: 0.85, start: 105, pack: 35, cap: 210 },
  sn: { name: "SNIPER", dmg: 70, head: 150, rate: 1300, mag: 5, reload: 2400, spread: 0.0004, kick: 1.1, len: 1.25, start: 10, pack: 5, cap: 20 },
};
const DUEL_WORDER = ["ar", "smg", "sn"];
const DUEL_EYE = [1.6, 1.15, 0.55]; // eye height standing, crouched, prone
const DUEL_STSPEED = [1, 0.55, 0.25];
const DUEL_HEADY = [1.58, 1.12, 0.35], DUEL_BODYY = [0.85, 0.62, 0.3], DUEL_MUZZY = [1.2, 0.85, 0.35];
// pickups: bandage, medkit, ammo box, the sniper rifle, and three super powers (10 s each). Fixed spots in open ground.
const DUEL_PICKS = [
  { k: "band", x: -12, z: -4 }, { k: "band", x: 12, z: 4 }, { k: "band", x: 0, z: -12 }, { k: "band", x: 0, z: 12 },
  { k: "med", x: -18, z: 18 }, { k: "med", x: 18, z: -18 },
  { k: "ammo", x: -8, z: 0 }, { k: "ammo", x: 8, z: 0 },
  { k: "speed", x: 0, z: -26 }, { k: "shield", x: 0, z: 26 }, { k: "rage", x: 7, z: -4 },
  { k: "sn", x: -26, z: -2 },
];
const DUEL_PCOL = { band: 0xffffff, med: 0xffffff, ammo: 0xd9b84a, speed: 0x4dd0ff, shield: 0x6aa8ff, rage: 0xff5a3d, sn: 0xf2f2f2 };
const DUEL_PNAME = { band: "Bandage", med: "Medkit", ammo: "Ammo box", speed: "SPEED", shield: "SHIELD", rage: "RAGE (double damage)", sn: "Sniper rifle" };
const DUEL_PBACK = { band: 20000, med: 20000, ammo: 20000, speed: 30000, shield: 30000, rage: 30000, sn: 45000 }; // ms until it is back
const DUEL_POWER_MS = 10000;
const DUEL_PWCODE = { speed: 1, shield: 2, rage: 3 };

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
    me: {
      x: 0, y: 0, z: 0, vy: 0, yaw: 0, el: -0.2, hp: DUEL_HP, dead: false, safeUntil: 0, moving: false, speed: 0, grounded: true, phase: 0,
      st: 0, eyeH: DUEL_EYE[0], w: "ar", mag: {}, res: {}, have: {}, inv: { band: 0, med: 0 }, switchUntil: 0, reload: null, ads: false, using: null, power: null,
    },
    opp: { x: 0, y: 0, z: 0, yaw: 0, tx: 0, ty: 0, tz: 0, tyaw: 0, hp: DUEL_HP, dead: false, seen: false, speed: 0, phase: 0, st: 0, w: "ar", pw: 0, sp: 0 },
    kills: 0, deaths: 0, over: false, rematch: [false, false], keys: {}, fireDown: false, lastShot: 0, lastSend: 0, lastHeadHit: false,
    joy: null, look: null, tracers: [], status: "Loading the arena…", pc: null, sid: "", chFast: null, chSafe: null,
    connected: false, relayTried: false, startedAt: 0, t0: performance.now(), ping: 0, lastRx: 0, weak: false, route: "", netAt: 0, pingShown: "", queue: [], timers: [], listeners: [], flash: 0, marker: 0, kick: 0, adsT: 0,
    sens: Number(duelPref("sens", 1)) || 1, adsSens: Number(duelPref("ads", 0.7)) || 0.7, sound: duelPref("snd", "1") === "1",
    sprintTouch: false, jumpTouch: false, invShown: "", ammoShown: "", lastMsg: "", picks: DUEL_PICKS.map(() => ({ on: true, until: 0 })), pickMeshes: [],
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
    '<canvas id="duelCanvas"></canvas><div id="duelScope" class="hidden"></div>' +
    '<div id="duelDmg"></div><div id="duelFlash"></div><div id="duelLow"></div>' +
    '<div class="duel-top"><canvas id="duelMap" width="120" height="120"></canvas><div id="duelScore"></div><div id="duelPing" class="hidden"></div>' +
    '<div class="duel-btns"><button id="duelMic" type="button" aria-label="Microphone">🎤</button><button id="duelGear" type="button" aria-label="Settings">⚙</button><button id="duelLeave" type="button">✕</button></div></div>' +
    '<div id="duelPower" class="hidden"></div>' +
    '<div id="duelSet" class="hidden"><label>Sensitivity <input id="duelSens" type="range" min="0.4" max="2.2" step="0.1"></label>' +
    '<label>Aiming (ADS) sensitivity <input id="duelAdsSens" type="range" min="0.2" max="1.6" step="0.1"></label>' +
    '<label class="duel-chk"><input id="duelSnd" type="checkbox"> Sound</label></div>' +
    '<ul id="duelFeed"></ul>' +
    '<div id="duelCross"><i></i><i></i><i></i><i></i></div><div id="duelHit"></div>' +
    '<div id="duelMsg"></div>' +
    '<div class="duel-use hidden"><span id="duelUseTxt"></span><div class="duel-rel"><div id="duelUseBar"></div></div></div>' +
    '<div class="duel-bar"><button id="duelPack" type="button" title="Inventory (Tab)">🎒<i>Tab</i></button>' +
    '<div class="duel-mid"><div class="duel-inv"><button id="duelBand" type="button">🩹 <b>0</b><i>B</i></button><button id="duelMed" type="button">➕ <b>0</b><i>N</i></button><span id="duelStance"></span></div>' +
    '<div class="duel-hp"><div class="duel-hp-top"><b id="duelHpLabel">HP</b><span id="duelHpTxt"></span></div><div class="duel-hp-bar"><div id="duelHpBar"></div></div></div></div>' +
    '<div class="duel-ammo"><div id="duelSlots"></div><span id="duelAmmo"></span><small id="duelAmmoHint"></small><div class="duel-rel"><div id="duelRelBar"></div></div></div></div>' +
    '<div id="duelPanel" class="hidden"><div class="duel-panel-in"><div class="duel-panel-head"><b>Inventory</b><button id="duelPanelX" type="button">✕</button></div><div id="duelPanelBody"></div><p class="duel-note">The match keeps running while this is open.</p></div></div>' +
    '<div id="duelBigMap" class="hidden"><div class="duel-map-in"><div class="duel-panel-head"><b>Tactical map</b><button id="duelMapX" type="button">✕</button></div><canvas id="duelMapBig" width="560" height="560"></canvas><div id="duelLegend"></div></div></div>' +
    '<button id="duelFire" type="button" aria-label="Fire">🔫</button>' +
    '<button id="duelAim" type="button" aria-label="Aim">◎</button>' +
    '<button id="duelJump" type="button" aria-label="Jump">⤒</button>' +
    '<button id="duelCrouch" type="button" aria-label="Crouch">⤓</button>' +
    '<button id="duelProne" type="button" aria-label="Prone">▁</button>' +
    '<button id="duelReload" type="button" aria-label="Reload">⟳</button>' +
    '<button id="duelSwitch" type="button" aria-label="Switch weapon">⇄</button>' +
    '<div id="duelStick"><i></i></div>' +
    '<div id="duelOver" class="hidden"><h2 id="duelOverTitle"></h2><p id="duelOverSub"></p>' +
    '<button id="duelAgain" type="button">Rematch</button><button id="duelOut" type="button" class="ghost">Back to lobby</button></div>' +
    '<div id="duelHelp">WASD move · Shift run · Space jump · C crouch · Z prone · right-click aim · R reload · 1 2 3 weapons · B bandage · N medkit · Esc frees the mouse</div>';
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
  q("#duelAdsSens").value = d.adsSens;
  q("#duelAdsSens").addEventListener("input", (e) => { d.adsSens = Number(e.target.value) || 0.7; duelSetPref("ads", d.adsSens); });
  q("#duelSnd").checked = d.sound;
  q("#duelSnd").addEventListener("change", (e) => { d.sound = e.target.checked; duelSetPref("snd", d.sound ? "1" : "0"); });
  q("#duelPack").addEventListener("click", () => duelToggle(d, "panel"));
  q("#duelPanelX").addEventListener("click", () => duelToggle(d, "panel", false));
  q("#duelMap").addEventListener("click", () => duelToggle(d, "map"));
  q("#duelMapX").addEventListener("click", () => duelToggle(d, "map", false));
  q("#duelBigMap").addEventListener("click", (e) => { if (e.target.id === "duelBigMap") duelToggle(d, "map", false); });
  q("#duelPanel").addEventListener("click", (e) => { if (e.target.id === "duelPanel") duelToggle(d, "panel", false); });
  q("#duelBand").addEventListener("click", () => duelUse(d, "band"));
  q("#duelMed").addEventListener("click", () => duelUse(d, "med"));
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

/** Weapon slots, ammo, reload bar, bandage / medkit counts, the super power timer and the heal bar. Cheap: only writes what changed. */
function duelAmmoHud(d, now) {
  const me = d.me, W = DUEL_WEAPONS[me.w], r = d.root;
  const reloading = Boolean(me.reload);
  const bar = r.querySelector("#duelRelBar");
  const w = reloading ? 100 - ((me.reload.until - now) / W.reload) * 100 : 0;
  bar.style.width = Math.max(0, Math.min(100, w)) + "%";
  const key = [me.w, me.mag[me.w], me.res[me.w], reloading, DUEL_WORDER.map((k) => (me.have[k] ? 1 : 0)).join("")].join("|");
  if (key !== d.ammoShown) {
    d.ammoShown = key;
    r.querySelector("#duelAmmo").innerHTML = "<small>" + W.name + "</small> <b>" + me.mag[me.w] + "</b> / " + me.res[me.w];
    r.querySelector("#duelAmmoHint").textContent = reloading ? "Reloading…" : me.mag[me.w] === 0 ? (me.res[me.w] > 0 ? "Empty — reload" : "No ammo — find an ammo box") : me.mag[me.w] <= Math.ceil(W.mag / 4) ? "Low" : "";
    r.querySelector("#duelSlots").innerHTML = DUEL_WORDER.map((k, i) => '<span class="' + (k === me.w ? "on " : "") + (me.have[k] ? "" : "off") + '"><i>' + (i + 1) + "</i>" + DUEL_WEAPONS[k].name + "</span>").join("");
  }
  const inv = me.inv.band + "," + me.inv.med + "," + me.st + "," + (me.power ? Math.ceil((me.power.until - now) / 1000) + me.power.kind : "") + "," + (me.using ? 1 : 0);
  if (inv !== d.invShown) {
    d.invShown = inv;
    r.querySelector("#duelBand b").textContent = me.inv.band;
    r.querySelector("#duelMed b").textContent = me.inv.med;
    r.querySelector("#duelBand").classList.toggle("off", me.inv.band === 0);
    r.querySelector("#duelMed").classList.toggle("off", me.inv.med === 0);
    r.querySelector("#duelStance").textContent = ["", "crouching", "prone"][me.st];
    const pw = r.querySelector("#duelPower");
    if (me.power) { pw.textContent = { speed: "⚡ SPEED", shield: "🛡 SHIELD", rage: "🔥 RAGE ×2" }[me.power.kind] + " " + Math.ceil((me.power.until - now) / 1000) + "s"; pw.dataset.k = me.power.kind; }
    pw.classList.toggle("hidden", !me.power);
    const shielded = Boolean(me.power && me.power.kind === "shield");
    r.querySelector(".duel-hp").classList.toggle("shielded", shielded);
    r.querySelector("#duelHpLabel").textContent = shielded ? "HP 🛡" : "HP";
  }
  const use = r.querySelector(".duel-use");
  use.classList.toggle("hidden", !me.using);
  if (me.using) {
    r.querySelector("#duelUseTxt").textContent = me.using.kind === "band" ? "Using bandage…" : "Using medkit…";
    r.querySelector("#duelUseBar").style.width = Math.min(100, ((now - me.using.start) / (me.using.end - me.using.start)) * 100) + "%";
  }
}

/** Opens or closes the inventory panel or the tactical map (`on` forces it). The match keeps running underneath. */
function duelToggle(d, which, on) {
  const el = d.root.querySelector(which === "panel" ? "#duelPanel" : "#duelBigMap");
  const open = on === undefined ? el.classList.contains("hidden") : on;
  if (open) { try { document.exitPointerLock(); } catch (e) { /* ignore */ } d.fireDown = false; }
  el.classList.toggle("hidden", !open);
  d[which + "Open"] = open;
  if (open && which === "panel") duelPanelRender(d);
  if (open && which === "map") duelLegend(d);
}

/** Weapons (tap to equip), healing (tap to use) and the active power. */
function duelPanelRender(d) {
  const me = d.me, now = performance.now(), body = d.root.querySelector("#duelPanelBody");
  const rows = DUEL_WORDER.map((k) => {
    const W = DUEL_WEAPONS[k], has = me.have[k];
    return '<button type="button" class="duel-row' + (k === me.w ? " on" : "") + (has ? "" : " off") + '" data-w="' + k + '"' + (has ? "" : " disabled") + "><b>" + W.name + "</b><span>" +
      (has ? me.mag[k] + " / " + me.res[k] : "find it on the map") + "</span><em>" + (k === me.w ? "equipped" : has ? "equip" : "") + "</em></button>";
  }).join("");
  const heal = [["band", "🩹 Bandage", "2.2 s · up to 75 HP"], ["med", "➕ Medkit", "4 s · full HP"]].map(([k, n, s]) =>
    '<button type="button" class="duel-row' + (me.inv[k] ? "" : " off") + '" data-u="' + k + '"' + (me.inv[k] ? "" : " disabled") + "><b>" + n + " ×" + me.inv[k] + "</b><span>" + s + "</span><em>" + (me.inv[k] ? "use" : "") + "</em></button>").join("");
  const pw = me.power ? { speed: "⚡ Speed", shield: "🛡 Shield", rage: "🔥 Rage ×2" }[me.power.kind] + " · " + Math.max(0, Math.ceil((me.power.until - now) / 1000)) + " s" : "none active";
  body.innerHTML = "<h4>Weapons</h4>" + rows + "<h4>Healing</h4>" + heal + "<h4>Super power</h4><div class=\"duel-row static\"><b>" + pw + "</b></div>";
  body.querySelectorAll("[data-w]").forEach((b) => b.addEventListener("click", () => { duelSwitch(d, b.dataset.w); duelPanelRender(d); }));
  body.querySelectorAll("[data-u]").forEach((b) => b.addEventListener("click", () => { duelUse(d, b.dataset.u); duelToggle(d, "panel", false); }));
}

function duelLegend(d) {
  const lg = d.root.querySelector("#duelLegend");
  if (lg.childElementCount) return;
  lg.innerHTML = [["#5cff7a", "Bandage / medkit"], ["#d9b84a", "Ammo box"], ["#f2f2f2", "Sniper rifle"], ["#4dd0ff", "Speed"], ["#6aa8ff", "Shield"], ["#ff5a3d", "Rage"], ["#ff4d4d", "Opponent"], ["#b34a3a", "Containers"], ["#9aa0a8", "Walls"], ["#b58a4f", "Crates"], ["#2f7a3a", "Trees"]]
    .map(([c, n]) => '<span><i style="background:' + c + '"></i>' + n + "</span>").join("");
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
    else if (kind === "snipe") { g.gain.setValueAtTime(0.7 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5); noise(0.5, 4000, 120); tone("sine", 90, 30, 0.4); }
    else if (kind === "hit") { g.gain.setValueAtTime(0.22 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08); tone("square", 900, 700, 0.08); }
    else if (kind === "head") { g.gain.setValueAtTime(0.25 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22); tone("triangle", 1500, 1900, 0.22); }
    else if (kind === "hurt") { g.gain.setValueAtTime(0.4 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18); tone("sine", 160, 60, 0.18); }
    else if (kind === "empty") { g.gain.setValueAtTime(0.18 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.04); noise(0.04, 3000, 1500); }
    else if (kind === "reload") { g.gain.setValueAtTime(0.25 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05); noise(0.05, 3500, 1200); d.timers.push(setTimeout(() => duelSound(d, "click"), 1100)); }
    else if (kind === "click") { g.gain.setValueAtTime(0.3 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.07); noise(0.07, 4000, 800); }
    else if (kind === "switch") { g.gain.setValueAtTime(0.25 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09); noise(0.09, 2500, 600); }
    else if (kind === "pick") { g.gain.setValueAtTime(0.25 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18); tone("triangle", 700, 1200, 0.18); }
    else if (kind === "heal") { g.gain.setValueAtTime(0.28 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45); tone("sine", 520, 1040, 0.45); }
    else if (kind === "power") { g.gain.setValueAtTime(0.3 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.6); tone("sawtooth", 200, 900, 0.6); }
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
  sc.add(new T.HemisphereLight(0xdcecff, 0x58704a, 0.6));
  const sun = new T.DirectionalLight(0xffe6bd, 0.8);
  sun.position.set(30, 50, 20);
  d.shadows = !d.touch; // real shadows on computers; phones get a cheap blob under each soldier
  if (d.shadows) {
    r.shadowMap.enabled = true; r.shadowMap.type = T.PCFSoftShadowMap;
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0006;
    Object.assign(sun.shadow.camera, { left: -42, right: 42, top: 42, bottom: -42, near: 1, far: 130 });
  }
  sc.add(sun);
  d.cam = new T.PerspectiveCamera(65, 1, 0.1, 220);

  const grass = duelTexture(T, 256, (x, s) => {
    x.fillStyle = "#5e9a4c"; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) { x.fillStyle = ["#6cab58", "#4f8a40", "#76b560", "#548f45"][i % 4]; x.fillRect(Math.random() * s, Math.random() * s, 2, 3 + Math.random() * 3); }
  }, 14);
  const ground = new T.Mesh(new T.PlaneGeometry(DUEL_HALF * 2, DUEL_HALF * 2), new T.MeshLambertMaterial({ map: grass }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
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
      tree.traverse((o) => { o.castShadow = true; });
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
    m.castShadow = m.receiveShadow = true;
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
  DUEL_PICKS.forEach((p, i) => {
    const m = duelPickMesh(T, p.k);
    m.position.set(p.x, 0, p.z);
    sc.add(m);
    d.pickMeshes[i] = m;
  });
  sc.updateMatrixWorld(true);
  d.meFig = duelFigure(T, DUEL_TEAMS[d.host ? 0 : 1]);
  d.oppFig = duelFigure(T, DUEL_TEAMS[d.host ? 1 : 0]);
  d.oppTag = duelTag(T, d.oppName);
  d.oppTag.sprite.position.set(0, 2.1, 0);
  d.oppFig.root.add(d.oppTag.sprite);
  sc.add(d.meFig.root, d.oppFig.root);
  [d.meFig, d.oppFig].forEach((f) => {
    if (d.shadows) { f.root.traverse((o) => { if (o.isMesh && o !== f.aura) o.castShadow = true; }); return; }
    const blob = new T.Mesh(new T.PlaneGeometry(1.1, 1.1), new T.MeshBasicMaterial({ map: duelTexture(T, 64, (x, s) => { const g = x.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2); g.addColorStop(0, "rgba(0,0,0,.5)"); g.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = g; x.fillRect(0, 0, s, s); }), transparent: true, depthWrite: false }));
    blob.rotation.x = -Math.PI / 2; blob.position.y = 0.03;
    f.root.add(blob);
  });
  duelEffectsInit(d);
  duelResize(d);
}

/** What a pickup looks like on the ground: a small spinning object and a light column so it can be seen from afar. */
function duelPickMesh(T, kind) {
  const g = new T.Group(), item = new T.Group();
  const mat = (c) => new T.MeshLambertMaterial({ color: c });
  const box = (w, h, dp, c, x, y, z, parent) => { const m = new T.Mesh(new T.BoxGeometry(w, h, dp), mat(c)); m.position.set(x, y, z); (parent || item).add(m); return m; };
  if (kind === "band") { box(0.42, 0.2, 0.3, 0xf4f4f4, 0, 0, 0); box(0.3, 0.215, 0.07, 0xd62828, 0, 0, 0); box(0.07, 0.215, 0.22, 0xd62828, 0, 0, 0); }
  else if (kind === "med") { box(0.62, 0.42, 0.34, 0xf4f4f4, 0, 0, 0); box(0.34, 0.44, 0.07, 0xd62828, 0, 0, 0.0); box(0.1, 0.44, 0.3, 0xd62828, 0, 0, 0); box(0.3, 0.06, 0.1, 0x777777, 0, 0.24, 0); }
  else if (kind === "ammo") { box(0.6, 0.32, 0.36, 0x5b6b3a, 0, 0, 0); box(0.62, 0.08, 0.38, 0xd9b84a, 0, 0.1, 0); box(0.12, 0.34, 0.38, 0xd9b84a, 0.18, 0, 0); }
  else if (kind === "sn") { box(0.1, 0.12, 1.1, 0x2b2b2b, 0, 0, 0); box(0.07, 0.07, 0.5, 0x1c1c1c, 0, 0.02, -0.7); box(0.07, 0.1, 0.4, 0x3a2f25, 0, -0.02, 0.6); box(0.09, 0.09, 0.32, 0x111111, 0, 0.14, -0.05); }
  else { const o = new T.Mesh(new T.OctahedronGeometry(0.3), new T.MeshBasicMaterial({ color: DUEL_PCOL[kind] })); item.add(o); const ring = new T.Mesh(new T.TorusGeometry(0.45, 0.03, 6, 20), new T.MeshBasicMaterial({ color: DUEL_PCOL[kind] })); ring.rotation.x = Math.PI / 2; item.add(ring); }
  item.position.y = 0.85;
  g.add(item);
  const col = kind === "band" || kind === "med" ? 0x5cff7a : DUEL_PCOL[kind];
  const beam = new T.Mesh(new T.CylinderGeometry(0.22, 0.22, 5, 10, 1, true), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.11, side: T.DoubleSide, depthWrite: false }));
  beam.position.y = 2.5;
  g.add(beam);
  g.userData.item = item;
  return g;
}

/** A soldier: helmet, goggles, vest, backpack, legs and arms that move, and three rifles (one shown). Faces -Z. */
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
  box(0.12, 0.12, 0.05, pal.band, 0.335, 1.1, -0.01); // armband
  const rifle = new T.Group();
  rifle.position.set(0.17, 1.17, -0.4);
  body.add(rifle);
  const flash = (parent, z) => { const f = new T.Mesh(new T.SphereGeometry(0.1, 8, 8), new T.MeshBasicMaterial({ color: 0xffd25a })); f.position.set(0, 0.02, z); f.visible = false; parent.add(f); return f; };
  const guns = {}, flashes = {};
  guns.ar = new T.Group();
  box(0.07, 0.11, 0.62, 0x2b2b2b, 0, 0, 0, guns.ar);
  box(0.06, 0.07, 0.3, 0x1c1c1c, 0, 0.02, -0.4, guns.ar);
  box(0.05, 0.14, 0.2, 0x3a2f25, 0, -0.02, 0.36, guns.ar);
  box(0.055, 0.22, 0.08, 0x202020, 0, -0.15, 0.04, guns.ar).rotation.x = 0.18;
  box(0.05, 0.05, 0.12, 0x111111, 0, 0.08, -0.06, guns.ar);
  flashes.ar = flash(guns.ar, -0.62);
  guns.smg = new T.Group();
  box(0.07, 0.12, 0.42, 0x2f2f2f, 0, 0, 0, guns.smg);
  box(0.05, 0.05, 0.2, 0x1c1c1c, 0, 0.02, -0.3, guns.smg);
  box(0.05, 0.12, 0.14, 0x202020, 0, -0.04, 0.26, guns.smg);
  box(0.05, 0.28, 0.07, 0x1a1a1a, 0, -0.18, -0.02, guns.smg);
  flashes.smg = flash(guns.smg, -0.46);
  guns.sn = new T.Group();
  box(0.07, 0.1, 0.8, 0x2a2e2a, 0, 0, 0, guns.sn);
  box(0.04, 0.04, 0.55, 0x151515, 0, 0.02, -0.65, guns.sn);
  box(0.06, 0.15, 0.3, 0x4a3b2c, 0, -0.03, 0.5, guns.sn);
  const scope = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 0.34, 10), mat(0x111111));
  scope.rotation.x = Math.PI / 2; scope.position.set(0, 0.12, -0.05); guns.sn.add(scope);
  flashes.sn = flash(guns.sn, -0.95);
  DUEL_WORDER.forEach((k) => { guns[k].visible = k === "ar"; rifle.add(guns[k]); });
  const aura = new T.Mesh(new T.SphereGeometry(1.05, 14, 10), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }));
  aura.position.y = 0.95; aura.visible = false;
  root.add(aura);
  return { root, body, legs, guns, flashes, rifle, aura, flashUntil: 0, scale: 1, dip: 0, hitAt: 0 };
}

/** Legs swing with the speed, the body bobs, crouch and prone lower it, a defeated soldier falls backwards. `p` carries speed, phase, dead, st, w, pw. */
function duelPose(fig, p, dt, now) {
  const run = Math.min(1, p.speed / DUEL_RUN);
  p.phase += dt * (3 + p.speed * 1.25);
  const walk = Math.min(1, p.speed / 2);
  const sw = Math.sin(p.phase) * (0.25 + 0.65 * run) * walk;
  fig.legs[0].rotation.x = sw;
  fig.legs[1].rotation.x = -sw;
  const st = p.st || 0;
  const k = Math.min(1, dt * 9);
  const targetX = p.dead ? 1.45 : st === 2 ? -1.5 : 0;
  fig.body.rotation.x += (targetX - fig.body.rotation.x) * k;
  const targetS = st === 1 && !p.dead ? 0.72 : 1;
  fig.scale += (targetS - fig.scale) * k;
  fig.body.scale.y = fig.scale;
  let y = Math.abs(Math.sin(p.phase)) * 0.06 * walk * (st ? 0.3 : 1) + (p.grounded === false ? 0.05 : 0);
  if (p.dead) y += 0.22 * Math.min(1, fig.body.rotation.x);
  else if (st === 2) y += 0.36 * Math.min(1, -fig.body.rotation.x / 1.5);
  fig.body.position.y = y;
  // the rifle kicks back with each shot and dips while reloading; a hit makes the soldier flinch sideways
  const since = now - (fig.flashUntil - 55), kickBack = since >= 0 && since < 110 ? 1 - since / 110 : 0;
  fig.dip += ((p.reload && !p.dead ? 1 : 0) - fig.dip) * k;
  fig.rifle.position.set(0.17, 1.17 - 0.2 * fig.dip, -0.4 + 0.08 * kickBack);
  fig.rifle.rotation.x = (st === 2 && !p.dead ? -fig.body.rotation.x : 0) + 0.5 * fig.dip + 0.05 * kickBack; // prone: the rifle stays pointing ahead
  const flinch = fig.hitAt && now - fig.hitAt < 200 ? 1 - (now - fig.hitAt) / 200 : 0;
  fig.body.rotation.z = flinch * 0.16;
  DUEL_WORDER.forEach((w) => { fig.guns[w].visible = w === (p.w || "ar"); });
  const fl = fig.flashes[p.w || "ar"];
  DUEL_WORDER.forEach((w) => { fig.flashes[w].visible = false; });
  if (fl) fl.visible = now < fig.flashUntil;
  const pw = p.pw || 0;
  fig.aura.visible = pw > 0 && !p.dead;
  if (pw) fig.aura.material.color.setHex(pw === 1 ? DUEL_PCOL.speed : pw === 2 ? DUEL_PCOL.shield : DUEL_PCOL.rage);
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

/** Sensitivity now: aiming has its own setting, and a scope turns slower still. */
const duelSensNow = (d) => d.sens * (d.me.ads ? d.adsSens * (d.me.w === "sn" ? 0.5 : 1) : 1);

function duelBind(d) {
  const canvas = d.root.querySelector("#duelCanvas");
  duelOn(d, window, "resize", () => duelResize(d));
  duelOn(d, window, "keydown", (e) => {
    if (d.over) return;
    d.keys[e.code] = true;
    if (e.repeat) { if (/^(Space|Arrow)/.test(e.code)) e.preventDefault(); return; }
    if (e.code === "Tab" || e.code === "KeyI") { e.preventDefault(); duelToggle(d, "panel"); }
    else if (e.code === "KeyM") duelToggle(d, "map");
    else if (e.code === "Escape") { duelToggle(d, "panel", false); duelToggle(d, "map", false); }
    else if (e.code === "KeyR") duelReload(d);
    else if (e.code === "Digit1") duelSwitch(d, "ar");
    else if (e.code === "Digit2") duelSwitch(d, "smg");
    else if (e.code === "Digit3") duelSwitch(d, "sn");
    else if (e.code === "KeyQ") duelCycle(d);
    else if (e.code === "KeyB") duelUse(d, "band");
    else if (e.code === "KeyN") duelUse(d, "med");
    else if (e.code === "KeyC") duelStance(d, 1);
    else if (e.code === "KeyZ") duelStance(d, 2);
    if (/^(Space|Arrow)/.test(e.code)) e.preventDefault();
  });
  duelOn(d, window, "keyup", (e) => { d.keys[e.code] = false; });
  duelOn(d, window, "blur", () => { d.keys = {}; d.fireDown = false; });
  duelOn(d, canvas, "contextmenu", (e) => e.preventDefault());
  duelOn(d, canvas, "mousedown", (e) => {
    if (d.touch) return;
    if (document.pointerLockElement !== canvas) { try { canvas.requestPointerLock(); } catch (er) { /* ignore */ } }
    if (e.button === 0) d.fireDown = true;
    else if (e.button === 2) { d.me.ads = true; duelCancelUse(d); }
  });
  duelOn(d, window, "mouseup", (e) => { if (e.button === 0) d.fireDown = false; else if (e.button === 2) d.me.ads = false; });
  duelOn(d, canvas, "wheel", (e) => { e.preventDefault(); duelCycle(d); }, { passive: false });
  duelOn(d, document, "mousemove", (e) => {
    if (document.pointerLockElement !== canvas) return;
    const s = duelSensNow(d);
    d.me.yaw -= e.movementX * 0.0025 * s;
    d.me.el = Math.max(-0.9, Math.min(0.6, d.me.el - e.movementY * 0.0025 * s));
  });
  // touch: left side is a stick (push it to the edge to run), right side turns the view, buttons do the rest
  const q = (id) => d.root.querySelector(id);
  const hold = (el, on, off) => {
    duelOn(d, el, "touchstart", (e) => { on(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
    duelOn(d, el, "touchend", (e) => { off(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
    duelOn(d, el, "touchcancel", off);
  };
  // the fire button also turns the view: hold it and drag the same thumb to aim while shooting
  const fireBtn = q("#duelFire");
  let fireTouch = null;
  duelOn(d, fireBtn, "touchstart", (e) => {
    e.preventDefault(); e.stopPropagation();
    const t = e.changedTouches[0];
    fireTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
    d.fireDown = true;
    fireBtn.classList.add("down");
  }, { passive: false });
  duelOn(d, fireBtn, "touchmove", (e) => {
    e.preventDefault(); e.stopPropagation();
    for (const t of e.changedTouches) {
      if (!fireTouch || t.identifier !== fireTouch.id) continue;
      const s = duelSensNow(d);
      d.me.yaw -= (t.clientX - fireTouch.x) * 0.006 * s;
      d.me.el = Math.max(-0.9, Math.min(0.6, d.me.el - (t.clientY - fireTouch.y) * 0.006 * s));
      fireTouch.x = t.clientX; fireTouch.y = t.clientY;
    }
  }, { passive: false });
  const fireEnd = (e) => { e.preventDefault(); e.stopPropagation(); fireTouch = null; d.fireDown = false; fireBtn.classList.remove("down"); };
  duelOn(d, fireBtn, "touchend", fireEnd, { passive: false });
  duelOn(d, fireBtn, "touchcancel", fireEnd, { passive: false });
  hold(q("#duelJump"), () => { d.jumpTouch = true; }, () => { d.jumpTouch = false; });
  hold(q("#duelReload"), () => duelReload(d), () => {});
  hold(q("#duelAim"), () => { d.me.ads = !d.me.ads; if (d.me.ads) duelCancelUse(d); q("#duelAim").classList.toggle("on", d.me.ads); }, () => {});
  hold(q("#duelCrouch"), () => duelStance(d, 1), () => {});
  hold(q("#duelProne"), () => duelStance(d, 2), () => {});
  hold(q("#duelSwitch"), () => duelCycle(d), () => {});
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
        const s = duelSensNow(d);
        d.me.yaw -= (t.clientX - d.look.x) * 0.006 * s;
        d.me.el = Math.max(-0.9, Math.min(0.6, d.me.el - (t.clientY - d.look.y) * 0.006 * s));
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

/** A fresh soldier: full health, the rifle and the SMG with their rounds, nothing else. */
function duelSpawn(d, i) {
  const me = d.me;
  duelCancelReload(d);
  me.x = DUEL_SPAWNS[i][0];
  me.z = DUEL_SPAWNS[i][1];
  me.y = 0; me.vy = 0;
  me.yaw = Math.atan2(me.x, me.z); // facing the middle: forward is (-sin yaw, -cos yaw)
  me.el = -0.2;
  me.hp = DUEL_HP;
  me.dead = false;
  me.st = 0; me.eyeH = DUEL_EYE[0];
  me.w = "ar";
  me.have = { ar: true, smg: true, sn: false };
  me.mag = { ar: DUEL_WEAPONS.ar.mag, smg: DUEL_WEAPONS.smg.mag, sn: 0 };
  me.res = { ar: DUEL_WEAPONS.ar.start, smg: DUEL_WEAPONS.smg.start, sn: 0 };
  me.inv = { band: 0, med: 0 };
  me.using = null; me.power = null; me.ads = false; me.switchUntil = 0;
  me.safeUntil = performance.now() + DUEL_SAFE_MS;
  d.ammoShown = ""; d.invShown = "";
}

function duelReload(d) {
  const me = d.me, W = DUEL_WEAPONS[me.w], now = performance.now();
  if (me.dead || d.over || me.reload || now < me.switchUntil || me.mag[me.w] >= W.mag || me.res[me.w] <= 0) return;
  duelCancelUse(d);
  const w = me.w;
  me.reload = { w, until: now + W.reload };
  duelSound(d, "reload");
  me.reload.timer = setTimeout(() => {
    if (d.closed || !me.reload || me.reload.w !== w) return;
    const take = Math.min(W.mag - me.mag[w], me.res[w]);
    me.mag[w] += take; me.res[w] -= take;
    me.reload = null;
  }, W.reload);
  d.timers.push(me.reload.timer);
}

function duelCancelReload(d) {
  const r = d.me.reload;
  if (r) { clearTimeout(r.timer); d.me.reload = null; }
}

function duelSwitch(d, w) {
  const me = d.me;
  if (me.dead || d.over || !me.have[w] || me.w === w) return;
  duelCancelReload(d); duelCancelUse(d);
  me.w = w; me.switchUntil = performance.now() + DUEL_SWITCH_MS; me.ads = false;
  const a = d.root.querySelector("#duelAim"); if (a) a.classList.remove("on");
  duelSound(d, "switch");
}

function duelCycle(d) {
  const have = DUEL_WORDER.filter((w) => d.me.have[w]);
  if (have.length > 1) duelSwitch(d, have[(have.indexOf(d.me.w) + 1) % have.length]);
}

/** Crouch and prone toggle; pressing the same one again stands up. */
function duelStance(d, s) {
  const me = d.me;
  if (me.dead || d.over) return;
  me.st = me.st === s ? 0 : s;
}

/** Bandage (2.2 s, up to 75 health) or medkit (4 s, to full). Being hit, shooting, aiming, reloading or switching stops it. */
function duelUse(d, kind) {
  const me = d.me, now = performance.now();
  if (me.dead || d.over || me.using) return;
  if (me.inv[kind] <= 0) { toast(kind === "band" ? "No bandages. Find one on the map." : "No medkits. Find one on the map."); return; }
  if (me.hp >= (kind === "band" ? 75 : 100)) { toast(kind === "band" ? "A bandage only heals up to 75. Use a medkit." : "Your health is full."); return; }
  duelCancelReload(d);
  me.ads = false;
  me.using = { kind, start: now, end: now + (kind === "band" ? 2200 : 4000) };
}

function duelCancelUse(d) { d.me.using = null; }

const duelPowerOn = (me, kind, now) => Boolean(me.power && me.power.kind === kind && now < me.power.until);

function duelFrame(d, now) {
  if (d.closed) return;
  d.raf = requestAnimationFrame((t) => duelFrame(d, t));
  const dt = Math.min(0.05, (now - d.last) / 1000);
  d.last = now;
  const me = d.me;
  if (me.power && now >= me.power.until) me.power = null;
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
    const running = me.moving && me.st === 0 && !me.ads && !me.using && (d.keys.ShiftLeft || d.keys.ShiftRight || d.sprintTouch) && fz > -0.1;
    if (me.moving) {
      if (m > 1) { fx /= m; fz /= m; }
      sp = (running ? DUEL_RUN : DUEL_WALK) * DUEL_STSPEED[me.st] * (me.ads ? 0.6 : 1) * (me.using ? 0.6 : 1) * (duelPowerOn(me, "speed", now) ? 1.35 : 1);
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
    if (d.keys.Space || d.jumpTouch) { if (me.st) me.st = 0; else if (me.grounded) { me.vy = DUEL_JUMP; me.grounded = false; } }
    const W = DUEL_WEAPONS[me.w];
    if (d.fireDown && now - d.lastShot >= W.rate && d.connected) duelShoot(d, now);
    if (me.using && now >= me.using.end) { // finished healing
      me.hp = me.using.kind === "band" ? Math.min(75, me.hp + 25) : DUEL_HP;
      me.inv[me.using.kind]--;
      me.using = null;
      duelSound(d, "heal");
      duelHud(d);
    }
    duelTakePicks(d, now);
  }
  me.vy -= DUEL_GRAV * dt;
  me.y += me.vy * dt;
  const gnd = duelGround(me.x, me.z, 0.3);
  if (me.y <= gnd) { me.y = gnd; me.vy = 0; me.grounded = true; } else me.grounded = false;
  me.speed = sp;
  me.eyeH += (DUEL_EYE[me.st] - me.eyeH) * Math.min(1, dt * 10);
  d.adsT += ((me.ads && !me.dead ? 1 : 0) - d.adsT) * Math.min(1, dt * 12);
  // the opponent glides to the last place they reported
  const o = d.opp, k = Math.min(1, dt * 14);
  o.x += (o.tx - o.x) * k;
  o.y += (o.ty - o.y) * k;
  o.z += (o.tz - o.z) * k;
  let dy = o.tyaw - o.yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  o.yaw += dy * k;
  duelPickups(d, now, dt);
  duelDraw(d, now, dt);
  duelNet(d, now);
  if (now - d.lastSend > 50 && d.connected && !d.solo) {
    d.lastSend = now;
    const pw = me.power && now < me.power.until ? DUEL_PWCODE[me.power.kind] : 0;
    duelSend(d, "fast", { t: "p", x: +me.x.toFixed(2), z: +me.z.toFixed(2), y: +me.y.toFixed(2), yaw: +me.yaw.toFixed(3), hp: me.hp, d: me.dead ? 1 : 0, sp: +me.speed.toFixed(1), st: me.st, w: me.w, pw });
  }
  d.flash = Math.max(0, d.flash - dt * 2.2);
  d.marker = Math.max(0, d.marker - dt * 4);
  d.kick = Math.max(0, d.kick - dt * 6);
  const r = d.root;
  r.querySelector("#duelFlash").style.opacity = d.flash;
  r.querySelector("#duelDmg").style.opacity = Math.max(0, d.flash * 1.2 - 0.1);
  r.querySelector("#duelHit").style.opacity = d.marker;
  r.querySelector("#duelCross").style.setProperty("--gap", (6 + (me.moving ? (me.running ? 12 : 5) : 0) + (me.grounded ? 0 : 8) + d.kick * 14 - d.adsT * 4) + "px");
  r.querySelector("#duelScope").classList.toggle("hidden", !(me.w === "sn" && d.adsT > 0.85 && !me.dead));
  r.querySelector("#duelCross").style.opacity = me.w === "sn" && d.adsT > 0.85 ? 0 : 1;
  duelAmmoHud(d, now);
  duelMap(d, now);
  if ((d.frames = (d.frames || 0) + 1) % 6 === 0) duelTalking(d);
  if (me.mag[me.w] === 0 && d.fireDown && now - d.lastShot > 300 && !me.dead && !me.reload) { d.lastShot = now; duelSound(d, "empty"); duelReload(d); }
}

/** Walk into a pickup to take it. */
function duelTakePicks(d, now) {
  const me = d.me;
  DUEL_PICKS.forEach((p, i) => {
    const s = d.picks[i];
    if (!s.on || Math.hypot(p.x - me.x, p.z - me.z) > 1.3 || Math.abs(me.y - 0) > 1.5) return;
    if (p.k === "band" && me.inv.band >= 5) return;
    if (p.k === "med" && me.inv.med >= 2) return;
    if (p.k === "sn" && me.have.sn && me.res.sn >= DUEL_WEAPONS.sn.cap) return;
    duelTake(d, i, now, true);
  });
}

/** `mine`: I took it (apply it to me and tell the other browser); otherwise the other player took it (just hide it). */
function duelTake(d, i, now, mine) {
  const p = DUEL_PICKS[i], s = d.picks[i], me = d.me;
  s.on = false;
  s.until = now + DUEL_PBACK[p.k];
  if (!mine) return;
  duelSend(d, "safe", { t: "pick", i });
  duelSound(d, p.k === "speed" || p.k === "shield" || p.k === "rage" ? "power" : "pick");
  if (p.k === "band") { me.inv.band = Math.min(5, me.inv.band + 3); duelFeed(d, "Picked up <b>3 bandages</b>", "good"); }
  else if (p.k === "med") { me.inv.med = Math.min(2, me.inv.med + 1); duelFeed(d, "Picked up a <b>medkit</b>", "good"); }
  else if (p.k === "ammo") { DUEL_WORDER.forEach((w) => { if (me.have[w]) me.res[w] = Math.min(DUEL_WEAPONS[w].cap, me.res[w] + DUEL_WEAPONS[w].pack); }); duelFeed(d, "Picked up <b>ammo</b>", "good"); }
  else if (p.k === "sn") {
    me.have.sn = true; me.res.sn = Math.min(DUEL_WEAPONS.sn.cap, me.res.sn + DUEL_WEAPONS.sn.pack + 5);
    if (me.mag.sn === 0) { const take = Math.min(DUEL_WEAPONS.sn.mag, me.res.sn); me.mag.sn = take; me.res.sn -= take; }
    duelFeed(d, "Picked up the <b>sniper rifle</b> (key 3)", "good");
  } else { me.power = { kind: p.k, until: now + DUEL_POWER_MS }; duelFeed(d, "<b>" + DUEL_PNAME[p.k] + "</b> for 10 seconds!", "good"); }
  d.ammoShown = ""; d.invShown = "";
}

/** The pickups spin and bob, and come back after their wait. */
function duelPickups(d, now, dt) {
  DUEL_PICKS.forEach((p, i) => {
    const s = d.picks[i], m = d.pickMeshes[i];
    if (!s.on && now >= s.until) s.on = true;
    if (!m) return;
    m.visible = s.on;
    if (s.on) { const it = m.userData.item; it.rotation.y += dt * 1.6; it.position.y = 0.85 + Math.sin(now / 400 + i) * 0.1; }
  });
}

function duelAim(d) {
  const me = d.me, ce = Math.cos(me.el);
  return { a: [-Math.sin(me.yaw) * ce, Math.sin(me.el), -Math.cos(me.yaw) * ce], right: [Math.cos(me.yaw), 0, -Math.sin(me.yaw)] };
}

/** How far behind and to the right the camera sits, and its field of view. Aiming brings it in; a sniper scope puts it at the eyes. */
function duelCamParams(d) {
  const t = d.adsT, sn = d.me.w === "sn";
  return {
    dist: sn ? 4.2 + (0.15 - 4.2) * t : 4.2 + (2.6 - 4.2) * t,
    side: sn ? 0.8 * (1 - t) : 0.8 + (0.5 - 0.8) * t,
    fov: sn ? 65 + (14 - 65) * t : 65 + (50 - 65) * t,
  };
}

/** Over the player's shoulder; the crosshair is the middle of this view. */
function duelCamPos(d) {
  const me = d.me, { a, right } = duelAim(d), { dist, side } = duelCamParams(d), lim = DUEL_HALF - 0.3;
  return [Math.max(-lim, Math.min(lim, me.x - a[0] * dist + right[0] * side)), Math.max(me.y + 0.4, me.y + me.eyeH - a[1] * dist), Math.max(-lim, Math.min(lim, me.z - a[2] * dist + right[2] * side))];
}

function duelDraw(d, now, dt) {
  const T = window.THREE, me = d.me, o = d.opp;
  const blink = now < me.safeUntil && Math.floor(now / 120) % 2;
  const scoped = me.w === "sn" && d.adsT > 0.85;
  const myPw = me.power && now < me.power.until ? DUEL_PWCODE[me.power.kind] : 0;
  d.meFig.root.position.set(me.x, me.y, me.z);
  d.meFig.root.rotation.y = me.yaw;
  d.meFig.root.visible = !blink && !scoped;
  duelPose(d.meFig, { speed: me.speed, phase: me.phase, dead: me.dead, grounded: me.grounded, st: me.st, w: me.w, pw: myPw, reload: Boolean(me.reload) }, dt, now);
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
  const params = duelCamParams(d);
  // the camera pulls in when a wall is behind the player
  const eyeY = me.y + me.eyeH - 0.1;
  const head = new T.Vector3(me.x, eyeY, me.z), to = new T.Vector3(cp[0] - me.x, cp[1] - eyeY, cp[2] - me.z);
  const len = to.length();
  if (len > 0.5) {
    to.normalize();
    const wall = new T.Raycaster(head, to, 0, len + 0.3).intersectObjects(d.solids, false)[0];
    if (wall && wall.distance < len + 0.3) { const k = Math.max(0.15, (wall.distance - 0.3) / len); cp[0] = me.x + (cp[0] - me.x) * k; cp[1] = eyeY + (cp[1] - eyeY) * k; cp[2] = me.z + (cp[2] - me.z) * k; }
  }
  d.cam.position.set(cp[0], cp[1], cp[2]);
  const targetFov = params.fov + (me.running && me.moving ? 9 : 0) + (duelPowerOn(me, "speed", now) && me.moving ? 4 : 0);
  d.fov = d.fov === undefined ? targetFov : d.fov + (targetFov - d.fov) * Math.min(1, dt * 10);
  if (Math.abs(d.cam.fov - d.fov) > 0.05) { d.cam.fov = d.fov; d.cam.updateProjectionMatrix(); }
  const kick = d.kick * 0.03;
  d.cam.lookAt(d.cam.position.x + a[0] * 50, d.cam.position.y + (a[1] + kick) * 50, d.cam.position.z + a[2] * 50);
  d.tracers = d.tracers.filter((t) => {
    t.life -= 1;
    if (t.life <= 0) { d.scene.remove(t.line); t.line.geometry.dispose(); return false; }
    t.line.material.opacity = t.life / 7;
    return true;
  });
  duelEffectsStep(d, now, dt);
  d.renderer.render(d.scene, d.cam);
}

/** Paints the map into a canvas: cover, pickups, where you look (a cone), you (arrow) and the other player. `big` adds a grid, labels and a compass. */
function duelPaintMap(d, c, S, big) {
  const k = S / (DUEL_HALF * 2), me = d.me, o = d.opp;
  c.clearRect(0, 0, S, S);
  c.fillStyle = big ? "rgba(24,48,30,.94)" : "rgba(20,40,25,.72)"; c.fillRect(0, 0, S, S);
  if (big) {
    c.strokeStyle = "rgba(255,255,255,.1)"; c.lineWidth = 1;
    for (let g = 10; g < DUEL_HALF * 2; g += 10) { c.beginPath(); c.moveTo(g * k, 0); c.lineTo(g * k, S); c.moveTo(0, g * k); c.lineTo(S, g * k); c.stroke(); }
  }
  for (const [x, z, w, dp, , kind] of DUEL_BOXES) {
    c.fillStyle = kind === "t" ? "#2f7a3a" : kind === "c" ? "#b58a4f" : kind === "k" ? "#b34a3a" : "#9aa0a8";
    if (kind === "t") { c.beginPath(); c.arc((x + DUEL_HALF) * k, (z + DUEL_HALF) * k, big ? 6 : 2.2, 0, 6.3); c.fill(); } else c.fillRect((x - w / 2 + DUEL_HALF) * k, (z - dp / 2 + DUEL_HALF) * k, w * k, dp * k);
  }
  const mark = big ? 9 : 4;
  DUEL_PICKS.forEach((p, i) => {
    if (!d.picks[i].on) return;
    c.fillStyle = p.k === "band" || p.k === "med" ? "#5cff7a" : "#" + DUEL_PCOL[p.k].toString(16).padStart(6, "0");
    c.fillRect((p.x + DUEL_HALF) * k - mark / 2, (p.z + DUEL_HALF) * k - mark / 2, mark, mark);
    if (big) { c.fillStyle = "#000"; c.font = "bold 8px sans-serif"; c.textAlign = "center"; c.fillText({ band: "B", med: "M", ammo: "A", sn: "S", speed: "⚡", shield: "◆", rage: "R" }[p.k], (p.x + DUEL_HALF) * k, (p.z + DUEL_HALF) * k + 3); }
  });
  if (!o.dead && (d.connected || d.solo)) {
    c.fillStyle = "#ff4d4d"; c.beginPath(); c.arc((o.x + DUEL_HALF) * k, (o.z + DUEL_HALF) * k, big ? 8 : 4, 0, 6.3); c.fill();
    if (big) { c.fillStyle = "#fff"; c.font = "bold 12px sans-serif"; c.textAlign = "center"; c.fillText(d.oppName.slice(0, 12), (o.x + DUEL_HALF) * k, (o.z + DUEL_HALF) * k - 12); }
  }
  c.save();
  c.translate((me.x + DUEL_HALF) * k, (me.z + DUEL_HALF) * k);
  c.rotate(-me.yaw); // forward is (-sin yaw, -cos yaw); a shape drawn pointing up turns to it
  const sc = big ? 1.7 : 1;
  c.fillStyle = "rgba(255,255,255,.18)"; c.beginPath(); c.moveTo(0, 0); c.lineTo(-22 * sc, -34 * sc); c.lineTo(22 * sc, -34 * sc); c.closePath(); c.fill(); // where you look
  c.fillStyle = "#fff"; c.strokeStyle = "#111"; c.lineWidth = 1;
  c.beginPath(); c.moveTo(0, -7 * sc); c.lineTo(5 * sc, 5 * sc); c.lineTo(0, 2 * sc); c.lineTo(-5 * sc, 5 * sc); c.closePath(); c.fill(); c.stroke();
  c.restore();
  c.strokeStyle = "rgba(255,255,255,.55)"; c.lineWidth = 2; c.strokeRect(0, 0, S, S);
  c.fillStyle = "#fff"; c.font = "bold " + (big ? 16 : 10) + "px sans-serif"; c.textAlign = "center"; c.fillText("N", S / 2, big ? 20 : 11); // north is up the map
}

function duelMap(d) {
  duelPaintMap(d, d.map, 120, false);
  if (d.mapOpen) duelPaintMap(d, d.root.querySelector("#duelMapBig").getContext("2d"), 560, true);
  if (d.panelOpen && (d.frames || 0) % 15 === 0) duelPanelRender(d);
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
  const T = window.THREE, me = d.me, o = d.opp, W = DUEL_WEAPONS[me.w];
  now = now || performance.now();
  if (me.dead || d.over || me.reload || now < me.switchUntil) return;
  if (me.mag[me.w] <= 0) { duelReload(d); return; }
  me.mag[me.w]--;
  d.lastShot = now;
  duelCancelUse(d);
  const aim = duelAim(d), right = aim.right;
  const scoped = me.w === "sn" && d.adsT > 0.85;
  // the shot spreads more when moving, running or in the air (and a lot for an un-scoped sniper); aiming tightens it; the view kicks up
  const spread = (W.spread + (me.moving ? 0.008 : 0) + (me.running ? 0.012 : 0) + (me.grounded ? 0 : 0.02) + (me.w === "sn" && !scoped ? 0.03 : 0)) * (me.ads ? 0.4 : 1) * (me.st ? 0.7 : 1);
  const a0 = aim.a, a = [a0[0] + (Math.random() - 0.5) * spread * 2, a0[1] + (Math.random() - 0.5) * spread * 2, a0[2] + (Math.random() - 0.5) * spread * 2];
  const al = Math.hypot(a[0], a[1], a[2]);
  a[0] /= al; a[1] /= al; a[2] /= al;
  d.kick = Math.min(1.4, d.kick + W.kick);
  const cam = duelCamPos(d), dist = duelCamParams(d).dist;
  const origin = [cam[0] + a[0] * dist, cam[1] + a[1] * dist, cam[2] + a[2] * dist];
  const ray = new T.Raycaster(new T.Vector3(...origin), new T.Vector3(...a), 0, 120);
  const wall = ray.intersectObjects(d.solids, false)[0];
  let tMax = wall ? wall.distance : 120, hit = 0, head = false;
  if (!o.dead) {
    const ost = o.st || 0;
    const h = duelRaySphere(origin, a, [o.x, o.y + DUEL_HEADY[ost], o.z], 0.27);
    const b = duelRaySphere(origin, a, [o.x, o.y + DUEL_BODYY[ost], o.z], ost === 2 ? 0.42 : 0.5);
    const mult = duelPowerOn(me, "rage", now) ? 2 : 1;
    if (h >= 0 && h < tMax) { tMax = h; hit = W.head * mult; head = true; }
    else if (b >= 0 && b < tMax) { tMax = b; hit = W.dmg * mult; }
  }
  const muzzle = [me.x + right[0] * 0.2 - Math.sin(me.yaw) * W.len, me.y + DUEL_MUZZY[me.st], me.z + right[2] * 0.2 - Math.cos(me.yaw) * W.len];
  const end = [origin[0] + a[0] * tMax, origin[1] + a[1] * tMax, origin[2] + a[2] * tMax];
  duelTracer(d, muzzle, end);
  d.meFig.flashUntil = now + 55;
  duelImpact(d, end, hit ? null : wall && wall.distance <= tMax + 0.01 && wall.face ? [wall.face.normal.x, wall.face.normal.y, wall.face.normal.z] : null, Boolean(hit));
  if (hit) d.oppFig.hitAt = now;
  duelSound(d, me.w === "sn" ? "snipe" : "shot");
  duelSend(d, "fast", { t: "shot", a: muzzle, b: end, w: me.w });
  if (hit) {
    d.marker = 1;
    o.hp = Math.max(0, o.hp - hit);
    d.root.querySelector("#duelHit").className = head ? "head" : "";
    duelSound(d, head ? "head" : "hit");
    duelDamageNumber(d, hit, head);
    duelSend(d, "safe", { t: "hit", d: hit, h: head ? 1 : 0 });
  }
  if (me.mag[me.w] === 0 && me.res[me.w] > 0) d.timers.push(setTimeout(() => { if (!d.closed) duelReload(d); }, 250));
}

/** A number floating up from the opponent when you hit them. */
function duelDamageNumber(d, dmg, head) {
  const T = window.THREE, o = d.opp;
  const v = new T.Vector3(o.x, o.y + 2.0, o.z).project(d.cam);
  const el = document.createElement("div");
  el.className = "duel-dmgnum" + (head ? " head" : "");
  el.textContent = (head ? "HEADSHOT " : "") + Math.round(dmg);
  el.style.left = (v.x * 0.5 + 0.5) * window.innerWidth + "px";
  el.style.top = (-v.y * 0.5 + 0.5) * window.innerHeight + "px";
  d.root.appendChild(el);
  d.timers.push(setTimeout(() => el.remove(), 800));
}

const DUEL_PARTS = 56, DUEL_HOLES = 20;

/** A pool of small puffs (dust, sparks, a hit puff) and bullet holes, made once and reused so shooting never allocates. */
function duelEffectsInit(d) {
  const T = window.THREE, geo = new T.SphereGeometry(0.5, 5, 4);
  d.parts = []; d.partAt = 0;
  for (let i = 0; i < DUEL_PARTS; i++) {
    const m = new T.Mesh(geo, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    m.visible = false;
    d.scene.add(m);
    d.parts.push({ m, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 0.1, grow: 0, grav: 0 });
  }
  const tex = duelTexture(T, 32, (x, s) => { const g = x.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s / 2); g.addColorStop(0, "rgba(10,10,10,.95)"); g.addColorStop(0.55, "rgba(20,20,20,.7)"); g.addColorStop(1, "rgba(20,20,20,0)"); x.fillStyle = g; x.fillRect(0, 0, s, s); });
  const hgeo = new T.PlaneGeometry(0.16, 0.16);
  d.holes = []; d.holeAt = 0;
  for (let i = 0; i < DUEL_HOLES; i++) {
    const m = new T.Mesh(hgeo, new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.visible = false;
    d.scene.add(m);
    d.holes.push({ m, until: 0 });
  }
}

/** Throws `n` puffs from a point. kind: dust (wall or ground), spark (a flash of hot specks on a wall), hit (a soldier was hit). */
function duelBurst(d, p, kind, n) {
  if (!d.parts) return;
  const spec = { dust: [0xcdbf9f, 0.5, 0.18, 0.5, 1.6, 2.2], spark: [0xffd27a, 0.22, 0.05, -0.02, 4.5, 8], hit: [0xd9d2c8, 0.45, 0.14, 0.4, 1.4, 1.8] }[kind];
  for (let i = 0; i < n; i++) {
    const q = d.parts[d.partAt++ % DUEL_PARTS], sp = spec[4] * (0.4 + Math.random() * 0.6);
    q.m.material.color.setHex(spec[0]);
    q.m.position.set(p[0], p[1], p[2]);
    q.vx = (Math.random() - 0.5) * sp; q.vy = Math.random() * sp * 0.8 + 0.4; q.vz = (Math.random() - 0.5) * sp;
    q.life = q.max = spec[1] * (0.6 + Math.random() * 0.6); q.size = spec[2]; q.grow = spec[3]; q.grav = spec[5];
    q.m.scale.setScalar(q.size);
    q.m.visible = true;
  }
}

/** Where a shot ended: a puff on a soldier, dust and sparks on cover, plus a bullet hole on a wall (`normal` is the wall face, known for your own shots). */
function duelImpact(d, end, normal, onPlayer) {
  if (Math.hypot(end[0] - d.cam.position.x, end[2] - d.cam.position.z) > 90) return; // a miss into the distance
  if (onPlayer) { duelBurst(d, end, "hit", 6); return; }
  duelBurst(d, end, "dust", 5);
  duelBurst(d, end, "spark", 4);
  if (!normal || !d.holes) return;
  const h = d.holes[d.holeAt++ % DUEL_HOLES], T = window.THREE;
  h.m.position.set(end[0] + normal[0] * 0.02, end[1] + normal[1] * 0.02, end[2] + normal[2] * 0.02);
  h.m.lookAt(end[0] + normal[0], end[1] + normal[1], end[2] + normal[2]);
  h.m.visible = true;
  h.until = performance.now() + 12000;
}

function duelEffectsStep(d, now, dt) {
  if (!d.parts) return;
  for (const q of d.parts) {
    if (q.life <= 0) continue;
    q.life -= dt;
    if (q.life <= 0) { q.m.visible = false; continue; }
    q.vy -= q.grav * dt;
    q.m.position.x += q.vx * dt; q.m.position.y = Math.max(0.02, q.m.position.y + q.vy * dt); q.m.position.z += q.vz * dt;
    q.size += q.grow * dt;
    q.m.scale.setScalar(Math.max(0.02, q.size));
    q.m.material.opacity = Math.min(1, q.life / q.max * 1.2);
  }
  for (const h of d.holes) if (h.m.visible && now > h.until) h.m.visible = false;
}

function duelTracer(d, a, b) {
  const T = window.THREE;
  const g = new T.BufferGeometry().setFromPoints([new T.Vector3(...a), new T.Vector3(...b)]);
  const line = new T.Line(g, new T.LineBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 1 }));
  d.scene.add(line);
  d.tracers.push({ line, life: 7 });
}

function duelGotHit(d, dmgIn, head) {
  const me = d.me, now = performance.now();
  if (me.dead || d.over || now < me.safeUntil) return;
  const dmg = duelPowerOn(me, "shield", now) ? dmgIn * 0.4 : dmgIn;
  me.hp = Math.max(0, me.hp - dmg);
  d.lastHeadHit = Boolean(head);
  d.flash = 1;
  d.meFig.hitAt = now;
  duelCancelUse(d);
  // a red wedge on the side the shot came from
  const dx = d.opp.x - me.x, dz = d.opp.z - me.z;
  const lx = dx * Math.cos(me.yaw) - dz * Math.sin(me.yaw), ly = -dx * Math.sin(me.yaw) - dz * Math.cos(me.yaw);
  d.root.querySelector("#duelDmg").style.transform = "translate(-50%,-50%) rotate(" + (Math.atan2(lx, ly) * 180 / Math.PI) + "deg)";
  duelSound(d, "hurt");
  if (me.hp > 0) { duelHud(d); return; }
  me.dead = true;
  duelCancelReload(d);
  me.ads = false; me.power = null;
  d.deaths++;
  duelSend(d, "safe", { t: "died", hs: d.lastHeadHit ? 1 : 0 });
  duelFeed(d, "<b>" + duelEsc(d.oppName) + "</b> eliminated you" + (d.lastHeadHit ? " 💀" : ""), "bad");
  duelSound(d, "die");
  if (d.deaths >= DUEL_WIN) { d.over = true; document.exitPointerLock && document.exitPointerLock(); }
  else {
    const spot = DUEL_SPAWNS.map((p, i) => [Math.hypot(p[0] - d.opp.x, p[1] - d.opp.z), i]).sort((x, y) => y[0] - x[0])[0][1];
    d.timers.push(setTimeout(() => { if (!d.closed && !d.over) { duelSpawn(d, spot); duelHud(d); } }, DUEL_RESPAWN_MS));
  }
  duelHud(d);
}

const duelEsc = (s) => String(s).replace(/[<>&"']/g, "");

/* ---------------- messages from the other browser ---------------- */

function duelOnMessage(d, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== "object") return;
  const o = d.opp;
  d.lastRx = performance.now();
  switch (m.t) {
    case "ping": duelSend(d, "fast", { t: "pong", n: +m.n || 0 }); break;
    case "pong": { const rtt = performance.now() - (+m.n || 0); if (rtt >= 0 && rtt < 10000) d.ping = d.ping ? d.ping * 0.7 + rtt * 0.3 : rtt; break; }
    case "p":
      o.tx = +m.x || 0; o.tz = +m.z || 0; o.ty = +m.y || 0; o.tyaw = +m.yaw || 0; o.hp = +m.hp; o.dead = Boolean(m.d); o.sp = +m.sp || 0;
      o.st = m.st === 1 || m.st === 2 ? m.st : 0; o.w = DUEL_WEAPONS[m.w] ? m.w : "ar"; o.pw = m.pw === 1 || m.pw === 2 || m.pw === 3 ? m.pw : 0;
      if (!o.seen) { o.seen = true; o.x = o.tx; o.z = o.tz; o.y = o.ty; o.yaw = o.tyaw; }
      break;
    case "shot":
      if (Array.isArray(m.a) && Array.isArray(m.b)) {
        duelTracer(d, m.a.map(Number), m.b.map(Number));
        d.oppFig.flashUntil = performance.now() + 55;
        const e = m.b.map(Number), near = Math.abs(e[0] - d.me.x) < 0.7 && Math.abs(e[2] - d.me.z) < 0.7 && e[1] > d.me.y - 0.1 && e[1] < d.me.y + 1.9;
        duelImpact(d, e, null, near);
        duelSound(d, m.w === "sn" ? "snipe" : "shot", Math.max(0.15, 1 - Math.hypot(o.x - d.me.x, o.z - d.me.z) / 50));
      }
      break;
    case "hit": duelGotHit(d, Math.max(1, Math.min(150, +m.d || 0)), m.h === 1); break;
    case "pick": { const i = +m.i; if (Number.isInteger(i) && d.picks[i]) duelTake(d, i, performance.now(), false); break; }
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
  d.picks.forEach((s) => { s.on = true; s.until = 0; });
  duelSpawn(d, d.host ? 0 : 1);
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
  d.timers.push(setInterval(() => { // nothing after a while: try through the relay, then say what is wrong
    if (d.connected || d.closed) return;
    const now = performance.now();
    if (d.host && d.pc) {
      const waited = now - d.startedAt;
      if (waited > 8000 && !d.relayTried && state && state.relayServers && state.relayServers.length) { d.relayTried = true; duelStartPeer(d, true); }
      else if (waited > 25000 && !d.status.startsWith("Could not")) { d.status = "Could not connect to " + d.oppName + " (strict network or no relay). Leave and try again."; duelHud(d); }
    } else if (!d.host && !d.pc && now - d.t0 > 20000 && !d.status.startsWith("Could not")) {
      d.status = "Could not reach " + d.oppName + ". Are they still in the duel? Leave and try again."; duelHud(d);
    }
  }, 1000));
}

/** Once a second: ping the other browser (the ms on screen), and if nothing has arrived for a while say so, then reconnect. */
function duelNet(d, now) {
  if (d.solo || d.closed) return;
  const chip = d.root.querySelector("#duelPing");
  if (!d.connected) { if (d.pingShown) { chip.className = "hidden"; d.pingShown = ""; } return; }
  if (now - d.netAt < 1000) return;
  d.netAt = now;
  const silent = now - d.lastRx;
  if (silent > 10000) { // dead link: the host starts a new connection, the guest answers when it arrives
    d.connected = false; d.weak = false; d.ping = 0;
    d.status = "Connection lost — reconnecting…";
    if (d.host) duelStartPeer(d, d.relayTried).catch(() => {});
    duelHud(d);
    return;
  }
  d.weak = silent > 3000;
  duelSend(d, "fast", { t: "ping", n: now });
  const ms = Math.round(d.ping);
  const txt = d.weak ? "⚠ weak connection" : (d.ping ? ms + " ms" : "… ms") + (d.route ? " · " + d.route : "");
  if (txt !== d.pingShown) { d.pingShown = txt; chip.textContent = txt; chip.className = d.weak || ms >= 160 ? "bad" : ms >= 80 ? "mid" : "good"; }
}

/** Whether the connection goes straight between the two browsers or through the relay. */
function duelRoute(d, pc) {
  d.timers.push(setTimeout(async () => {
    try {
      const all = {};
      let pair = null;
      (await pc.getStats()).forEach((r) => { if (r.type === "candidate-pair" && (r.nominated || r.state === "succeeded")) pair = pair && pair.nominated ? pair : r; else if (/-candidate$/.test(r.type)) all[r.id] = r; });
      if (!pair || d.pc !== pc) return;
      const l = all[pair.localCandidateId], rm = all[pair.remoteCandidateId];
      d.route = (l && l.candidateType === "relay") || (rm && rm.candidateType === "relay") ? "relay" : "direct";
      d.pingShown = "";
    } catch (e) { /* stats are optional */ }
  }, 800));
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
        d.connected = true; d.status = ""; d.lastRx = performance.now(); d.weak = false; d.ping = 0; d.route = "";
        duelHud(d);
        duelRoute(d, pc);
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
