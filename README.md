# Twitch Live Chat

Live, read-only extraction of any public Twitch channel's chat. No account, no OAuth
token, no client ID, no scraping.

## Why not `isaackogan/TwitchLive`?

That repo is an unpublished (`npm i twitchlive` → 404), reverse-engineered experiment;
the author explicitly says *"do not use this in production."* It isn't needed. Twitch
runs an **official anonymous chat gateway** (the IRC/TMI interface) that any client can
read without credentials — the same feed every chat overlay and `tmi.js` bot uses. Both
tools here talk to that directly.

- CLI  → `irc.chat.twitch.tv:6697` over TLS
- GUI  → `wss://irc-ws.chat.twitch.tv:443` (browser WebSocket)

Anonymous login is a random `justinfan#####` nick — read-only, cannot send messages.

## 1. `twitch-chat.js` — command-line (zero dependencies)

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

## 2. `twitch-chat.html` — browser GUI (multi-stream)

Just **double-click the file** — it opens in your browser, no server required.

**One stream:** type a channel or link in the top box and hit **Add**.

**Many streams at once:** click **Streams** to open the paste panel, drop in a list
(one per line, or separated by spaces/commas), and hit **Add all & record**. Every
channel is joined on a single connection and recorded simultaneously. Each shows up as a
chip with its live message count, its own **⬇ export** (that channel only, as JSON), and
**✕** to stop it. Messages are tagged by channel color so mixed feeds stay readable.

**Export**
- Per stream: the **⬇** on each chip → `twitch-<channel>-<timestamp>.json`.
- Everything combined: **All .txt** / **All .json** in the toolbar (the `.txt` prefixes
  each line with `[channel]` when more than one stream is present).

Features: live per-stream + global counters (msgs, msgs/min, chatters, streams) · text
filter (matches channel, user, or message) · autoscroll toggle (pauses when you scroll
up) · Clear · light/dark toggle · auto-reconnect. Keeps up to 20,000 messages in memory
for export and renders the most recent 500.

> If your browser ever blocks the connection from a `file://` page, serve the folder
> instead: `python -m http.server 8000` then open `http://localhost:8000/twitch-chat.html`.

## Notes & limits

- **Read-only & ToS-friendly.** Anonymous read access is a documented, supported use of
  the chat gateway. It cannot post, moderate, or see whispers.
- Chat only. It does **not** confirm whether a channel is *live* — an offline channel
  simply produces no messages (you'll still see it connect and join).
- Emotes render as their text codes (e.g. `Kappa`), not images, to stay dependency-free.
- The GUI keeps the last ~400 messages on screen and up to 8000 in memory for export.

## Turning this into a hosted service

If you want a persistent, always-on service (e.g. on Coolify or any Docker host) rather
than a local tool — a small FastAPI/Node process that connects per channel and exposes a
WebSocket/SSE or a REST `GET /chat/{channel}` endpoint — that's a straightforward next
step on the same anonymous gateway.
