// ベクトルの保存と走査。ベクトル関連の SQL は全部ここに置く
// (将来別ファイルに分けたくなっても、変更がこのモジュールに閉じるように)。

import { embedConfig } from '../embed/config.js';
import { db } from './db.js';
import { buildSearch, withRegexGuard } from './search.js';
import type { ChannelScope, ChunkRow, CountRow, MessageRowWithRid, SearchOptions, SqlParam, SqlValue } from './types.js';

// 埋め込む対象の条件。バッチ抽出・被覆計算・クエリ時の走査で同じ式を使う。
// 3箇所に散らすと必ず齟齬が出る。
const EMBEDDABLE_SQL = `
  m.deleted = 0
  AND m.content <> ''
  AND m.char_count >= @min_chars
  AND (@include_bots = 1 OR m.is_bot = 0)
`;

interface EmbeddableParams {
  min_chars: number;
  include_bots: number;
}

function embeddableParams(): EmbeddableParams {
  return {
    min_chars: embedConfig.minChars,
    include_bots: embedConfig.includeBots ? 1 : 0
  };
}

export interface ModelIdentity {
  name: string;
  dim: number;
  quant?: string;
  prefixQuery?: string;
  prefixPassage?: string;
  maxLength?: number;
}

/**
 * モデルの同一性を1行にして参照させる。
 * name / dim / quant / 前置き文字列が変わったら別モデル扱いにする。
 * revision は含めない — 上流がリポジトリを再アップしただけで数十万件が
 * 一斉に「古いモデル」に化けてしまうため。
 */
export function ensureModelId({ name, dim, quant = 'int8', prefixQuery = '', prefixPassage = '', maxLength = 192 }: ModelIdentity): number {
  const found = db.prepare<[string, number, string, string, string], { model_id: number }>(`
    SELECT model_id FROM embed_models
    WHERE name = ? AND dim = ? AND quant = ? AND prefix_query = ? AND prefix_passage = ?
  `).get(name, dim, quant, prefixQuery, prefixPassage);

  if (found) return found.model_id;

  const { lastInsertRowid } = db.prepare<[string, number, string, string, string, number, number]>(`
    INSERT INTO embed_models (name, dim, quant, prefix_query, prefix_passage, max_length, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, dim, quant, prefixQuery, prefixPassage, maxLength, Date.now());

  return Number(lastInsertRowid);
}

const insertVector = db.prepare<[number, number, number, Uint8Array, number, number]>(`
  INSERT OR REPLACE INTO message_vectors (rowid, model_id, scale, vec, text_len, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

export interface MessageVector {
  rowid: number;
  modelId: number;
  scale: number;
  vec: Uint8Array;
  textLen: number;
}

export const saveVectors = db.transaction((rows: readonly MessageVector[]): number => {
  const now = Date.now();
  for (const row of rows) {
    insertVector.run(row.rowid, row.modelId, row.scale, row.vec, row.textLen, now);
  }
  return rows.length;
});

export interface BatchRow {
  rid: number;
  content: string;
}

export interface NextBatchOptions {
  guildId: string;
  modelId: number;
  cursor?: number;
  limit?: number;
  mode?: 'forward' | 'sweep';
  since?: number;
}

/**
 * 次に埋め込む行を取る。
 * forward: rowid カーソルで前に進むだけ (新規挿入は必ず後ろに付く)
 * sweep  : カーソルを無視して穴 (編集でベクトルを捨てた行) を拾う
 */
export function nextBatch({ guildId, modelId, cursor = 0, limit = 32, mode = 'forward', since = 0 }: NextBatchOptions): BatchRow[] {
  const params = { ...embeddableParams(), guild_id: guildId, model_id: modelId, limit };

  if (mode === 'sweep') {
    return db.prepare<[typeof params & { since: number }], BatchRow>(`
      SELECT m.rowid AS rid, m.content AS content
      FROM messages m
      WHERE m.guild_id = @guild_id AND ${EMBEDDABLE_SQL} AND m.created_at >= @since
        AND NOT EXISTS (SELECT 1 FROM message_vectors v WHERE v.rowid = m.rowid AND v.model_id = @model_id)
      ORDER BY m.rowid LIMIT @limit
    `).all({ ...params, since });
  }

  return db.prepare<[typeof params & { cursor: number }], BatchRow>(`
    SELECT m.rowid AS rid, m.content AS content
    FROM messages m
    WHERE m.guild_id = @guild_id AND m.rowid > @cursor AND ${EMBEDDABLE_SQL}
      AND NOT EXISTS (SELECT 1 FROM message_vectors v WHERE v.rowid = m.rowid AND v.model_id = @model_id)
    ORDER BY m.rowid LIMIT @limit
  `).all({ ...params, cursor });
}

export interface VectorCoverage {
  embeddable: number;
  done: number;
  stale: number;
  ratio: number;
}

export function coverage(guildId: string, modelId: number): VectorCoverage {
  const embeddable = db.prepare<[EmbeddableParams & { guild_id: string }], CountRow>(`
    SELECT COUNT(*) AS count FROM messages m
    WHERE m.guild_id = @guild_id AND ${EMBEDDABLE_SQL}
  `).get({ ...embeddableParams(), guild_id: guildId })?.count ?? 0;

  const done = db.prepare<[string, number], CountRow>(`
    SELECT COUNT(*) AS count FROM messages m
    JOIN message_vectors v ON v.rowid = m.rowid
    WHERE m.guild_id = ? AND v.model_id = ? AND v.text_len > 0
  `).get(guildId, modelId)?.count ?? 0;

  const stale = db.prepare<[string, number], CountRow>(`
    SELECT COUNT(*) AS count FROM messages m
    JOIN message_vectors v ON v.rowid = m.rowid
    WHERE m.guild_id = ? AND v.model_id <> ?
  `).get(guildId, modelId)?.count ?? 0;

  return { embeddable, done, stale, ratio: embeddable > 0 ? done / embeddable : 0 };
}

export function clearGuildVectors(guildId: string): void {
  db.prepare<[string]>(`
    DELETE FROM message_vectors WHERE rowid IN (
      SELECT rowid FROM messages WHERE guild_id = ?
    )
  `).run(guildId);
}

/**
 * 埋め込む前に本文を整える。
 * URL はホスト名だけ残す (github.com は話題の手がかりだがパスは雑音)。
 * メンションは落とし、カスタム絵文字は名前だけにする。
 */
export function normalizeForEmbedding(content: string | null | undefined): string {
  const text = String(content ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/([^\s/]+)\S*/gi, (_, host: string) => ` ${host} `)
    .replace(/<a?:(\w+):\d+>/g, ' $1 ')
    .replace(/<[@#][!&]?\d+>/g, ' ')
    .replace(/<t:\d+(?::[a-zA-Z])?>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // コードポイント単位で切る。String#slice は UTF-16 単位なので、絵文字
  // (サロゲートペア) の途中で切れて孤立サロゲートが残る。そうなると UTF-8 として
  // 不正な文字列になり、Rust 実装の tokenizer が丸ごと受け付けない。
  // 実際に「AI is dead 💀」の繰り返しでこれを踏んで、バックフィルが 84% で止まった。
  const chars = Array.from(text);
  if (chars.length <= embedConfig.maxChars) return text;
  return chars.slice(0, embedConfig.maxChars).join('');
}

interface VectorRow {
  scale: number;
  vec: Uint8Array | null;
}

/** 量子化ベクトル (int8) と問い合わせベクトルの内積。長さが違えば null。 */
function dotInt8(queryVec: ArrayLike<number>, bytes: Uint8Array | null): number | null {
  const dim = queryVec.length;
  if (!bytes || bytes.length !== dim) return null;

  const quantized = new Int8Array(bytes.buffer, bytes.byteOffset, dim);
  let dot = 0;
  for (let i = 0; i < dim; i += 1) dot += (queryVec[i] ?? 0) * (quantized[i] ?? 0);
  return dot;
}

/** 上位だけ持つ。全件ソートは候補が多いと無駄。 */
function keepBest<Hit extends { score: number }>(best: Hit[], hit: Hit, limit: number): void {
  const last = best.at(-1);
  if (best.length < limit * 4) {
    best.push(hit);
    if (best.length === limit * 4) best.sort((a, b) => b.score - a.score);
  } else if (last && hit.score > last.score) {
    best[best.length - 1] = hit;
    best.sort((a, b) => b.score - a.score);
  }
}

export interface ScanOptions {
  options: SearchOptions;
  modelId: number;
  queryVec: ArrayLike<number>;
  limit?: number;
  maxCandidates?: number;
}

export type ScanResult<Hit> =
  | { tooMany: true; total: number }
  | { tooMany: false; total: number; scanned: number; hits: Hit[] };

/**
 * SQL で絞ってから、生き残った行のベクトルだけを総当たりで見る。
 *
 * 権限スコープは buildSearch が組み立てた where をそのまま継承するので、
 * 呼んだ人に見えないチャンネルは走査対象にすら入らない。
 */
export function scanTopK({ options, modelId, queryVec, limit = 10, maxCandidates = embedConfig.maxCandidates }: ScanOptions): ScanResult<{ rid: number; score: number }> {
  const built = buildSearch(options);
  const named = { ...embeddableParams(), model_id: modelId };
  const params: SqlParam[] = [...built.params, named];

  const where = `${built.where} AND v.model_id = @model_id AND v.text_len > 0 AND ${EMBEDDABLE_SQL}`;

  return withRegexGuard(built.usesRegex, (exec): ScanResult<{ rid: number; score: number }> => {
    const total = exec.get<CountRow>(`
      SELECT COUNT(*) AS count FROM messages m
      JOIN message_vectors v ON v.rowid = m.rowid
      WHERE ${where}
    `, params)?.count ?? 0;

    if (total > maxCandidates) {
      return { tooMany: true, total };
    }

    const sql = `
      SELECT m.rowid AS rid, v.scale AS scale, v.vec AS vec
      FROM messages m
      JOIN message_vectors v ON v.rowid = m.rowid
      WHERE ${where}
    `;
    // regex: を含むときはワーカーが行をまとめて返す (候補は maxCandidates 件まで)。
    // それ以外は従来どおりメインの接続で1行ずつ読む
    const rows: Iterable<VectorRow & { rid: number }> = built.usesRegex
      ? exec.all<VectorRow & { rid: number }>(sql, params)
      : db.prepare<SqlParam[], VectorRow & { rid: number }>(sql).iterate(...params);

    const best: { rid: number; score: number }[] = [];
    let scanned = 0;

    for (const row of rows) {
      const dot = dotInt8(queryVec, row.vec);
      if (dot === null) continue;

      scanned += 1;
      keepBest(best, { rid: row.rid, score: dot * row.scale }, limit);
    }

    best.sort((a, b) => b.score - a.score);
    return { tooMany: false, total, scanned, hits: best };
  }, options.guildId);
}

export interface ChunkFilters {
  authorId?: string;
  channelIds?: readonly string[];
  fromMs?: number;
  toMs?: number;
}

export interface ChunkScanOptions {
  guildId: string;
  modelId: number;
  queryVec: ArrayLike<number>;
  filters?: ChunkFilters;
  channelScope?: ChannelScope | null;
  limit?: number;
  maxCandidates?: number;
}

/**
 * 会話のまとまりを総当たりで走査する。
 *
 * messages 側の buildSearch は使えない (絞る対象が発言ではなくまとまりなので)。
 * 代わりにまとまりの属性で絞る: 参加者・チャンネル・期間・権限スコープ。
 * 権限は「そのまとまりのチャンネルが見えるか」の1回で足りる
 * (まとまりは必ず単一チャンネルなので)。
 */
export function scanChunksTopK({
  guildId,
  modelId,
  queryVec,
  filters = {},
  channelScope = null,
  limit = 10,
  maxCandidates = embedConfig.maxCandidates
}: ChunkScanOptions): ScanResult<{ cid: number; score: number }> {
  const where = ['c.guild_id = @guild_id', 'v.model_id = @model_id', 'c.text_len > 0'];
  const params: Record<string, SqlValue> = { guild_id: guildId, model_id: modelId };

  if (filters.authorId) {
    where.push('EXISTS (SELECT 1 FROM chunk_authors ca WHERE ca.chunk_id = c.chunk_id AND ca.author_id = @author_id)');
    params.author_id = filters.authorId;
  }

  const bindIds = (ids: readonly string[], prefix: string): string => {
    ids.forEach((id, index) => { params[`${prefix}${index}`] = id; });
    return ids.map((_, index) => `@${prefix}${index}`).join(', ');
  };

  if (filters.channelIds?.length) {
    where.push(`c.channel_id IN (${bindIds(filters.channelIds, 'ch')})`);
  }

  if (filters.fromMs !== undefined && Number.isFinite(filters.fromMs)) {
    where.push('c.to_ms >= @from_ms');
    params.from_ms = filters.fromMs;
  }

  if (filters.toMs !== undefined && Number.isFinite(filters.toMs)) {
    where.push('c.from_ms < @to_ms');
    params.to_ms = filters.toMs;
  }

  // 見えないチャンネルは走査対象にすら入れない
  if (channelScope?.mode === 'none') return { tooMany: false, total: 0, scanned: 0, hits: [] };
  if (channelScope?.mode === 'exclude' && channelScope.ids.length > 0) {
    where.push(`c.channel_id NOT IN (${bindIds(channelScope.ids, 'deny')})`);
  }
  if (channelScope?.mode === 'include') {
    if (channelScope.ids.length === 0) return { tooMany: false, total: 0, scanned: 0, hits: [] };
    where.push(`c.channel_id IN (${bindIds(channelScope.ids, 'allow')})`);
  }

  const clause = where.join(' AND ');

  const total = db.prepare<[Record<string, SqlValue>], CountRow>(`
    SELECT COUNT(*) AS count FROM message_chunks c
    JOIN chunk_vectors v ON v.chunk_id = c.chunk_id
    WHERE ${clause}
  `).get(params)?.count ?? 0;

  if (total > maxCandidates) return { tooMany: true, total };

  const statement = db.prepare<[Record<string, SqlValue>], VectorRow & { cid: number }>(`
    SELECT c.chunk_id AS cid, v.scale AS scale, v.vec AS vec
    FROM message_chunks c
    JOIN chunk_vectors v ON v.chunk_id = c.chunk_id
    WHERE ${clause}
  `);

  const best: { cid: number; score: number }[] = [];
  let scanned = 0;

  for (const row of statement.iterate(params)) {
    const dot = dotInt8(queryVec, row.vec);
    if (dot === null) continue;

    scanned += 1;
    keepBest(best, { cid: row.cid, score: dot * row.scale }, limit);
  }

  best.sort((a, b) => b.score - a.score);
  return { tooMany: false, total, scanned, hits: best };
}

export function fetchChunks(chunkIds: readonly number[]): ChunkRow[] {
  if (chunkIds.length === 0) return [];

  const placeholders = chunkIds.map(() => '?').join(', ');
  const rows = db.prepare<number[], ChunkRow>(`SELECT * FROM message_chunks WHERE chunk_id IN (${placeholders})`).all(...chunkIds);
  const byId = new Map(rows.map((row) => [row.chunk_id, row]));
  return chunkIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

export function fetchByRowids(rowids: readonly number[]): MessageRowWithRid[] {
  if (rowids.length === 0) return [];

  const placeholders = rowids.map(() => '?').join(', ');
  const rows = db.prepare<number[], MessageRowWithRid>(`SELECT m.*, m.rowid AS rid FROM messages m WHERE m.rowid IN (${placeholders})`).all(...rowids);
  const byId = new Map(rows.map((row) => [row.rid, row]));
  return rowids.flatMap((rid) => {
    const row = byId.get(rid);
    return row ? [row] : [];
  });
}
