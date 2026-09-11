// Minimal CORS relay for the VATSIM member details and ATC session endpoints.
//
// The VATSIM API doesn't send CORS headers, so a browser page can't read it.
// This Worker forwards exactly one endpoint, adds the headers, and caches
// responses briefly at the edge so repeated lookups don't reach VATSIM.
// It stores nothing and does no calculation; the site still does all of that.
//
// Deploy:  cd worker && npx wrangler deploy
// Then set the site's proxy URL to the Worker URL (Settings → Data source),
// or build the site with VITE_PROXY_URL=https://<worker>.workers.dev

const UPSTREAM = 'https://api.vatsim.net';
const CACHE_SECONDS = 120;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const allowOrigin = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : '';

    const cors = allowOrigin
      ? {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Accept',
          'Access-Control-Expose-Headers': 'Retry-After',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        }
      : {};

    if (request.method === 'OPTIONS') return new Response(null, { status: allowOrigin ? 204 : 403, headers: cors });
    if (!allowOrigin) return reply({ error: 'Origin not allowed' }, 403, {});
    if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405, cors);

    // Only two endpoints: member details (division/subdivision) and ATC session history.
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/v2\/members\/(\d{3,10})(\/atc)?\/?$/);
    if (!m) return reply({ error: 'Not found' }, 404, cors);

    let upstreamUrl = `${UPSTREAM}/v2/members/${m[1]}`;
    if (m[2]) {
      const limit = clampInt(url.searchParams.get('limit'), 1, 1000, 250);
      const offset = clampInt(url.searchParams.get('offset'), 0, 1_000_000, 0);
      upstreamUrl += `/atc?limit=${limit}&offset=${offset}`;
    }

    const cache = caches.default;
    const cacheKey = new Request(upstreamUrl);
    let res = await cache.match(cacheKey);

    if (!res) {
      const upstream = await fetch(upstreamUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'vatsim-atc-currency-proxy' },
      });
      const headers = { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' };
      const retryAfter = upstream.headers.get('Retry-After');
      if (retryAfter) headers['Retry-After'] = retryAfter;
      res = new Response(upstream.body, { status: upstream.status, headers });
      if (upstream.ok) {
        res.headers.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
      }
    }

    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function reply(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
