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
