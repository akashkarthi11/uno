import * as G from './_lib/game.js';
import { signToken, verifyToken } from './_lib/token.js';
import { readRoom, withRoom, usingRedis, pushSignal, takeSignals, benchmark } from './_lib/store.js';

const PLAYER_PASSWORD = process.env.GAME_PLAYER_PASSWORD || '123456';
const ADMIN_PASSWORD = process.env.GAME_ADMIN_PASSWORD || '110299';
const PRIVATE_PASSWORD = process.env.GAME_PRIVATE_PASSWORD || '281101';
const TOKEN_SALT = ADMIN_PASSWORD + '|' + PLAYER_PASSWORD + '|' + PRIVATE_PASSWORD; // new passwords sign everyone out

// Voice chat connects browsers directly; STUN finds the route. Add a TURN relay for strict networks by setting
// GAME_TURN_URLS (comma separated), GAME_TURN_USER and GAME_TURN_PASS.
const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
// Cloudflare Realtime TURN: set CF_TURN_KEY_ID and CF_TURN_API_TOKEN (a TURN key made in the Cloudflare dashboard) and
// the server mints short-lived relay credentials itself; nothing secret ever reaches the browser except those.
const CF_KEY = process.env.CF_TURN_KEY_ID;
const CF_TOKEN = process.env.CF_TURN_API_TOKEN;
const CF_BASE = process.env.CF_TURN_API || 'https://rtc.live.cloudflare.com';
const CF_TTL = 86400; // seconds a minted credential lives
let cfIce = null; // { servers, until }
let cfPending = null;

async function mintCloudflare() {
  const r = await fetch(`${CF_BASE}/v1/turn/keys/${CF_KEY}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: CF_TTL }),
    signal: AbortSignal.timeout(2000),
  });
  if (!r.ok) throw new Error('turn ' + r.status);
  const j = await r.json();
  const list = Array.isArray(j.iceServers) ? j.iceServers : j.iceServers ? [j.iceServers] : [];
  // keep only the relay entries; our own STUN list stays in front
  const relay = list.filter((s) => s && s.username && s.credential);
  if (!relay.length) throw new Error('turn: no relay entries');
  return relay;
}

/** Makes sure a relay credential is on hand (refreshed hourly at most). Never throws: without it voice just uses STUN. */
async function ensureIce() {
  if (!CF_KEY || !CF_TOKEN) return;
  const now = Date.now();
  if (cfIce && cfIce.until > now) return;
  if (!cfPending) {
    cfPending = mintCloudflare()
      .then((servers) => { cfIce = { servers, until: Date.now() + (CF_TTL * 1000) / 2 }; })
      .catch(() => { cfIce = cfIce && cfIce.until > now - CF_TTL * 500 ? { ...cfIce, until: Date.now() + 60000 } : null; })
      .finally(() => { cfPending = null; });
  }
  if (!cfIce) await cfPending; // first time on this instance: wait (2 s at most)
}

/**
 * "Direct" (the default, the original behaviour): STUN only, calls go straight between phones.
 * "Relay" (the admin switches it on): relay servers are added as a backup; a call uses them only when a direct route fails.
 */
function iceServers(relay) {
  const out = [...STUN];
  if (!relay) return out;
  if (cfIce) out.push(...cfIce.servers);
  const urls = (process.env.GAME_TURN_URLS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (urls.length) out.push({ urls, username: process.env.GAME_TURN_USER || '', credential: process.env.GAME_TURN_PASS || '' });
  return out;
}
const withIce = (state) => {
  if (state && state.canVoice) state.iceServers = iceServers(Boolean(state.settings && state.settings.voiceRelay));
  return state;
};

const cleanRoom = (raw) => (/^[A-Za-z0-9_-]{1,24}$/.test(String(raw ?? '').trim()) ? String(raw).trim() : 'main');

// Identifies the deployed version. Every answer carries it, so a page left open across a deploy can tell the player
// to reload instead of quietly running old code against the new server.
const BUILD = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || 'local';

export default async function handler(req, res) {
  // An API answer must never be kept by a browser, proxy or CDN (errors and the 405 included).
  if (res.setHeader) res.setHeader('Cache-Control', 'no-store, max-age=0');
  const sendJson = res.json.bind(res);
  res.json = (body) => sendJson({ build: BUILD, ...body });

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  await ensureIce();
  if (process.env.VERCEL && !usingRedis) {
    return res.status(500).json({ error: 'Storage not configured: add Upstash Redis to the Vercel project (KV_REST_API_URL / KV_REST_API_TOKEN).' });
  }

  let b;
  try {
    b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  } catch {
    return res.status(400).json({ error: 'Bad request.' });
  }
  const code = cleanRoom(b.room);
  const now = Date.now();

  try {
    // Admin-only speed check of each configured database, measured from this function (see README).
    if (b.op === 'bench') {
      if (String(b.password ?? '') !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Admin only.', denied: true });
      return res.json({ region: process.env.VERCEL_REGION || 'local', ...(await benchmark()) });
    }

    if (b.op === 'join') {
      const pw = String(b.password ?? '');
      const admin = pw === ADMIN_PASSWORD;
      if (!admin) {
        // The admin decides whether a game is public or private. Public games admit public players (123456)
        // only; private games admit private players (281101) only.
        const existing = await readRoom(code);
        const isPrivate = Boolean(existing && existing.private);
        if (pw !== (isPrivate ? PRIVATE_PASSWORD : PLAYER_PASSWORD)) {
          const msg = isPrivate && pw === PLAYER_PASSWORD
            ? 'Ask the admin to start the game and share the private password.'
            : 'Wrong password.';
          return res.status(401).json({ error: msg, denied: true });
        }
      }
      let claim;
      const state = await withRoom(code, (s) => {
        G.tick(s, now);
        const role = admin ? 'admin' : pw === PRIVATE_PASSWORD ? 'private' : 'public';
        const me = G.join(s, { name: b.name, admin, role, playerId: b.playerId }, now);
        claim = { r: code, p: me.id, role, n: me.name };
        return G.view(s, me, now);
      });
      return res.json({ state: withIce(state), token: signToken(claim, now, TOKEN_SALT) });
    }

    // A refresh (op "session", not "resume": that one is the admin's un-pause): the browser shows the token it got when it signed in instead of typing the password again.
    if (b.op === 'session') {
      const claim = verifyToken(b.token, code, now, TOKEN_SALT);
      if (!claim) return res.status(401).json({ error: 'Session expired — sign in again.', denied: true });
      const existing = await readRoom(code);
      if (existing && (existing.kicked || []).includes(claim.p)) {
        return res.status(401).json({ error: 'You were removed by the admin.', denied: true });
      }
      // The same rule as a fresh sign-in: a private game admits private players only, a public one public players only.
      if (claim.role !== 'admin' && (claim.role === 'private') !== Boolean(existing && existing.private)) {
        return res.status(401).json({
          error: claim.role === 'public' ? 'Ask the admin to start the game and share the private password.' : 'This game is public now — sign in again.',
          denied: true,
        });
      }
      let renewed;
      const state = await withRoom(code, (s) => {
        G.tick(s, now);
        const me = G.join(s, { name: claim.n, admin: claim.role === 'admin', role: claim.role, playerId: claim.p }, now);
        renewed = { r: code, p: me.id, role: claim.role, n: me.name };
        return G.view(s, me, now);
      });
      return res.json({ state: withIce(state), token: signToken(renewed, now, TOKEN_SALT) });
    }

    if (b.op === 'state') {
      // Cheap read-only path: one Redis GET, no write unless presence/auto-play needs one.
      const s = await readRoom(code);
      const me = s && s.members.find((m) => m.id === b.playerId);
      if (!me) return res.json(s && (s.kicked || []).includes(b.playerId) ? { kicked: true } : { gone: true });
      const stale = now - me.lastSeen > G.HEARTBEAT_MS;
      if (!stale && !G.tick(structuredClone(s), now)) {
        if (b.since === s.version && b.ps === G.presenceSig(s, now)) return res.json({ unchanged: true });
        return res.json({ state: withIce(G.view(s, me, now)) });
      }
      const result = await withRoom(code, (r) => {
        const self = r.members.find((m) => m.id === b.playerId);
        if (!self) return (r.kicked || []).includes(b.playerId) ? { kicked: true } : { gone: true };
        const wasOnline = G.online(self, now);
        self.lastSeen = now;
        const changed = G.tick(r, now);
        if (wasOnline && !changed) r.version -= 1; // a heartbeat alone is not news: other players' quiet polls stay quiet
        return { state: G.view(r, self, now) };
      });
      if (result.state) withIce(result.state);
      return res.json(result);
    }

    // Voice-chat signalling: tiny messages passed between two people who are both in the voice list.
    if (b.op === 'signal') {
      const s = await readRoom(code);
      const me = s && s.members.find((m) => m.id === b.playerId);
      const to = s && s.members.find((m) => m.id === b.to);
      if (!me || !to) throw new G.GameError('Not in this room.');
      if (!G.canVoice(s, me) || !G.canVoice(s, to)) throw new G.GameError('Voice chat is for private players and the admin.');
      const live = s.voice || [];
      if (!live.includes(me.id) || !live.includes(to.id)) throw new G.GameError('Not in voice chat.');
      if (!['offer', 'answer', 'ice'].includes(b.kind) || JSON.stringify(b.data ?? null).length > 8000) {
        throw new G.GameError('Bad signal.');
      }
      await pushSignal(code, to.id, { from: me.id, kind: b.kind, data: b.data });
      return res.json({ ok: true });
    }
    if (b.op === 'signals') {
      return res.json({ signals: await takeSignals(code, String(b.playerId ?? '').slice(0, 64)) });
    }

    const state = await withRoom(code, (r) => {
      const me = r.members.find((m) => m.id === b.playerId);
      if (!me) {
        throw new G.GameError((r.kicked || []).includes(b.playerId)
          ? 'You were removed by the admin.' : 'You are not in this room — rejoin.');
      }
      me.lastSeen = now;
      G.tick(r, now);
      G.act(r, me, b, now);
      return G.view(r, me, now);
    });
    return res.json({ state: withIce(state) });
  } catch (e) {
    if (e instanceof G.GameError) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: e.message === 'Room busy, please retry.' ? e.message : 'Server error.' });
  }
}
