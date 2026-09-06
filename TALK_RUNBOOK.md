# 🎤 TALK RUNBOOK — "Your Phone Is the Phish" (SJBIT CSE Demo)

One Express server runs the whole act: a **fake notes-download phish** (`public/index.html`), a
**consent-only audience counter** (`public/crowd.html`), a **PDF lure** (`public/d/notes.pdf`),
and a **Telegram C2 console** for the operator. Everything the "victim" does is narrated live
into a private Telegram chat and mirrored on the ops dashboard at `/admin`.

> Threat chain demonstrated: PDF lure → visit → silent fingerprint dossier → live keystroke
> streaming → credential grab → **OTP / 2FA one-time-code capture** → **account takeover
> (/nudge takeover overlay)** → optional GPS / selfie / camera-torch abuse.

---

## 0. HONESTY & CONSENT — read before every show

This is an educational simulation, not a real attack on anyone.

- **The demo victim is a volunteer from the audience** (or the presenter's own phone). One person's
  phone is the "victim"; everyone else is invited to the **consent-only crowd page**.
- **The OTP/SMS stage is simulated.** The fake page *asks* for the 6-digit code and the code is
  printed on the victim's own screen ("Simulated SMS"). A real attack would deliver the real SMS
  to the victim's phone — make that explicit on stage.
- **The crowd page sends nothing to Telegram, stores nothing on disk, and never logs IPs.** It only
  counts anonymous device IDs in server memory. Announce this before asking people to tap consent.
- **Use demo/fake credentials.** Nobody should type a real college/personal password. Say so.
- **Camera/geolocation permissions** are only requested if the volunteer taps those "verification"
  buttons or the operator queues `/gps`, `/selfie`, `/torch` — never silently after the first grant.
  The narration tells the truth about this ("permission prompt appeared").
- After the talk: `/clear` wipes sessions, delete `dump.txt` + `sessions.json`, stop the server,
  kill the tunnel.

---

## 1. What runs where

| File | Role |
|---|---|
| `server.js` | Express C2: endpoints, Telegram relay + console, admin dashboard, dump.txt |
| `public/index.html` | The phish — notes portal lookalike (creds → OTP → campus/selfie pretexts) |
| `public/crowd.html` | Consent-only live audience counter (clean control sample) |
| `public/notes.pdf` | The "notes PDF" lure — link inside opens the phish via `/?ref=pdf` |
| `dump.txt` | Live breach chain feed `email:password:otp:ip` (auto-created on first capture) |
| `sessions.json` | Session persistence (auto-created; wipe after the talk) |
| `config.json` | `bot_token`, `chat_id`, `admin_key`, `port` (env vars override all) |

## 2. Setup tonight (5 min)

1. **Bot** — in Telegram, message @BotFather → `/newbot` → save the token.
2. **Chat ID** — message your bot once (`/start`), then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the numeric `chat.id`
   (or send `/start` from a second account and read the update).
3. **Config** — edit `config.json`:
   ```json
   {
     "bot_token": "123456789:AAE...",
     "chat_id": "987654321",
     "admin_key": "pick-a-long-random-string",
     "port": 3000
   }
   ```
4. **Start** — `node server.js` → you should see the port banner and `[+] C2 console` line.
5. **Tunnel** — the audience phones must reach you: `cloudflared tunnel --url http://localhost:3000`
   (or ngrok). Copy the **https URL**.
6. **Health check** — send `/help` to the bot (reply appears), open
   `<TUNNEL>/admin?key=YOUR_KEY` (dashboard), and open `<TUNNEL>/` once (device dossier
   should land in the bot chat within seconds).
7. **QR + short link** — project the tunnel URL as a QR code (any QR site) so the crowd can
   reach `/crowd.html` and the volunteer can reach the phish.

> **Dry-run / rehearsal without spamming the real bot:** every env var overrides config.json.
> ```bash
> PORT=3100 BOT_TOKEN=111111:FAKE_CHAT_ID=999 ADMIN_KEY=smoke node server.js
> ```
> Everything works except Telegram delivery. `/collect?quiet=1` also suppresses the device
> dossier alert (stores locally only) if you want a silent rehearsal client.

---

## 3. URL map

| URL | What it is | Who |
|---|---|---|
| `/` | The phish (notes portal) | demo volunteer |
| `/crowd.html` or `/?crowd=1` | Consent-only counter | whole audience |
| `/d/notes.pdf` | "Downloaded notes" lure; opens the phish from inside | volunteer (via WhatsApp) |
| `/admin?key=…` | Ops dashboard, auto-refresh 3 s | operator laptop |
| Telegram bot | C2 console | operator |

---

## 4. Stage script (≈12–15 min)

Timing beats — run ahead or behind freely; each stage is independent.

### 🎬 Stage 0 — Crowd warm-up (consent page) · 2 min
1. Project `<TUNNEL>/crowd.html`; say: *"This is the honest control sample — it counts your phone
   once and sends only platform + screen size to server memory. No Telegram, no disk, no IPs."*
2. Ask people to open the link (QR) and tap **✅ I consent**.
3. Watch the counter climb. Operator: `/crowd` → e.g. *"🎟️ Live crowd opt-ins: 47"*.
4. Keep this on screen behind you — it re-enters the story at the end ("47 phones looked at a
   consent page tonight; the volunteer just gave one bad page all of this").

### 📄 Stage 1 — PDF lure (WhatsApp) · 1 min
1. Post the link `<TUNNEL>/d/notes.pdf` into the demo WhatsApp group as "S3 notes — final".
2. Volunteer taps it. Server logs the PDF hit → bot alert *"📄 PDF LURE OPENED"* + dossier.
3. Narrate: *"One attachment. That's the whole initial access — no exploit, no 0-day."*
4. The PDF's green button (**OPEN FULL SET IN BROWSER >**) lands them on the phish.

### 👀 Stage 2 — Silent profiling · 1 min
They scroll the notes list. Telegram already received: OS/browser/webview, screen, battery,
RAM/CPU, timezone, language, GPU hash, clipboard copy/paste, scroll depth, idle time, device
motion, even *which app they arrived from*. Show `/who <id>` in the bot — scroll + battery +
read-50%-of-page events are great proof moments.

### ⌨️ Stage 3 — LIVE keystroke streaming · 2 min ← show-stopper
1. Volunteer taps **"Sign in with SJBIT account to download"** and starts typing the demo
   password (e.g. `Hunt3r2!`).
2. Because the field is a password box, **every keystroke flushes instantly** — the bot's
   **⌨️ LIVE TYPING** message updates in real time, character by character, into one edited
   message (no 700 ms wait like normal fields).
3. Narrate: *"No keylogger installed. No malware. A web page — and the network never even saw
   the password: it was still inside the browser, being typed."*

### 🔐 Stage 4 — Credential grab · 30 s
Volunteer presses **Sign in**. Bot alert: *"🔐 CREDENTIALS CAPTURED"* with email+password,
geo/ISP of the network, and a ⚡ Session-takeover-ready flag. `dump.txt` line 1 is written.

### 🔑 Stage 5 — OTP / 2FA capture · 2 min ← the scary one
1. Page pretends to send an SMS; after ~2 s it displays **"Simulated SMS: your code is 483920"**.
   Say it out loud: *"In the wild, that SMS goes to the victim's real phone — the page just asks
   for it. Real 2FA phishing is not the attacker bypassing the code; it's the victim typing the
   code into the attacker's page."*
2. Volunteer types the code → bot alert **"🔑 OTP / 2FA CODE SNIFFED"** with the full
   `email:password:otp` chain → `dump.txt` line 2 appended.
3. The notes "download" completes; the campus + selfie cards appear (next pretexts).

### 🚨 Stage 6 — /nudge takeover reveal · 1 min ← grand finale
1. Operator: `/nudge <id>` (id from `/list`, e.g. `/nudge c1`). Defaults to the panic message
   *"New sign-in on your account — Bengaluru, India · Chrome on Windows · 2FA code used ✔️"*.
2. Within 3 s the victim's phone: vibrates, then a **full-screen red "New sign-in alert" overlay**
   reveals the exact email, password and OTP the page captured — *on the victim's own screen*.
3. Narrate: *"The attacker doesn't need to hack the bank. They log in as you — password plus your
   2FA code — and your phone then shows YOU the alert for THEIR login. That's account takeover
   in one line."*
4. Volunteer taps **I understand — dismiss**; an event confirms dismissal in the bot.

### 🎁 Stage 7 — Optional physical-extras blitz · 1–2 min
With the volunteer's consent, queue from the bot and narrate each:
`/gps <id>` (prompt appears; if location was ever allowed it tracks **silently** on re-visits),
`/selfie <id>` (camera prompt → frame arrives), `/torch <id> on` (LED lights up — no camera UI
shown), `/flash <id>` (screen strobes), `/speak <id> "…"` (phone speaks), `/buzz <id>`.

### 📊 Stage 8 — Wraparound + close · 1 min
1. `/stats` — devices, keystrokes, credentials, **OTP/2FA codes**, PDF lure opens, crowd opt-ins.
2. `/dump` — send `dump.txt` to the bot: *"This is what a breach-dump line looks like the day
   you reuse a password. Three fields on one line: email, password, OTP."*
3. Close the loop with Stage 0's number: consent page (honest) vs one careless tap (everything).

---

## 5. Telegram console quick reference

| Command | Action |
|---|---|
| `/help` | all commands |
| `/list` | device registry — gives you the `<id>` every other command needs |
| `/who <id>` | full dossier (fingerprint, location, battery, events…) |
| `/keys <id> [n]` | last n keystroke entries |
| `/creds` | all captured credentials |
| `/otp` | note — 2FA codes arrive automatically right after creds |
| `/events <id>` | behavior narration log |
| `/heat <id>` | touch heatmap image |
| `/gps <id>` | queue GPS fix (prompt on victim screen; silent if previously granted) |
| `/buzz <id>` | vibrate |
| `/nudge <id> [msg]` | **takeover overlay** — default msg has the 2FA-code-used line |
| `/speak <id> <text>` | text-to-speech on victim phone |
| `/flash <id>` | strobe the screen |
| `/selfie <id>` | trigger front camera capture |
| `/torch <id> [on\|off]` | LED flashlight |
| `/csv` | full breach-dump export (now includes `otp` column) |
| `/dump` | send `dump.txt` (email:password:otp chain) as a file |
| `/crowd` | audience opt-in counter |
| `/stats` | totals incl. OTP codes + crowd |
| `/clear` | wipe all demo data |

Every `<id>` is the short code shown in `/list` (e.g. `c1`). All queued actions (`/nudge`,
`/gps`, `/selfie`, `/torch`, `/buzz`…) land on the phone within the 3-second `/command` poll.

---

## 6. Fallbacks & troubleshooting

| Problem | Fix |
|---|---|
| Bot replies "⚠️ chat not found" or nothing | wrong `chat_id` or bot never received `/start` from that chat |
| No Telegram alerts but page loads | tunnel URL ≠ server reachable from your bot? No — check `config.json`/env token; run with real creds |
| Phone page loads, no dossier alert | volunteer behind captive portal / ad-block? retry; check `/admin` shows the session anyway |
| Tunnel flaky | restart `cloudflared`; **QR is per-run — regenerate if URL changed** |
| Camera/geo/torch blocked | volunteer denied prompt → permission-denied event still lands in bot; move on, it's honest |
| `/nudge` queued but no overlay | phone tab not open/foreground (commands poll every 3 s only while page is open) |
| Keystrokes arrive only in bursts | normal fields flush after 700 ms idle; password + OTP fields flush per keystroke |
| `/dump` says empty | no capture yet — needs ≥1 creds line |
| Audience NAT = one public IP | irrelevant: crowd dedupes by per-phone anonymous ID (localStorage), not IP |
| Dry-run keeps hitting real bot | pass fake `BOT_TOKEN`/`CHAT_ID` env; use `?quiet=1` collect to suppress dossier alerts |
| `/admin` shows 🔒 | wrong `key` — URL must be `/admin?key=<admin_key from config>` |

## 7. After the talk — cleanup checklist
1. `/clear` in the bot (wipes sessions + live keys).
2. Stop the server (Ctrl+C). Kill the tunnel process.
3. Delete `dump.txt` and `sessions.json` from the project folder.
4. Keep the demo build; rotate `config.json` values before next talk.

---
*Remember why this demo works: no permissions asked, no malware installed, no 0-day used —
just the permissions, autofill and attention the web hands out by default. The defence story is
the same list, inverted: unique passwords, real 2FA in an authenticator app (never typed into a
page), and suspicion of anything that asks you to "verify".*
