// Zero-knowledge sync for pokemon-estimation.
//
// The browser derives three values from the user's secret code: a vault id,
// an auth token and an AES key. Only the id, a SHA-256 of the token and the
// encrypted collection reach this Worker, so a leak of the database reveals
// nothing about who owns which cards. No request is logged.

const ID_RE = /^[0-9a-f]{32}$/;
const AUTH_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_DATA_CHARS = 700_000;
const MAX_CREATIONS_PER_DAY = 1000;
const RETENTION_DAYS = 730;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // Abuse limits, keyed on a hash of the client address that only lives in
    // Cloudflare's in-memory counters; nothing about the client is stored.
    const client = await sha256Hex(`pokemon-estimation:${request.headers.get('CF-Connecting-IP') || ''}`);
    if (!(await allowed(env.REQUEST_LIMITER, client))) return json({ error: 'rate_limited' }, 429, cors);

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/vault\/([0-9a-f]{32})$/);
    if (!match) return json({ error: 'not_found' }, 404, cors);
    const id = match[1];

    const auth = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
    if (!ID_RE.test(id) || !AUTH_RE.test(auth)) return json({ error: 'bad_request' }, 400, cors);
    const authHash = await sha256Hex(auth);

    const row = await env.DB.prepare('SELECT auth_hash, iv, data, version FROM vaults WHERE id = ?')
      .bind(id).first();
    // Same answer for "missing" and "wrong token": don't confirm a vault exists.
    const owned = row && timingSafeEqual(row.auth_hash, authHash);

    if (owned && request.method !== 'DELETE') await touch(env, id);

    if (request.method === 'GET') {
      if (!owned) return json({ error: 'not_found' }, 404, cors);
      return json({ iv: row.iv, data: row.data, version: row.version }, 200, cors);
    }

    if (request.method === 'PUT') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, cors); }
      const { iv, data, version } = body || {};
      if (typeof iv !== 'string' || iv.length > 24 || !B64_RE.test(iv)
        || typeof data !== 'string' || data.length > MAX_DATA_CHARS || !B64_RE.test(data)
        || !Number.isInteger(version) || version < 0) {
        return json({ error: 'bad_request' }, 400, cors);
      }

      if (!row) {
        if (version !== 0) return json({ error: 'not_found' }, 404, cors);
        if (!(await allowed(env.CREATE_LIMITER, client))) return json({ error: 'rate_limited' }, 429, cors);
        const day = today();
        const count = await env.DB.prepare(
          'INSERT INTO daily_creations (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1 RETURNING n',
        ).bind(day).first('n');
        if (count > MAX_CREATIONS_PER_DAY) return json({ error: 'rate_limited' }, 429, cors);
        const res = await env.DB.prepare(
          'INSERT INTO vaults (id, auth_hash, iv, data, version) VALUES (?, ?, ?, ?, 1) ON CONFLICT(id) DO NOTHING',
        ).bind(id, authHash, iv, data).run();
        if (!res.meta.changes) return json({ error: 'conflict' }, 409, cors);
        await touch(env, id);
        return json({ version: 1 }, 200, cors);
      }

      if (!owned) return json({ error: 'not_found' }, 404, cors);
      // Optimistic locking: the client must send the version it last saw.
      const res = await env.DB.prepare(
        'UPDATE vaults SET iv = ?, data = ?, version = version + 1 WHERE id = ? AND version = ?',
      ).bind(iv, data, id, version).run();
      if (!res.meta.changes) return json({ error: 'conflict' }, 409, cors);
      return json({ version: version + 1 }, 200, cors);
    }

    if (request.method === 'DELETE') {
      if (!owned) return json({ error: 'not_found' }, 404, cors);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM vaults WHERE id = ?').bind(id),
        env.DB.prepare('DELETE FROM vault_activity WHERE id = ?').bind(id),
      ]);
      return json({ deleted: true }, 200, cors);
    }

    return json({ error: 'method_not_allowed' }, 405, cors);
  },

  // Nightly: erase vaults nobody opened for RETENTION_DAYS, and old counters.
  async scheduled(event, env) {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
    await env.DB.batch([
      // Vaults created before activity tracking start their clock today.
      env.DB.prepare('INSERT OR IGNORE INTO vault_activity (id, day) SELECT id, ? FROM vaults').bind(today()),
      env.DB.prepare('DELETE FROM vaults WHERE id IN (SELECT id FROM vault_activity WHERE day < ?)').bind(cutoff),
      env.DB.prepare('DELETE FROM vault_activity WHERE day < ?').bind(cutoff),
      env.DB.prepare('DELETE FROM daily_creations WHERE day < ?').bind(today()),
    ]);
  },
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Records the day (not the time) a vault was last used.
async function touch(env, id) {
  const day = today();
  await env.DB.prepare(
    'INSERT INTO vault_activity (id, day) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET day = excluded.day WHERE day <> excluded.day',
  ).bind(id, day).run();
}

async function allowed(limiter, key) {
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  const headers = {
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
