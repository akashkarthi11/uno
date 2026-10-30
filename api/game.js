import { randomBytes } from 'node:crypto';
import * as G from './_lib/game.js';
import { signToken, verifyToken } from './_lib/token.js';
import { HANGUL } from './_lib/korean.js';
import { WORDS } from './_lib/words.js';
import { readRoom, withRoom, usingRedis, pushSignal, takeSignals, benchmark, listRooms, closeRoom, wasClosed, pushJoin, takeJoins, saveBackup, listBackups, getBackup, deleteBackup, MAX_BACKUPS, putImage, getImage, isShutdown, setShutdown, isObserverOff, setObserverOff, getAuthMode, setAuthMode, videoRead, videoUpdate } from './_lib/store.js';
import { auth0Config, readTicket } from './_lib/auth0.js';
import { usersEnabled, findLocal, createLocal, touchLocal, touchAdmin, nameTaken, isOgAdminName, adminNameOk, ogAdminName, checkPassword, MIN_PASSWORD } from './_lib/users.js';
import * as V from './_lib/video.js';

const PLAYER_PASSWORD = process.env.GAME_PLAYER_PASSWORD || '123456';
const ADMIN_PASSWORD = process.env.GAME_ADMIN_PASSWORD || '110299';
const PRIVATE_PASSWORD = process.env.GAME_PRIVATE_PASSWORD || '281101';
const OBSERVER_PASSWORD = process.env.GAME_OBSERVER_PASSWORD || '1102'; // the observer account: hears and sees, is not an admin, never shown in the lobby
const TOKEN_SALT = ADMIN_PASSWORD + '|' + PLAYER_PASSWORD + '|' + PRIVATE_PASSWORD + '|' + OBSERVER_PASSWORD; // new passwords sign everyone out
const SYS_SALT = TOKEN_SALT + '|sys'; // the system login token (no room)

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
      if (String(b.password ?? '') !== ADMIN_PASSWORD || !adminNameOk(String(b.name ?? ''))) return res.status(401).json({ error: 'Admin only.', denied: true });
      return res.json({ region: process.env.VERCEL_REGION || 'local', ...(await benchmark()) });
    }

    // What the sign-in screen shows: the name + password form, or the Auth0 button (the admin password form stays in both).
    if (b.op === 'authInfo') {
      return res.json({ mode: (await getAuthMode()) === 'auth0' && auth0Config() ? 'auth0' : 'current' });
    }

    // ---- System login: who you are, for the whole system. It names no room; the person then creates a room or joins one. ----
    // The answer is a signed "sys" token that op "join" takes together with a room code. Rules by credential:
    //   admin password -> admin (as the admin's own username when it matches), observer password -> observer,
    //   private password -> private player, otherwise a public player: their own account (the shared 123456 only opens the door the
    //   first time and they then choose a password), or the Auth0 ticket when the admin has switched sign-in to Auth0.
    if (b.op === 'login') {
      const pw = String(b.password ?? '');
      const sign = (role, name, a0) => signToken({ r: '*', p: 'sys', role, n: name, a0: Boolean(a0) }, now, SYS_SALT);
      const done = (role, name, a0) => res.json({ sys: sign(role, name, a0), name, role });
      const cfg = auth0Config();
      const auth0Mode = (await getAuthMode()) === 'auth0' && Boolean(cfg);

      if (b.ticket) {
        const ticket = auth0Mode ? readTicket(String(b.ticket), '*', cfg, now) : null;
        if (!ticket) return res.status(401).json({ error: 'Auth0 sign-in expired — try again.', denied: true });
        if (await isShutdown()) return res.status(401).json({ error: 'System down', denied: true });
        if (ticket.adm && usersEnabled() && isOgAdminName(ticket.n)) return done('admin', ogAdminName(), true); // the admin's own Auth0 account
        return done('public', ticket.n, true);
      }
      if (pw === ADMIN_PASSWORD && !adminNameOk(String(b.name ?? ''))) return res.status(401).json({ error: 'Wrong password.', denied: true }); // the admin password belongs to the admin's username only
      if (pw === ADMIN_PASSWORD) {
        let name = G.cleanName(b.name);
        if (isOgAdminName(String(b.name ?? ''))) {
          name = ogAdminName();
          if (usersEnabled()) await touchAdmin(name).catch(() => {}); // recording it must never stop the sign-in
        }
        return done('admin', name, false);
      }
      if (pw === OBSERVER_PASSWORD && !(await isObserverOff())) return done('observer', 'Observer', false);
      if (pw === PRIVATE_PASSWORD) return done('private', G.cleanName(b.name), false);

      // everyone else is a public player
      if (usersEnabled()) {
        if (!String(b.name ?? '').replace(/[<>&"']/g, '').trim()) return res.status(400).json({ error: 'Enter your name.' });
        const wanted = G.cleanName(b.name);
        // a name that is the real admin's, or an Auth0 user's, is not for anyone else to register or sign in with
        if (await nameTaken(wanted)) return res.status(401).json({ error: 'That name is taken.', denied: true });
        let account = await findLocal(wanted);
        if (!(account ? checkPassword(pw, account.pw_hash) : pw === PLAYER_PASSWORD)) return res.status(401).json({ error: 'Wrong password.', denied: true });
        if (auth0Mode) return res.status(401).json({ error: 'Sign in with Auth0.', denied: true });
        if (await isShutdown()) return res.status(401).json({ error: 'System down', denied: true });
        if (!account) {
          // first sign-in for this username: it must choose its own password now
          if (b.newPassword === undefined) return res.json({ needsPassword: true });
          const np = String(b.newPassword);
          if (np.length < MIN_PASSWORD || np.length > 32) return res.status(400).json({ error: `Choose a password of ${MIN_PASSWORD} to 32 characters.` });
          if ([PLAYER_PASSWORD, ADMIN_PASSWORD, PRIVATE_PASSWORD, OBSERVER_PASSWORD].includes(np)) return res.status(400).json({ error: 'Choose a password of your own, not one of the shared ones.' });
          account = await createLocal(wanted, np);
          if (!account) return res.status(401).json({ error: 'That name was just taken. Choose another.', denied: true });
        } else {
          await touchLocal(account.id).catch(() => {});
        }
        return done('public', account.username, false);
      }
      if (pw !== PLAYER_PASSWORD) return res.status(401).json({ error: 'Wrong password.', denied: true });
      if (auth0Mode) return res.status(401).json({ error: 'Sign in with Auth0.', denied: true });
      if (await isShutdown()) return res.status(401).json({ error: 'System down', denied: true });
      return done('public', G.cleanName(b.name), false);
    }

    // Create a room or join one, signed in with the sys token from op "login". Create makes a new room (a name of your own, or a
    // random one); join needs a room that exists. Public games admit public players, private games admit private players.
    if (b.op === 'join' && b.sys) {
      const sys = verifyToken(String(b.sys), '*', now, SYS_SALT);
      if (!sys) return res.status(401).json({ error: 'Session expired — sign in again.', denied: true });
      const named = /^[A-Za-z0-9_-]{1,24}$/.test(String(b.room ?? '').trim()) ? String(b.room).trim() : '';
      if (b.create && sys.role !== 'admin' && sys.role !== 'public') return res.status(400).json({ error: 'Join a room with its code.' });
      const rc = b.create ? named || randomBytes(3).toString('hex') : named;
      if (!rc) return res.status(400).json({ error: 'Enter the room code.' });
      const existing = await readRoom(rc);
      if (b.create && existing) return res.status(400).json({ error: 'That room name is taken. Choose another.' });
      if (!b.create && !existing) return res.status(400).json({ error: 'No room with that code.' });
      const isPrivate = Boolean(existing && existing.private);
      if (sys.role === 'public') {
        if (isPrivate) return res.status(401).json({ error: 'System down', denied: true }); // a public player is never told a game is private
        if (await isShutdown()) return res.status(401).json({ error: 'System down', denied: true });
        if (Boolean(sys.a0) !== ((await getAuthMode()) === 'auth0' && Boolean(auth0Config()))) return res.status(401).json({ error: 'Session expired — sign in again.', denied: true });
      } else if (sys.role === 'private' && !isPrivate) {
        return res.status(401).json({ error: 'This game is public.', denied: true });
      } else if (sys.role === 'observer' && (await isObserverOff())) {
        return res.status(401).json({ error: 'Session expired — sign in again.', denied: true });
      }
      let claim;
      const state = await withRoom(rc, (s) => {
        G.tick(s, now);
        const me = G.join(s, { name: sys.n, admin: sys.role === 'admin', role: sys.role, playerId: b.playerId, observer: sys.role === 'observer' }, now);
        claim = { r: rc, p: me.id, role: sys.role, n: me.name, co: false, obs: Boolean(me.observer), a0: Boolean(sys.a0) };
        return G.view(s, me, now);
      });
      if (sys.role !== 'admin') await pushJoin({ r: rc, n: claim.n, role: claim.role, t: now }).catch(() => {});
      if (state.admin) { state.shutdown = await isShutdown(); state.observerOff = await isObserverOff(); state.authMode = await getAuthMode(); state.auth0Ready = Boolean(auth0Config()); }
      return res.json({ room: rc, state: withIce(state), token: signToken(claim, now, TOKEN_SALT) });
    }

    if (b.op === 'join') {
      const pw = String(b.password ?? '');
      const admin = pw === ADMIN_PASSWORD && adminNameOk(String(b.name ?? '')); // the admin password belongs to the admin's username only
      // the observer account: any room, public or private (unless the admin switched it off: then 1102 is just a wrong password)
      const observer = !admin && pw === OBSERVER_PASSWORD && !(await isObserverOff());
      let publicLogin = false; // a public player who signed in with their own account
      let joinName = b.name;
      // The real admin signing in under their own username (the Auth0 user with that name): the sign-in is recorded on that user row.
      if (admin && usersEnabled() && isOgAdminName(String(b.name ?? ''))) {
        joinName = ogAdminName();
        await touchAdmin(joinName).catch(() => {}); // recording it must never stop the sign-in
      }
      if (!admin && !observer) {
        // The admin decides whether a game is public or private. Public games admit public players (123456)
        // only; private games admit private players (281101) only.
        const existing = await readRoom(code);
        const isPrivate = Boolean(existing && existing.private);
        const accounts = !isPrivate && usersEnabled(); // public games with the user database on: every public player has their own username and password
        let account = null;
        if (accounts && !String(b.name ?? '').replace(/[<>&"']/g, '').trim()) return res.status(400).json({ error: 'Enter your name.' });
        if (accounts) {
          // 123456 only opens the door the first time: the person then chooses their own password, and from then on signs in with it.
          // a name that is the real admin's, or an Auth0 user's, is not for anyone else to register or sign in with
          if (await nameTaken(G.cleanName(b.name))) return res.status(401).json({ error: 'That name is taken.', denied: true });
          account = await findLocal(G.cleanName(b.name));
          const ok = account ? checkPassword(pw, account.pw_hash) : pw === PLAYER_PASSWORD;
          if (!ok) return res.status(401).json({ error: 'Wrong password.', denied: true });
        } else if (pw !== (isPrivate ? PRIVATE_PASSWORD : PLAYER_PASSWORD)) {
          // A public player (123456) must never learn that a game is private: in a private game their password just gets
          // "System down". Any other wrong password is "Wrong password."
          const msg = isPrivate && pw === PLAYER_PASSWORD ? 'System down' : 'Wrong password.';
          return res.status(401).json({ error: msg, denied: true });
        }
        // Auth0 mode: public players sign in through Auth0, not with a password (admin, private and observer passwords still work).
        if (!isPrivate && (await getAuthMode()) === 'auth0' && auth0Config()) {
          return res.status(401).json({ error: 'Sign in with Auth0.', denied: true });
        }
        if (accounts) {
          publicLogin = true;
          if (!account) {
            // first sign-in for this username: it must choose its own password now
            if (b.newPassword === undefined) return res.json({ needsPassword: true });
            const np = String(b.newPassword);
            if (np.length < MIN_PASSWORD || np.length > 32) return res.status(400).json({ error: `Choose a password of ${MIN_PASSWORD} to 32 characters.` });
            if ([PLAYER_PASSWORD, ADMIN_PASSWORD, PRIVATE_PASSWORD, OBSERVER_PASSWORD].includes(np)) return res.status(400).json({ error: 'Choose a password of your own, not one of the shared ones.' });
            account = await createLocal(G.cleanName(b.name), np);
            if (!account) return res.status(401).json({ error: 'That name was just taken. Choose another.', denied: true });
          } else {
            await touchLocal(account.id).catch(() => {});
          }
          joinName = account.username;
        }
      }
      if ((pw === PLAYER_PASSWORD || publicLogin) && !admin && !observer && (await isShutdown())) {
        return res.status(401).json({ error: 'System down', denied: true }); // the admin's shutdown: public sign-in is off everywhere
      }
      let claim;
      const state = await withRoom(code, (s) => {
        G.tick(s, now);
        const role = admin ? 'admin' : observer ? 'observer' : pw === PRIVATE_PASSWORD ? 'private' : 'public';
        const me = G.join(s, { name: observer ? 'Observer' : joinName, admin, role, playerId: b.playerId, observer }, now);
        claim = { r: code, p: me.id, role, n: me.name, co: false, obs: Boolean(me.observer) };
        return G.view(s, me, now);
      });
      // tell the real admin (best effort: a failure here must never stop anyone joining)
      if (!admin) await pushJoin({ r: code, n: claim.n, role: claim.role, t: now }).catch(() => {});
      if (state.admin) { state.shutdown = await isShutdown(); state.observerOff = await isObserverOff(); state.authMode = await getAuthMode(); state.auth0Ready = Boolean(auth0Config()); }
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
      if (claim.role !== 'admin' && claim.role !== 'observer' && (claim.co ? Boolean(existing && existing.private) : (claim.role === 'private') !== Boolean(existing && existing.private))) {
        return res.status(401).json({
          error: claim.role === 'public' ? 'System down' : 'This game is public now — sign in again.', // public and co-admin tokens: no hint that the game is private
          denied: true,
        });
      }
      if (claim.role === 'observer' && (await isObserverOff())) {
        return res.status(401).json({ error: 'Session expired — sign in again.', denied: true });
      }
      if (claim.role === 'public' && (await isShutdown())) {
        return res.status(401).json({ error: 'System down', denied: true });
      }
      // The admin switched the sign-in method: a public sign-in made the other way is over (admin, co-admin, private, observer are not affected).
      if (claim.role === 'public' && !claim.co && Boolean(claim.a0) !== ((await getAuthMode()) === 'auth0' && Boolean(auth0Config()))) {
        return res.status(401).json({ error: 'Session expired — sign in again.', denied: true });
      }
      let renewed;
      const state = await withRoom(code, (s) => {
        G.tick(s, now);
        const role = claim.role;
        const me = G.join(s, { name: claim.n, admin: claim.role === 'admin', role, playerId: claim.p, coadmin: Boolean(claim.co), observer: Boolean(claim.obs) }, now);
        renewed = { r: code, p: me.id, role, n: me.name, co: Boolean(claim.co), obs: Boolean(me.observer), a0: Boolean(claim.a0) };
        return G.view(s, me, now);
      });
      if (state.admin) { state.shutdown = await isShutdown(); state.observerOff = await isObserverOff(); state.authMode = await getAuthMode(); state.auth0Ready = Boolean(auth0Config()); }
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
    if (['rooms', 'closeRoom', 'shutdown', 'observerSwitch', 'authSwitch', 'peek', 'peekKick', 'joins', 'learnBackupSave', 'learnBackupList', 'learnBackupGet', 'learnBackupRestore', 'learnBackupDelete'].includes(b.op)) {
      const here = await readRoom(code);
      const who = here && here.members.find((m) => m.id === b.playerId);
      // the observer account may list and watch rooms and remove unwanted players; closing rooms, the join feed and the Learn backups are the real admin's
      if (!who || !(who.admin || (who.observer && ['rooms', 'peek', 'peekKick'].includes(b.op)))) throw new G.GameError('Only the admin can do that.');
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
      // One button: shut down (public players cannot sign in to any room and every public room is closed) or open again.
      if (b.op === 'shutdown') {
        const on = b.on === true;
        await setShutdown(on);
        let closed = 0;
        if (on) {
          for (const { code: c, room: r } of await listRooms()) {
            if (!r.private) { await closeRoom(c); closed++; }
          }
        }
        return res.json({ ok: true, shutdown: on, closed });
      }
      // Observer account on / off: off removes every observer from every room and keeps the account from signing in.
      if (b.op === 'observerSwitch') {
        const off = b.off === true;
        await setObserverOff(off);
        let removed = 0;
        if (off) {
          for (const { code: c, room: r } of await listRooms()) {
            if (!(r.members || []).some((m) => m.observer)) continue;
            await withRoom(c, (s) => { removed += G.dropObservers(s, now); });
          }
        }
        return res.json({ ok: true, observerOff: off, removed });
      }
      // Sign-in method for public players: "current" (name + password) or "auth0". The admin password works in both.
      if (b.op === 'authSwitch') {
        const mode = b.mode === 'auth0' ? 'auth0' : 'current';
        if (mode === 'auth0' && !auth0Config()) throw new G.GameError('Auth0 is not set up yet: add AUTH0_DOMAIN, AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET to the Vercel project first.');
        await setAuthMode(mode);
        return res.json({ ok: true, authMode: mode });
      }
      if (b.op === 'rooms') {
        const rooms = (await listRooms()).map(({ code: c, room }) => G.roomSummary(room, c, now)).sort((x, y) => y.last - x.last);
        return res.json({ rooms, total: rooms.length, active: rooms.filter((r) => r.online > 0).length, shutdown: await isShutdown(), observerOff: await isObserverOff() });
      }
      const target = String(b.target ?? '');
      if (!/^[A-Za-z0-9_-]{1,24}$/.test(target)) throw new G.GameError('Bad room name.');
      if (b.op === 'peekKick') {
        if (!(await readRoom(target))) throw new G.GameError('That room no longer exists.');
        await withRoom(target, (s) => { G.removeByAdmin(s, String(b.targetId ?? ''), now); });
        return res.json({ ok: true });
      }
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
    // AI videos: the real admin and private players, in private rooms only; anybody else gets what a made-up action gets.
    if (['videoList', 'videoMake', 'videoCheck', 'videoDelete'].includes(b.op)) {
      const s = await readRoom(code);
      const me = s && s.members.find((m) => m.id === b.playerId);
      if (!me || !s.private || !G.canLearn(me)) return res.status(400).json({ error: 'Unknown action.' });
      const day = new Date(now).toISOString().slice(0, 10), month = day.slice(0, 7);
      const roll = (meta) => {
        if (meta.day !== day) { meta.day = day; meta.dayN = 0; }
        if (meta.month !== month) { meta.month = month; meta.monthN = 0; }
      };
      const view = (db) => ({
        videos: db.items.slice().sort((x, y) => y.at - x.at).map((i) => ({
          id: i.id, prompt: i.prompt, by: i.by, at: i.at, mode: i.mode, status: i.status, error: i.error,
          videoUrl: i.videoUrl, imageUrl: i.imageUrl, bytes: i.bytes || 0, canDelete: Boolean(me.admin || i.byId === me.id),
        })),
        limits: {
          day: db.meta.day === day ? db.meta.dayN || 0 : 0, dayMax: V.videoDaily(),
          month: db.meta.month === month ? db.meta.monthN || 0 : 0, monthMax: V.videoMonthly(),
          bytes: db.items.reduce((n, i) => n + (i.bytes || 0), 0), bytesMax: V.STORAGE_MAX,
        },
        ready: V.videoReady(),
      });

      if (b.op === 'videoList') return res.json(view(await videoRead()));

      if (b.op === 'videoDelete') {
        const id = String(b.id ?? '');
        const db0 = await videoRead();
        const it = db0.items.find((i) => i.id === id);
        if (!it || !(me.admin || it.byId === me.id)) throw new G.GameError('That video is not there (or is not yours).');
        await V.delFiles([it.videoUrl, it.imageUrl]).catch(() => {});
        await videoUpdate((db) => { db.items = db.items.filter((i) => i.id !== id); });
        return res.json(view(await videoRead()));
      }

      if (b.op === 'videoMake') {
        if (!V.videoReady()) throw new G.GameError('Video storage is not set up yet.');
        const text = String(b.prompt ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        let image = null;
        if (b.image) {
          const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image));
          if (!m) throw new G.GameError('Use a JPEG, PNG or WebP picture.');
          image = { type: m[1], bytes: Buffer.from(m[2], 'base64') };
          if (image.bytes.length > V.IMAGE_MAX) throw new G.GameError('That picture is too big — pick a smaller one.');
        }
        if (!image && text.length < 3) throw new G.GameError('Describe the video (a few words) or add a picture.');
        const id = 'v' + now.toString(36) + Math.random().toString(36).slice(2, 6);
        // reserve first (the caps are checked and the counters raised under the lock), then do the slow work
        await videoUpdate((db) => {
          roll(db.meta);
          if (db.meta.dayN >= V.videoDaily()) throw new G.GameError('Daily limit reached (' + V.videoDaily() + ' videos a day). Try again tomorrow.');
          if (db.meta.monthN >= V.videoMonthly()) throw new G.GameError('Monthly limit reached (' + V.videoMonthly() + ' videos).');
          if (db.items.reduce((n, i) => n + (i.bytes || 0), 0) > V.STORAGE_MAX) throw new G.GameError('Video storage is full — delete some old videos first.');
          db.meta.dayN++;
          db.meta.monthN++;
          db.items.push({ id, prompt: text, by: me.name, byId: me.id, at: now, mode: image ? 'image' : 'text', status: 'making' });
        });
        try {
          let imageUrl = null, imageBytes = 0;
          if (image) {
            imageUrl = (await V.putFile('video-in/' + id + (image.type === 'image/png' ? '.png' : image.type === 'image/webp' ? '.webp' : '.jpg'), image.bytes, image.type)).url;
            imageBytes = image.bytes.length;
          }
          const op = await V.startVideo({ imageUrl, text: text || 'Bring this picture to life with gentle, natural motion.' });
          await videoUpdate((db) => { const it = db.items.find((i) => i.id === id); if (it) { it.op = op; it.model = V.modelFor(Boolean(imageUrl)); it.imageUrl = imageUrl || undefined; it.imgBytes = imageBytes; it.bytes = imageBytes; } });
        } catch (e) {
          console.error('video start failed', e && e.message);
          await videoUpdate((db) => { // it never started, so it costs nothing: take the count back
            roll(db.meta);
            const it = db.items.find((i) => i.id === id);
            if (it) { it.status = 'failed'; it.error = 'Could not start: ' + String((e && e.message) || e).slice(0, 120); db.meta.dayN = Math.max(0, db.meta.dayN - 1); db.meta.monthN = Math.max(0, db.meta.monthN - 1); }
          });
        }
        return res.json(view(await videoRead()));
      }

      // videoCheck: look at every video that is still being made; finished ones are copied into Blob and become playable
      const db0 = await videoRead();
      for (const it of db0.items.filter((i) => i.status === 'making')) {
        if (!it.op) {
          if (now - it.at > 120000) await videoUpdate((db) => { const x = db.items.find((i) => i.id === it.id); if (x && !x.op) { x.status = 'failed'; x.error = 'Could not start.'; } });
          continue;
        }
        if (it.finalizing && now - it.finalizing < 60000) continue;
        let st;
        try { st = await V.getStatus(it.op, it.model); } catch (e) { console.error('video status failed', e && e.message); continue; }
        if (st.state === 'pending') {
          if (now - it.at > 20 * 60000) await videoUpdate((db) => { const x = db.items.find((i) => i.id === it.id); if (x) { x.status = 'failed'; x.error = 'Took too long.'; delete x.op; } });
          continue;
        }
        if (st.state === 'error') {
          await videoUpdate((db) => { const x = db.items.find((i) => i.id === it.id); if (x) { x.status = 'failed'; x.error = st.message; delete x.op; } });
          continue;
        }
        const claimed = await videoUpdate((db) => { const x = db.items.find((i) => i.id === it.id); if (!x || x.status !== 'making' || (x.finalizing && now - x.finalizing < 60000)) return false; x.finalizing = now; return true; });
        if (!claimed) continue;
        try {
          let bytes = st.bytes;
          if (!bytes) {
            const r = await fetch(st.url);
            if (!r.ok) throw new Error('download ' + r.status);
            bytes = Buffer.from(await r.arrayBuffer());
          }
          const saved = await V.putFile('video-out/' + it.id + '.mp4', bytes, 'video/mp4');
          await videoUpdate((db) => { const x = db.items.find((i) => i.id === it.id); if (x) { x.status = 'ready'; x.videoUrl = saved.url; x.bytes = (x.imgBytes || 0) + bytes.length; delete x.op; delete x.finalizing; } });
        } catch (e) {
          console.error('video save failed', e && e.message);
          await videoUpdate((db) => { const x = db.items.find((i) => i.id === it.id); if (x) delete x.finalizing; }); // tried again on the next check
        }
      }
      return res.json(view(await videoRead()));
    }

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

    // Pictures in the chat (admin and private players only): the bytes go to their own key, the message only carries an id.
    if (b.op === 'chat') {
      const img = b.img;
      delete b.img;
      b.imgId = undefined; // never trust an id from the client
      if (img !== undefined && img !== null && img !== '') {
        const s = await readRoom(code);
        const me = s && s.members.find((m) => m.id === b.playerId);
        if (!me || !G.canLearn(me)) throw new G.GameError('Unknown action.');
        if (typeof img !== 'string' || img.length > 220000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img)) throw new G.GameError('That picture is too big or is not a picture.');
        b.imgId = randomBytes(9).toString('hex');
        await putImage(b.imgId, img);
      }
    }
    if (b.op === 'chatImage') {
      const s = await readRoom(code);
      const me = s && s.members.find((m) => m.id === b.playerId);
      if (!me || !G.canLearn(me)) throw new G.GameError('Unknown action.');
      const id = String(b.id ?? '').slice(0, 40);
      if (!(s.chat || []).some((m) => m.img === id)) throw new G.GameError('That picture is gone.');
      const data = await getImage(id);
      if (!data) throw new G.GameError('That picture has expired.');
      return res.json({ data });
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
