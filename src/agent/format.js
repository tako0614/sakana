// ツール出力の整形。
//
// ここがトークン消費の大部分を決めるので、徹底して詰める:
//   - スノーフレーク (19桁) はモデルに見せず、短い参照番号 [3] に置き換える
//   - <@123...> ではなく表示名を出す (安いし、誤爆メンションも防げる)
//   - 空白と改行は1つに畳む
//   - 本文は既定 300 文字で切る

import { TZ_OFFSET_HOURS } from '../archive/query.js';

const TZ_OFFSET_MS = TZ_OFFSET_HOURS * 3_600_000;

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

    const snowflake = /(\d{16,21})/.exec(text);
    if (snowflake) {
      return this.byMessageId.get(snowflake[1]) ?? { messageId: snowflake[1] };
    }

    return null;
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
 * モデルが書いた [3] を実際のメッセージリンクに変える。
 * 存在しない番号はそのまま残す (リンク切れを作らない)。
 */
export function expandCitations(text, refs) {
  return String(text ?? '').replace(/\[(\d{1,4})\]/g, (match, digits) => {
    const url = messageLink(refs.get(Number(digits)));
    return url ? `[${digits}](${url})` : match;
  });
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
    content: row.content || row.extra || '',
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted: Boolean(row.deleted),
    reactionCount: row.reaction_count ?? 0,
    replyTo: row.reply_to ?? null,
    attachmentCount: row.attachment_count ?? 0
  };
}

/** discord.js の Message を共通形にそろえる。 */
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
    createdAt: message.createdTimestamp,
    editedAt: message.editedTimestamp ?? null,
    deleted: false,
    reactionCount: [...(message.reactions?.cache?.values() ?? [])]
      .reduce((sum, reaction) => sum + (reaction.count ?? 0), 0),
    replyTo: message.reference?.messageId ?? null,
    attachmentCount: message.attachments?.size ?? 0
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
    createdAt: raw.timestamp ? Date.parse(raw.timestamp) : Date.now(),
    editedAt: raw.edited_timestamp ? Date.parse(raw.edited_timestamp) : null,
    deleted: false,
    reactionCount: 0,
    replyTo: raw.referenced_message?.id ?? raw.message_reference?.message_id ?? null,
    attachmentCount: raw.attachments?.length ?? 0
  };
}

/**
 * メッセージ列を1行1件で書き出す。
 *   3) [08/10 14:32 たこ #general] 本文… ⭐2 ↩1
 */
export function formatMessages(messages, { refs, showChannel = false, bodyChars = 300 } = {}) {
  const now = Date.now();
  const lines = [];

  for (const message of messages) {
    const ref = refs ? refs.add(message) : null;
    const head = [shortTime(message.createdAt, now), message.authorName];
    if (showChannel && message.channelName) head.push(`#${message.channelName}`);
    if (message.isBot) head.push('bot');

    const tail = [];
    if (message.reactionCount > 0) tail.push(`⭐${message.reactionCount}`);
    if (message.editedAt) tail.push('編集済');
    if (message.deleted) tail.push('削除済');
    if (message.attachmentCount > 0) tail.push(`添付${message.attachmentCount}`);

    // 返信先が同じ結果セットに居るときだけ番号で示す。会話の噛み合いを見るのに要る。
    if (message.replyTo && refs) {
      const parent = refs.byMessageId.get(message.replyTo);
      if (parent) tail.push(`↩${parent.ref}`);
      else tail.push('↩');
    }

    const body = truncate(message.content, bodyChars) || '(本文なし)';
    const prefix = ref ? `${ref}) ` : '- ';

    lines.push(`${prefix}[${head.join(' ')}] ${body}${tail.length ? ` ${tail.join(' ')}` : ''}`);
  }

  return lines.join('\n');
}

/** Discord の 2000 文字制限に合わせて切る。段落・行の境目を優先する。 */
export function chunkForDiscord(text, limit = 1900, maxChunks = 3) {
  const chunks = [];
  let rest = String(text ?? '').trim();

  while (rest.length > 0 && chunks.length < maxChunks) {
    if (rest.length <= limit) {
      chunks.push(rest);
      rest = ''; // 全部入った。消しておかないと下の「省略しました」が誤って付く
      break;
    }

    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    const at = cut > limit * 0.5 ? cut : limit;

    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }

  // 打ち切ったことを黙っていると、途中で切れた回答を完結したものと読まれてしまう。
  if (rest.length > 0 && chunks.length > 0) {
    chunks[chunks.length - 1] += '\n\n*(長すぎるため以降を省略しました)*';
  }

  return chunks.filter(Boolean);
}
