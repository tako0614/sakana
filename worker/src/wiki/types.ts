// 記憶 (wiki) の型。D1 の行・押し込みの本文・画面に渡す値。

export interface Env {
  LAWS: D1Database;
  GOVERNANCE_LAW_API_TOKEN?: string;
  DEFAULT_GUILD_ID?: string;
  /** wiki を見せるサーバー (カンマ・空白区切り)。URL の /<サーバーID> がこの一覧に無ければ 404。サーバーごとにメンバーかを確かめる */
  MEMORY_GUILD_IDS?: string;
  /** 旧: 1つだけ見せるとき (MEMORY_GUILD_IDS に足して扱う) */
  MEMORY_GUILD_ID?: string;
  /** 'members' (既定: Discord ログインとサーバーのメンバー確認が要る) | 'public' (誰でも) */
  MEMORY_ACCESS?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  /** bot が発行するログインリンクの署名の鍵 (bot の MEMORY_SITE_LINK_SECRET と同じ値) */
  MEMORY_LINK_SECRET?: string;
}

export interface NodeRow {
  guild_id: string;
  id: number;
  path: string;
  parent: string | null;
  name: string;
  depth: number;
  summary: string;
  body: string;
  pending: string;
  pending_count: number;
  aliases: string;
  weight: number;
  first_at: number | null;
  last_at: number | null;
  updated_at: number;
  child_count: number;
  episode_count: number;
  content_hash: string;
}

export interface EpisodeRow {
  guild_id: string;
  id: number;
  kind: string;
  title: string;
  summary: string;
  channel_id: string;
  channel_name: string;
  at_ms: number;
  end_ms: number;
  importance: number;
  source_count: number;
  hidden_quotes: number;
  content_hash: string;
}

export interface QuoteRow {
  message_id: string;
  channel_id: string;
  author_name: string;
  content: string;
  created_at: number;
  highlight: number;
}

/** 一覧に出す最小限のページ情報 */
export interface NodeBrief {
  path: string;
  name: string;
  summary: string;
  child_count: number;
  episode_count: number;
  weight: number;
}

export type EpisodeBrief = Pick<EpisodeRow, 'id' | 'kind' | 'title' | 'summary' | 'at_ms' | 'channel_name' | 'importance'>;

/** bot が押し込むページ1件 */
export interface NodePayload {
  id: number;
  path: string;
  parent: string | null;
  name: string;
  depth: number;
  summary: string;
  body: string;
  pending: string;
  pendingCount: number;
  aliases: string[];
  weight: number;
  firstAt: number | null;
  lastAt: number | null;
  updatedAt: number;
  childCount: number;
  episodeCount: number;
  links: { dst: string; weight: number }[];
  contentHash: string;
}

/** bot が押し込む出来事1件 (関係する行ごと入れ替える) */
export interface EpisodePayload {
  id: number;
  kind: string;
  title: string;
  summary: string;
  channelId: string;
  channelName: string;
  atMs: number;
  endMs: number;
  importance: number;
  sourceCount: number;
  hiddenQuotes: number;
  nodes: string[];
  before: number[];
  quotes: { messageId: string; channelId: string; authorName: string; content: string; createdAt: number; highlight: boolean }[];
  contentHash: string;
}

export interface Session {
  /** どのサーバーの入場か。cookie はサーバーごとだが、確かめ直す */
  g: string;
  uid: string;
  name: string;
  avatar: string | null;
  exp: number;
}
