import * as G from './_lib/game.js';
import { signToken, verifyToken } from './_lib/token.js';
import { HANGUL } from './_lib/korean.js';
import { WORDS } from './_lib/words.js';
import { readRoom, withRoom, usingRedis, pushSignal, takeSignals, benchmark, listRooms, closeRoom, wasClosed, pushJoin, takeJoins, saveBackup, listBackups, getBackup, deleteBackup, MAX_BACKUPS } from './_lib/store.js';

const PLAYER_PASSWORD = process.env.GAME_PLAYER_PASSWORD || '123456';
const ADMIN_PASSWORD = process.env.GAME_ADMIN_PASSWORD || '110299';
const PRIVATE_PASSWORD = process.env.GAME_PRIVATE_PASSWORD || '281101';
// Anyone who signs in with this password is a co-admin straight away (shown as "admin", can start / configure / pause / restart
// the game) without the real admin appointing them. Public games only: a private game admits just the admin password and
// the private password.
const COADMIN_PASSWORD = process.env.GAME_COADMIN_PASSWORD || '12345678';
const TOKEN_SALT = ADMIN_PASSWORD + '|' + PLAYER_PASSWORD + '|' + PRIVATE_PASSWORD + '|' + COADMIN_PASSWORD; // new passwords sign everyone out

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
  if (state && (state.canVoice || state.canVideo)) state.iceServers = iceServers(Boolean(state.settings && state.settings.voiceRelay));
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
      const coadmin = !admin && pw === COADMIN_PASSWORD; // admitted to public games only, as a co-admin
      if (!admin && !coadmin) {
        // The admin decides whether a game is public or private. Public games admit public players (123456)
        // only; private games admit private players (281101) only.
        const existing = await readRoom(code);
        const isPrivate = Boolean(existing && existing.private);
        if (pw !== (isPrivate ? PRIVATE_PASSWORD : PLAYER_PASSWORD)) {
          // A public player (123456) must never learn that a game is private: in a private game their password just gets
          // "System down" (the co-admin password gets the same). Any other wrong password is "Wrong password."
          const msg = isPrivate && pw === PLAYER_PASSWORD ? 'System down' : 'Wrong password.';
          return res.status(401).json({ error: msg, denied: true });
        }
      } else if (coadmin) {
        const existing = await readRoom(code);
        if (existing && existing.private) {
          // the co-admin password is not to be hinted at: in a private game it just looks like the system is down
          return res.status(401).json({ error: 'System down', denied: true });
        }
      }
      let claim;
      const state = await withRoom(code, (s) => {
        G.tick(s, now);
        const role = admin ? 'admin' : coadmin ? 'public' : pw === PRIVATE_PASSWORD ? 'private' : 'public';
        const me = G.join(s, { name: b.name, admin, role, playerId: b.playerId, coadmin }, now);
        claim = { r: code, p: me.id, role, n: me.name, co: coadmin };
        return G.view(s, me, now);
      });
      // tell the real admin (best effort: a failure here must never stop anyone joining)
      if (!admin) await pushJoin({ r: code, n: claim.n, role: coadmin ? 'co-admin' : claim.role, t: now }).catch(() => {});
      return res.json({ state: withIce(state), token: signToken(claim, now, TOKEN_SALT) });
    }

    // A refresh (op "session", not "resume": that one is the admin's un-pause): the browser shows the token it got when it signed in instead of typing the password again.
    if (b.op === 'session') {
      const claim = verifyToken(b.token, code, now, TOKEN_SALT);
      if (!claim) return res.status(401).json({ error: 'Session expired — sign in again.', denied: true });
      const existing = await readRoom(code);
      if (!existing && (await wasClosed(code))) {
        return res.status(401).json({ error: 'This room was closed by the admin.', denied: true });
      }
      if (existing && (existing.kicked || []).includes(claim.p)) {
        return res.status(401).json({ error: 'You were removed by the admin.', denied: true });
      }
      if (existing && (existing.left || []).includes(claim.p)) {
        return res.status(401).json({ error: 'You left this game — sign in again to join.', denied: true });
      }
      // The same rule as a fresh sign-in: a private game admits private players only, a public one public players only.
      if (claim.role !== 'admin' && (claim.co ? Boolean(existing && existing.private) : (claim.role === 'private') !== Boolean(existing && existing.private))) {
        return res.status(401).json({
          error: claim.role === 'public' ? 'System down' : 'This game is public now — sign in again.', // public and co-admin tokens: no hint that the game is private
          denied: true,
        });
      }
      let renewed;
      const state = await withRoom(code, (s) => {
        G.tick(s, now);
        const role = claim.role;
        const me = G.join(s, { name: claim.n, admin: claim.role === 'admin', role, playerId: claim.p, coadmin: Boolean(claim.co) }, now);
        renewed = { r: code, p: me.id, role, n: me.name, co: Boolean(claim.co) };
        return G.view(s, me, now);
      });
      return res.json({ state: withIce(state), token: signToken(renewed, now, TOKEN_SALT) });
    }

    if (b.op === 'state') {
      // Cheap read-only path: one Redis GET, no write unless presence/auto-play needs one.
      const s = await readRoom(code);
      const me = s && s.members.find((m) => m.id === b.playerId);
      if (!me) {
        if (s && (s.kicked || []).includes(b.playerId)) return res.json({ kicked: true });
        if (s && (s.left || []).includes(b.playerId)) return res.json({ left: true });
        return res.json((await wasClosed(code)) ? { closed: true } : { gone: true });
      }
      const stale = now - me.lastSeen > G.HEARTBEAT_MS;
      if (!stale && !G.tick(structuredClone(s), now)) {
        if (b.since === s.version && b.ps === G.presenceSig(s, now)) return res.json({ unchanged: true });
        return res.json({ state: withIce(G.view(s, me, now)) });
      }
      const result = await withRoom(code, (r) => {
        const self = r.members.find((m) => m.id === b.playerId);
        if (!self) return (r.kicked || []).includes(b.playerId) ? { kicked: true } : (r.left || []).includes(b.playerId) ? { left: true } : { gone: true };
        const wasOnline = G.online(self, now);
        self.lastSeen = now;
        const changed = G.tick(r, now);
        if (wasOnline && !changed) r.version -= 1; // a heartbeat alone is not news: other players' quiet polls stay quiet
        return { state: G.view(r, self, now) };
      });
      if (result.gone && (await wasClosed(code))) return res.json({ closed: true });
      if (result.state) withIce(result.state);
      return res.json(result);
    }

    // The real admin's Rooms window: how many rooms exist, how many have someone online, and removing a room.
    // The admin is whoever signed in with the admin password in the room they are in now.
    if (['rooms', 'closeRoom', 'peek', 'joins', 'learnBackupSave', 'learnBackupList', 'learnBackupGet', 'learnBackupRestore', 'learnBackupDelete'].includes(b.op)) {
      const here = await readRoom(code);
      const who = here && here.members.find((m) => m.id === b.playerId);
      if (!who || !who.admin) throw new G.GameError('Only the admin can do that.');
      if (b.op === 'joins') return res.json({ joins: await takeJoins(now) });

      // Learn Korean backups: the shared word list, the questions between members and the points of the room's lesson, kept with
      // no time limit (the same store as room backups, told apart by `kind`) until the admin removes them.
      if (b.op === 'learnBackupList') {
        const list = (await listBackups()).filter((e) => e.kind === 'learn').map((e) => ({ id: e.id, room: e.room, at: e.at, label: e.label, words: e.data.words.length, asks: e.data.asks.length, players: Object.keys(e.data.scores).length })).sort((x, y) => y.at - x.at);
        return res.json({ backups: list, max: MAX_BACKUPS });
      }
      if (b.op === 'learnBackupGet') {
        const entry = await getBackup(String(b.id ?? '').slice(0, 60));
        if (!entry || entry.kind !== 'learn') throw new G.GameError('That backup no longer exists.');
        return res.json({ backup: entry });
      }
      if (b.op === 'learnBackupSave') {
        const L = here.learn;
        if (!L || !((L.words || []).length || (L.asks || []).length || Object.keys(L.scores || {}).length)) throw new G.GameError('There is nothing in the lesson to back up yet.');
        if ((await listBackups()).filter((e) => e.kind === 'learn').length >= MAX_BACKUPS) throw new G.GameError(`Backup limit reached (${MAX_BACKUPS}). Remove an old one first.`);
        const entry = {
          id: `learn-${code}-${now.toString(36)}`, kind: 'learn', room: code, at: now, label: String(b.label ?? '').trim().slice(0, 40),
          data: {
            words: L.words || [], asks: L.asks || [], scores: L.scores || {}, wordSeq: L.wordSeq || 0, askSeq: L.askSeq || 0,
            names: Object.fromEntries(here.members.map((m) => [m.id, m.name])),
          },
        };
        await saveBackup(structuredClone(entry));
        return res.json({ ok: true, id: entry.id });
      }
      if (b.op === 'learnBackupRestore') {
        const entry = await getBackup(String(b.id ?? '').slice(0, 60));
        if (!entry || entry.kind !== 'learn') throw new G.GameError('That backup no longer exists.');
        const d = entry.data;
        await withRoom(code, (s) => {
          if (!s.private) throw new G.GameError('The lesson belongs to private games — switch this room to private first.');
          const L = s.learn || (s.learn = { tab: 'consonants', idx: 0, mode: 'learn', q: null, qn: 0, scores: {}, at: now });
          // members have new ids in a new room, so people are matched by name; whatever cannot be matched falls back to the admin
          const idFor = (id) => (s.members.some((m) => m.id === id) ? id : (s.members.find((m) => m.name === d.names[id]) || {}).id);
          L.words = d.words.map((w) => ({ ...w, by: idFor(w.by) || who.id }));
          L.wordSeq = d.wordSeq;
          L.asks = d.asks.map((a) => ({ ...a, from: idFor(a.from), to: a.to === 'all' ? 'all' : idFor(a.to), answers: Object.fromEntries(Object.entries(a.answers).map(([id, x]) => [idFor(id), x]).filter(([id]) => id)) })).filter((a) => a.from && a.to);
          L.askSeq = d.askSeq;
          L.scores = { ...d.scores };
          L.at = now;
        });
        return res.json({ ok: true });
      }
      if (b.op === 'learnBackupDelete') {
        const entry = await getBackup(String(b.id ?? '').slice(0, 60));
        if (!entry || entry.kind !== 'learn') throw new G.GameError('That backup no longer exists.');
        await deleteBackup(entry.id);
        return res.json({ ok: true });
      }
      if (b.op === 'rooms') {
        const rooms = (await listRooms()).map(({ code: c, room }) => G.roomSummary(room, c, now)).sort((x, y) => y.last - x.last);
        return res.json({ rooms, total: rooms.length, active: rooms.filter((r) => r.online > 0).length });
      }
      const target = String(b.target ?? '');
      if (!/^[A-Za-z0-9_-]{1,24}$/.test(target)) throw new G.GameError('Bad room name.');
      if (b.op === 'peek') {
        const there = await readRoom(target);
        if (!there) throw new G.GameError('That room no longer exists.');
        return res.json({ peek: G.peekView(there, target, now) });
      }
      await closeRoom(target);
      return res.json({ ok: true });
    }

    // The private "Learn Korean" page: only the real admin and private players get anything; everyone else gets the same
    // answer as for an action that does not exist, so there is nothing to find.
    if (b.op === 'korean') {
      const s = await readRoom(code);
      const me = s && s.members.find((m) => m.id === b.playerId);
      if (!me || !(me.admin || me.role === 'private')) return res.status(400).json({ error: 'Unknown action.' });
      return res.json({ hangul: HANGUL, words: WORDS });
    }

    // Looks an English word up online (MyMemory, no key) for the learner; the result is machine-translated and labelled so on the page.
    if (b.op === 'translate') {
      const s = await readRoom(code);
      const me = s && s.members.find((m) => m.id === b.playerId);
      if (!me || !(me.admin || me.role === 'private')) return res.status(400).json({ error: 'Unknown action.' });
      const q = String(b.q ?? '').trim().replace(/\s+/g, ' ');
      if (!/^[A-Za-z][A-Za-z' -]{0,39}$/.test(q)) throw new G.GameError('Type one English word or a short phrase (letters only).');
      let ko = '';
      try {
        const r = await fetch('https://api.mymemory.translated.net/get?langpair=en|ko&q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(6000) });
        const j = await r.json();
        const cands = [j && j.responseData && j.responseData.translatedText, ...((j && j.matches) || []).map((m) => m.translation)];
        ko = String(cands.find((t) => typeof t === 'string' && /^[㄰-㆏가-힯 ]{1,30}$/.test(t.trim())) || '').trim();
      } catch (e) { throw new G.GameError('The online lookup is not reachable right now — try again in a moment.'); }
      if (!ko) throw new G.GameError('No Korean word found for “' + q + '”. Try a simpler word.');
      return res.json({ q, ko });
    }

    // Stats window: this room's table and its last games (read-only, any member of the room).
    if (b.op === 'stats') {
      const s = await readRoom(code);
      const me = s && s.members.find((m) => m.id === b.playerId);
      if (!me) throw new G.GameError('You are not in this room — rejoin.');
      return res.json({ stats: G.statsView(s, me) });
    }

    // Voice-chat signalling: tiny messages passed between two people who are both in the voice list.
    if (b.op === 'signal') {
      const s = await readRoom(code);
      const me = s && s.members.find((m) => m.id === b.playerId);
      const to = s && s.members.find((m) => m.id === b.to);
      if (!me || !to) throw new G.GameError('Not in this room.');
      if (!G.canCall(s, me) || !G.canCall(s, to)) throw new G.GameError('Voice chat is for private players and the admin.');
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
