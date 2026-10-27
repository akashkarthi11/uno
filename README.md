# GrowX Cards (Node.js on Vercel)

Multiplayer card game. Static page in `public/`, game rules in a Vercel serverless function
(`api/game.js` + `api/_lib/game.js`). Browsers poll the function about every 1.5 s. Shared state lives
in Upstash Redis.

## Rules in this build

- 2–8 players, 108-card deck, **5 cards each**, classic rules (match colour/number/symbol, Skip, Reverse,
  Draw Two, Wild, Wild Draw Four only when you hold no card of the current colour, call **GrowX!** at one
  card or draw 2).
- Play continues after someone empties their hand. **The last player still holding cards loses.**
- Password `123456` joins as a player, `110299` joins as admin. Only the admin can start a game.
  Override with the environment variables `GAME_PLAYER_PASSWORD` and `GAME_ADMIN_PASSWORD`.
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
