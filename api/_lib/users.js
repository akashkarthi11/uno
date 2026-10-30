// User accounts for public players, kept in Postgres (Neon, free plan): one row per person.
//   local  = signed in with our own login: a username and a password they chose themselves on their first sign-in.
//   auth0  = signed in through Auth0: Auth0's id, email and display name.
// The shared passwords (admin, co-admin, private, observer) never touch this table. Passwords are stored only as salted scrypt hashes.
// The connection string comes from the Vercel project (DATABASE_URL or POSTGRES_URL). Without it, sign-in keeps working the old way
// (the shared public password), so a missing database never locks anyone out. GAME_USERS_MEMORY=1 uses an in-memory table for tests.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const URL_ENV = () => process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
export const usersEnabled = () => Boolean(URL_ENV()) || process.env.GAME_USERS_MEMORY === '1';

export const MIN_PASSWORD = 6;

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `s1$${salt.toString('base64url')}$${scryptSync(pw, salt, 32).toString('base64url')}`;
}
export function checkPassword(pw, stored) {
  const [v, salt, hash] = String(stored || '').split('$');
  if (v !== 's1' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = scryptSync(String(pw), Buffer.from(salt, 'base64url'), want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

/* ---- storage: Postgres, or a Map in tests ---- */
const mem = { rows: [], seq: 1 };
let sqlPromise = null;
let ready = null;

async function sql() {
  if (!sqlPromise) {
    sqlPromise = import('@neondatabase/serverless').then(({ neon }) => neon(URL_ENV()));
  }
  return sqlPromise;
}
async function q(text, params = []) {
  const run = await sql();
  if (!ready) {
    ready = run.query(`CREATE TABLE IF NOT EXISTS growx_users (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL,
      pw_hash TEXT,
      auth0_sub TEXT UNIQUE,
      email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login TIMESTAMPTZ NOT NULL DEFAULT now(),
      logins INTEGER NOT NULL DEFAULT 1
    )`).then(() => run.query('CREATE UNIQUE INDEX IF NOT EXISTS growx_users_local_name ON growx_users (username_key) WHERE kind = \'local\'')).catch((e) => { ready = null; throw e; });
  }
  await ready;
  return run.query(text, params);
}

const key = (name) => String(name).trim().toLowerCase();
const useMem = () => !URL_ENV();

/** The local account with this username, or null. */
export async function findLocal(username) {
  if (useMem()) return mem.rows.find((r) => r.kind === 'local' && r.username_key === key(username)) || null;
  return (await q("SELECT id, username, pw_hash FROM growx_users WHERE kind = 'local' AND username_key = $1", [key(username)]))[0] || null;
}

/** First sign-in: creates the account with the person's own password. Returns null when the username was taken a moment ago. */
export async function createLocal(username, password) {
  const pw_hash = hashPassword(password);
  if (useMem()) {
    if (mem.rows.some((r) => r.kind === 'local' && r.username_key === key(username))) return null;
    const row = { id: mem.seq++, kind: 'local', username, username_key: key(username), pw_hash, logins: 1, created_at: Date.now(), last_login: Date.now() };
    mem.rows.push(row);
    return row;
  }
  const rows = await q("INSERT INTO growx_users (kind, username, username_key, pw_hash) VALUES ('local', $1, $2, $3) ON CONFLICT DO NOTHING RETURNING id, username", [username, key(username), pw_hash]);
  return rows[0] || null;
}

export async function touchLocal(id) {
  if (useMem()) { const r = mem.rows.find((x) => x.id === id); if (r) { r.logins++; r.last_login = Date.now(); } return; }
  await q('UPDATE growx_users SET logins = logins + 1, last_login = now() WHERE id = $1', [id]);
}

/** Auth0 sign-in: remembers the person by Auth0's id; keeps their email and name current. */
export async function upsertAuth0({ sub, email, name }) {
  if (!sub) return;
  if (useMem()) {
    const r = mem.rows.find((x) => x.auth0_sub === sub);
    if (r) { Object.assign(r, { email, username: name, username_key: key(name), logins: r.logins + 1, last_login: Date.now() }); return; }
    mem.rows.push({ id: mem.seq++, kind: 'auth0', username: name, username_key: key(name), auth0_sub: sub, email, logins: 1, created_at: Date.now(), last_login: Date.now() });
    return;
  }
  await q(`INSERT INTO growx_users (kind, username, username_key, auth0_sub, email) VALUES ('auth0', $1, $2, $3, $4)
    ON CONFLICT (auth0_sub) DO UPDATE SET username = EXCLUDED.username, username_key = EXCLUDED.username_key, email = EXCLUDED.email, last_login = now(), logins = growx_users.logins + 1`,
  [name, key(name), sub, email || null]);
}

/** Test helper: what the in-memory table holds. */
export const _memRows = () => mem.rows;
