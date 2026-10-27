# UNO Online (Spring Boot + WebSocket, Docker)

Multiplayer UNO. The Spring Boot server holds all game state and rules; browsers connect over a
WebSocket (`/ws`) and are served from the same port.

## Run

```
docker compose up --build
```

Open http://localhost:8080. Other PCs on the same network open `http://<host-pc-ip>:8080`
(find the IP with `ipconfig`; allow port 8080 through Windows Firewall).

Everyone who opens the link with the same `?room=` name joins the same table, e.g.
`http://192.168.1.20:8080/?room=friday`. The first player is the host and presses **Start**
(2–8 players, 5 cards each). Classic rules, but play continues until one player is left holding
cards — that player loses. People who join during a game are dealt in next game. A dropped player's turns are
played automatically; reopening the link rejoins the same seat.

## Without Docker

`mvn spring-boot:run` (Java 17+, Maven 3.9+).

## Layout

- `src/main/java/com/uno/Room.java` — game rules and per-room state (synchronized)
- `src/main/java/com/uno/GameSocketHandler.java` — WebSocket entry, rooms map
- `src/main/resources/static/` — browser client (index.html, app.js, style.css)

## Deploy: page on Vercel, server on Render (both free)

Vercel cannot run the WebSocket server, so the two halves are hosted separately.

1. Push this folder to a GitHub repo.
2. **Render** → New → Blueprint (uses `render.yaml`) → set `UNO_PLAYER_PASSWORD` and
   `UNO_ADMIN_PASSWORD` → deploy. Note the URL, e.g. `https://growx-cards-server.onrender.com`.
3. Edit `src/main/resources/static/config.js`: `window.GROWX_BACKEND = "wss://growx-cards-server.onrender.com";`
4. **Vercel** → Add New Project → import the repo. `vercel.json` publishes
   `src/main/resources/static` as a static site. Share the Vercel URL with players.

The free Render server sleeps when idle (first connection takes about a minute) and loses any game in
progress when it does.
