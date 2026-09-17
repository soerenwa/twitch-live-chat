#!/usr/bin/env node
/*
 * twitch-chat.js — live Twitch chat extractor (anonymous, read-only)
 *
 * Connects to Twitch's official chat gateway (irc.chat.twitch.tv:6697, TLS)
 * as an anonymous "justinfan" user. No OAuth token or client ID required.
 * Zero npm dependencies — uses only Node's built-in `tls` module.
 *
 * Usage:
 *   node twitch-chat.js <channel|url> [options]
 *
 * Examples:
 *   node twitch-chat.js zackrawrr
 *   node twitch-chat.js https://www.twitch.tv/zackrawrr
 *   node twitch-chat.js xqc --seconds 30 --out chat.log
 *   node twitch-chat.js pokimane --json > chat.jsonl
 *
 * Options:
 *   --seconds N     Auto-exit after N seconds (default: run until Ctrl+C)
 *   --out FILE      Append every message to FILE (plain text)
 *   --json          Print each message as a JSON object (one per line)
 *   --no-color      Disable ANSI colors
 *   --raw           Also print raw IRC lines (debugging)
 *   -h, --help      Show this help
 */

const tls = require("tls");
const fs = require("fs");

// ---------- arg parsing ----------
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
  console.log(
    [
      "twitch-chat.js — live Twitch chat extractor (anonymous, read-only)",
      "",
      "Usage: node twitch-chat.js <channel|url> [options]",
      "",
      "  --seconds N   Auto-exit after N seconds",
      "  --out FILE    Append messages to FILE (plain text)",
      "  --json        Emit one JSON object per message (stdout)",
      "  --no-color    Disable ANSI colors",
      "  --raw         Also print raw IRC protocol lines",
      "  -h, --help    Show this help",
    ].join("\n")
  );
  process.exit(0);
}

function takeValue(flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}

const seconds = parseInt(takeValue("--seconds") || "0", 10);
const outFile = takeValue("--out");
const asJson = argv.includes("--json");
const noColor = argv.includes("--no-color") || !process.stdout.isTTY;
const showRaw = argv.includes("--raw");

// first non-flag arg is the channel/url
const channelArg = argv.find((a) => !a.startsWith("--"));
if (!channelArg) {
  console.error("Error: no channel given. Try: node twitch-chat.js <channel>");
  process.exit(1);
}

// Accept a bare name, twitch.tv/name, or a full https URL.
function parseChannel(input) {
  let s = String(input).trim();
  const m = s.match(/twitch\.tv\/([^/?#]+)/i);
  if (m) s = m[1];
  s = s.replace(/^#/, "").toLowerCase();
  // Twitch login names: letters, digits, underscore.
  s = s.replace(/[^a-z0-9_]/g, "");
  return s;
}

const channel = parseChannel(channelArg);
if (!channel) {
  console.error(`Error: could not parse a channel name from "${channelArg}"`);
  process.exit(1);
}

// ---------- helpers ----------
const out = outFile ? fs.createWriteStream(outFile, { flags: "a" }) : null;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

// Stable fallback color for users with no chat color set.
function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const palette = [
    [255, 99, 132], [54, 162, 235], [255, 206, 86], [75, 192, 192],
    [153, 102, 255], [255, 159, 64], [46, 204, 113], [231, 76, 60],
    [52, 152, 219], [155, 89, 182], [241, 196, 15], [26, 188, 156],
  ];
  return palette[h % palette.length];
}

function colorName(name, hex) {
  if (noColor) return name;
  const rgb = hexToRgb(hex) || hashColor(name);
  return `\x1b[1m\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${name}\x1b[0m`;
}

const dim = (s) => (noColor ? s : `\x1b[2m${s}\x1b[0m`);

// IRCv3 tag unescaping per spec.
function unescapeTag(v) {
  return String(v)
    .replace(/\\s/g, " ")
    .replace(/\\:/g, ";")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

// Minimal IRCv3 parser: [@tags] [:prefix] COMMAND params [:trailing]
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
  const trailingAt = rest.indexOf(" :");
  let trailing = null;
  if (trailingAt !== -1) {
    trailing = rest.slice(trailingAt + 2);
    rest = rest.slice(0, trailingAt);
  }
  const parts = rest.split(" ").filter(Boolean);
  msg.command = parts.shift();
  msg.params = parts;
  if (trailing !== null) msg.params.push(trailing);
  return msg;
}

function nickFromPrefix(prefix) {
  if (!prefix) return "";
  const bang = prefix.indexOf("!");
  return bang === -1 ? prefix : prefix.slice(0, bang);
}

function two(n) {
  return String(n).padStart(2, "0");
}
function stamp() {
  const d = new Date();
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

// ---------- connection ----------
let count = 0;
let socket = null;
let buffer = "";
let stopping = false;
let reconnectDelay = 1000;

function connect() {
  socket = tls.connect(
    { host: "irc.chat.twitch.tv", port: 6697, servername: "irc.chat.twitch.tv" },
    () => {
      const nick = "justinfan" + Math.floor(Math.random() * 90000 + 10000);
      socket.write("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
      socket.write(`NICK ${nick}\r\n`);
      socket.write(`JOIN #${channel}\r\n`);
      console.error(dim(`[connecting to #${channel} …]`));
    }
  );
  socket.setEncoding("utf8");

  socket.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      handleLine(line);
    }
  });

  socket.on("error", (e) => console.error(dim(`[socket error: ${e.message}]`)));

  socket.on("close", () => {
    if (stopping) return;
    console.error(dim(`[disconnected — reconnecting in ${reconnectDelay}ms]`));
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });
}

function handleLine(line) {
  if (showRaw) console.error(dim("< " + line));
  const msg = parseLine(line);

  switch (msg.command) {
    case "PING":
      socket.write(`PONG :${msg.params[0] || "tmi.twitch.tv"}\r\n`);
      return;
    case "001": // welcome
      reconnectDelay = 1000;
      return;
    case "JOIN":
      if (nickFromPrefix(msg.prefix).startsWith("justinfan"))
        console.error(dim(`[joined #${channel} — waiting for messages…]`));
      return;
    case "NOTICE":
      console.error(dim(`[notice] ${msg.params[msg.params.length - 1]}`));
      return;
    case "PRIVMSG":
      emitMessage(msg);
      return;
    default:
      return;
  }
}

function emitMessage(msg) {
  count++;
  const text = msg.params[msg.params.length - 1] || "";
  const name = msg.tags["display-name"] || nickFromPrefix(msg.prefix);
  const color = msg.tags.color || null;
  const time = stamp();

  if (asJson) {
    const rec = {
      ts: new Date().toISOString(),
      channel,
      user: name,
      login: nickFromPrefix(msg.prefix),
      color,
      message: text,
      badges: msg.tags.badges || "",
      "user-id": msg.tags["user-id"] || "",
    };
    const json = JSON.stringify(rec);
    process.stdout.write(json + "\n");
    if (out) out.write(json + "\n");
  } else {
    const pretty = `${dim(time)} ${colorName(name, color)}: ${text}`;
    console.log(pretty);
    if (out) out.write(`${time} ${name}: ${text}\n`);
  }
}

// ---------- lifecycle ----------
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.error(dim(`\n[stopped — ${count} messages captured from #${channel}]`));
  try { socket && socket.end(); } catch {}
  if (out) out.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);

if (seconds > 0) setTimeout(shutdown, seconds * 1000);

connect();
