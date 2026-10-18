// Builds the fingerprint index of every French card that has an official image.
// Usage: node index-build.mjs [out=fp-index.json]
import { writeFile } from 'node:fs/promises';
import { fingerprintCard } from './fp-node.mjs';

const API = 'https://api.tcgdex.net/v2/fr';
const OUT = process.argv[2] || 'fp-index.json';
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
const index = [];
let done = 0;
let failed = 0;
const queue = [...cards];
await Promise.all(Array.from({ length: 24 }, async () => {
  while (queue.length) {
    const c = queue.shift();
    const buf = await get(`${c.image}/low.webp`, 'buffer');
    if (buf) {
      try {
        const fp = await fingerprintCard(buf);
        index.push({ id: c.id, name: c.name, n: c.localId, h: fp.hash.toString(16).padStart(16, '0'), g: [...fp.grid].map((x) => Math.round(x * 100) / 100) });
      } catch { failed++; }
    } else failed++;
    if (++done % 1000 === 0) console.log(`${done}/${cards.length}`);
  }
}));
console.log(`index : ${index.length} cartes, ${failed} échecs`);
await writeFile(OUT, JSON.stringify(index));
