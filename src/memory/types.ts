// 記憶のモジュールどうしで受け渡す形と、外から来た値 (state 表の JSON・モデルの出力) を
// 確かめる小さな型ガード。

import { arrayOf, isRecord } from '../ai/types.js';

export { arrayOf, detailsOf, errorMessage, isRecord, type JsonRecord } from '../ai/types.js';

/** 文字列だけを残す (別名・発言 ID の JSON 配列用)。配列でなければ空。 */
export const stringList = (value: unknown): string[] =>
  arrayOf(value).filter((item): item is string => typeof item === 'string');

/** state の値の `count` (失敗の回数など)。無い・数でなければ 0。 */
export const countOf = (value: unknown): number =>
  isRecord(value) && typeof value.count === 'number' ? value.count : 0;

/** エラーに付いた `code` (Discord の 10062、予算の MODEL_BUDGET_* など)。 */
export const errorCode = (error: unknown): unknown => (isRecord(error) ? error.code : undefined);

// ---- 区切り (transcript.ts → build.ts) ----------------------------------------

export interface Cursor {
  last_id: string;
  last_ms: number;
}

/** 行番号 → 根拠の発言。まとめた行は複数の ID を持つ。 */
export interface LineEntry {
  ids: string[];
  channelId: string;
  firstMs: number;
  lastMs: number;
}

export interface SegmentRecord {
  channelId: string;
  fromId: string;
  toId: string;
  fromMs: number;
  toMs: number;
  messages: number;
  chars: number;
}

export interface RenderedSegment extends SegmentRecord {
  label: string;
  text: string;
  lineMap: Map<number, LineEntry>;
  lineEnd: number;
  exhausted: boolean;
}

export interface Pack {
  segments: RenderedSegment[];
  lineMap: Map<number, LineEntry>;
  chars: number;
  text: string;
}

// ---- state 表に控える値 -------------------------------------------------------

export interface Totals {
  messages: number;
  channels: number;
  at: number;
}

export const isTotals = (value: unknown): value is Totals =>
  isRecord(value) && typeof value.messages === 'number' && typeof value.channels === 'number' && typeof value.at === 'number';

export interface PauseState {
  by: string;
  at: number;
}

export const isPauseState = (value: unknown): value is PauseState =>
  isRecord(value) && typeof value.by === 'string';

export interface LockState {
  pid: number;
  host: string;
  at: number;
}

export const isLockState = (value: unknown): value is LockState =>
  isRecord(value) && typeof value.pid === 'number' && typeof value.host === 'string' && typeof value.at === 'number';

// ---- 原文を見せる範囲 ---------------------------------------------------------

/**
 * 依頼した人が読めるチャンネルの範囲 (src/archive/permissions.js の getChannelScope と同じ形。
 * agent の ctx.channelScope)。ids が空なら all と同じ。
 */
export interface ChannelScope {
  mode: 'all' | 'none' | 'include' | 'exclude';
  ids: readonly string[];
}

/** そのチャンネルの発言の原文 (本文・リンク) を、いま見ている人に見せてよいか。 */
export type QuoteFilter = (channelId: string) => boolean;

/** archive/search.js の isChannelAllowed と同じ判定。 */
export function scopeAllows(channelId: string, scope: ChannelScope): boolean {
  if (scope.mode === 'none') return false;
  if (scope.ids.length === 0) return true;
  const included = scope.ids.includes(channelId);
  return scope.mode === 'exclude' ? !included : included;
}
