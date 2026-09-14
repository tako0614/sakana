// Discord sources use structured JSON lines. Short citation numbers remain a
// presentation convenience; author ids, reply targets and source state are explicit.

import { TZ_OFFSET_HOURS } from '../archive/query.js';
import { archiveStructure, discordStructure, discordExtraText, messageEnvelope } from '../conversation/message.js';
import { admissionFor } from '../conversation/admission.js';
import { isDreamGuild } from '../conversation/dream-config.js';

const TZ_OFFSET_MS = TZ_OFFSET_HOURS * 3_600_000;

// Discord のリンク。`https://discord.com/channels/<guild>/<channel>/<message>`
// で、末尾のメッセージは無いこと (チャンネルへのリンク) もある。DM は guild が `@me`。
const DISCORD_LINK = /discord(?:app)?\.com\/channels\/(\d{16,21}|@me)\/(\d{16,21})(?:\/(\d{16,21}))?/;

/**
 * 貼られた文字列から Discord の参照を取り出す。
 *
 * ここを素の `/(\d{16,21})/` でやってはいけない。リンクにはスノーフレークが3つ
 * 並んでいて、最初に当たるのは**サーバー ID**。実際そうなっていて、リンクを貼って
 * 「これ何？」と聞くと、サーバー ID をメッセージ ID として読みに行っていた。
 *
 * リンクなら channel まで分かるので、どのチャンネルを読めばいいかも同時に確定する。
 *
 * @returns {{ guildId: string|null, channelId: string|null, messageId: string|null }|null}
 */
export function parseDiscordRef(value) {
  const text = String(value ?? '');

  const link = DISCORD_LINK.exec(text);
  if (link) {
    const [, guild, second, third] = link;
    return third
      // guild/channel/message
      ? { guildId: guild === '@me' ? null : guild, channelId: second, messageId: third }
      // guild/channel (チャンネルへのリンク)
      : { guildId: guild === '@me' ? null : guild, channelId: second, messageId: null };
  }

  // リンクでなければ素のスノーフレーク。`<#123>` のようなメンションもここで拾う。
  const bare = /(\d{16,21})/.exec(text);
  return bare ? { guildId: null, channelId: null, messageId: bare[1] } : null;
}

/**
 * 参照番号とメッセージの対応表。1回の実行につき1つ作る。
 * モデルには番号だけを見せ、番号 → 実 ID の変換はこちらで持つ。
 */
export class RefTable {
  constructor() {
    this.entries = [];
    this.byMessageId = new Map();
  }

  add(message) {
    if (!message?.messageId) return null;

    const existing = this.byMessageId.get(message.messageId);
    if (existing) return existing.ref;

    const ref = this.entries.length + 1;
    const entry = { ref, ...message };
    this.entries.push(entry);
    this.byMessageId.set(message.messageId, entry);
    return ref;
  }

  /** 番号でも生の ID でも引けるようにする (モデルはどちらを渡してくるか読めない)。 */
  resolve(value) {
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

  get(ref) {
    return this.entries[ref - 1] ?? null;
  }
}

export function messageLink(entry) {
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
export function expandCitations(text, refs, { label = null } = {}) {
  const raw = String(text ?? '');
  const urls = [];
  const seen = new Set();

  // 直前の空白ごと食う。番号を抜いた跡に空白が残ると句点の前が空く。
  // 全角スペースも食う (日本語で書かせているので混ざる)。
  const body = raw.replace(/[ \t　]*\[(\d{1,4})\]/g, (match, digits, offset) => {
    const ref = Number(digits);
    const url = messageLink(refs.get(ref));

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

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function truncate(text, limit) {
  const flat = collapse(text);
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}…`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** MM/DD HH:MM 形式。年が今年と違うときだけ年を足す。 */
export function shortTime(timestamp, now = Date.now()) {
  const local = new Date(Number(timestamp) + TZ_OFFSET_MS);
  const current = new Date(now + TZ_OFFSET_MS);

  const stamp = `${pad(local.getUTCMonth() + 1)}/${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  return local.getUTCFullYear() === current.getUTCFullYear()
    ? stamp
    : `${local.getUTCFullYear()}/${stamp}`;
}

/** アーカイブ DB の行を共通形にそろえる。 */
export function fromArchiveRow(row, channelName) {
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
    ...(isDreamGuild(row.guild_id) ? { memorySelection: admissionFor(row) } : {}),
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted: Boolean(row.deleted),
    reactionCount: row.reaction_count ?? 0,
    replyTo: row.reply_to ?? null,
    attachmentCount: row.attachment_count ?? 0,
    structure: archiveStructure(row)
  };
}

/** discord.js の Message を共通形にそろえる。 */
/**
 * 本文が無いメッセージの中身。画像だけ・埋め込みだけの発言は content が空なので、
 * そのまま渡すと `(本文なし)` になって何が貼られたのか分からない。
 *
 * アーカイブの取り込みは同じものを extra に集めていて (`indexer.js`)、
 * 本文と添付・引用は別フィールドで保持し、共通envelopeでも出典を区別する。
 */
export function describeExtras(message) {
  const parts = [];

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

export function fromDiscordMessage(message, channelName) {
  return {
    guildId: message.guildId ?? message.guild?.id ?? null,
    channelId: message.channelId,
    channelName: channelName ?? message.channel?.name,
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

/** Discord API の生 JSON (検索結果) を共通形にそろえる。 */
export function fromRawMessage(raw, guildId, channelName) {
  const member = raw.member ?? {};
  return {
    guildId: raw.guild_id ?? guildId,
    channelId: raw.channel_id,
    channelName,
    messageId: raw.id,
    authorId: raw.author?.id ?? '0',
    authorName:
      member.nick
      ?? raw.author?.global_name
      ?? raw.author?.username
      ?? 'unknown',
    isBot: Boolean(raw.author?.bot),
    content: raw.content ?? '',
    extra: discordExtraText(raw),
    createdAt: raw.timestamp ? Date.parse(raw.timestamp) : Date.now(),
    editedAt: raw.edited_timestamp ? Date.parse(raw.edited_timestamp) : null,
    deleted: false,
    reactionCount: Array.isArray(raw.reactions) ? raw.reactions.reduce((sum, reaction) => sum + (reaction.count ?? 0), 0) : null,
    replyTo: raw.referenced_message?.id ?? raw.message_reference?.message_id ?? null,
    attachmentCount: raw.attachments?.length ?? 0,
    structure: discordStructure(raw)
  };
}

/**
 * メッセージ列を1行1件の構造化JSONで書き出す。本文の改行はJSON内に保つ。
 */
export function formatMessages(
  messages,
  { refs, showChannel = false, bodyChars = 300, tailOf = null, selfId = null } = {}
) {
  // Allocate references first: a reply can appear before its parent in search results.
  for (const message of messages) for (const item of message.contextMessages ?? [message]) refs?.add(item);
  return messages.map((message) => {
    const parts = message.contextMessages ?? [message];
    const first = parts[0];
    const ref = refs?.add(first);
    const envelope = messageEnvelope(first, {
      lookup: (id) => refs?.byMessageId.get(id), selfId, bodyChars
    });
    if (parts.length > 1) {
      envelope.contextGroup = { kind: 'consecutive_same_author', count: parts.length,
        note: '表示上まとめた連投。各メッセージの本文・ID・実際の返信先は別。',
        continuations: parts.slice(1).map(part => {
          const item = messageEnvelope(part, { lookup: id => refs?.byMessageId.get(id), selfId, bodyChars });
          const { schema, author, location, ...content } = item;
          return { ref: refs?.add(part), ...content };
        }) };
    }
    if (!showChannel) delete envelope.location.channelName;
    const note = tailOf?.(message);
    if (note) envelope.contextNote = note;
    return `${ref ? `${ref}) ` : ''}${JSON.stringify(envelope)}`;
  }).join('\n');
}

/** そのテキストがコードブロックを開いたまま終わっているか。 */
function fenceLeftOpen(text) {
  return ((text.match(/```/g) ?? []).length % 2) === 1;
}

/**
 * Discord の 2000 文字制限に合わせて切る。段落・行の境目を優先する。
 *
 * コードブロックの途中で切ると、続きのメッセージが地の文として描画されて
 * インデントも等幅も消える。切った側を閉じて、次の先頭で開き直す
 * (言語指定は引き継がない。素の ``` で開き直す)。
 */
export function chunkForDiscord(text, limit = 1900, maxChunks = 3) {
  const chunks = [];
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
  if (rest.length > 0 && chunks.length > 0) {
    chunks[chunks.length - 1] += '\n\n*(長すぎるため以降を省略しました)*';
  }

  return chunks.filter(Boolean);
}
