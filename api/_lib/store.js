// Room storage. Upstash Redis (REST) when configured, otherwise an in-memory map for local runs and tests.
import { randomUUID } from 'node:crypto';
import { newRoom } from './game.js';

// Which databases exist (either, or both):
//   tcp   MUMREDIS_REDIS_URL    a standard redis:// / rediss:// address (e.g. a free Redis Cloud database)
//   rest  MUM_KV_REST_API_* (an Upstash database added with the prefix MUM_), else UPSTASH_REDIS_REST_* / KV_REST_API_*
// With both, GAME_PRIMARY ("tcp" or "rest") says which one is used; the other takes over while the primary is failing.
// With neither (local runs and tests) rooms live in memory.
const TCP_URL = process.env.MUMREDIS_REDIS_URL || process.env.MUMREDIS_URL;
const URL = process.env.MUM_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.MUM_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const KINDS = [TCP_URL && 'tcp', URL && TOKEN && 'rest'].filter(Boolean);
if (KINDS.length === 2 && process.env.GAME_PRIMARY === 'rest') KINDS.reverse();
export const usingRedis = KINDS.length > 0;

const TTL_SECONDS = 6 * 60 * 60;
const CALL_TIMEOUT_MS = 3000; // a database that does not answer in this time counts as failing
const DOWN_MS = 30000; // after a failure the other database is used for this long, then the primary gets another try
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roomKey = (code) => `growx:room:${code}`;
const lockKey = (code) => `growx:lock:${code}`;

const clients = new Map(); // kind -> connection
const downUntil = new Map(); // kind -> time until which it is skipped

async function connect(kind) {
  if (!clients.has(kind)) clients.set(kind, kind === 'tcp' ? await tcpClient() : await restClient());
  return clients.get(kind);
}

async function restClient() {
  const { Redis } = await import('@upstash/redis');
  return new Redis({ url: URL, token: TOKEN });
}

/** Wraps an ioredis connection so it answers to the same calls the REST client does (the rest of this file uses those). */
async function tcpClient() {
  const { default: IORedis } = await import('ioredis');
  // One connection per warm function instance; it is reused by every request that instance serves.
  const c = new IORedis(TCP_URL, { maxRetriesPerRequest: 1, connectTimeout: 2500, keepAlive: 10000, enableAutoPipelining: true });
  c.on('error', () => {}); // a dropped connection is retried by the next command; never crash the function
  return {
    get: (key) => c.get(key),
    set: async (key, val, o = {}) => {
      const args = [key, val];
      if (o.ex) args.push('EX', o.ex);
      if (o.px) args.push('PX', o.px);
      if (o.nx) args.push('NX');
      return c.set(...args);
    },
    del: (key) => c.del(key),
    rpush: (key, val) => c.rpush(key, val),
    expire: (key, secs) => c.expire(key, secs),
    lpop: (key, count) => c.lpop(key, count),
    scan: (cursor, o = {}) => c.scan(cursor, 'MATCH', o.match || '*', 'COUNT', o.count || 100),
    mget: (...keys) => c.mget(...keys),
  };
}

const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('database timeout')), CALL_TIMEOUT_MS))]);

/** Runs one command on the primary; if that fails, marks it down for a while and runs it on the other database. */
async function run(name, ...args) {
  const now = Date.now();
  const order = KINDS.filter((k) => (downUntil.get(k) || 0) <= now);
  let lastErr;
  for (const kind of order.length ? order : KINDS) {
    try {
      const c = await connect(kind);
      return await withTimeout(c[name](...args));
    } catch (e) {
      lastErr = e;
      if (KINDS.length > 1) downUntil.set(kind, Date.now() + DOWN_MS);
    }
  }
  throw lastErr;
}

/** Same calls as the REST client; every one goes through run() so failover applies everywhere. */
const db = {
  get: (...a) => run('get', ...a),
  set: (...a) => run('set', ...a),
  del: (...a) => run('del', ...a),
  rpush: (...a) => run('rpush', ...a),
  expire: (...a) => run('expire', ...a),
  lpop: (...a) => run('lpop', ...a),
  scan: (...a) => run('scan', ...a),
  mget: (...a) => run('mget', ...a),
};
async function client() {
  return db;
}

/** Median time of a few reads on each configured database, measured from where this code runs (the Vercel function). */
export async function benchmark(rounds = 15) {
  const out = {};
  for (const kind of KINDS) {
    const times = [];
    let errors = 0;
    try {
      const c = await connect(kind);
      await withTimeout(c.get('growx:bench')); // connection set-up is not counted
      for (let n = 0; n < rounds; n++) {
        const t0 = Date.now();
        try { await withTimeout(c.get('growx:bench')); times.push(Date.now() - t0); } catch { errors++; }
      }
    } catch { errors = rounds; }
    times.sort((a, b) => a - b);
    out[kind] = { medianMs: times.length ? times[Math.floor(times.length / 2)] : null, bestMs: times[0] ?? null, errors };
  }
  return { primary: KINDS[0] || 'memory', results: out };
}

const mem = new Map();
const chains = new Map();
const sigMem = new Map();
const sigKey = (code, id) => `growx:sig:${code}:${id}`;

/** Voice-chat signalling: a short-lived mailbox per player (kept outside the room object, no lock needed). */
export async function pushSignal(code, toId, msg) {
  if (!usingRedis) {
    const k = sigKey(code, toId);
    sigMem.set(k, [...(sigMem.get(k) || []), msg].slice(-200));
    return;
  }
  const r = await client();
  await r.rpush(sigKey(code, toId), JSON.stringify(msg));
  await r.expire(sigKey(code, toId), 120);
}

export async function takeSignals(code, id) {
  if (!usingRedis) {
    const k = sigKey(code, id);
    const list = sigMem.get(k) || [];
    sigMem.delete(k);
    return list;
  }
  const v = await (await client()).lpop(sigKey(code, id), 100);
  return (v || []).map((x) => (typeof x === 'string' ? JSON.parse(x) : x));
}

/**
 * Sign-in feed for the real admin: every sign-in to any room is dropped on one short-lived list; the admin's page takes
 * what is new with one cheap call. Anything older than an hour is not worth telling about and is skipped.
 */
const JOINS_KEY = 'growx:joins';
const JOINS_TTL = 3600;
let joinsMem = [];

/** The shutdown switch (the real admin's one button): while it is on, public players cannot sign in anywhere. */
const shutKey = 'growx:shutdown';
let shutMem = false;
export async function isShutdown() {
  if (!usingRedis) return shutMem;
  return Boolean(await (await client()).get(shutKey));
}
export async function setShutdown(on) {
  if (!usingRedis) { shutMem = Boolean(on); return; }
  const r = await client();
  if (on) await r.set(shutKey, '1'); else await r.del(shutKey);
}

/** The observer switch (the real admin's button): while it is off the observer account cannot sign in. */
const obsOffKey = 'growx:observeroff';
let obsOffMem = false;
export async function isObserverOff() {
  if (!usingRedis) return obsOffMem;
  return Boolean(await (await client()).get(obsOffKey));
}
export async function setObserverOff(off) {
  if (!usingRedis) { obsOffMem = Boolean(off); return; }
  const r = await client();
  if (off) await r.set(obsOffKey, '1'); else await r.del(obsOffKey);
}

/** AI videos: one small JSON value (the list and the counters), kept with no expiry. Edited under a lock; fn(db) changes it in place. */
const VIDEO_KEY = 'growx:video:index';
let videoMem = null;
export async function videoRead() {
  if (!usingRedis) return structuredClone(videoMem || { items: [], meta: {} });
  const v = await (await client()).get(VIDEO_KEY);
  if (!v) return { items: [], meta: {} };
  return typeof v === 'string' ? JSON.parse(v) : v;
}
export function videoUpdate(fn) {
  return locked('__video__', async () => {
    const db = await videoRead();
    const out = await fn(db);
    if (usingRedis) await (await client()).set(VIDEO_KEY, JSON.stringify(db));
    else videoMem = structuredClone(db);
    return out;
  });
}

export async function pushJoin(evt) {
  if (!usingRedis) {
    joinsMem = [...joinsMem, evt].slice(-100);
    return;
  }
  const r = await client();
  await r.rpush(JOINS_KEY, JSON.stringify(evt));
  await r.expire(JOINS_KEY, JOINS_TTL);
}

export async function takeJoins(now = Date.now()) {
  let list;
  if (!usingRedis) {
    list = joinsMem;
    joinsMem = [];
  } else {
    const v = await (await client()).lpop(JOINS_KEY, 50);
    list = (v || []).map((x) => (typeof x === 'string' ? JSON.parse(x) : x));
  }
  return list.filter((e) => now - e.t < JOINS_TTL * 1000);
}

/**
 * Backups of a room, kept for as long as the real admin wants them (no expiry). One small key each; the admin removes them.
 * At most MAX_BACKUPS are kept so they can never grow without limit.
 */
export const MAX_BACKUPS = 30;
const backupKey = (id) => `growx:backup:${id}`;
const backupsMem = new Map();

export async function saveBackup(entry) {
  if (!usingRedis) {
    backupsMem.set(entry.id, structuredClone(entry));
    return;
  }
  await (await client()).set(backupKey(entry.id), JSON.stringify(entry)); // no expiry
}

export async function listBackups() {
  if (!usingRedis) return [...backupsMem.values()].map((e) => structuredClone(e));
  const r = await client();
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await r.scan(cursor, { match: 'growx:backup:*', count: 200 });
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== '0' && keys.length < 200);
  const picked = [...new Set(keys)];
  if (!picked.length) return [];
  const vals = await r.mget(...picked);
  const out = [];
  for (const v of vals) {
    try { const e = typeof v === 'string' ? JSON.parse(v) : v; if (e && e.id) out.push(e); } catch { /* skip a damaged one */ }
  }
  return out;
}

export async function getBackup(id) {
  if (!usingRedis) return backupsMem.has(id) ? structuredClone(backupsMem.get(id)) : null;
  const v = await (await client()).get(backupKey(id));
  if (!v) return null;
  return typeof v === 'string' ? JSON.parse(v) : v;
}

export async function deleteBackup(id) {
  if (!usingRedis) { backupsMem.delete(id); return; }
  await (await client()).del(backupKey(id));
}

const closedKey = (code) => `growx:closed:${code}`;
const closedMem = new Map();
const CLOSED_SECONDS = 120; // players of a closed room are told so for this long (instead of quietly rejoining it)

/** Every room that exists right now, for the admin's Rooms window (up to `limit`; one scan and one batched read). */
export async function listRooms(limit = 200) {
  if (!usingRedis) return [...mem.entries()].slice(0, limit).map(([code, v]) => ({ code, room: structuredClone(v) }));
  const r = await client();
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await r.scan(cursor, { match: 'growx:room:*', count: 200 });
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== '0' && keys.length < limit);
  const picked = [...new Set(keys)].slice(0, limit);
  if (!picked.length) return [];
  const vals = await r.mget(...picked);
  const out = [];
  picked.forEach((k, i) => {
    let v = vals[i];
    try { if (typeof v === 'string') v = JSON.parse(v); } catch { v = null; }
    if (v && typeof v === 'object') out.push({ code: k.slice('growx:room:'.length), room: v });
  });
  return out;
}

/** Removes a room. Its players find out on their next check (they are not quietly let back in for a couple of minutes). */
export function closeRoom(code) {
  return locked(code, async () => {
    if (!usingRedis) {
      mem.delete(code);
      closedMem.set(code, Date.now() + CLOSED_SECONDS * 1000);
      return;
    }
    const r = await client();
    await r.del(roomKey(code));
    await r.set(closedKey(code), '1', { ex: CLOSED_SECONDS });
  });
}

export async function wasClosed(code) {
  if (!usingRedis) return (closedMem.get(code) || 0) > Date.now();
  return Boolean(await (await client()).get(closedKey(code)));
}

export async function readRoom(code) {
  if (!usingRedis) {
    const v = mem.get(code);
    return v ? structuredClone(v) : null;
  }
  const v = await (await client()).get(roomKey(code));
  if (!v) return null;
  return typeof v === 'string' ? JSON.parse(v) : v;
}

async function writeRoom(code, saved) {
  const { log, ...s } = saved; // the event log is never stored anywhere
  if (!usingRedis) {
    mem.set(code, structuredClone(s));
    return;
  }
  await (await client()).set(roomKey(code), JSON.stringify(s), { ex: TTL_SECONDS });
}

async function locked(code, fn) {
  if (!usingRedis) {
    const prev = chains.get(code) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    chains.set(code, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  const r = await client();
  const token = randomUUID();
  let got = false;
  for (let i = 0; i < 40 && !got; i++) {
    got = Boolean(await r.set(lockKey(code), token, { nx: true, px: 5000 }));
    if (!got) await sleep(75);
  }
  if (!got) throw new Error('Room busy, please retry.');
  try {
    return await fn();
  } finally {
    await r.del(lockKey(code));
  }
}

/** Loads (or creates) the room under a lock, runs fn(room), and saves it. If fn throws, nothing is saved. */
export function withRoom(code, fn) {
  return locked(code, async () => {
    const s = (await readRoom(code)) || newRoom(code);
    s.version += 1;
    const result = await fn(s);
    await writeRoom(code, s);
    return result;
  });
}

/** Pictures sent in the chat: kept apart from the room (they are big) for as long as a room lives. */
const imgMem = new Map();
export async function putImage(id, data) {
  if (!usingRedis) {
    imgMem.set(id, data);
    if (imgMem.size > 200) imgMem.delete(imgMem.keys().next().value);
    return;
  }
  await (await client()).set('growx:img:' + id, data, { ex: 6 * 3600 });
}
export async function getImage(id) {
  if (!usingRedis) return imgMem.get(id) || null;
  return (await (await client()).get('growx:img:' + id)) || null;
}
