'use strict';

// Anonymous, end-to-end encrypted account.
//
// The account is nothing but a random secret code. From it the browser derives
// a vault id, an auth token and an AES-256-GCM key; the server only ever sees
// the id, the token (stored hashed) and the encrypted collection. Losing the
// code means losing the account: nobody, us included, can decrypt it.

const Sync = (() => {
  // Worker address, set once it is deployed (see README). Empty = accounts disabled.
  // window.POKEMON_SYNC_URL overrides it for local testing.
  const API_URL = window.POKEMON_SYNC_URL || 'https://pokemon-estimation-sync.jvtechsolutions60.workers.dev';

  const CODE_KEY = 'pokemon-estimation:code';
  const VERSION_KEY = 'pokemon-estimation:version';
  // The collection as it was at the last exchange with the server: comparing
  // it with this device and with the server tells who changed what.
  const BASE_KEY = 'pokemon-estimation:synced';
  const MAX_CONFLICT_ROUNDS = 3;
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
  const CODE_LENGTH = 20; // 100 bits
  const PBKDF2_ITERATIONS = 300000;
  const SALT = 'pokemon-estimation/v1';

  const enc = new TextEncoder();
  let session = null; // { id, auth, key, code }
  let version = 0;
  let pushTimer = null;
  let onRemote = () => {};
  let getExtra = () => ({});
  let onExtra = () => {};
  let onState = () => {};
  let getLocal = null;
  let merge = (base, local, remote) => ({ collection: remote, needsPush: false });
  let pushFailed = false;
  let onSynced = () => {};
  // Server exchanges run one after the other, so two of them never race on the version.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  // ---------- Storage ----------

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function safeSet(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch { /* storage unavailable */ }
  }

  function readBase() {
    try {
      const base = JSON.parse(safeGet(BASE_KEY));
      return Array.isArray(base) ? base : null;
    } catch { return null; }
  }
  function setBase(collection) {
    safeSet(BASE_KEY, collection === null ? null : JSON.stringify(collection));
  }

  // ---------- Code ----------

  function generateCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    // 256 is a multiple of 32, so `% 32` is unbiased.
    const raw = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    return formatCode(raw);
  }

  function normalizeCode(input) {
    const raw = String(input).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (raw.length !== CODE_LENGTH || [...raw].some((c) => !ALPHABET.includes(c))) return null;
    return formatCode(raw);
  }

  function formatCode(raw) {
    return raw.match(/.{4}/g).join('-');
  }

  // ---------- Crypto ----------

  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // By slices: spreading a whole large collection into one call overflows the stack.
  const b64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function deriveSession(code) {
    const base = await crypto.subtle.importKey('raw', enc.encode(code.replace(/-/g, '')), 'PBKDF2', false, ['deriveBits']);
    const seed = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(SALT), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      base, 256,
    );
    const hkdf = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits', 'deriveKey']);
    const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) });
    const id = hex(await crypto.subtle.deriveBits(params('vault-id'), hkdf, 128));
    const auth = hex(await crypto.subtle.deriveBits(params('auth'), hkdf, 256));
    const key = await crypto.subtle.deriveKey(params('enc'), hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return { id, auth, key, code };
  }

  // The server takes up to 700 000 base64 characters (about 520 000 bytes).
  // Bigger collections (about 1 700 different cards and more) are gzipped
  // first; smaller ones stay plain JSON, readable by older versions of the site.
  const COMPRESS_FROM = 400000;
  const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

  async function encrypt(collection) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    let plain = enc.encode(JSON.stringify({ v: 1, ...getExtra(), collection }));
    if (plain.length > COMPRESS_FROM && typeof CompressionStream === 'function') plain = await pipe(plain, new CompressionStream('gzip'));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(session.id) }, session.key, plain);
    return { iv: b64(iv), data: b64(cipher) };
  }

  async function decrypt({ iv, data }) {
    let plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(session.id) },
      session.key, unb64(data),
    ));
    // gzip starts with 1f 8b, JSON with "{".
    if (plain[0] === 0x1f && plain[1] === 0x8b) plain = await pipe(plain, new DecompressionStream('gzip'));
    const { collection, v, ...extra } = JSON.parse(new TextDecoder().decode(plain));
    onExtra(extra);
    return collection;
  }

  // ---------- Server ----------

  async function request(method, body) {
    const res = await fetch(`${API_URL}/vault/${session.id}`, {
      method,
      headers: { Authorization: `Bearer ${session.auth}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error('Trop de demandes pour le moment. Réessaie dans quelques minutes.');
    return { status: res.status, payload };
  }

  async function pull() {
    const { status, payload } = await request('GET');
    if (status === 404) return null;
    if (status !== 200) throw new Error(`Serveur indisponible (${status})`);
    version = payload.version;
    safeSet(VERSION_KEY, String(version));
    return decrypt(payload);
  }

  async function push(collection, round = 0) {
    const { status, payload } = await request('PUT', { ...(await encrypt(collection)), version });
    if (status === 409) {
      // Changed on another device meanwhile: merge both sides, then save again.
      if (round >= MAX_CONFLICT_ROUNDS) throw new Error('Enregistrement impossible : la collection change sur un autre appareil. Réessaie.');
      const remote = await pull();
      if (remote === null) throw new Error('Ce compte n\'existe plus.');
      return reconcile(remote, 'Collection fusionnée avec les changements faits sur un autre appareil.', round + 1);
    }
    if (status === 400) throw new Error('Enregistrement impossible : collection trop grande pour le compte.');
    if (status !== 200) throw new Error(`Enregistrement impossible (${status})`);
    version = payload.version;
    safeSet(VERSION_KEY, String(version));
    setBase(collection);
    onSynced();
  }

  // Keeps what changed on this device since the last exchange and what
  // changed on the server, then saves the result if the server lacks part of it.
  // Reading this device and showing the result happen in one go, with no wait
  // in between, so an edit made meanwhile cannot slip through.
  async function reconcile(remote, message, round = 0) {
    const { collection, needsPush } = merge(readBase() || [], getLocal ? getLocal() : remote, remote);
    onRemote(collection, needsPush ? message : null);
    if (needsPush) await push(collection, round);
    else setBase(remote);
  }

  // ---------- Public API ----------

  function setState(state, message) {
    onState(state, message);
  }

  async function start(code, localCollection, { create }) {
    setState('busy', 'Calcul des clés…');
    session = await deriveSession(code);
    version = 0;
    if (create) {
      await push(localCollection);
    } else {
      const remote = await pull();
      if (remote === null) {
        session = null;
        throw new Error('Aucun compte ne correspond à ce code.');
      }
      // Logging in replaces this device's collection (the user confirmed it).
      onRemote(remote, null);
      setBase(remote);
    }
    safeSet(CODE_KEY, code);
    setState('connected', 'Synchronisé');
  }

  return {
    enabled: () => Boolean(API_URL),
    apiUrl: () => API_URL,
    connected: () => Boolean(session),
    code: () => (session ? session.code : null),
    generateCode,
    normalizeCode,

    // getExtra/onExtra carry data saved beside the collection (value history).
    // getLocal returns this device's collection; merge(base, local, remote)
    // returns { collection, needsPush }.
    // onSynced runs after each save the server accepted.
    init({ onRemoteCollection, onStateChange, getExtra: extraGetter, onExtra: extraHandler, getLocal: localGetter, merge: merger, onSynced: syncedHandler }) {
      onRemote = onRemoteCollection;
      if (syncedHandler) onSynced = syncedHandler;
      if (localGetter) getLocal = localGetter;
      if (merger) merge = merger;
      if (extraGetter) getExtra = extraGetter;
      if (extraHandler) onExtra = extraHandler;
      onState = onStateChange;
    },

    async resume() {
      const code = safeGet(CODE_KEY);
      if (!code || !API_URL) return setState('disconnected');
      try {
        session = await deriveSession(code);
        version = parseInt(safeGet(VERSION_KEY), 10) || 0;
        const gone = await serial(async () => {
          const remote = await pull();
          if (remote === null) return true;
          // Changes made here while offline are merged, not overwritten.
          await reconcile(remote, null);
          return false;
        });
        if (gone) {
          // Deleted from another device.
          this.logout();
          setState('error', 'Ce compte n\'existe plus. Ta collection reste sur cet appareil.');
          return;
        }
        pushFailed = false;
        setState('connected', 'Synchronisé');
      } catch (e) {
        pushFailed = true;
        setState('error', e.message);
      }
    },

    create: (code, collection) => start(code, collection, { create: true }),
    login: (code) => start(code, null, { create: false }),

    // Debounced so a burst of edits makes one request.
    changed(collection) {
      if (!session) return;
      clearTimeout(pushTimer);
      setState('busy', 'Enregistrement…');
      pushTimer = setTimeout(async () => {
        try {
          await serial(() => push(getLocal ? getLocal() : collection));
          pushFailed = false;
          setState('connected', 'Synchronisé');
        } catch (e) {
          // Kept on this device; sent again when the network comes back.
          pushFailed = true;
          setState('error', e.message);
        }
      }, 800);
    },

    logout() {
      clearTimeout(pushTimer);
      session = null;
      version = 0;
      safeSet(CODE_KEY, null);
      safeSet(VERSION_KEY, null);
      setBase(null);
      pushFailed = false;
      setState('disconnected');
    },

    async destroy() {
      const { status } = await request('DELETE');
      if (status !== 200 && status !== 404) throw new Error(`Suppression impossible (${status})`);
      this.logout();
    },

    // Retry after a failed save, e.g. when the network comes back.
    retry() {
      if (session && pushFailed && getLocal) this.changed(getLocal());
    },

    // Exposed for tests.
    _deriveSession: deriveSession,
  };
})();
