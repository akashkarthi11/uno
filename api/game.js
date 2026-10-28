import * as G from './_lib/game.js';
import { readRoom, withRoom, usingRedis, pushSignal, takeSignals } from './_lib/store.js';

const PLAYER_PASSWORD = process.env.GAME_PLAYER_PASSWORD || '123456';
const ADMIN_PASSWORD = process.env.GAME_ADMIN_PASSWORD || '110299';
const PRIVATE_PASSWORD = process.env.GAME_PRIVATE_PASSWORD || '281101';

// Voice chat connects browsers directly; STUN finds the route. Add a TURN relay for strict networks by setting
// GAME_TURN_URLS (comma separated), GAME_TURN_USER and GAME_TURN_PASS.
const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
function iceServers() {
  const urls = (process.env.GAME_TURN_URLS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!urls.length) return STUN;
  return [...STUN, { urls, username: process.env.GAME_TURN_USER || '', credential: process.env.GAME_TURN_PASS || '' }];
}
const withIce = (state) => {
  if (state && state.canVoice) state.iceServers = iceServers();
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
      const state = await withRoom(code, (s) => {
        G.tick(s, now);
        const role = admin ? 'admin' : pw === PRIVATE_PASSWORD ? 'private' : 'public';
        const me = G.join(s, { name: b.name, admin, role, playerId: b.playerId }, now);
        return G.view(s, me, now);
      });
      return res.json({ state: withIce(state) });
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
      if (!G.canVoice(me) || !G.canVoice(to)) throw new G.GameError('Voice chat is for private players and the admin.');
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
