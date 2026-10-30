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
    )`).then(() => run.query('ALTER TABLE growx_users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false')).then(() => run.query('CREATE UNIQUE INDEX IF NOT EXISTS growx_users_local_name ON growx_users (username_key) WHERE kind = \'local\'')).catch((e) => { ready = null; throw e; });
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

/** The real admin's username: that name belongs to the admin only (the admin password signs in as it; nobody else can register it). */
export const ogAdminName = () => String(process.env.GAME_ADMIN_USERNAME || 'karthickkeyan303');
const isOgAdmin = (name) => key(name) === key(ogAdminName());
export const isOgAdminName = isOgAdmin;
/** The admin password only works together with the admin's username (GAME_ADMIN_ANY_NAME=1 lifts that: tests only). */
export const adminNameOk = (name) => process.env.GAME_ADMIN_ANY_NAME === '1' || isOgAdmin(name);

/** True when this username already belongs to somebody who is not a local account: the real admin, or an Auth0 user. */
export async function nameTaken(name) {
  if (isOgAdmin(name)) return true;
  if (useMem()) return mem.rows.some((r) => r.kind !== 'local' && r.username_key === key(name));
  return (await q("SELECT 1 FROM growx_users WHERE kind <> 'local' AND username_key = $1 LIMIT 1", [key(name)])).length > 0;
}

/**
 * Auth0 sign-in: remembers the person by Auth0's id and keeps their email current. Returns the username they play under:
 * the one already saved for them, else their Auth0 name, with a number added when somebody else already owns that name.
 */
export async function upsertAuth0({ sub, email, name }) {
  if (!sub) return name;
  const taken = async (n) => (useMem()
    ? mem.rows.some((r) => r.username_key === key(n) && r.auth0_sub !== sub)
    : (await q('SELECT 1 FROM growx_users WHERE username_key = $1 AND (auth0_sub IS NULL OR auth0_sub <> $2) LIMIT 1', [key(n), sub])).length > 0);
  const saved = useMem() ? mem.rows.find((x) => x.auth0_sub === sub) : (await q('SELECT username FROM growx_users WHERE auth0_sub = $1', [sub]))[0];
  let final = saved ? saved.username : name;
  if (!saved) for (let i = 2; (await taken(final)) || (isOgAdmin(final) && !saved); i++) final = `${name.slice(0, 13)} ${i}`;
  if (useMem()) {
    const r = mem.rows.find((x) => x.auth0_sub === sub);
    if (r) { Object.assign(r, { email, logins: r.logins + 1, last_login: Date.now(), is_admin: Boolean(r.is_admin) || isOgAdmin(r.username) }); return r.username; }
    mem.rows.push({ id: mem.seq++, kind: 'auth0', username: final, username_key: key(final), auth0_sub: sub, email, logins: 1, created_at: Date.now(), last_login: Date.now() });
    return final;
  }
  const rows = await q(`INSERT INTO growx_users (kind, username, username_key, auth0_sub, email, is_admin) VALUES ('auth0', $1, $2, $3, $4, $5)
    ON CONFLICT (auth0_sub) DO UPDATE SET email = EXCLUDED.email, last_login = now(), logins = growx_users.logins + 1, is_admin = growx_users.is_admin OR $5 RETURNING username`,
  [final, key(final), sub, email || null, isOgAdmin(final)]);
  return rows[0].username;
}

/**
 * The real admin signed in with the admin password under their own username: that sign-in is recorded on the same user row
 * (the Auth0 account with that name, when there is one), marked as the admin's. Creates the row when there is none yet.
 */
export async function touchAdmin(name) {
  if (useMem()) {
    const r = mem.rows.find((x) => x.username_key === key(name) && x.kind !== 'local');
    if (r) { r.logins++; r.last_login = Date.now(); r.is_admin = true; return; }
    mem.rows.push({ id: mem.seq++, kind: 'admin', username: name, username_key: key(name), is_admin: true, logins: 1, created_at: Date.now(), last_login: Date.now() });
    return;
  }
  const done = await q("UPDATE growx_users SET logins = logins + 1, last_login = now(), is_admin = true WHERE username_key = $1 AND kind <> 'local' RETURNING id", [key(name)]);
  if (!done.length) await q("INSERT INTO growx_users (kind, username, username_key, is_admin) VALUES ('admin', $1, $2, true)", [name, key(name)]);
}

/** Test helper: what the in-memory table holds. */
export const _memRows = () => mem.rows;
