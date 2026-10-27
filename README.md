# GrowX Mindrelax (Node.js on Vercel)

Multiplayer card game. Static page in `public/`, game rules in a Vercel serverless function
(`api/game.js` + `api/_lib/game.js`). Browsers poll the function about every 1.5 s. Shared state lives
in Upstash Redis.

## Rules in this build

- 2–8 players, 108-card deck, **5 cards each**, classic rules (match colour/number/symbol, Skip, Reverse,
  Draw Two, Wild, Wild Draw Four only when you hold no card of the current colour). With 2 cards in hand, press
  **GrowX!** before playing the second-to-last card or draw 1 extra card.
- Play continues after someone empties their hand. **The last player still holding cards loses.**
- A turn left idle for 30 s: the player draws 1 penalty card and the turn moves to the next player
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
