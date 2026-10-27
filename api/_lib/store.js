// Room storage. Upstash Redis (REST) when configured, otherwise an in-memory map for local runs and tests.
import { randomUUID } from 'node:crypto';
import { newRoom } from './game.js';

const URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
export const usingRedis = Boolean(URL && TOKEN);

const TTL_SECONDS = 6 * 60 * 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roomKey = (code) => `growx:room:${code}`;
const lockKey = (code) => `growx:lock:${code}`;

let redis = null;
async function client() {
  if (!redis) {
    const { Redis } = await import('@upstash/redis');
    redis = new Redis({ url: URL, token: TOKEN });
  }
  return redis;
}

const mem = new Map();
const chains = new Map();

export async function readRoom(code) {
  if (!usingRedis) {
    const v = mem.get(code);
    return v ? structuredClone(v) : null;
  }
  const v = await (await client()).get(roomKey(code));
  if (!v) return null;
  return typeof v === 'string' ? JSON.parse(v) : v;
}

async function writeRoom(code, s) {
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
