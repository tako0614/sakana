// Discord sources use structured JSON lines. Short citation numbers remain a
// presentation convenience; author ids, reply targets and source state are explicit.

import type { Message } from 'discord.js';
import { TZ_OFFSET_HOURS } from '../archive/query.js';
import { discordStructure, discordExtraText } from '../conversation/message.js';
import { conversation, type ArchiveRow } from './boundary.js';
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

/**
 * モデルが書いた [3] を本文から取り除き、URL だけを末尾にまとめる。
 *
 * 番号はモデルに「どの発言を根拠にしたか」を書かせるための仕組みで、読む人には要らない。
 * 本文に残すと地の文に括弧の数字が散るので消す。URL は加工せずそのまま並べる
 * (Discord のプレビューもそのまま出る)。
 *
 * 以前ここで [3] を生の URL に差し替えて本文に埋めていた。「生の URL なら Discord が
 * 元の発言をプレビューしてくれる」という前提だったが、実際に出るのはチャンネル名だけで、
 * 代わりに 88 文字の URL が1文ごとに挟まって本文が読めなくなっていた。
 *
 * 載せるのはモデルが実際に書いた番号ぶんだけ。refs にはモデルに見せた全メッセージが
 * 入っているので、全部並べると数百行になる。
 * 引けなかった番号は本文から消すだけで、末尾には出さない (リンク切れを作らない)。
 */
export function expandCitations(
  text: unknown,
  refs: RefTable,
  { label = null, selfId = null }: { label?: string | null; selfId?: string | null } = {}
): string {
  const raw = String(text ?? '');
  const urls: string[] = [];
  const seen = new Set<number>();

  // 直前の空白ごと食う。番号を抜いた跡に空白が残ると句点の前が空く。
  // 全角スペースも食う (日本語で書かせているので混ざる)。
  //
  // 空白の連なりは先頭からしか試さない (否定の後読み)。これが無いと、番号の続かない
  // 長い空白の列で開始位置ごとに列の端まで読み直し、文字数の2乗で時間がかかる
  // (回答はモデルが書くので、入力として長さを抑えられない)。一致する箇所は変わらない。
  const body = raw.replace(/(?<![ \t　])[ \t　]*\[(\d{1,4})\]/g, (match: string, digits: string, offset: number) => {
    const ref = Number(digits);
    const entry = refs.get(ref);
    const url = messageLink(entry);

    // 自分の発言は根拠にならない (プロンプトで禁じても flash 系は番号を付けた)。番号だけ消す
    if (url && selfId && String(entry?.authorId) === String(selfId)) return '';

    // 引けない番号は触らない。無条件に消していたら `[2024] の話ね` が
    // `の話ね` になっていた (数字の括弧は引用とは限らない)。
    if (!url) return match;

    // `items[1]` のような添字も引用ではない。引用は必ず語の区切りに来るので、
    // 空白で始まっていないのに直前が識別子の文字なら添字とみなす。
    if (!/^[ \t　]/.test(match) && /[\w.)\]]/.test(raw[offset - 1] ?? '')) return match;

    if (!seen.has(ref)) {
      seen.add(ref);
      urls.push(url);
    }

    return '';
  });

  // どのモデルが書いたかは毎回出す。引用があるときは同じ subtext に混ぜる
  // (行を2本にすると会話の邪魔になる)。
  const tail = [label, ...urls].filter(Boolean);
  if (tail.length === 0) return body.trim();

  return `${body.trim()}\n\n-# ${tail.join(' ')}`;
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
export function fromArchiveRow(row: ArchiveRow, channelName?: string | null): AgentMessage {
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
    structure: conversation.archiveStructure(row)
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
    const envelope = conversation.messageEnvelope(message, {
      lookup: (id) => refs?.byMessageId.get(id), selfId: selfId ?? null, bodyChars
    });
    if (!showChannel) delete envelope.location.channelName;
    const note = tailOf?.(message);
    if (note) envelope.contextNote = note;
    return `${ref ? `${ref}) ` : ''}${JSON.stringify(envelope)}`;
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
    const at = cut > room * 0.5 ? cut : room;

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
