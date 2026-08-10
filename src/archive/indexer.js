import { ChannelType } from 'discord.js';
import {
  countChannelMessages,
  getChannelState,
  getGuildState,
  markMessageDeleted,
  replaceReactions,
  saveMessage,
  saveMessages,
  setGuildState,
  updateChannelState,
  upsertChannel
} from './db.js';
import { MESSAGE_CHANNEL_TYPES, THREAD_CONTAINER_TYPES, canRead, isThreadType } from './permissions.js';

const FETCH_DELAY_MS = Number(process.env.ARCHIVE_FETCH_DELAY_MS ?? 150);
const PAGE_SIZE = 100;
const LINK_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/gi;

const runningJobs = new Map(); // guildId -> job

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractLinks(content) {
  const links = [];
  const seen = new Set();

  for (const match of content.matchAll(LINK_PATTERN)) {
    const url = match[0].replace(/[.,;:!?]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);

    let domain = '';
    try {
      domain = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }

    links.push({ url: url.slice(0, 500), domain });
  }

  return links;
}

function attachmentKind(attachment) {
  const type = attachment.contentType ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * discord.js の Message を DB 行に変換する。
 * extra には本文以外の検索対象 (添付ファイル名 / 埋め込み文言 / URL) を詰める。
 */
export function toRecord(message) {
  const content = message.content ?? '';
  const attachments = [...message.attachments.values()];
  const kinds = new Set(attachments.map(attachmentKind));

  const extraParts = [];
  for (const attachment of attachments) {
    extraParts.push(attachment.name ?? '');
    if (attachment.description) extraParts.push(attachment.description);
  }
  for (const embed of message.embeds ?? []) {
    extraParts.push(embed.title ?? '', embed.description ?? '', embed.author?.name ?? '', embed.footer?.text ?? '');
    for (const field of embed.fields ?? []) {
      extraParts.push(field.name ?? '', field.value ?? '');
    }
  }
  for (const sticker of message.stickers?.values() ?? []) {
    extraParts.push(sticker.name ?? '');
  }

  const links = extractLinks(content);
  for (const link of links) extraParts.push(link.url);

  const reactions = [...(message.reactions?.cache?.values() ?? [])].map((reaction) => ({
    emoji: reaction.emoji.id ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name,
    count: reaction.count ?? 0
  }));

  const channel = message.channel;

  return {
    message_id: message.id,
    guild_id: message.guildId ?? message.guild?.id ?? '',
    channel_id: message.channelId,
    parent_id: channel?.isThread?.() ? channel.parentId : null,
    author_id: message.author?.id ?? '0',
    author_name: message.member?.displayName ?? message.author?.globalName ?? message.author?.username ?? '',
    is_bot: message.author?.bot ? 1 : 0,
    content,
    extra: extraParts.filter(Boolean).join('\n'),
    created_at: message.createdTimestamp,
    edited_at: message.editedTimestamp ?? null,
    reply_to: message.reference?.messageId ?? null,
    attachment_count: attachments.length,
    attachment_kinds: kinds.size > 0 ? ` ${[...kinds].join(' ')} ` : '',
    embed_count: message.embeds?.length ?? 0,
    sticker_count: message.stickers?.size ?? 0,
    link_count: links.length,
    reaction_count: reactions.reduce((sum, reaction) => sum + reaction.count, 0),
    char_count: Array.from(content).length,
    pinned: message.pinned ? 1 : 0,
    mentions: [...(message.mentions?.users?.keys() ?? [])],
    reactions,
    links
  };
}

function channelRow(channel) {
  return {
    channel_id: channel.id,
    guild_id: channel.guildId ?? channel.guild?.id ?? '',
    parent_id: isThreadType(channel.type) ? channel.parentId : null,
    name: channel.name ?? '',
    type: channel.type,
    is_thread: isThreadType(channel.type) ? 1 : 0,
    is_private: channel.type === ChannelType.PrivateThread ? 1 : 0
  };
}

async function collectThreads(channel, botMember) {
  const threads = [];

  const active = await channel.threads.fetchActive().catch(() => null);
  if (active) threads.push(...active.threads.values());

  for (const type of ['public', 'private']) {
    let before;

    for (let page = 0; page < 200; page += 1) {
      const fetched = await channel.threads
        .fetchArchived({ type, limit: PAGE_SIZE, before })
        .catch(() => null);

      if (!fetched || fetched.threads.size === 0) break;

      threads.push(...fetched.threads.values());

      let oldest = Infinity;
      for (const thread of fetched.threads.values()) {
        const stamp = thread.archivedTimestamp ?? thread.createdTimestamp ?? 0;
        if (stamp < oldest) oldest = stamp;
      }

      if (!fetched.hasMore || !Number.isFinite(oldest)) break;
      before = oldest;
      await sleep(FETCH_DELAY_MS);
    }
  }

  const unique = new Map();
  for (const thread of threads) {
    if (!canRead(thread, botMember)) continue;
    unique.set(thread.id, thread);
  }

  return [...unique.values()];
}

/**
 * ギルド内でメッセージを取得できるチャンネル (スレッド含む) を全部集める。
 */
export async function collectIndexableChannels(guild) {
  const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!botMember) return { channels: [], skipped: [] };

  const result = [];
  const skipped = [];

  for (const channel of guild.channels.cache.values()) {
    const hasMessages = MESSAGE_CHANNEL_TYPES.has(channel.type) && !isThreadType(channel.type);
    const hasThreads = THREAD_CONTAINER_TYPES.has(channel.type);

    if (!hasMessages && !hasThreads) continue;

    if (!canRead(channel, botMember)) {
      skipped.push(channel.name ?? channel.id);
      continue;
    }

    if (hasMessages) result.push(channel);

    if (hasThreads) {
      const threads = await collectThreads(channel, botMember);
      result.push(...threads);
      await sleep(FETCH_DELAY_MS);
    }
  }

  return { channels: result, skipped };
}

async function indexChannel(channel, { mode, job }) {
  upsertChannel(channelRow(channel));

  const state = getChannelState(channel.id) ?? {};
  let indexed = 0;

  const persist = (messages) => {
    if (messages.length === 0) return;
    saveMessages(messages.map(toRecord));
    indexed += messages.length;
    job.messagesIndexed += messages.length;
  };

  // --- 新しい方向へ (前回の続きから最新まで) ---
  let newest = state.newest_id ?? null;

  if (newest) {
    for (;;) {
      if (job.cancelled) return indexed;

      const batch = await channel.messages.fetch({ after: newest, limit: PAGE_SIZE });
      if (batch.size === 0) break;

      const messages = [...batch.values()].sort((a, b) => (a.createdTimestamp - b.createdTimestamp));
      persist(messages);

      newest = messages[messages.length - 1].id;
      updateChannelState(channel.id, { newest_id: newest });

      if (batch.size < PAGE_SIZE) break;
      await sleep(FETCH_DELAY_MS);
    }
  }

  // --- 古い方向へ (未完了なら最古まで遡る) ---
  const needsBackfill = mode === 'full' && state.complete !== 1;

  if (needsBackfill || !newest) {
    let before = state.oldest_id ?? null;

    for (;;) {
      if (job.cancelled) return indexed;

      const batch = await channel.messages.fetch(before ? { before, limit: PAGE_SIZE } : { limit: PAGE_SIZE });
      if (batch.size === 0) {
        updateChannelState(channel.id, { complete: 1 });
        break;
      }

      const messages = [...batch.values()].sort((a, b) => (b.createdTimestamp - a.createdTimestamp));
      persist(messages);

      if (!newest) {
        newest = messages[0].id;
        updateChannelState(channel.id, { newest_id: newest });
      }

      before = messages[messages.length - 1].id;
      updateChannelState(channel.id, { oldest_id: before });

      if (batch.size < PAGE_SIZE) {
        updateChannelState(channel.id, { complete: 1 });
        break;
      }

      if (!needsBackfill) break; // update モードでは初回分だけ入れて終わり

      await sleep(FETCH_DELAY_MS);
    }
  }

  updateChannelState(channel.id, {
    message_count: countChannelMessages(channel.id),
    last_error: null
  });

  return indexed;
}

export function getRunningJob(guildId) {
  return runningJobs.get(guildId);
}

export function cancelJob(guildId) {
  const job = runningJobs.get(guildId);
  if (!job) return false;
  job.cancelled = true;
  return true;
}

/**
 * ギルド全体のインデックス作成。
 * mode: 'full' = 最古まで遡る / 'update' = 前回の続きだけ
 */
export async function runIndexJob(guild, { mode = 'full', onProgress = () => {} } = {}) {
  if (runningJobs.has(guild.id)) {
    throw new Error('このサーバーでは既にインデックス作成が実行中です。');
  }

  const job = {
    guildId: guild.id,
    mode,
    cancelled: false,
    startedAt: Date.now(),
    messagesIndexed: 0,
    channelsDone: 0,
    channelsTotal: 0,
    currentChannel: null
  };

  runningJobs.set(guild.id, job);
  setGuildState(guild.id, {
    status: 'running',
    mode,
    started_at: job.startedAt,
    finished_at: null,
    messages_indexed: 0,
    channels_done: 0,
    channels_total: 0,
    current_channel: null,
    last_error: null
  });

  try {
    const { channels, skipped } = await collectIndexableChannels(guild);
    job.channelsTotal = channels.length;
    job.skipped = skipped;
    setGuildState(guild.id, { channels_total: channels.length });
    onProgress(job);

    for (const channel of channels) {
      if (job.cancelled) break;

      job.currentChannel = channel.name ?? channel.id;
      onProgress(job);

      try {
        await indexChannel(channel, { mode, job });
      } catch (error) {
        console.error(`Failed to index channel ${channel.id}:`, error);
        upsertChannel(channelRow(channel));
        updateChannelState(channel.id, { last_error: String(error.message ?? error).slice(0, 300) });
      }

      job.channelsDone += 1;
      setGuildState(guild.id, {
        channels_done: job.channelsDone,
        messages_indexed: job.messagesIndexed,
        current_channel: job.currentChannel
      });
      onProgress(job);
    }

    setGuildState(guild.id, {
      status: job.cancelled ? 'cancelled' : 'idle',
      finished_at: Date.now(),
      messages_indexed: job.messagesIndexed,
      channels_done: job.channelsDone,
      current_channel: null
    });

    return job;
  } catch (error) {
    setGuildState(guild.id, {
      status: 'error',
      finished_at: Date.now(),
      last_error: String(error.message ?? error).slice(0, 300)
    });
    throw error;
  } finally {
    runningJobs.delete(guild.id);
  }
}

/**
 * インデックス済みのサーバーでは、新着メッセージをそのまま追記していく。
 * これがないと /index を回すたびに差分を取りに行くことになる。
 */
export function indexLiveMessage(message) {
  if (!message.guildId) return;
  if (!getGuildState(message.guildId)) return;

  try {
    if (message.channel && !getChannelState(message.channelId)) {
      upsertChannel(channelRow(message.channel));
    }

    saveMessage(toRecord(message));
    updateChannelState(message.channelId, { newest_id: message.id });
  } catch (error) {
    console.error('Failed to index live message:', error);
  }
}

export function indexLiveEdit(message) {
  if (!message.guildId || !message.author) return;
  if (!getGuildState(message.guildId)) return;

  try {
    saveMessage(toRecord(message));
  } catch (error) {
    console.error('Failed to index edited message:', error);
  }
}

export function markLiveDelete(message) {
  // 削除イベントは partial で届くことがあるので guildId を複数経路から拾う
  const guildId = message.guildId ?? message.guild?.id ?? message.channel?.guildId;
  if (!guildId || !getGuildState(guildId)) return;

  try {
    markMessageDeleted(message.id);
  } catch (error) {
    console.error('Failed to mark message deleted:', error);
  }
}

export function syncLiveReactions(message) {
  if (!message?.guildId) return;
  if (!getGuildState(message.guildId)) return;

  try {
    const reactions = [...(message.reactions?.cache?.values() ?? [])].map((reaction) => ({
      emoji: reaction.emoji.id ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name,
      count: reaction.count ?? 0
    }));

    replaceReactions(message.id, reactions);
  } catch (error) {
    console.error('Failed to sync reactions:', error);
  }
}
