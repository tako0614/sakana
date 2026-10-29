import type { Statement } from 'better-sqlite3';
import { db as archive } from '../archive/db.js';
import { getCursor } from './store.js';
import type { Cursor, LineEntry, Pack, RenderedSegment } from './types.js';

// アーカイブを、AI に渡す短い台本にする。
//
// 実測 (2026-10): 発言の平均は 15.9 字、半分が 5 字以下。旧 Writer は 1 発言を
// JSON の封筒 (約 930 バイト) に包んで渡していたので、中身の何十倍も包装に払っていた。
// ここでは 1 行 = 「時刻 名前: 本文」だけにして、時刻も間が空いたときしか書かない。
//
//   ## #雑談 2025-03-14
//   1|14:02 たこ: 今日のデプロイ落ちた / ログ見る
//   2|さば→たこ: DB のロックっぽい
//
// 行頭の番号は区切りの中で通し。モデルは出来事の根拠を行番号で返し、
// こちらで message_id に戻す (ID そのものを渡すと1行あたりの長さが倍になる)。

const TZ_MS = Number(process.env.ARCHIVE_TZ_OFFSET_HOURS ?? 9) * 3_600_000;
const TIME_GAP_MS = 10 * 60_000;   // これ以上空いたら時刻を書く
const MERGE_MS = 3 * 60_000;       // 同じ人がこの間に続けて書いたら1行にまとめる
const MESSAGE_CHARS = 500;         // ログやコードの貼り付けで区切りを埋めない
const PAGE = 500;

const local = (ms: number): string => new Date(ms + TZ_MS).toISOString();

/** snowflake 同士の比較。桁数が違うと文字列比較は狂う。 */
export function idAfter(a: string, b: string): boolean {
  const x = String(a);
  const y = String(b);
  return x.length !== y.length ? x.length > y.length : x > y;
}

const afterCursor = (row: { created_at: number; message_id: string }, cursor: Cursor | null | undefined): boolean => !cursor
  || row.created_at > cursor.last_ms
  || (row.created_at === cursor.last_ms && idAfter(row.message_id, cursor.last_id));

export interface MessageRow {
  message_id: string;
  author_id: string;
  author_name: string;
  content: string;
  created_at: number;
  reply_to: string | null;
  attachment_count: number;
  attachment_kinds: string;
  sticker_count: number;
  embed_count: number;
}

interface ChannelRow {
  name: string;
  is_thread: number;
  parent_id: string | null;
}

interface Statements {
  page: Statement<[string, number, number], MessageRow>;
  head: Statement<[string, number], { message_id: string; created_at: number }>;
  latestName: Statement<[string, string], { author_name: string }>;
  replyAuthor: Statement<[string], { author_id: string; author_name: string }>;
  channel: Statement<[string], ChannelRow>;
}

let statements: Statements | null = null;
function sql(): Statements {
  statements ??= {
    page: archive.prepare<[string, number, number], MessageRow>(`
      SELECT message_id, author_id, author_name, content, created_at, reply_to,
        attachment_count, attachment_kinds, sticker_count, embed_count
      FROM messages
      WHERE channel_id = ? AND deleted = 0 AND is_bot = 0 AND created_at >= ?
      ORDER BY created_at LIMIT ?
    `),
    head: archive.prepare<[string, number], { message_id: string; created_at: number }>(`
      SELECT message_id, created_at FROM messages
      WHERE channel_id = ? AND deleted = 0 AND is_bot = 0 AND created_at >= ?
      ORDER BY created_at LIMIT 20
    `),
    // 表示名は時期で変わる。木の中で同じ人が別名に割れないよう、最新の名前に揃える。
    latestName: archive.prepare<[string, string], { author_name: string }>(`
      SELECT author_name FROM messages
      WHERE guild_id = ? AND author_id = ? AND author_name <> ''
      ORDER BY created_at DESC LIMIT 1
    `),
    replyAuthor: archive.prepare<[string], { author_id: string; author_name: string }>('SELECT author_id, author_name FROM messages WHERE message_id = ?'),
    channel: archive.prepare<[string], ChannelRow>('SELECT name, is_thread, parent_id FROM channels WHERE channel_id = ?')
  };
  return statements;
}

export class NameBook {
  readonly guildId: string;
  readonly names = new Map<string, string>();
  readonly channels = new Map<string, string>();

  constructor(guildId: string) {
    this.guildId = guildId;
  }

  person(authorId: string, fallback: string | null | undefined): string {
    let name = this.names.get(authorId);
    if (name === undefined) {
      const row = sql().latestName.get(this.guildId, authorId);
      name = (row?.author_name || fallback || 'unknown').replace(/[\n:]/g, ' ').trim();
      this.names.set(authorId, name);
    }
    return name;
  }

  channel(channelId: string): string {
    let label = this.channels.get(channelId);
    if (label === undefined) {
      const row = sql().channel.get(channelId);
      label = `#${row?.name ?? channelId}`;
      if (row?.is_thread && row.parent_id) {
        const parent = sql().channel.get(row.parent_id);
        if (parent?.name) label = `#${parent.name} › ${row.name}`;
      }
      this.channels.set(channelId, label);
    }
    return label;
  }
}

export function extrasOf(row: MessageRow): string {
  const out: string[] = [];
  if (row.attachment_count > 0) out.push(/image/.test(row.attachment_kinds ?? '') ? '[画像]' : '[添付]');
  if (row.sticker_count > 0) out.push('[スタンプ]');
  if (row.embed_count > 0 && !row.content) out.push('[埋め込み]');
  return out.join('');
}

export function cleanText(content: string | null | undefined): string {
  let text = String(content ?? '')
    .replace(/https?:\/\/\S+/g, (url) => (url.length > 70 ? `${url.slice(0, 67)}…` : url))
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/\s*\n+\s*/g, ' / ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if ([...text].length > MESSAGE_CHARS) text = `${[...text].slice(0, MESSAGE_CHARS).join('')}…`;
  return text;
}

/** fromId の直前を指す cursor (失敗した区切りを最初から読み直す用)。 */
export function cursorBefore(fromId: string, fromMs: number): Cursor {
  return { last_id: (BigInt(fromId) - 1n).toString(), last_ms: fromMs };
}

/** 次に読む発言の時刻。無ければ null。 */
export function nextMessageAt(channelId: string, cursor: Cursor | null): number | null {
  for (const row of sql().head.all(channelId, cursor?.last_ms ?? 0)) {
    if (afterCursor(row, cursor)) return row.created_at;
  }
  return null;
}

/**
 * 1チャンネルぶんを cursor の続きから maxChars まで台本にする。
 * 空の発言 (本文も添付も無い) も cursor は進める。until を渡すとそこで止める。
 */
export interface RenderSegmentOptions {
  guildId: string;
  channelId: string;
  cursor: Cursor | null;
  maxChars: number;
  until?: { id: string; ms: number } | null;
  lineStart?: number;
  book?: NameBook;
}

export function renderSegment({ guildId, channelId, cursor, maxChars, until = null, lineStart = 1, book = new NameBook(guildId) }: RenderSegmentOptions): RenderedSegment | null {
  const label = book.channel(channelId);
  const lines: string[] = [];
  let chars = 0;
  let consumed = 0;
  let first: MessageRow | null = null;
  let last: MessageRow | null = null;
  let lastDate: string | null = null;
  let lastTimeShown = -Infinity;
  let prev: { author: string; at: number } | null = null;          // 直前の行 (まとめる判定用)
  let lineNo = lineStart;
  const lineMap = new Map<number, LineEntry>(); // 行番号 → { ids, channelId, firstMs, lastMs }
  let exhausted = false;
  let position: Cursor | null = cursor ? { ...cursor } : null;

  const push = (line: string): void => { lines.push(line); chars += line.length + 1; };

  outer:
  for (;;) {
    const rows = sql().page.all(channelId, position?.last_ms ?? 0, PAGE).filter((row) => afterCursor(row, position));
    if (rows.length === 0) { exhausted = true; break; }
    for (const row of rows) {
      // 失敗した区切りのやり直しは、元の終わり (until) で止める
      if (until && afterCursor(row, { last_id: until.id, last_ms: until.ms })) { exhausted = true; break outer; }
      const text = cleanText(row.content);
      const extras = extrasOf(row);
      const body = [text, extras].filter(Boolean).join(' ');
      const at = local(row.created_at);
      const date = at.slice(0, 10);

      if (body) {
        const name = book.person(row.author_id, row.author_name);
        let target = '';
        if (row.reply_to) {
          const parent = sql().replyAuthor.get(row.reply_to);
          if (parent && parent.author_id !== row.author_id) target = `→${book.person(parent.author_id, parent.author_name)}`;
        }
        const canMerge = prev && prev.author === row.author_id && !target && date === lastDate
          && row.created_at - prev.at <= MERGE_MS;
        let addition: string;
        let header = '';
        if (canMerge) {
          addition = ` / ${body}`;
        } else {
          if (date !== lastDate) header = `## ${label} ${date}`;
          const time = date !== lastDate || row.created_at - lastTimeShown >= TIME_GAP_MS ? `${at.slice(11, 16)} ` : '';
          addition = `${lineNo}|${time}${name}${target}: ${body}`;
        }
        // 1件は必ず入れる (巨大な1発言で永遠に進まないのを防ぐ)
        if (consumed > 0 && chars + header.length + addition.length > maxChars) break outer;

        if (canMerge) {
          lines[lines.length - 1] += addition;
          chars += addition.length;
          // まとめられるのは直前に書いた行 (canMerge は prev があるときだけ) なので、その行の対応は必ずある
          const entry = lineMap.get(lineNo - 1);
          if (entry) {
            entry.ids.push(row.message_id);
            entry.lastMs = row.created_at;
          }
        } else {
          if (header) push(header);
          push(addition);
          lineMap.set(lineNo, { ids: [row.message_id], channelId, firstMs: row.created_at, lastMs: row.created_at });
          lineNo += 1;
          if (date !== lastDate || row.created_at - lastTimeShown >= TIME_GAP_MS) lastTimeShown = row.created_at;
          lastDate = date;
        }
        prev = { author: row.author_id, at: row.created_at };
      }

      consumed += 1;
      first ??= row;
      last = row;
      position = { last_id: row.message_id, last_ms: row.created_at };
    }
    if (rows.length < PAGE) {
      // ページが尽きた = この時点の末尾まで読んだ
      const more = sql().page.all(channelId, position?.last_ms ?? 0, 5).some((row) => afterCursor(row, position));
      if (!more) { exhausted = true; break; }
    }
  }

  if (!first || !last) return null;
  return {
    channelId,
    label,
    fromId: first.message_id,
    toId: last.message_id,
    fromMs: first.created_at,
    toMs: last.created_at,
    messages: consumed,
    chars,
    text: lines.join('\n'),
    lineMap,
    lineEnd: lineNo,
    exhausted
  };
}

/**
 * 次の1回ぶん (pack) を組む。いちばん古い続きを持つチャンネルから順に、
 * 合計 targetChars まで複数チャンネルを詰める (小さいチャンネルで1回を使い切らない)。
 *
 * 新着の尻尾は貯まるまで待つ: 合計が minChars 未満で、どの区切りも
 * idleMs 以内に発言があったなら null (呼び出しの回数を新着の件数に比例させない)。
 */
export interface PlanPackOptions {
  guildId: string;
  channelIds: readonly string[];
  targetChars: number;
  minChars?: number;
  idleMs?: number;
  now?: number;
  exclude?: ReadonlySet<string> | null;
}

export function planPack({ guildId, channelIds, targetChars, minChars = 0, idleMs = 0, now = Date.now(), exclude = null }: PlanPackOptions): Pack | null {
  const queue: { channelId: string; cursor: Cursor | null; at: number }[] = [];
  for (const channelId of channelIds) {
    if (exclude?.has(channelId)) continue;   // 同じ波で別の区切りが読んでいるチャンネル
    const cursor = getCursor(guildId, channelId);
    const at = nextMessageAt(channelId, cursor);
    if (at !== null) queue.push({ channelId, cursor, at });
  }
  queue.sort((a, b) => a.at - b.at);

  const book = new NameBook(guildId);
  const segments: RenderedSegment[] = [];
  let used = 0;
  let lineStart = 1;
  for (const entry of queue) {
    const remaining = targetChars - used;
    if (remaining < Math.min(2000, targetChars / 4)) break;
    const segment = renderSegment({ guildId, channelId: entry.channelId, cursor: entry.cursor, maxChars: remaining, lineStart, book });
    if (!segment) continue;
    segments.push(segment);
    used += segment.chars;
    lineStart = segment.lineEnd;
  }
  if (segments.length === 0) return null;

  const stale = segments.some((segment) => !segment.exhausted || segment.toMs <= now - idleMs);
  if (used < minChars && !stale) return null;
  return packOf(segments);
}

/** 区切りの集まりを1回ぶんにする。行番号の対応表をまとめる。 */
export function packOf(segments: RenderedSegment[]): Pack {
  const lineMap = new Map<number, LineEntry>();
  for (const segment of segments) for (const [n, entry] of segment.lineMap) lineMap.set(n, entry);
  return {
    segments,
    lineMap,
    chars: segments.reduce((sum, segment) => sum + segment.chars, 0),
    text: segments.map((segment) => segment.text).join('\n\n')
  };
}
