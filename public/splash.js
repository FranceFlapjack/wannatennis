// Welcome screen + pull-to-refresh. Works even if the animation player doesn't load (the
// name and "Finding free courts…" still show).
//   • the tennis animation (Lottie) plays while app.js loads the data; it fades once the courts
//     are drawn ('wt:rendered'), after at least MIN ms — and never stays up longer than MAX
//   • phones: pull down at the top → a ball drops in; let go past the line → the animation plays
//     again while fresh data loads ('wt:refresh' → app.js → 'wt:rendered')
const splash = document.getElementById('splash');
const pullBall = document.getElementById('pullBall');
const anim = document.getElementById('splashAnim');
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (still) anim.removeAttribute('autoplay');               // runs before the player script upgrades it
const MIN = still ? 500 : 2000, MAX = 8000, PULL = 90;   // ms, ms, px

let busy = true;
// pause the animation while the screen is hidden (no work in the background)
const show = () => { splash.classList.remove('out'); busy = true; if (!still) anim.dotLottie?.play(); };
const hide = () => { splash.classList.add('out'); busy = false; setTimeout(() => anim.dotLottie?.pause(), 500); };

// hide after the next render, but not before `min` ms since `t0` (and at the latest after MAX)
let round = 0;
function hideAfterRender(t0, min) {
  const me = ++round, end = () => { if (me === round) hide(); };   // a newer refresh owns the screen
  document.addEventListener('wt:rendered', () => setTimeout(end, Math.max(0, min - (performance.now() - t0))), { once: true });
  setTimeout(end, MAX);                                    // data failed to load: don't trap the page
}
hideAfterRender(0, MIN);                                   // first load (t0 = page start)

if (matchMedia('(pointer: coarse)').matches) {
  let y0 = null, d = 0;
  const atTop = () => window.scrollY <= 0 && !document.getElementById('filters')?.classList.contains('open');
  addEventListener('touchstart', (e) => { y0 = !busy && atTop() ? e.touches[0].clientY : null; d = 0; }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    d = window.scrollY <= 0 ? Math.max(0, e.touches[0].clientY - y0) : 0;
    const y = Math.min(d, 160) * .75 - 56;               // follows the finger, with resistance
    pullBall.classList.add('dragging');
    pullBall.style.transform = `translate(-50%, ${y}px) rotate(${d * 2.5}deg) scale(${d > PULL ? 1.15 : 1})`;
  }, { passive: true });
  addEventListener('touchend', () => {
    if (y0 == null) return;
    y0 = null;
    pullBall.classList.remove('dragging'); pullBall.style.transform = '';
    if (d > PULL) {
      show();
      hideAfterRender(performance.now(), still ? 500 : 1600);
      document.dispatchEvent(new Event('wt:refresh'));
    }
  });
}
