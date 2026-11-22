import { memoryDb } from './store.js';

// v2 の主張を意味検索の索引 (kind = 'claim') に載せる。
//   - 主張 1 つ = 1 つの命題。埋め込む文は「[誰 / 時期 / 種類] 本文」と文脈を前に付ける (短い主張でも誰の何の話かが残る)
//   - 使う主張: wrong 以外。冗談・仮定・ごっこも引ける (モデル種別を付けて出す)
//   - v2 の表が無い DB (v1 のまま) では何もしない

export const TYPE_LABEL: Record<string, string> = {
  stance: '立場', trait: '人柄', skill: '得意', relation: '関係', fact: '事実', definition: '用語', outcome: '結果'
};
export const MODALITY_LABEL: Record<string, string> = {
  plain: '', self_report: '', hearsay: '伝聞', joke: '冗談', hypothetical: '仮定', roleplay: 'ごっこ'
};

const TZ_MS = 9 * 3_600_000;
export const monthOf = (ms: number): string => new Date(ms + TZ_MS).toISOString().slice(0, 7);

const hasTable = (name: string): boolean =>
  Boolean(memoryDb().prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(name));

/** v2 の主張がある DB か。 */
export function hasClaims(guildId: string): boolean {
  if (!hasTable('v2_claims')) return false;
  return Boolean(memoryDb().prepare("SELECT 1 FROM v2_claims WHERE guild_id = ? AND verdict <> 'wrong' LIMIT 1").get(guildId));
}

export interface ClaimView {
  id: number;
  text: string;
  type: string;
  modality: string;
  hedged: boolean;
  asOf: number;
  episodeId: number | null;
  entityId: number | null;
  who: string;
  path: string;
}

interface ClaimRow {
  id: number; text: string; type: string; modality: string; hedged: number; as_of: number; episode_id: number | null;
  who: string | null; path: string | null; entity_id: number | null; about_key: string; verdict: string
}

const SELECT = `
  SELECT c.id, c.text, c.type, c.modality, c.hedged, c.as_of, c.episode_id, c.entity_id, e.name AS who, e.path AS path, c.about_key, c.verdict
  FROM v2_claims c LEFT JOIN v2_entities e ON e.id = c.entity_id
`;

const view = (row: ClaimRow): ClaimView => ({
  id: row.id, text: row.text, type: row.type, modality: row.modality, hedged: row.hedged === 1, asOf: row.as_of, episodeId: row.episode_id,
  entityId: row.entity_id, who: row.who ?? (row.about_key.length > 12 ? '' : row.about_key), path: row.path ?? ''
});

/** 検索の索引に入れる主張 (wrong 以外)。 */
export function allClaims(guildId: string): ClaimView[] {
  if (!hasTable('v2_claims')) return [];
  return memoryDb().prepare<[string], ClaimRow>(`${SELECT} WHERE c.guild_id = ? AND c.verdict <> 'wrong'`).all(guildId).map(view);
}

export function loadClaims(guildId: string, ids: readonly number[]): Map<number, ClaimView> {
  const out = new Map<number, ClaimView>();
  if (ids.length === 0 || !hasTable('v2_claims')) return out;
  const stmt = memoryDb().prepare<[string, number], ClaimRow>(`${SELECT} WHERE c.guild_id = ? AND c.id = ?`);
  for (const id of ids) {
    const row = stmt.get(guildId, id);
    if (row && row.verdict !== 'wrong') out.set(id, view(row));
  }
  return out;
}

/** 埋め込む文: 「[誰 / 時期 / 種類] 本文」。 */
export function claimEmbedText(claim: ClaimView): string {
  const modality = MODALITY_LABEL[claim.modality] ?? '';
  const head = [claim.who, monthOf(claim.asOf), `${TYPE_LABEL[claim.type] ?? claim.type}${modality ? `・${modality}` : ''}`].filter(Boolean).join(' / ');
  return `[${head}] ${claim.text}`;
}
