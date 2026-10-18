// Checks against the real services (run by CI, which has internet access).
// They catch an API change before users do.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSite, openSite } from './helpers.mjs';

let site;
let ctx;
before(async () => { site = await startSite(); ctx = await openSite(site); });
after(async () => { await ctx.browser.close(); site.close(); });

test('TCGdex : 145/147 renvoie Vainqueurs Suprêmes et la réédition Célébrations', async () => {
  const ids = await ctx.page.evaluate(async () => (await findByNumber('fr', 145, 147)).map((c) => c.id));
  assert.ok(ids.includes('pl3-145'), ids.join(', '));
  assert.ok(ids.some((id) => id.startsWith('cel25c')), ids.join(', '));
});

test('TCGdex : nom anglais pour la recherche Cardmarket', async () => {
  const name = await ctx.page.evaluate(() => englishName('cel25cc-CC018', 'Carchacrok C NIV.X', 'fr'));
  assert.equal(name, 'Garchomp C LV.X');
});

test('TCGdex : prix Cardmarket présents', async () => {
  const cm = await ctx.page.evaluate(async () => (await getCard('fr', 'pl3-145')).pricing?.cardmarket);
  assert.ok(cm && typeof cm.updated === 'string', 'pas de bloc pricing.cardmarket');
  assert.ok(['avg7', 'trend', 'avg30', 'avg'].some((k) => typeof cm[k] === 'number'), JSON.stringify(cm));
});

// What the image server answers to a page on another site (status and CORS header).
async function probe(url) {
  const res = await fetch(url, { headers: { Origin: 'https://jvtechsolutions60-a11y.github.io' } });
  return `${url} → HTTP ${res.status}, type ${res.headers.get('content-type')}, CORS ${res.headers.get('access-control-allow-origin')}`;
}

test('images officielles lisibles (comparaison visuelle des éditions)', async () => {
  const image = await ctx.page.evaluate(async () => (await getCard('fr', 'pl3-145')).image);
  const info = await probe(`${image}/low.webp`);
  const result = await ctx.page.evaluate(async (url) => {
    try {
      const img = await loadRemoteImage(url);
      const c = document.createElement('canvas');
      c.width = 10; c.height = 10;
      c.getContext('2d').drawImage(img, 0, 0, 10, 10);
      c.getContext('2d').getImageData(0, 0, 10, 10); // throws if CORS is missing
      return 'ok';
    } catch (e) {
      return String(e && e.message || e && e.type || e);
    }
  }, `${image}/low.webp`);
  assert.equal(result, 'ok', info);
});

test('OCR : numéro lu sur l\u2019image officielle de Carchacrok C NIV.X', async () => {
  const image = await ctx.page.evaluate(async () => (await getCard('fr', 'pl3-145')).image);
  const res = await fetch(`${image}/high.png`);
  assert.ok(res.ok, await probe(`${image}/high.png`));
  const bytes = [...new Uint8Array(await res.arrayBuffer())];
  const hit = await ctx.page.evaluate(async (data) => {
    const file = new File([new Uint8Array(data)], 'carte.png', { type: 'image/png' });
    return readCardNumber(await loadImage(file));
  }, bytes);
  assert.deepEqual(hit, { num: 145, total: 147 });
});
