/* 3D duel: two players, third-person, one arena, one gun, first to 5 kills.
   The server only carries the invite and the connection set-up (ops duelStart / duelEnd / duelSignal / duelSignals).
   The match itself runs between the two browsers over a WebRTC data channel; each browser is the referee for its own player
   (position, health), so it suits friends, not ranked play. Needs app.js first (api, state, room, playerId, toast, $). */
"use strict";

const DUEL_THREE = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
const DUEL_WIN = 5, DUEL_HP = 100, DUEL_BODY = 25, DUEL_HEAD = 40, DUEL_FIRE_MS = 250, DUEL_RESPAWN_MS = 2000, DUEL_SAFE_MS = 1500;
const DUEL_HALF = 30; // the arena is 60 x 60
// cover: x, z, width, depth, height
const DUEL_BOXES = [[0, 0, 6, 6, 3], [-15, -12, 8, 2, 2.5], [15, 12, 8, 2, 2.5], [-14, 14, 2, 8, 2.5], [14, -14, 2, 8, 2.5],
  [0, -20, 10, 2, 2], [0, 20, 10, 2, 2], [-22, 0, 2, 6, 2], [22, 0, 2, 6, 2], [-8, 8, 3, 3, 1.4], [8, -8, 3, 3, 1.4]];
const DUEL_SPAWNS = [[-25, -25], [25, 25], [-25, 25], [25, -25]];
const DUEL_STUN = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];

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

/** Opens the match. `solo` (tests only) runs the arena with a still dummy and no connection. */
async function duelOpen({ host, oppId, oppName, solo }) {
  if (duel) return;
  const d = duel = {
    host, oppId, oppName: oppName || "Opponent", solo: Boolean(solo), closed: false,
    me: { x: 0, z: 0, yaw: 0, el: -0.2, hp: DUEL_HP, dead: false, safeUntil: 0, moving: false },
    opp: { x: 0, z: 0, yaw: 0, tx: 0, tz: 0, tyaw: 0, hp: DUEL_HP, dead: false, seen: false },
    kills: 0, deaths: 0, over: false, rematch: [false, false], keys: {}, fireDown: false, lastShot: 0, lastSend: 0,
    joy: null, look: null, tracers: [], status: "Loading the arena…", pc: null, sid: "", chFast: null, chSafe: null,
    connected: false, relayTried: false, startedAt: 0, queue: [], timers: [], listeners: [], flash: 0, marker: 0,
  };
  duelBuildUi(d);
  try { await duelLoadThree(); } catch (e) { toast(e.message); duelClose(); return; }
  if (d.closed) return;
  try { duelBuildWorld(d); } catch (e) { toast("This browser could not start 3D graphics, so the duel cannot open."); duelClose(true); return; }
  duelSpawn(d, host ? 0 : 1);
  d.opp.x = d.opp.tx = DUEL_SPAWNS[host ? 1 : 0][0];
  d.opp.z = d.opp.tz = DUEL_SPAWNS[host ? 1 : 0][1];
  duelBind(d);
  d.last = performance.now();
  d.raf = requestAnimationFrame((t) => duelFrame(d, t));
  if (d.solo) { d.status = ""; d.connected = true; } else duelConnect(d);
  duelHud(d);
}

/* ---------------- screen ---------------- */

function duelBuildUi(d) {
  const root = document.createElement("div");
  root.id = "duel";
  root.innerHTML =
    '<canvas id="duelCanvas"></canvas>' +
    '<div class="duel-top"><div id="duelScore"></div><button id="duelLeave" type="button">✕ Leave</button></div>' +
    '<div id="duelCross"></div><div id="duelHit"></div><div id="duelFlash"></div>' +
    '<div id="duelMsg"></div>' +
    '<div class="duel-hp"><div id="duelHpBar"></div><span id="duelHpTxt"></span></div>' +
    '<button id="duelFire" type="button" aria-label="Fire">🔫</button>' +
    '<div id="duelStick"><i></i></div>' +
    '<div id="duelOver" class="hidden"><h2 id="duelOverTitle"></h2><p id="duelOverSub"></p>' +
    '<button id="duelAgain" type="button">Rematch</button><button id="duelOut" type="button" class="ghost">Back to lobby</button></div>' +
    '<div id="duelHelp">WASD move · mouse look · click to shoot · Esc frees the mouse</div>';
  document.body.appendChild(root);
  d.root = root;
  d.touch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  root.classList.toggle("touch", d.touch);
  root.querySelector("#duelLeave").addEventListener("click", () => duelClose(true));
  root.querySelector("#duelOut").addEventListener("click", () => duelClose(true));
  root.querySelector("#duelAgain").addEventListener("click", () => {
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
  r.querySelector("#duelScore").textContent = "You " + d.kills + "  –  " + d.deaths + " " + d.oppName + "   (first to " + DUEL_WIN + ")";
  r.querySelector("#duelHpBar").style.width = Math.max(0, d.me.hp) + "%";
  r.querySelector("#duelHpTxt").textContent = Math.max(0, Math.round(d.me.hp));
  const m = r.querySelector("#duelMsg");
  m.textContent = d.me.dead && !d.over ? "You were hit — back in a moment…" : d.status;
  m.classList.toggle("hidden", !m.textContent);
  const o = r.querySelector("#duelOver");
  o.classList.toggle("hidden", !d.over);
  if (d.over) {
    const won = d.kills >= DUEL_WIN;
    r.querySelector("#duelOverTitle").textContent = won ? "🏆 You win!" : d.oppName + " wins";
    r.querySelector("#duelOverSub").textContent = d.kills + " – " + d.deaths + (d.rematch[0] ? "  ·  waiting for " + d.oppName + " to accept the rematch" : "");
    r.querySelector("#duelAgain").disabled = d.rematch[0] || !d.connected;
  }
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
  try { if (d.renderer) { d.renderer.dispose(); } } catch (e) { /* ignore */ }
  if (d.root) d.root.remove();
  if (state) duelSync(state);
}

/* ---------------- the arena ---------------- */

function duelBuildWorld(d) {
  const T = window.THREE;
  const canvas = d.root.querySelector("#duelCanvas");
  const r = d.renderer = new T.WebGLRenderer({ canvas, antialias: !d.touch });
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, d.touch ? 1.5 : 2));
  const sc = d.scene = new T.Scene();
  sc.background = new T.Color(0x9ec9ff);
  sc.fog = new T.Fog(0x9ec9ff, 40, 110);
  sc.add(new T.HemisphereLight(0xffffff, 0x556677, 0.85));
  const sun = new T.DirectionalLight(0xffffff, 0.7);
  sun.position.set(20, 40, 10);
  sc.add(sun);
  d.cam = new T.PerspectiveCamera(65, 1, 0.1, 200);
  const ground = new T.Mesh(new T.PlaneGeometry(DUEL_HALF * 2, DUEL_HALF * 2), new T.MeshLambertMaterial({ color: 0x6fae6b }));
  ground.rotation.x = -Math.PI / 2;
  sc.add(ground);
  sc.add(new T.GridHelper(DUEL_HALF * 2, 30, 0x4f8a4b, 0x5d9a59));
  d.solids = [];
  const cols = [0x8a7a6a, 0x9a8f80, 0x7d8a99, 0xa07a5a];
  DUEL_BOXES.forEach(([x, z, w, dp, h], i) => {
    const m = new T.Mesh(new T.BoxGeometry(w, h, dp), new T.MeshLambertMaterial({ color: cols[i % cols.length] }));
    m.position.set(x, h / 2, z);
    sc.add(m);
    d.solids.push(m);
  });
  [[0, -DUEL_HALF, DUEL_HALF * 2, 1], [0, DUEL_HALF, DUEL_HALF * 2, 1], [-DUEL_HALF, 0, 1, DUEL_HALF * 2], [DUEL_HALF, 0, 1, DUEL_HALF * 2]].forEach(([x, z, w, dp]) => {
    const m = new T.Mesh(new T.BoxGeometry(w, 4, dp), new T.MeshLambertMaterial({ color: 0x55606b }));
    m.position.set(x, 2, z);
    sc.add(m);
    d.solids.push(m);
  });
  sc.updateMatrixWorld(true);
  d.meMesh = duelFigure(T, d.host ? 0x3b82f6 : 0xef4444);
  d.oppMesh = duelFigure(T, d.host ? 0xef4444 : 0x3b82f6);
  d.oppTag = duelTag(T, d.oppName);
  d.oppTag.sprite.position.set(0, 2.15, 0);
  d.oppMesh.add(d.oppTag.sprite);
  sc.add(d.meMesh, d.oppMesh);
  duelResize(d);
}

function duelFigure(T, color) {
  const g = new T.Group();
  const mat = new T.MeshLambertMaterial({ color });
  const body = new T.Mesh(new T.CylinderGeometry(0.34, 0.4, 1.1, 14), mat);
  body.position.y = 0.65;
  const head = new T.Mesh(new T.SphereGeometry(0.24, 14, 12), new T.MeshLambertMaterial({ color: 0xf1d3b3 }));
  head.position.y = 1.5;
  const gun = new T.Mesh(new T.BoxGeometry(0.1, 0.12, 0.7), new T.MeshLambertMaterial({ color: 0x222222 }));
  gun.position.set(0.3, 1.1, -0.45);
  g.add(body, head, gun);
  return g;
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
    x.fillStyle = "rgba(0,0,0,.55)"; x.fillRect(10, 26, 140, 10);
    x.fillStyle = hp > 50 ? "#22c55e" : hp > 25 ? "#eab308" : "#ef4444"; x.fillRect(10, 26, 1.4 * Math.max(0, hp), 10);
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
  duelOn(d, window, "keydown", (e) => { if (!d.over) d.keys[e.code] = true; if (/^(Space|Arrow)/.test(e.code)) e.preventDefault(); });
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
    d.me.yaw -= e.movementX * 0.0025;
    d.me.el = Math.max(-0.9, Math.min(0.6, d.me.el - e.movementY * 0.0025));
  });
  // touch: left side is a stick, right side turns the view, the button fires
  const fire = d.root.querySelector("#duelFire"), stick = d.root.querySelector("#duelStick");
  duelOn(d, fire, "touchstart", (e) => { d.fireDown = true; e.preventDefault(); e.stopPropagation(); }, { passive: false });
  duelOn(d, fire, "touchend", (e) => { d.fireDown = false; e.preventDefault(); e.stopPropagation(); }, { passive: false });
  duelOn(d, fire, "touchcancel", () => { d.fireDown = false; });
  duelOn(d, canvas, "touchstart", (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.clientX < window.innerWidth * 0.45 && !d.joy) {
        d.joy = { id: t.identifier, x: t.clientX, y: t.clientY, dx: 0, dy: 0 };
        stick.style.cssText = "display:block;left:" + (t.clientX - 50) + "px;top:" + (t.clientY - 50) + "px";
        stick.firstChild.style.transform = "translate(0,0)";
      } else if (t.clientX >= window.innerWidth * 0.45 && !d.look) d.look = { id: t.identifier, x: t.clientX, y: t.clientY };
    }
  }, { passive: false });
  duelOn(d, canvas, "touchmove", (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (d.joy && t.identifier === d.joy.id) {
        let dx = (t.clientX - d.joy.x) / 50, dy = (t.clientY - d.joy.y) / 50;
        const m = Math.hypot(dx, dy);
        if (m > 1) { dx /= m; dy /= m; }
        d.joy.dx = dx; d.joy.dy = dy;
        stick.firstChild.style.transform = "translate(" + dx * 30 + "px," + dy * 30 + "px)";
      } else if (d.look && t.identifier === d.look.id) {
        d.me.yaw -= (t.clientX - d.look.x) * 0.006;
        d.me.el = Math.max(-0.9, Math.min(0.6, d.me.el - (t.clientY - d.look.y) * 0.006));
        d.look.x = t.clientX; d.look.y = t.clientY;
      }
    }
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) {
      if (d.joy && t.identifier === d.joy.id) { d.joy = null; stick.style.display = "none"; }
      if (d.look && t.identifier === d.look.id) d.look = null;
    }
  };
  duelOn(d, canvas, "touchend", end);
  duelOn(d, canvas, "touchcancel", end);
}

/* ---------------- the game loop ---------------- */

const duelHitsBox = (x, z, r) => DUEL_BOXES.some(([bx, bz, w, dp]) => Math.abs(x - bx) < w / 2 + r && Math.abs(z - bz) < dp / 2 + r);

function duelSpawn(d, i) {
  d.me.x = DUEL_SPAWNS[i][0];
  d.me.z = DUEL_SPAWNS[i][1];
  d.me.yaw = Math.atan2(d.me.x, d.me.z); // facing the middle: forward is (-sin yaw, -cos yaw)
  d.me.el = -0.2;
  d.me.hp = DUEL_HP;
  d.me.dead = false;
  d.me.safeUntil = performance.now() + DUEL_SAFE_MS;
}

function duelFrame(d, now) {
  if (d.closed) return;
  d.raf = requestAnimationFrame((t) => duelFrame(d, t));
  const dt = Math.min(0.05, (now - d.last) / 1000);
  d.last = now;
  const me = d.me;
  if (!me.dead && !d.over) {
    let fx = 0, fz = 0; // forward / strafe input
    if (d.keys.KeyW || d.keys.ArrowUp) fz += 1;
    if (d.keys.KeyS || d.keys.ArrowDown) fz -= 1;
    if (d.keys.KeyD || d.keys.ArrowRight) fx += 1;
    if (d.keys.KeyA || d.keys.ArrowLeft) fx -= 1;
    if (d.joy) { fx += d.joy.dx; fz -= d.joy.dy; }
    const m = Math.hypot(fx, fz);
    me.moving = m > 0.05;
    if (me.moving) {
      if (m > 1) { fx /= m; fz /= m; }
      const sp = 6 * dt, sy = Math.sin(me.yaw), cy = Math.cos(me.yaw);
      const dx = (-sy * fz + cy * fx) * sp, dz = (-cy * fz - sy * fx) * sp;
      const lim = DUEL_HALF - 0.8;
      const nx = Math.max(-lim, Math.min(lim, me.x + dx));
      if (!duelHitsBox(nx, me.z, 0.5)) me.x = nx;
      const nz = Math.max(-lim, Math.min(lim, me.z + dz));
      if (!duelHitsBox(me.x, nz, 0.5)) me.z = nz;
    }
    if (d.fireDown && now - d.lastShot >= DUEL_FIRE_MS && d.connected) { d.lastShot = now; duelShoot(d); }
  }
  // the opponent glides to the last place they reported
  const o = d.opp, k = Math.min(1, dt * 14);
  o.x += (o.tx - o.x) * k;
  o.z += (o.tz - o.z) * k;
  let dy = o.tyaw - o.yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  o.yaw += dy * k;
  duelDraw(d, now);
  if (now - d.lastSend > 50 && d.connected && !d.solo) {
    d.lastSend = now;
    duelSend(d, "fast", { t: "p", x: +me.x.toFixed(2), z: +me.z.toFixed(2), yaw: +me.yaw.toFixed(3), hp: me.hp, d: me.dead ? 1 : 0 });
  }
  d.flash = Math.max(0, d.flash - dt * 2.5);
  d.marker = Math.max(0, d.marker - dt * 4);
  d.root.querySelector("#duelFlash").style.opacity = d.flash;
  d.root.querySelector("#duelHit").style.opacity = d.marker;
}

function duelAim(d) {
  const me = d.me, ce = Math.cos(me.el);
  return { a: [-Math.sin(me.yaw) * ce, Math.sin(me.el), -Math.cos(me.yaw) * ce], right: [Math.cos(me.yaw), 0, -Math.sin(me.yaw)] };
}

/** Over the player's right shoulder, 4.2 behind; the crosshair is the middle of this view. */
function duelCamPos(d) {
  const me = d.me, { a, right } = duelAim(d), dist = 4.2, lim = DUEL_HALF - 0.3;
  return [Math.max(-lim, Math.min(lim, me.x - a[0] * dist + right[0] * 0.8)), Math.max(0.5, 1.6 - a[1] * dist), Math.max(-lim, Math.min(lim, me.z - a[2] * dist + right[2] * 0.8))];
}

function duelDraw(d, now) {
  const T = window.THREE, me = d.me, o = d.opp;
  d.meMesh.position.set(me.x, 0, me.z);
  d.meMesh.rotation.y = me.yaw;
  d.meMesh.visible = !me.dead && !(now < me.safeUntil && Math.floor(now / 120) % 2);
  d.oppMesh.position.set(o.x, 0, o.z);
  d.oppMesh.rotation.y = o.yaw;
  d.oppMesh.visible = !o.dead && (d.connected || d.solo);
  if (d.oppTag.hp !== o.hp) { d.oppTag.hp = o.hp; d.oppTag.draw(o.hp); }
  const { a } = duelAim(d);
  const cp = duelCamPos(d);
  d.cam.position.set(cp[0], cp[1], cp[2]);
  d.cam.lookAt(d.cam.position.x + a[0] * 50, d.cam.position.y + a[1] * 50, d.cam.position.z + a[2] * 50);
  d.tracers = d.tracers.filter((t) => {
    t.life -= 1;
    if (t.life <= 0) { d.scene.remove(t.line); t.line.geometry.dispose(); return false; }
    t.line.material.opacity = t.life / 6;
    return true;
  });
  d.renderer.render(d.scene, d.cam);
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

function duelShoot(d) {
  const T = window.THREE, me = d.me, { a, right } = duelAim(d);
  const cam = duelCamPos(d), dist = 4.2;
  const origin = [cam[0] + a[0] * dist, cam[1] + a[1] * dist, cam[2] + a[2] * dist];
  const ray = new T.Raycaster(new T.Vector3(...origin), new T.Vector3(...a), 0, 90);
  const wall = ray.intersectObjects(d.solids, false)[0];
  let tMax = wall ? wall.distance : 90, hit = 0;
  const o = d.opp;
  if (!o.dead) {
    const head = duelRaySphere(origin, a, [o.x, 1.5, o.z], 0.28);
    const body = duelRaySphere(origin, a, [o.x, 0.75, o.z], 0.55);
    if (head >= 0 && head < tMax) { tMax = head; hit = DUEL_HEAD; }
    else if (body >= 0 && body < tMax) { tMax = body; hit = DUEL_BODY; }
  }
  const muzzle = [me.x + right[0] * 0.3 + -Math.sin(me.yaw) * 0.6, 1.15, me.z + right[2] * 0.3 + -Math.cos(me.yaw) * 0.6];
  const end = [origin[0] + a[0] * tMax, origin[1] + a[1] * tMax, origin[2] + a[2] * tMax];
  duelTracer(d, muzzle, end);
  duelSend(d, "fast", { t: "shot", a: muzzle, b: end });
  if (hit) {
    d.marker = 1;
    o.hp = Math.max(0, o.hp - hit);
    duelSend(d, "safe", { t: "hit", d: hit });
  }
}

function duelTracer(d, a, b) {
  const T = window.THREE;
  const g = new T.BufferGeometry().setFromPoints([new T.Vector3(...a), new T.Vector3(...b)]);
  const line = new T.Line(g, new T.LineBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 1 }));
  d.scene.add(line);
  d.tracers.push({ line, life: 6 });
}

function duelGotHit(d, dmg) {
  const me = d.me, now = performance.now();
  if (me.dead || d.over || now < me.safeUntil) return;
  me.hp = Math.max(0, me.hp - dmg);
  d.flash = 1;
  if (me.hp > 0) { duelHud(d); return; }
  me.dead = true;
  d.deaths++;
  duelSend(d, "safe", { t: "died" });
  if (d.deaths >= DUEL_WIN) { d.over = true; document.exitPointerLock && document.exitPointerLock(); }
  else {
    const spot = DUEL_SPAWNS.map((p, i) => [Math.hypot(p[0] - d.opp.x, p[1] - d.opp.z), i]).sort((x, y) => y[0] - x[0])[0][1];
    d.timers.push(setTimeout(() => { if (!d.closed && !d.over) { duelSpawn(d, spot); duelHud(d); } }, DUEL_RESPAWN_MS));
  }
  duelHud(d);
}

/* ---------------- messages from the other browser ---------------- */

function duelOnMessage(d, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  const o = d.opp;
  switch (m.t) {
    case "p": o.tx = +m.x || 0; o.tz = +m.z || 0; o.tyaw = +m.yaw || 0; o.hp = +m.hp; o.dead = Boolean(m.d); if (!o.seen) { o.seen = true; o.x = o.tx; o.z = o.tz; o.yaw = o.tyaw; } break;
    case "shot": if (Array.isArray(m.a) && Array.isArray(m.b)) duelTracer(d, m.a.map(Number), m.b.map(Number)); break;
    case "hit": duelGotHit(d, m.d === DUEL_HEAD ? DUEL_HEAD : DUEL_BODY); break;
    case "died":
      if (!d.over) { d.kills++; o.dead = true; if (d.kills >= DUEL_WIN) { d.over = true; document.exitPointerLock && document.exitPointerLock(); } }
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
