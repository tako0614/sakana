// 記憶 (ページと出来事) の意味ベクトル。
//
// 名前の照合 (recall.ts) と全文検索は、言葉が一致しないと引けない。「レビューを飛ばした」話から
// 「ダブスタ」のページを思い出すには、意味で引く必要がある。ここでは、ページと出来事の短い文を
// ローカルの埋め込み (会話のログと同じ e5-small、src/embed) でベクトルにして memory.sqlite に持ち、
// 想起 (呼ばれたとき・考えている途中) と memory ツールの検索から近い順に引く。
//
// 重い処理は bot の中の1か所 (index.ts の定期実行) だけ。builder は別プロセスで、Python を起こさない。
// 本番 (HDD) ではモデルの読み込みに分単位かかることがあるので、質問側は短い時間で見切って、
// 間に合わなければ名前の想起だけで続ける (ロードは裏で進むので、次の往復には間に合う)。

import { createHash } from 'node:crypto';
import { embedConfig } from '../embed/config.js';
import { embedTexts, isDisabled, prewarm, workerInfo } from '../embed/worker.js';
import { memoryDb } from './store.js';

type Kind = 'node' | 'episode';
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

/**
 * 質問文をベクトルにする。timeoutMs で見切る (null)。モデルが眠っていたら起こしておく。
 * 見切った後も読み込みは裏で続くので、次の往復には間に合う。
 */
export async function embedQuery(text: string, { timeoutMs = 3000 }: { timeoutMs?: number } = {}): Promise<Float32Array | null> {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!clean || !embedConfig.enabled || isDisabled()) return null;
  if (embedder === defaultEmbed && workerInfo() === null) prewarm();
  const work = embedder([clean], 'query').then((reply) => decode(reply.vectors[0] ?? '', reply.dim), () => null);
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

export interface MeaningNode { path: string; summary: string; score: number }
export interface MeaningEpisode { id: number; kind: string; title: string; atMs: number; score: number }
export interface Meaning { nodes: MeaningNode[]; episodes: MeaningEpisode[] }

// 1位からこれ以上離れたものは捨てる。e5 は無関係な文どうしでも高い値が出る (0.7〜0.8) ので、絶対値では切れず、
// 順位と1位との差でしか絞れない。floor は絶対値の下限 (ほぼ何も似ていない質問で、1位をそのまま出さないため)。
const gap = Number(process.env.MEMORY_RECALL_GAP ?? 0.04);
const floor = Number(process.env.MEMORY_RECALL_FLOOR ?? 0.8);

/** 文に意味が近いページと出来事。ベクトルが無い・間に合わない・近いものが無ければ null。 */
export async function meaningOf(guildId: string, text: string,
  { nodeLimit = 2, episodeLimit = 3, excludePaths, excludeEpisodes, timeoutMs = 3000 }: {
    nodeLimit?: number; episodeLimit?: number; excludePaths?: ReadonlySet<string>; excludeEpisodes?: ReadonlySet<number>; timeoutMs?: number;
  } = {}): Promise<Meaning | null> {
  if (!hasVectors(guildId)) return null;
  const query = await embedQuery(text, { timeoutMs });
  if (!query) return null;
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
  const nodeHits = pick(nearest(guildId, 'node', query, { limit: nodeLimit + 1, exclude: skipNodes })).slice(0, nodeLimit);
  const episodeHits = pick(nearest(guildId, 'episode', query, { limit: episodeLimit + 2, exclude: excludeEpisodes ? new Set(excludeEpisodes) : undefined })).slice(0, episodeLimit);

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
  return nodes.length || episodes.length ? { nodes, episodes } : null;
}
