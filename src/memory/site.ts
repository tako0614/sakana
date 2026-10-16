// 記憶の本のサイト (worker/ の /wiki) の URL。/memory url と explore の「サイトで開く」が使う。
//
// サイトの origin は MEMORY_SITE_PUBLIC_URL、無ければ法令集と同じ GOVERNANCE_LAW_SITE_URL
// (同じ Worker なので、法令集の設定が済んでいればそのまま使える)。https のサイトだけ (開発の localhost を除く)。

export type SiteTarget =
  | { kind: 'home' }
  | { kind: 'page'; path: string }
  | { kind: 'episode'; id: number };

export function siteOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.MEMORY_SITE_PUBLIC_URL ?? env.GOVERNANCE_LAW_SITE_URL ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url.origin : null;
  } catch {
    return null;
  }
}

/** サイトの URL。パスの区切りは / のまま、各部分だけ percent-encode する。 */
export function siteUrl(origin: string, target: SiteTarget): string {
  if (target.kind === 'episode') return `${origin}/e/${target.id}`;
  if (target.kind === 'page') return `${origin}/wiki/${target.path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
  return `${origin}/wiki`;
}

/** 'e12' / 'E12' / '12' → 12。それ以外は null。 */
export function parseEpisodeId(text: string): number | null {
  const match = /^\s*e?(\d{1,9})\s*$/i.exec(text);
  const id = match?.[1] ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
