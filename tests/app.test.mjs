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

test('souhaits : ajout depuis la recherche, prix cible, gardés après rechargement', () => withPage({}, async (page) => {
  await page.evaluate(() => searchNumber(145, 147, 'Carchacrok C NIV.X'));
  const card = page.locator('#results .card', { hasText: 'Célébrations' });
  await card.getByRole('button', { name: '☆ Souhait' }).click();
  await card.getByRole('button', { name: '★ Dans tes souhaits' }).waitFor();
  await page.goto(`${site.url}#souhaits`);
  const row = page.locator('#wishRows .item');
  assert.equal(await row.count(), 1);
  assert.match(await row.innerText(), /Carchacrok C NIV\.X[\s\S]*7,20/);
  assert.equal(await page.isHidden('#wishBadge'), true);
  await row.locator('.w-target').fill('8');
  await row.locator('.w-target').dispatchEvent('change');
  await page.waitForSelector('#wishRows .item.deal');
  await page.reload();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pokemon-estimation:wishlist')));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].target, 8);
  assert.equal(saved[0].deal, true);
  assert.equal(await page.textContent('#wishBadge'), '1');
  assert.match(await page.textContent('#wishRows .item'), /À ton prix/);
  // A card already at its price when the target is set is not announced again later.
  assert.equal(await page.isHidden('#toast'), true);
}));

test('souhaits : vérification du jour, alerte quand le prix passe sous la cible', () => withPage({}, async (page) => {
  await page.evaluate(() => {
    localStorage.setItem('pokemon-estimation:wishlist', JSON.stringify([
      { id: 'pl3-145', lang: 'fr', name: 'Carchacrok C NIV.X', set: 'Vainqueurs Suprêmes', number: '145/147', variant: 'holo', marketPrice: 30, marketDate: '2026-10-10T00:00:00Z', target: 25 },
      { id: 'cel25cc-CC018', lang: 'fr', name: 'Carchacrok C NIV.X', set: 'Célébrations', number: '145/147', variant: 'holo', marketPrice: 7.2, marketDate: '2026-10-18T00:00:00Z', target: 5 },
    ]));
    localStorage.setItem('pokemon-estimation:wishlist-check', '2000-01-01');
  });
  await page.reload();
  await page.waitForFunction(() => /à ton prix/.test(document.getElementById('toast').textContent));
  assert.match(await page.textContent('#toast'), /Carchacrok C NIV\.X est à ton prix : 20,00/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pokemon-estimation:wishlist')));
  assert.deepEqual(saved.map((w) => [w.marketPrice, Boolean(w.deal)]), [[20, true], [7.2, false]]);
  assert.equal(await page.textContent('#wishBadge'), '1');
  // Checked once a day only.
  await page.reload();
  await page.waitForTimeout(300);
  assert.equal(await page.isHidden('#toast'), true);
}));

test('souhaits : « Je l’ai » passe la carte dans la collection', () => withPage({}, async (page) => {
  await page.evaluate(() => {
    localStorage.setItem('pokemon-estimation:wishlist', JSON.stringify([
      { id: 'pl3-145', lang: 'fr', name: 'Carchacrok C NIV.X', set: 'Vainqueurs Suprêmes', number: '145/147', variant: 'holo', marketPrice: 20, target: 25, deal: true },
    ]));
    localStorage.setItem('pokemon-estimation:wishlist-check', new Date().toLocaleDateString('sv'));
  });
  await page.goto(`${site.url}#souhaits`);
  await page.reload();
  await page.locator('#wishRows .w-got').click();
  const r = await page.evaluate(() => ({
    wish: JSON.parse(localStorage.getItem('pokemon-estimation:wishlist')),
    col: JSON.parse(localStorage.getItem('pokemon-estimation:collection')),
  }));
  assert.equal(r.wish.length, 0);
  assert.equal(r.col.length, 1);
  assert.deepEqual([r.col[0].id, r.col[0].condition, r.col[0].qty, r.col[0].marketPrice, r.col[0].target], ['pl3-145', 'NM', 1, 20, undefined]);
  assert.match(await page.textContent('#wishRows'), /Aucune carte recherchée/);
}));

test('souhaits : étoile sur les cartes manquantes d’une extension', () => withPage({}, async (page) => {
  await page.goto(`${site.url}#extensions`);
  await page.selectOption('#setSelect', 'pl3');
  await page.locator('.tick-wish').click();
  await page.waitForSelector('.tick-wish.on');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pokemon-estimation:wishlist')));
  assert.deepEqual(saved.map((w) => [w.id, w.marketPrice]), [['pl3-145', 20]]);
  // Ticking the card itself is still possible, and hides the star.
  await page.locator('label.tick input[type=checkbox]').check();
  await page.waitForSelector('label.tick.owned');
  assert.equal(await page.locator('.tick-wish').count(), 0);
}));

test('souhaits : données nettoyées au chargement', () => withPage({}, async (page) => {
  const r = await page.evaluate(() => sanitizeWishlist([
    { id: 'pl3-145', name: 'Carchacrok', target: -3, qty: 4, condition: 'PO', image: 'javascript:x', deal: 'yes' },
    { id: 'sm3-145', name: 'Apocyne', target: 12.345 },
    'junk',
  ]));
  assert.equal(r.length, 2);
  assert.deepEqual(Object.keys(r[0]).sort(), ['id', 'image', 'lang', 'name', 'number', 'set', 'variant']);
  assert.equal(r[0].image, '');
  assert.equal(r[1].target, 12.35);
}));
