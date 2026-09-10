// The same source envelope is used by live chat, search, and durable memory.
// Edges describe Discord's relationships; chronology, mentions and quotations
// are never silently promoted to a reply or to an assertion by the sender.
const values = (collection) => Array.isArray(collection) ? collection : [...(collection?.values?.() ?? [])];
const id = (value) => value == null ? null : String(value);

export function discordStructure(message) {
  const reference = message.reference ?? message.message_reference;
  const snapshots = values(message.messageSnapshots ?? message.message_snapshots);
  const type = message.type ?? null;
  const targetId = reference?.messageId ?? reference?.message_id;
  const forwarded = reference?.type === 1 || snapshots.length > 0;
  const kind = forwarded ? 'forward' : type === 21 ? 'thread_starter'
    : targetId ? 'reply' : 'none';
  const resolved = message.referenced_message;
  const thread = message.channel?.isThread?.();
  return {
    version: 1,
    messageType: type,
    reference: {
      kind, messageId: id(targetId),
      channelId: id(reference?.channelId ?? reference?.channel_id ?? (targetId ? message.channelId ?? message.channel_id : null)),
      guildId: id(reference?.guildId ?? reference?.guild_id ?? message.guildId ?? message.guild_id),
      availability: !targetId ? 'not_applicable' : resolved === null ? 'deleted' : resolved ? 'resolved' : 'not_fetched',
      authorId: id(resolved?.author?.id)
    },
    thread: {
      id: thread ? id(message.channelId) : null,
      parentChannelId: thread ? id(message.channel.parentId) : null,
      name: thread ? message.channel.name : null,
      archived: thread ? Boolean(message.channel.archived) : null,
      locked: thread ? Boolean(message.channel.locked) : null
    },
    mentions: values(message.mentions?.users ?? (Array.isArray(message.mentions) ? message.mentions : [])).map((user) => id(user.id)),
    forwarded: snapshots.map((entry) => {
      const snapshot = entry.message ?? entry;
      return { content: snapshot.content ?? '', authorId: null, attribution: 'unknown',
        attachments: values(snapshot.attachments).map((a) => ({ name: a.name ?? a.filename, url: a.url, contentType: a.contentType ?? a.content_type })) };
    }),
    attachments: values(message.attachments).map((a) => ({ id: id(a.id), name: a.name ?? a.filename,
      description: a.description ?? null, url: a.url, contentType: a.contentType ?? a.content_type ?? null, contentRead: false })),
    embeds: values(message.embeds).map((e) => ({ title: e.title ?? null, description: e.description ?? null, url: e.url ?? null, attribution: 'embed_not_sender' })),
    stickers: values(message.stickers ?? message.sticker_items).map((s) => ({ id: id(s.id), name: s.name })),
    pinned: Boolean(message.pinned), partial: Boolean(message.partial),
    observedAt: Date.now()
  };
}

export function archiveStructure(row) {
  if (row.structure_json) {
    try { const value = JSON.parse(row.structure_json); if (value.version === 1 && value.reference) return value; } catch { /* old or damaged source metadata */ }
  }
  return { version: 1, messageType: null, metadata: 'legacy_incomplete',
    reference: { kind: row.reply_to ? 'unknown_reference' : 'unknown', messageId: id(row.reply_to),
      channelId: row.reply_to ? id(row.channel_id) : null, guildId: id(row.guild_id), availability: row.reply_to ? 'not_fetched' : 'unknown' },
    thread: { id: row.parent_id ? id(row.channel_id) : null, parentChannelId: id(row.parent_id) },
    mentions: [], forwarded: [], attachments: [], embeds: [], stickers: [], pinned: Boolean(row.pinned) };
}

export function messageEnvelope(message, { lookup, selfId, bodyChars = Infinity } = {}) {
  const structure = message.structure ?? archiveStructure({ reply_to: message.replyTo, channel_id: message.channelId, guild_id: message.guildId });
  const reference = { ...structure.reference };
  const parent = reference.messageId ? lookup?.(reference.messageId) : null;
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
      identity: selfId && message.authorId === selfId ? 'あなた自身の発言' : 'participant' },
    body: { text: content.slice(0, bodyChars), complete: !structure.partial && content.length <= bodyChars, characters: content.length },
    reference,
    ...(structure.replyChainState ? { replyChain: { termination: structure.replyChainState } } : {}),
    state: { createdAt: message.createdAt, editedAt: message.editedAt ?? null, deleted: Boolean(message.deleted),
      pinned: structure.pinned ?? false, messageType: structure.messageType, metadata: structure.metadata ?? 'observed', observedAt: structure.observedAt ?? null },
    mentions: structure.mentions, forwarded: structure.forwarded,
    attachments: structure.attachments, embeds: structure.embeds, stickers: structure.stickers,
    reactions: { total: message.reactionCount ?? null, meaning: 'reaction_not_statement' }
  };
}

export function archiveEnvelope(row) {
  return messageEnvelope({ messageId: row.message_id, guildId: row.guild_id, channelId: row.channel_id,
    authorId: row.author_id, authorName: row.author_name, isBot: Boolean(row.is_bot), content: row.content,
    createdAt: row.created_at, editedAt: row.edited_at, deleted: Boolean(row.deleted),
    reactionCount: row.reaction_count, structure: archiveStructure(row) });
}
