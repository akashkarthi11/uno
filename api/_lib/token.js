// Session tokens: proof that this browser already signed in, so a refresh does not ask for the password again.
// A token is "payload.signature" (HMAC-SHA256). It names the room, the player and the role the password granted, and
// expires after TOKEN_TTL_MS. The signing key is derived (HMAC) from a secret the server already has, first match wins:
// GAME_TOKEN_SECRET, else the Redis connection string / token, plus the three game passwords, so changing a password
// also signs everybody out. Nothing in a token is secret, but nobody can make or change one without the key.
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
// With none of those (local runs, tests) a random key lasts as long as the process.
const FALLBACK_SECRET = randomBytes(32).toString('hex');
const base = () => process.env.GAME_TOKEN_SECRET || process.env.MUMREDIS_REDIS_URL || process.env.KV_REST_API_TOKEN
  || process.env.UPSTASH_REDIS_REST_TOKEN || FALLBACK_SECRET;

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (body, salt) => {
  const key = createHmac('sha256', base()).update(`growx-session-token-v1|${salt}`).digest();
  return createHmac('sha256', key).update(body).digest();
};

export function signToken(claim, now, salt) {
  const body = b64(JSON.stringify({ ...claim, exp: now + TOKEN_TTL_MS }));
  return `${body}.${b64(sign(body, salt))}`;
}

/** Returns the claim, or null if the token is forged, damaged, expired, or meant for another room. */
export function verifyToken(token, room, now, salt) {
  const [body, sig, extra] = String(token || '').split('.');
  if (!body || !sig || extra !== undefined || body.length > 1000) return null;
  const want = sign(body, salt);
  let got;
  try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let claim;
  try { claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!claim || claim.r !== room || !(claim.exp > now) || typeof claim.p !== 'string') return null;
  if (!['admin', 'private', 'public', 'observer'].includes(claim.role)) return null;
  return claim;
}
