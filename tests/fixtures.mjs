// A few real TCGdex entries (from tcgdex/cards-database), trimmed to what the app reads.
export const sets = [
  { id: 'ecard2', name: 'Aquapolis', cardCount: { official: 147, total: 186 } },
  { id: 'pl3', name: 'Vainqueurs Suprêmes', cardCount: { official: 147, total: 153 } },
  { id: 'sm3', name: 'Ombres Ardentes', cardCount: { official: 147, total: 177 } },
  { id: 'cel25cc', name: 'Célébrations Collection Classique', cardCount: { official: 25, total: 25 } },
];

const card = (id, localId, name, setIndex, pricing) => {
  const set = sets[setIndex];
  return { id, localId, name, image: `https://assets.tcgdex.net/fr/x/${set.id}/${localId}`, variants: { holo: true }, set: { id: set.id, name: set.name, cardCount: { official: set.cardCount.official } }, pricing };
};

export const cards = {
  'ecard2-145': card('ecard2-145', '145', 'Énergie super', 0),
  'pl3-145': { ...card('pl3-145', '145', 'Carchacrok C NIV.X', 1, { cardmarket: { idProduct: 278836, updated: '2026-10-17T00:00:00Z', avg7: 20, trend: 18 } }), rarity: 'Holo Rare NIV.X', illustrator: 'Shizurow' },
  'sm3-145': card('sm3-145', '145', 'Apocyne', 2),
  'cel25cc-CC018': { ...card('cel25cc-CC018', 'CC018', 'Carchacrok C NIV.X', 3, { cardmarket: { idProduct: 576788, updated: '2026-10-18T00:00:00Z', avg7: 7.2, trend: 6.45, 'avg7-holo': 9 } }), rarity: 'Collection Classique', illustrator: 'Shizurow' },
};

export const englishNames = { 'pl3-145': 'Garchomp C LV.X', 'cel25cc-CC018': 'Garchomp C LV.X' };

const setCards = { ecard2: ['ecard2-145'], pl3: ['pl3-145'], sm3: ['sm3-145'], cel25cc: ['cel25cc-CC018'] };

// Route handler for api.tcgdex.net. `failures` maps a path to how many times it answers 503 first.
export function tcgdex(failures = {}) {
  const left = { ...failures };
  const calls = [];
  const handler = async (route) => {
    const url = new URL(route.request().url());
    const headers = { 'access-control-allow-origin': '*' };
    if (url.host !== 'api.tcgdex.net') return route.fulfill({ status: 404, body: '' });
    const p = decodeURIComponent(url.pathname);
    calls.push(p);
    if (left[p] > 0) { left[p] -= 1; return route.fulfill({ status: 503, body: '', headers }); }
    if (p === '/v2/fr/sets') return route.fulfill({ json: sets, headers });
    let m = p.match(/^\/v2\/fr\/sets\/(.+)$/);
    if (m && setCards[m[1]]) return route.fulfill({ json: { id: m[1], cards: setCards[m[1]].map((id) => ({ id, localId: cards[id].localId, name: cards[id].name })) }, headers });
    m = p.match(/^\/v2\/fr\/cards\/(.+)$/);
    if (m && cards[m[1]]) return route.fulfill({ json: cards[m[1]], headers });
    m = p.match(/^\/v2\/en\/cards\/(.+)$/);
    if (m && englishNames[m[1]]) return route.fulfill({ json: { id: m[1], name: englishNames[m[1]] }, headers });
    return route.fulfill({ status: 404, body: '{}', headers });
  };
  return { handler, calls };
}
