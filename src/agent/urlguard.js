// モデルが指定した URL の到達先を検査する。
//
// ホスト名の前方一致では守れない。169.254.169.254 (メタデータ) も
// [::ffff:7f00:1] (= 127.0.0.1) も localtest.me (DNS で 127.0.0.1 に解決される) も
// 「127. で始まらない」ので素通りする。だから判定は必ず「解決した IP」で行う。
// 逆に http://127.0.0.1.example.com のような名前は、解決先が公開 IP なら通してよい。
//
// リダイレクトとページ内 fetch も同じ関門を通す必要があるので、
// 1 URL = 1 判定の純粋な関数として切り出してある (browser.js が Fetch ドメインから呼ぶ)。

import dns from 'node:dns';
import net from 'node:net';

// about:blank だけは例外的に通す (タブの初期化に使う)。
// file: / data: / chrome: / devtools: / view-source: は AGENT_BROWSER_ALLOW_LOCAL でも開けない。
// ローカルファイルを読ませる用途はブラウザ経由でやるべきものではない。
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// 同じホストへの lookup を繰り返さない (ページ1枚でサブリソースごとに呼ばれる)。
const lookupCache = new Map();
const LOOKUP_TTL_MS = 60_000;
const LOOKUP_CACHE_MAX = 500;

function ipv4Blocked(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;

  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8 (0 は「このホスト」に化ける)
  if (a === 127) return true; // ループバック
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local と 169.254.169.254 (メタデータ)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF 予約
  if (a === 198 && (b === 18 || b === 19)) return true; // ベンチマーク用
  if (a >= 224) return true; // multicast と予約

  return false;
}

/**
 * IPv6 を 16bit×8 に展開する。
 * ::ffff:127.0.0.1 のような点表記も、::ffff:7f00:1 のような16進表記も
 * 同じ形に落として v4 として判定できるようにするために要る。
 */
function expandIpv6(input) {
  let text = String(input).toLowerCase().replace(/^\[|\]$/g, '');

  // 末尾が IPv4 表記なら 16bit 2つに畳む
  const tail = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(text);
  if (tail) {
    const octets = tail[1].split('.').map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n > 255)) return null;
    const hi = (((octets[0] << 8) | octets[1]) >>> 0).toString(16);
    const lo = (((octets[2] << 8) | octets[3]) >>> 0).toString(16);
    text = `${text.slice(0, tail.index)}:${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2
    ? (halves[1] ? halves[1].split(':').filter(Boolean) : [])
    : null;

  let groups;
  if (right === null) {
    groups = left;
  } else {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array(fill).fill('0'), ...right];
  }

  if (groups.length !== 8) return null;

  const out = groups.map((group) => parseInt(group, 16));
  return out.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ? null : out;
}

function ipv6Blocked(ip) {
  const groups = expandIpv6(ip);
  if (!groups) return true; // 解釈できないものは通さない

  // IPv4-mapped (::ffff:x) と IPv4-compatible (::x) は v4 として判定する
  if (groups.slice(0, 5).every((n) => n === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    if (groups[5] === 0 && groups[6] === 0 && groups[7] <= 1) return true; // :: と ::1
    const v4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
    return ipv4Blocked(v4);
  }

  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x64 && groups[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64 (内部 v4 に化ける)
  if (first === 0x2001 && groups[1] === 0x0db8) return true; // ドキュメント用

  return false;
}

/** この IP に出て行かせてよいか。判定できないものは全部止める。 */
export function isBlockedAddress(ip) {
  const version = net.isIP(String(ip).replace(/^\[|\]$/g, ''));
  if (version === 4) return ipv4Blocked(String(ip));
  if (version === 6) return ipv6Blocked(String(ip));
  return true;
}

async function resolveHost(hostname) {
  const cached = lookupCache.get(hostname);
  if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.addresses;

  let addresses = [];
  try {
    const found = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    addresses = found.map((entry) => entry.address);
  } catch {
    addresses = [];
  }

  // 上限を超えたら古いものから捨てる (Map は挿入順)
  if (lookupCache.size >= LOOKUP_CACHE_MAX) {
    lookupCache.delete(lookupCache.keys().next().value);
  }
  lookupCache.set(hostname, { at: Date.now(), addresses });

  return addresses;
}

/**
 * URL を検査して正規化する。
 * 例外は投げない — 呼び出し側がモデルへの文字列としてそのまま返せるように
 * { ok, url, reason } で返す (throw はツール失敗扱いになり、モデルが再試行を繰り返す)。
 */
export async function inspectUrl(input, { allowLocal = false } = {}) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'url を指定してください。' };

  let parsed;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: `URL として読めませんでした: ${trimmed.slice(0, 200)}` };
  }

  if (parsed.protocol === 'about:') {
    return parsed.href === 'about:blank'
      ? { ok: true, url: 'about:blank' }
      : { ok: false, reason: `この URL は開けません: ${parsed.href}` };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return {
      ok: false,
      reason: `${parsed.protocol} は開けません。http / https だけです。`
    };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) return { ok: false, reason: 'ホスト名がありません。' };

  if (allowLocal) return { ok: true, url: parsed.href };

  if (net.isIP(hostname)) {
    return isBlockedAddress(hostname)
      ? { ok: false, reason: `内部ネットワーク宛なので開けません: ${hostname}` }
      : { ok: true, url: parsed.href };
  }

  const addresses = await resolveHost(hostname);
  if (addresses.length === 0) {
    return { ok: false, reason: `ホスト名を解決できませんでした: ${hostname}` };
  }

  // 1つでも内部を指していたら止める。DNS が複数返すときに
  // 公開 IP だけ見て通すと、そのあと内部側に繋がれる可能性が残る。
  const blocked = addresses.find((address) => isBlockedAddress(address));
  if (blocked) {
    return {
      ok: false,
      reason: `${hostname} は内部アドレス (${blocked}) に解決されるので開けません。`
    };
  }

  return { ok: true, url: parsed.href };
}
