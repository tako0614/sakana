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

/** フォーラム / メディア。中身は「投稿」= スレッドで、本体は発言を持たない。 */
export function isForumType(type) {
  return type === ChannelType.GuildForum || type === ChannelType.GuildMedia;
}

/**
 * bot 自身がそのチャンネルで発言できるか。
 *
 * 「見える」だけでは足りない。送れない場所で実行すると経過表示も回答も
 * 投げ捨てることになり、トークンと同時実行の枠だけを払う (実測でそうなっていた)。
 * 呼ぶのは枠を取る前。
 */
export function canBotSpeak(channel, me) {
  const permissions = channel?.permissionsFor?.(me);
  if (!permissions?.has(Flags.ViewChannel)) return false;

  return isThreadType(channel.type)
    ? permissions.has(Flags.SendMessagesInThreads)
    : permissions.has(Flags.SendMessages);
}

/** 添付を付けられるか。付けられなくても本文は出せるので、実行自体は止めない。 */
export function canBotAttach(channel, me) {
  return Boolean(channel?.permissionsFor?.(me)?.has(Flags.AttachFiles));
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
  // 消えたチャンネルは誰の権限でも判定できないので既定では落とす。
  // ただし管理者には見せられるようにする (長く運用したサーバーだと、
  // 整理で消したチャンネルに古い発言がまとまって入っていることがある)。
  const includeDeleted = canManageIndex(member);

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

    // スレッド以外でキャッシュに無い = サーバーから消えたチャンネル。
    // (通常のチャンネルは GUILD_CREATE で全部キャッシュに載るので、
    //  載っていないなら実体が無い。スレッドはアーカイブで載らないので除く)
    if (includeDeleted && !row.is_thread) {
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

// /index を使える人を ID で明示的に足せるようにする。
// サーバーの ManageGuild を渡すとサーバー名変更・Webhook・連携まで付いてしまうので、
// 「bot の管理コマンドだけ渡したい」ときはこちらを使う。
const ARCHIVE_ADMIN_USERS = String(process.env.ARCHIVE_ADMIN_USERS ?? '')
  .split(/[\s,]+/)
  .filter(Boolean);

export function canManageIndex(member) {
  if (member?.id && ARCHIVE_ADMIN_USERS.includes(member.id)) return true;
  return Boolean(member?.permissions?.has(Flags.Administrator) || member?.permissions?.has(Flags.ManageGuild));
}

export function canSeeDeleted(member) {
  return Boolean(member?.permissions?.has(Flags.ManageMessages));
}
