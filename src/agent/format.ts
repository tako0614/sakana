// Discord sources use structured JSON lines. Short citation numbers remain a
// presentation convenience; author ids, reply targets and source state are explicit.

import type { Message } from 'discord.js';
import { TZ_OFFSET_HOURS } from '../archive/query.js';
import type { JsonRecord } from '../ai/types.js';
import type { MessageRow } from '../archive/types.js';
import { archiveStructure, discordStructure, discordExtraText, messageEnvelope } from '../conversation/message.js';
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
export function expandCitations(
  text: unknown,
  refs: RefTable,
  { label = null, selfId = null, episodeUrl = null }: {
    label?: string | null;
    selfId?: string | null;
    /** 記憶の出来事 (e12) の URL。サイトが無い・そんな出来事は無いなら null (番号は消すだけ) */
    episodeUrl?: ((id: number) => string | null) | null;
  } = {}
): string {
  const raw = String(text ?? '');
  const numbers = new Map<string, number>();
  const episodeUrls = new Set<string>();
  const numberOf = (url: string): number => {
    let no = numbers.get(url);
    if (no === undefined) { no = numbers.size + 1; numbers.set(url, no); }
    return no;
  };

  // 直前の空白ごと食う。番号を抜いた跡に空白が残ると句点の前が空く。全角スペースも食う (日本語で書かせているので混ざる)。
  // 空白の連なりは先頭からしか試さない (否定の後読み)。これが無いと、番号の続かない長い空白の列で
  // 開始位置ごとに列の端まで読み直し、文字数の2乗で時間がかかる (回答はモデルが書くので、長さを抑えられない)。
  const body = raw.replace(/(?<![ \t　])[ \t　]*\[(\d{1,4}|e\d{1,9}(?:[ \t]*[,、][ \t]*e\d{1,9})*)\]/gi,
    (match: string, group: string, offset: number) => {
      const spaced = /^[ \t　]/.test(match);
      if (/^\d+$/.test(group)) {
        const entry = refs.get(Number(group));
        const url = messageLink(entry);

        // 自分の発言は根拠にならない (プロンプトで禁じても flash 系は番号を付けた)。番号だけ消す
        if (url && selfId && String(entry?.authorId) === String(selfId)) return '';
        // 引けない番号は触らない
        if (!url) return match;
        // `items[1]` のような添字も引用ではない。引用は必ず語の区切りに来るので、
        // 空白で始まっていないのに直前が識別子の文字なら添字とみなす。
        if (!spaced && /[\w.)\]]/.test(raw[offset - 1] ?? '')) return match;
        return sourceLink(numberOf(url), url);
      }

      // 記憶の出来事 ([e3214] / [e3214, e11489])。`items[e1]` のような添字は触らない。
      // `[e1][e2]` と続けて書くことはあるので `]` は数えない。
      if (!spaced && /[\w.)]/.test(raw[offset - 1] ?? '')) return match;
      const links: string[] = [];
      for (const id of group.match(/\d+/g) ?? []) {
        let url: string | null = null;
        try { url = episodeUrl?.(Number(id)) ?? null; } catch { url = null; }
        if (!url) continue;
        if (!episodeUrls.has(url) && episodeUrls.size >= MAX_EPISODE_URLS) continue;
        episodeUrls.add(url);
        links.push(sourceLink(numberOf(url), url));
      }
      return links.join('');
    });

  // どのモデルが書いたかは毎回出す (出典は文中にあるので、末尾はこれだけ)
  return label ? `${body.trim()}\n\n-# ${label}` : body.trim();
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
    content: row.content ?? '',
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

/** describeExtras が見る部分。偽物のメッセージ (検証用) でも同じ形を持つ。 */
type MessageExtras = Pick<Message, 'attachments' | 'embeds' | 'stickers'>;

/**
 * 本文が無いメッセージの中身。画像だけ・埋め込みだけの発言は content が空なので、
 * そのまま渡すと `(本文なし)` になって何が貼られたのか分からない。
 *
 * アーカイブの取り込みは同じものを extra に集めていて (`indexer.js`)、
 * 本文と添付・引用は別フィールドで保持し、共通envelopeでも出典を区別する。
 */
export function describeExtras(message: MessageExtras): string {
  const parts: string[] = [];

  for (const attachment of message.attachments?.values() ?? []) {
    parts.push(attachment.description ? `${attachment.name}: ${attachment.description}` : attachment.name);
  }

  for (const embed of message.embeds ?? []) {
    const head = [embed.title, embed.author?.name].filter(Boolean).join(' / ');
    const body = [head, embed.description].filter(Boolean).join(' — ');
    if (body) parts.push(`[埋め込み] ${body}`);
  }

  for (const sticker of message.stickers?.values() ?? []) {
    parts.push(`[スタンプ] ${sticker.name}`);
  }

  // 埋め込みの説明は長いことがあるので、何が貼られたか分かる範囲で切る
  return parts.filter(Boolean).length ? truncate(parts.filter(Boolean).join(' / '), 120) : '';
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
    content: message.content ?? '',
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
    content: stringField(raw, 'content') ?? '',
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

export interface FormatOptions {
  refs?: RefTable | undefined;
  showChannel?: boolean;
  bodyChars?: number;
  tailOf?: ((message: AgentMessage) => string | null) | null;
  selfId?: string | null | undefined;
}

const nonEmpty = (value: unknown): boolean => Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '';

/**
 * messageEnvelope の既定値・重複を省いた、モデルに見せる形。
 *
 * 1件ごとに schema・location (どれも同じ guild / channel)・author.webhookId=null・
 * body.characters・空の supplemental / mentions / embeds …・reactions.meaning・state.observedAt が並んで、
 * 本文 70 文字の発言が 1,100 文字の JSON になっていた (30 件で 約 1.1 万トークン、中身は 700 トークン)。
 * 省いた欄は既定値 (返信ではない・本文は完結・削除でも固定でもない・添付も埋め込みも無い)。
 * messageEnvelope 自体は統治・調査も使うので触らず、ここで間引くだけ。
 */
export function slimEnvelope(envelope: JsonRecord, { showChannel = false }: { showChannel?: boolean } = {}): JsonRecord {
  const out: JsonRecord = { id: envelope.id };

  // 場所: チャンネルをまたぐ検索結果だけ。スレッドのときは、それが分かる最小限
  const location = isRecord(envelope.location) ? envelope.location : {};
  const thread = isRecord(location.thread) && location.thread.id ? { id: location.thread.id, name: location.thread.name ?? null, parentChannelId: location.thread.parentChannelId ?? null } : null;
  if (showChannel) out.location = { channelId: location.channelId, ...(location.channelName ? { channelName: location.channelName } : {}), ...(thread ? { thread } : {}) };
  else if (thread) out.location = { thread };

  const author = isRecord(envelope.author) ? envelope.author : {};
  out.author = {
    id: author.id, name: author.name,
    ...(author.bot ? { bot: true } : {}),
    ...(author.webhookId ? { webhookId: author.webhookId } : {}),
    ...(author.identity && author.identity !== 'participant' ? { identity: author.identity } : {})
  };

  const body = isRecord(envelope.body) ? envelope.body : {};
  out.body = { text: body.text, ...(body.complete === false ? { complete: false, characters: body.characters } : {}) };

  const supplemental = isRecord(envelope.supplemental) ? envelope.supplemental : {};
  if (nonEmpty(supplemental.text)) {
    out.supplemental = { text: supplemental.text, attribution: supplemental.attribution, ...(supplemental.complete === false ? { complete: false, characters: supplemental.characters } : {}) };
  }

  // 返信の関係。返信でも転送でもなく、先も無いなら省く (=返信ではない)
  const reference = isRecord(envelope.reference) ? envelope.reference : {};
  const plain = (reference.kind === 'none' || reference.kind === 'unknown') && !reference.messageId;
  if (!plain) {
    out.reference = {
      kind: reference.kind, messageId: reference.messageId, availability: reference.availability,
      ...(reference.ref ? { ref: reference.ref } : {}),
      ...(reference.authorId ? { authorId: reference.authorId } : {}),
      ...(reference.channelId && (showChannel || reference.channelId !== location.channelId) ? { channelId: reference.channelId } : {})
    };
  }
  if (envelope.replyChain) out.replyChain = envelope.replyChain;

  const state = isRecord(envelope.state) ? envelope.state : {};
  out.state = {
    createdAt: state.createdAt,
    ...(state.editedAt ? { editedAt: state.editedAt } : {}),
    ...(state.deleted ? { deleted: true } : {}),
    ...(state.pinned ? { pinned: true } : {}),
    ...(state.messageType ? { messageType: state.messageType } : {}),
    // 古いアーカイブ (構造を残していない発言) は、返信の有無が確かめられないと伝える
    ...(state.metadata && state.metadata !== 'observed' ? { metadata: state.metadata } : {})
  };

  for (const key of ['mentions', 'forwarded', 'attachments', 'embeds', 'stickers'] as const) {
    if (nonEmpty(envelope[key])) out[key] = envelope[key];
  }
  const reactions = isRecord(envelope.reactions) ? envelope.reactions.total : null;
  if (typeof reactions === 'number' && reactions > 0) out.reactions = reactions;
  if (envelope.contextNote) out.contextNote = envelope.contextNote;
  return out;
}

/**
 * メッセージ列を1行1件の構造化JSONで書き出す。本文の改行はJSON内に保つ。
 */
export function formatMessages(
  messages: AgentMessage[],
  { refs, showChannel = false, bodyChars = 300, tailOf = null, selfId = null }: FormatOptions = {}
): string {
  // Allocate references first: a reply can appear before its parent in search results.
  for (const message of messages) refs?.add(message);
  return messages.map((message) => {
    const ref = refs?.add(message);
    const envelope = messageEnvelope(message, {
      lookup: (id) => refs?.byMessageId.get(id), selfId: selfId ?? null, bodyChars
    });
    const note = tailOf?.(message);
    if (note) envelope.contextNote = note;
    return `${ref ? `${ref}) ` : ''}${JSON.stringify(slimEnvelope(envelope, { showChannel }))}`;
  }).join('\n');
}

const flat = (text: unknown): string => String(text ?? '').replace(/\s*\n\s*/g, ' ⏎ ').trim();
const listOf = (value: unknown): JsonRecord[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** envelope 1件を1行にする。省くのは既定値だけで、返信・自分の発言・補足 (発言者の言葉ではない) は残す。 */
function lineOf(ref: number | null | undefined, envelope: JsonRecord, showChannel: boolean): string {
  const author = isRecord(envelope.author) ? envelope.author : {};
  const state = isRecord(envelope.state) ? envelope.state : {};
  const body = isRecord(envelope.body) ? envelope.body : {};
  const supplemental = isRecord(envelope.supplemental) ? envelope.supplemental : {};
  const location = isRecord(envelope.location) ? envelope.location : {};
  const reference = isRecord(envelope.reference) ? envelope.reference : {};
  const thread = isRecord(location.thread) && location.thread.id ? location.thread : null;

  const channel = showChannel || thread
    ? `${showChannel ? `#${String(location.channelName ?? location.channelId ?? '?')}` : ''}${thread ? `[スレッド:${String(thread.name ?? thread.id)}]` : ''}`
    : '';
  const who = `${String(author.name ?? 'unknown')}${author.identity && author.identity !== 'participant' ? '(あなた)' : ''}${author.bot ? '[bot]' : ''}`;

  // 返信先: 番号が分かれば ↩N。引けなかった・消えたことも言う (返信先を推測で補わせない)
  let reply = '';
  if (reference.kind === 'forward') reply = ' [転送]';
  else if (reference.kind === 'thread_starter') reply = ' [スレッド開始]';
  else if (reference.messageId) {
    reply = reference.ref ? ` ↩${String(reference.ref)}`
      : reference.availability === 'deleted' ? ' ↩(削除済)' : ' ↩(未取得)';
  }

  const text = flat(body.text);
  const cut = body.complete === false ? `…(全${String(body.characters)}字)` : '';
  let extra = '';
  if (typeof supplemental.text === 'string' && supplemental.text.trim()) {
    extra = ` ※補足(発言者の言葉ではない): ${flat(supplemental.text)}${supplemental.complete === false ? '…' : ''}`;
  } else {
    const names = listOf(envelope.attachments).map((item) => String(item.name ?? '')).filter(Boolean);
    if (names.length) extra += ` [添付:${names.slice(0, 3).join(',')}${names.length > 3 ? ` ほか${names.length - 3}件` : ''}]`;
    const stickers = listOf(envelope.stickers).map((item) => String(item.name ?? '')).filter(Boolean);
    if (stickers.length) extra += ` [スタンプ:${stickers.slice(0, 2).join(',')}]`;
  }
  const marks = [
    state.editedAt ? '(編集済)' : '',
    state.deleted ? '(削除済)' : '',
    typeof (isRecord(envelope.reactions) ? envelope.reactions.total : null) === 'number' && Number(isRecord(envelope.reactions) ? envelope.reactions.total : 0) > 0
      ? `(反応${String(isRecord(envelope.reactions) ? envelope.reactions.total : 0)})` : ''
  ].filter(Boolean).join('');

  const head = [ref !== undefined && ref !== null ? `${ref})` : '', shortTime(state.createdAt), channel, `${who}${reply}`].filter(Boolean).join(' ');
  const content = text || (extra ? '' : '(本文なし)');
  return `${head}:${content ? ` ${content}` : ''}${cut}${extra}${marks ? ` ${marks}` : ''}`.trimEnd();
}

/**
 * メッセージ列を1行1件の短い文で書き出す (道具の結果用)。
 * `3) 08/14 14:02 #雑談 たこ ↩2: 本文` — 自分の発言は名前に (あなた)、返信は ↩N、補足は ※ 以降。
 * 1件ずつ JSON にすると 540 文字の飾りが付いて、検索1回で 5〜19k 文字になっていた (往復のたびに送り直される)。
 * 意味の元は formatMessages と同じ envelope で、返信先の解決・本文の切り詰め・自分の判定は変わらない。
 */
export function formatMessageLines(
  messages: AgentMessage[],
  { refs, showChannel = false, bodyChars = 300, selfId = null }: FormatOptions = {}
): string {
  // 返信は親より前に出ることがある。番号を先に全部振る
  for (const message of messages) refs?.add(message);
  return messages.map((message) => {
    const ref = refs?.add(message);
    const envelope = messageEnvelope(message, {
      lookup: (id) => refs?.byMessageId.get(id), selfId: selfId ?? null, bodyChars
    });
    return lineOf(ref, envelope, showChannel);
  }).join('\n');
}

/** そのテキストがコードブロックを開いたまま終わっているか。 */
function fenceLeftOpen(text: string): boolean {
  return ((text.match(/```/g) ?? []).length % 2) === 1;
}

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

    // 閉じの ``` を足す余地を残す
    const room = limit - prefix.length - 4;
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
    chunks[last] = `${chunks[last] ?? ''}\n\n*(長すぎるため以降を省略しました)*`;
  }

  return chunks.filter(Boolean);
}
