import { createHash } from 'node:crypto';
import { memoryDb } from './store.js';

// 主張 (v2) の索引。v2 の構築 (src/memory/v2) が作る v2_claims を、意味検索 (vectors.ts の kind = 'claim') と
// 語彙検索 (claims_fts、文字 3-gram の FTS5) で引けるようにする。
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
export const dayOf = (ms: number): string => new Date(ms + TZ_MS).toISOString().slice(0, 10);

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
  who: string;
  path: string;
  entityKind: string;
}

interface ClaimRow {
  id: number; text: string; type: string; modality: string; hedged: number; as_of: number; episode_id: number | null;
  who: string | null; path: string | null; ekind: string | null; about_key: string; verdict: string
}

const SELECT = `
  SELECT c.id, c.text, c.type, c.modality, c.hedged, c.as_of, c.episode_id, e.name AS who, e.path AS path, e.kind AS ekind, c.about_key, c.verdict
  FROM v2_claims c LEFT JOIN v2_entities e ON e.id = c.entity_id
`;

const view = (row: ClaimRow): ClaimView => ({
  id: row.id, text: row.text, type: row.type, modality: row.modality, hedged: row.hedged === 1, asOf: row.as_of, episodeId: row.episode_id,
  who: row.who ?? (row.about_key.length > 12 ? '' : row.about_key), path: row.path ?? '', entityKind: row.ekind ?? ''
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

export const claimHash = (model: string, text: string): string => createHash('sha1').update(model).update('\n').update(text).digest('hex');

// ---- 語彙 (文字 3-gram の BM25) ---------------------------------------------------

/** 質問の文字 3-gram (記号・空白をまたがない)。FTS5 の MATCH 式 ("abc" OR "bcd" …) にする。作れなければ null。 */
export function trigramMatch(query: string, limit = 80): string | null {
  const seen = new Set<string>();
  const grams: string[] = [];
  for (const piece of query.split(/[\s、。,.!！?？「」『』()（）[\]【】:：;；/／\-_~〜<>@#]+/)) {
    const chars = [...piece];
    for (let i = 0; i + 3 <= chars.length; i += 1) {
      const gram = chars.slice(i, i + 3).join('');
      if (!seen.has(gram)) { seen.add(gram); grams.push(gram); }
    }
  }
  if (grams.length === 0) return null;
  return grams.slice(0, limit).map((gram) => `"${gram.replace(/"/g, '""')}"`).join(' OR ');
}

/** claims_fts を作り直す (主張の数は数万で、数秒)。中身が変わっていなければ触らない。 */
export function syncClaimFts(guildId: string): number {
  if (!hasTable('v2_claims')) return 0;
  const d = memoryDb();
  d.exec("CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(text, who, tokenize='trigram')");
  const claims = allClaims(guildId);
  const signature = `${claims.length}:${claims.reduce((max, claim) => Math.max(max, claim.id), 0)}:${claims.reduce((sum, claim) => sum + claim.text.length, 0)}`;
  const state = d.prepare<[string], { value: string }>("SELECT value FROM state WHERE key = ?").get(`claims-fts:${guildId}`);
  if (state?.value === signature && d.prepare('SELECT 1 FROM claims_fts LIMIT 1').get()) return claims.length;
  const insert = d.prepare('INSERT INTO claims_fts(rowid, text, who) VALUES (?, ?, ?)');
  d.transaction(() => {
    d.exec('DELETE FROM claims_fts');
    for (const claim of claims) insert.run(claim.id, claim.text, claim.who);
    d.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`claims-fts:${guildId}`, signature);
  })();
  return claims.length;
}

/** 語彙で近い主張 (id、近い順)。claims_fts が無い・質問から 3-gram が取れないときは空。 */
export function lexicalClaims(guildId: string, query: string, limit = 40): number[] {
  const match = trigramMatch(query);
  if (!match || !hasTable('claims_fts')) return [];
  try {
    return memoryDb().prepare<[string, string, number], { rowid: number }>(`
      SELECT f.rowid AS rowid FROM claims_fts f JOIN v2_claims c ON c.id = f.rowid
      WHERE claims_fts MATCH ? AND c.guild_id = ? AND c.verdict <> 'wrong' ORDER BY bm25(claims_fts) LIMIT ?
    `).all(match, guildId, limit).map((row) => row.rowid);
  } catch {
    return [];
  }
}

/** 逆順位の融合 (RRF)。lists はそれぞれ近い順の id。重みつき。 */
export function rrf(lists: readonly (readonly number[])[], weights: readonly number[], k = 60): number[] {
  const score = new Map<number, number>();
  lists.forEach((list, index) => list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + (weights[index] ?? 1) / (k + rank + 1))));
  return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
