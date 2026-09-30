// Frontend. Gets venue cards + filtered availability (from the server, or computed here
// on the static site — see data.js), renders the list and a Leaflet map.
import { STATIC, getVenues, getState } from './data.js';

const state = window.__wt = { minHours: 1, place: 'all', hideEmpty: false, freshOnly: false, userPos: null, date: null, venues: [], data: null, map: null, markers: null, bounds: null };

const $ = (s, r = document) => r.querySelector(s);
const el = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const hhmm = (h) => String(h).padStart(2, '0') + ':00';
// Straight-line distance from the user (Near me). Infinity when off or no pin.
function distanceKm(v) {
  if (!state.userPos || v.lat == null) return Infinity;
  const r = (d) => (d * Math.PI) / 180, [lat, lng] = state.userPos;
  const a = Math.sin(r(v.lat - lat) / 2) ** 2 + Math.cos(r(lat)) * Math.cos(r(v.lat)) * Math.sin(r(v.lng - lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
// "Indoor Tennis Court 1" -> "Indoor 1", "Outdoor Tennis Court 11" -> "Outdoor 11", "Court 3" stays.
const shortCourt = (n) => { const t = n.replace(/\s*tennis\s*/i, ' ').replace(/\bcourt\s+/i, '').replace(/\s+/g, ' ').trim(); return /^\d+$/.test(t) ? `Court ${t}` : t; };

async function loadState() {
  state.data = await getState({ minHours: state.minHours, place: state.place });
  if (!state.date || !state.data.dates.some((d) => d.date === state.date)) {
    state.date = state.data.dates[0]?.date;
  }
  renderDates();
  renderList();
  renderMeta();
}

function renderDates() {
  const box = $('#dates'); box.innerHTML = '';
  for (const d of state.data.dates) {
    const b = el('div', 'date' + (d.date === state.date ? ' on' : ''));
    b.setAttribute('role', 'tab');
    b.append(el('div', 'dow', d.dow), el('div', 'day', String(d.day)), el('div', 'mon', d.mon));
    if (d.today) b.append(el('span', 'badge', 'Today'));
    b.onclick = () => { state.date = d.date; renderDates(); renderList(); renderMeta(); };
    box.append(b);
  }
}

// A venue shows under Indoor/Outdoor if it has at least one court of that type;
// the server then counts only those courts.
function venueVisible(v) {
  return state.place === 'all' || (v.types || []).includes(state.place);
}

function renderMeta() {
  const day = state.data.venues;
  let liveFree = 0, liveVenues = 0;
  for (const v of state.venues) {
    if (!venueVisible(v)) continue;
    const cell = day[v.id]?.byDate[state.date];
    if (v.live && cell) { liveFree += cell.starts.reduce((a, s) => a + s.courts, 0); if (cell.starts.length) liveVenues++; }
  }
  const label = state.minHours === 1 ? 'Open slots' : `${state.minHours}-hour blocks`;
  $('#meta').textContent = `${label} · ${liveFree} court-slots across ${liveVenues} live venue${liveVenues === 1 ? '' : 's'}`;
}

function renderList() {
  const list = $('#list'); list.innerHTML = '';

  // Order: Near me -> nearest first. Otherwise: live venues with free slots (🔔 ones
  // first, then most free court-slots), then live venues with nothing free / couldn't
  // check, then self-check venues. Ties keep catalog order (sort is stable).
  const cellFor = (v) => state.data.venues[v.id]?.byDate[state.date];
  const group = (v) => (v.live && cellFor(v)?.starts.length ? 0 : v.live ? 1 : 2);
  const freeCount = (v) => (cellFor(v)?.starts || []).reduce((a, s) => a + s.courts, 0);
  const byDefault = (a, b) => group(a) - group(b)
    || (cellFor(b)?.hasFresh ? 1 : 0) - (cellFor(a)?.hasFresh ? 1 : 0)
    || freeCount(b) - freeCount(a);
  const shown = state.venues.filter(venueVisible)
    .sort(state.userPos ? (a, b) => distanceKm(a) - distanceKm(b) : byDefault);

  for (const v of shown) {
    const cell = cellFor(v);
    const hasSlots = v.live && cell && cell.starts.length > 0;
    if (state.hideEmpty && v.live && !hasSlots && !cell?.error) continue; // never hide a failed check
    if (state.freshOnly && !(v.live && cell?.hasFresh)) continue; // fresh-only hides the rest

    const card = el('div', 'card' + (v.live ? '' : ' self'));
    const head = el('div', 'card-head');
    const left = el('div');
    left.append(el('h2', null, v.name));
    const tags = el('div', 'tags');
    tags.append(el('span', 'tag ' + (v.live ? 'live' : 'self'), v.live ? '● Live' : 'Self-check'));
    const types = v.types || [v.indoor ? 'indoor' : 'outdoor'];
    tags.append(el('span', 'tag', types.length > 1 ? 'Indoor + Outdoor' : types[0] === 'indoor' ? 'Indoor' : 'Outdoor'));
    left.append(tags);
    const km = distanceKm(v);
    const place = [Number.isFinite(km) ? `${km < 10 ? km.toFixed(1) : Math.round(km)} km` : '', v.area].filter(Boolean).join(' · ');
    if (place) left.append(el('div', 'venue-area', place));
    head.append(left);

    // action button(s)
    const actions = el('div', 'actions');
    const link = (cls, txt, href) => { const a = el('a', 'btn ' + cls, txt); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };
    if (v.live) {
      actions.append(link('', v.bookBy === 'admin' ? 'Calendar ↗' : 'Book ↗', v.bookingUrl));
    } else {
      if (v.bookingUrl) actions.append(link('', 'Check ↗', v.bookingUrl));
      if (v.lineUrl) actions.append(link('line', 'LINE', v.lineUrl));
    }
    head.append(actions);
    card.append(head);

    if (v.live && cell?.error) {
      card.append(el('div', 'check-failed', "Couldn't check this day just now — open their page to see availability."));
    } else if (v.live) {
      const starts = state.freshOnly ? cell.starts.filter((s) => s.fresh) : (cell?.starts || []);
      if (starts.length) {
        // Each slot opens the venue's booking page — on the right day where the venue
        // supports a date in the link (GOAT57); otherwise their page, and we say so.
        const url = v.bookingUrlForDate ? v.bookingUrlForDate.replace('{date}', state.date) : v.bookingUrl;
        const slots = el('div', 'slots');
        for (const s of starts) {
          const end = s.hour + state.minHours;
          const chip = el('a', 'slot' + (s.fresh ? ' fresh' : ''));
          chip.href = url; chip.target = '_blank'; chip.rel = 'noopener';
          const time = el('span', 'slot-time');
          if (s.fresh) time.append(el('span', 'bell', '🔔'));
          time.append(document.createTextNode(`${hhmm(s.hour)}–${hhmm(end)}`));
          chip.append(time, el('span', 'slot-courts', s.names.map(shortCourt).join(' · ')));
          slots.append(chip);
        }
        card.append(slots);
        if (v.bookBy === 'admin') {
          card.append(el('div', 'slot-hint', 'No online booking here — book through their admin.'));
        }
      } else {
        card.append(el('div', 'empty', 'No slots match your filters on this day'));
      }
    } else {
      card.append(el('div', 'self-note', v.note || 'Login required to see availability — check on their site'));
      if (v.phone) {
        const p = el('div', 'phone');
        const a = el('a', null, '📞 ' + v.phone); a.href = 'tel:' + v.phone.replace(/[^0-9+]/g, '');
        p.append(a); card.append(p);
      }
    }
    list.append(card);
  }
  if (!list.children.length) list.append(el('p', 'empty', 'No venues match your filters'));
}

function initMap() {
  const withCoords = state.venues.filter((v) => v.lat != null && v.lng != null);
  if (!withCoords.length || !window.L) return;
  state.map = L.map('map', { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenStreetMap',
  }).addTo(state.map);
  const group = L.featureGroup();
  for (const v of withCoords) {
    const m = L.marker([v.lat, v.lng]).bindPopup(
      `<b>${v.name}</b><br>${v.area || ''}<br>` +
      `<a href="${v.bookingUrl}" target="_blank" rel="noopener">${v.live ? 'Book' : 'Check'} ↗</a>`);
    m.addTo(group);
  }
  group.addTo(state.map);
  state.bounds = group.getBounds().pad(0.3);
  state.map.fitBounds(state.bounds);
}

function wireControls() {
  $('#duration').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-h]'); if (!b) return;
    state.minHours = +b.dataset.h;
    [...$('#duration').querySelectorAll('button')].forEach((x) => x.classList.toggle('on', x === b));
    loadState();
  });
  $('#place').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-p]'); if (!b) return;
    state.place = b.dataset.p;
    [...$('#place').querySelectorAll('button')].forEach((x) => x.classList.toggle('on', x === b));
    loadState();
  });
  $('#hideEmpty').addEventListener('change', (e) => { state.hideEmpty = e.target.checked; renderList(); });
  $('#nearBtn').addEventListener('click', (e) => {
    const b = e.currentTarget;
    const set = (on, label) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.textContent = label; };
    if (state.userPos) { state.userPos = null; set(false, '📍 Near me'); renderList(); return; }
    if (!navigator.geolocation || !window.isSecureContext) {
      $('#meta').textContent = 'Near me needs a secure (https) page — it works on localhost now, and on your phone once the site is online.';
      return;
    }
    set(false, '📍 Locating…');
    navigator.geolocation.getCurrentPosition(
      (p) => { state.userPos = [p.coords.latitude, p.coords.longitude]; set(true, '📍 Nearest first'); renderList(); },
      (err) => { set(false, '📍 Near me'); $('#meta').textContent = `Couldn't get your location (${err.message}). Showing the default order.`; },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  });
  $('#freshBtn').addEventListener('click', (e) => {
    state.freshOnly = !state.freshOnly;
    e.currentTarget.classList.toggle('on', state.freshOnly);
    e.currentTarget.setAttribute('aria-pressed', String(state.freshOnly));
    renderList();
  });
  $('#mapwrap').addEventListener('toggle', function () {
    if (this.open && state.map) setTimeout(() => {
      state.map.invalidateSize();
      if (state.bounds) state.map.fitBounds(state.bounds);
    }, 60);
  });
}

(async function main() {
  wireControls();
  // "Just freed" needs checks a few minutes apart; the static site's are ~15+ min apart
  if (STATIC) $('#freshBtn').style.display = 'none';
  state.venues = await getVenues();
  await loadState();
  initMap();
  renderStamp();
  if (STATIC) setInterval(renderStamp, 60_000);
})();

// "Updated 21:40". On the static site the data is refreshed every ~10–15 min by a
// scheduled job, so say how old it is — and say it loudly when it's gone stale.
function renderStamp() {
  const g = state.data?.generatedAt;
  if (!g) return;
  const at = new Date(g).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(g)) / 60_000));
  const stamp = $('#stamp');
  if (!STATIC) { stamp.textContent = `Updated ${at}`; return; }
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  stamp.textContent = `Courts checked ${ago} (${at}) · refreshed about every 15 min — confirm on the venue's page before you go`;
  stamp.classList.toggle('stale', mins > 45);
}
