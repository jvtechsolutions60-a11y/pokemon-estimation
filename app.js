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

  // Reprints such as the Celebrations "Classic Collection" keep their original
  // number (4/102) but are stored as "4_A" inside a much smaller set.
  let reprints = [];
  try {
    const list = await getJSON(`${API}/${lang}/cards?localId=like:${num}_`);
    reprints = await Promise.all(list
      .filter((c) => parseInt(c.localId, 10) === num)
      .slice(0, MAX_CANDIDATE_SETS)
      .map((c) => getCard(lang, c.id).catch(() => null)));
  } catch { /* optional lookup */ }

  const seen = new Set();
  return [...reprints, ...found].filter((c) => c && !seen.has(c.id) && seen.add(c.id));
}

async function findByName(lang, name) {
  const list = await getJSON(`${API}/${lang}/cards?name=${encodeURIComponent(name)}`);
  return list.slice(0, 24);
}

// "4_A" (Classic Collection reprint) is printed as "4" on the card.
function displayNumber(card) {
  return `${String(card.localId).replace(/_.*$/, '')}/${card.set.cardCount.official}`;
}

// ---------- Pricing ----------

function marketPrice(card, variant) {
  const cm = card && card.pricing && card.pricing.cardmarket;
  if (!cm) return null;
  const foil = variant === 'holo' || variant === 'reverse';
  const pick = (...keys) => {
    for (const k of keys) if (typeof cm[k] === 'number' && cm[k] > 0) return cm[k];
    return null;
  };
  return foil
    ? pick('trend-holo', 'avg30-holo', 'avg-holo', 'trend', 'avg30', 'avg')
    : pick('trend', 'avg30', 'avg', 'trend-holo', 'avg30-holo');
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

// ---------- UI: search ----------

function setStatus(msg) {
  $('ocrStatus').textContent = msg;
}

function lang() {
  return $('lang').value;
}

function renderResults(cards) {
  const box = $('results');
  box.innerHTML = '';
  if (!cards.length) {
    box.innerHTML = '<p class="muted">Aucune carte trouvée. Corrige le numéro ou cherche par nom.</p>';
    return;
  }
  for (const card of cards) box.appendChild(resultCard(card));
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
    <button type="button">Ajouter</button>`;
  el.querySelector('.title').textContent = card.name;
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

async function searchNumber(num, total) {
  $('results').innerHTML = '<p class="muted">Recherche…</p>';
  try {
    renderResults(await findByNumber(lang(), num, total));
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
  setStatus('Lecture du numéro de la carte…');
  try {
    const hit = await readCardNumber(img);
    if (!hit) {
      setStatus('Numéro illisible. Saisis-le ci-dessous (ex. 4 / 102) ou cherche par nom.');
      return;
    }
    $('num').value = hit.num;
    $('total').value = hit.total;
    setStatus(`Numéro lu : ${hit.num}/${hit.total}. Corrige-le si besoin.`);
    await searchNumber(hit.num, hit.total);
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
