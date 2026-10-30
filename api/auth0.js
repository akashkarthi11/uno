// Auth0 hand-off (GET). ?action=login&room=X sends the browser to Auth0; Auth0 sends it back here with ?code&state, and we
// return it to the game page with a short signed ticket (?a0=...) that the join call accepts. See api/_lib/auth0.js.
import { auth0Config, makeState, readState, makeTicket, nameFromCode } from './_lib/auth0.js';
import { getAuthMode } from './_lib/store.js';
import { usersEnabled, upsertAuth0 } from './_lib/users.js';

const cleanRoom = (raw) => (/^[A-Za-z0-9_-]{1,24}$/.test(String(raw ?? '').trim()) ? String(raw).trim() : 'main');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `https://${host}/api/auth0`;
  const cfg = auth0Config();
  const now = Date.now();
  const back = (room, params) => {
    res.statusCode = 302;
    res.setHeader('Location', `/?room=${encodeURIComponent(room)}&${new URLSearchParams(params)}`);
    res.end();
  };

  if (!cfg || (await getAuthMode()) !== 'auth0') return back(cleanRoom(q.get('room')), { a0err: 'Auth0 sign-in is not on.' });

  if (q.get('code')) {
    const room = cleanRoom(q.get('room') || '');
    // the room travels inside the signed state, so read it from there first
    let claim = null;
    const raw = String(q.get('state') || '');
    try { claim = readState(raw, JSON.parse(Buffer.from(raw.split('.')[0], 'base64url').toString('utf8')).r, cfg, now); } catch { /* forged or damaged */ }
    if (!claim) return back(room, { a0err: 'Sign-in expired — try again.' });
    try {
      const who = await nameFromCode(String(q.get('code')), redirectUri, cfg);
      if (usersEnabled()) await upsertAuth0(who).catch(() => {}); // saving the user must never stop the sign-in
      return back(claim.r, { a0: makeTicket(claim.r, who.name, cfg, now) });
    } catch {
      return back(claim.r, { a0err: 'Auth0 sign-in failed — try again.' });
    }
  }
  if (q.get('error')) return back(cleanRoom(q.get('room')), { a0err: 'Auth0 sign-in was cancelled.' });

  const room = cleanRoom(q.get('room'));
  const to = new URLSearchParams({ response_type: 'code', client_id: cfg.id, redirect_uri: redirectUri, scope: 'openid profile email', state: makeState(room, cfg, now) });
  res.statusCode = 302;
  res.setHeader('Location', `https://${cfg.domain}/authorize?${to}`);
  res.end();
}
