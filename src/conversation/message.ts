// The same source envelope is used by live chat, search, and governance evidence.
// Edges describe Discord's relationships; chronology, mentions and quotations
// are never silently promoted to a reply or to an assertion by the sender.
//
// 受け取るのは discord.js の Message と、API の生の JSON (snake_case) の両方。どちらの欄があるかは
// 読むまで分からないので unknown から1つずつ確かめる。
import { isRecord, type JsonRecord } from '../ai/types.js';

const rec = (value: unknown): JsonRecord => (isRecord(value) ? value : {});
const hasValues = (value: unknown): value is { values(): Iterable<unknown> } => isRecord(value) && typeof value.values === 'function';
const values = (collection: unknown): unknown[] => Array.isArray(collection) ? [...collection] : hasValues(collection) ? [...collection.values()] : [];
const id = (value: unknown): string | null => value == null ? null : String(value);
const isThreadChannel = (value: unknown): value is JsonRecord & { isThread(): unknown } => isRecord(value) && typeof value.isThread === 'function';

/** 保存・受け渡しする発言の構造。version と reference だけは必ずある。ほかは書いた時期によって欠ける。 */
export interface MessageStructure extends JsonRecord {
  version: 1;
  reference: JsonRecord;
  messageType?: unknown;
  metadata?: unknown;
  thread?: unknown;
  mentions?: unknown;
  forwarded?: unknown;
  attachments?: unknown;
  embeds?: unknown;
  stickers?: unknown;
  webhookId?: unknown;
  pinned?: unknown;
  partial?: unknown;
  observedAt?: unknown;
  replyChainState?: unknown;
}

const isMessageStructure = (value: unknown): value is MessageStructure =>
  isRecord(value) && value.version === 1 && isRecord(value.reference);

export function discordExtraText(message: unknown): string {
  const m = rec(message);
  const parts: unknown[] = [];
  for (const entry of values(m.messageSnapshots ?? m.message_snapshots)) {
    const text = rec(rec(entry).message ?? entry).content;
    if (text) parts.push(`[転送] ${String(text)}`);
  }
  for (const item of values(m.attachments)) { const a = rec(item); parts.push(a.name ?? a.filename ?? '', a.description ?? ''); }
  for (const item of values(m.embeds)) {
    const e = rec(item);
    parts.push(e.title ?? '', e.description ?? '', rec(e.author).name ?? '', rec(e.footer).text ?? '');
    for (const field of values(e.fields ?? [])) { const f = rec(field); parts.push(f.name ?? '', f.value ?? ''); }
  }
  for (const item of values(m.stickers ?? m.sticker_items)) parts.push(rec(item).name ?? '');
  return parts.filter(Boolean).join('\n');
}

export function discordStructure(message: unknown): MessageStructure {
  const m = rec(message);
  const reference = rec(m.reference ?? m.message_reference);
  const snapshots = values(m.messageSnapshots ?? m.message_snapshots);
  const type = m.type ?? null;
  const targetId = reference.messageId ?? reference.message_id;
  const forwarded = reference.type === 1 || snapshots.length > 0;
  const kind = forwarded ? 'forward' : type === 21 ? 'thread_starter'
    : targetId ? 'reply' : 'none';
  const resolved = m.referenced_message;
  const channel = m.channel;
  const thread = isThreadChannel(channel) ? channel.isThread() : undefined;
  const threadChannel = rec(channel);
  return {
    version: 1,
    messageType: type,
    reference: {
      kind, messageId: id(targetId),
      channelId: id(reference.channelId ?? reference.channel_id ?? (targetId ? m.channelId ?? m.channel_id : null)),
      guildId: id(reference.guildId ?? reference.guild_id ?? m.guildId ?? m.guild_id),
      availability: !targetId ? 'not_applicable' : resolved === null ? 'deleted' : resolved ? 'resolved' : 'not_fetched',
      authorId: id(rec(rec(resolved).author).id)
    },
    thread: {
      id: thread ? id(m.channelId) : null,
      parentChannelId: thread ? id(threadChannel.parentId) : null,
      name: thread ? threadChannel.name : null,
      archived: thread ? Boolean(threadChannel.archived) : null,
      locked: thread ? Boolean(threadChannel.locked) : null
    },
    mentions: values(rec(m.mentions).users ?? (Array.isArray(m.mentions) ? m.mentions : [])).map((user) => id(rec(user).id)),
    forwarded: snapshots.map((entry) => {
      const snapshot = rec(rec(entry).message ?? entry);
      return { content: snapshot.content ?? '', authorId: null, attribution: 'unknown',
        attachments: values(snapshot.attachments).map((item) => { const a = rec(item); return { name: a.name ?? a.filename, url: a.url, contentType: a.contentType ?? a.content_type }; }) };
    }),
    attachments: values(m.attachments).map((item) => { const a = rec(item); return { id: id(a.id), name: a.name ?? a.filename,
      description: a.description ?? null, url: a.url, contentType: a.contentType ?? a.content_type ?? null, contentRead: false }; }),
    embeds: values(m.embeds).map((item) => { const e = rec(item); return { title: e.title ?? null, description: e.description ?? null,
      url: e.url ?? null, fields: values(e.fields ?? []).map((field) => { const f = rec(field); return { name: f.name, value: f.value }; }),
      author: rec(e.author).name ?? null, footer: rec(e.footer).text ?? null, attribution: 'embed_not_sender' }; }),
    stickers: values(m.stickers ?? m.sticker_items).map((item) => { const s = rec(item); return { id: id(s.id), name: s.name }; }),
    webhookId: id(m.webhookId ?? m.webhook_id),
    pinned: Boolean(m.pinned), partial: Boolean(m.partial),
    observedAt: Date.now()
  };
}

/** アーカイブの発言の行 (structure_json は保存した構造の JSON)。 */
export interface ArchiveStructureRow {
  structure_json?: unknown;
  reply_to?: unknown;
  channel_id?: unknown;
  guild_id?: unknown;
  parent_id?: unknown;
  pinned?: unknown;
}

export function archiveStructure(row: ArchiveStructureRow): MessageStructure {
  if (row.structure_json) {
    try { const value: unknown = JSON.parse(String(row.structure_json)); if (isMessageStructure(value)) return value; } catch { /* old or damaged source metadata */ }
  }
  return { version: 1, messageType: null, metadata: 'legacy_incomplete',
    reference: { kind: row.reply_to ? 'unknown_reference' : 'unknown', messageId: id(row.reply_to),
      channelId: row.reply_to ? id(row.channel_id) : null, guildId: id(row.guild_id), availability: row.reply_to ? 'not_fetched' : 'unknown' },
    thread: { id: row.parent_id ? id(row.channel_id) : null, parentChannelId: id(row.parent_id) },
    mentions: [], forwarded: [], attachments: [], embeds: [], stickers: [], pinned: Boolean(row.pinned) };
}

/** 発言の中身。欄はどれも呼び出し側 (Discord・アーカイブ) から来たまま。 */
export interface EnvelopeSource {
  messageId?: unknown;
  guildId?: unknown;
  channelId?: unknown;
  channelName?: unknown;
  authorId?: unknown;
  authorName?: unknown;
  isBot?: unknown;
  content?: unknown;
  extra?: unknown;
  createdAt?: unknown;
  editedAt?: unknown;
  deleted?: unknown;
  reactionCount?: unknown;
  replyTo?: unknown;
  structure?: MessageStructure | null;
}

/** リプライ先を引く (会話の中の既知の発言)。 */
export type EnvelopeLookup = (messageId: string) => { deleted?: unknown; ref?: unknown; authorId?: unknown } | null | undefined;

export function messageEnvelope(message: EnvelopeSource,
  { lookup, selfId, bodyChars = Infinity }: { lookup?: EnvelopeLookup; selfId?: string | null; bodyChars?: number } = {}): JsonRecord {
  const structure = message.structure ?? archiveStructure({ reply_to: message.replyTo, channel_id: message.channelId, guild_id: message.guildId });
  const reference: JsonRecord = { ...structure.reference };
  const parent = typeof reference.messageId === 'string' && reference.messageId ? lookup?.(reference.messageId) : null;
  if (parent) {
    reference.availability = parent.deleted ? 'deleted' : 'resolved';
    reference.ref = parent.ref ?? null;
    reference.authorId = parent.authorId;
  }
  const content = String(message.content ?? '');
  return {
    schema: 'discord.message.v1', id: message.messageId,
    location: { guildId: message.guildId, channelId: message.channelId, channelName: message.channelName ?? null, thread: structure.thread },
    author: { id: message.authorId, name: message.authorName, bot: Boolean(message.isBot),
      webhookId: structure.webhookId ?? null,
      identity: selfId && message.authorId === selfId ? 'あなた自身の発言' : 'participant' },
    body: { text: content.slice(0, bodyChars), complete: !structure.partial && content.length <= bodyChars, characters: content.length },
    // Legacy archives kept embed fields/footer and attachment descriptions here.
    // These are source material, never silently attributed to the sender.
    supplemental: { text: String(message.extra ?? '').slice(0, bodyChars),
      attribution: 'embed_attachment_or_quoted_material',
      complete: String(message.extra ?? '').length <= bodyChars,
      characters: String(message.extra ?? '').length },
    reference,
    ...(structure.replyChainState ? { replyChain: { termination: structure.replyChainState } } : {}),
    state: { createdAt: message.createdAt, editedAt: message.editedAt ?? null, deleted: Boolean(message.deleted),
      pinned: structure.pinned ?? false, messageType: structure.messageType, metadata: structure.metadata ?? 'observed', observedAt: structure.observedAt ?? null },
    mentions: structure.mentions, forwarded: structure.forwarded,
    attachments: structure.attachments, embeds: structure.embeds, stickers: structure.stickers,
    reactions: { total: message.reactionCount ?? null, meaning: 'reaction_not_statement' }
  };
}

/** アーカイブの messages の行。 */
export interface ArchiveMessageRow extends ArchiveStructureRow {
  message_id?: unknown;
  author_id?: unknown;
  author_name?: unknown;
  is_bot?: unknown;
  content?: unknown;
  extra?: unknown;
  created_at?: unknown;
  edited_at?: unknown;
  deleted?: unknown;
  reaction_count?: unknown;
}

export function archiveEnvelope(row: ArchiveMessageRow): JsonRecord {
  return messageEnvelope({ messageId: row.message_id, guildId: row.guild_id, channelId: row.channel_id,
    authorId: row.author_id, authorName: row.author_name, isBot: Boolean(row.is_bot), content: row.content, extra: row.extra,
    createdAt: row.created_at, editedAt: row.edited_at, deleted: Boolean(row.deleted),
    reactionCount: row.reaction_count, structure: archiveStructure(row) });
}
