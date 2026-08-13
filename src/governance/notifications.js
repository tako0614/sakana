import { PermissionFlagsBits } from 'discord.js';
import {
  claimGovernanceNotification,
  completeGovernanceNotification,
  failGovernanceNotification,
  getGovernanceGuild,
  getOperationalSetting,
  reconcileGovernanceNotification,
  writeAudit
} from './db.js';

const NOTIFICATION_LIMIT_KEYS = Object.freeze({
  everyone: 'notification_everyone_daily_limit',
  trusted_role: 'notification_trusted_daily_limit',
  user: 'notification_user_daily_limit'
});

const EVENT_AUDIENCES = Object.freeze({
  proposal_vote_all: 'everyone',
  proposal_vote_trusted: 'trusted_role',
  case_approval: 'trusted_role',
  case_defense: 'user',
  case_appeal: 'user'
});

function discordId(value) {
  const normalized = String(value ?? '');
  return /^\d{17,20}$/.test(normalized) ? normalized : null;
}

function eventDescriptor({ guildId, eventKey, eventType, audienceId = null, mention }) {
  const audienceKind = EVENT_AUDIENCES[eventType];
  if (!audienceKind) throw new Error('未許可の通知イベントです。');
  return { guildId, eventKey, eventType, audienceKind, audienceId, mention };
}

function roleCanBeMentioned(guild, roleId) {
  const role = guild.roles?.cache?.get?.(roleId);
  return Boolean(role?.mentionable || guild.members?.me?.permissions?.has?.(PermissionFlagsBits.MentionEveryone));
}

function notificationAllowedMentions(descriptor) {
  if (descriptor.audienceKind === 'everyone') return { parse: ['everyone'], repliedUser: false };
  if (descriptor.audienceKind === 'trusted_role') {
    return { parse: [], roles: [descriptor.audienceId], repliedUser: false };
  }
  return { parse: [], users: [descriptor.audienceId], repliedUser: false };
}

function suppressionReason(guild, descriptor) {
  if (descriptor.audienceKind === 'everyone'
    && !guild.members?.me?.permissions?.has?.(PermissionFlagsBits.MentionEveryone)) {
    return 'bot lacks MentionEveryone permission';
  }
  if (descriptor.audienceKind === 'trusted_role') {
    if (!discordId(descriptor.audienceId)) return 'trusted role is not configured';
    if (!roleCanBeMentioned(guild, descriptor.audienceId)) return 'trusted role is not mentionable';
  }
  if (descriptor.audienceKind === 'user' && !discordId(descriptor.audienceId)) {
    return 'case party is not a Discord user';
  }
  return null;
}

export function proposalVoteNotification(guild, proposal) {
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

export function caseApprovalNotification(guild, caseRecord, sanction) {
  const governance = getGovernanceGuild(guild.id);
  const roleId = discordId(governance?.trusted_role_id);
  return eventDescriptor({
    guildId: guild.id,
    eventKey: `governance:case:${caseRecord.id}:approval:${sanction.id}`,
    eventType: 'case_approval',
    audienceId: roleId,
    mention: roleId ? `<@&${roleId}>` : '特別有権者'
  });
}

function casePartyNotification(guild, caseRecord, phase, deadline) {
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

export function beginGovernanceNotification(guild, descriptor) {
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
      targetId: result.notification.id,
      detail: { eventType: descriptor.eventType, reason: result.notification.last_error }
    });
  }
  return result.action === 'send'
    ? { eventKey: descriptor.eventKey, allowedMentions: notificationAllowedMentions(descriptor) }
    : null;
}

export function reconcileGovernanceNotificationMessage(descriptor, message) {
  return reconcileGovernanceNotification({
    ...descriptor,
    channelId: message.channelId ?? message.channel?.id ?? null,
    messageId: message.id,
    deliveredAt: message.createdTimestamp ?? Date.now()
  });
}

export function finishGovernanceNotification(descriptor, message) {
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

export function rejectGovernanceNotification(descriptor, error) {
  const notification = failGovernanceNotification(descriptor.eventKey, error);
  writeAudit({
    guildId: descriptor.guildId,
    actorType: 'system',
    action: 'notification.failed',
    targetType: 'notification',
    targetId: notification?.id ?? null,
    detail: { eventType: descriptor.eventType, error: String(error?.message ?? error).slice(0, 500) }
  });
  return notification;
}

export async function notifyCaseParty(guild, caseRecord, phase, deadline) {
  if (!caseRecord.public_thread_id || !Number.isFinite(Number(deadline))) return false;
  const { descriptor, message } = casePartyNotification(guild, caseRecord, phase, Number(deadline));
  const thread = await guild.channels.fetch(caseRecord.public_thread_id).catch(() => null);
  if (!thread?.isTextBased?.() && !thread?.isThread?.()) return false;
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
