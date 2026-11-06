# GrowX Mindrelax — configuration and how to connect

Every setting the app reads, and how to reach every service it uses. **No secret values are in this file** — only names, places and commands. Real values live in Vercel's environment variables. Never paste them into chat, a commit or a screenshot.

## 1. The pieces

| Piece | What it is | Where |
|---|---|---|
| App | plain Node 20+ (ES modules), no framework | `server.js` (local), `api/game.js` + `api/auth0.js` (Vercel functions) |
| Hosting | Vercel, free plan, project `growx-cards`, scope `karthi-4a8f`, region `bom1` (Mumbai) | https://growx-mindrelax.vercel.app (alias `growx-cards.vercel.app` redirects to it) |
| Source | GitHub `akashkarthi11/uno`, branch `main` | https://github.com/akashkarthi11/uno |
| Live room state | Redis Cloud Mumbai (primary) + Upstash Redis (backup) | section 4 |
| Accounts and stats | Neon Postgres, Singapore | section 5 |
| Login with Auth0 | Auth0 tenant (`us.auth0.com`) | section 6 |
| Voice relay | Cloudflare Realtime TURN | section 7 |
| AI videos | Replicate (models) + Vercel Blob (files) | section 8 |

`vercel.json`: region `bom1`; `api/game.js` may run 60 s; `/api/*` is never cached; the alias host redirects to the main URL. `/` is cached on Vercel's CDN until the next deploy.

## 2. Run it on this machine

This PC has no Node, so use Docker Desktop (start it if `docker info` fails).

```sh
# run the tests (repo mounted read-only, copied to /w)
MSYS_NO_PATHCONV=1 docker run --rm -v "C:/karthi/UAB/uno:/src:ro" node:20-alpine sh -c \
  "mkdir /w && cp -r /src/api /src/test /src/public /src/package.json /w/ && cd /w && npm install --silent && node --test test/"

# run the app locally on http://localhost:8080 (in-memory rooms, no database unless you pass env vars)
docker compose up --build
```

With no Redis variables the app keeps rooms in memory (fine for local and tests). With no Postgres variable, accounts and stats are off.

## 3. Environment variables

All names the code reads. "Where" is the Vercel project's *Settings → Environment Variables*.

### Roles and passwords
| Name | Purpose |
|---|---|
| `GAME_ADMIN_USERNAME` | the admin's username (default `karthi`) |
| `GAME_ADMIN_PASSWORD` | admin password |
| `GAME_PLAYER_PASSWORD` | public players' first-time password |
| `GAME_PRIVATE_PASSWORD` | private players' password |
| `GAME_OBSERVER_PASSWORD` | observer account password |
| `GAME_TOKEN_SECRET` | signs session tokens. If unset, it is derived from the Redis string and the passwords, so changing a password signs everyone out |

### Redis (room state)
| Name | Purpose |
|---|---|
| `MUMREDIS_REDIS_URL` / `MUMREDIS_URL` | Redis Cloud Mumbai, TCP (`redis://…`), used through ioredis |
| `MUM_KV_REST_API_URL`, `MUM_KV_REST_API_TOKEN` | an Upstash database added with the `MUM_` prefix (REST) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Upstash REST (the backup) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | the same Upstash values under Vercel KV's names |
| `GAME_PRIMARY` | `tcp` or `rest`: which one is the primary when both exist. The other takes over for 30 s after a failure |

### Postgres (accounts, stats)
| Name | Purpose |
|---|---|
| `SG_DATABASE_URL` | the Neon Singapore connection string (the one in use) |
| `DATABASE_URL`, `POSTGRES_URL` | fallbacks if `SG_DATABASE_URL` is not set |

### Auth0
| Name | Purpose |
|---|---|
| `AUTH0_DOMAIN` | tenant domain (currently `us.auth0.com`) |
| `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | the Auth0 application |

### Voice relay
| Name | Purpose |
|---|---|
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Cloudflare TURN key. `CF_TURN_API` overrides the API base (default `https://rtc.live.cloudflare.com`, tests only) |
| `GAME_TURN_URLS`, `GAME_TURN_USER`, `GAME_TURN_PASS` | your own TURN server instead (URLs comma separated) |

### AI videos
| Name | Purpose |
|---|---|
| `REPLICATE_API_TOKEN` | Replicate account token |
| `BLOB_READ_WRITE_TOKEN`, `BLOB_STORE_ID` | Vercel Blob store for the video files |
| `GAME_VIDEO_DAILY` (5), `GAME_VIDEO_MONTHLY` (30), `GAME_VIDEO_SECONDS` (5), `GAME_VIDEO_STORAGE_MB` (900) | limits, defaults in brackets |
| `GAME_VIDEO_MODEL_T2V`, `GAME_VIDEO_MODEL_I2V`, `GAME_VIDEO_REPLICATE_T2V`, `GAME_VIDEO_REPLICATE_I2V` | model names, defaults in `api/_lib/video.js` |

### Test and development only (never set in production)
`GAME_ADMIN_ANY_NAME=1` (admin password works with any name), `GAME_USERS_MEMORY=1` (accounts in memory), `GAME_VIDEO_FAKE=1`, `GAME_DEAL=off` (no dealing delay).

Set by Vercel itself: `VERCEL`, `VERCEL_REGION`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_GIT_COMMIT_SHA`. `PORT` is read by `server.js` (default 8080).

### Reading the real values safely
```sh
# pulls them into a git-ignored file inside a throwaway container; the file is deleted afterwards
MSYS_NO_PATHCONV=1 docker run --rm -v "C:/karthi/UAB/uno:/app" -v "C:/Users/THINKPAD/vercel-auth:/root/.local/share" -w /app node:20-alpine sh -c \
  "npx --yes vercel@latest env pull /tmp/.env.prod --environment=production --yes && <use it here> ; rm -f /tmp/.env.prod"
```
`.env*` is already in `.gitignore`. Do not copy the pulled file anywhere.

## 4. Connect to Redis

- **Redis Cloud (primary, TCP):** take `MUMREDIS_REDIS_URL` from the Vercel env, then
  `redis-cli -u "$MUMREDIS_REDIS_URL"` (or `docker run -it --rm redis:7-alpine redis-cli -u "<url>"` since this PC has no redis-cli).
  Keys use the `growx:` prefix, for example `growx:authmode`, `growx:backup:<id>`.
- **Upstash (backup, REST):**
  `curl -s "$UPSTASH_REDIS_REST_URL/get/growx:authmode" -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"` (on Windows add `--ssl-no-revoke`).
- The app tries the primary, and for 30 s after a failure it uses the other one.

### Redis first, Postgres behind (`api/_lib/dbqueue.js`)

Players never wait for Postgres. Accounts and game stats are read from Redis; changes go to Redis at once and to a queue, and the queue is applied to Postgres in the background.

| Redis key | Holds |
|---|---|
| `growx:acct:<name>` | one account by lower-case name (`local`: password hash, or `taken`: an Auth0 user / the admin). 24 h |
| `growx:rs:<room>:<mode>` | a room's whole table and last 10 games. 1 h |
| `growx:pt:<name>:<mode>` | one player's totals and streaks. 1 h |
| `growx:q:db` | the queue (a list): sign-ups, sign-in counts, finished games |
| `growx:q:dead` | jobs that failed 30 times (kept, never dropped) |
| `growx:q:lock`, `growx:q:due` | one drain at a time, at most one every 4 s |

- A read that misses Redis first lets the queue finish, then reads Postgres once and fills Redis.
- The queue is drained after the answer has been sent (Vercel `waitUntil`), whenever any request arrives and the queue is not empty. With nobody online it waits, safe in Redis, for the next request.
- Jobs are safe to run twice (finished games carry a `job_id`, sign-ups use `ON CONFLICT DO NOTHING`), so a crash in the middle loses nothing.
- Look at it: `LLEN growx:q:db` (should be 0 or tiny), `LLEN growx:q:dead` (should be 0).
- If Redis is wiped, accounts and stats are rebuilt from Postgres. Anything still in the queue at that moment is lost, so keep the queue short (it normally is).
- Auth0 sign-in and linking an account still write Postgres directly (rare, and they need the row at once).

## 5. Connect to Postgres (Neon, Singapore)

```sh
docker run -it --rm postgres:16-alpine psql "$SG_DATABASE_URL"
```
Tables (created on a cold start in one transaction, `api/_lib/users.js`): `growx_users`, `growx_games`, `growx_game_players`. Public-mode rows in `growx_games` were cleared once; private rows were kept. The old US-East Neon database was deleted. Manage it in the Neon console (Singapore region).

## 6. Auth0

- Tenant `us.auth0.com`. Application settings that must match the app:
  - Allowed Callback URL: `https://growx-mindrelax.vercel.app/api/auth0`
- The admin switch **Auth0 sign-in: on/off** (Settings) only shows or hides the Auth0 button. The own name + password login always works.
- Moving to a tenant in Japan or Australia: create the tenant and app, set the callback above, replace the three `AUTH0_*` variables in Vercel, redeploy, then re-link the admin's `auth0_sub` on the `karthi` row in `growx_users` (a new tenant gives a new subject id).

## 7. Voice relay (Cloudflare TURN)

In the Cloudflare dashboard create a TURN key (*Realtime → TURN*), put the key id in `CF_TURN_KEY_ID` and its token in `CF_TURN_API_TOKEN`. Calls try a direct connection first; each pair that has trouble gets the relay automatically. The admin's **📡 Relay** button cycles `auto → on → off`. With neither Cloudflare nor `GAME_TURN_*` set, only public STUN servers are used.

## 8. AI videos

Replicate makes the video; Vercel Blob keeps the file. Create a Blob store in the Vercel project (its token becomes `BLOB_READ_WRITE_TOKEN`) and a Replicate API token. Limits per day / month / storage are the `GAME_VIDEO_*` variables above.

## 9. Vercel and GitHub

```sh
# commit and push
git add -A && git commit -m "..." && git push origin main

# deploy to production (login is mounted from C:/Users/THINKPAD/vercel-auth)
MSYS_NO_PATHCONV=1 docker run --rm -v "C:/karthi/UAB/uno:/app" -v "C:/Users/THINKPAD/vercel-auth:/root/.local/share" \
  -w /app node:20-alpine sh -c "npx --yes vercel@latest deploy --prod --yes"
```
Deploys show under the `karthickkeyan303-9210` Vercel account. The repo root of the workspace (`C:\karthi\UAB`) is not a git repository; `uno` is. Windows `curl` needs `--ssl-no-revoke`.

## 10. Quick health checks

```sh
# the live site answers and the API rejects a bad token (proves the function and the stores are up)
curl -s --ssl-no-revoke -X POST https://growx-mindrelax.vercel.app/api/game \
  -H "content-type: application/json" -d '{"op":"roomList","sys":"bad"}'
# expected: {"build":"…","error":"Session expired — sign in again.","denied":true}
```
In the app, the admin's **Settings → Rooms** window lists rooms, and the header shows the live latency in milliseconds.

See also `README.md` (features and rules) and `HANDOFF.md` (project history and open items).
