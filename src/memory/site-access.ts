// 記憶のサイト (Worker) の公開状態を、bot の側から変える。/memory site と scripts/memory-site-access.ts が使う。
//
// 正本は bot の記憶 DB (site_access)。変えたら Worker の POST /v1/memory/access にも送り、同期 (scripts/memory-site-sync.ts) のたびに
// もう一度送る (Worker 側が空になっても、次の同期で戻る)。送れなくても bot 側の設定は残る (リンクは止まる)。
import { setSiteAccess, type SiteAccess } from './store.js';

export interface SiteApi { url: string; token: string }

/** Worker の入口。MEMORY_SITE_URL / TOKEN、無ければ法令集と同じ Worker (GOVERNANCE_LAW_API_URL / TOKEN)。未設定なら null。 */
export function siteApi(env: NodeJS.ProcessEnv = process.env): SiteApi | null {
  const url = (env.MEMORY_SITE_URL ?? env.GOVERNANCE_LAW_API_URL ?? '').trim().replace(/\/+$/, '');
  const token = (env.MEMORY_SITE_TOKEN ?? env.GOVERNANCE_LAW_API_TOKEN ?? '').trim();
  return url && token ? { url, token } : null;
}

export interface PushResult { ok: boolean; reason?: string }

type Fetch = typeof fetch;

/** Worker に公開状態を送る。失敗しても投げない (理由を返す)。 */
export async function pushSiteAccess(guildId: string, access: SiteAccess, by: string | null, { env = process.env, fetchImpl = fetch }: { env?: NodeJS.ProcessEnv; fetchImpl?: Fetch } = {}): Promise<PushResult> {
  const api = siteApi(env);
  if (!api) return { ok: false, reason: 'MEMORY_SITE_URL / MEMORY_SITE_TOKEN (または GOVERNANCE_LAW_API_URL / _TOKEN) が未設定です' };
  try {
    const response = await fetchImpl(`${api.url}/v1/memory/access`, {
      method: 'POST',
      headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ guildId, access, by }),
      signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) return { ok: true };
    const body = await response.text().catch(() => '');
    return { ok: false, reason: `サイトが ${response.status} を返しました${body ? `: ${body.slice(0, 120)}` : ''}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 公開状態を変える: bot の記憶 DB に書き、Worker にも送る。bot 側は必ず変わる。サイトに届いたかは pushed。 */
export async function changeSiteAccess(guildId: string, access: SiteAccess, by: string | null, deps: { env?: NodeJS.ProcessEnv; fetchImpl?: Fetch } = {}): Promise<PushResult> {
  setSiteAccess(guildId, access, by);
  return pushSiteAccess(guildId, access, by, deps);
}
