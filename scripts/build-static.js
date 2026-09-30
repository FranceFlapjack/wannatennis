// Builds the static website (GitHub Pages) into dist/ from the same code the server uses.
//   node lib/poll.js              # fresh data/snapshot.json first
//   node scripts/build-static.js  # -> dist/
// The page runs in static mode: it reads dist/data/*.json and does the filtering in the
// browser (public/data.js). Env: LINE_BOT_BASIC_ID (e.g. @724ganrk) for the LINE buttons.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, process.argv[2] || 'dist');
// only pure, browser-safe modules (no node: imports)
const LIB = ['state.js', 'slots.js', 'time.js', 'commands.js'];

const snapshot = JSON.parse(await readFile(join(ROOT, 'data', 'snapshot.json'), 'utf8'));
if (!snapshot.generatedAt) throw new Error('data/snapshot.json has no generatedAt — run lib/poll.js first');

await rm(OUT, { recursive: true, force: true });
await cp(join(ROOT, 'public'), OUT, { recursive: true });
await mkdir(join(OUT, 'lib'), { recursive: true });
for (const f of LIB) await cp(join(ROOT, 'lib', f), join(OUT, 'lib', f));
await cp(join(ROOT, 'catalog.js'), join(OUT, 'catalog.js'));

await mkdir(join(OUT, 'data'), { recursive: true });
await writeFile(join(OUT, 'data', 'snapshot.json'), JSON.stringify(snapshot));
const id = process.env.LINE_BOT_BASIC_ID || null;
await writeFile(join(OUT, 'data', 'config.json'), JSON.stringify({
  botBasicId: id, addFriendUrl: id ? `https://line.me/R/ti/p/${encodeURIComponent(id)}` : null,
}));

const indexPath = join(OUT, 'index.html');
const html = await readFile(indexPath, 'utf8');
if (!html.includes('<html lang="en">')) throw new Error('index.html: expected <html lang="en"> to mark static mode');
await writeFile(indexPath, html.replace('<html lang="en">', '<html lang="en" data-mode="static">'));
await writeFile(join(OUT, '.nojekyll'), '');       // serve files as-is, no Jekyll processing

console.log(`built ${OUT} — data from ${snapshot.generatedAt}${id ? `, LINE ${id}` : ', no LINE id'}`);
