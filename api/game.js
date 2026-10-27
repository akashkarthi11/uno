import * as G from './_lib/game.js';
import { readRoom, withRoom, usingRedis } from './_lib/store.js';

const PLAYER_PASSWORD = process.env.GAME_PLAYER_PASSWORD || '123456';
const ADMIN_PASSWORD = process.env.GAME_ADMIN_PASSWORD || '110299';

const cleanRoom = (raw) => (/^[A-Za-z0-9_-]{1,24}$/.test(String(raw ?? '').trim()) ? String(raw).trim() : 'main');

export default async function handler(req, res) {
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
      if (!admin && pw !== PLAYER_PASSWORD) return res.status(401).json({ error: 'Wrong password.', denied: true });
      const state = await withRoom(code, (s) => {
        G.tick(s, now);
        const me = G.join(s, { name: b.name, admin, playerId: b.playerId }, now);
        return G.view(s, me, now);
      });
      return res.json({ state });
    }

    if (b.op === 'state') {
      // Cheap read-only path: one Redis GET, no write unless presence/auto-play needs one.
      const s = await readRoom(code);
      const me = s && s.members.find((m) => m.id === b.playerId);
      if (!me) return res.json({ gone: true });
      const stale = now - me.lastSeen > G.HEARTBEAT_MS;
      if (!stale && !G.tick(structuredClone(s), now)) {
        if (b.since === s.version) return res.json({ unchanged: true });
        return res.json({ state: G.view(s, me, now) });
      }
      const result = await withRoom(code, (r) => {
        const self = r.members.find((m) => m.id === b.playerId);
        if (!self) return { gone: true };
        self.lastSeen = now;
        G.tick(r, now);
        return { state: G.view(r, self, now) };
      });
      return res.json(result);
    }

    const state = await withRoom(code, (r) => {
      const me = r.members.find((m) => m.id === b.playerId);
      if (!me) throw new G.GameError('You are not in this room — rejoin.');
      me.lastSeen = now;
      G.tick(r, now);
      G.act(r, me, b, now);
      return G.view(r, me, now);
    });
    return res.json({ state });
  } catch (e) {
    if (e instanceof G.GameError) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: e.message === 'Room busy, please retry.' ? e.message : 'Server error.' });
  }
}
