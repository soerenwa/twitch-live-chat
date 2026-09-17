# Twitch Live Chat

Live, read-only extraction of any public Twitch channel's chat — **no account, no OAuth
token, no client ID, no scraping**. It talks to Twitch's official anonymous chat gateway
(the same feed overlays and `tmi.js` use).

Three ways to run it:

| # | Variant | Best for | Setup |
|---|---------|----------|-------|
| 1 | **Browser GUI** (`twitch-chat.html`) | just watch & export, multi-stream | **double-click the file** — zero install |
| 2 | **CLI** (`twitch-chat.js`) | logging, piping, automation | `node twitch-chat.js <channel>` |
| 3 | **Hosted service** (Docker) | always-on API / shared URL | `docker compose up` |

> The GUI is a single static file that connects the browser **straight to Twitch**, so it
> needs no backend — double-click it locally, or host it on **GitHub Pages / any static
> host**. The Docker service (variant 3) is only needed for a *server-side* API (SSE/JSON)
> you can automate against.

---

## 1. Browser GUI — no install ⭐

**Download [`twitch-chat.html`](twitch-chat.html) and double-click it.** It opens in your
browser. No server, no build, no dependencies.

- **One stream:** type a channel name or `twitch.tv/...` link, hit **Add**.
- **Many at once:** click **Streams**, paste a list (one per line, or separated by spaces
  or commas), hit **Add all & record** — every channel records in parallel.
- Each stream gets a chip with its live message count, its own **⬇ export** (that channel
  → JSON), and **✕** to stop it. Messages are color-tagged per channel.
- **Export everything combined:** **All .txt** / **All .json** in the toolbar.
- Filter (channel / user / message), autoscroll (pauses when you scroll up), light/dark,
  auto-reconnect.

### Host the GUI online (still no backend)

Because it's static, you can put it on **GitHub Pages**, Cloudflare Pages, Netlify, etc.
and share a URL. This repo is set up to serve it on GitHub Pages at:

```
https://soerenwa.github.io/twitch-live-chat/
```

> If your browser ever blocks a `file://` page from connecting, serve the folder instead:
> `python -m http.server 8000` then open `http://localhost:8000/twitch-chat.html`.

## 2. CLI (Node, zero dependencies)

Needs only Node (tested on v24). Uses the built-in `tls` module — nothing to install.

```bash
node twitch-chat.js <channel|url> [options]
```

Examples:

```bash
node twitch-chat.js zackrawrr
node twitch-chat.js https://www.twitch.tv/xqc --seconds 30 --out chat.log
node twitch-chat.js pokimane --json > chat.jsonl
```

| Option        | Effect                                             |
|---------------|----------------------------------------------------|
| `--seconds N` | Auto-exit after N seconds (default: until Ctrl+C)  |
| `--out FILE`  | Append every message to FILE (plain text)          |
| `--json`      | Emit one JSON object per message on stdout         |
| `--no-color`  | Disable ANSI colors                                |
| `--raw`       | Also print raw IRC lines (debugging)               |

Accepts a bare name (`xqc`), `twitch.tv/xqc`, or a full `https://…` link.

## 3. Hosted service (Docker)

A tiny, dependency-free Node server (`server.js`) that reuses the same anonymous gateway.
A **single shared upstream connection** joins channels on demand and fans each message out
to every subscriber, so many channels/clients cost one Twitch socket. It serves the GUI
**and** a live API. Idle channels are left automatically after their last subscriber.

### Run

```bash
docker compose up -d
# or, without compose:
docker build -t twitch-live-chat . && docker run -p 8080:8080 twitch-live-chat
# or, without Docker at all:
npm start        # === node server.js
```

Then open <http://localhost:8080> for the GUI.

### Endpoints

| Method & path | Description |
|---------------|-------------|
| `GET /` | the browser GUI |
| `GET /healthz` | JSON status (active channels, uptime) |
| `GET /api/stream/:channel[?history=N]` | live chat as **Server-Sent Events** (one JSON per event; optional last-N replay) |
| `GET /api/collect/:channel?seconds=N` | collect **N seconds** (1–60) then return one JSON array |

```bash
curl -N http://localhost:8080/api/stream/zackrawrr        # live stream
curl "http://localhost:8080/api/collect/xqc?seconds=10"   # 10s snapshot
```

Consume the stream from JS:

```js
const es = new EventSource("https://your-host/api/stream/zackrawrr");
es.onmessage = (e) => { const m = JSON.parse(e.data); console.log(m.user, m.message); };
```

Every message has the shape:

```json
{
  "ts": "2026-09-17T20:03:03.242Z",
  "channel": "zackrawrr",
  "user": "SomeName",
  "login": "somename",
  "color": "#8A2BE2",
  "badges": ["subscriber"],
  "message": "hello chat",
  "action": false
}
```

CORS is open (`*`) — the API returns public chat data, so browsers on any origin can read it.

### Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8080` | listen port |
| `BUFFER_SIZE` | `200` | messages kept per channel (for `?history`) |
| `MAX_CHANNELS` | `50` | max distinct channels joined at once |
| `IDLE_MS` | `60000` | leave a channel this long after its last subscriber |

### Deploy on Coolify (or any Docker host)

- New Resource → **Docker Compose** (point it at this repo) or **Dockerfile**.
- Assign a domain; set the exposed **port to `8080`** (Coolify reads the port from the URL).
- No inbound secrets and no env vars are required — override the ones above if you like.
- The container only needs **outbound TLS** to `irc.chat.twitch.tv:6697`.

---

## Why not `isaackogan/TwitchLive`?

That repo is an unpublished (`npm i twitchlive` → 404), reverse-engineered experiment whose
author explicitly says *"do not use this in production."* It isn't needed. Twitch runs an
**official anonymous chat gateway** any client can read without credentials:

- CLI & server → `irc.chat.twitch.tv:6697` over TLS
- GUI → `wss://irc-ws.chat.twitch.tv:443` (browser WebSocket)

Anonymous login is a random `justinfan#####` nick — read-only, cannot send messages.

## Notes & limits

- **Read-only & ToS-friendly.** Anonymous read access is a documented, supported use of the
  chat gateway. It cannot post, moderate, or see whispers.
- Chat only. It does **not** report whether a channel is *live* — an offline channel simply
  produces no messages (it still connects and joins).
- Emotes render as their text codes (e.g. `Kappa`), not images, to stay dependency-free.
- The GUI keeps the last ~500 messages on screen and up to 20,000 in memory for export.

## License

MIT — see [LICENSE](LICENSE).
