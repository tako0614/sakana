/**
 * 法令検索の公開面。静的assetを配り、/api/ だけを Cloudflare Tunnel の
 * originへ中継する。tokenはWorker secretに置き、ブラウザへは出さない。
 */

const API_PREFIX = '/api/';
const ALLOWED_API_PATHS = [
  /^\/api\/health$/,
  /^\/api\/guilds$/,
  /^\/api\/guilds\/\d{5,25}\/laws$/,
  /^\/api\/guilds\/\d{5,25}\/laws\/\d+$/,
  /^\/api\/guilds\/\d{5,25}\/laws\/\d+\/versions\/\d+$/,
  /^\/api\/guilds\/\d{5,25}\/constitution$/,
  /^\/api\/guilds\/\d{5,25}\/constitutions$/,
  /^\/api\/guilds\/\d{5,25}\/constitutions\/\d+$/
];
const ALLOWED_QUERY = new Set(['q', 'status', 'limit']);

export function apiTarget(pathname, search, originUrl) {
  if (!ALLOWED_API_PATHS.some((pattern) => pattern.test(pathname))) return null;
  const target = new URL(pathname, originUrl);
  for (const [key, value] of new URLSearchParams(search)) {
    if (ALLOWED_QUERY.has(key)) target.searchParams.set(key, value.slice(0, 200));
  }
  return target;
}

function jsonResponse(status, body, cacheSeconds = 0) {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(API_PREFIX)) {
      if (!env.ASSETS) return new Response('assets binding is missing', { status: 500 });
      return env.ASSETS.fetch(request);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse(405, { error: 'method not allowed' });
    }
    if (!env.ORIGIN_URL || !env.ORIGIN_TOKEN) {
      return jsonResponse(503, { error: 'origin is not configured' });
    }
    const target = apiTarget(url.pathname, url.search, env.ORIGIN_URL);
    if (!target) return jsonResponse(404, { error: 'not found' });
    let upstream;
    try {
      upstream = await fetch(target, {
        method: 'GET',
        headers: { 'x-statute-token': env.ORIGIN_TOKEN, accept: 'application/json' },
        cf: { cacheTtl: 30, cacheEverything: true }
      });
    } catch {
      // 自宅鯖が落ちている、tunnelが切れている、のどちらかを画面で説明できるようにする。
      return jsonResponse(502, { error: 'origin unavailable' });
    }
    if (!upstream.ok) {
      return jsonResponse(upstream.status === 401 ? 500 : upstream.status, {
        error: upstream.status === 401 ? 'origin rejected the worker token' : 'origin error'
      });
    }
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=60'
      }
    });
  }
};
