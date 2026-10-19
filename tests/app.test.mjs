// Offline tests: every outside request is answered from fixtures.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSite, openSite } from './helpers.mjs';
import { tcgdex } from './fixtures.mjs';

let site;
before(async () => { site = await startSite(); });
after(() => site.close());

async function withPage(failures, fn) {
  const api = tcgdex(failures);
  const { browser, page, errors } = await openSite(site, api.handler);
  try {
    await fn(page, api);
    assert.deepEqual(errors, [], 'erreurs JavaScript dans la page');
  } finally {
    await browser.close();
  }
}

test('lecture du numéro', () => withPage({}, async (page) => {
  const r = await page.evaluate(() => [parseNumber('Illus. 145/147 ★'), parseNumber('HP 120'), parseNumber('4 / 102')]);
  assert.deepEqual(r, [{ num: 145, total: 147 }, null, { num: 4, total: 102 }]);
}));

test('numéro mal lu : variantes plausibles, seulement avec un vrai total d\u2019extension', () => withPage({}, async (page) => {
  const r = await page.evaluate(() => {
    const totals = new Set([165, 193, 147]);
    const g = (hits) => numberGuesses(hits, totals).map((x) => `${x.num}/${x.total}`);
    return {
      dot: parseNumber('Moyen 128.165 @'),
      rattata: g([{ num: 120, total: 165 }]),
      sv: g([{ num: 906, total: 793 }]),
      stray: numberGuesses(parseNumbers('Mintenge 78/1130 kL · © 490/001 © · Ns 32,95'), new Set([113, 91, 95])).map((x) => `${x.num}/${x.total}`),
    };
  });
  assert.deepEqual(r.dot, { num: 128, total: 165 });
  assert.equal(r.rattata[0], '120/165');
  assert.ok(r.rattata.includes('128/165'));
  assert.ok(r.sv.includes('6/193'), r.sv.join(' '));
  assert.ok(!r.sv.some((x) => x.endsWith('/793')));
  for (const want of ['78/113', '190/91', '82/95']) assert.ok(r.stray.includes(want), `${want} absent de ${r.stray.join(' ')}`);

}));

test('nom lu sur la photo, même abîmé par l’OCR', () => withPage({}, async (page) => {
  const r = await page.evaluate(() => [
    nameOnPhoto({ name: 'Carchacrok C NIV.X' }, 'Carchacrok C NlV.X 100PV'),
    nameOnPhoto({ name: 'Apocyne' }, 'Carchacrok C NlV.X 100PV'),
    nameOnPhoto({ name: 'Brindibou et Noadkoko d\u2019Alola GX' }, 'Raichu et Raichu d\u2019Alola GX 210PV'),
    nameOnPhoto({ name: 'Méga-Dracaufeu X EX' }, 'MEGA Dracaufeu-EX'),
  ]);
  assert.deepEqual(r, [true, false, false, true]);
}));

test('prix : moyenne 7 jours, reverse sur les champs -holo', () => withPage({}, async (page) => {
  const r = await page.evaluate(() => {
    const card = { pricing: { cardmarket: { avg7: 7.2, trend: 6.45, 'avg7-holo': 9 } } };
    return [marketPrice(card, 'holo'), marketPrice(card, 'reverse'), marketPrice({ pricing: { cardmarket: { trend: 5 } } }, 'normal')];
  });
  assert.deepEqual(r, [7.2, 9, 5]);
}));

test('un prix plus ancien n’écrase pas le prix connu', () => withPage({}, async (page) => {
  const r = await page.evaluate(() => {
    const item = { variant: 'holo' };
    applyMarket(item, { pricing: { cardmarket: { updated: '2026-10-18T00:00:00Z', avg7: 10 } } }, { force: true });
    const older = applyMarket(item, { pricing: { cardmarket: { updated: '2026-10-17T00:00:00Z', avg7: 8 } } });
    const newer = applyMarket(item, { pricing: { cardmarket: { updated: '2026-10-19T00:00:00Z', avg7: 12 } } });
    return [older, newer, item.marketPrice];
  });
  assert.deepEqual(r, [false, true, 12]);
}));

test('données de collection nettoyées au chargement', () => withPage({}, async (page) => {
  const r = await page.evaluate(() => sanitizeCollection([
    { id: 'pl3-145', name: 'Carchacrok', nameEn: 'Garchomp C LV.X', qty: 99999, variant: 'pirate', image: 'https://evil.example/x.png', evil: 1 },
    { nope: true },
  ]));
  assert.equal(r.length, 1);
  assert.equal(r[0].qty, 9999);
  assert.equal(r[0].variant, 'normal');
  assert.equal(r[0].image, '');
  assert.equal(r[0].nameEn, 'Garchomp C LV.X');
  assert.equal(r[0].evil, undefined);
}));

test('export CSV protégé contre les formules', () => withPage({}, async (page) => {
  const r = await page.evaluate(() => [csvCell('=HYPERLINK("x")'), csvCell('-3,5'), csvCell('Carchacrok')]);
  assert.deepEqual(r, ['"\'=HYPERLINK(""x"")"', '-3,5', 'Carchacrok']);
}));

test('145/147 trouve la carte d’origine et la réédition Célébrations', () => withPage({}, async (page) => {
  const r = await page.evaluate(async () => {
    const cards = await findByNumber('fr', 145, 147);
    return { ids: cards.map((c) => c.id).sort(), printed: cards.map((c) => c.printed), incomplete: cards.incomplete };
  });
  assert.deepEqual(r.ids, ['cel25cc-CC018', 'ecard2-145', 'pl3-145', 'sm3-145']);
  assert.ok(r.printed.every((p) => p === '145/147'));
  assert.equal(r.incomplete, false);
}));

test('une extension qui ne répond pas une fois est redemandée', () => withPage({ '/v2/fr/sets/pl3': 1 }, async (page, api) => {
  const ids = await page.evaluate(async () => (await findByNumber('fr', 145, 147)).map((c) => c.id));
  assert.ok(ids.includes('pl3-145'));
  assert.equal(api.calls.filter((p) => p === '/v2/fr/sets/pl3').length, 2);
}));

test('une extension en panne est signalée au lieu d’être ignorée', () => withPage({ '/v2/fr/sets/pl3': 99 }, async (page) => {
  await page.evaluate(() => searchNumber(145, 147, 'Carchacrok C NIV.X'));
  assert.match(await page.textContent('#results'), /Certaines extensions n.ont pas répondu/);
}));

test('recherche 145/147 : seules les deux Carchacrok, lien Cardmarket en anglais', () => withPage({}, async (page) => {
  await page.evaluate(() => searchNumber(145, 147, 'Carchacrok C NIV.X'));
  await page.waitForFunction(() => [...document.querySelectorAll('#results .card .cm')].every((a) => a.href.includes('Garchomp')));
  const cards = await page.$$eval('#results .card', (els) => els.map((e) => ({ text: e.innerText, cm: e.querySelector('.cm').href })));
  assert.equal(cards.length, 2);
  assert.ok(cards.some((c) => /Célébrations/.test(c.text)));
  for (const c of cards) assert.equal(new URL(c.cm).searchParams.get('searchString'), 'Garchomp C LV.X');
  assert.match(await page.textContent('#results'), /Voir 2 autres cartes/);
}));

test('ajout à la collection : prix, nom anglais gardé après rechargement', () => withPage({}, async (page) => {
  await page.evaluate(() => searchNumber(145, 147, 'Carchacrok C NIV.X'));
  await page.locator('#results .card', { hasText: 'Célébrations' }).getByRole('button', { name: 'Ajouter' }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('pokemon-estimation:collection'))[0]?.nameEn);
  await page.reload();
  const items = await page.evaluate(() => JSON.parse(localStorage.getItem('pokemon-estimation:collection')));
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'cel25cc-CC018');
  assert.equal(items[0].marketPrice, 7.2);
  assert.equal(items[0].nameEn, 'Garchomp C LV.X');
  assert.equal(items[0].number, '145/147');
}));

test('images officielles : passage par notre serveur quand le CORS de TCGdex est refusé', async () => {
  const { readFile } = await import('node:fs/promises');
  const png = await readFile(new URL('../icons/icon-192.png', import.meta.url));
  const api = tcgdex();
  const hosts = [];
  const { browser, page, errors } = await openSite(site, async (route) => {
    const url = new URL(route.request().url());
    hosts.push(url.host + url.pathname);
    // What assets.tcgdex.net really sends: the header twice, which browsers reject.
    if (url.host === 'assets.tcgdex.net') return route.fulfill({ body: png, contentType: 'image/png', headers: { 'access-control-allow-origin': '*, *' } });
    if (url.host.endsWith('.workers.dev')) return route.fulfill({ body: png, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } });
    return api.handler(route);
  });
  try {
    const size = await page.evaluate(async () => {
      const img = await loadRemoteImage('https://assets.tcgdex.net/fr/pl/pl3/145/low.webp');
      const c = document.createElement('canvas');
      c.getContext('2d').drawImage(img, 0, 0);
      c.getContext('2d').getImageData(0, 0, 1, 1); // throws on a tainted canvas
      return img.naturalWidth;
    });
    assert.equal(size, 192);
    assert.ok(hosts.includes('pokemon-estimation-sync.jvtechsolutions60.workers.dev/img/fr/pl/pl3/145/low.webp'), hosts.join('\n'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('reconnaissance par l’image : carte inclinée sur un fond chargé, reconnue sans lire le numéro', () => withPage({}, async (page) => {
  // Four made-up card images stand in for the official ones, and a photo of
  // one of them, tilted, on a busy background.
  const ids = ['ecard2-145', 'pl3-145', 'sm3-145', 'cel25cc-CC018'];
  const { index, photo } = await page.evaluate((ids) => {
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const color = () => `rgb(${rand() * 255 | 0},${rand() * 255 | 0},${rand() * 255 | 0})`;
    const cards = ids.map(() => {
      const c = document.createElement('canvas');
      c.width = 252; c.height = 352;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#e8c33a'; ctx.fillRect(0, 0, 252, 352);
      ctx.fillStyle = color(); ctx.fillRect(10, 10, 232, 332);
      for (let k = 0; k < 14; k++) {
        ctx.fillStyle = color();
        ctx.beginPath();
        ctx.arc(20 + rand() * 212, 20 + rand() * 312, 10 + rand() * 50, 0, 7);
        ctx.fill();
      }
      return c;
    });
    const fps = cards.map((c) => {
      const s = document.createElement('canvas');
      s.width = Fingerprint.CARD_W; s.height = Fingerprint.CARD_H;
      s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
      return Fingerprint.fingerprint(s.getContext('2d').getImageData(0, 0, s.width, s.height).data, 4);
    });
    const p = document.createElement('canvas');
    p.width = 900; p.height = 1200;
    const ctx = p.getContext('2d');
    for (let k = 0; k < 300; k++) { ctx.fillStyle = color(); ctx.fillRect(rand() * 900, rand() * 1200, 20 + rand() * 120, 20 + rand() * 120); }
    ctx.translate(450, 620);
    ctx.rotate((4 * Math.PI) / 180);
    ctx.drawImage(cards[1], -270, -377, 540, 754);
    return { index: Array.from(Fingerprint.encodeIndex(fps)), photo: p.toDataURL('image/jpeg', 0.9).split(',')[1] };
  }, ids);
  await page.route(/@empreintes\/fp-index\.bin$/, (r) => r.fulfill({ body: Buffer.from(index), contentType: 'application/octet-stream' }));
  await page.route(/@empreintes\/fp-ids\.json$/, (r) => r.fulfill({ json: ids }));
  await page.setInputFiles('#photo', { name: 'carte.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(photo, 'base64') });
  await page.waitForFunction(() => /Carte reconnue/.test(document.getElementById('ocrStatus').textContent), null, { timeout: 30000 });
  assert.match(await page.textContent('#ocrStatus'), /Carchacrok C NIV\.X · Vainqueurs Suprêmes/);
  assert.match(await page.textContent('#results .card.best'), /Correspond à ta photo/);
}));

test('collection sur téléphone : réglages repliés, un toucher les ouvre', () => withPage({}, async (page) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    collection = sanitizeCollection([{ id: 'pl3-145', name: 'Carchacrok C NIV.X', set: 'Rivaux Émergents', number: '145/147', qty: 2, marketPrice: 10 }]);
    saveCollection();
    renderCollection();
    location.hash = '#collection';
  });
  const controls = page.locator('#rows .item-controls');
  assert.equal(await controls.isVisible(), false);
  await page.click('#rows .item-head');
  assert.equal(await controls.isVisible(), true);
  await page.click('#rows .q-plus'); // the row is rebuilt and stays open
  assert.equal(await page.locator('#rows .q-val').textContent(), '3');
  assert.equal(await controls.isVisible(), true);
}));

test('prix de repli signalé : reverse sans cote reverse, décote d’état indiquée', () => withPage({}, async (page) => {
  const r = await page.evaluate(() => {
    const normalOnly = { pricing: { cardmarket: { avg7: 4, updated: '2026-10-10' } } };
    const both = { pricing: { cardmarket: { avg7: 4, 'avg7-holo': 9, updated: '2026-10-10' } } };
    const reverseOnly = { pricing: { cardmarket: { 'avg7-holo': 9, updated: '2026-10-10' } } };
    const item = sanitizeCollection([{ id: 'a', name: 'A', variant: 'reverse', condition: 'EX' }])[0];
    applyMarket(item, normalOnly, { force: true });
    const label = priceSourceLabel(item);
    const kept = sanitizeCollection([item])[0].priceFallback;
    applyMarket(item, both, { force: true });
    return {
      flags: [priceIsFallback(normalOnly, 'reverse'), priceIsFallback(both, 'reverse'), priceIsFallback(both, 'normal'), priceIsFallback(reverseOnly, 'normal')],
      label, kept, after: item.priceFallback,
    };
  });
  assert.deepEqual(r.flags, [true, false, false, true]);
  assert.match(r.label, /état EX : −20 % \(estimation\)/);
  assert.match(r.label, /Pas de cote reverse/);
  assert.equal(r.kept, true);
  assert.equal(r.after, undefined);
}));

test('grosse collection affichée par pages ; un autre état = une autre ligne', () => withPage({}, async (page) => {
  const r = await page.evaluate(() => {
    collection = sanitizeCollection(Array.from({ length: 250 }, (_, i) => ({ id: `c-${i}`, name: `Carte ${i}`, set: 'S', number: `${i}`, marketPrice: i })));
    renderCollection();
    const first = document.querySelectorAll('#rows .item').length;
    document.querySelector('#rows .more-rows').click();
    const second = document.querySelectorAll('#rows .item').length;
    const card = { id: 'pl3-145', name: 'Carchacrok', set: { name: 'Rivaux', cardCount: { official: 147 } }, localId: '145', image: '', pricing: {} };
    collection = [];
    addToCollection(card, 'normal', 'NM');
    addToCollection(card, 'normal', 'EX');
    addToCollection(card, 'normal', 'NM');
    const split = collection.map((i) => `${i.condition}×${i.qty}`).join(' ');
    collection[1].condition = 'NM';
    joinTwin(collection[1]);
    return { first, second, split, joined: collection.map((i) => `${i.condition}×${i.qty}`).join(' ') };
  });
  assert.deepEqual(r, { first: 100, second: 200, split: 'NM×2 EX×1', joined: 'NM×3' });
}));
