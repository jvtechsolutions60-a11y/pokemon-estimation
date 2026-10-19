// Builds the fingerprint index of every French card that has an official image.
// Usage: node index-build.mjs [dir=.]  →  fp-index.bin + fp-ids.json
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FP, fingerprintCard } from './fp-node.mjs';

const API = 'https://api.tcgdex.net/v2/fr';
const DIR = process.argv[2] || '.';
const POCKET = /^(?:[AB]\d+[a-z]?|P-[A-Z])-/;

async function get(url, as = 'json') {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return as === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
      if (res.status === 404) return null;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  return null;
}

const cards = (await get(`${API}/cards`)).filter((c) => c.image && !POCKET.test(c.id));
console.log(`${cards.length} cartes avec image`);
const done = new Map();
let failed = 0;
const queue = [...cards];
await Promise.all(Array.from({ length: 24 }, async () => {
  while (queue.length) {
    const c = queue.shift();
    const buf = await get(`${c.image}/low.webp`, 'buffer');
    try {
      if (!buf) throw new Error('absent');
      done.set(c.id, await fingerprintCard(buf));
    } catch { failed++; }
    if ((done.size + failed) % 2000 === 0) console.log(`${done.size + failed}/${cards.length}`);
  }
}));
// Stable order (by id) so a week without new cards gives the same file.
const ids = [...done.keys()].sort();
await writeFile(join(DIR, 'fp-index.bin'), FP.encodeIndex(ids.map((id) => done.get(id))));
await writeFile(join(DIR, 'fp-ids.json'), JSON.stringify(ids));
console.log(`index : ${ids.length} cartes, ${failed} échecs`);
