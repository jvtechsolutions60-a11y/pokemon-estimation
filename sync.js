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
  const API_URL = window.POKEMON_SYNC_URL || '';

  const CODE_KEY = 'pokemon-estimation:code';
  const VERSION_KEY = 'pokemon-estimation:version';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
  const CODE_LENGTH = 20; // 100 bits
  const PBKDF2_ITERATIONS = 300000;
  const SALT = 'pokemon-estimation/v1';

  const enc = new TextEncoder();
  let session = null; // { id, auth, key, code }
  let version = 0;
  let pushTimer = null;
  let onRemote = () => {};
  let onState = () => {};

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
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
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

  async function encrypt(collection) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = enc.encode(JSON.stringify({ v: 1, collection }));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(session.id) }, session.key, plain);
    return { iv: b64(iv), data: b64(cipher) };
  }

  async function decrypt({ iv, data }) {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(session.id) },
      session.key, unb64(data),
    );
    return JSON.parse(new TextDecoder().decode(plain)).collection;
  }

  // ---------- Server ----------

  async function request(method, body) {
    const res = await fetch(`${API_URL}/vault/${session.id}`, {
      method,
      headers: { Authorization: `Bearer ${session.auth}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await res.json().catch(() => ({}));
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

  async function push(collection) {
    const { status, payload } = await request('PUT', { ...(await encrypt(collection)), version });
    if (status === 409) {
      // Changed on another device: take the server copy.
      const remote = await pull();
      if (remote) onRemote(remote, 'La collection a été modifiée sur un autre appareil : version la plus récente chargée.');
      return;
    }
    if (status !== 200) throw new Error(`Enregistrement impossible (${status})`);
    version = payload.version;
    safeSet(VERSION_KEY, String(version));
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
      onRemote(remote, null);
    }
    safeSet(CODE_KEY, code);
    setState('connected', 'Synchronisé');
  }

  return {
    enabled: () => Boolean(API_URL),
    connected: () => Boolean(session),
    code: () => (session ? session.code : null),
    generateCode,
    normalizeCode,

    init({ onRemoteCollection, onStateChange }) {
      onRemote = onRemoteCollection;
      onState = onStateChange;
    },

    async resume() {
      const code = safeGet(CODE_KEY);
      if (!code || !API_URL) return setState('disconnected');
      try {
        session = await deriveSession(code);
        version = parseInt(safeGet(VERSION_KEY), 10) || 0;
        const remote = await pull();
        if (remote === null) {
          // Deleted from another device.
          this.logout();
          setState('error', 'Ce compte n\'existe plus. Ta collection reste sur cet appareil.');
          return;
        }
        onRemote(remote, null);
        setState('connected', 'Synchronisé');
      } catch (e) {
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
          await push(collection);
          setState('connected', 'Synchronisé');
        } catch (e) {
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
      setState('disconnected');
    },

    async destroy() {
      const { status } = await request('DELETE');
      if (status !== 200 && status !== 404) throw new Error(`Suppression impossible (${status})`);
      this.logout();
    },

    // Exposed for tests.
    _deriveSession: deriveSession,
  };
})();
