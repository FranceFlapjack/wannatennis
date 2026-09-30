// Bangkok time helpers. Thailand is UTC+7 year-round (no DST), so we can shift
// by a fixed offset and never touch a timezone database.
const BKK_OFFSET_MS = 7 * 3_600_000;

/** The next `n` Bangkok dates starting today: ['2026-09-25', ...]. */
export function bkkDateRange(n, now = Date.now()) {
  const base = now + BKK_OFFSET_MS; // shifted so UTC fields read as Bangkok wall-clock
  const out = [];
  for (let i = 0; i < n; i++) out.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** Short weekday + day + month for a date tab, e.g. { dow:'Thu', day:25, mon:'Sep' }. */
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
             'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Compute weekday from the date (treat as UTC midnight, weekday is offset-safe).
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { dow: DOW[dow], day: d, mon: MON[m - 1] };
}
