// Auth0 hand-off (GET). /api/auth0 sends the browser to Auth0; Auth0 sends it back here with ?code&state, and we return it to the
// game page with a short signed ticket (?a0=...) that the system login (op "login") accepts. See api/_lib/auth0.js.
// A sign-in belongs to the system, not to a room, so the state and the ticket are made for the room name "*".
import { auth0Config, makeState, readState, makeTicket, nameFromCode } from './_lib/auth0.js';
import { getAuthMode } from './_lib/store.js';
import { usersEnabled, upsertAuth0, isOgAdminName } from './_lib/users.js';

const SYSTEM = '*';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const q = new URL(req.url, 'http://x').searchParams;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `https://${host}/api/auth0`;
  const cfg = auth0Config();
  const now = Date.now();
  const back = (params) => {
    res.statusCode = 302;
    res.setHeader('Location', `/?${new URLSearchParams(params)}`);
    res.end();
  };

  if (!cfg || (await getAuthMode()) !== 'auth0') return back({ a0err: 'Auth0 sign-in is not on.' });

  if (q.get('code')) {
    if (!readState(String(q.get('state') || ''), SYSTEM, cfg, now)) return back({ a0err: 'Sign-in expired — try again.' });
    try {
      const who = await nameFromCode(String(q.get('code')), redirectUri, cfg);
      let saved = false;
      if (usersEnabled()) {
        try { who.name = await upsertAuth0(who); saved = true; } catch { /* saving the user must never stop the sign-in */ }
      }
      // the Auth0 account that owns the admin's username signs in as the admin; only that account can hold that name (see upsertAuth0),
      // so a name that was not checked against the saved users never counts
      const admin = saved && isOgAdminName(who.name);
      return back({ a0: makeTicket(SYSTEM, who.name, cfg, now, admin) });
    } catch {
      return back({ a0err: 'Auth0 sign-in failed — try again.' });
    }
  }
  if (q.get('error')) return back({ a0err: 'Auth0 sign-in was cancelled.' });

  const to = new URLSearchParams({ response_type: 'code', client_id: cfg.id, redirect_uri: redirectUri, scope: 'openid profile email', state: makeState(SYSTEM, cfg, now) });
  res.statusCode = 302;
  res.setHeader('Location', `https://${cfg.domain}/authorize?${to}`);
  res.end();
}
