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

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

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
        const res = await env.DB.prepare(
          'INSERT INTO vaults (id, auth_hash, iv, data, version) VALUES (?, ?, ?, ?, 1) ON CONFLICT(id) DO NOTHING',
        ).bind(id, authHash, iv, data).run();
        if (!res.meta.changes) return json({ error: 'conflict' }, 409, cors);
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
      await env.DB.prepare('DELETE FROM vaults WHERE id = ?').bind(id).run();
      return json({ deleted: true }, 200, cors);
    }

    return json({ error: 'method_not_allowed' }, 405, cors);
  },
};

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
