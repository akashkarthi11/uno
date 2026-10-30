// Auth0 sign-in for public players. Keys come from the Vercel project's environment (never from the code):
// AUTH0_DOMAIN (for example your-tenant.us.auth0.com), AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET.
// The browser is sent to Auth0, comes back to /api/auth0 with a code, the server swaps it for the person's name, and hands the
// page a two-minute signed ticket that /api/game accepts once, as a public player. Nothing here ever reaches the browser but that ticket.
import { signToken, verifyToken } from './token.js';

export const auth0Config = () => {
  const domain = String(process.env.AUTH0_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const id = process.env.AUTH0_CLIENT_ID;
  const secret = process.env.AUTH0_CLIENT_SECRET;
  return domain && id && secret ? { domain, id, secret } : null;
};

const TICKET_MS = 2 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;
const salt = (kind, cfg) => `a0-${kind}|${cfg.secret}`;

/** The "state" sent to Auth0 and returned unchanged: proves the callback answers a sign-in this server started, for this room. */
export const makeState = (room, cfg, now) => signToken({ r: room, p: 'a0', role: 'public', t: now }, now, salt('state', cfg));
export function readState(state, room, cfg, now) {
  const c = verifyToken(state, room, now, salt('state', cfg));
  return c && now - c.t < STATE_MS ? c : null;
}

/** The ticket the page presents to join: names the room and the person, good for two minutes. */
export const makeTicket = (room, name, cfg, now) => signToken({ r: room, p: 'a0', role: 'public', n: String(name).slice(0, 16), t: now }, now, salt('ticket', cfg));
export function readTicket(ticket, room, cfg, now) {
  const c = verifyToken(ticket, room, now, salt('ticket', cfg));
  return c && now - c.t < TICKET_MS && typeof c.n === 'string' ? c : null;
}

/** Swaps the code Auth0 sent back for who signed in: Auth0's id, email and display name. */
export async function nameFromCode(code, redirectUri, cfg) {
  const t = await fetch(`https://${cfg.domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', client_id: cfg.id, client_secret: cfg.secret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(8000),
  });
  if (!t.ok) throw new Error('token ' + t.status);
  const { access_token: at } = await t.json();
  if (!at) throw new Error('no token');
  const u = await fetch(`https://${cfg.domain}/userinfo`, { headers: { Authorization: `Bearer ${at}` }, signal: AbortSignal.timeout(8000) });
  if (!u.ok) throw new Error('userinfo ' + u.status);
  const j = await u.json();
  const name = String(j.nickname || j.name || String(j.email || '').split('@')[0] || 'Player').trim() || 'Player';
  return { sub: String(j.sub || ''), email: typeof j.email === 'string' ? j.email : '', name };
}
