import type { Env, Session } from './types.ts';

// 記憶の本を読めるのは、このサーバーのメンバーだけにする。
//   Discord OAuth2 (identify + guilds) でログイン → サーバーに入っているかを確かめる → 署名つき cookie を渡す。
// アクセストークンはその場で使い捨てて保存しない。メッセージやフレンドの権限は求めない。

const SESSION_COOKIE = 'sk_session';
const STATE_COOKIE = 'sk_state';
const SESSION_SECONDS = 7 * 24 * 3600;
const DISCORD_API = 'https://discord.com/api/v10';
const encoder = new TextEncoder();

export interface AuthDeps {
  fetch: typeof fetch;
  now(): number;
  random(bytes: number): Uint8Array;
}

export const defaultAuthDeps: AuthDeps = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes))
};

// ---- base64url / 署名 ----------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(session: Session, secret: string): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(session)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload)));
  return `${payload}.${toBase64Url(signature)}`;
}

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const { uid, name, avatar, exp } = value as Record<string, unknown>;
  return typeof uid === 'string' && typeof name === 'string' && (avatar === null || typeof avatar === 'string') && typeof exp === 'number';
}

/** 署名と期限を確かめる。壊れていれば null。署名の比較は subtle.verify (定数時間)。 */
export async function verifySession(token: string, secret: string, now: number): Promise<Session | null> {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const signatureBytes = fromBase64Url(signature);
  if (!signatureBytes) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), signatureBytes, encoder.encode(payload));
  if (!ok) return null;
  const bytes = fromBase64Url(payload);
  if (!bytes) return null;
  try {
    const session: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isSession(session) && session.exp * 1000 > now ? session : null;
  } catch {
    return null;
  }
}

// ---- cookie -----------------------------------------------------------------

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function setCookie(url: URL, name: string, value: string, options: { maxAge: number; path: string }): string {
  return `${name}=${value}; Max-Age=${options.maxAge}; Path=${options.path}; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`;
}

// ---- 設定 -------------------------------------------------------------------

export const memoryGuild = (env: Env): string => (env.MEMORY_GUILD_ID ?? env.DEFAULT_GUILD_ID ?? '').trim();
export const isPublicAccess = (env: Env): boolean => env.MEMORY_ACCESS === 'public';

export function authConfigured(env: Env): boolean {
  return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.SESSION_SECRET && memoryGuild(env));
}

/** ログイン後に戻る先。同じサイトの中の絶対パスだけ (//evil.example や \ を弾く)。 */
export function safeNext(next: string | null | undefined): string {
  const value = next ?? '';
  return /^\/(?![/\\])[^\u0000-\u001f\\]*$/.test(value) && value.length <= 300 ? value : '/wiki';
}

/** Location ヘッダーは ASCII だけ。日本語や空白は %XX にする (すでにある %XX はそのまま)。 */
export const asciiLocation = (path: string): string => path.replace(/[^\u0021-\u007e]/gu, (character) => encodeURIComponent(character));

export async function currentSession(request: Request, env: Env, now = Date.now()): Promise<Session | null> {
  if (!env.SESSION_SECRET) return null;
  const token = readCookie(request, SESSION_COOKIE);
  return token ? verifySession(token, env.SESSION_SECRET, now) : null;
}

// ---- OAuth ------------------------------------------------------------------

export function loginRedirect(request: Request, env: Env, deps: AuthDeps = defaultAuthDeps): Response {
  const url = new URL(request.url);
  const state = toBase64Url(deps.random(16));
  const next = safeNext(url.searchParams.get('next'));
  const authorize = new URL('https://discord.com/oauth2/authorize');
  authorize.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID ?? '',
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'none'
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      'set-cookie': setCookie(url, STATE_COOKIE, `${state}:${encodeURIComponent(next)}`, { maxAge: 600, path: '/auth' }),
      'cache-control': 'no-store'
    }
  });
}

export type CallbackResult =
  | { ok: true; response: Response }
  | { ok: false; reason: string; status: number };

function stringField(value: unknown, key: string): string | null {
  const field = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return typeof field === 'string' ? field : null;
}

async function discordJson(deps: AuthDeps, path: string, init: RequestInit): Promise<unknown> {
  const response = await deps.fetch(`${DISCORD_API}${path}`, { ...init, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Discord ${path} が ${response.status} を返しました`);
  return response.json();
}

/** Discord から戻ってきた後。state・メンバー確認を通ったときだけセッションを渡す。 */
export async function finishLogin(request: Request, env: Env, deps: AuthDeps = defaultAuthDeps): Promise<CallbackResult> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const saved = readCookie(request, STATE_COOKIE);
  const [savedState = '', savedNext = ''] = (saved ?? '').split(':');
  if (url.searchParams.get('error')) return { ok: false, reason: 'ログインがキャンセルされました。', status: 400 };
  if (!code || !state || !saved || state !== savedState) {
    return { ok: false, reason: 'ログインの確認に失敗しました (期限切れか、別のタブで始めた可能性があります)。もう一度お試しください。', status: 400 };
  }
  if (!authConfigured(env)) return { ok: false, reason: 'ログインの設定が済んでいません。', status: 503 };

  let accessToken: string | null;
  try {
    const token = await discordJson(deps, '/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID ?? '',
        client_secret: env.DISCORD_CLIENT_SECRET ?? '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${url.origin}/auth/callback`
      })
    });
    accessToken = stringField(token, 'access_token');
  } catch {
    return { ok: false, reason: 'Discord との通信に失敗しました。少し待ってからもう一度お試しください。', status: 502 };
  }
  if (!accessToken) return { ok: false, reason: 'Discord から正しい応答が返りませんでした。', status: 502 };

  const headers = { authorization: `Bearer ${accessToken}` };
  let user: unknown;
  let guilds: unknown;
  try {
    [user, guilds] = await Promise.all([discordJson(deps, '/users/@me', { headers }), discordJson(deps, '/users/@me/guilds', { headers })]);
  } catch {
    return { ok: false, reason: 'Discord からユーザー情報を取れませんでした。', status: 502 };
  } finally {
    // 使い終わったトークンは失効させる (失敗しても困らない)
    void deps.fetch(`${DISCORD_API}/oauth2/token/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID ?? '', client_secret: env.DISCORD_CLIENT_SECRET ?? '', token: accessToken }),
      signal: AbortSignal.timeout(5000)
    }).catch(() => undefined);
  }

  const uid = stringField(user, 'id');
  if (!uid || !Array.isArray(guilds)) return { ok: false, reason: 'Discord から正しい応答が返りませんでした。', status: 502 };
  const member = guilds.some((entry) => stringField(entry, 'id') === memoryGuild(env));
  if (!member) return { ok: false, reason: 'このサーバーのメンバーではないようです。サーバーに参加してからもう一度お試しください。', status: 403 };

  const session: Session = {
    uid,
    name: (stringField(user, 'global_name') ?? stringField(user, 'username') ?? uid).slice(0, 40),
    avatar: stringField(user, 'avatar'),
    exp: Math.floor(deps.now() / 1000) + SESSION_SECONDS
  };
  const token = await signSession(session, env.SESSION_SECRET ?? '');
  const headersOut = new Headers({ location: asciiLocation(safeNext(decodeURIComponentSafe(savedNext))), 'cache-control': 'no-store' });
  headersOut.append('set-cookie', setCookie(url, SESSION_COOKIE, token, { maxAge: SESSION_SECONDS, path: '/' }));
  headersOut.append('set-cookie', setCookie(url, STATE_COOKIE, '', { maxAge: 0, path: '/auth' }));
  return { ok: true, response: new Response(null, { status: 302, headers: headersOut }) };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

export function logoutResponse(request: Request): Response {
  const url = new URL(request.url);
  return new Response(null, {
    status: 302,
    headers: { location: '/wiki', 'set-cookie': setCookie(url, SESSION_COOKIE, '', { maxAge: 0, path: '/' }), 'cache-control': 'no-store' }
  });
}
