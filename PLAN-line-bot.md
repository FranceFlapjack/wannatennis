# Plan — LINE bot, alerts, and self-monitoring

## Goal
Tell me on LINE when a court I want frees up, and tell me when the checking itself
breaks — so a silent failure can never look like "no free courts".

## What you do (blocks go-live only; everything else can be built first)
1. Create a free **LINE Official Account** (LINE Official Account Manager).
2. Settings → **enable Messaging API** → a channel appears in LINE Developers Console.
3. Copy the **Channel secret**; issue a **Channel access token**.
4. OA Manager → **turn off auto-reply** (otherwise every message gets two answers).
4b. OA Manager → allow the bot to **join group chats** (needed for group alerts).
5. Put the secret/token in `tennis-finder/.env` yourself (I'll create `.env.example`).
   Never paste them in chat.
6. Check LINE's current free monthly push quota for Thailand.

## Build steps

### 1. Storage — `lib/db.js` (Node's built-in `node:sqlite`, still zero npm installs)
- `users` (LINE user id, language, isAdmin)
- `watches` (user, venue/area filter, day or date, time window, min hours 1/2/3, place)
- `alerts_sent` (user, venue, court, date, hour) — the dedupe: one alert per slot per person
- `venue_health` (venue, consecutive failures, last ok, last error, alert state)

### 2. Commands — `lib/commands.js` (rules only, no AI; English + Thai)
- `alert Sat 18-21 2h goat` / `แจ้งเตือน เสาร์ 18-21 2ชม โกท`
- `my alerts` / `ดูแจ้งเตือน`,  `cancel 2` / `ยกเลิกแจ้งเตือน 2`,  `help` / `วิธีใช้`
- Venue + area aliases come from `catalog.js` (`aliases`, `areaTh`).
- Replies in English (matches the site); unparseable input → short help, never a guess.

### 3. Matcher — `lib/alerts.js`
- After each poll, take the just-freed events (already produced by change detection)
  and match them against watches: venue, date/weekday, window, **same-court N-hour
  run** (reuse `qualifyingStarts`), place.
- Skip anything in `alerts_sent`; skip hours already started.
- Group per user per poll → one message, not one per slot.

### 4. Webhook + push — `lib/line.js`, route in `server.js`
- `POST /line/webhook`: verify the `X-Line-Signature` HMAC with the channel secret;
  reject anything unsigned. Replies use the reply token (free); alerts use push (quota).

### 5. NEW — Venue health alert (auto-check #1)
- The poller already records failed days per venue (`errorDates`). Track a counter:
  **3 failed polls in a row (~15 min) → push the admin:**
  "⚠️ Beat checking is failing: <error>. The site shows 'Couldn't check'."
- Alert **once** per outage, then **"✅ Beat checking recovered"** when it succeeds again.
- Also catches the quiet failure: a venue that suddenly returns **zero courts** or a
  **different court list** than yesterday (e.g. renamed courts) → warn, even if no error.

### 6. NEW — Daily self-check against the venues' own pages (auto-check #2)
Two layers, because a true page-vs-app comparison needs a real browser:
- **Daily structural check (zero dependencies):** once a day, verify each live
  venue still looks the way the adapter expects — Beat's page still has the court
  table with the 8 normal courts, start times on the hour; Hatch still returns its 3
  courts with 60-min slots; GOAT57 still has 4 courts, 60-min slots, no buffer.
  Any change → admin LINE message naming exactly what changed.
- **Weekly page comparison (optional, adds Playwright):** open each venue's public
  booking page headlessly, read the free courts for a few days, compare with the app
  hour-by-hour (the same method that caught the Beat kids-court bug). Mismatch →
  admin LINE message with the differing hours. Needs `npm install playwright`
  (~150 MB incl. a browser) — decide before we build it.

### 7. Public HTTPS — Cloudflare Tunnel
- `brew install cloudflared` (will ask first). Quick tunnel for testing; a named
  tunnel (free Cloudflare account) for a stable webhook URL.
- Note: alerts and self-checks only run while this Mac is awake → the always-on
  host step (Umbrel / small VPS) comes right after this works.

## Verification
- `npm test` extended: command parsing (EN/TH), watch matching incl. 2h same-court,
  dedupe, grouping, signature verification (good/bad/missing), health counter
  (fail ×3 → one alert, recover → one message, no repeats), structural-check diffs.
- Local fake-LINE harness: post signed webhook events to the server, capture the
  outgoing push calls instead of sending them — full flow testable without an account.
- Live: with your channel, set a watch, seed a booked→free transition (as we did for
  the 🔔 badge), confirm exactly one LINE alert arrives; break a venue URL on purpose,
  confirm the health alert and the recovery message.

## Open decisions
- Weekly Playwright comparison: yes/no (adds a dependency).
- Who is admin for health alerts (default: the first user to message the bot).
