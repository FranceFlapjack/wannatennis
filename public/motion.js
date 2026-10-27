// Motion layer — optional polish on top of a page that already works without it
// (the welcome serve is splash.js + CSS, not this file):
//   • cards reveal as you scroll on first load; after a day/filter change, a quick fade
//   • slot tiles lean toward the mouse (desktop)
// Scrolling itself stays native. Does nothing with ?motion=0, when the device asks for
// reduced motion, or if the CDN libraries didn't load.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches || new URLSearchParams(location.search).get('motion') === '0';
const { gsap, ScrollTrigger } = window;

if (!reduce && gsap && ScrollTrigger) start();

function start() {
  gsap.registerPlugin(ScrollTrigger);

  // list reveals
  let first = true, triggers = [];
  const reveal = () => {
    triggers.forEach((t) => t.kill()); triggers = [];
    const items = gsap.utils.toArray('#list > *');
    if (!first) {                     // re-render (day / filter): never leave anything hidden
      gsap.fromTo(items, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: .3, stagger: .025, ease: 'power2.out', overwrite: true, clearProps: 'transform' });
      return;
    }
    first = false;
    const all = [...items, ...gsap.utils.toArray('.results-head, #alertswrap, #mapwrap')];
    gsap.set(all, { opacity: 0, y: 26 });
    const show = (batch) => {
      gsap.to(batch, { opacity: 1, y: 0, duration: .6, ease: 'power3.out', stagger: .07, overwrite: true, clearProps: 'transform' });
      const slots = batch.flatMap((el) => [...el.querySelectorAll('.slot')]);
      if (slots.length) gsap.from(slots, { scale: .9, opacity: 0, duration: .4, delay: .15, stagger: .03, ease: 'back.out(1.6)', clearProps: 'transform' });
    };
    triggers = ScrollTrigger.batch(all, { start: 'top 94%', once: true, onEnter: show, onEnterBack: show });
    // safety net: whatever a trigger missed (e.g. already scrolled past) shows after a moment
    gsap.delayedCall(2.5, () => gsap.to(all.filter((el) => +getComputedStyle(el).opacity < 1), { opacity: 1, y: 0, duration: .4 }));
  };
  document.addEventListener('wt:rendered', reveal);
  if (document.querySelector('#list > *')) reveal();     // rendered before this file ran

  // slot tiles lean toward the pointer (mouse/trackpad only)
  if (matchMedia('(pointer: fine)').matches) {
    const list = document.getElementById('list');
    list.addEventListener('pointermove', (e) => {
      const s = e.target.closest('.slot'); if (!s) return;
      const r = s.getBoundingClientRect();
      gsap.to(s, { x: (e.clientX - r.left - r.width / 2) * .16, y: (e.clientY - r.top - r.height / 2) * .22, duration: .3, ease: 'power2.out' });
    });
    list.addEventListener('pointerout', (e) => {
      const s = e.target.closest('.slot');
      if (s && !s.contains(e.relatedTarget)) gsap.to(s, { x: 0, y: 0, duration: .6, ease: 'elastic.out(1, .45)' });
    });
  }
}
