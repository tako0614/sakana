import { claimEmbedText, dayOf, hasClaims, lexicalClaims, loadClaims, monthOf, rrf, MODALITY_LABEL, TYPE_LABEL, type ClaimView } from './claims.js';
import { jevJudge, type Judge } from './rerank.js';
import type { RecallParts } from './recall.js';
import { memoryDb } from './store.js';
import { embedQuery, hasKind, nearest, scoresFor } from './vectors.js';

// メモリパック。呼ばれたときの想起で、記憶の「見出し」でなく、依頼に関係する主張そのもの (日付・出典の出来事つき) を渡す。
//
//   1. 入口の門: 依頼が、このコミュニティの具体的な人・出来事・過去の話に触れていなければ、何も出さない (挨拶・雑談・一般知識)
//   2. 候補: 依頼を埋め込んだ近さ (主張・出来事) + 語彙 (文字 3-gram の BM25) を RRF で融合。依頼にメンション (<@id>) された人の主張は優先
//   3. 再順位づけ: 上位を判定モデル (rerank.ts) が 1 回で採点し、閾値以上だけを残す (埋め込みのコサインは関係の有無を選り分けられない)
//   4. 整理: 同じ文の主張・同じ出来事ばかりの重複を畳み、予算 (maxChars) に収める
//   判定モデルが使えない・主張の索引がまだ無いときは null (従来の見出しの想起に任せる)。何も当たらなければ空 (空は空)。

export const packConfig = {
  enabled: !['0', 'false', 'no', 'off'].includes(String(process.env.MEMORY_PACK ?? 'on').toLowerCase()),
  /** 入口の門。これ未満なら何も出さない */
  gate: Number(process.env.MEMORY_PACK_GATE ?? 0.2),
  /** 候補を残す関連の下限 */
  keep: Number(process.env.MEMORY_PACK_KEEP ?? 0.6),
  maxClaims: Number(process.env.MEMORY_PACK_CLAIMS ?? 6),
  maxEpisodes: Number(process.env.MEMORY_PACK_EPISODES ?? 2),
  /** 判定にかける主張・出来事の数 (質問が 20 個前後に収まる量) */
  claimCandidates: 14,
  episodeCandidates: 6,
  maxChars: Number(process.env.MEMORY_PACK_CHARS ?? 1800),
  perEpisode: 2
};

export interface PackDeps {
  embed?: (text: string, timeoutMs: number) => Promise<Float32Array | null>;
  judge?: Judge;
}

export const emptyParts = (): RecallParts => ({ text: '', paths: new Set(), episodeIds: new Set(), chunkIds: new Set() });

/** 依頼の文から、メンションされた人 (author_id) と、メンション・URL を除いた本文を取る。 */
export function splitRequest(request: string): { text: string; mentioned: string[] } {
  const mentioned = [...new Set([...request.matchAll(/<@!?(\d{15,25})>/g)].map((m) => m[1] as string))];
  const text = request.replace(/<@[!&]?\d+>/g, ' ').replace(/<#\d+>/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
  return { text, mentioned };
}

const normalized = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[\s\-_・.,、。!！?？「」『』()（）]/g, '');
const bigrams = (text: string): Set<string> => {
  const chars = [...normalized(text)];
  return new Set(chars.slice(0, -1).map((_, i) => chars.slice(i, i + 2).join('')));
};
const similar = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both += 1;
  return both / Math.min(a.size, b.size);
};

interface EpisodeCard { id: number; kind: string; title: string; summary: string; at_ms: number }

function episodeCards(ids: readonly number[]): Map<number, EpisodeCard> {
  const out = new Map<number, EpisodeCard>();
  const stmt = memoryDb().prepare<[number], EpisodeCard>('SELECT id, kind, title, summary, at_ms FROM episodes WHERE id = ?');
  for (const id of ids) {
    const row = stmt.get(id);
    if (row) out.set(id, row);
  }
  return out;
}

/** メンションされた人の主張 (依頼に近い順に最大 limit 件)。 */
function mentionedClaims(guildId: string, authorIds: readonly string[], vector: Float32Array | null, limit = 4): number[] {
  if (authorIds.length === 0) return [];
  const d = memoryDb();
  const ids: number[] = [];
  const find = d.prepare<[string, string], { id: number }>("SELECT id FROM v2_entities WHERE guild_id = ? AND kind = 'person' AND key = ?");
  const of = d.prepare<[number], { id: number }>("SELECT id FROM v2_claims WHERE entity_id = ? AND verdict <> 'wrong'");
  for (const authorId of authorIds.slice(0, 3)) {
    const entity = find.get(guildId, authorId);
    if (!entity) continue;
    const claimIds = of.all(entity.id).map((row) => row.id);
    if (vector) {
      const near = scoresFor(guildId, 'claim', vector, claimIds);
      ids.push(...[...near].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id));
    } else {
      ids.push(...claimIds.slice(-limit));
    }
  }
  return ids;
}

const claimLine = (claim: ClaimView): string => {
  const tags = [TYPE_LABEL[claim.type] ?? claim.type, MODALITY_LABEL[claim.modality] ?? '', claim.hedged ? '根拠弱' : ''].filter(Boolean).join('・');
  const who = claim.who ? `${claim.who} ` : '';
  return `- ${who}(${monthOf(claim.asOf)}・${tags}): ${claim.text}${claim.episodeId ? ` [e${claim.episodeId}]` : ''}`;
};

const clip = (text: string, limit: number): string => ([...text].length > limit ? `${[...text].slice(0, limit).join('')}…` : text);

/**
 * 呼ばれたときの想起 (メモリパック)。主張の索引が無い・判定モデルが使えないときは null。
 * 依頼に関係する記憶が無ければ、text が空の RecallParts (何も足さない)。
 */
export async function recallPack(guildId: string, { request }: { request: string }, deps: PackDeps = {}): Promise<RecallParts | null> {
  if (!packConfig.enabled || !hasClaims(guildId) || !hasKind(guildId, 'claim')) return null;
  const { text, mentioned } = splitRequest(request);
  if (!text && mentioned.length === 0) return emptyParts();
  const query = text || request;

  const embed = deps.embed ?? ((value: string, timeoutMs: number) => embedQuery(value, { timeoutMs }));
  const vector = await embed(query.slice(0, 500), 3000);
  if (!vector) return null;   // 埋め込みが間に合わない (モデルを起こしている途中)。従来の想起に任せる

  const dense = nearest(guildId, 'claim', vector, { limit: 40 }).map((hit) => hit.id);
  const lexical = lexicalClaims(guildId, query, 40);
  const entry = mentionedClaims(guildId, mentioned, vector);
  const fused = rrf([dense, lexical, entry], [1, 0.7, 1.2]);

  // 同じ文の重複を畳む (言い回しだけ違う主張で枠を埋めない)
  const loaded = loadClaims(guildId, fused.slice(0, 40));
  const picked: ClaimView[] = [];
  const grams: Set<string>[] = [];
  for (const id of fused) {
    const claim = loaded.get(id);
    if (!claim) continue;
    const g = bigrams(claim.text);
    if (grams.some((other) => similar(g, other) > 0.8)) continue;
    picked.push(claim);
    grams.push(g);
    if (picked.length >= packConfig.claimCandidates) break;
  }
  const episodeHits = nearest(guildId, 'episode', vector, { limit: packConfig.episodeCandidates }).map((hit) => hit.id);
  const cards = episodeCards(episodeHits);
  const episodes = episodeHits.map((id) => cards.get(id)).filter((card): card is EpisodeCard => Boolean(card));

  const items = [
    ...picked.map(claimEmbedText),
    ...episodes.map((card) => `${card.title}: ${clip(card.summary, 120)}`)
  ];
  if (items.length === 0) return emptyParts();
  const judged = await (deps.judge ?? jevJudge())(query, items);
  if (judged.gate === null && judged.scores === null) return null;   // 判定モデルが使えない。従来の想起に任せる
  if (judged.gate !== null && judged.gate < packConfig.gate) return emptyParts();
  if (!judged.scores) return null;

  const claimScores = judged.scores.slice(0, picked.length);
  const episodeScores = judged.scores.slice(picked.length);
  const keptClaims: ClaimView[] = [];
  const perEpisode = new Map<number, number>();
  picked.map((claim, i) => ({ claim, score: claimScores[i] ?? 0 })).sort((a, b) => b.score - a.score).forEach(({ claim, score }) => {
    if (score < packConfig.keep || keptClaims.length >= packConfig.maxClaims) return;
    const key = claim.episodeId ?? -claim.id;
    if ((perEpisode.get(key) ?? 0) >= packConfig.perEpisode) return;
    perEpisode.set(key, (perEpisode.get(key) ?? 0) + 1);
    keptClaims.push(claim);
  });
  const keptEpisodes = episodes.map((card, i) => ({ card, score: episodeScores[i] ?? 0 }))
    .filter(({ card, score }) => score >= packConfig.keep && !keptClaims.some((claim) => claim.episodeId === card.id))
    .sort((a, b) => b.score - a.score).slice(0, packConfig.maxEpisodes).map(({ card }) => card);
  if (keptClaims.length === 0 && keptEpisodes.length === 0) return emptyParts();

  const lines = ['思い出したこと (記憶のうち、この依頼に関係するもの。[e12] は根拠の出来事で、memory ツールの episode で開くと元の発言までたどれる):'];
  for (const claim of keptClaims) lines.push(claimLine(claim));
  if (keptEpisodes.length > 0) {
    lines.push('関係する出来事:');
    for (const card of keptEpisodes) lines.push(`- e${card.id} ${dayOf(card.at_ms)}${card.kind ? ` [${card.kind}]` : ''} ${card.title}: ${clip(card.summary, 140)}`);
  }
  const body = lines.join('\n');
  const paths = new Set(keptClaims.map((claim) => claim.path).filter(Boolean));
  const episodeIds = new Set<number>([...keptEpisodes.map((card) => card.id), ...keptClaims.flatMap((claim) => (claim.episodeId ? [claim.episodeId] : []))]);
  return { text: body.length > packConfig.maxChars ? `${body.slice(0, packConfig.maxChars)}…` : body, paths, episodeIds, chunkIds: new Set() };
}

