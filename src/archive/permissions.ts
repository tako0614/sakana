import {
  ChannelType,
  PermissionsBitField,
  type APIInteractionGuildMember,
  type GuildBasedChannel,
  type GuildMember,
  type Guild,
  type Role,
  type TextBasedChannel
} from 'discord.js';
import { db } from './db.js';
import type { ChannelScope } from './types.js';

const { Flags } = PermissionsBitField;

// メッセージを持ちうるチャンネル種別
export const MESSAGE_CHANNEL_TYPES: ReadonlySet<ChannelType> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread
]);

// 自身はメッセージを持たないが、スレッドをぶら下げるチャンネル種別
export const THREAD_CONTAINER_TYPES: ReadonlySet<ChannelType> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia
]);

export function isThreadType(type: ChannelType | null | undefined): boolean {
  return type === ChannelType.PublicThread
    || type === ChannelType.PrivateThread
    || type === ChannelType.AnnouncementThread;
}

/** フォーラム / メディア。中身は「投稿」= スレッドで、本体は発言を持たない。 */
export function isForumType(type: ChannelType | null | undefined): boolean {
  return type === ChannelType.GuildForum || type === ChannelType.GuildMedia;
}

/** permissionsFor を持つ (サーバーの) チャンネルか。DM などは持たない。 */
function hasPermissionsFor(channel: TextBasedChannel | GuildBasedChannel | null | undefined): channel is GuildBasedChannel {
  return typeof channel === 'object' && channel !== null && 'permissionsFor' in channel && typeof channel.permissionsFor === 'function';
}

/**
 * bot 自身がそのチャンネルで発言できるか。
 *
 * 「見える」だけでは足りない。送れない場所で実行すると経過表示も回答も
 * 投げ捨てることになり、トークンと同時実行の枠だけを払う (実測でそうなっていた)。
 * 呼ぶのは枠を取る前。
 */
export function canBotSpeak(channel: TextBasedChannel | GuildBasedChannel | null | undefined, me: GuildMember): boolean {
  if (!hasPermissionsFor(channel)) return false;
  const permissions = channel.permissionsFor(me);
  if (!permissions?.has(Flags.ViewChannel)) return false;

  return isThreadType(channel.type)
    ? permissions.has(Flags.SendMessagesInThreads)
    : permissions.has(Flags.SendMessages);
}

/** 添付を付けられるか。付けられなくても本文は出せるので、実行自体は止めない。 */
export function canBotAttach(channel: TextBasedChannel | GuildBasedChannel | null | undefined, me: GuildMember): boolean {
  return hasPermissionsFor(channel) && Boolean(channel.permissionsFor(me)?.has(Flags.AttachFiles));
}

export function canRead(channel: GuildBasedChannel, member: GuildMember | Role): boolean {
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

interface ChannelScopeRow {
  channel_id: string;
  parent_id: string | null;
  is_thread: number;
  is_private: number;
}

/**
 * 実行者が閲覧できるチャンネルだけに検索範囲を絞るためのスコープを作る。
 * 見えないチャンネルの中身が検索から漏れないようにするための要。
 */
export function getChannelScope(guild: Guild, member: GuildMember): ChannelScope {
  const allowed = new Set<string>();
  const allowedParents = new Set<string>();
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
    .prepare<[string], ChannelScopeRow>('SELECT channel_id, parent_id, is_thread, is_private FROM channels WHERE guild_id = ?')
    .all(guild.id);

  const denied: string[] = [];

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

/**
 * 権限を判定できるメンバー。キャッシュ済みなら GuildMember、未キャッシュの interaction なら
 * API の形 (permissions が10進の文字列) で届く。
 */
export type PermissionHolder = Pick<GuildMember, 'id' | 'permissions'> | APIInteractionGuildMember;

function memberId(member: PermissionHolder): string | undefined {
  return 'user' in member ? member.user.id : member.id;
}

function memberPermissions(member: PermissionHolder): Readonly<PermissionsBitField> | null {
  const { permissions } = member;
  if (typeof permissions !== 'string') return permissions ?? null;
  // API の形のメンバーは権限が10進の文字列で来る。読めなければ権限なしとして扱う
  try {
    return new PermissionsBitField(BigInt(permissions));
  } catch {
    return null;
  }
}

export function canManageIndex(member: PermissionHolder | null | undefined): boolean {
  if (!member) return false;
  const id = memberId(member);
  if (id && ARCHIVE_ADMIN_USERS.includes(id)) return true;
  const permissions = memberPermissions(member);
  return Boolean(permissions?.has(Flags.Administrator) || permissions?.has(Flags.ManageGuild));
}

export function canSeeDeleted(member: PermissionHolder | null | undefined): boolean {
  if (!member) return false;
  return Boolean(memberPermissions(member)?.has(Flags.ManageMessages));
}
