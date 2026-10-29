import { db as archive } from '../../archive/db.js';
import { NameBook, cleanText, extrasOf, idAfter, type MessageRow } from '../transcript.js';
import { memoryDb } from '../store.js';
import type { LineInfo, RenderedSection, SectionRange, UnitInfo } from './types.js';

// S0 準備 (機械)。アーカイブを「区間」に切り、区間ごとに台本を作る。
//
// 区間 = 同じチャンネルの会話単位 (20 分以上空くまでの連なり) を約 2 万字ずつ詰めたもの。
//   - 会話の途中で切らない。1 つの会話が 2 万字を超えるときだけ、いちばん空いた所で割る
//   - 割った続きの区間には、前の 6 行を「読むだけ」の文脈として付ける
//   - 区間は範囲 (チャンネル + 最初と最後の発言) だけ持つ。台本はいつでも同じものが作れる
//
// 台本:
//   [凡例] A1=たこ / A2=さば
//   ## #雑談 2025-03-14
//   ### c1 (3発言)
//   1|14:02 A1: 今日のデプロイ落ちた / ログ見る
//   2|A2→A1: DB のロックっぽい
//
// 発言者は author_id ごとのコード (A1…) で見せる。表示名は人を表さない (同じ人が名前を変える・別の人が同じ名前になる)。
// モデルは行番号とコードを返し、話者・時刻・原文はこちらが行番号から決める。

const TZ_MS = Number(process.env.ARCHIVE_TZ_OFFSET_HOURS ?? 9) * 3_600_000;
export const GAP_MS = 20 * 60_000;          // これ以上空いたら別の会話
const TIME_GAP_MS = 10 * 60_000;            // これ以上空いたら行頭に時刻を書く
const MERGE_MS = 3 * 60_000;                // 同じ人がこの間に続けて書いたら 1 行にまとめる
export const SECTION_CHARS = Number(process.env.MEMORY_V2_SECTION_CHARS || 20000);
const CONTEXT_LINES = 6;
const EXCERPT_CHARS = 30;
const LINE_OVERHEAD = 12;                   // 行番号・時刻・コードの分 (計画の見積もり用)

const local = (ms: number): string => new Date(ms + TZ_MS).toISOString();

// ---- 計画 ------------------------------------------------------------------

/** 計画に要る最小の情報 (使える発言 1 件)。 */
export interface Slim {
  id: string;
  at: number;
  len: number;
}

const sum = (rows: readonly Slim[]): number => rows.reduce((total, row) => total + row.len, 0);

/** 1 つの長い会話を、いちばん空いた所で割る (target を少し超える手前の 3 割の範囲で選ぶ)。 */
export function splitLong(unit: readonly Slim[], target: number): Slim[][] {
  const parts: Slim[][] = [];
  let start = 0;
  while (sum(unit.slice(start)) > target * 1.25) {
    let end = start;
    let acc = 0;
    while (end < unit.length && acc < target) { acc += unit[end]?.len ?? 0; end += 1; }
    let lo = start + 1;
    let seen = 0;
    for (let i = start; i < end; i += 1) {
      seen += unit[i]?.len ?? 0;
      if (seen >= acc * 0.7) { lo = Math.max(start + 1, i); break; }
    }
    let cut = end;
    let best = -1;
    for (let k = lo; k <= end && k < unit.length; k += 1) {
      const gap = (unit[k]?.at ?? 0) - (unit[k - 1]?.at ?? 0);
      if (gap >= best) { best = gap; cut = k; }
    }
    parts.push(unit.slice(start, cut));
    start = cut;
  }
  parts.push(unit.slice(start));
  return parts.filter((part) => part.length > 0);
}

/** 使える発言を、区間の範囲に詰める。 */
export function planFrom(rows: Iterable<Slim>, channelId: string, target = SECTION_CHARS): SectionRange[] {
  const units: Slim[][] = [];
  let unit: Slim[] = [];
  for (const row of rows) {
    const last = unit.at(-1);
    if (last && row.at - last.at >= GAP_MS) { units.push(unit); unit = []; }
    unit.push(row);
  }
  if (unit.length) units.push(unit);

  const sections: Slim[][] = [];
  let current: Slim[] = [];
  let currentChars = 0;
  const flush = (): void => { if (current.length) sections.push(current); current = []; currentChars = 0; };
  for (const u of units) {
    const chars = sum(u);
    if (chars > target * 1.25) {
      flush();
      const parts = splitLong(u, target);
      for (const part of parts.slice(0, -1)) sections.push(part);
      current = [...(parts.at(-1) ?? [])];
      currentChars = sum(current);
    } else if (current.length && currentChars + chars > target * 1.15) {
      flush();
      current = [...u];
      currentChars = chars;
    } else {
      current.push(...u);
      currentChars += chars;
    }
  }
  flush();
  return sections.map((rowsOf) => {
    const first = rowsOf[0] as Slim;
    const last = rowsOf.at(-1) as Slim;
    return { channelId, fromId: first.id, toId: last.id, fromMs: first.at, toMs: last.at, messages: rowsOf.length, chars: sum(rowsOf) };
  });
}

const MESSAGE_COLUMNS = `message_id, author_id, author_name, content, created_at, reply_to,
  attachment_count, attachment_kinds, sticker_count, embed_count`;

const bodyOf = (row: MessageRow): string => [cleanText(row.content), extrasOf(row)].filter(Boolean).join(' ');

/** どこから・どこまで計画するか。after は読み終えた最後の発言 (この次から)、until はこの時刻より新しい発言は待つ (会話の途中で切らない)。 */
export interface PlanWindow { afterMs?: number; afterId?: string; untilMs?: number }

/** チャンネルの使える発言 (bot・削除済み・中身が空を除く) を時刻順に。計画と台本で同じ並びにする。 */
function* usableRows(channelId: string, { afterMs, afterId, untilMs }: PlanWindow = {}): Generator<MessageRow> {
  const statement = archive.prepare<[string, number, number], MessageRow>(`
    SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel_id = ? AND deleted = 0 AND is_bot = 0 AND created_at >= ? AND created_at <= ?
    ORDER BY created_at, message_id
  `);
  for (const row of statement.iterate(channelId, afterMs ?? 0, untilMs ?? Number.MAX_SAFE_INTEGER)) {
    if (afterMs !== undefined && afterId !== undefined && row.created_at === afterMs && !idAfter(row.message_id, afterId)) continue;
    if (bodyOf(row)) yield row;
  }
}

export function planChannel(channelId: string, target = SECTION_CHARS, window: PlanWindow = {}): SectionRange[] {
  function* slim(): Generator<Slim> {
    for (const row of usableRows(channelId, window)) yield { id: row.message_id, at: row.created_at, len: bodyOf(row).length + LINE_OVERHEAD };
  }
  return planFrom(slim(), channelId, target);
}

/**
 * 公開チャンネルすべての区間を v2_sections に入れる。既にあるものは触らず、各チャンネルの最後の区間の次から計画する
 * (= 新着だけ。何度呼んでもよい)。settleMs より新しい発言は、会話が続いているかもしれないので次の回に回す。
 */
export function planGuild(guildId: string, channelIds: readonly string[], target = SECTION_CHARS, now = Date.now(), { settleMs = 0 }: { settleMs?: number } = {}): { channels: number; sections: number; added: number } {
  const d = memoryDb();
  const insert = d.prepare(`
    INSERT OR IGNORE INTO v2_sections (guild_id, depth, channel_id, from_id, to_id, from_ms, to_ms, messages, chars, updated_at)
    VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const last = d.prepare<[string, string], { to_id: string; to_ms: number }>(
    'SELECT to_id, to_ms FROM v2_sections WHERE guild_id = ? AND channel_id = ? ORDER BY to_ms DESC, id DESC LIMIT 1');
  let sections = 0;
  let added = 0;
  for (const channelId of channelIds) {
    const tail = last.get(guildId, channelId);
    const ranges = planChannel(channelId, target, { ...(tail ? { afterMs: tail.to_ms, afterId: tail.to_id } : {}), untilMs: now - settleMs });
    d.transaction(() => {
      for (const r of ranges) {
        added += insert.run(guildId, r.channelId, r.fromId, r.toId, r.fromMs, r.toMs, r.messages, r.chars, now).changes;
      }
    })();
    sections += ranges.length;
  }
  return { channels: channelIds.length, sections, added };
}

// ---- 台本 ------------------------------------------------------------------

/** 範囲の発言 (前後の端は発言 ID で切る)。 */
export function loadRange(range: SectionRange): MessageRow[] {
  const rows = archive.prepare<[string, number, number], MessageRow>(`
    SELECT ${MESSAGE_COLUMNS} FROM messages
    WHERE channel_id = ? AND deleted = 0 AND is_bot = 0 AND created_at BETWEEN ? AND ? ORDER BY created_at, message_id
  `).all(range.channelId, range.fromMs, range.toMs);
  const start = rows.findIndex((row) => row.message_id === range.fromId);
  const end = rows.findLastIndex((row) => row.message_id === range.toId);
  return rows.slice(Math.max(0, start), end < 0 ? rows.length : end + 1).filter((row) => bodyOf(row));
}

/** 区間の直前の発言 (同じ会話が続いているときだけ、最大 CONTEXT_LINES 件)。 */
function loadBefore(range: SectionRange, firstAt: number): MessageRow[] {
  const rows = archive.prepare<[string, number, string], MessageRow>(`
    SELECT ${MESSAGE_COLUMNS} FROM messages
    WHERE channel_id = ? AND deleted = 0 AND is_bot = 0 AND created_at <= ? AND message_id <> ?
    ORDER BY created_at DESC, message_id DESC LIMIT 30
  `).all(range.channelId, firstAt, range.fromId).filter((row) => bodyOf(row)
    && (row.created_at < firstAt || idAfter(range.fromId, row.message_id)));
  const picked: MessageRow[] = [];
  let at = firstAt;
  for (const row of rows) {
    if (picked.length >= CONTEXT_LINES || at - row.created_at >= GAP_MS) break;
    picked.unshift(row);
    at = row.created_at;
  }
  return picked;
}

interface ParentRow { author_id: string; author_name: string; is_bot: number; content: string }

export interface RenderOptions {
  book?: NameBook;
  /** 指定すると、この会話単位だけを台本に出す (行番号は全体のまま)。 */
  onlyConvs?: ReadonlySet<string>;
}

/** 区間の台本。同じ範囲からは同じ台本ができる。 */
export function renderSection(guildId: string, range: SectionRange, { book = new NameBook(guildId), onlyConvs }: RenderOptions = {}): RenderedSection {
  const rows = loadRange(range);
  const before = rows[0] ? loadBefore(range, rows[0].created_at) : [];
  const inRange = new Set(rows.map((row) => row.message_id));

  // 発言者コード: 出てきた順
  const codes = new Map<string, string>();
  const authors = new Map<string, string>();
  const names = new Map<string, string>();
  const codeOf = (authorId: string, fallback: string | null): string => {
    let code = codes.get(authorId);
    if (code === undefined) {
      code = `A${codes.size + 1}`;
      codes.set(authorId, code);
      authors.set(code, authorId);
      names.set(code, book.person(authorId, fallback));
    }
    return code;
  };
  for (const row of [...before, ...rows]) codeOf(row.author_id, row.author_name);

  const parentStatement = archive.prepare<[string], ParentRow>('SELECT author_id, author_name, is_bot, content FROM messages WHERE message_id = ?');
  const textOf = (row: MessageRow): string => {
    const content = String(row.content ?? '')
      .replace(/<@&\d+>/g, '@ロール')
      .replace(/<@!?(\d+)>/g, (_, id: string) => `@${codes.get(id) ?? book.person(id, null)}`)
      .replace(/<#(\d+)>/g, (_, id: string) => book.channel(id));
    return bodyOf({ ...row, content });
  };
  const excerpt = (content: string): string => {
    const text = cleanText(content).replace(/<@!?\d+>/g, '@…');
    return [...text].length > EXCERPT_CHARS ? `${[...text].slice(0, EXCERPT_CHARS).join('')}…` : text;
  };
  const targetOf = (row: MessageRow): string => {
    if (!row.reply_to) return '';
    const parent = parentStatement.get(row.reply_to);
    if (!parent) return '';
    if (parent.is_bot) return `→[bot]「${excerpt(parent.content)}」`;
    if (parent.author_id === row.author_id) return '';
    const code = codeOf(parent.author_id, parent.author_name);
    return inRange.has(row.reply_to) ? `→${code}` : `→${code}「${excerpt(parent.content)}」`;
  };

  const label = book.channel(range.channelId);
  const out: string[] = [];
  const lines = new Map<number, LineInfo>();
  const units: UnitInfo[] = [];

  if (before.length) {
    out.push('(前の区間の続き。読むだけで、根拠にしない)');
    for (const row of before) out.push(`  ${codeOf(row.author_id, row.author_name)}${targetOf(row)}: ${textOf(row)}`);
  }

  let lineNo = 1;
  let lastDate: string | null = null;
  let lastTimeShown = -Infinity;
  let prev: { authorId: string; at: number } | null = null;
  let unit: { conv: string; fromLine: number; messages: number; fromMs: number; toMs: number; out: string[] } | null = null;
  const unitOut: Map<string, string[]> = new Map();

  const closeUnit = (): void => {
    if (!unit) return;
    units.push({ conv: unit.conv, fromLine: unit.fromLine, toLine: lineNo - 1, messages: unit.messages, fromMs: unit.fromMs, toMs: unit.toMs });
    unit.out[0] = `### ${unit.conv} (${unit.messages}発言)`;
    unitOut.set(unit.conv, unit.out);
    unit = null;
  };

  let prevAt = -Infinity;
  for (const row of rows) {
    if (!unit || row.created_at - prevAt >= GAP_MS) {
      closeUnit();
      const conv = `c${units.length + 1}`;
      unit = { conv, fromLine: lineNo, messages: 0, fromMs: row.created_at, toMs: row.created_at, out: [''] };
      prev = null;
      lastTimeShown = -Infinity;
    }
    const at = local(row.created_at);
    const date = at.slice(0, 10);
    const code = codeOf(row.author_id, row.author_name);
    const target = targetOf(row);
    const body = textOf(row);
    const canMerge = prev && prev.authorId === row.author_id && !target && date === lastDate && row.created_at - prev.at <= MERGE_MS;
    if (canMerge) {
      const index = unit.out.length - 1;
      unit.out[index] += ` / ${body}`;
      const entry = lines.get(lineNo - 1);
      if (entry) { entry.ids.push(row.message_id); entry.lastMs = row.created_at; }
    } else {
      if (date !== lastDate) unit.out.push(`## ${label} ${date}`);
      const time = row.created_at - lastTimeShown >= TIME_GAP_MS || date !== lastDate ? `${at.slice(11, 16)} ` : '';
      unit.out.push(`${lineNo}|${time}${code}${target}: ${body}`);
      lines.set(lineNo, { ids: [row.message_id], authorId: row.author_id, code, firstMs: row.created_at, lastMs: row.created_at, conv: unit.conv });
      if (time) lastTimeShown = row.created_at;
      lastDate = date;
      lineNo += 1;
    }
    prev = { authorId: row.author_id, at: row.created_at };
    prevAt = row.created_at;
    unit.messages += 1;
    unit.toMs = row.created_at;
  }
  closeUnit();

  for (const u of units) {
    if (onlyConvs && !onlyConvs.has(u.conv)) continue;
    const unitLines = unitOut.get(u.conv) ?? [];
    // 一部の会話だけを出すときは、日付の見出しが前の会話に付いていることがあるので、その会話の頭に付け直す
    if (onlyConvs && !unitLines[1]?.startsWith('## ')) out.push(unitLines[0] ?? '', `## ${label} ${local(u.fromMs).slice(0, 10)}`, ...unitLines.slice(1));
    else out.push(...unitLines);
  }

  // 凡例: 同じ名前が 2 人いたら、author_id の末尾で見分ける
  const counts = new Map<string, number>();
  for (const name of names.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const [authorId, code] of codes) {
    const name = names.get(code) ?? '';
    labels.set(code, (counts.get(name) ?? 0) > 1 || /^deleted user/i.test(name) ? `${name}#${authorId.slice(-4)}` : name);
  }
  const text = [`[凡例] ${[...labels].map(([code, name]) => `${code}=${name}`).join(' / ')}`, ...out].join('\n');
  return { range, label, text, lines, units, codes, authors, labels, lineEnd: lineNo };
}

/** 区間を、真ん中あたりでいちばん空いた所で 2 つに割る (出力が長さで切れたとき)。割れなければ null。 */
export function splitRange(range: SectionRange): [SectionRange, SectionRange] | null {
  const rows = loadRange(range);
  if (rows.length < 4) return null;
  const lens = rows.map((row) => bodyOf(row).length + LINE_OVERHEAD);
  const total = lens.reduce((a, b) => a + b, 0);
  let acc = 0;
  let lo = 1;
  let hi = rows.length - 1;
  for (let i = 0; i < rows.length; i += 1) {
    acc += lens[i] ?? 0;
    if (acc < total * 0.4) lo = i + 1;
    if (acc <= total * 0.6) hi = i + 1;
  }
  hi = Math.max(lo, Math.min(hi, rows.length - 1));
  let cut = lo;
  let best = -1;
  const middle = rows.length / 2;
  for (let k = lo; k <= hi; k += 1) {
    const gap = (rows[k]?.created_at ?? 0) - (rows[k - 1]?.created_at ?? 0);
    // いちばん空いた所。同じなら真ん中に近いほう
    if (gap > best || (gap === best && Math.abs(k - middle) < Math.abs(cut - middle))) { best = gap; cut = k; }
  }
  const make = (part: MessageRow[]): SectionRange => ({
    channelId: range.channelId, fromId: (part[0] as MessageRow).message_id, toId: (part.at(-1) as MessageRow).message_id,
    fromMs: (part[0] as MessageRow).created_at, toMs: (part.at(-1) as MessageRow).created_at, messages: part.length,
    chars: part.reduce((sum, row) => sum + bodyOf(row).length + LINE_OVERHEAD, 0)
  });
  return [make(rows.slice(0, cut)), make(rows.slice(cut))];
}

/** 範囲の端と件数から、区間の説明 (ログ用)。 */
export const describeSection = (range: SectionRange, label = range.channelId): string =>
  `${label} ${local(range.fromMs).slice(0, 10)}〜${local(range.toMs).slice(0, 10)} ${range.messages}発言`;

/** 台本の行 → 原文の発言 ID。範囲外・存在しない行は null。 */
export function messageIdsOf(section: RenderedSection, lineNumbers: readonly number[]): string[] {
  const ids: string[] = [];
  for (const n of lineNumbers) for (const id of section.lines.get(n)?.ids ?? []) if (!ids.includes(id)) ids.push(id);
  return ids;
}
