// Redis first, database behind it.
//   - Reads: the hot data (accounts, game stats) is kept in Redis as small JSON keys. A miss reads Postgres once and fills Redis.
//   - Writes: a change is applied to Redis at once and also put on a queue (a Redis list). A drain applies the queue to Postgres in the
//     background, in order, a batch at a time. Nothing waits for Postgres on the way to the player.
// The queue is at-least-once: a job leaves the list only after it was applied, so every job handler must be safe to run twice.
// A job that keeps failing is retried (it goes to the back of the line) and after MAX_TRIES moves to growx:q:dead, never lost.
// Without Redis (local runs and tests) the keys and the queue live in memory, and a memory database is drained at once.
import { randomUUID } from 'node:crypto';
import { usingRedis, rawRedis } from './store.js';

const Q = 'growx:q:db';
const DEAD = 'growx:q:dead';
const LOCK = 'growx:q:lock';
const DUE = 'growx:q:due';
const MAX_TRIES = 30;
const DEAD_KEEP = 200;
export const DEFAULT_TTL = 24 * 60 * 60;

const memKv = new Map();
const memList = new Map(); // list key -> array
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ioredis returns the stored text; Upstash has already turned JSON text into values. Accept both.
const parse = (x) => {
  if (typeof x !== 'string') return x;
  try { return JSON.parse(x); } catch { return x; }
};

async function r() { return usingRedis ? rawRedis() : null; }

/** A JSON value, or null. */
export async function kvGet(k) {
  const c = await r();
  if (!c) return memKv.has(k) ? structuredClone(memKv.get(k)) : null;
  const v = await c.get(k);
  return v === null || v === undefined ? null : parse(v);
}
/** Stores a JSON value; with nx only when the key is new. Returns true when it was stored. */
export async function kvSet(k, v, ttl = DEFAULT_TTL, { nx = false } = {}) {
  const c = await r();
  if (!c) {
    if (nx && memKv.has(k)) return false;
    memKv.set(k, structuredClone(v));
    return true;
  }
  const o = { ex: ttl };
  if (nx) o.nx = true;
  return Boolean(await c.set(k, JSON.stringify(v), o));
}
export async function kvDel(k) {
  const c = await r();
  if (!c) { memKv.delete(k); return; }
  await c.del(k);
}

async function lpush(key, job) {
  const c = await r();
  if (!c) { memList.set(key, [...(memList.get(key) || []), job]); return; }
  await c.rpush(key, JSON.stringify(job));
}
async function llen(key) {
  const c = await r();
  if (!c) return (memList.get(key) || []).length;
  return Number(await c.llen(key)) || 0;
}
async function lrange(key, n) {
  const c = await r();
  if (!c) return (memList.get(key) || []).slice(0, n);
  return ((await c.lrange(key, 0, n - 1)) || []).map(parse);
}
async function ltrim(key, n) {
  const c = await r();
  if (!c) { memList.set(key, (memList.get(key) || []).slice(n)); return; }
  await c.ltrim(key, n, -1);
}

/* ---- jobs ---- */
const handlers = new Map();
/** A module that owns a table registers how its jobs are applied to the database. */
export function registerJob(type, fn) { handlers.set(type, fn); }

/** Puts a job on the queue. `inline` (a memory database) applies it right away so tests see the result. */
export async function enqueue(type, data, { inline = false } = {}) {
  await lpush(Q, { id: randomUUID(), t: type, d: data, n: 0, at: Date.now() });
  if (inline) await drain({ force: true });
}

export const queueLength = () => llen(Q);
export const deadLength = () => llen(DEAD);

async function release(token) {
  const c = await r();
  if (!c) { if (memKv.get(LOCK) === token) memKv.delete(LOCK); return; }
  if (parse(await c.get(LOCK)) === token) await c.del(LOCK);
}
async function takeLock(token) {
  const c = await r();
  if (!c) { if (memKv.has(LOCK)) return false; memKv.set(LOCK, token); return true; }
  return Boolean(await c.set(LOCK, JSON.stringify(token), { nx: true, px: 30000 }));
}

/**
 * Applies the queue to the database, oldest first, until it is empty or `budgetMs` is used up.
 * Only one drain runs at a time (a lock in Redis). On the first failure the round stops, so a database that is down
 * costs one try per round, not one per job.
 */
export async function drain({ budgetMs = 8000, force = false } = {}) {
  if (!force && !(await llen(Q))) return 0;
  const token = randomUUID();
  if (!(await takeLock(token))) return 0;
  const until = Date.now() + budgetMs;
  let done = 0;
  try {
    while (Date.now() < until) {
      const batch = await lrange(Q, 25);
      if (!batch.length) break;
      let used = 0;
      let failed = false;
      for (const job of batch) {
        const fn = handlers.get(job.t);
        try {
          if (!fn) throw new Error(`no handler for ${job.t}`);
          await fn(job.d, job);
          used++; done++;
        } catch {
          // the failed job goes to the back of the line with one more try, or to the dead list when it keeps failing
          used++;
          if (job.n + 1 >= MAX_TRIES) {
            await lpush(DEAD, { ...job, n: job.n + 1 });
            const c = await r();
            if (c) await c.ltrim(DEAD, -DEAD_KEEP, -1); else memList.set(DEAD, (memList.get(DEAD) || []).slice(-DEAD_KEEP));
          } else {
            await lpush(Q, { ...job, n: job.n + 1 });
          }
          failed = true;
          break;
        }
      }
      await ltrim(Q, used);
      if (failed) break;
    }
  } finally {
    await release(token);
  }
  return done;
}

/**
 * Before a read that goes to the database (a cache miss): lets the queue finish first, so the database is not behind.
 * If another drain is running, waits for it a moment.
 */
export async function flush() {
  if (!(await llen(Q))) return;
  for (let i = 0; i < 30; i++) {
    await drain({ budgetMs: 4000 });
    if (!(await llen(Q))) return;
    await sleep(100);
  }
}

/**
 * Called after every request: when the queue has work and nobody drained in the last few seconds, drain now.
 * It runs after the answer was sent (see `afterResponse`), so players never wait for it.
 */
export async function drainIfDue() {
  try {
    if (!(await llen(Q))) return;
    if (!(await kvSet(DUE, 1, 4, { nx: true }))) return;
    await drain();
  } catch { /* the queue stays; the next request tries again */ }
}

let waitUntilFn;
/** Keeps the function alive for background work on Vercel (waitUntil); elsewhere the process just keeps running. */
export async function afterResponse(promise) {
  if (waitUntilFn === undefined) waitUntilFn = await import('@vercel/functions').then((m) => m.waitUntil).catch(() => null);
  const p = Promise.resolve(promise).catch(() => {});
  if (waitUntilFn && process.env.VERCEL) waitUntilFn(p);
  return p;
}

/** Test helper. */
export const _reset = () => { memKv.clear(); memList.clear(); };
