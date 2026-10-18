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

test('images officielles lisibles (comparaison visuelle des éditions)', async () => {
  const ok = await ctx.page.evaluate(async () => {
    const card = await getCard('fr', 'pl3-145');
    const img = await loadRemoteImage(`${card.image}/low.webp`);
    const c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    c.getContext('2d').drawImage(img, 0, 0, 10, 10);
    return c.getContext('2d').getImageData(0, 0, 10, 10).data.length === 400; // throws if CORS is missing
  });
  assert.ok(ok);
});

test('OCR : numéro lu sur l’image officielle de Carchacrok C NIV.X', async () => {
  const hit = await ctx.page.evaluate(async () => {
    const card = await getCard('fr', 'pl3-145');
    const blob = await (await fetch(`${card.image}/high.png`)).blob();
    return readCardNumber(await loadImage(new File([blob], 'carte.png', { type: blob.type })));
  });
  assert.deepEqual(hit, { num: 145, total: 147 });
});
