import { PermissionFlagsBits, type Guild, type MessageMentionOptions } from 'discord.js';
import {
  claimGovernanceNotification,
  completeGovernanceNotification,
  failGovernanceNotification,
  getGovernanceGuild,
  getWorkflowInstance,
  getOperationalSetting,
  reconcileGovernanceNotification,
  writeAudit
} from './db.js';
import type { OperationalSettingKey } from './config.js';
import { humanAuthorityLabel } from './human-authority.js';
import { errorText, type CaseRecord, type NotificationRow, type Proposal } from './types.js';

export type AudienceKind = 'everyone' | 'trusted_role' | 'user';

const NOTIFICATION_LIMIT_KEYS: Readonly<Record<AudienceKind, OperationalSettingKey>> = Object.freeze({
  everyone: 'notification_everyone_daily_limit',
  trusted_role: 'notification_trusted_daily_limit',
  user: 'notification_user_daily_limit'
});

const EVENT_AUDIENCES: Readonly<Record<string, AudienceKind>> = Object.freeze({
  proposal_vote_all: 'everyone',
  proposal_vote_trusted: 'trusted_role',
  case_approval: 'trusted_role',
  case_approval_all: 'everyone',
  case_defense: 'user',
  case_appeal: 'user'
});

/** 通知1件の宛先と mention。silent は「カードは出すが一括の mention はしない」。 */
export interface NotificationDescriptor {
  guildId: string;
  eventKey: string;
  eventType: string;
  audienceKind: AudienceKind;
  audienceId: string | null;
  mention: string;
  silent?: boolean;
}

/** 送った (または既に送ってあった) 投稿のうち、通知の記録に使う項目。 */
export interface DeliveredMessage {
  id: string;
  channelId?: string | null;
  channel?: { id: string } | null;
  createdTimestamp?: number | null;
}

function discordId(value: unknown): string | null {
  const normalized = String(value ?? '');
  return /^\d{17,20}$/.test(normalized) ? normalized : null;
}

function eventDescriptor({ guildId, eventKey, eventType, audienceId = null, mention }: {
  guildId: string; eventKey: string; eventType: string; audienceId?: string | null; mention: string;
}): NotificationDescriptor {
  const audienceKind = EVENT_AUDIENCES[eventType];
  if (!audienceKind) throw new Error('未許可の通知イベントです。');
  return { guildId, eventKey, eventType, audienceKind, audienceId, mention };
}

function roleCanBeMentioned(guild: Guild, roleId: string): boolean {
  const role = guild.roles?.cache?.get?.(roleId);
  return Boolean(role?.mentionable || guild.members?.me?.permissions?.has?.(PermissionFlagsBits.MentionEveryone));
}

// 宛先ごとに、mention してよい相手をちょうどその1種類だけにする。本文に他の mention が混ざっても鳴らさない。
function notificationAllowedMentions(descriptor: NotificationDescriptor): MessageMentionOptions {
  if (descriptor.audienceKind === 'everyone') return { parse: ['everyone'], repliedUser: false };
  // 送信までに suppressionReason が Discord ID であることを確かめている。ID でなければ誰も鳴らさない。
  const audience = discordId(descriptor.audienceId);
  if (descriptor.audienceKind === 'trusted_role') {
    return { parse: [], roles: audience ? [audience] : [], repliedUser: false };
  }
  return { parse: [], users: audience ? [audience] : [], repliedUser: false };
}

function suppressionReason(guild: Guild, descriptor: NotificationDescriptor): string | null {
  if (descriptor.silent) return '法令で指定した対象者への公開カード。全員・特別有権者への一括通知は使わない。';
  if (descriptor.audienceKind === 'everyone'
    && !guild.members?.me?.permissions?.has?.(PermissionFlagsBits.MentionEveryone)) {
    return 'bot lacks MentionEveryone permission';
  }
  if (descriptor.audienceKind === 'trusted_role') {
    const roleId = discordId(descriptor.audienceId);
    if (!roleId) return 'trusted role is not configured';
    if (!roleCanBeMentioned(guild, roleId)) return 'trusted role is not mentionable';
  }
  if (descriptor.audienceKind === 'user' && !discordId(descriptor.audienceId)) {
    return 'case party is not a Discord user';
  }
  return null;
}

export function proposalVoteNotification(guild: Guild, proposal: Pick<Proposal, 'id' | 'vote_scope' | 'stage_started_at' | 'stage_ends_at' | 'revision'>): NotificationDescriptor {
  const governance = getGovernanceGuild(guild.id);
  const phase = Number(proposal.stage_started_at ?? proposal.stage_ends_at ?? proposal.revision ?? 0);
  if (proposal.vote_scope === 'trusted') {
    const roleId = discordId(governance?.trusted_role_id);
    return eventDescriptor({
      guildId: guild.id,
      eventKey: `governance:proposal:${proposal.id}:vote:${proposal.revision ?? 1}:${phase}`,
      eventType: 'proposal_vote_trusted',
      audienceId: roleId,
      mention: roleId ? `<@&${roleId}>` : '特別有権者'
    });
  }
  return eventDescriptor({
    guildId: guild.id,
    eventKey: `governance:proposal:${proposal.id}:vote:${proposal.revision ?? 1}:${phase}`,
    eventType: 'proposal_vote_all',
    mention: '@everyone'
  });
}

export function caseApprovalNotification(guild: Guild, caseRecord: Pick<CaseRecord, 'id'>, sanction: { id: number | string }): NotificationDescriptor {
  const governance = getGovernanceGuild(guild.id);
  const approval = getWorkflowInstance('case', caseRecord.id)?.context.approval;
  const roleId = discordId(governance?.trusted_role_id);
  const selected = approval && !['all', 'trusted'].includes(String(approval.scope));
  const descriptor = eventDescriptor({
    guildId: guild.id,
    eventKey: `governance:case:${caseRecord.id}:approval:${sanction.id}${approval ? `:${approval.openedAt}` : ''}`,
    eventType: approval?.scope === 'all' ? 'case_approval_all' : 'case_approval',
    audienceId: roleId,
    mention: selected ? humanAuthorityLabel(approval.authority ?? approval) : approval?.scope === 'all' ? '@everyone' : roleId ? `<@&${roleId}>` : '承認資格のある構成員'
  });
  return selected ? { ...descriptor, silent: true } : descriptor;
}

type CaseParty = Pick<CaseRecord, 'id' | 'accused_id' | 'review_count'>;

function casePartyNotification(guild: Guild, caseRecord: CaseParty, phase: string, deadline: number): { descriptor: NotificationDescriptor; message: string } {
  const userId = discordId(caseRecord.accused_id);
  const eventType = phase === 'appeal' ? 'case_appeal' : 'case_defense';
  const round = phase === 'appeal' ? 'appeal' : `defense:${caseRecord.review_count ?? 0}`;
  const message = phase === 'appeal'
    ? `${userId ? `<@${userId}>` : '被申立人'} この判決は上訴できます。期限 <t:${Math.floor(deadline / 1000)}:R>。事件投稿上部のボタンから手続してください。`
    : `${userId ? `<@${userId}>` : '被申立人'} 回答が必要です。期限 <t:${Math.floor(deadline / 1000)}:R>。この事件投稿で答弁してください。`;
  return {
    descriptor: eventDescriptor({
      guildId: guild.id,
      eventKey: `governance:case:${caseRecord.id}:${round}`,
      eventType,
      audienceId: userId,
      mention: userId ? `<@${userId}>` : '被申立人'
    }),
    message
  };
}

export interface NotificationDelivery {
  eventKey: string;
  allowedMentions: MessageMentionOptions;
}

export function beginGovernanceNotification(guild: Guild, descriptor: NotificationDescriptor): NotificationDelivery | null {
  const limit = getOperationalSetting(guild.id, NOTIFICATION_LIMIT_KEYS[descriptor.audienceKind]);
  const result = claimGovernanceNotification({
    ...descriptor,
    limit,
    suppressionReason: suppressionReason(guild, descriptor)
  });
  if (result.action === 'suppressed') {
    writeAudit({
      guildId: guild.id,
      actorType: 'system',
      action: 'notification.suppressed',
      targetType: 'notification',
      targetId: result.notification?.id ?? null,
      detail: { eventType: descriptor.eventType, reason: result.notification?.last_error }
    });
  }
  return result.action === 'send'
    ? { eventKey: descriptor.eventKey, allowedMentions: notificationAllowedMentions(descriptor) }
    : null;
}

export function reconcileGovernanceNotificationMessage(descriptor: NotificationDescriptor, message: DeliveredMessage): NotificationRow | null {
  return reconcileGovernanceNotification({
    ...descriptor,
    channelId: message.channelId ?? message.channel?.id ?? null,
    messageId: message.id,
    deliveredAt: message.createdTimestamp ?? Date.now()
  });
}

export function finishGovernanceNotification(descriptor: NotificationDescriptor, message: DeliveredMessage): NotificationRow | null {
  const notification = completeGovernanceNotification(descriptor.eventKey, {
    channelId: message.channelId ?? message.channel?.id ?? null,
    messageId: message.id
  });
  writeAudit({
    guildId: descriptor.guildId,
    actorType: 'system',
    action: 'notification.delivered',
    targetType: 'notification',
    targetId: notification?.id ?? null,
    detail: { eventType: descriptor.eventType, audienceKind: descriptor.audienceKind }
  });
  return notification;
}

export function rejectGovernanceNotification(descriptor: NotificationDescriptor, error: unknown): NotificationRow | null {
  const notification = failGovernanceNotification(descriptor.eventKey, error);
  writeAudit({
    guildId: descriptor.guildId,
    actorType: 'system',
    action: 'notification.failed',
    targetType: 'notification',
    targetId: notification?.id ?? null,
    detail: { eventType: descriptor.eventType, error: errorText(error).slice(0, 500) }
  });
  return notification;
}

export async function notifyCaseParty(guild: Guild, caseRecord: CaseParty & Pick<CaseRecord, 'public_thread_id'>, phase: string, deadline: unknown): Promise<boolean> {
  if (!caseRecord.public_thread_id || !Number.isFinite(Number(deadline))) return false;
  const { descriptor, message } = casePartyNotification(guild, caseRecord, phase, Number(deadline));
  const thread = await guild.channels.fetch(caseRecord.public_thread_id).catch(() => null);
  if (!thread?.isTextBased?.() && !thread?.isThread?.()) return false;
  // text-based な channel とスレッドは必ず messages と send を持つ。型の上でもそこまで絞る。
  if (!thread || !('messages' in thread) || !('send' in thread)) return false;
  const recent = await thread.messages?.fetch?.({ limit: 100 }).catch?.(() => null);
  const existing = recent?.find?.((candidate) => candidate.author?.id === guild.client.user.id && candidate.content === message);
  if (existing) {
    reconcileGovernanceNotificationMessage(descriptor, existing);
    return false;
  }
  const delivery = beginGovernanceNotification(guild, descriptor);
  if (!delivery) return false;
  try {
    const sent = await thread.send({ content: message, allowedMentions: delivery.allowedMentions });
    finishGovernanceNotification(descriptor, sent);
    return true;
  } catch (error) {
    rejectGovernanceNotification(descriptor, error);
    return false;
  }
}
