<div align="center">

# 📵 Link-Demo — "Your Phone Is the Phish"

### A live, operator-driven security-awareness demo that turns a single innocent link into a full **account-takeover theater**: silent fingerprinting → live keystroke streaming → credential + **2FA/OTP capture** → remote phone control (torch, vibration, siren, camera, GPS) — all narrated in real time to a Telegram C2.

`Express` · `Vanilla JS` · `Telegram Bot API` · `Web APIs (getUserMedia · WebRTC · Vibration · WebAudio · Geolocation)`

> **Educational simulation for authorized security talks & demos.** Uses fake credentials, a simulated SMS, and a volunteer's own phone. Run it only with consent. Full presenter playbook → [`TALK_RUNBOOK.md`](TALK_RUNBOOK.md)

</div>

---

## 🎯 The Point

Every audience member has a phone. This demo proves, in 5 minutes and **zero installs**, that the most dangerous link is the one that looks *official*.

One tap on a WhatsApp "notes PDF" link and a device is silently turned into an open dossier — then an operator on the other side of the world **turns the victim's own phone against itself**: flashlight on in their pocket, a buzz out of nowhere, a police siren, their front camera snapping frames, a red **"NEW SIGN-IN"** takeover banner that shows them their own stolen password *and* 2FA code on screen.

Not a single permission is requested for 90% of it. **That is the talk.**

```
                        ┌──────────────────────────────────────────────┐
                        │              THE "VICTIM"                    │
                        │  WhatsApp → /d/notes.pdf  →  "SJBIT portal"  │
                        │                                              │
                        │   👀 silent dossier (0 permissions)          │
                        │   ⌨️ keystrokes stream live                  │
                        │   🔐 fake sign-in → email + password         │
                        │   🔑 fake "2FA" page → 6-digit OTP           │
                        │                                              │
                        │   then the phone itself becomes the prop:    │
                        │   🔦 torch · 📳 buzz · 🔊 voice · 🚨 siren   │
                        │   📸 selfie burst · 📍 GPS · 🚨 nudge overlay│
                        └───────────────▲──────────────────────────────┘
                                        │   every 3s: /command poll
                                        │
                        ┌───────────────┴──────────────────────────────┐
                        │              THE OPERATOR (C2)               │
                        │                                              │
                        │  Telegram bot ── /list /who /buzz /torch …   │
                        │  /console <id> ── one-tap button console    │
                        │  /admin?key=…  ── browser ops dashboard     │
                        │  /dash         ── auto-refreshing Telegram   │
                        │                   live board                 │
                        └──────────────────────────────────────────────┘
```

---

## 🧬 The Attack Chain — What "Everything So Far" Does

### Stage 0 — The Lure (PDF)
The demo WhatsApp group gets a file that *looks* like college notes: **`/d/notes.pdf`** (`public/notes.pdf`). The first person to open it earns a loud C2 alert (`/stats` counts every open). The PDF's link drops them onto the phishing page with `?ref=pdf`.

### Stage 1 — Silent Dossier (zero permissions)
On page load the client assembles a deep fingerprint and POSTs it to `/collect`. **No permission prompts are shown for any of this:**

| Harvested | How (all silent) |
|---|---|
| Platform, browser, webview, language(s), timezone, local time | `navigator.userAgent` / `language` / `Intl` |
| Screen, dark mode, touch support, max touch points, plugins | `screen` / `matchMedia` / `navigator` |
| CPU cores, device RAM | `hardwareConcurrency` / `deviceMemory` |
| Battery level + charging state | Battery Status API (no prompt on Android) |
| Network type (4g/wifi…) + live measurement | Network Information API + `/ping` bandwidth probe |
| GPU model, **WebGL hash**, audio fingerprint | WebGL renderer + `OfflineAudioContext` |
| **Local + public IP (WebRTC leak)** | `RTCPeerConnection` + STUN candidates |
| Media devices present (cam/mic count) | `enumerateDevices` |
| DRM level (Widevine robustness) | `requestMediaKeySystemAccess` |
| Installed font probing | hidden-span width comparison |
| Storage quota estimate | `navigator.storage.estimate` |
| **Permission states for camera / mic / location / notifications** | `permissions.query` — reveals what the victim has *ever* granted elsewhere |
| Return-visit detection | `localStorage` |
| IP → city/region/ISP/coords | server-side geo lookup after response |

New device → full dossier message is pushed to Telegram with inline **Console / Dashboard / All devices** buttons.

### Stage 2 — Live Keystroke Streaming
Everything typed is relayed with context tags (`password field`, `otp field`, `search box`…). Password & OTP fields flush **instantly**; the rest debounce into a live-edit stream that the dashboard shows **while the victim is still typing**. Keystroke dynamics (timing between keys) and an online-typing presence indicator ride along.

The browser's own **autofill is harvested**: hidden off-screen fields (`name`, `tel`, `organization`, `street`, `postal`) sit inside the fake sign-in form so a single autofill fills the dossier with the victim's real identity details.

### Stage 3 — Credential Capture (the convincing part)
"Sign in with your SJBIT account to download notes" → **`/creds`** fires a loud Telegram alert:

```
🔐 CREDENTIALS CAPTURED — 🤖 Android
Email: 1sj22cs001@sjbit.edu.in
Password: hunter2
IP: 103.x.x.x
breach-dump line: 1sj22cs001@sjbit.edu.in:hunter2:103.x.x.x
```

### Stage 4 — OTP / 2FA Capture (the twist that makes the talk)
Real phish-kits die here: they have the password but *not* the one-time code. This kit fakes the next step — **"SAMARTH SSO flagged this sign-in as new"** — and shows a **Simulated SMS** right on the victim's screen with a generated 6-digit code. The victim types it into the phish, the attacker now holds `email : password : OTP`:

```
⚡ Full ATO chain (email:password:otp):
1sj22cs001@sjbit.edu.in:hunter2:483920:103.x.x.x
```

Each capture appends one line to `dump.txt` (fetch it with `/dump`, or export everything with `/csv`).

> **Honesty on stage:** the SMS is simulated and shown on the victim's own screen. The demo's message — *an attacker who already holds your password only needs to mirror one more screen to hold your 2FA too* — is exactly what real AiTM/phish-kits do.

### Stage 5 — The Pretext Gauntlet ("download verified… one more step")
A fake download bar completes, then two permission-baited cards appear, each wearing an official-looking campus policy:

- **🏫 Campus Attendance Verification** → "prove you're on campus (85% attendance rule)" → **Geolocation**. Grant once and `watchPosition` streams the victim's location **forever** — `/gps` re-triggers silently.
- **🪪 SJBIT ID Card Verification** → "COE exam-hall photo policy" → **front camera**. The frame is shown back to the victim ("matching against the student database…") to sell the pretext, and shipped to the C2.

Both cards are also revealed instantly with **`?test=1`** in the URL for rehearsals.

### Stage 6 — Operator Takeover (the phone becomes the prop)
The page polls `/command` every 3 seconds. The operator's queued effects execute on the victim's phone — see the full remote-control reference below.

---

## 🎛 Remote Control — Commands

### Telegram C2 console
Send `/help` to your bot for the live list. IDs are the 12-char visitor short-IDs from `/list`.

**Recon / intel**

| Command | What you get |
|---|---|
| `/list` | every device: `🖥️ id · Windows · 87%🔋 · 4g · Bengaluru, IN · 🟢` |
| `/filter android` | filter by `android` `ios` `windows` `mac` `linux` |
| `/who <id>` | full dossier card (fingerprint, permissions, location, stage) |
| `/keys <id> [n]` | last *n* keystroke entries with context tags |
| `/creds` | all captured credentials |
| `/events <id>` | behavior narration log for a device |
| `/heat <id>` | the victim's **touch heatmap** as a photo |
| `/stats` | totals: devices, online, keystrokes, creds, **OTP codes**, PDF opens, autofill harvests, crowd opt-ins |
| `/dump` | `dump.txt` (the live `email:password:otp:ip` feed) as a file |
| `/csv` | full breach-dump CSV of every session |
| `/dash` | one self-editing live Telegram board (no spam) |
| `/console <id>` | opens a button-driven console for that device |

**Actuators (executed on the victim's phone within ~3 s)**

| Command | Effect | Platform reality |
|---|---|---|
| **`/buzz <id>`** | 📳 vibration burst `[500,200,500,200,1000]` | **Android only.** Chrome needs a prior tap on the page + visible tab + haptics enabled (not Silent/DND; Android 14 "Touch feedback" must be on). Result is reported back to the C2: *fired / blocked / unsupported*. |
| **`/torch <id>`** · `/torch <id> off` | 🔦 rear **LED flashlight** on/off via `torch` track constraint on the live rear-camera stream | **Android Chrome only**, needs camera permission granted once (the selfie card does it). iOS has no torch API → silent no-op. |
| `/selfie <id> [1-6]` | 📷 front-camera **burst** (default 3 frames) → one Telegram album | once camera is granted: fires with **no prompt**. |
| `/gps <id>` | 📍 location fix request | if location was ever granted: **silent tracking**. |
| `/nudge <id> [msg]` | 🚨 full-screen red **"NEW SIGN-IN"** takeover banner + vibration — shows the victim *their own* stolen email/password/OTP on screen | everywhere (screen overlay) |
| `/speak <id> <text>` | 🔊 text-to-speech, e.g. *"This device has been compromised."* | Android Chrome / desktop; iOS varies |
| `/flash <id>` | ⚡ white screen strobe ×8 | everywhere |
| `/siren <id>` | 🚨 600→1400 Hz audio sweep ×2 + vibration + red pulse | audio needs one prior tap to unlock WebAudio (auto-primed on first interaction) |

### 🖥 Browser ops dashboard
**`/admin?key=<ADMIN_KEY>`** — dark auto-refreshing (3 s) dashboard: per-device cards with battery/network/geo/online status, the last 30 keystrokes with context tags, live credential + OTP chain completion badges. JSON feed: `/admin/data?key=…`.

### 🎟 Crowd mode
**`/crowd.html`** (or `/?crowd=1`, which redirects so the phish page never leaks) is a consent-only live audience counter — dark UI, big number, anonymous per-phone dedupe via `localStorage`. **No Telegram, no disk, no IP logging.** Poll it with `/crowd`. Serves as the "honest control sample" next to the phish.

---

## 📡 Every Client→Server Endpoint

| Endpoint | Purpose |
|---|---|
| `POST /collect` | full silent dossier (first visit → loud Telegram alert) |
| `POST /keys` | live keystrokes with context + dynamics |
| `POST /typing` | online-typing presence |
| `POST /autofill` | autofill honey-field harvest |
| `POST /event` | behavior narration (scroll, tab-hide, network change…) |
| `POST /creds` | credentials capture → loud alert + `dump.txt` |
| `POST /otp` | **2FA code capture → full ATO chain** |
| `POST /exit` | `sendBeacon` dwell summary (fires even on tab close) |
| `POST /heatmap` | touch heatmap PNG upload (on tab hide) |
| `POST /gps` | geolocation pin (throttled, silent updates) |
| `POST /selfie?burst=N&last=1` | selfie frames / bursts (raw PNG bodies, ≤15 MB) |
| `GET /command?vid=…` | C2 command queue poll (every 3 s) |
| `GET /ping?n=…` | bandwidth probe asset |
| `POST /crowd-ping` · `GET /crowd` | crowd opt-in counter |
| `GET /d/notes.pdf` | PDF lure (hit-logged) |
| `GET /admin` · `/admin/data` | ops dashboard + JSON |
| `POST /perm` | permission-outcome tally (drives `/stats`) |
| `POST /otp` + `/creds` → `dump.txt` | append-only plain-text breach dump |

---

## 🧱 Files

```
link-demo/
├── server.js              # Express C2: all endpoints, Telegram console/relay,
│                          # geo lookups, sessions store, live dashboards,
│                          # twin-instance lock + update dedupe
├── public/
│   ├── index.html         # THE phish — SJBIT portal lookalike (creds→OTP→pretexts)
│   ├── crowd.html         # consent-only live audience counter
│   ├── notes.pdf          # the "notes PDF" lure (served at /d/notes.pdf)
│   └── sjbit-logo.svg     # official-looking branding
├── smoke_dash_test.js     # end-to-end smoke harness for the whole pipeline
├── preload-tg-stub.js     # redirects api.telegram.org → local fake (safe CI tests)
├── TALK_RUNBOOK.md        # presenter script: honesty, consent, stage flow, cleanup
└── README.md              # this file
```

Runtime state is **never committed**: `config.json`, `sessions.json`, `dump.txt`, `tgstate-*.json`, `run-*.lock`, `server.log` are git-ignored.

---

## 🚀 Run It

### Local

```bash
npm install
cp config.example.json config.json   # or skip → env vars below
node server.js
# → http://localhost:3000  ·  C2 console = your bot
```

### Render (or any Node host)

```bash
# Render: Node service, build `npm install`, start `node server.js`
```

Set these **environment variables** (they override `config.json`):

| Env | Required | Notes |
|---|---|---|
| `BOT_TOKEN` | ✅ | Telegram bot token from [@BotFather](https://t.me/BotFather) |
| `CHAT_ID` | ✅ | your numeric chat id (message @userinfobot) |
| `ADMIN_KEY` | ⚠️ | protects `/admin` — **change it**, default is `changeme` |
| `PORT` | — | default `3000` |

### Smoke test (never touches the real bot)

```bash
node -r ./preload-tg-stub.js smoke_dash_test.js
```

The preload stub rewrites every `api.telegram.org` call to a local fake, so the full pipeline (sessions → keystrokes → creds → OTP → dashboard) is validated **without the real token or a live victim page**. Note the stub lives only in the test file — the server itself calls the real Telegram API.

---

## 🔒 Operational Notes (from real deployments)

- **Two instances polling the same bot token** duplicate every message. The server persists a per-token update offset + seen-update log (`tgstate-*.json`) and warns loudly at boot via a lock file (`run-*.lock`) if another instance is already polling. Render free-tier sleep/wake is safe; don't point two services at one token.
- **Dossier spam is suppressed**: Telegram gets a *loud* dossier only on a session's **first** visit; reloads and returning visits are quiet feed lines.
- **Every hardware effect has platform truth** (see the actuator table): torch/buzz are Android-Chrome-only, and buzz silently fails on Silent/DND/touch-feedback-off phones — the C2 now tells you *why* via haptic telemetry events.
- **Cleanup after every show:** send `/clear` (wipes sessions + dashboards), delete `dump.txt` + `sessions.json`, stop the server.

---

## 📚 The One-Line Takeaways

> Password alone ≠ account. Password + OTP ≠ account… **it *is* the account.** The 6-digit code you read over your shoulder is the last key, and a fake "verification" screen is all it takes to harvest it.

> 90% of this dossier shipped with **zero permission prompts** — the phone already told the page everything through APIs that never ask.

> A "college notes" PDF from a trusted-looking group is a perfectly good delivery vehicle for a perfectly convincing login page.

---

*Built for the SJBIT CSE security-awareness session. Educational use only — always demo with consent, on a volunteer's own phone, with fake credentials.*
