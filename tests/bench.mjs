// Test bench: ~100 real cards from TCGdex, read by the app as a clean scan and
// as a simulated phone photo (background, tilt, lighting, blur, JPEG).
// Usage: node bench.mjs [cards=100] [seed=1]   (needs internet: run by CI)
import { writeFile, mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { startSite, openSite } from './helpers.mjs';

// Recognition by image, when an index was built (index-build.mjs).
let fp = null;
try {
  const ids = JSON.parse(await readFile(new URL('./fp-ids.json', import.meta.url), 'utf8'));
  const mod = await import('./fp-node.mjs');
  const index = mod.FP.decodeIndex(await readFile(new URL('./fp-index.bin', import.meta.url)));
  const names = JSON.parse(await readFile(new URL('./fp-names.json', import.meta.url), 'utf8').catch(() => '{}'));
  fp = { ids, index, names, ...mod };
  console.log(`index d'empreintes : ${index.length} cartes`);
} catch (e) {
  console.log(`pas d'index d'empreintes (${e.message}) : reconnaissance par image non testée`);
}

async function byImage(buf, card, hit, mode) {
  // A clean scan is already just the card; a photo needs the card found first.
  const q = mode === 'scan' ? await fp.fingerprintCard(buf) : await fp.fingerprintPhoto(buf);
  const ranked = fp.FP.closest(fp.index, q, 20).map((r) => ({ id: fp.ids[r.i], d: r.d }));
  const pos = ranked.findIndex((r) => r.id === card.id);
  const num = (id) => parseInt(id.split('-').pop(), 10);
  // Hybrid: among the 20 closest images, the one whose number was read.
  const withNumber = hit && ranked.find((r) => num(r.id) === hit.num);
  const hybrid = withNumber ? withNumber.id : ranked[0].id;
  const gap = ranked[1].d - ranked[0].d;
  return {
    imgRank: pos, // -1 = not in the 20 closest
    imgTop1: pos === 0,
    imgTop5: pos >= 0 && pos < 5,
    imgSure: gap >= 0.1 && ranked[0].d < 0.9, // same rule as the site
    imgGap: Math.round(gap * 1000) / 1000,
    imgFirst: ranked[0].id,
    hybridOk: hybrid === card.id,
  };
}

// The official image, fetched from here: assets.tcgdex.net's doubled CORS
// header stops the page from downloading it itself.
const images = new Map();
async function officialImage(card) {
  if (!images.has(card.id)) {
    const base = await page.evaluate(async (id) => (await getCard('fr', id)).image || null, card.id);
    if (!base) return null;
    const res = await fetch(`${base}/high.png`);
    if (!res.ok) return null;
    images.set(card.id, Buffer.from(await res.arrayBuffer()).toString('base64'));
  }
  return images.get(card.id);
}

async function runOne(card, mode, seed) {
  const png = await officialImage(card);
  if (!png) return { skipped: 'pas d\u2019image' };
  const r = await page.evaluate(async ({ card, mode, seed, png }) => {
    let s = seed >>> 0;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const bytes = Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0));
    let file = new File([bytes], 'carte.png', { type: 'image/png' });
    let photoB64 = null;
    if (mode === 'photo') {
      // Card lying on a table, shot slightly tilted, under uneven light.
      const src = await loadImage(file);
      const W = 1200; const H = 1600;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const hue = Math.floor(rand() * 360);
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, `hsl(${hue} 25% ${30 + rand() * 40}%)`);
      grad.addColorStop(1, `hsl(${(hue + 40) % 360} 20% ${20 + rand() * 40}%)`);
      g.fillStyle = grad; g.fillRect(0, 0, W, H);
      const h = H * (0.72 + rand() * 0.18);
      const w = h * src.naturalWidth / src.naturalHeight;
      g.save();
      g.translate(W / 2 + (rand() - 0.5) * 80, H / 2 + (rand() - 0.5) * 80);
      g.rotate((rand() - 0.5) * 0.12); // about ±3.5°
      g.filter = `brightness(${0.8 + rand() * 0.4}) contrast(${0.85 + rand() * 0.25}) blur(${(rand() * 1.2).toFixed(2)}px)`;
      g.drawImage(src, -w / 2, -h / 2, w, h);
      g.restore();
      // Light falling from one side.
      const light = g.createRadialGradient(W * rand(), H * rand(), 50, W / 2, H / 2, W);
      light.addColorStop(0, 'rgba(255,255,240,0.18)');
      light.addColorStop(1, 'rgba(0,0,0,0.12)');
      g.fillStyle = light; g.fillRect(0, 0, W, H);
      const jpeg = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.78));
      file = new File([jpeg], 'photo.jpg', { type: 'image/jpeg' });
      photoB64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(jpeg); });
    }
    $('lang').value = 'fr';
    const t0 = performance.now();
    const img = await loadImage(file);
    const res = await identifyPhoto(img);
    const ms = Math.round(performance.now() - t0);
    const listIds = [...(res.cards || []), ...(res.others || [])].map((c) => c.id);
    // What the OCR saw when no number came out, to tune the passes.
    let ocr = null;
    if (!res.hit || res.hit.num !== card.num || res.hit.total !== card.total) {
      const w = await getWorker();
      ocr = [];
      for (const [from, to, threshold, invert] of OCR_PASSES.slice(0, 2)) {
        ocr.push((await w.recognize(prepareBand(img, from, to, threshold, invert))).data.text.replace(/\s+/g, ' ').slice(0, 160));
      }
    }
    return {
      read: res.hit ? `${res.hit.num}/${res.hit.total}` : null,
      numberOk: Boolean(res.hit && res.hit.num === card.num && res.hit.total === card.total),
      lang: res.detected,
      candidates: listIds.length,
      listed: listIds.includes(card.id),
      rank: (res.cards || []).findIndex((c) => c.id === card.id),
      sure: res.sure,
      pick: res.pick ? res.pick.id : null,
      ms,
      ocr,
      photoB64,
      hit: res.hit,
    };
  }, { card, mode, seed, png });
  const { photoB64, hit, ...out } = r;
  if (fp) Object.assign(out, await byImage(Buffer.from(photoB64 || png, 'base64'), card, hit, mode));
  return out;
}

const rows = [];
for (const [i, card] of sample.entries()) {
  for (const mode of ['scan', 'photo']) {
    let r;
    try {
      r = await Promise.race([runOne(card, mode, SEED * 1000 + i), new Promise((_, rej) => setTimeout(() => rej(new Error('délai dépassé')), 120000))]);
    } catch (e) {
      r = { error: String(e.message || e).slice(0, 200) };
    }
    rows.push({ ...card, mode, ...r });
    console.log(i + 1, mode, card.id, `${card.num}/${card.total}`, JSON.stringify(r));
  }
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)} %` : '–');
let md = `# Banc d'essai : ${sample.length} cartes (graine ${SEED})\n\n`;
md += '| | Scan propre | Photo simulée |\n|---|---|---|\n';
const stats = {};
for (const mode of ['scan', 'photo']) {
  const all = rows.filter((r) => r.mode === mode && !r.skipped);
  const ok = all.filter((r) => !r.error);
  stats[mode] = {
    total: all.length,
    numberOk: ok.filter((r) => r.numberOk).length,
    listed: ok.filter((r) => r.listed).length,
    autoOk: ok.filter((r) => r.sure && r.pick === r.id).length,
    autoWrong: ok.filter((r) => r.sure && r.pick !== r.id).length,
    errors: all.length - ok.length,
    ms: Math.round(ok.reduce((a, r) => a + r.ms, 0) / (ok.length || 1)),
    imgTop1: ok.filter((r) => r.imgTop1).length,
    imgTop5: ok.filter((r) => r.imgTop5).length,
    imgSure: ok.filter((r) => r.imgSure).length,
    imgSureWrong: ok.filter((r) => r.imgSure && !r.imgTop1).length,
    hybridOk: ok.filter((r) => r.hybridOk).length,
  };
}
const line = (label, key, fmt = (m) => pct(stats[m][key], stats[m].total)) => { md += `| ${label} | ${fmt('scan')} | ${fmt('photo')} |\n`; };
line('Cartes testées', 'total', (m) => String(stats[m].total));
line('Numéro bien lu', 'numberOk');
line('Bonne carte dans la liste', 'listed');
line('Ajout automatique correct', 'autoOk');
line('Ajout automatique **faux**', 'autoWrong');
line('Erreurs techniques', 'errors', (m) => String(stats[m].errors));
line('Temps moyen par carte', 'ms', (m) => `${(stats[m].ms / 1000).toFixed(1)} s`);
if (fp) {
  md += `| **Par l'image** (${fp.index.length} cartes connues) | | |\n`;
  line('Bonne carte en 1er', 'imgTop1');
  line('Bonne carte dans les 5 premières', 'imgTop5');
  line('Sûre (nettement devant la 2e)', 'imgSure');
  line('Sûre mais **fausse**', 'imgSureWrong');
  line('Image + numéro lu', 'hybridOk');
}
md += '\n## Échecs\n\n| Mode | Carte | Extension | Attendu | Lu | Dans la liste | Choix auto |\n|---|---|---|---|---|---|---|\n';
for (const r of rows.filter((x) => !x.skipped && (x.error || !x.numberOk || !x.listed || (x.sure && x.pick !== x.id)))) {
  md += `| ${r.mode} | ${r.name} (${r.id}) | ${r.set} | ${r.num}/${r.total} | ${r.error ? `erreur : ${r.error}` : r.read || 'rien'} | ${r.listed ? 'oui' : 'non'} | ${r.sure ? r.pick : '–'} |\n`;
}
if (errors.length) md += `\nErreurs JavaScript : ${[...new Set(errors)].join(' · ')}\n`;

await mkdir(OUT, { recursive: true });
await writeFile(new URL('results.json', OUT), JSON.stringify({ seed: SEED, stats, rows }, null, 1));
await writeFile(new URL('RESULTATS.md', OUT), md);
console.log(md);
await browser.close();
site.close();
