// Where the page gets its data. The same page runs two ways:
//  - with the server (node server.js): asks /api/* — always current, alerts can be managed here
//  - as a static site (GitHub Pages, <html data-mode="static">): reads data/snapshot.json,
//    which a scheduled job refreshes, and runs the same filtering code here in the browser
//    with the viewer's own clock (so past hours still drop off even if the file is a bit old)
export const STATIC = document.documentElement.dataset.mode === 'static';

async function json(path, init) {
  const r = await fetch(path, init);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

let local = null;                  // static mode: { lib…, CATALOG, snapshot, config }
async function loadLocal() {
  if (!local) {
    local = (async () => {
      const [state, commands, cat, snapshot, config] = await Promise.all([
        import('./lib/state.js'), import('./lib/commands.js'), import('./catalog.js'),
        json('data/snapshot.json', { cache: 'no-cache' }), json('data/config.json', { cache: 'no-cache' }),
      ]);
      return { ...state, ...commands, CATALOG: cat.CATALOG, snapshot, config };
    })();
  }
  return local;
}

/** Venue cards (name, area, links, live or self-check). */
export async function getVenues() {
  if (!STATIC) return json('api/venues');
  const L = await loadLocal();
  return L.CATALOG.map((v) => L.venueCard(v, L.snapshot));
}

/** Free slots for the filters. */
export async function getState({ minHours, place }) {
  if (!STATIC) return json(`api/state?minHours=${minHours}&place=${place}`);
  const L = await loadLocal();
  return L.buildState(L.snapshot, L.CATALOG, { minHours, place });
}

/** { botBasicId, addFriendUrl } */
export async function getConfig() {
  if (!STATIC) return json('api/config');
  return (await loadLocal()).config;
}

/** The alert as a LINE command + links: { text, summary, lineUrl, shareUrl } or { error }. */
export async function buildCommand(watch) {
  if (!STATIC) {
    const r = await fetch('api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(watch) });
    const data = await r.json().catch(() => ({}));
    return r.ok ? data : { error: data.error || 'Could not build the alert.' };
  }
  const L = await loadLocal();
  return L.lineCommand(watch, { catalog: L.CATALOG, clock: L.bkkClock(), botBasicId: L.config.botBasicId });
}
