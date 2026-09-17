#!/usr/bin/env node
"use strict";
/*
 * server.js — hosted Twitch live chat service (zero dependencies, Node built-ins only).
 *
 * Reads Twitch's public chat gateway anonymously (a justinfan nick) — no OAuth token,
 * no client ID. A single shared TLS connection joins channels on demand and fans each
 * message out to every subscriber, so many channels/clients cost one upstream socket.
 *
 * Endpoints:
 *   GET /                                 -> the browser GUI (twitch-chat.html)
 *   GET /healthz                          -> JSON status
 *   GET /api/stream/:channel[?history=N]  -> Server-Sent Events live chat stream
 *   GET /api/collect/:channel?seconds=N   -> collect N seconds, return one JSON array
 *
 * Config (env): PORT=8080  BUFFER_SIZE=200  MAX_CHANNELS=50  IDLE_MS=60000
 */

const http = require("http");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "8080", 10);
const BUFFER_SIZE = parseInt(process.env.BUFFER_SIZE || "200", 10);
const MAX_CHANNELS = parseInt(process.env.MAX_CHANNELS || "50", 10);
const IDLE_MS = parseInt(process.env.IDLE_MS || "60000", 10);
const MAX_COLLECT_SECONDS = 60;

// ---------- IRC helpers (shared with the CLI) ----------
function unescapeTag(v) {
  return String(v).replace(/\\s/g, " ").replace(/\\:/g, ";")
    .replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}
function parseLine(line) {
  const msg = { tags: {}, prefix: null, command: null, params: [] };
  let rest = line;
  if (rest[0] === "@") {
    const sp = rest.indexOf(" ");
    rest.slice(1, sp).split(";").forEach((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) msg.tags[pair] = true;
      else msg.tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
    });
    rest = rest.slice(sp + 1);
  }
  if (rest[0] === ":") {
    const sp = rest.indexOf(" ");
    msg.prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const tAt = rest.indexOf(" :");
  let trailing = null;
  if (tAt !== -1) { trailing = rest.slice(tAt + 2); rest = rest.slice(0, tAt); }
  const parts = rest.split(" ").filter(Boolean);
  msg.command = parts.shift();
  msg.params = parts;
  if (trailing !== null) msg.params.push(trailing);
  return msg;
}
const nickOf = (p) => (!p ? "" : p.indexOf("!") === -1 ? p : p.slice(0, p.indexOf("!")));
function badgesOf(tagStr) {
  if (!tagStr) return [];
  return tagStr.split(",").map((b) => b.split("/")[0])
    .filter((b) => ["broadcaster", "moderator", "vip", "subscriber", "staff", "admin", "global_mod"].includes(b));
}
const validChannel = (s) => /^[a-z0-9_]{1,25}$/.test(s);

// ---------- shared chat hub ----------
class Hub {
  constructor() {
    this.socket = null;
    this.ready = false;
    this.buf = "";
    this.reconnectDelay = 1000;
    // channel -> { subs:Set<fn(rec)>, ring:[], joined:bool, idleTimer }
    this.channels = new Map();
  }

  ensure(ch) {
    let c = this.channels.get(ch);
    if (!c) { c = { subs: new Set(), ring: [], joined: false, idleTimer: null }; this.channels.set(ch, c); }
    return c;
  }

  connect() {
    if (this.socket) return;
    this.ready = false;
    const s = tls.connect(
      { host: "irc.chat.twitch.tv", port: 6697, servername: "irc.chat.twitch.tv" },
      () => {
        const nick = "justinfan" + Math.floor(Math.random() * 90000 + 10000);
        s.write("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
        s.write("NICK " + nick + "\r\n");
        this.ready = true;
        this.reconnectDelay = 1000;
        for (const [ch, c] of this.channels) { s.write("JOIN #" + ch + "\r\n"); c.joined = true; }
        console.log("[hub] connected; joined " + this.channels.size + " channel(s)");
      }
    );
    s.setEncoding("utf8");
    s.on("data", (chunk) => {
      this.buf += chunk;
      let nl;
      while ((nl = this.buf.indexOf("\r\n")) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 2);
        this.onLine(line);
      }
    });
    s.on("error", (e) => console.error("[hub] socket error: " + e.message));
    s.on("close", () => {
      this.socket = null; this.ready = false;
      for (const c of this.channels.values()) c.joined = false;
      if (this.channels.size) {
        console.error("[hub] disconnected; reconnecting in " + this.reconnectDelay + "ms");
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      }
    });
    this.socket = s;
  }

  join(ch) {
    this.connect();
    const c = this.ensure(ch);
    if (this.ready && !c.joined) { this.socket.write("JOIN #" + ch + "\r\n"); c.joined = true; }
  }

  part(ch) {
    const c = this.channels.get(ch);
    if (!c) return;
    if (this.ready && c.joined) { try { this.socket.write("PART #" + ch + "\r\n"); } catch {} }
    if (c.idleTimer) clearTimeout(c.idleTimer);
    this.channels.delete(ch);
    console.log("[hub] left #" + ch);
  }

  onLine(line) {
    const m = parseLine(line);
    if (m.command === "PING") { this.socket.write("PONG :" + (m.params[0] || "tmi.twitch.tv") + "\r\n"); return; }
    if (m.command !== "PRIVMSG") return;
    const ch = (m.params[0] || "").replace(/^#/, "");
    const c = this.channels.get(ch);
    if (!c) return;
    let text = m.params[m.params.length - 1] || "";
    let action = false;
    const am = /^ACTION (.*)$/.exec(text);
    if (am) { action = true; text = am[1]; }
    const rec = {
      ts: new Date().toISOString(),
      channel: ch,
      user: m.tags["display-name"] || nickOf(m.prefix),
      login: nickOf(m.prefix),
      color: m.tags.color || "",
      badges: badgesOf(m.tags.badges),
      message: text,
      action,
    };
    c.ring.push(rec);
    if (c.ring.length > BUFFER_SIZE) c.ring.shift();
    for (const fn of c.subs) { try { fn(rec); } catch {} }
  }

  // returns an unsubscribe function
  subscribe(ch, fn) {
    const c = this.ensure(ch);
    if (c.idleTimer) { clearTimeout(c.idleTimer); c.idleTimer = null; }
    c.subs.add(fn);
    this.join(ch);
    return () => this.unsubscribe(ch, fn);
  }
  unsubscribe(ch, fn) {
    const c = this.channels.get(ch);
    if (!c) return;
    c.subs.delete(fn);
    if (c.subs.size === 0) {
      c.idleTimer = setTimeout(() => { if (c.subs.size === 0) this.part(ch); }, IDLE_MS);
    }
  }
  atCapacity(ch) { return !this.channels.has(ch) && this.channels.size >= MAX_CHANNELS; }
}

const hub = new Hub();

// ---------- GUI ----------
let GUI = "<h1>twitch-chat.html not found next to server.js</h1>";
try { GUI = fs.readFileSync(path.join(__dirname, "twitch-chat.html")); } catch {}

// ---------- HTTP ----------
function cors(res) { res.setHeader("Access-Control-Allow-Origin", "*"); }
function sendJson(res, code, obj) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch { return sendJson(res, 400, { error: "bad request" }); }
  const p = url.pathname;

  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });

  if (p === "/" || p === "/index.html") {
    cors(res);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(GUI);
    return;
  }

  if (p === "/healthz") {
    return sendJson(res, 200, {
      status: "ok",
      uptime: Math.round(process.uptime()),
      activeChannels: hub.channels.size,
      maxChannels: MAX_CHANNELS,
      channels: [...hub.channels.keys()],
    });
  }

  let m;
  if ((m = p.match(/^\/api\/stream\/([^/]+)\/?$/))) {
    const ch = decodeURIComponent(m[1]).toLowerCase();
    if (!validChannel(ch)) return sendJson(res, 400, { error: "invalid channel name" });
    if (hub.atCapacity(ch)) return sendJson(res, 503, { error: "channel capacity reached" });

    cors(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");

    const hist = Math.min(Math.max(parseInt(url.searchParams.get("history") || "0", 10) || 0, 0), BUFFER_SIZE);
    if (hist) {
      const c = hub.ensure(ch);
      for (const rec of c.ring.slice(-hist)) res.write("data: " + JSON.stringify(rec) + "\n\n");
    }

    const unsub = hub.subscribe(ch, (rec) => { try { res.write("data: " + JSON.stringify(rec) + "\n\n"); } catch {} });
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
    req.on("close", () => { clearInterval(ping); unsub(); });
    return;
  }

  if ((m = p.match(/^\/api\/collect\/([^/]+)\/?$/))) {
    const ch = decodeURIComponent(m[1]).toLowerCase();
    if (!validChannel(ch)) return sendJson(res, 400, { error: "invalid channel name" });
    if (hub.atCapacity(ch)) return sendJson(res, 503, { error: "channel capacity reached" });

    let secs = parseInt(url.searchParams.get("seconds") || "10", 10);
    if (!Number.isFinite(secs)) secs = 10;
    secs = Math.max(1, Math.min(secs, MAX_COLLECT_SECONDS));

    const out = [];
    const unsub = hub.subscribe(ch, (rec) => out.push(rec));
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(timer); unsub();
      sendJson(res, 200, { channel: ch, seconds: secs, count: out.length, messages: out });
    };
    const timer = setTimeout(finish, secs * 1000);
    req.on("close", () => { if (!done) { done = true; clearTimeout(timer); unsub(); } });
    return;
  }

  sendJson(res, 404, { error: "not found", endpoints: ["/", "/healthz", "/api/stream/:channel", "/api/collect/:channel?seconds=N"] });
});

server.listen(PORT, () => {
  console.log("Twitch live chat service on http://0.0.0.0:" + PORT);
  console.log("  GUI:      /");
  console.log("  stream:   /api/stream/<channel>        (Server-Sent Events)");
  console.log("  collect:  /api/collect/<channel>?seconds=10");
  console.log("  health:   /healthz");
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
