import { GUILD_ID } from './links.ts';
import type { Env, Session } from './types.ts';

// 記憶の本を読めるのは、このサーバーのメンバーだけにする。入り方は2つ:
//   1. bot のログインリンク (既定): メンバーが Discord で /memory url を使うと、bot が (そのサーバーのメンバーだと
//      分かっているので) 10分だけ有効な1回限りのリンクを本人にだけ返す。サイトは署名を確かめて cookie を渡す。
//      Discord 側の設定 (OAuth アプリ・Client Secret) が要らない。
//   2. Discord OAuth2 (identify + guilds): 設定してあれば「Discord でログイン」ボタンも出す。
// どちらも署名つきの session cookie を渡す。OAuth のアクセストークンはその場で使い捨てて保存しない。

const STATE_COOKIE = 'sk_state';
// cookie はサーバーごと (名前も、送られるパスも分ける): あるサーバーの入場が別のサーバーのページに効かないように
const sessionCookieName = (guild: string): string => `sk_session_${guild}`;
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
  const { g, uid, name, avatar, exp } = value as Record<string, unknown>;
  return typeof g === 'string' && typeof uid === 'string' && typeof name === 'string' && (avatar === null || typeof avatar === 'string') && typeof exp === 'number';
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

/** 記憶の本を見せるサーバー。URL の /<サーバーID> がこの一覧にあるものだけ開く (無ければ 404)。 */
export function memoryGuilds(env: Env): string[] {
  const raw = `${env.MEMORY_GUILD_IDS ?? ''} ${env.MEMORY_GUILD_ID ?? ''} ${env.DEFAULT_GUILD_ID ?? ''}`;
  return [...new Set(raw.split(/[\s,]+/).filter((id) => GUILD_ID.test(id)))];
}
export const isPublicAccess = (env: Env): boolean => env.MEMORY_ACCESS === 'public';

/** cookie を発行・確認できる (どの入り方にも必要) */
export const sessionConfigured = (env: Env): boolean => Boolean(env.SESSION_SECRET) && memoryGuilds(env).length > 0;

/** Discord OAuth でログインできる */
export function authConfigured(env: Env): boolean {
  return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) && sessionConfigured(env);
}

/** bot のログインリンクで入れる */
export const linkConfigured = (env: Env): boolean => Boolean(env.MEMORY_LINK_SECRET) && sessionConfigured(env);

/** 入る手段が1つでもある (無ければ wiki は閉じたまま) */
export const loginAvailable = (env: Env): boolean => authConfigured(env) || linkConfigured(env);

/** ログイン後に戻る先。そのサーバーの中の絶対パスだけ (//evil.example・\・別のサーバーのパスを弾く)。 */
export function safeNext(next: string | null | undefined, guild: string): string {
  const value = next ?? '';
  const inside = value.startsWith(`/${guild}/`) || value === `/${guild}`;
  return inside && /^\/(?![/\\])[^\u0000-\u001f\\]*$/.test(value) && value.length <= 300 ? value : `/${guild}/wiki`;
}

/** Location ヘッダーは ASCII だけ。日本語や空白は %XX にする (すでにある %XX はそのまま)。 */
export const asciiLocation = (path: string): string => path.replace(/[^\u0021-\u007e]/gu, (character) => encodeURIComponent(character));

export async function currentSession(request: Request, env: Env, guild: string, now = Date.now()): Promise<Session | null> {
  if (!env.SESSION_SECRET) return null;
  const token = readCookie(request, sessionCookieName(guild));
  const session = token ? await verifySession(token, env.SESSION_SECRET, now) : null;
  return session?.g === guild ? session : null;   // cookie の名前とパスで分けた上で、中身のサーバーも確かめる
}

// ---- OAuth ------------------------------------------------------------------

export function loginRedirect(request: Request, env: Env, guild: string, deps: AuthDeps = defaultAuthDeps): Response {
  const url = new URL(request.url);
  const state = toBase64Url(deps.random(16));
  const next = safeNext(url.searchParams.get('next'), guild);
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
      'set-cookie': setCookie(url, STATE_COOKIE, `${state}:${guild}:${encodeURIComponent(next)}`, { maxAge: 600, path: '/auth' }),
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
  const [savedState = '', savedGuild = '', savedNext = ''] = (saved ?? '').split(':');
  if (url.searchParams.get('error')) return { ok: false, reason: 'ログインがキャンセルされました。', status: 400 };
  if (!code || !state || !saved || state !== savedState) {
    return { ok: false, reason: 'ログインの確認に失敗しました (期限切れか、別のタブで始めた可能性があります)。もう一度お試しください。', status: 400 };
  }
  if (!authConfigured(env) || !memoryGuilds(env).includes(savedGuild)) return { ok: false, reason: 'ログインの設定が済んでいません。', status: 503 };

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
  const member = guilds.some((entry) => stringField(entry, 'id') === savedGuild);
  if (!member) return { ok: false, reason: 'このサーバーのメンバーではないようです。サーバーに参加してからもう一度お試しください。', status: 403 };

  const session: Session = {
    g: savedGuild,
    uid,
    name: (stringField(user, 'global_name') ?? stringField(user, 'username') ?? uid).slice(0, 40),
    avatar: stringField(user, 'avatar'),
    exp: Math.floor(deps.now() / 1000) + SESSION_SECONDS
  };
  const token = await signSession(session, env.SESSION_SECRET ?? '');
  const headersOut = new Headers({ location: asciiLocation(safeNext(decodeURIComponentSafe(savedNext), savedGuild)), 'cache-control': 'no-store' });
  headersOut.append('set-cookie', setCookie(url, sessionCookieName(savedGuild), token, { maxAge: SESSION_SECONDS, path: `/${savedGuild}` }));
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

// ---- bot のログインリンク -------------------------------------------------------

const LINK_PREFIX = 'sakana-memory-link.v1';
const LINK_JTI = '~link';

export interface LinkClaims {
  g: string;
  uid: string;
  name: string;
  avatar: string | null;
  iat: number;
  exp: number;
  jti: string;
}

function isLinkClaims(value: unknown): value is LinkClaims {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.g === 'string' && typeof c.uid === 'string' && typeof c.name === 'string' && (c.avatar === null || typeof c.avatar === 'string')
    && typeof c.iat === 'number' && typeof c.exp === 'number' && typeof c.jti === 'string' && c.jti.length >= 8 && c.jti.length <= 64;
}

/** 署名・サーバー・期限を確かめる。1回限りの確認 (jti) は finishLink で行う。 */
export async function verifyLinkToken(token: string, secret: string, guilds: string | readonly string[], now: number): Promise<LinkClaims | null> {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const signatureBytes = fromBase64Url(signature);
  if (!signatureBytes) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), signatureBytes, encoder.encode(`${LINK_PREFIX}.${payload}`));
  if (!ok) return null;
  const bytes = fromBase64Url(payload);
  if (!bytes) return null;
  try {
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    // 発行から 10 分以内・見せているサーバー宛て・未来すぎる発行時刻 (時計のずれ以上) は受け取らない
    return isLinkClaims(claims) && (typeof guilds === 'string' ? [guilds] : guilds).includes(claims.g) && claims.exp * 1000 > now && claims.iat * 1000 <= now + 60_000 && claims.exp - claims.iat <= 900 ? claims : null;
  } catch {
    return null;
  }
}

/** /auth/link?t=…&next=…: bot のリンクを受け取り、1回だけ使えるようにして cookie を渡す。 */
export async function finishLink(request: Request, env: Env, now = Date.now()): Promise<{ ok: true; response: Response } | { ok: false; reason: string; status: number }> {
  if (!linkConfigured(env)) return { ok: false, reason: 'このサイトではログインリンクが設定されていません。', status: 503 };
  const url = new URL(request.url);
  const claims = await verifyLinkToken(url.searchParams.get('t') ?? '', env.MEMORY_LINK_SECRET ?? '', memoryGuilds(env), now);
  if (!claims) return { ok: false, reason: 'このリンクは使えません (期限切れか、別のサーバーのものです)。Discord でもう一度 /memory url を使ってください。', status: 400 };
  // 1回限り: 使った jti を D1 に残し、同じリンクの2回目は断る。古い記録 (期限の2倍を過ぎたもの) はここで掃除する
  const [, inserted] = await env.LAWS.batch([
    env.LAWS.prepare('DELETE FROM memory_meta WHERE guild_id = ?1 AND CAST(value AS INTEGER) < ?2').bind(LINK_JTI, Math.floor(now / 1000) - 1800),
    env.LAWS.prepare('INSERT OR IGNORE INTO memory_meta (guild_id, key, value) VALUES (?1, ?2, ?3)').bind(LINK_JTI, claims.jti, String(claims.exp))
  ]);
  if (!inserted || (inserted.meta?.changes ?? 0) !== 1) {
    return { ok: false, reason: 'このリンクはもう使われています。Discord でもう一度 /memory url を使ってください。', status: 400 };
  }
  const session: Session = { g: claims.g, uid: claims.uid, name: claims.name.slice(0, 40), avatar: claims.avatar, exp: Math.floor(now / 1000) + SESSION_SECONDS };
  const headers = new Headers({ location: asciiLocation(safeNext(url.searchParams.get('next'), claims.g)), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  headers.append('set-cookie', setCookie(url, sessionCookieName(claims.g), await signSession(session, env.SESSION_SECRET ?? ''), { maxAge: SESSION_SECONDS, path: `/${claims.g}` }));
  return { ok: true, response: new Response(null, { status: 302, headers }) };
}

export function logoutResponse(request: Request, guild: string): Response {
  const url = new URL(request.url);
  return new Response(null, {
    status: 302,
    headers: { location: `/${guild}/wiki`, 'set-cookie': setCookie(url, sessionCookieName(guild), '', { maxAge: 0, path: `/${guild}` }), 'cache-control': 'no-store' }
  });
}
