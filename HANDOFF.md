# GrowX Mindrelax — handoff

Everything a fresh session needs to carry on. **No secrets are in this file.** Passwords, tokens and connection strings live only in Vercel's environment variables.

## What it is

A multiplayer UNO-style card game for friends. In the product it is called **GrowX Mindrelax**, and the word "UNO" never appears. Full feature notes are in `README.md`.

- Code: `C:\karthi\UAB\uno` (the workspace root `C:\karthi\UAB` is not a git repo; `uno` is).
- Stack: plain Node 20+ (ES modules), no framework. `public/` is the browser app (`app.js`, `index.html`, `style.css`, `voice.js`). `api/game.js` is the main handler, `api/auth0.js` the Auth0 callback, and `api/_lib/` holds the logic. `server.js` runs the same handlers locally and on Vercel.
- Tests: `node --test test/` (155 pass as of the last change).

## Where it lives

| Thing | Value |
|---|---|
| Production URL | https://growx-mindrelax.vercel.app |
| Alias | https://growx-cards.vercel.app (redirects to the URL above) |
| Vercel project | `growx-cards`, scope `karthi-4a8f`, region `bom1` (Mumbai), free plan |
| Function | `api/game.js`, `maxDuration` 60 s. `/api/*` is never cached. `/` is cached on the CDN until the next deploy (`Vercel-CDN-Cache-Control` in `server.js`). |
| GitHub | https://github.com/akashkarthi11/uno, branch `main` |
| Vercel login used | the `karthickkeyan303-9210` account (deploys show it) |

## Data stores

| Store | Used for | Env vars (names only) |
|---|---|---|
| Redis Cloud, Mumbai (primary) | live room state, tokens, switches (`growx:authmode` and similar) | `GAME_PRIMARY`, `MUMREDIS_URL`, `MUMREDIS_REDIS_URL`, `MUM_KV_REST_API_URL`, `MUM_KV_REST_API_TOKEN` |
| Upstash Redis (backup) | fallback copy of the same | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` |
| Neon Postgres, Singapore | accounts, Auth0 links, game history and stats (`growx_users`, `growx_games`, `growx_game_players`) | `SG_DATABASE_URL` (the one in use), with `DATABASE_URL` / `POSTGRES_URL` as older fallbacks |
| Vercel Blob | AI video files | `BLOB_READ_WRITE_TOKEN`, `BLOB_STORE_ID` |

The old US-East Neon database was deleted. Public-mode rows in `growx_games` were cleared once; private rows were kept. The schema is created on a cold start in one transaction (`api/_lib/users.js`).

## Other environment variables (names only)

- **Passwords and roles:** `GAME_ADMIN_USERNAME` (default `karthi`), `GAME_ADMIN_PASSWORD`, `GAME_PLAYER_PASSWORD`, `GAME_PRIVATE_PASSWORD`, `GAME_OBSERVER_PASSWORD`, `GAME_TOKEN_SECRET`.
- **Auth0:** `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`. The tenant is currently `us.auth0.com`. The callback URL is `https://growx-mindrelax.vercel.app/api/auth0`.
- **Voice relay (Cloudflare TURN):** `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`, `CF_TURN_API`. Own TURN as an alternative: `GAME_TURN_URLS`, `GAME_TURN_USER`, `GAME_TURN_PASS`.
- **AI video:** `REPLICATE_API_TOKEN`, `GAME_VIDEO_*` (limits, models, seconds).
- **Test and dev only:** `GAME_ADMIN_ANY_NAME=1`, `GAME_USERS_MEMORY=1`, `GAME_VIDEO_FAKE`, `GAME_DEAL`.

To read real values, run `vercel env pull` inside a throwaway container. Never print them or commit them.

## How to test and deploy

This machine has no Node. Docker Desktop is used instead (start it if `docker info` fails).

```sh
# tests (the repo is mounted read-only, copied to /w)
MSYS_NO_PATHCONV=1 docker run --rm -v "C:/karthi/UAB/uno:/src:ro" node:20-alpine sh -c \
  "mkdir /w && cp -r /src/api /src/test /src/public /src/package.json /w/ && cd /w && npm install --silent && node --test test/"

# commit and push
git add -A && git commit -m "..." && git push origin main

# deploy to production (Vercel login is mounted from C:/Users/THINKPAD/vercel-auth)
MSYS_NO_PATHCONV=1 docker run --rm -v "C:/karthi/UAB/uno:/app" -v "C:/Users/THINKPAD/vercel-auth:/root/.local/share" \
  -w /app node:20-alpine sh -c "npx --yes vercel@latest deploy --prod --yes"
```

Then delete the stray `package-lock.json` that npm leaves in the repo. On Windows, `curl` needs `--ssl-no-revoke`. For a visual check, use host Chrome headless with `--screenshot` and a window width of at least 520.

## Working agreements

- After every change: test, commit, push, deploy to production and verify it live. Do not hand the deploy back.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Do not name the game UNO anywhere in the product.
- Never print or commit secrets.

## Current behaviour worth knowing

- **Roles:** admin, private, public, observer. The system login gives a signed token that is then used to create or join rooms.
- **Login:** the own name-and-password login always works. The admin's switch only turns the **Auth0 button** on or off. Sessions survive the switch.
- **Voice relay:** three states: auto (the default, direct first and relay only for a pair that has trouble), on, and off.
- **Rooms:** the room screen lists active rooms that are on. A room that is off is not listed and needs its name and a PIN (4–8 digits, stored as a salted hash, 5 wrong tries lock guessing for 5 minutes). Only the room's creator can turn it off or on, from inside the room (lobby or Settings). The creator is stored as `owner` and `ownerRole`; an older room like `main` belongs to whoever joined it first, and a room the admin account made belongs to the admin account.
- **Deck:** 122 cards (108 classic and 14 super cards). Swap Hands has 1 copy. A super wild card played as the very last card needs no choices and wins.
- **Radar:** opt-in location sharing with a Direction list (bearing, distance, error, compass-turned arrows). The accuracy of the arrows on real phones has not been confirmed yet.

## Open items

1. **Auth0 tenant to Japan or Australia** (Auth0 has no India region): the owner creates the tenant and app, sets the callback URL, replaces the three `AUTH0_*` variables in Vercel, and says "done". Then redeploy, re-link the admin's `auth0_sub` on the `karthi` user row (a new tenant gives a new sub, otherwise a "karthi 2" user appears) and verify the redirect.
2. **Radar accuracy:** waiting on test details from real phones (devices, indoors or outdoors, what was shown).
3. **Not yet verified in a real browser or on phones:** the three relay states, the room list, the lock and PIN flow, the in-room Turn off button, the last-card super rule, real Auth0 sign-in timing.
4. **Offered, awaiting a go-ahead:** move Learn backups, room backups and the AI video list from Redis to Postgres; a duplicate-name rule between Auth0 and own names; Web Push for admin join alerts; Focus mode as a default.

## Continuing from the Claude app or web

Run `/remote-control` (or `/rc`) in the open session, then open https://claude.ai/code or the Claude app's Code tab. The session keeps running on this PC, so it must stay on. A new session can also just read this file and `README.md`.
