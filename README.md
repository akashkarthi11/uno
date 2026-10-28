# GrowX Mindrelax (Node.js on Vercel)

Multiplayer card game. Static page in `public/`, game rules in a Vercel serverless function
(`api/game.js` + `api/_lib/game.js`). Browsers poll the function about every 1.5 s. Shared state lives
in Upstash Redis.

## Rules in this build

- 2–8 players, 123-card deck (108 classic + 15 super cards, see below), **5 cards each by default (the admin can choose 3–10)**, classic rules (match colour/number/symbol, Skip, Reverse,
  Draw Two, Wild, Wild Draw Four only when you hold no card of the current colour). With 2 cards in hand, press
  **GrowX!** before playing the second-to-last card or draw 1 extra card.
- Play continues after someone empties their hand. **The last player still holding cards loses.**
- A turn left idle for the turn time (30 s by default; the admin sets 15-120 s in the lobby): the player draws 1 penalty card and the turn moves to the next player
  (if they had already drawn a card that turn, it just passes).
- Three passwords: `110299` = admin (only the admin can start a game), `123456` = public player,
  `281101` = private player.
- The admin decides whether a game is **public** or **private** (button in the lobby). A public game admits
  public players only; a private game admits private players only. Switching removes players already in the
  room who joined with the other password.
  Override all three with `GAME_PLAYER_PASSWORD`, `GAME_ADMIN_PASSWORD` and `GAME_PRIVATE_PASSWORD`.
- A player who goes quiet for 20 s is treated as offline and their turns are played automatically.

## Run locally (Docker, in-memory state)

```
docker compose up --build
```

Open http://localhost:8080. Other PCs on the network use `http://<this-pc-ip>:8080`.
Tests: `docker run --rm growx-cards:latest node --test test/`

## Deploy to Vercel (free)

1. Push this repo to GitHub (already at github.com/akashkarthi11/uno).
2. Vercel → Add New → Project → import the repo. No build settings needed.
3. In the project: **Storage** → Marketplace → **Upstash Redis** (free plan) → connect it to the project.
   This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`. (Without it the API answers "Storage not configured".)
4. Settings → Environment Variables: add `GAME_PLAYER_PASSWORD` and `GAME_ADMIN_PASSWORD`.
5. Redeploy. Share the Vercel URL; everyone uses the same `?room=` name to join the same table.

Free-tier note: each connected player costs about 1 Redis command per second, so a 4-player hour is roughly
15k commands. Check the current Upstash free limits.

## Lobby chat and voice chat

- **Chat:** everyone can send short messages (200 characters) and one-tap emoji reactions, in the lobby and during a game (💬 button). The chat is cleared when a game finishes or is restarted.
- **Voice chat:** only the admin and private players (password `281101`) see the **🎤 Join voice** button. Audio goes
  directly between browsers (WebRTC); the server only passes the set-up messages, and enforces who may use it.
  It uses free Google STUN servers. Players on very strict networks may not connect; to fix that add a TURN relay
  with `GAME_TURN_URLS`, `GAME_TURN_USER` and `GAME_TURN_PASS`. Each person must allow the microphone in their browser.

## Pause

The admin has a **⏸ Pause / ▶ Resume** button during a game. While paused nobody can play or draw, the turn timer is
frozen (and nothing times out), and a banner tells everyone. Resuming gives the player back the time they had left.

## Super cards (golden border, ★)

| Card | Count | Playable | Effect |
|---|---|---|---|
| 🔁 Play Again | 4 (one per colour) | on its colour or on another Play Again | you take another turn |
| 🧹 Sweep | 4 (one per colour) | on its colour or on another Sweep | every other card of that colour in your hand goes down with it (no effects, wilds are never swept) — it can empty your hand |
| 💥 Blast | 2 | any time (choose the next colour) | every other player draws 1 card |
| 🔄 Swap Hands | 2 | any time (choose colour + a player) | you and that player swap hands |
| 🎁 Gift | 2 | any time (choose the next colour) | give 1 random card to every other player; you always keep at least 1 |

### ✨ Master card (1 in the deck, plain blank face)

Playable any time. You pick a colour, then a player, then one super rule that is applied to that player:

| Rule | Effect on the chosen player |
|---|---|
| 🔁 Play Again | the turn jumps to them — they play next |
| 🧹 Sweep | all their cards of the new colour are put down |
| 💥 Blast | they draw 2 cards |
| 🔄 Swap Hands | you swap hands with them |
| 🎁 Gift | you give them 2 random cards (you keep at least 1) |
| +2 Draw Two | they draw 2 cards and lose their next turn |
| +4 Draw Four | they draw 4 cards and lose their next turn |

You can choose yourself for Play Again or Sweep; the other rules need another player.
(💥 Blast only makes them draw 2 — nobody loses a turn — whereas +2 also costs them their next turn.)

### Lobby settings: which super cards are in the game

Before a game starts (in the lobby, or on the results screen) the admin gets a **"Super cards in this game"** panel
with a tick box for each super card (Play Again, Sweep, Blast, Swap Hands, Gift, Master card), plus **All on / All off**.
Unticked cards are not put in the deck, the admin's pick-up menu no longer offers them, and the Master card does not
offer the matching rule. Everyone else sees the same list read-only, with the deck size. The choice is kept for the
room and can only be changed while no game is running.

## Caching rules (what is and isn't cached)

- **Game API (`/api/game`)**: never cached. Every answer, including errors, carries `Cache-Control: no-store, max-age=0`
  (set in the function and again in `vercel.json`); the page also asks `fetch` for `cache: "no-store"`.
- **Page files (html / js / css)**: Vercel's default `public, max-age=0, must-revalidate` + ETag, so the browser asks the
  CDN on every load and only re-downloads when a file changed. There is no service worker and no manifest.
- **Open tabs across a deploy**: every API answer includes the deployed `build` id. If it changes while a tab is open, a
  "🔄 A new version is available — Reload" bar appears, so nobody keeps running old page code against the new server.
- **Back/forward cache**: a page restored with the back button refreshes itself immediately.
- **Room data**: lives only in Redis (6 h expiry, refreshed by activity); the function keeps no copy between requests.

## Making it faster for players in India (Mumbai database)

Requests enter Vercel at Mumbai, but the function and database are in the US, which costs about 0.2 s per call. To fix it:

1. Vercel → project `growx-mindrelax` → **Storage** → create an **Upstash Redis** with primary region **Mumbai (ap-south-1)**,
   and give it the environment-variable prefix **`MUM_`** (CLI: `vercel integration add upstash/upstash-kv --name growx-mumbai-redis --prefix MUM_`).
2. Set `"regions": ["bom1"]` inside the `functions` → `api/game.js` entry of `vercel.json` (or in Settings → Functions → Region) and redeploy.

The code already prefers `MUM_KV_REST_API_URL` / `MUM_KV_REST_API_TOKEN` when they exist. Move the function **and** the
database together: either one alone is slower than today. Rooms live in the database, so games in progress are lost at the switch.

### Choosing for a wild-type card (colour / player / rule)

One sheet handles every step. It has **←** Back, **👁** Peek (hides the sheet so you can look at the table; a
"▲ Continue choosing" pill brings it back at the same step) and **✕** Close (also a tap outside, or Escape). Chips show
what you've chosen so far and are tappable to jump back. Closing leaves the card in your hand; tap it again to start
over. The sheet also closes by itself if your turn ends. The admin's draw-pile card picker has the same ✕ / tap-outside.

## Play offline on a hotspot (no internet, no Vercel)

The server needs only **Node 20+** (no `npm install`, no internet). Rooms are kept in the server's memory.

**Option A – a laptop hosts:** `docker compose up -d` (or `node server.js`). Everyone joins the same Wi-Fi/hotspot and opens
`http://<laptop-address>:8080`. On Windows allow the port once:
`netsh advfirewall firewall add rule name="GrowX 8080" dir=in action=allow protocol=TCP localport=8080`.

**Option B – an Android phone hosts (no laptop), using Termux** (install Termux from F-Droid):
1. One time, with internet: `pkg update && pkg install nodejs git`, then `git clone https://github.com/akashkarthi11/uno.git`
   (or copy just the `api`, `public` and `server.js` files onto the phone).
2. Switch the phone's hotspot on; the other phones join it.
3. In Termux: `cd uno && termux-wake-lock && node server.js`  (keep Termux open; exempt it from battery optimisation).
4. The host's address on its own hotspot is shown in `ip addr` (often `192.168.x.1`, or `10.x.x.1`). Everyone, including the
   host, opens `http://<that address>:8080`.

Notes: the game, chat, emoji and all cards work offline. **Voice chat does not** over plain `http://` (browsers only allow the
microphone on https or localhost). Bluetooth is not supported. Restarting the server clears the rooms.

### Table themes (admin, lobby)

The lobby settings have a **Table theme** picker. The admin's choice is stored for the room and applied to everyone at
the table, including players who join later. It is cosmetic, so it can be changed at any time, even mid-game.

| Theme | Look |
|---|---|
| **GrowX** (default) | the light GrowX wireframe look: purple/blue accents, white panels |
| **Classic** | bold red / yellow / green / blue cards, black card backs with a red oval, green felt table (no brand logo or name) |
| **Midnight** | dark mode with the purple glow |

Themes are plain CSS variables (`html[data-theme="…"]` in `public/style.css`), so adding another one is one CSS block, a
name in `THEMES` (`api/_lib/game.js`) and an entry in `THEME_INFO` (`public/app.js`).

### Admin-only settings

The lobby's **Admin settings** panel is shown to the admin only (public and private players never see it, though the chosen
theme and card choices apply to them). It controls: the **table theme**, the **cards dealt to each player** (3–10, default 5,
lobby only) and which **super cards** are in the deck (lobby only). The server refuses these changes from anyone else.

## Two databases: fastest first, the other as backup

The room store can use either or both of:

| Kind | Environment variables | Notes |
|---|---|---|
| `tcp` | `MUMREDIS_REDIS_URL` (a `redis://` / `rediss://` address, e.g. Redis Cloud) | uses the `ioredis` package |
| `rest` | `MUM_KV_REST_API_*`, else `UPSTASH_REDIS_REST_*` / `KV_REST_API_*` (Upstash) | uses `@upstash/redis` |

With both configured, `tcp` is primary unless `GAME_PRIMARY=rest`. If the primary errors or takes over 3 s, the other
database serves requests for 30 s, then the primary is tried again. The two databases do not copy each other, so a
switch means the table starts empty and players rejoin; it keeps the game available, it does not carry a game over.

To pick the primary, ask the live function to time both (admin password required):

    curl -s -X POST https://<your-site>/api/game -H 'Content-Type: application/json' \
      -d '{"op":"bench","room":"main","password":"<admin password>"}'

It answers with the function's region and each database's median read time in ms; make the lower one primary.

## Voice relay (TURN) — Cloudflare, free

Most voice calls connect directly. For phones that cannot (some mobile-data networks), a relay carries the audio.
In the Cloudflare dashboard: **Realtime → TURN → Create TURN key**. Then add two private variables to the Vercel project
(Production): `CF_TURN_KEY_ID` (the key id) and `CF_TURN_API_TOKEN` (its API token). The server mints short-lived
credentials from them (cached for 12 h per server instance); players never see the token, and public players get no voice
details at all. Without the variables voice uses STUN only. Check Cloudflare's current free allowance on its pricing page.
Static credentials from another provider also work via `GAME_TURN_URLS`, `GAME_TURN_USER`, `GAME_TURN_PASS`.

### Direct or relay: the admin's switch

Voice starts in the original **direct** mode (STUN only, audio goes straight between phones). The admin — and a player the
admin allowed to start games — has a **📡 Relay** button in the top bar, in the lobby and during a game. **On** adds the
relay servers above as a backup: a call uses them only when a direct route fails, so it uses little relay data. Switching
it on rebuilds the pairs that are not connected; switching it off restarts every pair so nothing keeps going through the
relay. The choice is stored with the room's settings (`settings.voiceRelay`, default off) and resets with the room.

## Card drop animation

A played card flies onto the pile: from the player's hand for my own card, from the avatar (with a name tag) for an opponent's. It is skipped when the device asks for reduced motion.

## Staying signed in after a refresh

Signing in returns a signed token (`api/_lib/token.js`). The page keeps it in `sessionStorage` (this tab only; closing the
tab forgets it) and shows it to the server (`op: session`) when the page loads, so a refresh goes straight back to the
lobby or table instead of the password form. The token names the room, the player and the role the password granted,
lasts 12 hours (renewed on each resume), and cannot be changed or made without the signing key. The key is derived from
`GAME_TOKEN_SECRET` if you set one (a long random string; recommended), otherwise from the Redis connection string/token
the server already has. A resume still follows the rules: removed players and players of the wrong public/private mode
are refused and see the password form. Changing any of the three game passwords (or the signing secret) signs everyone out.

### Voice joins by itself

Everyone who may use voice (the admin and private players) joins it automatically when they enter the room; the
browser asks for the microphone once. **Leave voice** is remembered for that tab (a refresh does not pull the player back
in), and **Join voice** brings them back. If the microphone is refused the page asks only once; the button tries again.

### Public voice switch

Voice is for the admin and private players. The admin's **🎙 Public voice** button in the top bar (also for a player the
admin allowed to start games) lets public players use it as well; turning it off again drops public players from the
call. It is shown only while the game is public (a private game has no public players): making a game private switches it off, and it cannot be switched on while private. It is stored with the room settings (`settings.publicVoice`, default off).
