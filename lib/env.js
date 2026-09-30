// Minimal .env loader (no dependency). Real environment variables win over the file.
import { readFileSync } from 'node:fs';

export function loadEnv(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return false; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}
