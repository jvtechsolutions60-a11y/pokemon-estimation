'use strict';

const API = 'https://api.tcgdex.net/v2';
const STORE_KEY = 'pokemon-estimation:collection';
const SETS_CACHE_KEY = 'pokemon-estimation:sets:';
const SETS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CANDIDATE_SETS = 10;

// Indicative discount per Cardmarket condition.
const CONDITIONS = {
  MT: { label: 'Mint', factor: 1 },
  NM: { label: 'Near Mint', factor: 1 },
  EX: { label: 'Excellent', factor: 0.8 },
  GD: { label: 'Good', factor: 0.65 },
  LP: { label: 'Light Played', factor: 0.5 },
  PL: { label: 'Played', factor: 0.35 },
  PO: { label: 'Poor', factor: 0.2 },
};

const VARIANTS = {
  normal: 'Normale',
  holo: 'Holo',
  reverse: 'Reverse',
};

// Which Cardmarket figure marketPrice() used, for the label under the price.
const PRICE_KEY_LABELS = {
  avg7: 'Moyenne des ventes 7 j', trend: 'Tendance Cardmarket', avg30: 'Moyenne des ventes 30 j', avg: 'Prix moyen Cardmarket',
};

const $ = (id) => document.getElementById(id);
const euro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

// Card data comes from a third-party API (and synced vaults), so only image
// URLs on the TCGdex asset host ever reach the page's HTML.
const IMAGE_RE = /^https:\/\/assets\.tcgdex\.net\/[\w./-]+$/;
function safeImage(url) {
  return typeof url === 'string' && IMAGE_RE.test(url) ? url : '';
}

function errorLine(message) {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = `Erreur : ${message}`;
  return p;
}

// ---------- Storage ----------

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

let collection = [];
// Keeps only well-formed entries with the expected types, whatever the source
// (this device, an old version of the app or a synced vault).
function sanitizeCollection(list) {
  if (!Array.isArray(list)) return [];
  const str = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  return list.filter((i) => i && typeof i === 'object' && typeof i.id === 'string').map((i) => {
    const item = {
      id: str(i.id),
      lang: /^[a-z]{2}$/.test(i.lang) ? i.lang : 'fr',
      name: str(i.name),
      set: str(i.set),
      number: str(String(i.number ?? '')),
      image: safeImage(i.image),
      variant: Object.hasOwn(VARIANTS, i.variant) ? i.variant : 'normal',
      condition: Object.hasOwn(CONDITIONS, i.condition) ? i.condition : 'NM',
      qty: Math.min(9999, Math.max(1, parseInt(i.qty, 10) || 1)),
    };
    const market = num(i.marketPrice);
    if (market !== undefined) item.marketPrice = market;
    if (Object.hasOwn(PRICE_KEY_LABELS, i.marketKey)) item.marketKey = i.marketKey;
    // Older entries kept the Cardmarket date in priceDate.
    const date = str(i.marketDate || (typeof i.manualPrice !== 'number' ? i.priceDate : ''));
    if (date && !Number.isNaN(Date.parse(date))) item.marketDate = date;
    const manual = num(i.manualPrice);
    if (manual !== undefined) {
      item.manualPrice = manual;
      if (i.priceSource) item.priceSource = str(i.priceSource);
    }
    return item;
  });
}

try { collection = sanitizeCollection(JSON.parse(safeGet(STORE_KEY))); } catch { collection = []; }

function saveCollection({ fromServer = false } = {}) {
  safeSet(STORE_KEY, JSON.stringify(collection));
  if (!fromServer) Sync.changed(collection);
}

// ---------- API ----------

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.json();
}

async function getSets(lang) {
  const cached = safeGet(SETS_CACHE_KEY + lang);
  if (cached) {
    try {
      const { at, sets } = JSON.parse(cached);
      if (Date.now() - at < SETS_TTL_MS) return sets;
    } catch { /* ignore broken cache */ }
  }
  const sets = await getJSON(`${API}/${lang}/sets`);
  safeSet(SETS_CACHE_KEY + lang, JSON.stringify({ at: Date.now(), sets }));
  return sets;
}

async function getCard(lang, id) {
  return getJSON(`${API}/${lang}/cards/${encodeURIComponent(id)}`);
}

// Finds every card numbered `num` in a set whose size is `total`.
async function findByNumber(lang, num, total) {
  const sets = await getSets(lang);
  let candidates = sets.filter((s) => s.cardCount && s.cardCount.official === total);
  if (!candidates.length) candidates = sets.filter((s) => s.cardCount && s.cardCount.total === total);
  candidates = candidates.slice(-MAX_CANDIDATE_SETS).reverse();

  const found = await Promise.all(candidates.map(async (set) => {
    try {
      const full = await getJSON(`${API}/${lang}/sets/${encodeURIComponent(set.id)}`);
      const brief = (full.cards || []).find((c) => parseInt(c.localId, 10) === num);
      return brief ? getCard(lang, brief.id) : null;
    } catch {
      return null;
    }
  }));

  // "Classic Collection" reprints (Celebrations, 30th Celebration) keep the
  // printed number of the original card (Dracaufeu 4/102) but TCGdex numbers
  // them 001…030 inside their own small set, so match them by name instead.
  const names = new Set(found.filter(Boolean).map((c) => c.name));
  let reprints = [];
  if (names.size) {
    const classicSets = sets.filter((s) => /classi/i.test(s.name)).reverse();
    reprints = (await Promise.all(classicSets.map(async (set) => {
      try {
        const full = await getJSON(`${API}/${lang}/sets/${encodeURIComponent(set.id)}`);
        return Promise.all((full.cards || [])
          .filter((c) => names.has(c.name))
          .map((c) => getCard(lang, c.id).catch(() => null)));
      } catch {
        return [];
      }
    }))).flat();
  }

  const printed = `${num}/${total}`;
  const seen = new Set();
  return [...reprints, ...found]
    .filter((c) => c && !seen.has(c.id) && seen.add(c.id))
    .map((c) => ({ ...c, printed }));
}

async function findByName(lang, name) {
  const list = await getJSON(`${API}/${lang}/cards?name=${encodeURIComponent(name)}`);
  return list.slice(0, 24);
}

// Number as printed on the card: reprints found by number keep the one read on
// the photo, since TCGdex renumbers them inside their own set.
function displayNumber(card) {
  if (card.printed) return card.printed;
  return `${card.localId}/${card.set.cardCount.official}`;
}

// ---------- Pricing ----------

function marketPriceKey(card, variant) {
  const cm = card && card.pricing && card.pricing.cardmarket;
  if (!cm) return null;
  const order = variant === 'reverse'
    ? ['avg7-holo', 'trend-holo', 'avg30-holo', 'avg-holo', 'avg7', 'trend', 'avg30', 'avg']
    : ['avg7', 'trend', 'avg30', 'avg', 'avg7-holo', 'trend-holo', 'avg30-holo'];
  return order.find((k) => typeof cm[k] === 'number' && cm[k] > 0) || null;
}

function marketPrice(card, variant) {
  const cm = card && card.pricing && card.pricing.cardmarket;
  if (!cm) return null;
  // Cardmarket has one product per card: its main price covers the normal or
  // holo print, and the "-holo" fields are the reverse holo (foil) version.
  const reverse = variant === 'reverse';
  const pick = (...keys) => {
    for (const k of keys) if (typeof cm[k] === 'number' && cm[k] > 0) return cm[k];
    return null;
  };
  // The 7-day average of real sales follows the market better than Cardmarket's
  // "trend", which lags a lot on new cards whose price moves fast.
  return reverse
    ? pick('avg7-holo', 'trend-holo', 'avg30-holo', 'avg-holo', 'avg7', 'trend', 'avg30', 'avg')
    : pick('avg7', 'trend', 'avg30', 'avg', 'avg7-holo', 'trend-holo', 'avg30-holo');
}

// "Tendance 31,88 € · 7 j 37,27 € · 30 j 48,65 €" for the chosen print.
function priceDetails(card, variant) {
  const cm = card && card.pricing && card.pricing.cardmarket;
  if (!cm) return '';
  const sfx = variant === 'reverse' ? '-holo' : '';
  const parts = [['Tendance', 'trend'], ['7 j', 'avg7'], ['30 j', 'avg30']]
    .filter(([, k]) => typeof cm[k + sfx] === 'number' && cm[k + sfx] > 0)
    .map(([label, k]) => `${label} ${euro.format(cm[k + sfx])}`);
  return parts.join(' · ');
}

function defaultVariant(card) {
  const v = card.variants || {};
  if (v.normal) return 'normal';
  if (v.holo) return 'holo';
  if (v.reverse) return 'reverse';
  return 'normal';
}

// TCGdex answers through several caches, so two refreshes in a row can return
// different snapshots. Only take a price that is newer than the one we have,
// so the value stays put until Cardmarket really publishes a new one.
function applyMarket(item, card, { force = false } = {}) {
  const cm = card && card.pricing && card.pricing.cardmarket;
  const updated = cm && cm.updated ? Date.parse(cm.updated) : NaN;
  const known = item.marketDate ? Date.parse(item.marketDate) : NaN;
  if (!force && Number.isFinite(known) && !(updated > known)) return false;
  if (!force && !Number.isFinite(updated) && typeof item.marketPrice === 'number') return false;
  const price = marketPrice(card, item.variant);
  if (price === null && !force) return false;
  item.marketPrice = price;
  item.marketDate = cm && cm.updated ? cm.updated : null;
  const key = marketPriceKey(card, item.variant);
  if (key) item.marketKey = key.replace('-holo', ''); else delete item.marketKey;
  return true;
}

function priceSourceLabel(item) {
  if (typeof item.manualPrice === 'number') return item.priceSource || 'Prix saisi à la main';
  if (typeof item.marketPrice !== 'number') return 'Pas de prix';
  const day = item.marketDate ? ` au ${new Date(item.marketDate).toLocaleDateString('fr-FR')}` : '';
  return `${PRICE_KEY_LABELS[item.marketKey] || 'Prix Cardmarket'}${day}`;
}

function unitPrice(item) {
  if (typeof item.manualPrice === 'number') return item.manualPrice;
  if (typeof item.marketPrice !== 'number') return 0;
  return item.marketPrice * CONDITIONS[item.condition].factor;
}

// ---------- OCR ----------

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await Tesseract.createWorker('eng');
      // Sparse text mode: the band holds scattered bits of text.
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      return worker;
    })();
  }
  return workerPromise;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// Crops a horizontal band of the photo, upscales it and keeps only the pixels
// darker than `threshold` (or brighter, when `invert`), which removes the holo
// sparkle that otherwise drowns the small card number.
function prepareBand(img, fromY, toY, threshold, invert) {
  const canvas = $('cropCanvas');
  const sy = Math.floor(img.naturalHeight * fromY);
  const sh = Math.floor(img.naturalHeight * (toY - fromY));
  const scale = Math.min(3, 2400 / img.naturalWidth);
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, sy, img.naturalWidth, sh, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = pixels.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
    const ink = invert ? lum > threshold : lum < threshold;
    d[i] = d[i + 1] = d[i + 2] = ink ? 0 : 255;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

// Returns the most plausible "num/total" read in the text.
function parseNumber(text) {
  const matches = [...text.matchAll(/(?<![\d,.])(\d{1,3})\s*\/\s*(\d{2,3})(?!\d)/g)]
    .map((m) => ({ num: parseInt(m[1], 10), total: parseInt(m[2], 10) }))
    .filter((m) => m.num > 0 && m.total >= 10 && m.num <= m.total * 2);
  return matches[0] || null;
}

// Each pass: [band start, band end, threshold, light text on dark background].
const OCR_PASSES = [
  [0.8, 1, 60, false],
  [0.8, 1, 90, false],
  [0.65, 1, 60, false],
  [0.8, 1, 200, true],
  [0.65, 1, 120, false],
];

async function readCardNumber(img) {
  const worker = await getWorker();
  // The number sits at the bottom left on recent cards, bottom right on older ones.
  for (const [from, to, threshold, invert] of OCR_PASSES) {
    const band = prepareBand(img, from, to, threshold, invert);
    const { data } = await worker.recognize(band);
    const hit = parseNumber(data.text);
    if (hit) return hit;
  }
  return null;
}

// Words printed on every Pokémon card, used to guess the card's language.
const LANGUAGE_WORDS = {
  fr: ['faiblesse', 'resistance', 'retraite', 'pouvoir', 'talent', 'niveau', 'evolution de', 'degats'],
  en: ['weakness', 'resistance', 'retreat', 'ability', 'evolves from', 'stage', 'damage'],
  de: ['schwache', 'resistenz', 'ruckzug', 'entwickelt sich', 'phase', 'schaden', 'fahigkeit'],
  it: ['debolezza', 'resistenza', 'ritirata', 'abilita', 'si evolve da', 'fase', 'danni'],
  es: ['debilidad', 'resistencia', 'retirada', 'habilidad', 'evoluciona de', 'fase', 'dano'],
  pt: ['fraqueza', 'resistencia', 'recuo', 'habilidade', 'evolui de', 'estagio', 'dano'],
};

// Lowercase, without accents, so OCR output can be compared loosely.
function fold(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function detectLanguage(text) {
  const t = fold(text);
  let best = null;
  let bestScore = 0;
  for (const [code, words] of Object.entries(LANGUAGE_WORDS)) {
    const score = words.filter((w) => t.includes(w)).length;
    if (score > bestScore) { best = code; bestScore = score; }
  }
  return bestScore >= 2 ? best : null;
}

// Reads the name (top of the card) and the rules text (middle and bottom).
async function readCardText(img) {
  const worker = await getWorker();
  const read = async (from, to) => (await worker.recognize(prepareBand(img, from, to, 90, false))).data.text;
  const top = await read(0.03, 0.22);
  const body = await read(0.5, 0.95);
  return { top, all: `${top}\n${body}` };
}

// Puts first the cards whose name appears in the text read at the top of the photo.
// Whether the card's name shows up in the text read at the top of the photo.
// OCR often mangles symbols and suffixes ("C NIV.X", "ex", "V"), so one long
// enough word of the name is enough.
function nameOnPhoto(card, topText) {
  const t = fold(topText).replace(/[^a-z0-9]/g, '');
  if (!t) return false;
  const full = fold(card.name).replace(/[^a-z0-9]/g, '');
  if (full.length >= 3 && t.includes(full)) return true;
  return fold(card.name).split(/[^a-z0-9]+/).some((w) => w.length >= 5 && t.includes(w));
}

// Cards whose name is on the photo come first; the others are returned apart.
function rankByName(cards, topText) {
  const hits = cards.filter((c) => nameOnPhoto(c, topText));
  if (!hits.length) return { cards, others: [] };
  return { cards: hits, others: cards.filter((c) => !hits.includes(c)) };
}

// ---------- Visual match ----------
//
// Several prints can share a number (Base Set and the 30th anniversary reprint
// of Dracaufeu 4/102): they differ by a stamp or a holo pattern, not by text.
// We find the card in the photo, then compare it pixel by pixel with each
// candidate's official image.

const REF_W = 50;
const REF_H = 70;
const CMP_W = 100;
const CMP_H = 140;

function loadRemoteImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // needed to read the pixels back
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// RGB values of a region of `source`, resized to w×h.
function samplePixels(source, sx, sy, sw, sh, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    out[j] = d[i]; out[j + 1] = d[i + 1]; out[j + 2] = d[i + 2];
  }
  return out;
}

function toGray(rgb) {
  const g = new Float32Array(rgb.length / 3);
  for (let i = 0; i < g.length; i++) g[i] = (rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3;
  return g;
}

// Zero-mean, unit-variance copy, so lighting differences don't matter.
function standardize(values, stride = 1) {
  const out = new Float32Array(values.length);
  for (let c = 0; c < stride; c++) {
    let sum = 0;
    let sq = 0;
    let n = 0;
    for (let i = c; i < values.length; i += stride) { sum += values[i]; sq += values[i] * values[i]; n++; }
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(sq / n - mean * mean, 1e-6));
    for (let i = c; i < values.length; i += stride) out[i] = (values[i] - mean) / sd;
  }
  return out;
}

// Slides the reference over the photo at several sizes and returns the box
// (in photo pixels) where it correlates best.
function locateCard(photo, ref) {
  const refZ = standardize(toGray(samplePixels(ref, 0, 0, ref.naturalWidth, ref.naturalHeight, REF_W, REF_H)));
  let best = { score: -Infinity };
  for (let frac = 0.55; frac <= 1.001; frac += 0.05) {
    // Photo resized so that a card filling `frac` of its height is REF_H tall.
    const ph = Math.round(REF_H / frac);
    const pw = Math.round(photo.naturalWidth * ph / photo.naturalHeight);
    if (pw < REF_W) continue;
    const gray = toGray(samplePixels(photo, 0, 0, photo.naturalWidth, photo.naturalHeight, pw, ph));
    for (let y = 0; y + REF_H <= ph; y++) {
      for (let x = 0; x + REF_W <= pw; x++) {
        let sum = 0;
        let sq = 0;
        let dot = 0;
        for (let r = 0; r < REF_H; r++) {
          const row = (y + r) * pw + x;
          const refRow = r * REF_W;
          for (let c = 0; c < REF_W; c++) {
            const v = gray[row + c];
            sum += v; sq += v * v; dot += v * refZ[refRow + c];
          }
        }
        const n = REF_W * REF_H;
        const sd = Math.sqrt(Math.max(sq / n - (sum / n) ** 2, 1e-6));
        const score = dot / (n * sd); // refZ has zero mean, so this is the correlation
        if (score > best.score) {
          const k = photo.naturalHeight / ph;
          best = { score, x: x * k, y: y * k, w: REF_W * k, h: REF_H * k };
        }
      }
    }
  }
  return best;
}

// Mean colour difference between the card found in the photo and a reference.
function visualDistance(photoZ, ref) {
  const refZ = standardize(samplePixels(ref, 0, 0, ref.naturalWidth, ref.naturalHeight, CMP_W, CMP_H), 3);
  let diff = 0;
  for (let i = 0; i < refZ.length; i++) diff += Math.abs(refZ[i] - photoZ[i]);
  return diff / refZ.length;
}

// Sorts cards by how close their official image is to the photo. Returns the
// cards unchanged when images can't be compared (no image, or no CORS).
async function rankByImage(cards, photo) {
  const withImage = cards.filter((c) => c.image).slice(0, 8);
  if (withImage.length < 2) return { cards, best: null };
  const refs = await Promise.all(withImage.map((c) => loadRemoteImage(`${c.image}/low.webp`).catch(() => null)));
  try {
    const first = refs.find(Boolean);
    if (!first) return { cards, best: null };
    const box = locateCard(photo, first);
    const photoZ = standardize(samplePixels(photo, box.x, box.y, box.w, box.h, CMP_W, CMP_H), 3);
    const scored = withImage.map((card, i) => ({ card, d: refs[i] ? visualDistance(photoZ, refs[i]) : Infinity }));
    scored.sort((a, b) => a.d - b.d);
    const ranked = scored.map((x) => x.card);
    const rest = cards.filter((c) => !ranked.includes(c));
    // Only claim a match when it clearly beats the runner-up.
    const clear = scored.length > 1 && scored[1].d - scored[0].d > 0.02;
    return { cards: [...ranked, ...rest], best: clear ? scored[0].card.id : null };
  } catch {
    return { cards, best: null }; // tainted canvas or decoding error
  }
}

// ---------- UI: search ----------

function setStatus(msg) {
  $('ocrStatus').textContent = msg;
}

function lang() {
  return $('lang').value;
}

// Cardmarket language ids, used to open the listing filtered on the card's language.
const CARDMARKET_LANG = { en: 1, fr: 2, de: 3, es: 4, it: 5, pt: 8 };

function cardmarketUrl(card) {
  const q = new URLSearchParams({ searchString: card.name, language: CARDMARKET_LANG[lang()] || 2 });
  return `https://www.cardmarket.com/fr/Pokemon/Products/Search?${q}`;
}

function renderResults(cards, bestId = null, byNumber = false, others = []) {
  const box = $('results');
  box.innerHTML = '';
  if (!cards.length) {
    box.innerHTML = '<p class="muted">Aucune carte trouvée. Corrige le numéro ou cherche par nom.</p>';
    return;
  }
  if (byNumber && cards.length > 1 && !bestId) {
    const hint = document.createElement('p');
    hint.className = 'muted hint';
    hint.textContent = 'Plusieurs éditions portent ce numéro : compare le symbole d\u2019extension et les tampons '
      + '(Pikachu « 25 » ou « 30 » pour les rééditions anniversaire) et choisis la tienne.';
    box.appendChild(hint);
  }
  for (const card of cards) {
    const el = resultCard(card);
    if (card.id === bestId) {
      el.classList.add('best');
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = '✓ Correspond à ta photo';
      el.prepend(badge);
    }
    box.appendChild(el);
  }
  // Same number but another name than the one read on the photo: kept out of the way.
  if (others.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'secondary more-results';
    more.textContent = `Voir ${others.length} autre${others.length > 1 ? 's' : ''} carte${others.length > 1 ? 's' : ''} avec ce numéro`;
    more.addEventListener('click', () => {
      more.remove();
      for (const card of others) box.appendChild(resultCard(card));
    });
    box.appendChild(more);
  }
}

function resultCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  const img = card.image ? safeImage(`${card.image}/low.webp`) : '';
  const setName = card.set ? card.set.name : '';
  el.innerHTML = `
    ${img ? `<img loading="lazy" src="${img}" alt="">` : ''}
    <div class="title"></div>
    <div class="muted small"></div>
    <select class="variant"></select>
    <div class="price"></div>
    <div class="details muted small"></div>
    <a class="cm small" target="_blank" rel="noopener">Voir sur Cardmarket</a>
    <button type="button">Ajouter</button>`;
  el.querySelector('.title').textContent = card.name;
  el.querySelector('.cm').href = cardmarketUrl(card);
  el.querySelector('.muted').textContent = card.set && card.set.cardCount ? `${setName} · ${displayNumber(card)}` : `n° ${card.localId}`;

  const select = el.querySelector('.variant');
  for (const [k, label] of Object.entries(VARIANTS)) {
    const opt = new Option(label, k);
    select.appendChild(opt);
  }
  const priceEl = el.querySelector('.price');
  const button = el.querySelector('button');

  // List results only carry id/name/image: load details on demand.
  let full = card.pricing !== undefined ? card : null;
  const refresh = () => {
    const p = full ? marketPrice(full, select.value) : null;
    priceEl.textContent = full ? (p === null ? 'Prix inconnu' : `≈ ${euro.format(p)}`) : '…';
    el.querySelector('.details').textContent = full ? priceDetails(full, select.value) : '';
  };
  const ensureFull = async () => {
    if (!full) {
      full = await getCard(lang(), card.id);
      el.querySelector('.muted').textContent = `${full.set.name} · ${displayNumber(full)}`;
      select.value = defaultVariant(full);
    }
    refresh();
  };
  if (full) select.value = defaultVariant(full);
  select.addEventListener('change', refresh);
  ensureFull().catch(() => { priceEl.textContent = 'Erreur de chargement'; });

  button.addEventListener('click', async () => {
    await ensureFull();
    addToCollection(full, select.value);
    button.textContent = 'Ajoutée ✓';
    button.classList.add('added');
    toast(`${full.name} ajoutée à ta collection`, { label: 'Voir', href: '#collection' });
  });
  return el;
}

async function searchNumber(num, total, topText = '', photo = null) {
  $('results').innerHTML = '<p class="muted">Recherche…</p>';
  try {
    const ranked = rankByName(await findByNumber(lang(), num, total), topText);
    let { cards } = ranked;
    let best = null;
    if (photo && cards.length > 1) {
      $('results').innerHTML = '<p class="muted">Comparaison avec les images officielles…</p>';
      ({ cards, best } = await rankByImage(cards, photo));
    }
    renderResults(cards, best, true, ranked.others);
  } catch (e) {
    $('results').replaceChildren(errorLine(e.message));
  }
}

async function searchName(name) {
  $('results').innerHTML = '<p class="muted">Recherche…</p>';
  try {
    renderResults(await findByName(lang(), name));
  } catch (e) {
    $('results').replaceChildren(errorLine(e.message));
  }
}

const LANG_NAMES = { fr: 'français', en: 'anglais', de: 'allemand', it: 'italien', es: 'espagnol', pt: 'portugais' };

// Reads one photo: number, language, the matching cards and, when it is clear,
// which of them is on the photo. `sure` means it can be added without asking.
async function identifyPhoto(img, onStep = () => {}) {
  const hit = await readCardNumber(img);
  const text = await readCardText(img).catch(() => ({ top: '', all: '' }));
  const detected = detectLanguage(text.all);
  if (detected) $('lang').value = detected;
  if (!hit) return { hit, detected, cards: [], best: null, sure: false };
  onStep(hit, detected);
  const ranked = rankByName(await findByNumber(lang(), hit.num, hit.total), text.top);
  let { cards } = ranked;
  let best = null;
  if (cards.length > 1) ({ cards, best } = await rankByImage(cards, img));
  const sure = cards.length === 1 || Boolean(best);
  return { hit, detected, cards, others: ranked.others, best, sure, pick: sure ? (best ? cards.find((c) => c.id === best) : cards[0]) : null };
}

async function scanOne(file) {
  const img = await loadImage(file);
  $('previewImg').src = img.src;
  $('preview').hidden = false;
  setStatus('Lecture de la carte…');
  $('results').innerHTML = '';
  try {
    const res = await identifyPhoto(img, (hit, detected) => {
      $('num').value = hit.num;
      $('total').value = hit.total;
      const langLabel = detected ? ` · langue détectée : ${LANG_NAMES[detected] || detected}` : '';
      setStatus(`Numéro lu : ${hit.num}/${hit.total}${langLabel}. Corrige si besoin.`);
      $('results').innerHTML = '<p class="muted">Recherche et comparaison avec les images officielles…</p>';
    });
    if (!res.hit) {
      const langLabel = res.detected ? ` · langue détectée : ${LANG_NAMES[res.detected] || res.detected}` : '';
      setStatus(`Numéro illisible${langLabel}. Saisis-le ci-dessous (ex. 4 / 102) ou cherche par nom.`);
      $('manualBox').open = true;
      return;
    }
    renderResults(res.cards, res.best, true, res.others);
  } catch (e) {
    setStatus(`Lecture impossible (${e.message}). Saisis le numéro à la main.`);
    $('results').innerHTML = '';
  }
}

// ---------- Burst mode ----------
//
// Several photos in a row: each card read with certainty is added at once in
// Near Mint; the others wait in the list with their candidates.

let burstQueue = [];
let burstRunning = false;
const burstStats = { added: 0, value: 0, total: 0, done: 0 };

function burstOn() {
  return $('burst').checked;
}

function updateBurstUi() {
  const on = burstOn();
  $('photo').multiple = on;
  // Without "capture" the phone offers the camera and the gallery, needed to pick several photos.
  if (on) $('photo').removeAttribute('capture'); else $('photo').setAttribute('capture', 'environment');
  $('dropTitle').textContent = on ? 'Prendre ou choisir des photos' : 'Prendre ou choisir une photo';
  $('dropHint').textContent = on
    ? 'Plusieurs photos d’un coup possible : chaque carte reconnue est ajoutée en Near Mint'
    : 'Carte bien à plat, numéro du bas lisible';
  $('burstPanel').hidden = !on || !burstStats.total;
  $('preview').hidden = true;
}

function renderBurstSummary() {
  const s = burstStats;
  $('burstSummary').textContent = `${s.done} / ${s.total} photo${s.total > 1 ? 's' : ''} lue${s.total > 1 ? 's' : ''}`
    + ` · ${s.added} carte${s.added > 1 ? 's' : ''} ajoutée${s.added > 1 ? 's' : ''} · ${euro.format(s.value)}`;
  $('burstPanel').hidden = false;
}

function burstRow(img) {
  const row = document.createElement('li');
  row.className = 'burst-row';
  row.innerHTML = '<img alt=""><div class="burst-body"><div class="burst-title">En attente…</div><div class="burst-sub muted small"></div><div class="burst-pick"></div></div>';
  row.querySelector('img').src = img.src;
  $('burstList').prepend(row);
  return row;
}

function addFromBurst(card, row) {
  const variant = defaultVariant(card);
  addToCollection(card, variant, 'NM');
  const price = marketPrice(card, variant) || 0;
  burstStats.added += 1;
  burstStats.value += price;
  row.classList.add('ok');
  row.querySelector('.burst-title').textContent = `✓ ${card.name}`;
  row.querySelector('.burst-sub').textContent = `${card.set ? card.set.name : ''} · ${displayNumber(card)} · ${price ? euro.format(price) : 'prix inconnu'}`;
  row.querySelector('.burst-pick').innerHTML = '';
  renderBurstSummary();
}

async function runBurst() {
  if (burstRunning) return;
  burstRunning = true;
  while (burstQueue.length) {
    const file = burstQueue.shift();
    let row = null;
    try {
      const img = await loadImage(file);
      row = burstRow(img);
      row.querySelector('.burst-title').textContent = 'Lecture…';
      const res = await identifyPhoto(img, (hit) => {
        row.querySelector('.burst-title').textContent = `Numéro ${hit.num}/${hit.total} : recherche…`;
      });
      if (!res.hit) {
        row.classList.add('warn');
        row.querySelector('.burst-title').textContent = 'Numéro illisible';
        row.querySelector('.burst-sub').textContent = 'Reprends la photo de plus près, ou saisis le numéro en mode normal.';
      } else if (!res.cards.length) {
        row.classList.add('warn');
        row.querySelector('.burst-title').textContent = `Aucune carte ${res.hit.num}/${res.hit.total}`;
        row.querySelector('.burst-sub').textContent = 'Vérifie la langue choisie en haut, ou le numéro.';
      } else if (res.sure) {
        addFromBurst(res.pick, row);
      } else {
        row.classList.add('warn');
        row.querySelector('.burst-title').textContent = 'À vérifier : choisis ta carte';
        row.querySelector('.burst-sub').textContent = `${res.cards.length} cartes portent le numéro ${res.hit.num}/${res.hit.total}.`;
        const pick = row.querySelector('.burst-pick');
        for (const card of res.cards.slice(0, 4)) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'secondary';
          b.textContent = `${card.name} · ${card.set ? card.set.name : ''}`;
          b.addEventListener('click', () => { row.classList.remove('warn'); addFromBurst(card, row); });
          pick.appendChild(b);
        }
      }
    } catch (e) {
      if (row) {
        row.classList.add('warn');
        row.querySelector('.burst-title').textContent = 'Lecture impossible';
        row.querySelector('.burst-sub').textContent = e.message;
      }
    }
    burstStats.done += 1;
    renderBurstSummary();
  }
  burstRunning = false;
}

$('photo').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  if (!files.length) return;
  if (!burstOn()) {
    await scanOne(files[0]);
    return;
  }
  burstStats.total += files.length;
  burstQueue.push(...files);
  renderBurstSummary();
  runBurst();
});

$('burst').addEventListener('change', updateBurstUi);
$('burstClear').addEventListener('click', () => {
  $('burstList').innerHTML = '';
  Object.assign(burstStats, { added: 0, value: 0, total: burstQueue.length, done: 0 });
  $('burstPanel').hidden = !burstStats.total;
});

$('manual').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const num = parseInt($('num').value, 10);
  const total = parseInt($('total').value, 10);
  const name = $('name').value.trim();
  if (num && total) searchNumber(num, total);
  else if (name) searchName(name);
  else setStatus('Indique un numéro et un total, ou un nom.');
});

// ---------- UI: browse a set ----------
//
// Tick the cards you own in a set instead of photographing them one by one.
// A ticked card is added in Near Mint; its condition can be changed per card.

let browseCards = [];
let browseSetName = '';
let browseOfficial = 0;

function ownedItem(id) {
  return collection.find((i) => i.id === id && i.lang === lang());
}

async function loadSetList() {
  try {
    const sets = await getSets(lang());
    const select = $('setSelect');
    select.innerHTML = '';
    select.appendChild(new Option('Choisis une extension', ''));
    // Newest first: the API lists sets in release order.
    for (const s of [...sets].reverse()) {
      const count = s.cardCount ? ` (${s.cardCount.official})` : '';
      select.appendChild(new Option(`${s.name}${count}`, s.id));
    }
  } catch (e) {
    $('setSelect').innerHTML = '<option value="">Extensions indisponibles</option>';
    $('setInfo').textContent = `Erreur : ${e.message}`;
  }
}

async function openSet(id) {
  browseCards = [];
  $('setGrid').innerHTML = '';
  $('setProgress').hidden = true;
  if (!id) { $('setInfo').textContent = ''; return; }
  $('setInfo').textContent = 'Chargement…';
  try {
    const set = await getJSON(`${API}/${lang()}/sets/${encodeURIComponent(id)}`);
    browseCards = set.cards || [];
    browseSetName = set.name;
    browseOfficial = set.cardCount ? set.cardCount.official : 0;
    renderBrowse();
  } catch (e) {
    $('setInfo').textContent = `Erreur : ${e.message}`;
  }
}

function renderBrowse() {
  const grid = $('setGrid');
  grid.innerHTML = '';
  if (!browseCards.length) return;
  const q = fold($('setFilter').value.trim());
  const show = $('setShow').value;
  const owned = browseCards.filter((c) => ownedItem(c.id)).length;
  $('setInfo').textContent = `${browseSetName} : ${owned} / ${browseCards.length} cartes cochées.`;
  $('setProgress').hidden = false;
  $('setProgressBar').style.width = `${(100 * owned) / browseCards.length}%`;
  renderSetCost();

  for (const c of browseCards) {
    const item = ownedItem(c.id);
    if (show === 'owned' && !item) continue;
    if (show === 'missing' && item) continue;
    if (q && !fold(c.name).includes(q) && !String(c.localId).includes(q)) continue;

    const el = document.createElement('label');
    el.className = `tick${item ? ' owned' : ''}`;
    el.innerHTML = `
      ${c.image && safeImage(`${c.image}/low.webp`) ? `<img loading="lazy" src="${safeImage(`${c.image}/low.webp`)}" alt="">` : '<div class="noimg"></div>'}
      <span class="tick-row"><input type="checkbox"> <span class="tick-name"></span></span>
      <span class="tick-meta"><span class="muted small tick-num"></span><span class="tick-price"></span></span>
      <select class="tick-cond"></select>`;
    el.querySelector('.tick-name').textContent = c.name;
    el.querySelector('.tick-num').textContent = browseOfficial ? `${c.localId}/${browseOfficial}` : c.localId;
    const known = item ? unitPrice(item) : missingPrices.get(priceKey(c.id));
    if (typeof known === 'number' && known > 0) el.querySelector('.tick-price').textContent = euro.format(known);

    const box = el.querySelector('input');
    const cond = el.querySelector('.tick-cond');
    for (const [k, v] of Object.entries(CONDITIONS)) cond.appendChild(new Option(`${k} · ${v.label}`, k));
    box.checked = Boolean(item);
    cond.value = item ? item.condition : 'NM';
    cond.disabled = !item;

    box.addEventListener('change', async () => {
      if (box.checked) {
        box.disabled = true;
        try {
          const full = await getCard(lang(), c.id);
          addToCollection(full, defaultVariant(full), cond.value);
        } catch (e) {
          box.checked = false;
          $('setInfo').textContent = `Impossible d'ajouter ${c.name} : ${e.message}`;
        }
        box.disabled = false;
      } else {
        collection = collection.filter((i) => !(i.id === c.id && i.lang === lang()));
        saveCollection();
        renderCollection();
      }
    });
    cond.addEventListener('change', () => {
      for (const i of collection) if (i.id === c.id && i.lang === lang()) i.condition = cond.value;
      saveCollection();
      renderCollection();
    });
    grid.appendChild(el);
  }
}

$('setSelect').addEventListener('change', (e) => openSet(e.target.value));
$('setFilter').addEventListener('input', renderBrowse);
$('setShow').addEventListener('change', renderBrowse);

// ---------- Missing cards ----------
//
// The set listing has no prices: they are fetched card by card, only when asked,
// and kept for the session.

const missingPrices = new Map();
let costRun = null;

function priceKey(id) {
  return `${lang()}:${id}`;
}

function missingCards() {
  return browseCards.filter((c) => !ownedItem(c.id));
}

function renderSetCost() {
  const box = $('setCost');
  const missing = missingCards();
  box.hidden = !browseCards.length;
  if (!missing.length) {
    $('setCostText').textContent = 'Extension complète, bravo !';
    $('setCostBtn').hidden = true;
    return;
  }
  const known = missing.filter((c) => missingPrices.has(priceKey(c.id)));
  const priced = known.map((c) => missingPrices.get(priceKey(c.id))).filter((p) => typeof p === 'number');
  const sum = priced.reduce((a, b) => a + b, 0);
  const label = `Il te manque ${missing.length} carte${missing.length > 1 ? 's' : ''}.`;
  if (known.length === missing.length) {
    const unpriced = missing.length - priced.length;
    $('setCostText').textContent = `${label} Coût estimé pour compléter : ${euro.format(sum)} en Near Mint`
      + (unpriced ? ` (${unpriced} sans prix connu).` : '.');
    $('setCostBtn').hidden = true;
  } else {
    $('setCostText').textContent = label;
    $('setCostBtn').hidden = false;
    if (!costRun) $('setCostBtn').textContent = 'Estimer le coût pour compléter';
  }
}

async function estimateSetCost() {
  if (costRun) return;
  const todo = missingCards().filter((c) => !missingPrices.has(priceKey(c.id)));
  const btn = $('setCostBtn');
  btn.disabled = true;
  let done = 0;
  costRun = (async () => {
    const queue = [...todo];
    const worker = async () => {
      while (queue.length) {
        const c = queue.shift();
        const key = priceKey(c.id);
        try {
          const full = await getCard(lang(), c.id);
          missingPrices.set(key, marketPrice(full, defaultVariant(full)));
        } catch { /* left unknown: retried next time */ }
        done += 1;
        btn.textContent = `Estimation… ${done} / ${todo.length}`;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  })();
  try { await costRun; } finally {
    costRun = null;
    btn.disabled = false;
    renderBrowse();
  }
}

$('setCostBtn').addEventListener('click', estimateSetCost);
$('lang').addEventListener('change', () => {
  loadSetList();
  openSet('');
});

// ---------- UI: collection ----------

function addToCollection(card, variant, condition = 'NM') {
  const existing = collection.find((i) => i.id === card.id && i.variant === variant && i.lang === lang());
  if (existing) {
    existing.qty += 1;
  } else {
    collection.push({
      id: card.id,
      lang: lang(),
      name: card.name,
      set: card.set.name,
      number: displayNumber(card),
      image: card.image ? `${card.image}/low.webp` : '',
      variant,
      condition,
      qty: 1,
    });
    applyMarket(collection[collection.length - 1], card, { force: true });
  }
  saveCollection();
  renderCollection();
}

const SORTS = {
  value: (a, b) => unitPrice(b) * b.qty - unitPrice(a) * a.qty,
  name: (a, b) => a.name.localeCompare(b.name, 'fr'),
  set: (a, b) => a.set.localeCompare(b.set, 'fr') || String(a.number).localeCompare(String(b.number), 'fr', { numeric: true }),
  added: (a, b) => collection.indexOf(b) - collection.indexOf(a),
};

function emptyCollection() {
  const el = document.createElement('div');
  el.className = 'empty';
  el.innerHTML = `
    <span class="big" aria-hidden="true">🗂️</span>
    <p>Ta collection est vide. Ajoute des cartes en photo ou en les cochant par extension.</p>
    <div class="row">
      <a class="btn" href="#scan">📷 Scanner une carte</a>
      <a class="btn secondary" href="#extensions">☑️ Cocher par extension</a>
    </div>`;
  return el;
}

function renderCollection() {
  const list = $('rows');
  list.innerHTML = '';
  let total = 0;
  let count = 0;
  let top = null;
  for (const item of collection) {
    const value = unitPrice(item) * item.qty;
    total += value;
    count += item.qty;
    if (!top || unitPrice(item) > unitPrice(top)) top = item;
  }

  const q = fold($('colFilter').value.trim());
  const shown = collection
    .filter((i) => !q || fold(`${i.name} ${i.set} ${i.number}`).includes(q))
    .sort(SORTS[$('colSort').value] || SORTS.value);

  if (!collection.length) list.appendChild(emptyCollection());
  else if (!shown.length) list.innerHTML = '<p class="muted">Aucune carte ne correspond à ta recherche.</p>';

  for (const item of shown) {
    const unit = unitPrice(item);
    const el = document.createElement('article');
    el.className = 'item';
    el.innerHTML = `
      ${safeImage(item.image) ? `<img class="item-img" loading="lazy" src="${safeImage(item.image)}" alt="">` : '<div class="item-img"></div>'}
      <div class="item-head">
        <div class="item-name"></div>
        <div class="item-meta"></div>
      </div>
      <div class="item-total"><strong>${euro.format(unit * item.qty)}</strong>${item.qty > 1 ? `<span class="muted">${item.qty} × ${euro.format(unit)}</span>` : ''}</div>
      <div class="item-controls">
        <select class="c-variant" aria-label="Version"></select>
        <select class="c-cond" aria-label="État"></select>
        <span class="stepper" aria-label="Quantité">
          <button type="button" class="q-minus" aria-label="Retirer un exemplaire">−</button>
          <span class="q-val">${item.qty}</span>
          <button type="button" class="q-plus" aria-label="Ajouter un exemplaire">+</button>
        </span>
        <label class="price-edit">Prix
          <input class="c-price" type="number" inputmode="decimal" min="0" step="0.01" value="${unit.toFixed(2)}" aria-label="Prix unitaire en euros">
        </label>
        <span class="item-actions">
          <button type="button" class="secondary cm-open" title="Prix depuis les offres Cardmarket">€ Cardmarket</button>
          <button type="button" class="icon c-remove" title="Retirer de la collection" aria-label="Retirer">✕</button>
        </span>
        <span class="price-src"></span>
      </div>`;
    el.querySelector('.item-name').textContent = item.name;
    const meta = el.querySelector('.item-meta');
    meta.textContent = `${item.number} · ${item.set}`;
    const tag = document.createElement('span');
    tag.className = 'item-lang';
    tag.textContent = (item.lang || '').toUpperCase();
    meta.appendChild(tag);
    el.querySelector('.price-src').textContent = priceSourceLabel(item);

    const variantSel = el.querySelector('.c-variant');
    for (const [k, label] of Object.entries(VARIANTS)) variantSel.appendChild(new Option(label, k));
    variantSel.value = item.variant;
    variantSel.addEventListener('change', async () => {
      item.variant = variantSel.value;
      try { applyMarket(item, await getCard(item.lang, item.id), { force: true }); } catch { /* keep old price */ }
      saveCollection();
      renderCollection();
    });

    const condSel = el.querySelector('.c-cond');
    for (const [k, c] of Object.entries(CONDITIONS)) condSel.appendChild(new Option(`${k} · ${c.label}`, k));
    condSel.value = item.condition;
    condSel.addEventListener('change', () => {
      item.condition = condSel.value;
      saveCollection();
      renderCollection();
    });

    el.querySelector('.q-minus').addEventListener('click', () => {
      if (item.qty <= 1) return;
      item.qty -= 1;
      saveCollection();
      renderCollection();
    });
    el.querySelector('.q-plus').addEventListener('click', () => {
      item.qty += 1;
      saveCollection();
      renderCollection();
    });

    el.querySelector('.c-price').addEventListener('change', (e) => {
      const v = parseFloat(String(e.target.value).replace(',', '.'));
      if (Number.isFinite(v) && v >= 0) {
        item.manualPrice = v;
        item.priceSource = 'Prix saisi à la main';
      } else {
        delete item.manualPrice;
        delete item.priceSource;
      }
      saveCollection();
      renderCollection();
    });

    el.querySelector('.cm-open').addEventListener('click', () => openCardmarketDialog(item));

    el.querySelector('.c-remove').addEventListener('click', () => {
      const i = collection.indexOf(item);
      if (i < 0) return;
      collection.splice(i, 1);
      saveCollection();
      renderCollection();
      toast(`${item.name} retirée`, {
        label: 'Annuler',
        onClick() {
          collection.splice(Math.min(i, collection.length), 0, item);
          saveCollection();
          renderCollection();
        },
      });
    });

    list.appendChild(el);
  }

  if (browseCards.length) renderBrowse();
  const cards = `${count} carte${count > 1 ? 's' : ''}`;
  $('grandTotal').textContent = euro.format(total);
  $('count').textContent = count ? cards : '';
  $('sumTotal').textContent = euro.format(total);
  $('sumCount').textContent = String(count);
  $('sumTop').textContent = top && unitPrice(top) > 0 ? euro.format(unitPrice(top)) : '–';
  $('sumTopName').textContent = top && unitPrice(top) > 0 ? top.name : '';
  $('tabCount').textContent = String(count);
  $('tabCount').hidden = !count;
  recordHistory(total, count);
  renderHistory();
}

$('colFilter').addEventListener('input', renderCollection);
$('colSort').addEventListener('change', renderCollection);

// ---------- Value history ----------
//
// One point per day: the collection's total value and card count, kept on the
// device and, with an account, inside the encrypted vault.

const HISTORY_KEY = 'pokemon-estimation:history';
const HISTORY_MAX = 800;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeHistory(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && DAY_RE.test(p.d) && Number.isFinite(p.v) && p.v >= 0 && Number.isFinite(p.n) && p.n >= 0)
    .map((p) => ({ d: p.d, v: Math.round(p.v * 100) / 100, n: Math.round(p.n) }))
    .sort((a, b) => a.d.localeCompare(b.d))
    .slice(-HISTORY_MAX);
}

let valueHistory = [];
try { valueHistory = sanitizeHistory(JSON.parse(safeGet(HISTORY_KEY))); } catch { valueHistory = []; }

function localDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function recordHistory(total, count) {
  if (!count && !valueHistory.length) return;
  const point = { d: localDay(), v: Math.round(total * 100) / 100, n: count };
  const last = valueHistory[valueHistory.length - 1];
  if (last && last.d === point.d) {
    if (last.v === point.v && last.n === point.n) return;
    valueHistory[valueHistory.length - 1] = point;
  } else {
    valueHistory.push(point);
    valueHistory = valueHistory.slice(-HISTORY_MAX);
  }
  safeSet(HISTORY_KEY, JSON.stringify(valueHistory));
}

// Days known on another device are added; for a day both know, this device wins.
function mergeHistory(remote) {
  const byDay = new Map(sanitizeHistory(remote).map((p) => [p.d, p]));
  for (const p of valueHistory) byDay.set(p.d, p);
  valueHistory = sanitizeHistory([...byDay.values()]);
  safeSet(HISTORY_KEY, JSON.stringify(valueHistory));
  renderHistory();
}

let historyRange = 30;

function renderHistory() {
  const box = $('historyChart');
  const note = $('historyNote');
  const from = historyRange ? localDay(new Date(Date.now() - historyRange * 86_400_000)) : '';
  const points = valueHistory.filter((p) => p.d >= from);
  for (const b of document.querySelectorAll('[data-range]')) b.classList.toggle('active', Number(b.dataset.range) === historyRange);
  box.innerHTML = '';
  if (points.length < 2) {
    note.textContent = valueHistory.length
      ? 'La courbe se remplit jour après jour : reviens demain pour voir l’évolution.'
      : 'Ajoute des cartes : leur valeur sera suivie chaque jour.';
    $('historyDelta').textContent = '';
    return;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const delta = last.v - first.v;
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  $('historyDelta').textContent = `${sign}${euro.format(Math.abs(delta))} depuis le ${new Date(`${first.d}T12:00:00`).toLocaleDateString('fr-FR')}`;
  $('historyDelta').className = `delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`;
  note.textContent = last.n !== first.n
    ? `Cette variation inclut les cartes ajoutées ou retirées (${first.n} → ${last.n} cartes).`
    : 'Même nombre de cartes sur la période : la variation vient des prix du marché.';

  const W = 600;
  const H = 180;
  const pad = { l: 8, r: 8, t: 12, b: 22 };
  const t0 = Date.parse(first.d);
  const span = Math.max(1, Date.parse(last.d) - t0);
  let lo = Math.min(...points.map((p) => p.v));
  let hi = Math.max(...points.map((p) => p.v));
  if (hi - lo < 1) { lo -= 1; hi += 1; }
  const x = (p) => pad.l + ((Date.parse(p.d) - t0) / span) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(last).toFixed(1)},${H - pad.b} L${x(first).toFixed(1)},${H - pad.b} Z`;
  const fmt = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Évolution de la valeur de la collection">
      <defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="currentColor" stop-opacity=".28"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/>
      </linearGradient></defs>
      <line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(hi).toFixed(1)}" y2="${y(hi).toFixed(1)}"/>
      <line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(lo).toFixed(1)}" y2="${y(lo).toFixed(1)}"/>
      <path d="${area}" fill="url(#hg)"/>
      <path d="${line}" class="hline" vector-effect="non-scaling-stroke"/>
    </svg>
    <span class="hdot"></span>
    <div class="h-axis"><span>${fmt(first.d)}</span><span>${fmt(last.d)}</span></div>
    <div class="h-scale"><span>${euro.format(hi)}</span><span>${euro.format(lo)}</span></div>`;
  // Set through the CSSOM: the page's CSP forbids inline style attributes.
  const dot = box.querySelector('.hdot');
  dot.style.left = `${((100 * x(last)) / W).toFixed(2)}%`;
  dot.style.top = `${((160 * y(last.v)) / H).toFixed(1)}px`;
}

for (const b of document.querySelectorAll('[data-range]')) {
  b.addEventListener('click', () => { historyRange = Number(b.dataset.range); renderHistory(); });
}

// ---------- UI: navigation and toast ----------

const VIEWS = ['scan', 'extensions', 'collection', 'compte'];

function showView() {
  const name = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'scan';
  for (const v of document.querySelectorAll('[data-view]')) v.hidden = v.dataset.view !== name;
  for (const a of document.querySelectorAll('[data-tab]')) {
    a.classList.toggle('active', a.dataset.tab === name);
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  $('toast').hidden = true;
}
window.addEventListener('hashchange', showView);

let toastTimer = null;
// Short message at the bottom of the screen, with an optional link or action.
function toast(message, action = null) {
  const el = $('toast');
  el.textContent = message;
  if (action) {
    const a = document.createElement('a');
    a.href = action.href || '#';
    a.textContent = action.label;
    a.addEventListener('click', (e) => {
      if (action.onClick) { e.preventDefault(); action.onClick(); }
      el.hidden = true;
    });
    el.appendChild(a);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

// ---------- Cardmarket offers ----------
//
// Cardmarket has no public API and blocks scripts, so the user copies the
// offers page from their own browser and we average the cheapest offers.

// Labels of Cardmarket's summary block ("De 40,00 €", "Tendance des prix 31,88 €"…)
// in the languages the site is shown in.
const CM_STAT_LABELS = /^\s*(de|from|ab|tendance|price trend|preistrend|prix moyen|average price|durchschnittspreis|disponible|available|articles)\b/i;
const PRICE_RE = /(\d{1,3}(?:[ .\u00a0\u202f]\d{3})+|\d+)[,.](\d{2})\s*€/g;

// Prices of the individual offers found in the pasted page text.
function parseOfferPrices(text) {
  const prices = [];
  let afterLabel = false;
  for (const line of String(text).split(/\n/)) {
    if (!line.trim()) continue;
    const isLabel = CM_STAT_LABELS.test(line);
    // The value sits on the label's line or, depending on the browser, on the next one.
    const priceOnly = /^\s*[\d .,\u00a0\u202f]+€\s*$/.test(line);
    const skip = isLabel || (afterLabel && priceOnly);
    afterLabel = isLabel && !PRICE_RE.test(line);
    PRICE_RE.lastIndex = 0;
    if (skip) continue;
    for (const m of line.matchAll(PRICE_RE)) {
      const v = parseFloat(`${m[1].replace(/[ .\u00a0\u202f]/g, '')}.${m[2]}`);
      if (v > 0) prices.push(v);
    }
  }
  return prices;
}

function cheapestAverage(prices, n) {
  const sorted = [...prices].sort((a, b) => a - b).slice(0, n);
  if (!sorted.length) return null;
  return { avg: sorted.reduce((a, b) => a + b, 0) / sorted.length, used: sorted.length, min: sorted[0], max: sorted[sorted.length - 1] };
}

let cmItem = null;
let cmValue = null;

function cardmarketSearchUrl(name, itemLang) {
  const q = new URLSearchParams({ searchString: name, language: CARDMARKET_LANG[itemLang] || 2 });
  return `https://www.cardmarket.com/fr/Pokemon/Products/Search?${q}`;
}

function openCardmarketDialog(item) {
  cmItem = item;
  cmValue = null;
  $('cmCard').textContent = `${item.name} · ${item.set} · ${item.number} · ${item.lang.toUpperCase()}`;
  $('cmLink').href = cardmarketSearchUrl(item.name, item.lang);
  $('cmText').value = '';
  $('cmResult').textContent = '';
  $('cmApply').disabled = true;
  $('cmDialog').showModal();
}

function updateCardmarketResult() {
  const res = cheapestAverage(parseOfferPrices($('cmText').value), parseInt($('cmCount').value, 10));
  cmValue = res ? Math.round(res.avg * 100) / 100 : null;
  $('cmApply').disabled = cmValue === null;
  $('cmResult').textContent = res
    ? `Moyenne de ${res.used} offre${res.used > 1 ? 's' : ''} : ${euro.format(res.avg)} (de ${euro.format(res.min)} à ${euro.format(res.max)})`
    : ($('cmText').value.trim() ? 'Aucun prix trouvé dans le texte collé.' : '');
}

$('cmText').addEventListener('input', updateCardmarketResult);
$('cmCount').addEventListener('change', updateCardmarketResult);
$('cmApply').addEventListener('click', () => {
  if (cmItem && cmValue !== null) {
    cmItem.manualPrice = cmValue;
    cmItem.priceSource = `Cardmarket, ${$('cmCount').value} offres les moins chères`;
    saveCollection();
    renderCollection();
  }
  $('cmDialog').close();
});

$('refresh').addEventListener('click', async () => {
  const btn = $('refresh');
  btn.disabled = true;
  btn.textContent = 'Actualisation…';
  let changed = 0;
  for (const item of collection) {
    try {
      if (applyMarket(item, await getCard(item.lang, item.id))) changed += 1;
    } catch { /* keep old price */ }
  }
  saveCollection();
  renderCollection();
  btn.disabled = false;
  btn.textContent = 'Actualiser les prix';
  $('refreshInfo').textContent = changed
    ? `${changed} prix mis à jour avec les nouvelles ventes Cardmarket.`
    : 'Aucun nouveau prix Cardmarket depuis la dernière actualisation : les prix restent les mêmes.';
});

function csvCell(v) {
  let s = String(v ?? '');
  // Stop spreadsheets from running a cell as a formula.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

$('export').addEventListener('click', () => {
  const header = ['Carte', 'Extension', 'Numéro', 'Langue', 'Version', 'État', 'Quantité', 'Prix unitaire (€)', 'Total (€)', 'Date du prix'];
  const lines = [header.join(';')];
  for (const item of collection) {
    const unit = unitPrice(item);
    lines.push([
      item.name, item.set, item.number, item.lang.toUpperCase(), VARIANTS[item.variant],
      item.condition, item.qty, unit.toFixed(2).replace('.', ','),
      (unit * item.qty).toFixed(2).replace('.', ','), item.marketDate ? item.marketDate.slice(0, 10) : '',
    ].map(csvCell).join(';'));
  }
  // BOM so Excel opens accented characters correctly.
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `collection-pokemon-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('clear').addEventListener('click', () => {
  if (!confirm('Vider toute la collection ?')) return;
  collection = [];
  saveCollection();
  renderCollection();
});

// ---------- UI: account ----------

let pendingCode = null;

function accMsg(msg) {
  $('accMsg').textContent = msg || '';
}

function showAccount(view) {
  for (const id of ['accDisabled', 'accOut', 'accNew', 'accIn']) $(id).hidden = id !== view;
}

Sync.init({
  getExtra: () => ({ history: valueHistory }),
  onExtra(extra) { if (extra && extra.history) mergeHistory(extra.history); },
  onRemoteCollection(remote, message) {
    collection = sanitizeCollection(remote);
    saveCollection({ fromServer: true });
    renderCollection();
    if (message) accMsg(message);
  },
  onStateChange(state, message) {
    if (state === 'connected' || state === 'busy') {
      if (Sync.connected()) showAccount('accIn');
      $('accState').textContent = message || '';
    } else if (state === 'error') {
      $('accState').textContent = 'Erreur';
      accMsg(message);
    } else if (state === 'disconnected') {
      showAccount(Sync.enabled() ? 'accOut' : 'accDisabled');
    }
  },
});

$('accCreate').addEventListener('click', () => {
  pendingCode = Sync.generateCode();
  $('accNewCode').textContent = pendingCode;
  $('accSaved').checked = false;
  $('accConfirm').disabled = true;
  accMsg('');
  showAccount('accNew');
});

$('accSaved').addEventListener('change', (e) => {
  $('accConfirm').disabled = !e.target.checked;
});

$('accCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pendingCode);
    accMsg('Code copié.');
  } catch {
    accMsg('Copie impossible : recopie le code à la main.');
  }
});

function downloadCode(code) {
  const text = `Estimation Pokémon - code secret du compte\n\n${code}\n\n`
    + 'Garde ce fichier en lieu sûr. Ce code est le seul moyen de retrouver ta collection.\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = 'code-secret-pokemon-estimation.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}

$('accDownload').addEventListener('click', () => downloadCode(pendingCode));

$('accCancel').addEventListener('click', () => {
  pendingCode = null;
  showAccount('accOut');
});

$('accConfirm').addEventListener('click', async () => {
  $('accConfirm').disabled = true;
  try {
    await Sync.create(pendingCode, collection);
    pendingCode = null;
    accMsg('Compte créé. Ta collection est chiffrée et sauvegardée.');
  } catch (e) {
    accMsg(e.message);
    $('accConfirm').disabled = false;
  }
});

$('accLogin').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const code = Sync.normalizeCode($('accCodeInput').value);
  if (!code) {
    accMsg('Code invalide : 20 caractères, par ex. K7QF-2M9X-PL4D-8RWA-3HNC.');
    return;
  }
  if (collection.length && !confirm('La collection de ce compte va remplacer celle de cet appareil. Continuer ?')) return;
  try {
    accMsg('');
    await Sync.login(code);
    $('accCodeInput').value = '';
  } catch (e) {
    accMsg(e.message);
  }
});

$('accShow').addEventListener('click', () => {
  const el = $('accShownCode');
  el.hidden = !el.hidden;
  el.textContent = el.hidden ? '' : Sync.code();
});

$('accLogout').addEventListener('click', () => {
  if (!confirm('Se déconnecter ? La collection sera effacée de cet appareil (elle reste sur ton compte).')) return;
  Sync.logout();
  collection = [];
  saveCollection({ fromServer: true });
  renderCollection();
  $('accShownCode').hidden = true;
  accMsg('Déconnecté.');
});

$('accDelete').addEventListener('click', async () => {
  if (!confirm('Supprimer définitivement ton compte et la copie chiffrée de ta collection sur le serveur ?')) return;
  try {
    await Sync.destroy();
    accMsg('Compte supprimé. Ta collection reste sur cet appareil.');
  } catch (e) {
    accMsg(e.message);
  }
});

// ---------- Install as an app ----------

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* site still works online */ });
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('installBtn').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  $('installBtn').hidden = true;
});
window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; });

// iPhone has no install button: show the manual steps once, in Safari only.
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent) && !safeGet('pokemon-estimation:ios-hint')) {
  $('iosHint').hidden = false;
  safeSet('pokemon-estimation:ios-hint', '1');
}

showView();
renderCollection();
loadSetList();
Sync.resume();
