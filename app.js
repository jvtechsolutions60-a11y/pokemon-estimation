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

const $ = (id) => document.getElementById(id);
const euro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

// ---------- Storage ----------

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

let collection = [];
try { collection = JSON.parse(safeGet(STORE_KEY)) || []; } catch { collection = []; }

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
function rankByName(cards, topText) {
  if (!topText) return cards;
  const t = fold(topText).replace(/[^a-z0-9]/g, '');
  const hit = (c) => {
    const n = fold(c.name).replace(/[^a-z0-9]/g, '');
    return n.length >= 3 && t.includes(n);
  };
  return [...cards.filter(hit), ...cards.filter((c) => !hit(c))];
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

function renderResults(cards, bestId = null) {
  const box = $('results');
  box.innerHTML = '';
  if (!cards.length) {
    box.innerHTML = '<p class="muted">Aucune carte trouvée. Corrige le numéro ou cherche par nom.</p>';
    return;
  }
  if (cards.length > 1 && !bestId) {
    const hint = document.createElement('p');
    hint.className = 'muted hint';
    hint.textContent = 'Plusieurs cartes portent ce numéro : compare les logos et tampons '
      + '(ex. Pikachu « 30 » pour les 30 ans) et choisis la tienne.';
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
}

function resultCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  const img = card.image ? `${card.image}/low.webp` : '';
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
  });
  return el;
}

async function searchNumber(num, total, topText = '', photo = null) {
  $('results').innerHTML = '<p class="muted">Recherche…</p>';
  try {
    let cards = rankByName(await findByNumber(lang(), num, total), topText);
    let best = null;
    if (photo && cards.length > 1) {
      $('results').innerHTML = '<p class="muted">Comparaison avec les images officielles…</p>';
      ({ cards, best } = await rankByImage(cards, photo));
    }
    renderResults(cards, best);
  } catch (e) {
    $('results').innerHTML = `<p class="muted">Erreur : ${e.message}</p>`;
  }
}

async function searchName(name) {
  $('results').innerHTML = '<p class="muted">Recherche…</p>';
  try {
    renderResults(await findByName(lang(), name));
  } catch (e) {
    $('results').innerHTML = `<p class="muted">Erreur : ${e.message}</p>`;
  }
}

$('photo').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const img = await loadImage(file);
  $('previewImg').src = img.src;
  $('preview').hidden = false;
  setStatus('Lecture de la carte…');
  try {
    const hit = await readCardNumber(img);
    const text = await readCardText(img).catch(() => ({ top: '', all: '' }));
    const detected = detectLanguage(text.all);
    if (detected) $('lang').value = detected;
    const langLabel = detected ? ` · langue détectée : ${$('lang').selectedOptions[0].text.toLowerCase()}` : '';
    if (!hit) {
      setStatus(`Numéro illisible${langLabel}. Saisis-le ci-dessous (ex. 4 / 102) ou cherche par nom.`);
      return;
    }
    $('num').value = hit.num;
    $('total').value = hit.total;
    setStatus(`Numéro lu : ${hit.num}/${hit.total}${langLabel}. Corrige si besoin.`);
    await searchNumber(hit.num, hit.total, text.top, img);
  } catch (e) {
    setStatus(`Lecture impossible (${e.message}). Saisis le numéro à la main.`);
  } finally {
    ev.target.value = '';
  }
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

// ---------- UI: collection ----------

function addToCollection(card, variant) {
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
      condition: 'NM',
      qty: 1,
      marketPrice: marketPrice(card, variant),
      priceDate: card.pricing && card.pricing.cardmarket ? card.pricing.cardmarket.updated : null,
    });
  }
  saveCollection();
  renderCollection();
}

function renderCollection() {
  const tbody = $('rows');
  tbody.innerHTML = '';
  let total = 0;
  let count = 0;

  collection.forEach((item, idx) => {
    const unit = unitPrice(item);
    total += unit * item.qty;
    count += item.qty;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${item.image ? `<img src="${item.image}" alt="">` : ''}</td>
      <td class="c-name"></td>
      <td class="c-set"></td>
      <td class="c-num"></td>
      <td><select class="c-variant"></select></td>
      <td><select class="c-cond"></select></td>
      <td><input class="qty" type="number" min="1" value="${item.qty}"></td>
      <td class="num"><input class="c-price" type="number" min="0" step="0.01" value="${unit.toFixed(2)}"></td>
      <td class="num">${euro.format(unit * item.qty)}</td>
      <td><button type="button" class="link" title="Retirer">✕</button></td>`;
    tr.querySelector('.c-name').textContent = item.name;
    tr.querySelector('.c-set').textContent = item.set;
    tr.querySelector('.c-num').textContent = item.number;

    const variantSel = tr.querySelector('.c-variant');
    for (const [k, label] of Object.entries(VARIANTS)) variantSel.appendChild(new Option(label, k));
    variantSel.value = item.variant;
    variantSel.addEventListener('change', async () => {
      item.variant = variantSel.value;
      try { item.marketPrice = marketPrice(await getCard(item.lang, item.id), item.variant); } catch { /* keep old price */ }
      saveCollection();
      renderCollection();
    });

    const condSel = tr.querySelector('.c-cond');
    for (const [k, c] of Object.entries(CONDITIONS)) condSel.appendChild(new Option(`${k} (${c.label})`, k));
    condSel.value = item.condition;
    condSel.addEventListener('change', () => {
      item.condition = condSel.value;
      saveCollection();
      renderCollection();
    });

    tr.querySelector('.qty').addEventListener('change', (e) => {
      item.qty = Math.max(1, parseInt(e.target.value, 10) || 1);
      saveCollection();
      renderCollection();
    });

    tr.querySelector('.c-price').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v) && v >= 0) item.manualPrice = v;
      else delete item.manualPrice;
      saveCollection();
      renderCollection();
    });

    tr.querySelector('.link').addEventListener('click', () => {
      collection.splice(idx, 1);
      saveCollection();
      renderCollection();
    });

    tbody.appendChild(tr);
  });

  $('grandTotal').textContent = euro.format(total);
  $('count').textContent = count ? `(${count} carte${count > 1 ? 's' : ''})` : '';
}

$('refresh').addEventListener('click', async () => {
  const btn = $('refresh');
  btn.disabled = true;
  btn.textContent = 'Actualisation…';
  for (const item of collection) {
    try {
      const card = await getCard(item.lang, item.id);
      item.marketPrice = marketPrice(card, item.variant);
      item.priceDate = card.pricing && card.pricing.cardmarket ? card.pricing.cardmarket.updated : item.priceDate;
    } catch { /* keep old price */ }
  }
  saveCollection();
  renderCollection();
  btn.disabled = false;
  btn.textContent = 'Actualiser les prix';
});

function csvCell(v) {
  const s = String(v ?? '');
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
      (unit * item.qty).toFixed(2).replace('.', ','), item.priceDate ? item.priceDate.slice(0, 10) : '',
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
  onRemoteCollection(remote, message) {
    collection = Array.isArray(remote) ? remote : [];
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

renderCollection();
Sync.resume();
