import type {
  AnyThreadChannel,
  Message,
  MessageReaction,
  PartialMessage,
  PartialMessageReaction,
  PartialUser,
  User,
  VoiceState
} from 'discord.js';
import {
  activeDetentions,
  activeRestrictions,
  getCaseByPublicThread,
  recordRestrictionUsage,
  restrictionRules,
  restrictionUsageCount,
  restrictionUsageWindow,
  writeAudit
} from './db.js';
import type { ActiveRestriction } from './types.js';

const LINK_RE = /https?:\/\/|www\.|discord(?:app)?\.com\/invite\/|discord\.gg\//i;


export function hasRestriction(guildId: string, userId: string, primitive: string, now = Date.now()): boolean {
  return activeRestrictions(guildId, userId, now).some((restriction) => restrictionRules(restriction, primitive).length > 0);
}

export function isDetained(guildId: string, userId: string, now = Date.now()): boolean {
  return activeDetentions(guildId, userId, now).length > 0;
}

export function governanceActionAllowed(guildId: string, userId: string, action: string, now = Date.now()): boolean {
  if (isDetained(guildId, userId, now)) return false;
  const primitive = action === 'vote' ? 'block_voting' : 'block_petitions';
  return !hasRestriction(guildId, userId, primitive, now);
}

export interface RestrictedCallReservation {
  ok: boolean;
  used?: number;
  limit?: number;
  retryAt?: number;
  reason?: string;
}

export function reserveRestrictedAgentCall(guildId: string, userId: string, eventId: string, now = Date.now()): RestrictedCallReservation {
  const detentions = activeDetentions(guildId, userId, now);
  if (detentions.length > 0) {
    return {
      ok: false,
      used: 0,
      limit: 0,
      retryAt: Math.min(...detentions.map((entry) => entry.ends_at)),
      reason: 'detention'
    };
  }
  const restrictions = activeRestrictions(guildId, userId, now);
  for (const restriction of restrictions) {
    for (const rule of restrictionRules(restriction, 'agent_calls_per_window')) {
      const windowMs = Number(rule.windowSeconds) * 1000;
      const maximum = Number(rule.maximum);
      const since = now - windowMs;
      const usage = restrictionUsageWindow(restriction.id, 'agent_call', since);
      if (usage.count >= maximum) {
        return {
          ok: false,
          used: usage.count,
          limit: maximum,
          retryAt: (usage.oldest ?? now) + windowMs
        };
      }
    }
  }
  for (const restriction of restrictions) {
    if (restrictionRules(restriction, 'agent_calls_per_window').length > 0) {
      recordRestrictionUsage(restriction.id, 'agent_call', eventId);
    }
  }
  return { ok: true };
}

function blockedMessageReason(message: Message, restriction: ActiveRestriction, now: number): string | null {
  if (restrictionRules(restriction, 'block_links').length > 0 && LINK_RE.test(message.content ?? '')) return 'リンク投稿が制限されています';
  if (restrictionRules(restriction, 'block_attachments').length > 0 && (message.attachments?.size ?? 0) > 0) return '添付投稿が制限されています';
  if (restrictionRules(restriction, 'block_mentions').length > 0
    && ((message.mentions?.users?.size ?? 0) > 0
      || (message.mentions?.roles?.size ?? 0) > 0
      || (message.mentions?.channels?.size ?? 0) > 0
      || message.mentions?.everyone)) {
    return 'メンションが制限されています';
  }
  for (const rule of restrictionRules(restriction, 'messages_per_window')) {
    const since = now - Number(rule.windowSeconds) * 1000;
    const used = restrictionUsageCount(restriction.id, 'message', since);
    if (used >= Number(rule.maximum)) return `${String(rule.windowSeconds)}秒あたり${String(rule.maximum)}件の発言上限です`;
  }
  return null;
}

export async function enforceMessageRestrictions(message: Message | null | undefined): Promise<boolean> {
  if (!message?.guildId || message.author?.bot) return false;
  const now = Date.now();
  const courtCase = message.channel?.isThread?.() ? getCaseByPublicThread(message.channelId) : null;
  const detentions = activeDetentions(message.guildId, message.author.id, now);
  const [protection] = detentions;
  if (protection) {
    // 拘留中でも、自分の事件の記録では必ず反論できる。第十条3。
    const ownOpenCase = courtCase
      && courtCase.accused_id === message.author.id
      && detentions.some((entry) => entry.case_id === courtCase.id);
    if (!ownOpenCase) {
      const reason = '拘留中は自分の事件記録だけに発言できます';
      const deleted = await message.delete().then(() => true).catch(() => false);
      writeAudit({
        guildId: message.guildId,
        actorType: 'system',
        action: deleted ? 'detention.message_blocked' : 'detention.enforcement_failed',
        targetType: 'detention',
        targetId: protection.id,
        detail: { caseId: protection.case_id, messageId: message.id, channelId: message.channelId, reason }
      });
      if (deleted) {
        await message.author.send(`${message.guild?.name ?? 'このコミュニティ'}では拘留中のため、自分の事件記録でだけ発言できます。拘留は時間で自動終了します。`).catch(() => {});
      }
      // 削除権限が壊れていても、この投稿を活動資格・AI・統治受付へ流さない。
      return true;
    }
  }
  // 公開裁判所での当事者の答弁・上訴だけは、別の制裁profileで妨げない。
  // 第三者が事件投稿へ書けば通常の制裁対象となり、裁判所を回避経路にできない。
  if (courtCase
    && ['defense', 'trial', 'appeal'].includes(courtCase.status)
    && [courtCase.reporter_id, courtCase.accused_id].filter(Boolean).includes(message.author.id)) {
    return false;
  }
  const restrictions = activeRestrictions(message.guildId, message.author.id, now);
  for (const restriction of restrictions) {
    const reason = blockedMessageReason(message, restriction, now);
    if (!reason) continue;
    const deleted = await message.delete().then(() => true).catch(() => false);
    if (!deleted) {
      writeAudit({
        guildId: message.guildId,
        actorType: 'system',
        action: 'restriction.enforcement_failed',
        targetType: 'sanction',
        targetId: restriction.sanction_id,
        detail: { event: 'message', messageId: message.id, reason }
      });
      return false;
    }
    writeAudit({
      guildId: message.guildId,
      actorType: 'system',
      action: 'restriction.message_blocked',
      targetType: 'sanction',
      targetId: restriction.sanction_id,
      detail: { userId: message.author.id, messageId: message.id, reason }
    });
    await message.author.send(`${message.guild?.name ?? 'このコミュニティ'}の機能制限により投稿を削除しました: ${reason}\n詳しくは裁判所または通知済みの事件投稿を確認してください。`).catch(() => {});
    return true;
  }
  for (const restriction of restrictions) {
    if (restrictionRules(restriction, 'messages_per_window').length > 0) {
      recordRestrictionUsage(restriction.id, 'message', message.id);
    }
  }
  return false;
}

export async function enforceReactionRestrictions(
  reaction: (MessageReaction | PartialMessageReaction) & { message: Message | PartialMessage } | null | undefined,
  user: User | PartialUser | null | undefined
): Promise<boolean> {
  if (!reaction?.message?.guildId || !user || user.bot) return false;
  if (!isDetained(reaction.message.guildId, user.id)
    && !hasRestriction(reaction.message.guildId, user.id, 'block_reactions')) return false;
  const removed = await reaction.users.remove(user.id).then(() => true).catch(() => false);
  if (removed) writeAudit({
    guildId: reaction.message.guildId,
    actorType: 'system',
    action: 'restriction.reaction_blocked',
    targetType: 'member',
    targetId: user.id,
    detail: { messageId: reaction.message.id }
  });
  return removed;
}

export async function enforceVoiceRestrictions(_oldState: VoiceState | null | undefined, newState: VoiceState | null | undefined): Promise<boolean> {
  if (!newState?.guild?.id || !newState.member || !newState.channelId) return false;
  if (!isDetained(newState.guild.id, newState.member.id)
    && !hasRestriction(newState.guild.id, newState.member.id, 'block_voice')) return false;
  const disconnected = await newState.disconnect(`${newState.guild?.name ?? 'Community'} governance restriction: voice access blocked`)
    .then(() => true).catch(() => false);
  if (disconnected) writeAudit({
    guildId: newState.guild.id,
    actorType: 'system',
    action: 'restriction.voice_blocked',
    targetType: 'member',
    targetId: newState.member.id,
    detail: { channelId: newState.channelId }
  });
  return disconnected;
}

export async function enforceThreadRestrictions(thread: AnyThreadChannel | null | undefined): Promise<boolean> {
  const ownerId = thread?.ownerId;
  if (!thread?.guildId || !ownerId || (!isDetained(thread.guildId, ownerId)
    && !hasRestriction(thread.guildId, ownerId, 'block_thread_creation'))) return false;
  const deleted = await thread.delete(`${thread.guild?.name ?? 'Community'} governance restriction: thread creation blocked`)
    .then(() => true).catch(() => false);
  if (deleted) writeAudit({
    guildId: thread.guildId,
    actorType: 'system',
    action: 'restriction.thread_blocked',
    targetType: 'member',
    targetId: ownerId,
    detail: { threadId: thread.id, parentId: thread.parentId }
  });
  return deleted;
}
