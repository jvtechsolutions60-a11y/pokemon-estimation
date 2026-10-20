// Account sync between two devices, against an in-memory copy of the server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSite, openSite } from './helpers.mjs';
import { tcgdex } from './fixtures.mjs';

let site;
before(async () => { site = await startSite(); });
after(() => site.close());

// Same rules as worker/src: optimistic locking on `version`.
function fakeServer() {
  const vaults = new Map();
  const server = { offline: false, puts: 0 };
  server.route = async (route) => {
    const req = route.request();
    if (server.offline) return route.abort('internetdisconnected');
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const id = new URL(req.url()).pathname.split('/').pop();
    const row = vaults.get(id);
    if (req.method() === 'GET') return route.fulfill(row ? { json: row, headers: cors } : { status: 404, json: {}, headers: cors });
    if (req.method() === 'PUT') {
      const { iv, data, version } = req.postDataJSON();
      if (data.length > 700000) return route.fulfill({ status: 400, json: {}, headers: cors });
      if ((row ? row.version : 0) !== version) return route.fulfill({ status: 409, json: {}, headers: cors });
      vaults.set(id, { iv, data, version: version + 1 });
      server.puts += 1;
      return route.fulfill({ json: { version: version + 1 }, headers: cors });
    }
    return route.fulfill({ status: 405, json: {}, headers: cors });
  };
  return server;
}

async function device(server) {
  const api = tcgdex();
  const dev = await openSite(site, (route) => (new URL(route.request().url()).host.endsWith('.workers.dev') ? server.route(route) : api.handler(route)));
  dev.page.on('dialog', (d) => d.accept());
  return dev;
}

const card = (id, qty = 1) => ({ id, name: id, set: 'Test', number: '1/1', qty, marketPrice: 1 });
const add = (page, id, qty) => page.evaluate((c) => { collection.push(sanitizeCollection([c])[0]); saveCollection(); renderCollection(); }, card(id, qty));
const ids = (page) => page.evaluate(() => collection.map((i) => `${i.id}×${i.qty}`).sort().join(' '));
// Waits for the debounced save to reach the server.
async function saved(page) {
  await page.waitForFunction(() => document.getElementById('accState').textContent === 'Synchronisé' || document.getElementById('accMsg').textContent, null, { timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.waitForFunction(() => document.getElementById('accState').textContent !== 'Enregistrement…', null, { timeout: 15000 });
}

test('synchronisation : rien n’est perdu hors ligne ni entre deux appareils', async () => {
  const server = fakeServer();
  const a = await device(server);
  const b = await device(server);
  try {
    await add(a.page, 'x-1');
    const code = await a.page.evaluate(async () => { const c = Sync.generateCode(); await Sync.create(c, collection); return c; });
    await b.page.evaluate((c) => Sync.login(c), code);
    assert.equal(await ids(b.page), 'x-1×1');

    // A works offline, then opens the site again once back online.
    server.offline = true;
    await add(a.page, 'x-2');
    await a.page.waitForFunction(() => document.getElementById('accState').textContent === 'Erreur', null, { timeout: 15000 });
    server.offline = false;
    await a.page.reload();
    await saved(a.page);
    assert.equal(await ids(a.page), 'x-1×1 x-2×1', 'carte ajoutée hors ligne perdue');

    // B, not refreshed, changes the same card and adds another: conflict on the server.
    await b.page.evaluate(() => { collection[0].qty = 3; saveCollection(); });
    await add(b.page, 'x-3');
    await saved(b.page);
    assert.equal(await ids(b.page), 'x-1×3 x-2×1 x-3×1');

    // A removes a card B did not touch; both end up with the same collection.
    await a.page.reload();
    await saved(a.page);
    await a.page.evaluate(() => { collection = collection.filter((i) => i.id !== 'x-2'); saveCollection(); });
    await saved(a.page);
    await b.page.reload();
    await saved(b.page);
    assert.equal(await ids(a.page), 'x-1×3 x-3×1');
    assert.equal(await ids(b.page), 'x-1×3 x-3×1');
    assert.deepEqual([...a.errors, ...b.errors], []);
  } finally {
    await a.browser.close();
    await b.browser.close();
  }
});

test('fusion : chaque côté garde ses changements', async () => {
  const { browser, page } = await openSite(site, tcgdex().handler);
  try {
    const r = await page.evaluate(() => {
      const c = (id, qty, extra = {}) => ({ id, name: id, set: 'S', number: '1', qty, ...extra });
      const run = (base, local, remote) => mergeCollections(base, local, remote).map((i) => `${i.id}×${i.qty}${i.manualPrice !== undefined ? `@${i.manualPrice}` : ''}`).join(' ');
      return {
        qty: run([c('a', 2)], [c('a', 3)], [c('a', 4)]),
        deletedHereChangedThere: run([c('a', 1)], [], [c('a', 2)]),
        deletedThere: run([c('a', 1), c('b', 1)], [c('a', 1), c('b', 1)], [c('b', 1)]),
        noBase: run([], [c('a', 1)], [c('b', 1), c('a', 2)]),
        manual: run([c('a', 1)], [c('a', 1, { manualPrice: 5 })], [c('a', 2)]),
        newerPrice: mergeCollections([c('a', 1)], [c('a', 2, { marketPrice: 1, marketDate: '2026-10-01' })], [c('a', 1, { marketPrice: 3, marketDate: '2026-10-10' })])[0].marketPrice,
      };
    });
    assert.deepEqual(r, { qty: 'a×5', deletedHereChangedThere: 'a×2', deletedThere: 'b×1', noBase: 'b×1 a×2', manual: 'a×2@5', newerPrice: 3 });
  } finally {
    await browser.close();
  }
});

test('grosse collection : compressée pour tenir sur le compte', async () => {
  const server = fakeServer();
  const a = await device(server);
  const b = await device(server);
  try {
    const code = await a.page.evaluate(async () => {
      collection = sanitizeCollection(Array.from({ length: 4000 }, (_, i) => ({ id: `big-${i}`, name: `Carte numéro ${i}`, set: 'Extension de test', number: `${i}/4000`, image: `https://assets.tcgdex.net/fr/swsh/swsh1/${i}/low.webp`, qty: 1, marketPrice: 1.5, marketDate: '2026-10-18T00:00:00.000Z' })));
      saveCollection();
      const c = Sync.generateCode();
      await Sync.create(c, collection);
      return c;
    });
    await b.page.evaluate((c) => Sync.login(c), code);
    assert.equal(await b.page.evaluate(() => collection.length), 4000);
  } finally {
    await a.browser.close();
    await b.browser.close();
  }
});

test('sauvegarde sur fichier : restaurer ajoute sans rien supprimer', async () => {
  const { browser, page, errors } = await openSite(site, tcgdex().handler);
  page.on('dialog', (d) => d.accept());
  try {
    await add(page, 'keep', 1);
    const file = { kind: 'cotecartes-sauvegarde', version: 1, saved: '2026-10-19T10:00:00Z', collection: [card('keep', 2), card('new', 1)], history: [{ d: '2026-10-01', v: 3, n: 3 }] };
    await page.setInputFiles('#backupFile', { name: 's.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await page.waitForFunction(() => document.getElementById('backupMsg').textContent);
    assert.equal(await ids(page), 'keep×2 new×1');
    assert.match(await page.textContent('#backupMsg'), /1 nouvelle carte/);
    await page.setInputFiles('#backupFile', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
    await page.waitForFunction(() => /pas une sauvegarde/.test(document.getElementById('backupMsg').textContent));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('souhaits synchronisés sans perte, comme la collection', async () => {
  const server = fakeServer();
  const a = await device(server);
  const b = await device(server);
  const wish = (page, id) => page.evaluate((w) => { wishlist.push(sanitizeWishlist([w])[0]); saveWishlist(); }, { id, name: id, set: 'S', number: '1/1' });
  const wishes = (page) => page.evaluate(() => wishlist.map((w) => w.id).sort().join(' '));
  try {
    await wish(a.page, 'w-1');
    const code = await a.page.evaluate(async () => { const c = Sync.generateCode(); await Sync.create(c, collection); return c; });
    await b.page.evaluate((c) => Sync.login(c), code);
    assert.equal(await wishes(b.page), 'w-1');

    server.offline = true;
    await wish(a.page, 'w-2');
    await a.page.waitForFunction(() => document.getElementById('accState').textContent === 'Erreur', null, { timeout: 15000 });
    server.offline = false;
    await a.page.reload();
    await saved(a.page);
    assert.equal(await wishes(a.page), 'w-1 w-2', 'souhait ajouté hors ligne perdu');

    await b.page.evaluate(() => { wishlist = wishlist.filter((w) => w.id !== 'w-1'); saveWishlist(); });
    await saved(b.page);
    await a.page.reload();
    await saved(a.page);
    assert.equal(await wishes(a.page), 'w-2');
  } finally {
    await a.browser.close();
    await b.browser.close();
  }
});
