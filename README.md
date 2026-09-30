# Wanna Tennis ? — Find Courts Near You

Free tennis courts in Bangkok: live availability where a venue publishes it, a self-check
link where it doesn't, and a LINE bot that tells you when a court frees up.
Zero runtime dependencies — Node 22.5+ only (built-in `node:sqlite`).

## Two ways it runs
| | Website | LINE bot + alerts | Data freshness |
|---|---|---|---|
| **Static site** (GitHub Pages, `.github/workflows/pages.yml`) | ✅ | ❌ (buttons still open LINE with the command typed) | every ~15 min, often later |
| **Server** (`node server.js` — your Mac + tunnel today, Fly.io later) | ✅ | ✅ | every 5 min |

The static site is the same page in "static mode": a scheduled GitHub job runs
`lib/poll.js`, then `scripts/build-static.js` puts the page, the pure `lib/` modules and
`data/snapshot.json` into `dist/`, and the browser does the filtering (`public/data.js`).
Build it yourself: `node lib/poll.js && node scripts/build-static.js`.

## Run
```bash
node server.js
# open http://localhost:3000
```

## Test
```bash
npm test
```
29 offline tests (Node's built-in runner, no dependencies): the slot engine, every
display rule in `lib/state.js` (past hours, midnight rollover, failed checks,
indoor/outdoor, 🔔 window), change detection, and each adapter against canned
responses shaped like the real APIs — including a regression test for every bug found
so far. Run it before and after any change.
The server polls every venue on startup and then every 5 minutes.
Force a one-off refresh: `node lib/poll.js`

## What works today
- **Live** (auto-checked): Hatch Tennis Club, BEAT Discovery, G.O.A.T. 57
- **Self-check** (login/phone-walled, gray cards + booking link / LINE / phone):
  Ace of Clubs, ALM x Impact, Crystal Sports, Crystal Sports G, CV Sport Club,
  Simoorgh Tennis Academy
- Date tabs (next 7 days, Bangkok time), Thai labels
- **Duration filter — 1 / 2 / 3 hr** consecutive on the *same court* (a filter, not a rule)
- **🔔 เพิ่งว่าง (just-freed) detection** — the poller diffs each run against the previous
  one; a court that flipped booked→free is badged for 30 min, and a "เพิ่งว่าง" toggle
  filters to only those. This is the primitive the future LINE alert will push from.
- Indoor / outdoor filter, hide-empty toggle
- Past hours are dropped for today (an hour that already started isn't bookable)
- **Normal courts only.** Venues whose "Tennis" includes kids' courts (Beat: Orange/Red
  Clay (Kid), U4 Tennis Room) are filtered by court name. okrabook rows accept
  `includeCourts` / `excludeCourts` regex strings; default include is `tennis court`,
  default exclude catches `(Kid)`, `U4`, junior, mini.
- **Indoor/Outdoor is per court**, not per venue: a court named "Outdoor…" counts as
  outdoor even at a mostly-indoor venue (Beat has 6 indoor + 2 outdoor). Manual venues
  can declare `types: ['indoor','outdoor']` in the catalog.
- OpenStreetMap map (pins are APPROXIMATE — see catalog.js)

## LINE bot
Commands (English or Thai): `alert Sat 18-21 2h goat` · `แจ้งเตือน เสาร์ 18-21 2ชม` ·
`my alerts` · `cancel 2` · `cancel all` · `link` · `help`. Admin only: `status`, `selfcheck`.
- **Groups:** alerts set in a group belong to the group and are pushed to the whole group.
  In groups the bot only answers real commands or an @mention — normal chat is ignored.
- **Website → LINE (no linking):** "🔔 LINE alerts" builds the alert, then **Alert me in LINE**
  opens the bot chat with the command typed in (needs `LINE_BOT_BASIC_ID`), and **Alert my
  group** opens LINE's share picker. You tap Send; LINE proves who sent it.
  `watchToCommand` + `roundTrips` guarantee the text reads back as the same alert.
- **See/cancel on the website (optional):** send `link` → the bot replies with a one-tap link
  (needs `PUBLIC_URL`; opens in the normal browser) or a 6-digit code. One use, 10 minutes,
  wrong codes rate-limited. Same rules as chat (`checkWatch`).
- After every poll, just-opened slots are matched against alerts (a 2h run counts as new if
  ANY of its hours opened this poll) → one LINE message per person, each slot at most once.
- Health: 3 failed polls in a row → one warning to the admin, then one "working again".
  A changed court list (e.g. kids courts slipping in) is reported even without an error.
- Daily self-check (from 09:00): every live venue must return exactly its `expectCourts`.
- Storage: `data/app.db` (Node's built-in SQLite). Secrets: `.env` (see `.env.example`).
- **Try it without LINE:** `.env` with only a made-up `LINE_CHANNEL_SECRET` → dry-run;
  every message goes to `data/outbox.log`. Chat with it: `npm run line -- "alert sat 18-21 2h"`.

## Change detection (how "just freed" works)
`lib/poll.js` reads the previous `data/snapshot.json` before overwriting it and stamps
each currently-free (venue, date, court, hour) via `computeFreed()`:
- was free last poll  → keep the original `freedAt` (no reset)
- was booked last poll → real transition → `freedAt = now`
- brand-new date/court → unstamped (no baseline ⇒ never a false badge; first poll is quiet)
`server.js` treats a stamp as fresh for `FRESH_WINDOW_MS` (30 min) and exposes `fresh` per
slot + `hasFresh` per venue/day. No database — the stamps live in the snapshot and survive
restarts. SQLite arrives only with the LINE per-user watch store.

## Add a venue = edit one file
`catalog.js` is the only file you touch.
- On a platform we already support -> one entry, no code:
  - Hatch-style bespoke API: `source: { type: 'hatch', base }`
  - okrabook platform: `source: { type: 'okrabook', base, detailPath, venueId, sportId }`
  - Reservation System: `source: { type: 'reservationSystem', base, itemType: 'court' }`
- No public feed -> `source: { type: 'manual' }` + a `bookingUrl` (or `lineUrl`)

## Architecture
```
catalog.js         venues + how to read each (the only file you edit to add courts)
adapters/
  hatch.js               bespoke public API (returns BOOKED -> we invert to free; UTC)
  okrabook.js            multi-tenant platform (returns FREE court ids per slot)
  reservation-system.js  SvelteKit platform, __data.json in devalue format (local time,
                         ships its own business hours + holidays). GOAT57 runs on it.
lib/
  time.js          Bangkok (UTC+7) date helpers + Thai labels
  slots.js         the engine: free hours -> qualifying starts for N-hour runs
  poll.js          walk catalog -> data/snapshot.json
lib/state.js       pure view model: snapshot -> what the page shows ("now" injectable)
server.js          node:http — static site + /api/venues, /api/state?minHours=&place=
public/            minimal frontend (index.html, styles.css, app.js) + Leaflet
data/snapshot.json latest poll (regenerated; safe to delete)
```

## Booking platforms seen in Bangkok (for adding venues)
- **Hatch** — bespoke Next.js API, availability is PUBLIC → live adapter.
- **"Reservation System"** (SvelteKit) — availability PUBLIC at
  `/availability/<type>/__data.json?date=` → live adapter. Likely white-label; if another
  venue runs it, it's a catalog row only. (GOAT57.)
- **okrabook** (`<slug>.okrabook.com`) — multi-tenant, availability PUBLIC via
  `POST /venues/getTimes` → live adapter. Real tenants redirect to
  `<slug>.okrabook.com/login`; non-tenants bounce to `okrabook.com`. (Beat is one.)
- **KE Group** (`*-booking.kegroup.co.th`) — phone/OTP login → self-check. (Crystal.)
- **OnCourt** (`getoncourt.app`) — nice public venue pages, but booking needs
  Google/LINE/email login → self-check. Lists many BKK courts. (Simoorgh.)
- Phone / LINE only (no system) → self-check. (CV Sport, Beat's LINE, etc.)

## Always-on server (Oracle Cloud Always Free)
One Ubuntu VM (free shape E2.1.Micro or A1), Caddy for HTTPS, systemd keeps it running.
1. Create the VM (Singapore, Always Free shape, public IPv4, your SSH key); in its subnet's
   security list allow TCP 80 + 443 from 0.0.0.0/0.
2. Hostname without buying a domain: `<ip-with-dashes>.sslip.io` (e.g. `129-150-1-2.sslip.io`).
3. On the VM: `curl -fsSLO https://raw.githubusercontent.com/FranceFlapjack/wannatennis/main/deploy/oracle-setup.sh && bash oracle-setup.sh <hostname>`
4. Stop the Mac copy, then copy `.env` and `data/app.db` to `/opt/wannatennis/` (owner
   `wannatennis`, `.env` mode 600) and `sudo systemctl restart wannatennis`.
5. LINE webhook → `https://<hostname>/line/webhook`, Verify. Logs: `journalctl -u wannatennis -f`.
Update later: rerun step 3 (it pulls the latest code and restarts).
**Only one copy may run** — two bots would push every alert twice.

## Roadmap
1. **Now:** website on GitHub Pages for friends; bot runs on the Mac while it's awake.
2. **Always-on bot:** deploy `server.js` to Fly.io (`Dockerfile` + `fly.toml` are ready;
   secrets via `fly secrets import < .env`, data on a volume at `/app/data`), point the LINE
   webhook at `https://<app>.fly.dev/line/webhook`, stop the Mac copy. ~US$3–5/month.
3. **wannatennis.app** for both, then the website can move back to the server (fresh data,
   manage alerts on the web) or stay on Pages.
4. More venues; Ruji admin contact on its card.

Heads-up: GitHub pauses scheduled jobs in a public repo after 60 days without commits —
re-enable in the Actions tab (or push anything).

## Notes / TODO
- **Coordinates are approximate.** Fix lat/lng in catalog.js; **Hatch has none** (its site
  has no public address — ask the venue).
- Adapters poll politely (5–10 min, identify UA). Beat/okrabook needs a CSRF handshake.
- LINE bot is live (LINE channel in `.env`, webhook through a Cloudflare quick tunnel whose
  address changes on restart — fixed by the Fly.io step). Not built: AI free-text box.
- To add live coverage: find more okrabook tennis tenants (same adapter, new catalog rows).
  There is no public cross-tenant directory, so discover them per venue.
