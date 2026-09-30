// The page background: a real tennis court seen from above, drawn to ITF proportions
// (in metres, so the lines scale with the screen), scrolling slower than the content.
//   phone   -> court width = screen width (doubles sidelines just inside the edges)
//   desktop -> court wider than the 720px column, sidelines run down the margins
// Scroll speed is chosen so the whole court maps onto the whole page: top baseline at
// the top, bottom baseline as you reach the end. Reduced-motion users get a still court.
const DOUBLES_W = 10.97, LENGTH = 23.77, ALLEY = 1.37, SERVICE = 6.40, LINE = 0.06;
const SIDE_RUN = 0.25;        // metres of surface outside the doubles sidelines
const END_PAD_PX = 28;        // surface below the far baseline
const layer = document.getElementById('court');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let geo = null; // { svgH }

function draw() {
  const vw = window.innerWidth;
  const courtW = vw < 640 ? vw - 12 : Math.min(vw - 64, 900);          // px, doubles-to-doubles
  const pxPerM = courtW / DOUBLES_W;
  const masthead = document.querySelector('.masthead');
  const topPadM = ((masthead ? masthead.offsetHeight : 0) + 18) / pxPerM; // first baseline clears the header
  const vbW = DOUBLES_W + 2 * SIDE_RUN;
  const vbH = topPadM + LENGTH + END_PAD_PX / pxPerM;
  const w = vbW * pxPerM, h = vbH * pxPerM;

  const x0 = SIDE_RUN, x1 = SIDE_RUN + DOUBLES_W, y0 = topPadM, y1 = topPadM + LENGTH;
  const sx0 = x0 + ALLEY, sx1 = x1 - ALLEY, net = y0 + LENGTH / 2, cx = (x0 + x1) / 2;
  const l = (a, b, c, d, cls = '') => `<line ${cls} x1="${a}" y1="${b}" x2="${c}" y2="${d}"/>`;

  layer.innerHTML = `
<svg width="${w}" height="${h}" viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="none" aria-hidden="true">
  <rect class="surface" x="${x0}" y="${y0}" width="${DOUBLES_W}" height="${LENGTH}"/>
  <g class="lines" stroke-width="${LINE}" stroke-linecap="square">
    ${l(x0, y0, x1, y0)}${l(x0, y1, x1, y1)}                                  <!-- baselines -->
    ${l(x0, y0, x0, y1)}${l(x1, y0, x1, y1)}                                  <!-- doubles sidelines -->
    ${l(sx0, y0, sx0, y1)}${l(sx1, y0, sx1, y1)}                              <!-- singles sidelines -->
    ${l(sx0, net - SERVICE, sx1, net - SERVICE)}${l(sx0, net + SERVICE, sx1, net + SERVICE)} <!-- service lines -->
    ${l(cx, net - SERVICE, cx, net + SERVICE)}                                <!-- centre service line -->
    ${l(cx, y0, cx, y0 + 0.1)}${l(cx, y1, cx, y1 - 0.1)}                      <!-- centre marks -->
  </g>
  ${l(x0 - 0.3, net, x1 + 0.3, net, `class="net" stroke-width="${LINE * 2}"`)}
</svg>`;
  geo = { svgH: h };
  place();
}

let ticking = false;
function place() {
  ticking = false;
  if (!geo) return;
  const vh = window.innerHeight;
  const travel = Math.max(0, geo.svgH - vh);                  // how far the court can move
  if (reduceMotion.matches || travel === 0) { layer.style.transform = 'translate3d(-50%,0,0)'; return; }
  const scrollRange = Math.max(1, document.documentElement.scrollHeight - vh);
  const speed = Math.min(0.55, Math.max(0.15, travel / scrollRange)); // always slower than content
  const y = -Math.min(window.scrollY * speed, travel);
  layer.style.transform = `translate3d(-50%, ${y}px, 0)`;
}

window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(place); } }, { passive: true });
window.addEventListener('resize', () => requestAnimationFrame(draw));
reduceMotion.addEventListener?.('change', place);
// the list height changes when filters change -> keep the court-to-page mapping right
new ResizeObserver(() => requestAnimationFrame(place)).observe(document.body);
document.fonts?.ready.then(draw);  // masthead height depends on the web font
draw();
