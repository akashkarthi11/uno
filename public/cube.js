/* 3D Rubik's cube: drag a face to turn it, drag the background to look around, scramble, race the clock, best times for the room.
   The cube runs in this browser; the server only keeps each player's best time (op cubeTime) and sends the list in state.cube.
   Needs app.js first (api, apply, state, toast, $). Uses the same three.js build as the duel. */
"use strict";

const CUBE_THREE = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
// classic colours: +y white, -y yellow, +z green, -z blue, +x red, -x orange
const CUBE_COLORS = { "0,1,0": 0xf4f4f0, "0,-1,0": 0xffd10a, "0,0,1": 0x00a04a, "0,0,-1": 0x0a4ac8, "1,0,0": 0xc8102e, "-1,0,0": 0xff5a00 };
const CUBE_SCRAMBLE_MOVES = 22;

let cube = null; // the running puzzle: { T, renderer, scene, camera, group, cubies, stickers, ... }
let cubeBoard = [];
let cubeFloor = null; // the shadow plane under the cube, hidden when you look from below

function cubeLoadThree() {
  if (window.THREE) return Promise.resolve();
  return new Promise((ok, no) => {
    const el = document.createElement("script");
    el.src = CUBE_THREE;
    el.onload = ok;
    el.onerror = () => no(new Error("The 3D engine could not be loaded. Check your connection."));
    document.head.appendChild(el);
  });
}

const cubeFmt = (ms) => { const t = Math.floor(ms / 100), m = Math.floor(t / 600), s = Math.floor((t % 600) / 10); return m + ":" + String(s).padStart(2, "0") + "." + (t % 10); };
const cubeAxis = (v) => { // the nearest of the six axis directions
  const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)], i = a.indexOf(Math.max(...a));
  return new cube.T.Vector3(i === 0 ? Math.sign(v.x) : 0, i === 1 ? Math.sign(v.y) : 0, i === 2 ? Math.sign(v.z) : 0);
};

function cubeStyle() {
  if (document.getElementById("cubeCss")) return;
  const st = document.createElement("style");
  st.id = "cubeCss";
  st.textContent = `
.cube-box { position: fixed; inset: 0; z-index: 90; background: radial-gradient(ellipse at 50% 35%, #2b2f4f 0%, #14162b 55%, #0a0b18 100%); color: #eef0ff; touch-action: none; user-select: none; -webkit-user-select: none; }
.cube-box.hidden { display: none; }
.cube-stage { position: absolute; inset: 0; }
.cube-stage canvas { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
.cube-top, .cube-bar { position: absolute; left: 0; right: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px max(14px, env(safe-area-inset-left)) 12px max(14px, env(safe-area-inset-right)); pointer-events: none; }
.cube-top { top: env(safe-area-inset-top, 0px); }
.cube-bar { bottom: env(safe-area-inset-bottom, 0px); justify-content: center; flex-wrap: wrap; }
.cube-box button { pointer-events: auto; font: inherit; font-weight: 700; color: #eef0ff; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.22); border-radius: 14px; padding: 10px 13px; min-height: 44px; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); box-shadow: 0 6px 18px rgba(0,0,0,.35); cursor: pointer; }
.cube-box button:active { transform: scale(.96); }
.cube-box button.primary { background: linear-gradient(135deg, #7c5cf0, #4f7cff); border-color: transparent; }
.cube-stat { display: flex; flex-direction: column; align-items: center; line-height: 1.1; text-shadow: 0 2px 10px rgba(0,0,0,.6); }
.cube-stat b { font-size: 30px; font-variant-numeric: tabular-nums; letter-spacing: .5px; }
.cube-stat span { font-size: 13px; opacity: .75; }
.cube-pad { position: absolute; left: 0; right: 0; bottom: calc(72px + env(safe-area-inset-bottom, 0px)); display: flex; gap: 9px; justify-content: center; align-items: center; padding: 0 12px; pointer-events: none; }
.cube-box .cube-dot { width: 40px; height: 40px; min-height: 0; padding: 0; border-radius: 50%; border: 2px solid rgba(255,255,255,.55); box-shadow: 0 3px 10px rgba(0,0,0,.45), inset 0 -4px 8px rgba(0,0,0,.2), inset 0 3px 6px rgba(255,255,255,.35); }
.cube-box .cube-dirbtn { width: 44px; height: 44px; min-height: 0; padding: 0; border-radius: 50%; font-size: 22px; }
.cube-hint { position: absolute; left: 0; right: 0; bottom: calc(126px + env(safe-area-inset-bottom, 0px)); text-align: center; font-size: 13px; opacity: .7; pointer-events: none; padding: 0 20px; }
.cube-board, .cube-win { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(92vw, 360px); max-height: 80vh; overflow: auto; background: rgba(18,20,40,.92); border: 1px solid rgba(255,255,255,.18); border-radius: 20px; padding: 18px; box-shadow: 0 20px 60px rgba(0,0,0,.6); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
.cube-board.hidden, .cube-win.hidden { display: none; }
.cube-board h3, .cube-win h3 { margin: 0 0 10px; font-size: 18px; }
.cube-board ol { margin: 0 0 12px; padding: 0 0 0 22px; display: grid; gap: 6px; font-size: 15px; }
.cube-board li span { float: right; font-variant-numeric: tabular-nums; opacity: .85; }
.cube-win { text-align: center; animation: cube-pop .45s cubic-bezier(.2,1.4,.4,1); }
.cube-win .big { font-size: 38px; font-weight: 800; font-variant-numeric: tabular-nums; margin: 4px 0 2px; }
.cube-win .row { display: flex; gap: 8px; justify-content: center; margin-top: 14px; }
@keyframes cube-pop { from { transform: translate(-50%, -50%) scale(.7); opacity: 0; } to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }
`;
  document.head.appendChild(st);
}

function cubeDom() {
  let box = document.getElementById("cubeBox");
  if (box) return box;
  cubeStyle();
  box = document.createElement("div");
  box.id = "cubeBox";
  box.className = "cube-box hidden";
  box.innerHTML = `
  <div class="cube-stage" id="cubeStage"></div>
  <div class="cube-top">
    <button id="cubeClose" type="button" aria-label="Close">✕</button>
    <div class="cube-stat"><b id="cubeClock">0:00.0</b><span id="cubeMoves">0 moves</span></div>
    <button id="cubeTop" type="button" aria-label="Best times">🏆</button>
  </div>
  <div class="cube-hint" id="cubeHint">Drag a face: it follows your finger. Drag the background to look around.</div>
  <div class="cube-pad" id="cubePad" aria-label="Turn a face">
    ${Object.values(CUBE_COLORS).map((c) => `<button type="button" class="cube-dot" data-col="${c}" style="background:#${c.toString(16).padStart(6, "0")}" aria-label="Turn this colour's face"></button>`).join("")}
    <button type="button" id="cubeDir" class="cube-dirbtn" aria-label="Direction">↻</button>
  </div>
  <div class="cube-bar">
    <button id="cubeScramble" class="primary" type="button">🔀 Scramble</button>
    <button id="cubeUndo" type="button">↶ Undo</button>
    <button id="cubeView" type="button" aria-label="Reset the view">🧭 View</button>
    <button id="cubeReset" type="button">↺ Reset</button>
  </div>
  <div class="cube-board hidden" id="cubeBoard"></div>
  <div class="cube-win hidden" id="cubeWin"></div>`;
  document.body.appendChild(box);
  const q = (id) => box.querySelector("#" + id);
  q("cubeClose").addEventListener("click", cubeClose);
  q("cubeScramble").addEventListener("click", () => cubeScramble());
  q("cubeReset").addEventListener("click", () => { cubeBuild(); cubeStatus(false); });
  q("cubeUndo").addEventListener("click", cubeUndo);
  let ccw = false;
  box.querySelectorAll(".cube-dot").forEach((b) => b.addEventListener("click", () => cubeFaceTurn(Number(b.dataset.col), ccw)));
  q("cubeDir").addEventListener("click", () => { ccw = !ccw; q("cubeDir").textContent = ccw ? "↺" : "↻"; });
  q("cubeView").addEventListener("click", () => { cube.tx = 1.05; cube.ty = 0.75; });
  q("cubeTop").addEventListener("click", () => { cubeRenderBoard(); q("cubeBoard").classList.toggle("hidden"); });
  return box;
}

function cubeRenderBoard() {
  const b = document.getElementById("cubeBoard");
  if (!b) return;
  const rows = cubeBoard.map((e, i) => `<li>${["🥇", "🥈", "🥉"][i] || ""} ${e.name.replace(/[<>&"]/g, "")}<span>${cubeFmt(e.ms)} · ${e.moves} moves</span></li>`).join("");
  b.innerHTML = `<h3>🏆 Best times in this room</h3>` + (rows ? `<ol>${rows}</ol>` : `<p style="opacity:.75">No solves yet. Scramble the cube and be the first.</p>`) +
    `<button type="button" id="cubeBoardX">Close</button>`;
  b.querySelector("#cubeBoardX").addEventListener("click", () => b.classList.add("hidden"));
}

function cubeStatus(running) {
  cube.running = running;
  cube.moves = 0;
  cube.t0 = 0;
  document.getElementById("cubeMoves").textContent = "0 moves";
  document.getElementById("cubeClock").textContent = "0:00.0";
}

/** Builds (or rebuilds) the 27 small cubes: a dark plastic body with rounded, glossy stickers on the outside faces. */
function cubeBuild() {
  const T = cube.T;
  while (cube.group.children.length) cube.group.remove(cube.group.children[0]);
  cube.cubies = [];
  cube.stickers = [];
  cube.queue = [];
  cube.hist = []; // your own turns, so Undo can take them back
  cube.busy = false;
  cube.scrambled = false;
  const body = new T.BoxGeometry(0.97, 0.97, 0.97);
  const bodyMat = new T.MeshStandardMaterial({ color: 0x0b0b0e, roughness: 0.6, metalness: 0.04 });
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    const c = new T.Group();
    c.position.set(x, y, z);
    const m = new T.Mesh(body, bodyMat);
    m.castShadow = true;
    m.receiveShadow = true;
    c.add(m);
    for (const [nx, ny, nz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (nx * x + ny * y + nz * z !== 1) continue; // only faces on the outside of the cube
      const mat = new T.MeshPhysicalMaterial({ color: new T.Color(CUBE_COLORS[nx + "," + ny + "," + nz]).convertSRGBToLinear(), roughness: 0.32, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.28 });
      const s = new T.Mesh(cube.stickerGeo, mat);
      s.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), new T.Vector3(nx, ny, nz));
      s.position.set(nx * 0.485, ny * 0.485, nz * 0.485);
      s.castShadow = false;
      s.userData.col = CUBE_COLORS[nx + "," + ny + "," + nz];
      c.add(s);
      cube.stickers.push(s);
    }
    c.userData.cubie = true;
    cube.group.add(c);
    cube.cubies.push(c);
  }
}

function cubeStickerGeo(T) {
  const h = 0.43, r = 0.12, s = new T.Shape();
  s.moveTo(-h + r, -h); s.lineTo(h - r, -h); s.quadraticCurveTo(h, -h, h, -h + r); s.lineTo(h, h - r); s.quadraticCurveTo(h, h, h - r, h);
  s.lineTo(-h + r, h); s.quadraticCurveTo(-h, h, -h, h - r); s.lineTo(-h, -h + r); s.quadraticCurveTo(-h, -h, -h + r, -h);
  return new T.ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 2, curveSegments: 6 });
}

const cubeEase = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Settles a layer from its current angle to a whole number of quarter turns, then puts its pieces back in the cube, snapped to the grid. */
function cubeSettle(pivot, turning, axis, from, quarters, ms, done) {
  const T = cube.T, to = (quarters * Math.PI) / 2, t0 = performance.now();
  const step = (now) => {
    const k = ms <= 0 ? 1 : Math.min(1, (now - t0) / ms);
    pivot.quaternion.setFromAxisAngle(axis, from + (to - from) * cubeEase(k));
    if (k < 1) { requestAnimationFrame(step); return; }
    pivot.quaternion.setFromAxisAngle(axis, to);
    pivot.updateMatrixWorld(true);
    turning.forEach((c) => {
      cube.group.attach(c);
      c.position.set(Math.round(c.position.x), Math.round(c.position.y), Math.round(c.position.z)); // no drift after many turns
      const e = new T.Matrix4().makeRotationFromQuaternion(c.quaternion);
      e.elements = e.elements.map((v) => Math.round(v));
      c.quaternion.setFromRotationMatrix(e);
    });
    cube.group.remove(pivot);
    done();
  };
  requestAnimationFrame(step);
}
const cubeLayer = (axis, layer) => cube.cubies.filter((c) => Math.round(c.position.dot(axis)) === layer);
function cubeGrab(axis, layer) {
  const pivot = new cube.T.Group();
  cube.group.add(pivot);
  const turning = cubeLayer(axis, layer);
  turning.forEach((c) => pivot.attach(c));
  return { pivot, turning };
}

/** Turns one layer a quarter turn (dir +1 or -1 about the axis), animated; moves queued behind it run in order. `record` keeps it for Undo. */
function cubeTurn(axis, layer, dir, ms, byUser, record) {
  if (byUser && cube.scrambled && !cube.running) { cube.running = true; cube.t0 = performance.now(); } // the clock starts with the first turn
  if (record) cube.hist.push({ axis: axis.clone(), layer, dir });
  cube.queue.push({ axis: axis.clone(), layer, dir, ms, byUser });
  if (!cube.busy) cubeNext();
}
function cubeNext() {
  const mv = cube.queue.shift();
  if (!mv) { cube.busy = false; return; }
  cube.busy = true;
  const { pivot, turning } = cubeGrab(mv.axis, mv.layer);
  cubeSettle(pivot, turning, mv.axis, 0, mv.dir, mv.ms, () => {
    if (mv.byUser) cubeAfterUserMove(1);
    cubeNext();
  });
}

function cubeSolved() {
  const T = cube.T, seen = {};
  cube.group.updateMatrixWorld(true);
  const q = new T.Quaternion(), n = new T.Vector3();
  for (const s of cube.stickers) {
    s.getWorldQuaternion(q);
    n.set(0, 0, 1).applyQuaternion(q);
    const key = Math.round(n.x) + "," + Math.round(n.y) + "," + Math.round(n.z);
    if (seen[key] === undefined) seen[key] = s.userData.col;
    else if (seen[key] !== s.userData.col) return false;
  }
  return true;
}

function cubeAfterUserMove(turns) {
  if (navigator.vibrate) navigator.vibrate(12);
  if (!cube.scrambled) return;
  cube.moves += turns;
  document.getElementById("cubeMoves").textContent = cube.moves + (cube.moves === 1 ? " move" : " moves");
  if (cube.running && cubeSolved()) cubeWin();
}

/** Takes back your last turn (it still counts as a move, so the result stays honest). */
function cubeUndo() {
  if (!cube || cube.busy || cube.queue.length || !cube.hist.length) return;
  const last = cube.hist.pop();
  cubeTurn(last.axis, last.layer, -last.dir, 190, true, false);
}

function cubeScramble() {
  if (cube.busy || cube.queue.length) return;
  const T = cube.T, axes = [new T.Vector3(1, 0, 0), new T.Vector3(0, 1, 0), new T.Vector3(0, 0, 1)];
  document.getElementById("cubeWin").classList.add("hidden");
  cube.hist = [];
  cubeStatus(false);
  let last = -1;
  for (let i = 0; i < CUBE_SCRAMBLE_MOVES; i++) {
    let a; do { a = Math.floor(Math.random() * 3); } while (a === last);
    last = a;
    cubeTurn(axes[a], Math.floor(Math.random() * 3) - 1, Math.random() < 0.5 ? 1 : -1, 90, false);
  }
  const done = setInterval(() => {
    if (cube.busy || cube.queue.length) return;
    clearInterval(done);
    cube.scrambled = true;
    document.getElementById("cubeHint").textContent = "The clock starts with your first turn.";
  }, 60);
}

function cubeWin() {
  cube.running = false;
  cube.scrambled = false;
  const ms = Math.round(performance.now() - cube.t0), moves = cube.moves;
  const w = document.getElementById("cubeWin");
  const mine = cubeBoard.find((e) => state && e.name === (state.players.find((p) => p.id === state.you) || {}).name);
  const record = !mine || ms < mine.ms;
  w.innerHTML = `<h3>🎉 Solved!</h3><div class="big">${cubeFmt(ms)}</div><div style="opacity:.8">${moves} moves${record ? " · new personal best" : ""}</div>
    <div class="row"><button type="button" class="primary" id="cubeAgain">Scramble again</button><button type="button" id="cubeWinX">Close</button></div>`;
  w.classList.remove("hidden");
  w.querySelector("#cubeAgain").addEventListener("click", () => cubeScramble());
  w.querySelector("#cubeWinX").addEventListener("click", () => w.classList.add("hidden"));
  if (navigator.vibrate) navigator.vibrate([30, 40, 60]);
  if (state) api({ op: "cubeTime", ms, moves }).then(apply).catch(() => {}); // too-fast or too-short results are refused by the server; nothing to tell the player
}

/* ---- pointer: drag a face and the layer follows your finger (and settles on the nearest quarter turn); drag the background to look around ---- */
function cubePointer(el) {
  const T = cube.T, ray = new T.Raycaster(), v = new T.Vector2();
  let drag = null;
  const ndc = (e) => { const r = el.getBoundingClientRect(); v.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); return r; };
  const screenOf = (p, r) => { const q = p.clone().project(cube.camera); return [(q.x + 1) / 2 * r.width, (1 - q.y) / 2 * r.height]; };
  el.addEventListener("pointerdown", (e) => {
    if (drag) return;
    el.setPointerCapture(e.pointerId);
    const r = ndc(e);
    ray.setFromCamera(v, cube.camera);
    const hit = ray.intersectObjects(cube.group.children, true)[0];
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, at: performance.now(), r, face: null, live: null };
    if (hit && !cube.busy) {
      let o = hit.object;
      while (o && !o.userData.cubie) o = o.parent;
      const n = cubeAxis(hit.face.normal.clone().transformDirection(hit.object.matrixWorld));
      drag.face = { cubie: o, n, p: hit.point.clone() };
    }
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.live) { // the layer follows the finger
      const L = drag.live;
      const along = ((e.clientX - drag.x0) * L.sx + (e.clientY - drag.y0) * L.sy) / L.len2; // how far along the drag direction, in cube units
      const angle = Math.max(-Math.PI, Math.min(Math.PI, along / 1.5)); // a point 1.5 units out moves as far as the finger does
      const now = performance.now();
      if (now > L.t) L.vel = 0.5 * L.vel + 0.5 * ((angle - L.angle) / Math.max(1, now - L.t)); // radians per ms, smoothed
      L.angle = angle;
      L.t = now;
      L.pivot.quaternion.setFromAxisAngle(L.axis, angle);
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.face) { // look around
      cube.ty -= dx * 0.008;
      cube.tx = Math.max(0.15, Math.min(Math.PI - 0.15, cube.tx - dy * 0.008));
      drag.x = e.clientX; drag.y = e.clientY;
      return;
    }
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 10 || cube.busy) return;
    const { cubie, n, p } = drag.face;
    const base = screenOf(p, drag.r);
    const fx = e.clientX - drag.x0, fy = e.clientY - drag.y0;
    let best = null;
    for (const t of [new T.Vector3(1, 0, 0), new T.Vector3(0, 1, 0), new T.Vector3(0, 0, 1)]) {
      if (Math.abs(t.dot(n)) > 0.5) continue; // along the face's own normal: not a drag on the face
      const sc = screenOf(p.clone().add(t), drag.r);
      const d = (sc[0] - base[0]) * fx + (sc[1] - base[1]) * fy;
      if (!best || Math.abs(d) > Math.abs(best.d)) best = { t, d, s: [sc[0] - base[0], sc[1] - base[1]] };
    }
    drag.face = null;
    if (!best) return;
    const sign = Math.sign(best.d) || 1;
    const dir = best.t.clone().multiplyScalar(sign); // the way the finger moves, in the cube's own axes
    const axis = new T.Vector3().crossVectors(n, dir); // the turn that carries this spot along that way
    const layer = Math.round(cubie.position.dot(axis));
    cube.busy = true;
    const g = cubeGrab(axis, layer);
    const sx = best.s[0] * sign, sy = best.s[1] * sign;
    drag.live = { ...g, axis, layer, sx, sy, len2: sx * sx + sy * sy, angle: 0, vel: 0, t: performance.now() };
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const L = drag.live, at = drag.at;
    drag = null;
    if (!L) return;
    let q = Math.round(L.angle / (Math.PI / 2)); // the nearest quarter turn, or a quick flick the same way goes one further
    const vel = performance.now() - L.t > 80 ? 0 : L.vel; // a finger that rested before letting go is not a flick
    if (Math.abs(vel) > 0.0025 && Math.sign(vel) === Math.sign(L.angle) && Math.abs(L.angle) > 0.12) q = Math.sign(L.angle) * Math.max(1, Math.abs(q));
    if (q !== 0 && cube.scrambled && !cube.running) { cube.running = true; cube.t0 = at; } // the clock starts when the first real turn starts
    cubeSettle(L.pivot, L.turning, L.axis, L.angle, q, q === 0 ? 120 : 140, () => {
      for (let i = 0; i < Math.abs(q); i++) cube.hist.push({ axis: L.axis.clone(), layer: L.layer, dir: Math.sign(q) });
      cube.busy = false;
      if (q !== 0) cubeAfterUserMove(Math.abs(q));
      if (cube.queue.length) cubeNext();
    });
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("lostpointercapture", end);
}

/** A turn of one whole face, found by its colour (the centre piece names the face, wherever it is now), clockwise as you look at it. */
function cubeFaceTurn(color, ccw) {
  if (!cube || cube.busy || cube.queue.length) return;
  const T = cube.T, q = new T.Quaternion(), n = new T.Vector3();
  cube.group.updateMatrixWorld(true);
  for (const c of cube.cubies) {
    const st = c.children.filter((m) => m.userData.col !== undefined);
    if (st.length !== 1 || st[0].userData.col !== color) continue; // a centre piece has exactly one sticker
    st[0].getWorldQuaternion(q);
    n.set(0, 0, 1).applyQuaternion(q);
    const axis = cubeAxis(n);
    cubeTurn(axis, 1, ccw ? 1 : -1, 170, true, true); // turning clockwise, seen from outside, is a negative turn about the outward axis
    return;
  }
}

function cubeInit() {
  const T = window.THREE, stage = document.getElementById("cubeStage");
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.outputEncoding = T.sRGBEncoding;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  stage.appendChild(renderer.domElement);
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(38, 1, 0.1, 100);
  scene.add(new T.HemisphereLight(0xffffff, 0xb8c0ee, 0.6)); // the underside gets nearly as much light as the top
  for (const [x, y, z, k] of [[0, -1, 0, 0.5], [0, 0, -1, 0.45], [-1, 0, 0, 0.45], [1, 0, 0, 0.4], [0, 0, 1, 0.3]]) { // a soft light shining on each side
    const l = new T.DirectionalLight(0xffffff, k);
    l.position.set(x * 8, y * 8, z * 8);
    scene.add(l);
  }
  const key = new T.DirectionalLight(0xfff4e6, 0.85);
  key.position.set(4, 8, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 20 });
  key.shadow.radius = 5;
  scene.add(key);
  const floor = new T.Mesh(new T.PlaneGeometry(30, 30), new T.ShadowMaterial({ opacity: 0.28 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.35;
  floor.receiveShadow = true;
  scene.add(floor);
  cubeFloor = floor;
  const group = new T.Group();
  scene.add(group);
  cube = { T, renderer, scene, camera, group, stickerGeo: cubeStickerGeo(T), tx: 1.05, ty: 0.75, cx: 1.05, cy: 0.75, dist: 10, t0: 0, running: false, moves: 0, scale: 0.6 };
  cubeBuild();
  cubePointer(renderer.domElement);
  const fit = () => {
    const w = stage.clientWidth || 300, h = stage.clientHeight || 300;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    cube.dist = w / h < 0.8 ? 10 / Math.max(0.55, (w / h) / 0.8) : 10; // a narrow phone screen needs the camera further back
    camera.updateProjectionMatrix();
  };
  fit();
  cube.fit = fit;
  new ResizeObserver(fit).observe(stage);
}

function cubeLoop() {
  if (!cube || cube.stop) return;
  cube.cx += (cube.tx - cube.cx) * 0.18; // the camera glides to where you dragged it
  cube.cy += (cube.ty - cube.cy) * 0.18;
  cube.scale += (1 - cube.scale) * 0.12;
  cubeFloor.visible = cube.cx < 1.5;
  cube.group.scale.setScalar(cube.scale);
  const d = cube.dist;
  cube.camera.position.set(d * Math.sin(cube.cx) * Math.sin(cube.cy), d * Math.cos(cube.cx), d * Math.sin(cube.cx) * Math.cos(cube.cy));
  cube.camera.lookAt(0, 0, 0);
  if (cube.running) document.getElementById("cubeClock").textContent = cubeFmt(performance.now() - cube.t0);
  cube.renderer.render(cube.scene, cube.camera);
  requestAnimationFrame(cubeLoop);
}

async function cubeOpen() {
  const box = cubeDom();
  try {
    await cubeLoadThree();
    box.classList.remove("hidden"); // visible first, so the canvas can be measured
    if (!cube) cubeInit();
  } catch (e) { box.classList.add("hidden"); toast(e.message || "The cube could not start on this device."); return; }
  cube.stop = false;
  cube.scale = 0.6;
  cube.fit();
  document.getElementById("cubeHint").textContent = "Drag a face: it follows your finger. Tap a colour to turn that face.";
  cubeLoop();
}
function cubeClose() {
  if (!cube) return;
  cube.stop = true;
  document.getElementById("cubeBox").classList.add("hidden");
}

/** Called with every state update: the lobby button, and the room's best times. */
function cubeSync(s) {
  let b = document.getElementById("cubeBtn");
  if (!b) {
    b = document.createElement("button");
    b.id = "cubeBtn";
    b.type = "button";
    b.className = "ghost hidden";
    b.textContent = "🧊 Cube puzzle";
    b.addEventListener("click", cubeOpen);
    document.getElementById("botBtn").after(b);
  }
  b.classList.toggle("hidden", !s.cube || Boolean(s.observing));
  cubeBoard = s.cube || [];
  if (document.getElementById("cubeBoard") && !document.getElementById("cubeBoard").classList.contains("hidden")) cubeRenderBoard();
}
