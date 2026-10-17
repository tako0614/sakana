// src/agent の中で共有する型。
//
// 実行時の値は持たない (import type だけで読む)。外 (Discord / モデル / DB) から来る値は
// ここの型を名乗る前に必ず確かめる。確かめる関数もここに置く。

import type { Client, Guild, GuildMember, GuildTextBasedChannel, Role } from 'discord.js';
import type { ChannelScope } from '../archive/types.js';
import type { MessageStructure } from '../conversation/message.js';
import type { RefTable } from './format.js';

// 持ち主のモジュールの型をそのまま使う (写しを作らない)。agent の他のファイルはここから読んでよい。
//   ChannelScope     : 実行者が読めるチャンネルの範囲 (archive/types.ts。getChannelScope が返す)
//   MessageStructure : 保存・受け渡しする発言の構造 (conversation/message.ts)
//   ToolDefinition   : OpenAI 互換のツール定義 (ai/types.ts。provider と runtime が受け取る)
export type { ChannelScope, MessageStructure };
export type { ToolDefinition } from '../ai/types.js';

/** 返信の鎖をどこで止めたか。プロンプトでは reference.availability に載る。 */
export type ReferenceState =
  | 'not_applicable' | 'snapshot' | 'cycle' | 'unavailable' | 'deleted' | 'resolved' | 'depth_limit';

/** アーカイブ・discord.js・検索 API の生 JSON をそろえた共通形。 */
export interface AgentMessage {
  guildId: string | null;
  channelId: string;
  channelName?: string | null | undefined;
  messageId: string;
  authorId: string;
  authorName: string;
  isBot?: boolean;
  content: string;
  extra?: string;
  createdAt: number;
  editedAt?: number | null;
  deleted?: boolean;
  reactionCount?: number | null;
  replyTo?: string | null;
  attachmentCount?: number;
  structure?: MessageStructure;
  referenceState?: ReferenceState;
}

/** 返信の鎖。配列にどこで止めたかを持たせる (呼び出し側が referenceState を読む)。 */
export type ReplyChain = AgentMessage[] & { referenceState: ReferenceState };

/** 参照番号の表に入れられるもの。検索のまとまりや投稿のように一部しか無いものも入る。 */
export type RefInput = Partial<AgentMessage>;

/** 参照番号の表の1行。 */
export type RefEntry = RefInput & { ref: number; messageId: string };

/** 番号・ID・リンクを引いた結果。チャンネルへのリンクは messageId を持たない。 */
export interface ResolvedRef {
  messageId: string | null;
  channelId?: string | null | undefined;
  guildId?: string | null | undefined;
  authorId?: string | undefined;
  content?: string | undefined;
  createdAt?: number | undefined;
  ref?: number;
}

/** この実行専用の隔離タブ・コンテキスト。 */
export interface BrowserState {
  contextId: string | null;
  sandboxTargetId: string | null;
  opened: string[];
  attachedTargetId?: string | null;
  /** 内部アドレスから応答があったと分かった理由。入っていたら、この実行ではページの内容を返さない。 */
  tainted?: string | null;
  /** 隔離コンテキストのポップアップを閉じる購読の解除。 */
  stopPopupGuard?: (() => void) | null;
}

/** 1回の実行の文脈。ツールはすべてこれを受け取る。 */
export interface AgentContext {
  client: Client;
  guild: Guild;
  channel: GuildTextBasedChannel;
  member: GuildMember;
  /**
   * チャンネルを読める権限の主体。省略なら member (依頼した人の目で見る)。
   * 自発参加は誰かの依頼ではないので @everyone にして、全員に見えるものだけを読む。
   */
  viewer?: GuildMember | Role;
  me: GuildMember;
  refs: RefTable;
  screenshots: Buffer[];
  channelScope: ChannelScope;
  browserFull: boolean;
  canAttach: boolean;
  setStatus?: (status: string) => void;
  recent?: AgentMessage[];
  thread?: AgentMessage[];
  browser?: BrowserState | null;
  escalated?: boolean;
  usedMeaning?: boolean;
}

/** モデルが渡してきたツールの引数。中身はどれも確かめるまで unknown。 */
export type ToolArgs = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 外から来た値の中の1項目を文字列として読む。無ければ undefined。 */
export function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

export function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}

export function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

/** throw されたものからメッセージを取り出す。Error でなくても落ちない。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** throw されたものの Discord のエラーコード (10008 など)。 */
export function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** throw されたものの HTTP ステータス (discord.js の DiscordAPIError は status を持つ)。 */
export function errorStatus(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
}
