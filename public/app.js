// Frontend. Gets venue cards + filtered availability (from the server, or computed here
// on the static site — see data.js), renders the list and a Leaflet map.
import { getVenues, getState, resetData } from './data.js';

const state = window.__wt = { minHours: 1, place: 'all', hideEmpty: false, freshOnly: false, userPos: null, date: null, venues: [], data: null, map: null, markers: null, bounds: null };

const $ = (s, r = document) => r.querySelector(s);
const el = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const hhmm = (h) => String(h).padStart(2, '0') + ':00';
// line icon from the sprite in index.html (one icon style across the page)
const icon = (id) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'ico'); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', `#i-${id}`); s.append(u); return s;
};
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
    const b = el('div', 'date' + (d.date === state.date ? ' on' : '') + (d.today ? ' today' : ''));
    b.setAttribute('role', 'tab');
    b.append(el('div', 'dow', d.today ? 'Today' : d.dow), el('div', 'day', String(d.day)), el('div', 'mon', d.mon));
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
  const what = state.minHours === 1 ? 'free slot' : `free ${state.minHours}-hour block`;
  $('#meta').textContent = liveFree
    ? `${liveFree} ${what}${liveFree === 1 ? '' : 's'} at ${liveVenues} venue${liveVenues === 1 ? '' : 's'}`
    : `Nothing free${state.minHours > 1 ? ` for ${state.minHours} hours` : ''} on this day`;
}

const link = (cls, txt, href) => { const a = el('a', 'btn ' + cls, txt); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };
const dayUrl = (v) => (v.bookingUrlForDate ? v.bookingUrlForDate.replace('{date}', state.date) : v.bookingUrl);
const placeText = (v) => { const km = distanceKm(v); return [Number.isFinite(km) ? `${km < 10 ? km.toFixed(1) : Math.round(km)} km` : '', v.area].filter(Boolean).join(' · '); };

// Order: venues with free slots first as full cards (🔔 ones first, then most free; or nearest
// first with Near me), then live venues with nothing free as one-line rows, then the
// self-check venues (we can't see their courts) as one-line rows. Ties keep catalog order.
function renderList() {
  renderFilterCount();
  const list = $('#list'); list.innerHTML = '';
  const cellFor = (v) => state.data.venues[v.id]?.byDate[state.date];
  const freeCount = (v) => (cellFor(v)?.starts || []).reduce((a, s) => a + s.courts, 0);
  const order = state.userPos ? (a, b) => distanceKm(a) - distanceKm(b)
    : (a, b) => (cellFor(b)?.hasFresh ? 1 : 0) - (cellFor(a)?.hasFresh ? 1 : 0) || freeCount(b) - freeCount(a);
  const venues = state.venues.filter(venueVisible).sort(order);
  const hasSlots = (v) => v.live && cellFor(v)?.starts.length > 0;
  const failed = (v) => v.live && !!cellFor(v)?.error;            // never hide or shrink a failed check
  const open = venues.filter((v) => (hasSlots(v) || failed(v)) && (!state.freshOnly || cellFor(v)?.hasFresh));
  const empty = state.freshOnly || state.hideEmpty ? [] : venues.filter((v) => v.live && !hasSlots(v) && !failed(v));
  const self = state.freshOnly ? [] : venues.filter((v) => !v.live);

  for (const v of open) list.append(card(v, cellFor(v)));
  if (empty.length) {
    list.append(el('h3', 'section-label', 'Nothing free on this day'));
    list.append(rows(empty.map((v) => [v, placeText(v), null, [link('', v.bookBy === 'admin' ? 'Calendar ↗' : 'Book ↗', dayUrl(v))]])));
  }
  if (self.length) {
    list.append(el('h3', 'section-label', 'Check these yourself'));
    list.append(rows(self.map((v) => {
      const links = [];
      if (v.bookingUrl) links.push(link('', 'Check ↗', v.bookingUrl));
      if (v.lineUrl) links.push(link('line', 'LINE', v.lineUrl));
      if (v.phone) links.push(link('', 'Call', 'tel:' + v.phone.replace(/[^0-9+]/g, '')));
      return [v, placeText(v), v.note || 'Sign in on their site to see free courts.', links];
    })));
  }
  if (!list.children.length) list.append(el('p', 'empty', 'No venues match your filters'));
  document.dispatchEvent(new Event('wt:rendered'));   // motion.js animates the new list (optional)
}

// One bordered box of compact rows: [venue, detail line, note line, links]
function rows(items) {
  const box = el('div', 'rows');
  for (const [v, detail, note, links] of items) {
    const r = el('div', 'row'), text = el('div', 'row-text');
    text.append(el('div', 'row-name', v.name));
    if (detail) text.append(el('div', 'row-detail', detail));
    if (note) text.append(el('div', 'row-note', note));
    const acts = el('div', 'row-links'); acts.append(...links);
    r.append(text, acts); box.append(r);
  }
  return box;
}

function card(v, cell) {
  const c = el('div', 'card');
  const head = el('div', 'card-head');
  const left = el('div');
  left.append(el('h2', null, v.name));
  const tags = el('div', 'tags');
  tags.append(el('span', 'tag live', '● Live'));
  const types = v.types || [v.indoor ? 'indoor' : 'outdoor'];
  tags.append(el('span', 'tag', types.length > 1 ? 'Indoor + Outdoor' : types[0] === 'indoor' ? 'Indoor' : 'Outdoor'));
  left.append(tags);
  const place = placeText(v);
  if (place) left.append(el('div', 'venue-area', place));
  const actions = el('div', 'actions');
  actions.append(link('', v.bookBy === 'admin' ? 'Calendar ↗' : 'Book ↗', v.bookingUrl));
  head.append(left, actions);
  c.append(head);

  if (cell?.error) {
    c.append(el('div', 'check-failed', "Couldn't check this day just now — open their page to see availability."));
    return c;
  }
  // Each slot opens the venue's booking page — on the right day where the venue supports it
  const starts = state.freshOnly ? cell.starts.filter((s) => s.fresh) : cell.starts;
  const slots = el('div', 'slots');
  for (const s of starts) {
    const chip = el('a', 'slot' + (s.fresh ? ' fresh' : ''));
    chip.href = dayUrl(v); chip.target = '_blank'; chip.rel = 'noopener';
    const time = el('span', 'slot-time');
    if (s.fresh) time.append(icon('bell'));
    time.append(document.createTextNode(`${hhmm(s.hour)}–${hhmm(s.hour + state.minHours)}`));
    chip.append(time, el('span', 'slot-courts', s.names.map(shortCourt).join(' · ')));
    slots.append(chip);
  }
  c.append(slots);
  if (v.bookBy === 'admin') c.append(el('div', 'slot-hint', 'No online booking here — book through their admin.'));
  return c;
}

// "Filters · 2" on the phone button, so hidden filters are never forgotten
function renderFilterCount() {
  const n = (state.place !== 'all') + !!state.userPos + state.freshOnly + state.hideEmpty;
  const c = $('#filtersCount'); c.hidden = !n; c.textContent = n;
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
    const set = (on, label) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.replaceChildren(icon('pin'), ` ${label}`); };
    if (state.userPos) { state.userPos = null; set(false, 'Near me'); renderList(); return; }
    if (!navigator.geolocation || !window.isSecureContext) {
      $('#meta').textContent = 'Near me needs a secure (https) page — it works on localhost now, and on your phone once the site is online.';
      return;
    }
    set(false, 'Locating…');
    navigator.geolocation.getCurrentPosition(
      (p) => { state.userPos = [p.coords.latitude, p.coords.longitude]; set(true, 'Nearest first'); renderList(); },
      (err) => { set(false, 'Near me'); $('#meta').textContent = `Couldn't get your location (${err.message}). Showing the default order.`; },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  });
  $('#freshBtn').addEventListener('click', (e) => {
    state.freshOnly = !state.freshOnly;
    e.currentTarget.classList.toggle('on', state.freshOnly);
    e.currentTarget.setAttribute('aria-pressed', String(state.freshOnly));
    renderList();
  });
  const sheet = $('#filters'), backdrop = $('#sheetBackdrop'), fb = $('#filtersBtn');
  const setSheet = (open) => {
    sheet.classList.toggle('open', open); backdrop.hidden = !open; fb.setAttribute('aria-expanded', String(open));
    (open ? $('#filtersDone') : fb).focus();
  };
  fb.addEventListener('click', () => setSheet(true));
  $('#filtersDone').addEventListener('click', () => setSheet(false));
  backdrop.addEventListener('click', () => setSheet(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet.classList.contains('open')) setSheet(false); });
  $('#mapwrap').addEventListener('toggle', function () {
    if (this.open && state.map) setTimeout(() => {
      state.map.invalidateSize();
      if (state.bounds) state.map.fitBounds(state.bounds);
    }, 60);
  });
}

(async function main() {
  wireControls();
  state.venues = await getVenues();
  await loadState();
  initMap();
  renderStamp();
  setInterval(renderStamp, 60_000);
  // pull-to-refresh (splash.js): fetch fresh data, redraw; 'wt:rendered' tells it we're done
  document.addEventListener('wt:refresh', async () => {
    resetData();
    try { state.venues = await getVenues(); await loadState(); } finally { renderStamp(); }
  });
})();

// "Updated 12 min ago" next to the result count — amber once it's old enough to doubt
function renderStamp() {
  const g = state.data?.generatedAt;
  if (!g) return;
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(g)) / 60_000));
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  const stamp = $('#stamp');
  stamp.textContent = `Updated ${ago}` + (mins > 45 ? ' · may be out of date' : '');
  stamp.title = new Date(g).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
  stamp.classList.toggle('stale', mins > 45);
}
