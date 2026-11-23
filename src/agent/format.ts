// Discord sources share scoped speaker aliases, short citations and explicit source-state labels.

import type { Message } from 'discord.js';
import { TZ_OFFSET_HOURS } from '../archive/query.js';
import type { MessageRow } from '../archive/types.js';
import { archiveStructure, discordStructure, discordExtraText } from '../conversation/message.js';
import {
  isRecord,
  numberField,
  recordField,
  stringField,
  type AgentMessage,
  type RefEntry,
  type RefInput,
  type ResolvedRef
} from './types.js';

const TZ_OFFSET_MS = TZ_OFFSET_HOURS * 3_600_000;

// Discord のリンク。`https://discord.com/channels/<guild>/<channel>/<message>`
// で、末尾のメッセージは無いこと (チャンネルへのリンク) もある。DM は guild が `@me`。
const DISCORD_LINK = /discord(?:app)?\.com\/channels\/(\d{16,21}|@me)\/(\d{16,21})(?:\/(\d{16,21}))?/;

export interface DiscordRef {
  guildId: string | null;
  channelId: string | null;
  messageId: string | null;
}

/**
 * 貼られた文字列から Discord の参照を取り出す。
 *
 * ここを素の `/(\d{16,21})/` でやってはいけない。リンクにはスノーフレークが3つ
 * 並んでいて、最初に当たるのは**サーバー ID**。実際そうなっていて、リンクを貼って
 * 「これ何？」と聞くと、サーバー ID をメッセージ ID として読みに行っていた。
 *
 * リンクなら channel まで分かるので、どのチャンネルを読めばいいかも同時に確定する。
 */
export function parseDiscordRef(value: unknown): DiscordRef | null {
  const text = String(value ?? '');

  const link = DISCORD_LINK.exec(text);
  if (link) {
    const [, guild, second = null, third] = link;
    return third
      // guild/channel/message
      ? { guildId: guild === '@me' ? null : guild ?? null, channelId: second, messageId: third }
      // guild/channel (チャンネルへのリンク)
      : { guildId: guild === '@me' ? null : guild ?? null, channelId: second, messageId: null };
  }

  // リンクでなければ素のスノーフレーク。`<#123>` のようなメンションもここで拾う。
  const bare = /(\d{16,21})/.exec(text)?.[1];
  return bare ? { guildId: null, channelId: null, messageId: bare } : null;
}

/**
 * 参照番号とメッセージの対応表。1回の実行につき1つ作る。
 * モデルには番号だけを見せ、番号 → 実 ID の変換はこちらで持つ。
 */
export class RefTable {
  entries: RefEntry[];
  byMessageId: Map<string, RefEntry>;

  constructor() {
    this.entries = [];
    this.byMessageId = new Map();
  }

  add(message: RefInput | null | undefined): number | null {
    if (!message?.messageId) return null;

    const existing = this.byMessageId.get(message.messageId);
    if (existing) return existing.ref;

    const ref = this.entries.length + 1;
    const entry: RefEntry = { ref, ...message, messageId: message.messageId };
    this.entries.push(entry);
    this.byMessageId.set(message.messageId, entry);
    return ref;
  }

  /** 番号でも生の ID でも引けるようにする (モデルはどちらを渡してくるか読めない)。 */
  resolve(value: unknown): ResolvedRef | null {
    if (value === null || value === undefined) return null;

    const text = String(value).trim().replace(/^[#[]|]$/g, '');

    // 短い数字は参照番号として引く。ただし存在しなければ ID として解釈し直す
    // (モデルは番号と ID のどちらを渡してくるか読めない)。
    if (/^\d{1,4}$/.test(text)) {
      const entry = this.entries[Number(text) - 1];
      if (entry) return entry;
    }

    // リンクなら channel まで取れる。素の正規表現で先頭のスノーフレークを取ると
    // サーバー ID を掴む (リンクは guild/channel/message の順に並んでいる)。
    const parsed = parseDiscordRef(text);
    if (!parsed) return null;

    // チャンネルへのリンクにはメッセージが無い。番号を振った覚えも無いので、
    // 「どのチャンネルか」だけを返す (read はこれで channel を決められる)。
    if (!parsed.messageId) {
      return parsed.channelId ? { messageId: null, channelId: parsed.channelId } : null;
    }

    const known = this.byMessageId.get(parsed.messageId);
    if (known) return known;

    // 表に無くても、リンクから来たなら channel が分かっている
    return { messageId: parsed.messageId, channelId: parsed.channelId ?? null };
  }

  get(ref: number): RefEntry | null {
    return this.entries[ref - 1] ?? null;
  }
}

export function messageLink(entry: ResolvedRef | null | undefined): string | null {
  if (!entry?.guildId || !entry?.channelId || !entry?.messageId) return null;
  return `https://discord.com/channels/${entry.guildId}/${entry.channelId}/${entry.messageId}`;
}

const MAX_EPISODE_URLS = 3;
/** ラベルの形で本文に出す記憶 (出来事・記事) の数。メニューの選択肢になる */
const MAX_EPISODE_MARKS = 5;

// 出典の目印。文の終わりに小さなリンクとして置く (ChatGPT の出典のように、文中に)。
// ラベルは丸数字 1 文字。URL は <> で囲んで、Discord にプレビューを出させない。
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const sourceMark = (no: number): string => (no >= 1 && no <= CIRCLED.length ? (CIRCLED[no - 1] as string) : String(no));
const sourceLink = (no: number, url: string): string => `[${sourceMark(no)}](<${url}>)`;

/**
 * モデルが書いた [3] (発言の番号) と [e12] (記憶の出来事) を、文中の出典リンク ① ② … に直す。
 *
 * 番号はモデルに「どの発言を根拠にしたか」を書かせるための仕組みで、そのまま見せると地の文に括弧の数字が散る。
 * 出典は、その文の終わりに小さなリンクとして置く。番号 (①②) は本文での初出順で、同じ出典は同じ番号を使う。
 *
 * 経緯: 最初は [3] を生の URL に差し替えて本文に埋めていた。88 文字の URL が1文ごとに挟まって読めなかったので、
 * 末尾の subtext (`-# url url`) にまとめた。今度は masked link ([①](<url>)) にして、本文の中で短く出す。
 *
 * 引けなかった番号は本文から消すだけ (リンク切れを作らない)。ただし `[2024] の話ね` のように、
 * 数字の括弧が引用とは限らないので、発言の番号として引けないものは触らない。
 * [e12] は episodeUrl で実在を確かめられたものだけリンクにする (最初の3件まで)。
 */
const SUBTEXT_LINE = /^[ \t　]*-#(?:[ \t　]|$)/;

/**
 * 末尾の subtext (`-# ...`) の行を落とす。
 *
 * 返答の末尾には `-# モデル名` を付けているので、会話の履歴にそのまま入れると、モデルが footer ごと
 * 真似して自分でも書き、送るときに足す分と二重になっていた (`-# z-ai/glm-5.3-flash` が 2 行)。
 * 自作モデル側は同じ理由で行ごと落としている (mimic/respond.ts)。
 * 本文が残らないとき (経過表示 `-# thinking ...` だけの発言) は、見分けに使うので元のまま返す。
 */
export function stripTrailingSubtext(text: string): string {
  const lines = String(text ?? '').split('\n');
  let end = lines.length;
  while (end > 0 && String(lines[end - 1]).trim() === '') end -= 1;
  if (end === 0 || !SUBTEXT_LINE.test(String(lines[end - 1]))) return text;
  while (end > 0 && (String(lines[end - 1]).trim() === '' || SUBTEXT_LINE.test(String(lines[end - 1])))) end -= 1;
  return end === 0 ? text : lines.slice(0, end).join('\n');
}

/**
 * モデルが自分で書いた出典の一覧 (`[1] people/… — …` の行が末尾に並ぶもの) を落とす。
 * 出典は文の終わりに付ける決まりで、行頭の `[1]` は一覧の見出しの印にすぎない。そのまま変換すると、
 * 一覧の印が無関係な発言へのリンクになり、行の中身は内部の名前 (ページのパス・出来事の番号) の羅列になる。
 */
const FOOTNOTE_LINE = /^[ \t　]*(?:[-*・]\s*)?\[(?:\d{1,4}|e\d{1,9})\][ \t　]*\S/i;
export function dropFootnoteList(text: string): string {
  const lines = text.split('\n');
  let end = lines.length;
  const tail: number[] = [];
  while (end > 0) {
    const line = String(lines[end - 1]);
    if (line.trim() === '' || SUBTEXT_LINE.test(line)) { end -= 1; continue; }
    if (FOOTNOTE_LINE.test(line)) { tail.push(end - 1); end -= 1; continue; }
    break;
  }
  if (!tail.length || end === 0) return text;
  const drop = new Set(tail);
  return lines.filter((_, index) => !drop.has(index)).join('\n');
}

/** 出典の表示を、丸数字でなく「[たこのメッセージ]」のようなラベルにするときの指定。ラベルはコードが作る (モデルには書かせない)。 */
export interface CitationLabels {
  /** 発言 ([3]) のラベル。作れなければ null (「メッセージ」になる) */
  message?: ((entry: ResolvedRef) => string | null) | undefined;
  /** 記憶の出来事 ([e12]) のラベル。実在しない出来事なら null (番号は消すだけ) */
  episode?: ((id: number) => string | null) | undefined;
  /** 記憶の記事 ([p:people/たこ]) の id とラベル。実在しない記事なら null (記号は消すだけ) */
  page?: ((path: string) => { id: number; label: string } | null) | undefined;
  /**
   * true なら、本文には出典の目印を一切残さず (番号・ラベルとも消す)、出典は返り値の sources / messages にだけ入れる。
   * 呼び出し側が回答の下に「根拠」として並べる (発言はリンクボタン、出来事・記事はメニュー)。
   */
  below?: boolean | undefined;
}

/** ラベルに入れてよい形にする: リンクの括弧・強調・メンションを壊す記号を除き、長ければ切る (絵文字の途中では切らない)。 */
export function citationLabel(text: unknown, max = 18): string {
  const clean = String(text ?? '').replace(/[\[\]()<>*_`~|@#\\]/g, '').replace(/\s+/g, ' ').trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : clean;
}

/** 本文にラベルで出した記憶。呼び出し側が「開く」メニューにする (出てきた順) */
export interface CitedSource { kind: 'episode' | 'page'; id: number; label: string }
/** 本文の下に並べる発言 (リンクボタンになる)。url は発言へのジャンプリンク */
export interface CitedMessage { url: string; label: string }

/** 回答の下に並べる発言のリンクボタンの数 (1 行 5 個 × 2 行) */
const MAX_MESSAGE_BUTTONS = 10;

export function expandCitations(
  text: unknown,
  refs: RefTable,
  options: {
    label?: string | null;
    selfId?: string | null;
    /** 記憶の出来事 (e12) の URL。サイトが無い・そんな出来事は無いなら null (番号は消すだけ) */
    episodeUrl?: ((id: number) => string | null) | null;
    labels?: CitationLabels;
  } = {}
): string {
  return expandCitationsDetailed(text, refs, options).text;
}

/**
 * expandCitations と同じ。ラベルの形 (labels) のときは、本文に出した出来事・記事の一覧 (sources) も返す (呼び出し側が「開く」メニューにする)。
 *   発言 [3]  → [たこのメッセージ](<発言へのリンク>)   押すとその発言に飛ぶ
 *   出来事 [e12] → [出来事の題]                          本文では押せない。同じラベルのメニューから Discord の中で開く (サイトが無くても開ける)
 *   記事 [p:people/たこ] → [たこの記事]                  同上
 */
export function expandCitationsDetailed(
  text: unknown,
  refs: RefTable,
  { label = null, selfId = null, episodeUrl = null, labels }: {
    label?: string | null;
    selfId?: string | null;
    episodeUrl?: ((id: number) => string | null) | null;
    labels?: CitationLabels;
  } = {}
): { text: string; sources: CitedSource[]; messages: CitedMessage[] } {
  const raw = dropFootnoteList(String(text ?? ''));
  const numbers = new Map<string, number>();
  const episodeUrls = new Set<string>();
  /** 出典として変換した括弧の終わりの位置。続けて書かれた出典 (`[3][43]`) の2つ目を見分ける */
  const converted = new Set<number>();
  const numberOf = (url: string): number => {
    let no = numbers.get(url);
    if (no === undefined) { no = numbers.size + 1; numbers.set(url, no); }
    return no;
  };
  // ラベルの形: 同じラベルが別の出典に付くときは、丸数字を足して見分ける ([たこのメッセージ] [たこのメッセージ②])
  const labelOf = new Map<string, string>();
  const taken = new Map<string, number>();
  const uniqueLabel = (key: string, wanted: string): string => {
    const known = labelOf.get(key);
    if (known) return known;
    const count = (taken.get(wanted) ?? 0) + 1;
    taken.set(wanted, count);
    const shown = count === 1 ? wanted : `${wanted}${sourceMark(count)}`;
    labelOf.set(key, shown);
    return shown;
  };
  const cited: CitedSource[] = [];
  const messages: CitedMessage[] = [];

  // 直前の空白ごと食う。番号を抜いた跡に空白が残ると句点の前が空く。全角スペースも食う (日本語で書かせているので混ざる)。
  // 空白の連なりは先頭からしか試さない (否定の後読み)。これが無いと、番号の続かない長い空白の列で
  // 開始位置ごとに列の端まで読み直し、文字数の2乗で時間がかかる (回答はモデルが書くので、長さを抑えられない)。
  // 記事は `[p:people/たこ]` (カテゴリ/名前。`/` が無ければ `x[p:q]` のような添字・範囲と区別がつかないので引用にしない)
  const body = raw.replace(/(?<![ \t　])[ \t　]*\[(\d{1,4}|e\d{1,9}(?:[ \t]*[,、][ \t]*e\d{1,9})*|p:[^\[\]\n/]{1,40}\/[^\[\]\n]{1,150})\]/gi,
    (match: string, group: string, offset: number) => {
      const spaced = /^[ \t　]/.test(match);
      if (/^\d+$/.test(group)) {
        const entry = refs.get(Number(group));
        const url = messageLink(entry);

        // 自分の発言は根拠にならない (プロンプトで禁じても flash 系は番号を付けた)。番号だけ消す
        if (url && selfId && String(entry?.authorId) === String(selfId)) { converted.add(offset + match.length); return ''; }
        // 引けない番号は触らない
        if (!url) return match;
        // `items[1]` のような添字も引用ではない。引用は必ず語の区切りに来るので、
        // 空白で始まっていないのに直前が識別子の文字なら添字とみなす。
        // ただし `[3][43]` のように出典が続くときは、直前の `]` が (出典として変換した) 閉じ括弧なので添字ではない。
        // 変換していない括弧の直後 (`grid[1][2]`) は、これまでどおり添字。
        if (!spaced && /[\w.)\]]/.test(raw[offset - 1] ?? '') && !converted.has(offset)) return match;
        converted.add(offset + match.length);
        if (labels) {
          if (labels.below) {
            if (!messages.some((known) => known.url === url) && messages.length < MAX_MESSAGE_BUTTONS) {
              messages.push({ url, label: uniqueLabel(url, citationLabel((entry && labels.message?.(entry)) || 'メッセージ')) });
            }
            return '';
          }
          const wanted = citationLabel((entry && labels.message?.(entry)) || 'メッセージ');
          return `[${uniqueLabel(url, wanted)}](<${url}>)`;
        }
        return sourceLink(numberOf(url), url);
      }

      // 記憶の出来事 ([e3214] / [e3214, e11489]) と記事 ([p:people/たこ])。`items[e1]` のような添字は触らない。
      // `[e1][e2]` と続けて書くことはあるので `]` は数えない。
      if (!spaced && /[\w.)]/.test(raw[offset - 1] ?? '')) return match;
      converted.add(offset + match.length);
      if (/^p:/i.test(group)) {
        // 記事。ラベルの形でなければ (メニューが無い) 記号だけ消す。実在しない記事も消す
        if (!labels) return '';
        const path = group.slice(2).trim().replace(/^\/+|\/+$/g, '');
        let page: { id: number; label: string } | null = null;
        try { page = labels.page?.(path) ?? null; } catch { page = null; }
        if (!page) return '';
        const key = `n${page.id}`;
        if (!labelOf.has(key) && cited.length >= MAX_EPISODE_MARKS) return '';
        const shown = uniqueLabel(key, citationLabel(page.label));
        if (!cited.some((entry) => entry.kind === 'page' && entry.id === page.id)) cited.push({ kind: 'page', id: page.id, label: shown });
        return labels.below ? '' : `[${shown}]`;
      }
      const links: string[] = [];
      for (const id of group.match(/\d+/g) ?? []) {
        if (labels) {
          let wanted: string | null = null;
          try { wanted = labels.episode?.(Number(id)) ?? null; } catch { wanted = null; }
          if (!wanted) continue;
          const key = `e${Number(id)}`;
          if (!labelOf.has(key) && cited.length >= MAX_EPISODE_MARKS) continue;
          const shown = uniqueLabel(key, citationLabel(wanted));
          if (!cited.some((entry) => entry.kind === 'episode' && entry.id === Number(id))) cited.push({ kind: 'episode', id: Number(id), label: shown });
          if (!labels.below) links.push(`[${shown}]`);
          continue;
        }
        let url: string | null = null;
        try { url = episodeUrl?.(Number(id)) ?? null; } catch { url = null; }
        if (!url) continue;
        if (!episodeUrls.has(url) && episodeUrls.size >= MAX_EPISODE_URLS) continue;
        episodeUrls.add(url);
        links.push(sourceLink(numberOf(url), url));
      }
      return links.join('');
    });

  // どのモデルが書いたかは毎回出す (出典は文中にあるので、末尾はこれだけ)。
  // モデルが自分で書いた末尾の `-# ...` は落とす (足すのはここだけ。二重になる)
  const finished = label ? `${stripTrailingSubtext(body.trim()).trim()}\n\n-# ${label}` : body.trim();
  return { text: finished, sources: cited, messages };
}

function collapse(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function truncate(text: unknown, limit: number): string {
  const flat = collapse(text);
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}…`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** MM/DD HH:MM 形式。年が今年と違うときだけ年を足す。 */
export function shortTime(timestamp: unknown, now = Date.now()): string {
  const local = new Date(Number(timestamp) + TZ_OFFSET_MS);
  const current = new Date(now + TZ_OFFSET_MS);

  const stamp = `${pad(local.getUTCMonth() + 1)}/${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  return local.getUTCFullYear() === current.getUTCFullYear()
    ? stamp
    : `${local.getUTCFullYear()}/${stamp}`;
}

/** アーカイブ DB の行を共通形にそろえる。 */
export function fromArchiveRow(row: MessageRow, channelName?: string | null): AgentMessage {
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    channelName,
    messageId: row.message_id,
    authorId: row.author_id,
    authorName: row.author_name || 'unknown',
    isBot: Boolean(row.is_bot),
    content: row.is_bot ? stripTrailingSubtext(row.content ?? '') : row.content ?? '',
    extra: row.extra ?? '',
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted: Boolean(row.deleted),
    reactionCount: row.reaction_count ?? 0,
    replyTo: row.reply_to ?? null,
    attachmentCount: row.attachment_count ?? 0,
    structure: archiveStructure(row)
  };
}

/**
 * チャンネル名。DM には名前が無く、検証用の偽物は channel 自体を持たないことがある。
 */
function channelNameOf(message: Message): string | undefined {
  const channel: unknown = message.channel;
  return stringField(channel, 'name');
}

/** discord.js の Message を共通形にそろえる。 */
export function fromDiscordMessage(message: Message, channelName?: string | null): AgentMessage {
  return {
    guildId: message.guildId ?? message.guild?.id ?? null,
    channelId: message.channelId,
    channelName: channelName ?? channelNameOf(message),
    messageId: message.id,
    authorId: message.author?.id ?? '0',
    authorName:
      message.member?.displayName
      ?? message.author?.globalName
      ?? message.author?.username
      ?? 'unknown',
    isBot: Boolean(message.author?.bot),
    content: message.author?.bot ? stripTrailingSubtext(message.content ?? '') : message.content ?? '',
    extra: discordExtraText(message),
    createdAt: message.createdTimestamp,
    editedAt: message.editedTimestamp ?? null,
    deleted: false,
    reactionCount: [...(message.reactions?.cache?.values() ?? [])]
      .reduce((sum, reaction) => sum + (reaction.count ?? 0), 0),
    replyTo: message.reference?.messageId ?? null,
    attachmentCount: message.attachments?.size ?? 0,
    structure: discordStructure(message)
  };
}

/** Discord API の検索結果に入っている生のメッセージ。id と channel_id だけは確かめてある。 */
export interface RawMessage {
  id: string;
  channel_id: string;
  [key: string]: unknown;
}

export function isRawMessage(value: unknown): value is RawMessage {
  return isRecord(value) && typeof value.id === 'string' && typeof value.channel_id === 'string';
}

function parsedTime(value: unknown): number | null {
  return typeof value === 'string' && value ? Date.parse(value) : null;
}

/** Discord API の生 JSON (検索結果) を共通形にそろえる。 */
export function fromRawMessage(raw: RawMessage, guildId: string, channelName?: string | null): AgentMessage {
  const author = recordField(raw, 'author');
  const reactions = raw.reactions;
  const attachments = raw.attachments;
  return {
    guildId: stringField(raw, 'guild_id') ?? guildId,
    channelId: raw.channel_id,
    channelName,
    messageId: raw.id,
    authorId: stringField(author, 'id') ?? '0',
    authorName:
      stringField(raw.member, 'nick')
      ?? stringField(author, 'global_name')
      ?? stringField(author, 'username')
      ?? 'unknown',
    isBot: Boolean(author?.bot),
    content: author?.bot ? stripTrailingSubtext(stringField(raw, 'content') ?? '') : stringField(raw, 'content') ?? '',
    extra: discordExtraText(raw),
    createdAt: parsedTime(raw.timestamp) ?? Date.now(),
    editedAt: parsedTime(raw.edited_timestamp),
    deleted: false,
    reactionCount: Array.isArray(reactions)
      ? reactions.reduce((sum: number, reaction: unknown) => sum + (numberField(reaction, 'count') ?? 0), 0)
      : null,
    replyTo: stringField(raw.referenced_message, 'id') ?? stringField(raw.message_reference, 'message_id') ?? null,
    attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
    structure: discordStructure(raw)
  };
}

export interface ConversationRenderOptions {
  showChannel?: boolean;
  bodyChars?: number;
  tailOf?: ((message: AgentMessage) => string | null) | null;
}

export interface FormatOptions extends ConversationRenderOptions {
  refs?: RefTable | undefined;
  selfId?: string | null | undefined;
  /** Cached, authorization-safe labels for Discord syntax found in source bodies. */
  resolveDisplay?: ((kind: 'user' | 'role' | 'channel', id: string) => string | null) | undefined;
}

/** Tool wrapper: one legend followed by a source-preserving quoted conversation block. */
export function formatMessageLines(
  messages: AgentMessage[],
  options: FormatOptions = {}
): string {
  const formatter = createConversationFormatter(messages, options);
  return [formatter.speakers, formatter.render(messages, options)].filter(Boolean).join('\n\n');
}

export interface ConversationFormatter {
  /** このレンダリングブロックだけで使う話者一覧。 */
  speakers: string;
  /** 同じ author ID には、表示名が変わっても同じ別名を返す。 */
  speakerOf(message: AgentMessage): string;
  render(messages: readonly AgentMessage[], options?: ConversationRenderOptions): string;
}

const objectList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const cleanValue = (value: unknown): string => typeof value === 'string' || typeof value === 'number'
  ? String(value).replace(/[\r\n\t\u0000-\u001f\u007f-\u009f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/[\\`*_{}\[\]()#+!|>~-]/g, '\\$&') : '';
const cleanContent = (value: unknown): string => typeof value === 'string'
  ? value.replace(/[\r\n\t\u0000-\u001f\u007f-\u009f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`) : '';
const linesAsQuote = (value: string): string => value.split('\n').map((line) => `> ${line}`).join('\n');
const linesAsMeta = (value: string): string => value.split('\n').map((line) => `| ${line}`).join('\n');
const limited = (value: unknown, limit: number): { text: string; complete: boolean; characters: number } => {
  const text = String(value ?? '');
  return { text: text.slice(0, limit), complete: text.length <= limit, characters: text.length };
};

/**
 * Discord の発言を、ひとつの文書内だけで通用する話者別名と引用本文で表示する。
 * 参照は先に全件登録するため、検索結果の順番に関係なく返信先を解決できる。
 */
export function createConversationFormatter(
  messages: readonly AgentMessage[],
  { refs: suppliedRefs, selfId = null, resolveDisplay }: Pick<FormatOptions, 'refs' | 'selfId' | 'resolveDisplay'> = {}
): ConversationFormatter {
  const refs = suppliedRefs ?? new RefTable();
  const showRefs = suppliedRefs !== undefined;
  const speakerKey = (message: AgentMessage): string => message.authorId && message.authorId !== '0'
    ? message.authorId : `unknown:${message.messageId}`;
  const speakers = new Map<string, { alias: string; id: string; names: string[]; bot: boolean }>();
  const speakersById = new Map<string, { alias: string; names: string[] }>();
  for (const message of messages) {
    refs.add(message);
    const key = speakerKey(message);
    let speaker = speakers.get(key);
    if (!speaker) {
      speaker = { alias: `u${speakers.size + 1}`, id: message.authorId, names: [], bot: false };
      speakers.set(key, speaker);
    }
    const name = String(message.authorName || 'unknown');
    if (!speaker.names.includes(name)) speaker.names.push(name);
    speaker.bot ||= message.isBot === true;
    if (message.authorId && message.authorId !== '0') speakersById.set(message.authorId, speaker);
  }

  const speakerFor = (message: AgentMessage) => {
    const speaker = speakers.get(speakerKey(message));
    if (!speaker) throw new Error('Message speaker is missing from the conversation formatter');
    return speaker;
  };

  const legend = [...speakers.values()].map(({ alias, id, names, bot }) => {
    const tags = [id === selfId ? '自分' : '', bot ? 'bot' : ''].filter(Boolean);
    const identity = cleanValue(id && id !== '0' ? id : '不明');
    return `${alias} = ${names.map(cleanValue).join(' / ')}（Discord ID: ${identity}）${tags.length ? ` [${tags.join('/')}]` : ''}`;
  });
  const speakerLegend = legend.length ? ['話者（この資料内）:', ...legend].join('\n') : '';

  const render = (section: readonly AgentMessage[], options: ConversationRenderOptions = {}): string => {
    const { showChannel = false, bodyChars = 300, tailOf = null } = options;
    return section.map((message) => {
      const ref = refs.byMessageId.get(message.messageId)?.ref ?? null;
      const rawName = String(message.authorName || 'unknown');
      const name = cleanValue(rawName);
      const speaker = speakerFor(message);
      const nameNote = speaker.names[0] !== rawName ? `（表示名: ${name}）` : '';
      const structure = message.structure;
      const reference = isRecord(structure?.reference) ? structure.reference : {};
      const kind = reference.kind;
      const thread = isRecord(structure?.thread) && structure.thread.id ? structure.thread : null;
      const time = shortTime(message.createdAt);
      const channel = showChannel ? ` #${cleanValue(message.channelName || message.channelId)}` : '';
      const threadLabel = thread ? ` [スレッド: ${cleanValue(thread.name || thread.id)}]` : '';
      let edge = '';
      let immediateDeleted = reference.availability === 'deleted';
      if (kind === 'reply') {
        const parentId = typeof reference.messageId === 'string' && reference.messageId
          ? reference.messageId : String(message.replyTo ?? '');
        const parent = parentId ? refs.byMessageId.get(parentId) : undefined;
        const parentRef = parent?.ref ?? null;
        immediateDeleted ||= parent?.deleted === true || (!parent && message.referenceState === 'deleted');
        if (immediateDeleted) edge = ' [返信先:削除済]';
        else if (parentRef && showRefs) edge = ` ↩${parentRef}`;
        else if (reference.availability === 'unavailable' || (reference.channelId && reference.channelId !== message.channelId)) edge = ' [返信先:範囲外]';
        else if (reference.availability === 'resolved') edge = ' [返信先:表示範囲外]';
        else if (reference.availability === 'not_fetched') edge = ' [返信先:未取得]';
        else if (reference.availability === 'depth_limit' || message.referenceState === 'depth_limit') edge = ' [返信先:深度上限]';
        else if (reference.availability === 'cycle' || message.referenceState === 'cycle') edge = ' [返信先:循環]';
        else if (reference.availability === 'unknown') edge = ' [返信先:状態不明]';
        else edge = ' [返信]';
      } else if (kind === 'unknown_reference' || (kind === 'unknown' && reference.messageId)) {
        edge = ' [参照種別不明]';
      } else if (kind === 'forward') edge = ' [転送]';
      else if (kind === 'thread_starter') edge = ' [スレッド開始]';

      const webhook = structure?.webhookId ? ' [webhook]' : '';
      const header = `${showRefs && ref ? `${ref}) ` : ''}${time}${channel}${threadLabel} ${speaker.alias}${nameNote}${webhook}${edge}:`;
      const rawBody = String(message.content ?? '');
      const limit = Number.isFinite(bodyChars) ? Math.max(0, bodyChars) : Infinity;
      const body = rawBody.slice(0, limit);
      const forwarded = objectList(structure?.forwarded);
      const attachments = objectList(structure?.attachments);
      const embeds = objectList(structure?.embeds);
      const stickers = objectList(structure?.stickers);
      const typed = forwarded.length + attachments.length + embeds.length + stickers.length > 0;
      const out: string[] = [header];
      if (body.length) out.push(linesAsQuote(body));
      else if (typed || String(message.extra ?? '').trim()) out.push('| 本文なし（添付等の情報は本文ではありません）');
      else out.push('> (本文なし)');
      if (rawBody.length > body.length) out.push(`| …本文を途中まで表示（全${rawBody.length}文字）`);

      // Resolve Discord syntax as separate, low-authority display metadata. Never rewrite
      // source text: code, quoted syntax, and citation references remain byte-for-byte intact.
      const hints = new Set<string>();
      const addHint = (text: string): void => { if (hints.size < 12) hints.add(text); };
      for (const match of body.matchAll(/<@!?(\d{16,21})>|<@&(\d{16,21})>|<#(\d{16,21})>/g)) {
        const userId = match[1];
        const roleId = match[2];
        const channelId = match[3];
        const kind = userId ? 'user' : roleId ? 'role' : 'channel';
        const id = userId ?? roleId ?? channelId;
        if (!id) continue;
        const knownSpeaker = kind === 'user' ? speakersById.get(id) : undefined;
        const label = knownSpeaker ? `${knownSpeaker.alias} (${knownSpeaker.names[0]})` : resolveDisplay?.(kind, id);
        if (label) addHint(`${match[0]} → ${cleanValue(label)}`);
      }
      for (const match of body.matchAll(/<t:(\d{1,12})(?::[tTdDfFR])?>/g)) {
        const seconds = Number(match[1]);
        const date = new Date(seconds * 1000);
        if (Number.isFinite(seconds) && Number.isFinite(date.getTime())) {
          addHint(`${match[0]} → ${shortTime(date.getTime())} (UTC+9)`);
        }
      }
      if (hints.size) out.push(`| 表示ヒント（本文は原文）: ${[...hints].join(' / ')}`);

      // Bound all non-body source material together, including many fields in many embeds.
      let richRemaining = Number.isFinite(limit) ? limit : 1200;
      let richOmitted = false;
      const addRich = (content: string, clipSource = false): void => {
        for (const line of content.split('\n')) {
          if (richRemaining <= 0) { richOmitted = true; return; }
          if (line.length <= richRemaining) {
            out.push(line);
            richRemaining -= line.length;
          } else {
            if (clipSource && line.startsWith('| ') && richRemaining > 2) out.push(line.slice(0, richRemaining));
            richRemaining = 0;
            richOmitted = true;
            return;
          }
        }
      };

      for (const item of forwarded) {
        const fragment = limited(item.content ?? '(本文なし)', limit);
        addRich('| 転送内容（投稿者の発言とは未確認）:');
        addRich(linesAsMeta(fragment.text), true);
        if (!fragment.complete) addRich(`| …転送の表示範囲（全${fragment.characters}文字）`);
        for (const attachment of objectList(item.attachments)) {
          const name = cleanValue(attachment.name) || '名前不明';
          const type = cleanValue(attachment.contentType ?? attachment.content_type);
          addRich(`| 転送添付: ${name}（未読${type ? `; 種類 ${type}` : ''}）`);
        }
      }
      for (const item of attachments) {
        const detail = [
          cleanValue(item.contentType) ? `種類 ${cleanValue(item.contentType)}` : '',
          typeof item.size === 'number' ? `${item.size} bytes` : '',
          cleanValue(item.description) ? `説明 ${cleanValue(item.description)}` : ''
        ].filter(Boolean).join('、');
        const filename = limited(cleanValue(item.name) || '名前不明', limit);
        const metadata = limited(detail, limit);
        addRich(`| 添付: ${filename.text}（未読${metadata.text ? `; ${metadata.text}` : ''}）`);
        if (!filename.complete || !metadata.complete) addRich(`| …添付情報の表示範囲（名前${filename.characters}文字、他メタデータ${metadata.characters}文字）`);
      }
      for (const item of embeds) {
        const title = cleanValue(item.title);
        const description = cleanValue(item.description);
        const label = limited([title, description].filter(Boolean).join(' — '), limit);
        const fields = objectList(item.fields).map((field) => limited(`${cleanValue(field.name)}: ${cleanValue(field.value)}`, limit)).filter((field) => field.text);
        if (label.text || fields.length) {
          addRich(`| 埋め込み（投稿者の発言とは別）: ${label.text || '(内容なし)'}`);
          for (const field of fields) {
            addRich(linesAsMeta(field.text), true);
            if (!field.complete) addRich(`| …埋め込みフィールドの表示範囲（全${field.characters}文字）`);
          }
          if (!label.complete) addRich(`| …埋め込み説明の表示範囲（全${label.characters}文字）`);
        }
        for (const [label, value] of [['URL', item.url], ['埋め込み作成者', item.author], ['フッター', item.footer]] as const) {
          if (typeof value === 'string' && value) addRich(`| ${label}: ${JSON.stringify(cleanContent(value))}`);
        }
      }
      for (const item of stickers) {
        addRich(`| スタンプ: ${limited(cleanValue(item.name) || '名前不明', limit).text}`);
      }
      if (!typed && !String(message.extra ?? '').trim() && message.structure?.metadata === 'legacy_incomplete'
          && typeof message.attachmentCount === 'number' && message.attachmentCount > 0) {
        addRich(`| 添付件数: ${message.attachmentCount}（詳細未保存、内容未読）`);
      }
      if (!typed && String(message.extra ?? '').trim()) {
        const supplemental = limited(message.extra, limit);
        addRich('| 補足（発言者の言葉とは限らない）:');
        addRich(linesAsMeta(supplemental.text), true);
        if (!supplemental.complete) addRich(`| …補足を途中まで表示（全${supplemental.characters}文字）`);
      }
      if (message.deleted) out.push('| 状態: 削除済み記録');
      if (structure?.partial) out.push('| 状態: 一部のみ取得');
      const chainState = cleanContent(structure?.replyChainState);
      const chainStatus = message.referenceState === 'deleted' ? '削除済み'
        : message.referenceState === 'unavailable' ? '範囲外'
          : message.referenceState === 'depth_limit' ? '深度上限'
            : message.referenceState === 'cycle' ? '循環で停止' : '';
      if (chainStatus && !immediateDeleted) out.push(`| 返信履歴: ${chainStatus}`);
      else if (chainState && !immediateDeleted) out.push(`| 返信履歴: ${chainState === 'cycle' ? '循環で停止' : chainState === 'depth_limit' ? '深度上限' : cleanValue(chainState)}`);
      if (typeof message.reactionCount === 'number' && message.reactionCount > 0) out.push(`| 反応数: ${message.reactionCount}（賛同の主張とは限らない）`);
      if (message.editedAt) out.push('| 状態: 編集済み');
      const tail = tailOf?.(message);
      if (tail) {
        addRich('| 補足（検索・取得条件）:');
        addRich(linesAsMeta(String(tail)), true);
      }
      if (richOmitted) out.push('| …補足情報は文字数上限により省略');
      return out.join('\n');
    }).join('\n\n');
  };

  return { speakers: speakerLegend, speakerOf: (message) => speakerFor(message).alias, render };
}

/** そのテキストがコードブロックを開いたまま終わっているか。 */
function fenceLeftOpen(text: string): boolean {
  return ((text.match(/```/g) ?? []).length % 2) === 1;
}

const OMISSION_NOTE = '\n\n*(長すぎるため以降を省略しました)*';
export const CHAT_REPLY_CHARS = 300;

/**
 * Discord の 2000 文字制限に合わせて切る。段落・行の境目を優先する。
 *
 * コードブロックの途中で切ると、続きのメッセージが地の文として描画されて
 * インデントも等幅も消える。切った側を閉じて、次の先頭で開き直す
 * (言語指定は引き継がない。素の ``` で開き直す)。
 */
export function chunkForDiscord(text: unknown, limit = 1900, maxChunks = 3): string[] {
  const chunks: string[] = [];
  let rest = String(text ?? '').trim();
  // 前のチャンクが開いたままだったコードブロックの続き
  let prefix = '';

  while (rest.length > 0 && chunks.length < maxChunks) {
    if (prefix.length + rest.length <= limit) {
      chunks.push(prefix + rest);
      rest = ''; // 全部入った。消しておかないと下の「省略しました」が誤って付く
      break;
    }

    // 閉じの ``` と、最後のチャンクに付く省略通知の余地を残す。
    const lastChunk = chunks.length + 1 === maxChunks;
    const room = limit - prefix.length - 4 - (lastChunk ? OMISSION_NOTE.length : 0);
    if (room <= 0) break;
    const window = rest.slice(0, room);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    let at = cut > room * 0.5 ? cut : room;
    // 出典リンク `[①](<url>)` の途中で切ると、どちらのメッセージでも生の文字になる。リンクの手前で切る
    if (at === room) {
      const open = window.lastIndexOf('](<');
      if (open >= 0 && window.indexOf('>)', open) === -1) {
        const start = window.lastIndexOf('[', open);
        if (start > room * 0.3) at = start;
      }
    }
    const beforeCut = rest.charCodeAt(at - 1);
    const afterCut = rest.charCodeAt(at);
    if (beforeCut >= 0xd800 && beforeCut <= 0xdbff && afterCut >= 0xdc00 && afterCut <= 0xdfff) at--;
    if (at <= 0) break;

    let piece = prefix + rest.slice(0, at).trim();
    rest = rest.slice(at).trim();

    if (fenceLeftOpen(piece)) {
      piece += '\n```';
      prefix = '```\n';
    } else {
      prefix = '';
    }

    chunks.push(piece);
  }

  // 打ち切ったことを黙っていると、途中で切れた回答を完結したものと読まれてしまう。
  const last = chunks.length - 1;
  if (rest.length > 0 && last >= 0) {
    chunks[last] = `${chunks[last] ?? ''}${OMISSION_NOTE}`;
  }

  return chunks.filter(Boolean);
}

/** 出典の変換前に切り、送る本文に出てくる根拠だけを残す。 */
export function clipChatReply(text: string, footerChars = 0): string {
  return chunkForDiscord(stripTrailingSubtext(text), CHAT_REPLY_CHARS - footerChars, 1)[0] ?? '';
}
