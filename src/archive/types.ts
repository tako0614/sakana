// archive/ の中で共有する型。SQLite の行はここで形を決め、
// better-sqlite3 の prepare<引数, 行>() に渡して使う。

/** SQLite に渡せる値 (better-sqlite3 は boolean を受け付けない)。 */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** 位置引数か、名前付き引数をまとめたオブジェクト。 */
export type SqlParam = SqlValue | Readonly<Record<string, SqlValue>>;

// ---------------------------------------------------------------- messages

export interface MessageRow {
  message_id: string;
  guild_id: string;
  channel_id: string;
  parent_id: string | null;
  author_id: string;
  author_name: string;
  is_bot: number;
  content: string;
  extra: string;
  created_at: number;
  edited_at: number | null;
  reply_to: string | null;
  attachment_count: number;
  attachment_kinds: string;
  embed_count: number;
  sticker_count: number;
  link_count: number;
  reaction_count: number;
  char_count: number;
  pinned: number;
  deleted: number;
  structure_json: string;
}

/** SELECT m.*, m.rowid AS rid */
export interface MessageRowWithRid extends MessageRow {
  rid: number;
}

export interface ReactionRecord {
  emoji: string;
  count: number;
  /** 押した人。取れなかったときは付けない (空配列は「誰も押していない」の意味になる) */
  users?: string[];
}

export interface LinkRecord {
  url: string;
  domain: string;
}

/** 取り込み1件ぶん。子テーブル (メンション・リアクション・リンク) の配列も一緒に持つ。 */
export interface MessageRecord extends Omit<MessageRow, 'deleted' | 'structure_json'> {
  structure_json?: string;
  mentions?: string[];
  reactions?: ReactionRecord[];
  links?: LinkRecord[];
}

// ---------------------------------------------------------------- channels

export interface ChannelRow {
  channel_id: string;
  guild_id: string;
  parent_id: string | null;
  name: string;
  type: number | null;
  is_thread: number;
  is_private: number;
  oldest_id: string | null;
  newest_id: string | null;
  complete: number;
  message_count: number;
  last_error: string | null;
  updated_at: number | null;
  applied_tags: string;
  topic: string;
}

/** upsertChannel に渡す形。applied_tags / topic / updated_at は省略できる。 */
export interface ChannelInput {
  channel_id: string;
  guild_id: string;
  parent_id: string | null;
  name: string;
  type: number | null;
  is_thread: number;
  is_private: number;
  applied_tags?: string;
  topic?: string;
  updated_at?: number;
}

export type ChannelStatePatch = Partial<Omit<ChannelRow, 'channel_id' | 'updated_at'>>;

export interface SpanRow {
  from_ms: number;
  to_ms: number;
  from_id: string;
  to_id: string;
}

export interface ChannelGap {
  afterId: string;
  beforeId: string;
  fromMs: number;
  toMs: number;
}

export interface ChannelTailGap {
  afterId: string;
  fromMs: number;
  toMs: number;
}

// ---------------------------------------------------------------- 状態

export interface GuildIndexStateRow {
  guild_id: string;
  status: string;
  mode: string | null;
  started_at: number | null;
  finished_at: number | null;
  channels_total: number;
  channels_done: number;
  messages_indexed: number;
  current_channel: string | null;
  last_error: string | null;
}

export type GuildStatePatch = Partial<Omit<GuildIndexStateRow, 'guild_id'>>;

export interface EmbedStateRow {
  guild_id: string;
  model_id: number | null;
  status: string;
  cursor_rowid: number;
  embedded: number;
  skipped: number;
  started_at: number | null;
  finished_at: number | null;
  swept_at: number | null;
  last_error: string | null;
  enabled: number;
}

export type EmbedStatePatch = Partial<Omit<EmbedStateRow, 'guild_id'>>;

// ---------------------------------------------------------------- まとまり

export interface ChunkRow {
  chunk_id: number;
  guild_id: string;
  channel_id: string;
  from_ms: number;
  to_ms: number;
  from_id: string;
  to_id: string;
  msg_count: number;
  text_len: number;
  built_at: number;
}

/** まとまりに入る範囲。描画にも埋め込みにも同じ範囲を使う。 */
export type ChunkRange = Pick<ChunkRow, 'channel_id' | 'from_ms' | 'to_ms'>;

// ---------------------------------------------------------------- 検索

/**
 * 実行者が読めるチャンネルの範囲。
 * all = 制限なし / none = 何も読めない / include = ids だけ / exclude = ids 以外
 */
export interface ChannelScope {
  mode: 'all' | 'none' | 'include' | 'exclude';
  ids: string[];
}

export interface FilterCondition {
  key: string;
  value: string;
}

export interface SearchOptions {
  guildId: string;
  query?: string;
  extra?: readonly FilterCondition[];
  channelScope?: ChannelScope | null;
  allowDeleted?: boolean;
  sort?: string;
}

export type QueryNode =
  | { type: 'and'; nodes: QueryNode[] }
  | { type: 'or'; nodes: QueryNode[] }
  | { type: 'not'; node: QueryNode }
  | { type: 'term'; value: string }
  | { type: 'filter'; key: string; value: string };

export interface CountRow {
  count: number;
}

export interface AggregateRow {
  bucket: string | number | null;
  count: number;
}

// ---------------------------------------------------------------- ジョブ

/** 取り込み・埋め込みで共有する単一フライトのジョブ。/index status と cancel が見る。 */
export interface ArchiveJob {
  guildId: string;
  mode: string;
  cancelled: boolean;
  startedAt: number;
  messagesIndexed: number;
  channelsDone: number;
  channelsTotal: number;
  currentChannel: string | null;
  /**
   * 処理中のチャンネルの ID。公開の進捗表示では名前ではなく <#ID> で出す
   * (見えない人には名前が伏せられる)。チャンネルでない段階では付かない。
   */
  currentChannelId?: string | null;
}

/** スレッドの列挙や取り込みで起きた失敗 (Discord のエラーコードか状態) */
export interface IndexFailure {
  channelId?: string;
  stage?: string;
  code: string | number;
}

export interface IndexJob extends ArchiveJob {
  skipped?: (string | IndexFailure)[];
  /** bot が読めなかったチャンネルの ID (skipped の名前と同じ並び。表示は <#ID> で出す) */
  skippedIds?: string[];
  errors?: IndexFailure[];
  channelIds?: string[];
}

export interface CoverageJob extends ArchiveJob {
  gapsClosed: number;
}

export interface EmbedJob extends ArchiveJob {
  embedded: number;
  skipped: number;
  rate: number;
  batchFailures: number;
  failed: number;
}

export type RunningJob = IndexJob | CoverageJob | EmbedJob;
