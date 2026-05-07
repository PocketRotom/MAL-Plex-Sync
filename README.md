# MALSync Plex Bridge

A small Node.js / Express server that receives Plex webhooks and syncs your watch progress to **MyAnimeList**.

```
_node/
├── src/
│   ├── server.js       — Express app, routes, OAuth endpoints
│   ├── plexHandler.js  — Plex webhook parsing + sync orchestration
│   ├── mal.js          — MAL v2 API (search, get entry, update progress)
│   └── storage.js      — JSON-file persistence (tokens + title→id cache)
├── data/               — Created automatically on first run
│   ├── tokens.json     — OAuth tokens (do not commit)
│   └── cache.json      — Title → MAL ID cache (7-day TTL)
├── .env.example
└── package.json
```

---

## Quick start

```bash
cd _node
npm install
cp .env.example .env
# Edit .env — at minimum set MAL_CLIENT_ID
npm start
```

---

## Authentication

### MyAnimeList

1. Create a MAL API client at <https://myanimelist.net/apiconfig>  
   - App type: **Other**  
   - Redirect URI: `http://localhost:3000/auth/mal/callback`  
2. Copy the **Client ID** into `.env` as `MAL_CLIENT_ID`
3. Open `http://localhost:3000/auth/mal` in a browser — you will be redirected to MAL to approve access, then back to the server. Tokens are saved to `data/tokens.json`.

---

## Plex setup

In Plex, go to **Settings → Webhooks** and add:

```
http://YOUR_SERVER_IP:3000/webhook/plex
```

For local testing use a tool like [ngrok](https://ngrok.com) to expose port 3000.

---

## API reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhook/plex` | Plex webhook receiver |
| `GET` | `/auth/mal` | Start MAL OAuth flow |
| `GET` | `/auth/mal/callback` | MAL OAuth redirect URI |
| `GET` | `/status` | Auth status + config summary |
| `GET` | `/cache` | Dump title→id cache |
| `DELETE` | `/cache/:titleKey` | Delete a cache entry to force re-lookup |

---

## Notes

- **MAL token refresh** is handled automatically. MAL tokens expire after ~31 days; the server will refresh using the stored `refresh_token` when a 401 is received. If the refresh also fails (refresh token expired), revisit `/auth/mal`.
- The `data/` directory is gitignored. Back up your tokens separately if needed.
