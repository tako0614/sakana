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
import { embedTexts, isDisabled, prewarm, workerInfo } from '../embed/worker.js';
import { bestLine, chunkText, syncChunks } from './chunks.js';
import { memoryDb } from './store.js';

type Kind = 'node' | 'episode' | 'chunk';
type EmbedFn = (texts: readonly string[], kind: 'passage' | 'query') => Promise<{ dim: number; vectors: string[] }>;

const defaultEmbed: EmbedFn = async (texts, kind) => {
  const reply = await embedTexts(texts, { kind, encode: 'float32' });
  return { dim: reply.dim, vectors: reply.vectors };
};

let embedder: EmbedFn = defaultEmbed;
/** 検証用: 埋め込みを差し替える (引数なしで元に戻す)。 */
export function setEmbedder(fn?: EmbedFn): void {
  embedder = fn ?? defaultEmbed;
  matrices.clear();
}

const modelKey = (): string => embedConfig.modelName;
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
  // ページの中の1つの知識 (syncChunks が本文から作った表)。ページ名と節が付くので、誰の何の話かが残る
  for (const chunk of db.prepare<[string], { id: number; path: string; heading: string; text: string; aliases: string }>(
    'SELECT c.id, c.path, c.heading, c.text, n.aliases FROM memory_chunks c JOIN nodes n ON n.id = c.node_id WHERE c.guild_id = ?').all(guildId)) {
    const text = chunkText(chunk.path, parseAliases(chunk.aliases), chunk.heading, chunk.text);
    items.push({ kind: 'chunk', id: chunk.id, text, hash: hashOf(text) });
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
    syncChunks(guildId);
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
  if (!embedConfig.enabled || isDisabled()) return;
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

// ---- 引く ---------------------------------------------------------------------

interface Matrix { signature: string; dim: number; ids: number[]; values: Float32Array }
const matrices = new Map<string, Matrix>();

function matrixFor(guildId: string, kind: Kind): Matrix | null {
  const db = memoryDb();
  const summary = db.prepare<[string, string, string], { n: number; last: number | null }>(
    'SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM memory_vectors WHERE guild_id = ? AND kind = ? AND model = ?').get(guildId, kind, modelKey());
  if (!summary || summary.n === 0) return null;
  const signature = `${summary.n}:${summary.last}`;
  const key = `${guildId}:${kind}`;
  const cached = matrices.get(key);
  if (cached?.signature === signature) return cached;

  const rows = db.prepare<[string, string, string], { id: number; vec: Buffer }>(
    'SELECT id, vec FROM memory_vectors WHERE guild_id = ? AND kind = ? AND model = ?').all(guildId, kind, modelKey());
  const dim = (rows[0]?.vec.byteLength ?? 0) / Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isInteger(dim) || dim <= 0) return null;
  const usable = rows.filter((row) => row.vec.byteLength === dim * Float32Array.BYTES_PER_ELEMENT);
  const values = new Float32Array(usable.length * dim);
  usable.forEach((row, index) => {
    values.set(new Float32Array(row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength)), index * dim);
  });
  const matrix: Matrix = { signature, dim, ids: usable.map((row) => row.id), values };
  matrices.set(key, matrix);
  return matrix;
}

export interface VectorHit { id: number; score: number }

/** 質問のベクトルに近い順。exclude の id は除く。 */
export function nearest(guildId: string, kind: Kind, query: Float32Array, { limit = 5, exclude }: { limit?: number; exclude?: ReadonlySet<number> } = {}): VectorHit[] {
  const matrix = matrixFor(guildId, kind);
  if (!matrix || matrix.dim !== query.length) return [];
  const hits: VectorHit[] = [];
  for (let row = 0; row < matrix.ids.length; row += 1) {
    const id = matrix.ids[row] as number;
    if (exclude?.has(id)) continue;
    let score = 0;
    const base = row * matrix.dim;
    for (let index = 0; index < matrix.dim; index += 1) score += (matrix.values[base + index] ?? 0) * (query[index] ?? 0);
    hits.push({ id, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 指定した id だけの、質問への近さ。ベクトルが無い id は含まれない。 */
export function scoresFor(guildId: string, kind: Kind, query: Float32Array, ids: readonly number[]): Map<number, number> {
  const scores = new Map<number, number>();
  const matrix = matrixFor(guildId, kind);
  if (!matrix || matrix.dim !== query.length || ids.length === 0) return scores;
  const wanted = new Set(ids);
  for (let row = 0; row < matrix.ids.length; row += 1) {
    const id = matrix.ids[row] as number;
    if (!wanted.has(id)) continue;
    let score = 0;
    const base = row * matrix.dim;
    for (let index = 0; index < matrix.dim; index += 1) score += (matrix.values[base + index] ?? 0) * (query[index] ?? 0);
    scores.set(id, score);
  }
  return scores;
}

/**
 * 質問文をベクトルにする。timeoutMs で見切る (null)。モデルが眠っていたら起こしておく。
 * 見切った後も読み込みは裏で続くので、次の往復には間に合う。
 */
// モデルがまだ起きていないとき、1度見切ったら少しのあいだは待たずに諦める
// (往復のたびに数秒ずつ待たせない。読み込みは prewarm で裏に進んでいる)。
let coldUntil = 0;
const COLD_SKIP_MS = 30_000;

export async function embedQuery(text: string, { timeoutMs = 3000 }: { timeoutMs?: number } = {}): Promise<Float32Array | null> {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!clean || !embedConfig.enabled || isDisabled()) return null;
  const real = embedder === defaultEmbed;
  const cold = real && workerInfo() === null;
  if (cold) {
    prewarm();
    if (Date.now() < coldUntil) return null;
  }
  const work = embedder([clean], 'query').then((reply) => decode(reply.vectors[0] ?? '', reply.dim), () => null);
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const limit = new Promise<null>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(null); }, timeoutMs); });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
    if (cold && timedOut) coldUntil = Date.now() + COLD_SKIP_MS;
  }
}

/** 埋め込みモデルが読めるのは 384 トークン (日本語で 500 字ほど)。それより長い文は後ろが切れるので、質問は短い断片ごとに分けて渡す。 */
const SEGMENT_CHARS = 500;

/**
 * 複数の質問文を、1 回の呼び出しでまとめてベクトルにする。timeoutMs で見切る (null)。
 * 戻りは入力と同じ順で、空の文は null。モデルが眠っているときは embedQuery と同じに見切る。
 */
export async function embedQueries(texts: readonly string[], { timeoutMs = 3000 }: { timeoutMs?: number } = {}): Promise<(Float32Array | null)[] | null> {
  const clean = texts.map((text) => text.replace(/\s+/g, ' ').trim().slice(0, SEGMENT_CHARS));
  const wanted = clean.map((text, index) => ({ text, index })).filter((entry) => entry.text);
  if (wanted.length === 0 || !embedConfig.enabled || isDisabled()) return null;
  const real = embedder === defaultEmbed;
  const cold = real && workerInfo() === null;
  if (cold) {
    prewarm();
    if (Date.now() < coldUntil) return null;
  }
  const work = embedder(wanted.map((entry) => entry.text), 'query').then((reply) => {
    const out: (Float32Array | null)[] = clean.map(() => null);
    wanted.forEach((entry, position) => { out[entry.index] = decode(reply.vectors[position] ?? '', reply.dim); });
    return out;
  }, () => null);
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const limit = new Promise<null>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(null); }, timeoutMs); });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
    if (cold && timedOut) coldUntil = Date.now() + COLD_SKIP_MS;
  }
}

/** 質問の 1 本。penalty は、弱い手がかり (直前の会話など) のスコアから引く値。 */
export interface QuerySegment { text: string; penalty?: number }

/** 複数の質問のそれぞれで引き、同じものはいちばん高いスコア (penalty を引いたあと) を採って、近い順に並べる。 */
function nearestOfAny(guildId: string, kind: Kind, queries: readonly { vector: Float32Array; penalty: number }[],
  { limit, exclude }: { limit: number; exclude?: ReadonlySet<number> | undefined }): VectorHit[] {
  const best = new Map<number, number>();
  for (const { vector, penalty } of queries) {
    for (const hit of nearest(guildId, kind, vector, { limit, ...(exclude ? { exclude } : {}) })) {
      const score = hit.score - penalty;
      if (score > (best.get(hit.id) ?? -Infinity)) best.set(hit.id, score);
    }
  }
  return [...best].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface MeaningNode { path: string; summary: string; score: number }
export interface MeaningEpisode { id: number; kind: string; title: string; atMs: number; score: number }
/** ページの中の1つの知識 (まとめた断片なら、その中で質問にいちばん近い行を line に)。episodeIds は根拠の出来事 (開くと原文までたどれる)。 */
export interface MeaningChunk { id: number; path: string; heading: string; text: string; line: string; episodeIds: number[]; score: number; /** 同じ節で、ほかにも当たった断片の数。 */ more: number }
export interface Meaning { nodes: MeaningNode[]; episodes: MeaningEpisode[]; chunks: MeaningChunk[] }

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

/**
 * 文に意味が近いページ・出来事・ページの中の1つの知識。ベクトルが無い・間に合わない・近いものが無ければ null。
 * 質問は 1 つの文でも、複数の断片 (依頼・直前の会話・思考・道具の結果) でもよい。断片は別々に埋め込んで、いちばん近いものを採る
 * (1 本につなぐと、埋め込みが読める 500 字ほどを超えた後ろが切れる)。
 */
export async function meaningOf(guildId: string, input: string | readonly QuerySegment[],
  { nodeLimit = 2, episodeLimit = 3, chunkLimit = 3, excludePaths, excludeEpisodes, excludeChunks, timeoutMs = 3000, queryVector }: {
    nodeLimit?: number; episodeLimit?: number; chunkLimit?: number; excludePaths?: ReadonlySet<string>; excludeEpisodes?: ReadonlySet<number>;
    excludeChunks?: ReadonlySet<number>; timeoutMs?: number;
    /** 質問が 1 つの文のとき、呼び出し側で埋め込み済みのベクトル (同じ文を二度埋め込まない)。 */
    queryVector?: Float32Array | null;
  } = {}): Promise<Meaning | null> {
  if (!hasVectors(guildId)) return null;
  const segments: QuerySegment[] = typeof input === 'string' ? [{ text: input }] : [...input];
  const embedded = segments.length === 1 && typeof input === 'string'
    ? [queryVector ?? await embedQuery(input, { timeoutMs })]
    : await embedQueries(segments.map((segment) => segment.text), { timeoutMs });
  const queries = (embedded ?? []).flatMap((vector, index) => (vector ? [{ vector, penalty: segments[index]?.penalty ?? 0 }] : []));
  if (queries.length === 0) return null;
  // 出す行の頭を、質問のどこにいちばん重なる行にするかの手がかり
  const text = segments.map((segment) => segment.text).join('\n');
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
    return hits.filter((hit) => hit.score >= floor && hit.score >= best - gap);
  };
  // 根 (全体の概要) は常に何かに近いので出さない
  const nodeHits = pick(nearestOfAny(guildId, 'node', queries, { limit: nodeLimit + 1, exclude: skipNodes })).slice(0, nodeLimit);
  const episodeHits = pick(nearestOfAny(guildId, 'episode', queries, { limit: episodeLimit + 2, exclude: excludeEpisodes ? new Set(excludeEpisodes) : undefined })).slice(0, episodeLimit);

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
  if (chunkLimit > 0) {
    const raw = nearestOfAny(guildId, 'chunk', queries, { limit: chunkLimit * 8, exclude: excludeChunks ? new Set(excludeChunks) : undefined });
    const best = raw[0]?.score ?? 0;
    const perPage = new Map<string, number>();
    const sections = new Map<string, MeaningChunk>();
    for (const hit of raw) {
      if (hit.score < chunkFloor || hit.score < best - chunkGap) continue;
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
  return nodes.length || episodes.length || chunks.length ? { nodes, episodes, chunks } : null;
}
