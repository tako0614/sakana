import { ChannelType, PermissionsBitField } from 'discord.js';
import { db } from './db.js';

const { Flags } = PermissionsBitField;

// メッセージを持ちうるチャンネル種別
export const MESSAGE_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread
]);

// 自身はメッセージを持たないが、スレッドをぶら下げるチャンネル種別
export const THREAD_CONTAINER_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia
]);

export function isThreadType(type) {
  return type === ChannelType.PublicThread
    || type === ChannelType.PrivateThread
    || type === ChannelType.AnnouncementThread;
}

export function canRead(channel, member) {
  const permissions = channel.permissionsFor(member);
  if (!permissions?.has(Flags.ViewChannel) || !permissions.has(Flags.ReadMessageHistory)) {
    return false;
  }

  // プライベートスレッドは権限計算だけでは判定できないので、
  // 参加者か「スレッドの管理」権限を持つ人だけに見せる。
  if (channel.type === ChannelType.PrivateThread) {
    return permissions.has(Flags.ManageThreads) || Boolean(channel.members?.cache?.has(member.id));
  }

  return true;
}

/**
 * 実行者が閲覧できるチャンネルだけに検索範囲を絞るためのスコープを作る。
 * 見えないチャンネルの中身が検索から漏れないようにするための要。
 */
export function getChannelScope(guild, member) {
  const allowed = new Set();
  const allowedParents = new Set();

  for (const channel of guild.channels.cache.values()) {
    if (!MESSAGE_CHANNEL_TYPES.has(channel.type) && !THREAD_CONTAINER_TYPES.has(channel.type)) {
      continue;
    }

    if (!canRead(channel, member)) continue;

    if (isThreadType(channel.type)) {
      allowed.add(channel.id);
    } else {
      allowed.add(channel.id);
      allowedParents.add(channel.id);
    }
  }

  const rows = db
    .prepare('SELECT channel_id, parent_id, is_thread, is_private FROM channels WHERE guild_id = ?')
    .all(guild.id);

  const denied = [];

  for (const row of rows) {
    if (allowed.has(row.channel_id)) continue;

    // アーカイブ済みスレッドはキャッシュに無いことが多い。親チャンネルの権限で判定する。
    if (row.is_thread && !row.is_private && row.parent_id && allowedParents.has(row.parent_id)) {
      allowed.add(row.channel_id);
      continue;
    }

    denied.push(row.channel_id);
  }

  if (denied.length === 0) return { mode: 'all', ids: [] };
  if (allowed.size === 0) return { mode: 'none', ids: [] };

  // IN / NOT IN のうち短い方を使う
  return denied.length <= allowed.size
    ? { mode: 'exclude', ids: denied }
    : { mode: 'include', ids: [...allowed] };
}

export function canManageIndex(member) {
  return Boolean(member?.permissions?.has(Flags.Administrator) || member?.permissions?.has(Flags.ManageGuild));
}

export function canSeeDeleted(member) {
  return Boolean(member?.permissions?.has(Flags.ManageMessages));
}
