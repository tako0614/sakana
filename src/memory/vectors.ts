// 記憶 (ページ・出来事・ページの中の1つの知識) の意味ベクトル。
//
// 名前の照合 (recall.ts) と全文検索は、言葉が一致しないと引けない。「レビューを飛ばした」話から
// 「ダブスタ」のページを思い出すには、意味で引く必要がある。ここでは、ページと出来事の短い文と、
// ページの本文を 1 行ずつに割った断片 (chunks.ts) を、ローカルの埋め込み (会話のログと同じ e5-small、src/embed) でベクトルにして memory.sqlite に持ち、
// 想起 (呼ばれたとき・考えている途中) と memory ツールの検索から近い順に引く。
//
// 重い処理は bot の中の1か所 (index.ts の定期実行) だけ。builder は別プロセスで、Python を起こさない。
// 本番 (HDD) ではモデルの読み込みに分単位かかることがあるので、質問側は短い時間で見切って、
// 間に合わなければ名前の想起だけで続ける (ロードは裏で進むので、次の往復には間に合う)。

import { createHash } from 'node:crypto';
import { embedConfig } from '../embed/config.js';
import { memoryWorker } from '../embed/worker.js';
import { bestLine, chunkText, syncChunks } from './chunks.js';
import { allClaims, claimEmbedText, hasClaims, loadClaims, type ClaimView } from './claims.js';
import { memoryDb } from './store.js';

type Kind = 'node' | 'episode' | 'chunk' | 'claim';
type EmbedFn = (texts: readonly string[], kind: 'passage' | 'query') => Promise<{ dim: number; vectors: string[] }>;

const defaultEmbed: EmbedFn = async (texts, kind) => {
  const reply = await memoryWorker().embedTexts(texts, { kind, encode: 'float32' });
  return { dim: reply.dim, vectors: reply.vectors };
};

let embedder: EmbedFn = defaultEmbed;
/** 検証用: 埋め込みを差し替える (引数なしで元に戻す)。 */
export function setEmbedder(fn?: EmbedFn): void {
  embedder = fn ?? defaultEmbed;
  matrices.clear();
}

const modelKey = (): string => embedConfig.memory.modelName;
const hashOf = (text: string): string => createHash('sha1').update(modelKey()).update('\n').update(text).digest('hex');

// ---- 何を埋め込むか -------------------------------------------------------------

const plain = (text: string): string => text.replace(/\[\[([^\]]*)\]\]/g, '$1').replace(/\[e\d+\]/g, '').replace(/\s+/g, ' ').trim();

function parseAliases(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

interface NodeSource { id: number; path: string; summary: string; body: string; pending: string; aliases: string }
interface EpisodeSource { id: number; kind: string; title: string; summary: string }

/** ページの要点: 名前・別名・要約・本文の頭。中身が無いページは null (振らない)。 */
export function nodeText(node: NodeSource): string | null {
  const content = plain(node.body || node.pending).slice(0, 500);
  if (!node.summary && !content) return null;
  const aliases = parseAliases(node.aliases);
  const head = `${node.path || '記憶の根'}${aliases.length ? ` (${aliases.slice(0, 6).join(', ')})` : ''}`;
  return [head, node.summary, content].filter(Boolean).join('\n');
}

export function episodeText(episode: EpisodeSource): string {
  return [`${episode.kind ? `[${episode.kind}] ` : ''}${episode.title}`, plain(episode.summary).slice(0, 500)].filter(Boolean).join('\n');
}

interface Item { kind: Kind; id: number; text: string; hash: string }

function itemsOf(guildId: string): Item[] {
  const db = memoryDb();
  const items: Item[] = [];
  for (const node of db.prepare<[string], NodeSource>('SELECT id, path, summary, body, pending, aliases FROM nodes WHERE guild_id = ?').all(guildId)) {
    const text = nodeText(node);
    if (text) items.push({ kind: 'node', id: node.id, text, hash: hashOf(text) });
  }
  for (const episode of db.prepare<[string], EpisodeSource>('SELECT id, kind, title, summary FROM episodes WHERE guild_id = ?').all(guildId)) {
    const text = episodeText(episode);
    items.push({ kind: 'episode', id: episode.id, text, hash: hashOf(text) });
  }
  // ページの中の1つの知識 (syncChunks が本文から作った表)。ページ名と節が付くので、誰の何の話かが残る。
  // v2 の記憶は主張が同じ粒度の知識なので、断片は振らない (同じ文を二重に振って、検索でも重なるため)
  const claimsMode = hasClaims(guildId);
  if (!claimsMode) for (const chunk of db.prepare<[string], { id: number; path: string; heading: string; text: string; aliases: string }>(
    'SELECT c.id, c.path, c.heading, c.text, n.aliases FROM memory_chunks c JOIN nodes n ON n.id = c.node_id WHERE c.guild_id = ?').all(guildId)) {
    const text = chunkText(chunk.path, parseAliases(chunk.aliases), chunk.heading, chunk.text);
    items.push({ kind: 'chunk', id: chunk.id, text, hash: hashOf(text) });
  }
  // v2 の主張 (1 つの命題)。「[誰 / 時期 / 種類] 本文」の形で埋め込む (claims.ts)
  for (const claim of allClaims(guildId)) {
    const text = claimEmbedText(claim);
    items.push({ kind: 'claim', id: claim.id, text, hash: hashOf(text) });
  }
  return items;
}

// ---- ベクトルの形 ---------------------------------------------------------------

function decode(base64: string, dim: number): Float32Array | null {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.byteLength < dim * Float32Array.BYTES_PER_ELEMENT) return null;
  const vector = new Float32Array(dim);
  new Uint8Array(vector.buffer).set(bytes.subarray(0, dim * Float32Array.BYTES_PER_ELEMENT));
  let norm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return null;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let index = 0; index < dim; index += 1) vector[index] = (vector[index] ?? 0) / norm;
  return vector;
}

// ---- 振る (定期実行) -----------------------------------------------------------

export interface SyncResult {
  embedded: number;
  remaining: number;
  removed: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let syncing = false;

/**
 * 変わったものだけ振り直し、無くなったものを消す。中身 (text_hash) で比べるので、
 * builder がページを書き直したぶんだけが対象になる。途中で止めても、次の回が続きから進める。
 */
export async function syncMemoryVectors(guildId: string,
  { batchSize = 32, sleepMs = 100, deadlineMs = 15 * 60_000 }: { batchSize?: number; sleepMs?: number; deadlineMs?: number } = {}): Promise<SyncResult> {
  if (syncing) return { embedded: 0, remaining: 0, removed: 0 };
  syncing = true;
  try {
    const db = memoryDb();
    // 先に本文から断片の表を作り直す (builder が書き直したぶんだけ変わる。SQL だけで済む)
    // 主張のある記憶 (v2) は主張が 1 つの知識なので、本文を 1 行ずつに割った断片の表は作らない (本文が数十万字になるページもある)
    if (!hasClaims(guildId)) syncChunks(guildId);
    const items = itemsOf(guildId);
    const stored = new Map<string, string>();
    for (const row of db.prepare<[string, string], { kind: string; id: number; text_hash: string }>(
      'SELECT kind, id, text_hash FROM memory_vectors WHERE guild_id = ? AND model = ?').iterate(guildId, modelKey())) {
      stored.set(`${row.kind}:${row.id}`, row.text_hash);
    }
    const live = new Set(items.map((item) => `${item.kind}:${item.id}`));
    let removed = 0;
    const drop = db.prepare<[string, string, number]>('DELETE FROM memory_vectors WHERE guild_id = ? AND kind = ? AND id = ?');
    for (const key of stored.keys()) {
      if (live.has(key)) continue;
      const [kind = '', id = '0'] = key.split(':');
      drop.run(guildId, kind, Number(id));
      removed += 1;
    }
    // 別モデルの古い行は使わないので、ここで消す (同じ主キーの行を上書きするため)
    db.prepare('DELETE FROM memory_vectors WHERE guild_id = ? AND model <> ?').run(guildId, modelKey());

    const todo = items.filter((item) => stored.get(`${item.kind}:${item.id}`) !== item.hash);
    const put = db.prepare<[string, string, number, string, string, Buffer, number]>(`
      INSERT INTO memory_vectors (guild_id, kind, id, model, text_hash, vec, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (guild_id, kind, id) DO UPDATE SET model = excluded.model, text_hash = excluded.text_hash, vec = excluded.vec, updated_at = excluded.updated_at
    `);
    const startedAt = Date.now();
    let embedded = 0;
    for (let from = 0; from < todo.length; from += batchSize) {
      if (Date.now() - startedAt > deadlineMs) break;
      const batch = todo.slice(from, from + batchSize);
      const reply = await embedder(batch.map((item) => item.text), 'passage');
      if (reply.vectors.length !== batch.length) throw new Error(`memory vectors: expected ${batch.length} vectors, got ${reply.vectors.length}`);
      const now = Date.now();
      db.transaction(() => {
        batch.forEach((item, index) => {
          const vector = decode(reply.vectors[index] ?? '', reply.dim);
          if (!vector) return;   // 壊れたベクトルは保存しない (次の回でもう一度)
          put.run(guildId, item.kind, item.id, modelKey(), item.hash, Buffer.from(vector.buffer), now);
          embedded += 1;
        });
      })();
      if (sleepMs > 0) await sleep(sleepMs);
    }
    return { embedded, remaining: Math.max(0, todo.length - embedded), removed };
  } finally {
    syncing = false;
  }
}

/** 記憶のあるサーバーぜんぶで、変わったぶんを振り直す (夜間と起動の少しあと)。失敗しても次の回がある。 */
export async function sweepMemoryVectors(): Promise<void> {
  if (!embedConfig.enabled || memoryWorker().isDisabled()) return;
  const guilds = memoryDb().prepare<[], { guild_id: string }>('SELECT DISTINCT guild_id FROM nodes').all().map((row) => row.guild_id);
  for (const guildId of guilds) {
    const result = await syncMemoryVectors(guildId);
    if (result.embedded || result.removed) {
      console.log(`Memory vectors in ${guildId}: embedded ${result.embedded}, removed ${result.removed}, remaining ${result.remaining}.`);
    }
  }
}

/** ベクトルを持つサーバーが記憶にあるか (想起で意味検索を試す価値があるか)。 */
export function hasVectors(guildId: string): boolean {
  return Boolean(memoryDb().prepare('SELECT 1 FROM memory_vectors WHERE guild_id = ? AND model = ? LIMIT 1').get(guildId, modelKey()));
}

/** その種類のベクトルを持つか (主張の索引がまだ振られていない DB で、新しい想起を使わないため)。 */
export function hasKind(guildId: string, kind: Kind): boolean {
  return Boolean(memoryDb().prepare('SELECT 1 FROM memory_vectors WHERE guild_id = ? AND kind = ? AND model = ? LIMIT 1').get(guildId, kind, modelKey()));
}

// ---- 引く ---------------------------------------------------------------------

interface Matrix {
  db: ReturnType<typeof memoryDb>;
  model: string;
  revision: number;
  dim: number;
  ids: number[];
  values: Float32Array;
}
const matrices = new Map<string, Matrix>();

function matrixFor(guildId: string, kind: Kind): Matrix | null {
  const db = memoryDb();
  // SQLite triggers bump this only for writes to this guild and kind, including
  // writes made by another connection. Legacy rows have an implicit revision 0.
  const revision = db.prepare<[string, string], { revision: number }>(
    'SELECT revision FROM memory_vector_revisions WHERE guild_id = ? AND kind = ?').get(guildId, kind)?.revision ?? 0;
  const model = modelKey();
  const key = `${guildId}:${kind}`;
  const cached = matrices.get(key);
  if (cached?.db === db && cached.model === model && cached.revision === revision) return cached;

  const rows = db.prepare<[string, string, string], { id: number; vec: Buffer }>(
    'SELECT id, vec FROM memory_vectors WHERE guild_id = ? AND kind = ? AND model = ?').all(guildId, kind, model);
  if (rows.length === 0) { matrices.delete(key); return null; }
  const dim = (rows[0]?.vec.byteLength ?? 0) / Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isInteger(dim) || dim <= 0) { matrices.delete(key); return null; }
  const usable = rows.filter((row) => row.vec.byteLength === dim * Float32Array.BYTES_PER_ELEMENT);
  const values = new Float32Array(usable.length * dim);
  usable.forEach((row, index) => {
    values.set(new Float32Array(row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength)), index * dim);
  });
  const ids = usable.map((row) => row.id);
  const matrix: Matrix = { db, model, revision, dim, ids, values };
  matrices.set(key, matrix);
  return matrix;
}

export interface VectorHit { id: number; score: number }

/** 質問のベクトルに近い順。exclude の id は除く。 */
export function nearest(guildId: string, kind: Kind, query: Float32Array, { limit = 5, exclude }: { limit?: number; exclude?: ReadonlySet<number> } = {}): VectorHit[] {
  const topCount = Math.trunc(limit);
  if (topCount === 0 || Number.isNaN(topCount)) return [];
  const matrix = matrixFor(guildId, kind);
  if (!matrix || matrix.dim !== query.length) return [];
  // 通常は上位 5〜40 件を保持する。同点は行順。大きな limit では配列への逐次挿入を避ける。
  const bounded = topCount > 0 && topCount <= 128;
  const hits: VectorHit[] = [];
  for (let row = 0; row < matrix.ids.length; row += 1) {
    const id = matrix.ids[row] as number;
    if (exclude?.has(id)) continue;
    let score = 0;
    const base = row * matrix.dim;
    for (let index = 0; index < matrix.dim; index += 1) score += (matrix.values[base + index] ?? 0) * (query[index] ?? 0);
    if (bounded) {
      if (hits.length === topCount && score <= (hits[topCount - 1]?.score ?? -Infinity)) continue;
      let low = 0;
      let high = hits.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (score > (hits[mid]?.score ?? -Infinity)) high = mid;
        else low = mid + 1;
      }
      hits.splice(low, 0, { id, score });
      if (hits.length > topCount) hits.pop();
    } else {
      hits.push({ id, score });
    }
  }
  return bounded ? hits : hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * 質問文をベクトルにする。timeoutMs で見切る (null)。モデルが眠っていたら起こしておく。
 * 見切った後も読み込みは裏で続くので、次の往復には間に合う。
 */
// モデルがまだ起きていないとき、1度見切ったら少しのあいだは待たずに諦める
// (往復のたびに数秒ずつ待たせない。読み込みは prewarm で裏に進んでいる)。
let coldUntil = 0;
const COLD_SKIP_MS = 30_000;

type QueryEmbedding = { vector: Float32Array | null; status: 'ok' | 'cold_or_timeout' | 'embed_failure' };

async function queryEmbedding(text: string, timeoutMs: number): Promise<QueryEmbedding> {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!clean || !embedConfig.enabled || memoryWorker().isDisabled()) return { vector: null, status: 'embed_failure' };
  const real = embedder === defaultEmbed;
  const cold = real && memoryWorker().workerInfo() === null;
  if (cold) {
    memoryWorker().prewarm();
    if (Date.now() < coldUntil) return { vector: null, status: 'cold_or_timeout' };
  }
  const work = embedder([clean], 'query').then((reply): QueryEmbedding => {
    const vector = decode(reply.vectors[0] ?? '', reply.dim);
    return { vector, status: vector ? 'ok' : 'embed_failure' };
  }, (): QueryEmbedding => ({ vector: null, status: 'embed_failure' }));
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const limit = new Promise<QueryEmbedding>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve({ vector: null, status: 'cold_or_timeout' }); }, timeoutMs); });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
    if (cold && timedOut) coldUntil = Date.now() + COLD_SKIP_MS;
  }
}

export async function embedQuery(text: string, { timeoutMs = 3000 }: { timeoutMs?: number } = {}): Promise<Float32Array | null> {
  return (await queryEmbedding(text, timeoutMs)).vector;
}

export interface MeaningNode { path: string; summary: string; score: number }
export interface MeaningEpisode { id: number; kind: string; title: string; atMs: number; score: number }
/** ページの中の1つの知識 (まとめた断片なら、その中で質問にいちばん近い行を line に)。episodeIds は根拠の出来事 (開くと原文までたどれる)。 */
export interface MeaningChunk { id: number; path: string; heading: string; text: string; line: string; episodeIds: number[]; score: number; more: number; claim?: ClaimView }
export interface Meaning { nodes: MeaningNode[]; episodes: MeaningEpisode[]; chunks: MeaningChunk[] }
export interface MeaningTrace {
  status: 'no_vectors' | 'cold_or_timeout' | 'embed_failure' | 'no_candidates' | 'below_cutoff' | 'matched';
  embedMs: number;
  searchMs: number;
  candidateCounts: { node: number; episode: number; claim: number; chunk: number };
  selectedCounts: { node: number; episode: number; claim: number; chunk: number };
}

export interface AutoRecallAnchor { anchorText: string; mentionedUserIds?: readonly string[] }

// 1位からこれ以上離れたものは捨てる。e5 は無関係な文どうしでも高い値が出るので、順位と1位との差でも絞る。
// 本番の実データで測った (2026-10-17、ページ 4,242 件・出来事 11,917 件): 関係のある質問の1位は 0.87〜0.91、
// 関係のない質問 (天気・おなかすいた・ころすよ) は 0.80〜0.84、抽象的な雑談は 0.85〜0.86。
// 下限 0.85 で「何も似ていない質問」は何も出さない。上位は 0.01〜0.02 差で団子になるので、差は 0.02。
const gap = Number(process.env.MEMORY_RECALL_GAP ?? 0.02);
const floor = Number(process.env.MEMORY_RECALL_FLOOR ?? 0.85);
// 断片 (ページの中の1つの知識) の下限と差。実データの短い質問で決めた (本番、2026-10-18、docs/memory-chunks.md):
// 関係のある質問 10 件の 1 位は 0.861〜0.915、関係のない質問 8 件の 1 位は 0.805〜0.853 (「おはよう」だけ名前の一致で 0.873)。
// 長い文 (出来事の要約) を質問にした測定では 0.89 未満の正解率が低かったが、実際の質問は短く、スコアが低めに出る。
const chunkGap = Number(process.env.MEMORY_CHUNK_GAP ?? 0.02);
const chunkFloor = Number(process.env.MEMORY_CHUNK_FLOOR ?? 0.865);
/** 1ページから出す節の上限 (同じページの似た節で枠を埋めない)。 */
const CHUNKS_PER_PAGE = 2;

const emptyCounts = (): MeaningTrace['candidateCounts'] => ({ node: 0, episode: 0, claim: 0, chunk: 0 });
const normalized = (text: string): string => text.normalize('NFKC').toLowerCase();

// Only the request/reply anchor supplies exact evidence. Unquoted common prose
// never lowers the semantic floor. Cap both the number of terms and the bonus.
interface AnchorEvidence { quoted: string[]; latin: RegExp[]; months: ReadonlySet<string>; people: ReadonlySet<string> }

function anchorEvidence(anchor: AutoRecallAnchor): AnchorEvidence {
  const raw = anchor.anchorText.slice(0, 1200).normalize('NFKC');
  const text = raw.toLowerCase();
  const quoted = [...text.matchAll(/[「『"`']([^」』"`']{3,40})[」』"`']/g)]
    .map((match) => match[1]?.trim() ?? '').filter((term) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term)).slice(0, 6);
  const latin = [...new Set((raw.match(/\b(?:[A-Z][A-Za-z0-9_.-]{3,30}|[A-Za-z][A-Za-z0-9]*[._-][A-Za-z0-9._-]{2,30})\b/g) ?? [])
    .map(normalized))].slice(0, 8).map((term) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i'));
  const months = new Set([...new Set(text.match(/\b20\d{2}-(?:0[1-9]|1[0-2])\b/g) ?? [])].slice(0, 4));
  for (const match of text.matchAll(/(20\d{2})年(1[0-2]|0?[1-9])月/g)) {
    if (months.size >= 4) break;
    months.add(`${match[1]}-${(match[2] ?? '').padStart(2, '0')}`);
  }
  return { quoted, latin, months, people: new Set(anchor.mentionedUserIds ?? []) };
}

function anchorBonus(text: string, atMs: number, evidence: AnchorEvidence, personId?: string | null): number {
  const body = evidence.quoted.length || evidence.latin.length ? normalized(text) : '';
  let bonus = 0;
  if (evidence.quoted.some((term) => body.includes(term))) bonus += 0.03;
  for (const term of evidence.latin) if (term.test(body)) bonus += 0.015;
  if (personId && evidence.people.has(personId)) bonus += 0.035;
  if (evidence.months.size) {
    const date = new Date(atMs + 9 * 3_600_000);
    if (Number.isFinite(date.getTime()) && evidence.months.has(date.toISOString().slice(0, 7))) bonus += 0.005;
  }
  return Math.min(0.035, bonus);
}

function autoMeaning(guildId: string, query: Float32Array, anchor: AutoRecallAnchor,
  { episodeLimit, chunkLimit, excludeEpisodes, excludeChunks, minScore }: {
    episodeLimit: number; chunkLimit: number; excludeEpisodes?: ReadonlySet<number>; excludeChunks?: ReadonlySet<number>; minScore?: number;
  }, counts: MeaningTrace['candidateCounts']): Meaning {
  const db = memoryDb();
  const episodeRaw = episodeLimit > 0 ? nearest(guildId, 'episode', query, { limit: 32, exclude: excludeEpisodes }) : [];
  const claimRaw = chunkLimit > 0 ? nearest(guildId, 'claim', query, { limit: 64, exclude: excludeChunks }) : [];
  counts.episode = episodeRaw.length;
  counts.claim = claimRaw.length;
  const evidence = anchorEvidence(anchor);
  const bestClaim = claimRaw[0]?.score ?? -Infinity;
  const base = minScore ?? chunkFloor;
  const hasClaimAnchor = evidence.quoted.length > 0 || evidence.latin.length > 0 || evidence.people.size > 0;
  const possibleClaims = claimRaw.filter((hit) =>
    (hit.score >= base && hit.score >= bestClaim - chunkGap) || (hasClaimAnchor && hit.score >= base - 0.02));
  const claims = loadClaims(guildId, possibleClaims.map((hit) => hit.id));
  const ranked = possibleClaims.flatMap((hit) => {
    const claim = claims.get(hit.id);
    if (!claim || (!claim.path && claim.episodeId === null)) return [];
    const bonus = anchorBonus(`${claim.who} ${claim.text}`, claim.asOf, evidence, claim.personId);
    const semantic = hit.score >= base && hit.score >= bestClaim - chunkGap;
    const anchored = bonus > 0.005 && hit.score >= base - Math.min(0.02, bonus);
    return semantic || anchored ? [{ claim, score: hit.score, rank: hit.score + bonus }] : [];
  }).sort((a, b) => b.rank - a.rank || b.score - a.score);
  const unique = new Map<string, (typeof ranked)[number]>();
  for (const item of ranked) {
    const c = item.claim;
    const modality = c.modality === 'self_report' ? 'plain' : c.modality;
    const key = c.entityId === null ? String(c.id) : JSON.stringify([c.entityId, c.episodeId, c.type, c.asOf, modality, c.hedged, normalized(c.text).replace(/[\s、。]/g, '')]);
    const previous = unique.get(key);
    if (!previous || (previous.claim.modality === 'plain' && c.modality === 'self_report')) unique.set(key, item);
  }
  const chunks: MeaningChunk[] = [];
  const used = new Set<number>();
  const perPage = new Map<string, number>();
  const perEpisode = new Map<number, number>();
  // One claim per source first; a second pass fills remaining slots without
  // letting repeated claims from one episode crowd out independent evidence.
  for (const sourceCap of [1, 2]) for (const { claim, score } of unique.values()) {
    if (chunks.length >= chunkLimit || used.has(claim.id)) continue;
    if (claim.path && (perPage.get(claim.path) ?? 0) >= CHUNKS_PER_PAGE) continue;
    const source = claim.episodeId;
    if (source !== null && (perEpisode.get(source) ?? 0) >= sourceCap) continue;
    used.add(claim.id);
    if (claim.path) perPage.set(claim.path, (perPage.get(claim.path) ?? 0) + 1);
    if (source !== null) perEpisode.set(source, (perEpisode.get(source) ?? 0) + 1);
    chunks.push({ id: claim.id, path: claim.path, heading: '', text: claim.text, line: claim.text, episodeIds: source === null ? [] : [source], score, more: 0, claim });
  }
  const selectedSources = new Set(chunks.flatMap((chunk) => chunk.episodeIds));
  const availableEpisodes = episodeRaw.filter((hit) => !selectedSources.has(hit.id));
  const bestEpisode = availableEpisodes[0]?.score ?? -Infinity;
  const episodeFloor = minScore ?? floor;
  const episodes: MeaningEpisode[] = [];
  const hasEpisodeAnchor = evidence.quoted.length > 0 || evidence.latin.length > 0;
  const possibleEpisodes = availableEpisodes.filter((hit) =>
    (hit.score >= episodeFloor && hit.score >= bestEpisode - gap) || (hasEpisodeAnchor && hit.score >= episodeFloor - 0.02));
  const readEpisode = db.prepare<[string, number], { id: number; kind: string; title: string; summary: string; at_ms: number }>(
    'SELECT id, kind, title, summary, at_ms FROM episodes WHERE guild_id = ? AND id = ?');
  const rankedEpisodes = possibleEpisodes.flatMap((hit) => {
    const row = readEpisode.get(guildId, hit.id);
    if (!row) return [];
    const bonus = anchorBonus(`${row.title} ${row.kind} ${row.summary ?? ''}`, row.at_ms, evidence);
    const semantic = hit.score >= episodeFloor && hit.score >= bestEpisode - gap;
    const anchored = bonus > 0.005 && hit.score >= episodeFloor - Math.min(0.02, bonus);
    return semantic || anchored ? [{ row, score: hit.score, rank: hit.score + bonus }] : [];
  }).sort((a, b) => b.rank - a.rank || b.score - a.score);
  for (const { row, score } of rankedEpisodes.slice(0, episodeLimit)) {
    episodes.push({ id: row.id, kind: row.kind, title: row.title, atMs: row.at_ms, score });
  }
  return { nodes: [], episodes, chunks };
}

/**
 * 文に意味が近いページ・出来事・ページの中の1つの知識。ベクトルが無い・間に合わない・近いものが無ければ null。
 * 自動想起では minScore に関係の下限を渡し、明示的な検索では既定の下限を使う。
 */
export async function meaningOf(guildId: string, text: string,
  { nodeLimit = 2, episodeLimit = 3, chunkLimit = 3, excludePaths, excludeEpisodes, excludeChunks, timeoutMs = 3000, minScore, autoRecall, onTrace }: {
    nodeLimit?: number; episodeLimit?: number; chunkLimit?: number; excludePaths?: ReadonlySet<string>; excludeEpisodes?: ReadonlySet<number>;
    excludeChunks?: ReadonlySet<number>; timeoutMs?: number;
    minScore?: number; autoRecall?: AutoRecallAnchor; onTrace?: (trace: MeaningTrace) => void;
  } = {}): Promise<Meaning | null> {
  const candidateCounts = emptyCounts();
  const selectedCounts = emptyCounts();
  let embedMs = 0;
  let searchMs = 0;
  const emit = (status: MeaningTrace['status']): void => {
    try { onTrace?.({ status, embedMs, searchMs, candidateCounts, selectedCounts }); } catch { /* diagnostics cannot fail recall */ }
  };
  if (!text.trim()) { emit('no_candidates'); return null; }
  if (!hasVectors(guildId)) { emit('no_vectors'); return null; }
  const embedStart = performance.now();
  const embedded = await queryEmbedding(text, timeoutMs);
  embedMs = performance.now() - embedStart;
  if (!embedded.vector) { emit(embedded.status === 'cold_or_timeout' ? 'cold_or_timeout' : 'embed_failure'); return null; }
  const query = embedded.vector;
  const searchStart = performance.now();
  if (autoRecall && hasKind(guildId, 'claim')) {
    const result = autoMeaning(guildId, query, autoRecall, { episodeLimit, chunkLimit, excludeEpisodes, excludeChunks, minScore }, candidateCounts);
    searchMs = performance.now() - searchStart;
    selectedCounts.episode = result.episodes.length;
    selectedCounts.claim = result.chunks.length;
    emit(result.episodes.length || result.chunks.length ? 'matched' : candidateCounts.episode || candidateCounts.claim ? 'below_cutoff' : 'no_candidates');
    return result.episodes.length || result.chunks.length ? result : null;
  }
  const db = memoryDb();

  const skipNodes = new Set<number>();
  if (excludePaths?.size) {
    for (const path of excludePaths) {
      const row = db.prepare<[string, string], { id: number }>('SELECT id FROM nodes WHERE guild_id = ? AND path = ?').get(guildId, path);
      if (row) skipNodes.add(row.id);
    }
  }
  const pick = (hits: VectorHit[]): VectorHit[] => {
    const best = hits[0]?.score ?? 0;
    return hits.filter((hit) => hit.score >= (minScore ?? floor) && hit.score >= best - gap);
  };
  // 根 (全体の概要) は常に何かに近いので出さない
  const rawNodes = nodeLimit > 0 ? nearest(guildId, 'node', query, { limit: nodeLimit + 1, exclude: skipNodes }) : [];
  const rawEpisodes = episodeLimit > 0 ? nearest(guildId, 'episode', query, { limit: episodeLimit, ...(excludeEpisodes ? { exclude: excludeEpisodes } : {}) }) : [];
  candidateCounts.node = rawNodes.length;
  candidateCounts.episode = rawEpisodes.length;
  const nodeHits = pick(rawNodes).slice(0, nodeLimit);
  const episodeHits = pick(rawEpisodes);

  const nodes: MeaningNode[] = [];
  for (const hit of nodeHits) {
    const row = db.prepare<[number], { path: string; summary: string }>('SELECT path, summary FROM nodes WHERE id = ?').get(hit.id);
    if (row && row.path) nodes.push({ path: row.path, summary: row.summary, score: hit.score });
  }
  const episodes: MeaningEpisode[] = [];
  for (const hit of episodeHits) {
    const row = db.prepare<[number], { id: number; kind: string; title: string; at_ms: number }>('SELECT id, kind, title, at_ms FROM episodes WHERE id = ?').get(hit.id);
    if (row) episodes.push({ id: row.id, kind: row.kind, title: row.title, atMs: row.at_ms, score: hit.score });
  }

  // 断片: 探すのは 1 行ずつ (いちばん当たる) が、出すのは節ごと。同じ節で当たった行は、いちばん近い 1 件にまとめて「ほか N 件」と数える。
  // 1位との差と下限で絞り、同じページからは CHUNKS_PER_PAGE 節まで
  const chunks: MeaningChunk[] = [];
  if (chunkLimit > 0 && hasKind(guildId, 'claim')) {
    // v2 の記憶: 1 つの知識 = 主張。ページ (entity) ごとに CHUNKS_PER_PAGE 件まで。節は無い (heading は空)
    const raw = nearest(guildId, 'claim', query, { limit: chunkLimit * 8, ...(excludeChunks ? { exclude: excludeChunks } : {}) });
    candidateCounts.claim = raw.length;
    const best = raw[0]?.score ?? 0;
    const perPage = new Map<string, number>();
    const hits = raw.filter((hit) => hit.score >= (minScore ?? chunkFloor) && hit.score >= best - chunkGap);
    const claims = loadClaims(guildId, hits.map((hit) => hit.id));
    const unique = new Map<string | number, { claim: ClaimView; score: number }>();
    for (const hit of hits) {
      const claim = claims.get(hit.id);
      if (!claim || (!claim.path && claim.episodeId === null)) continue;
      const text = claim.text.normalize('NFKC').toLowerCase().replace(/[\s、。]/g, '');
      const modality = claim.modality === 'self_report' ? 'plain' : claim.modality;
      const key = claim.entityId === null ? claim.id : JSON.stringify([claim.entityId, claim.asOf, claim.episodeId, claim.type, modality, claim.hedged, text]);
      const previous = unique.get(key);
      if (!previous || (previous.claim.modality === 'plain' && claim.modality === 'self_report')) unique.set(key, { claim, score: hit.score });
    }
    const perEpisode = new Map<number, number>();
    for (const { claim, score } of unique.values()) {
      if (chunks.length >= chunkLimit) break;
      if (claim.path && (perPage.get(claim.path) ?? 0) >= CHUNKS_PER_PAGE) continue;
      const source = claim.episodeId;
      if (source !== null && (perEpisode.get(source) ?? 0) >= CHUNKS_PER_PAGE) continue;
      if (source !== null) perEpisode.set(source, (perEpisode.get(source) ?? 0) + 1);
      if (claim.path) perPage.set(claim.path, (perPage.get(claim.path) ?? 0) + 1);
      chunks.push({ id: claim.id, path: claim.path, heading: '', text: claim.text, line: claim.text, episodeIds: source === null ? [] : [source], score, more: 0, claim });
    }
  } else if (chunkLimit > 0) {
    const raw = nearest(guildId, 'chunk', query, { limit: chunkLimit * 8, ...(excludeChunks ? { exclude: excludeChunks } : {}) });
    candidateCounts.chunk = raw.length;
    const best = raw[0]?.score ?? 0;
    const perPage = new Map<string, number>();
    const sections = new Map<string, MeaningChunk>();
    for (const hit of raw) {
      if (!(hit.score >= (minScore ?? chunkFloor) && hit.score >= best - chunkGap)) continue;
      const row = db.prepare<[number], { id: number; path: string; heading: string; text: string; cites: string }>('SELECT id, path, heading, text, cites FROM memory_chunks WHERE id = ?').get(hit.id);
      if (!row || !row.path) continue;
      const section = sections.get(`${row.path}\u0000${row.heading}`);
      if (section) { section.more += 1; continue; }
      if (chunks.length >= chunkLimit || (perPage.get(row.path) ?? 0) >= CHUNKS_PER_PAGE) continue;
      perPage.set(row.path, (perPage.get(row.path) ?? 0) + 1);
      let episodeIds: number[] = [];
      try { episodeIds = (JSON.parse(row.cites) as unknown[]).filter((id): id is number => typeof id === 'number'); } catch { /* 出典なし */ }
      const chunk: MeaningChunk = { id: row.id, path: row.path, heading: row.heading, text: row.text, line: bestLine(row.text, text), episodeIds, score: hit.score, more: 0 };
      chunks.push(chunk);
      sections.set(`${row.path}\u0000${row.heading}`, chunk);
    }
  }
  searchMs = performance.now() - searchStart;
  selectedCounts.node = nodes.length;
  selectedCounts.episode = episodes.length;
  selectedCounts[hasKind(guildId, 'claim') ? 'claim' : 'chunk'] = chunks.length;
  const matched = nodes.length || episodes.length || chunks.length;
  emit(matched ? 'matched' : Object.values(candidateCounts).some(Boolean) ? 'below_cutoff' : 'no_candidates');
  return matched ? { nodes, episodes, chunks } : null;
}
