// 記憶の本のサイト (worker/ の /wiki) の URL。/memory url と explore の「サイトで開く」が使う。
//
// サイトの origin は MEMORY_SITE_PUBLIC_URL だけ (明示したときだけ出す)。法令集の URL (GOVERNANCE_LAW_SITE_URL) は
// 使わない: 同じ Worker でも、wiki を配備する前に URL だけが出て「not found」になった (2026-10-17)。
// https のサイトだけ (開発の localhost を除く)。
//
// サイトが見せるのは1つのサーバー (builder が記憶を作り、サイトへ送るサーバー = MEMORY_TREE_GUILD) だけ。
// 別のサーバーでは、そのサーバーのページを確かめても、別のサーバーのサイトへ案内してしまうので、リンクを出さない。

export type SiteTarget =
  | { kind: 'home' }
  | { kind: 'page'; path: string }
  | { kind: 'episode'; id: number };

export function siteOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.MEMORY_SITE_PUBLIC_URL ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url.origin : null;
  } catch {
    return null;
  }
}

/** サイトが見せるサーバー。 */
export function siteGuild(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = (env.MEMORY_SITE_GUILD ?? env.MEMORY_TREE_GUILD ?? '').trim();
  return /^\d+$/.test(id) ? id : null;
}

/** そのサーバーで案内してよいサイトの origin。サイトの対象のサーバーでなければ null。 */
export function siteOriginFor(guildId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const origin = siteOrigin(env);
  return origin && siteGuild(env) === guildId ? origin : null;
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
