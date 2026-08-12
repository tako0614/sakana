import {
  activeInterimProtections,
  activeRestrictions,
  getCaseByPublicThread,
  recordRestrictionUsage,
  restrictionUsageCount,
  restrictionUsageWindow,
  writeAudit
} from './db.js';

const LINK_RE = /https?:\/\/|www\.|discord(?:app)?\.com\/invite\/|discord\.gg\//i;

function rules(restriction, primitive) {
  return (restriction.profile?.rules ?? []).filter((rule) => rule.primitive === primitive);
}

export function hasRestriction(guildId, userId, primitive, now = Date.now()) {
  return activeRestrictions(guildId, userId, now).some((restriction) => rules(restriction, primitive).length > 0);
}

export function hasInterimProtection(guildId, userId, now = Date.now()) {
  return activeInterimProtections(guildId, userId, now).length > 0;
}

export function governanceActionAllowed(guildId, userId, action, now = Date.now()) {
  if (hasInterimProtection(guildId, userId, now)) return false;
  const primitive = action === 'vote' ? 'block_voting' : 'block_petitions';
  return !hasRestriction(guildId, userId, primitive, now);
}

export function reserveRestrictedAgentCall(guildId, userId, eventId, now = Date.now()) {
  const protections = activeInterimProtections(guildId, userId, now);
  if (protections.length > 0) {
    return {
      ok: false,
      used: 0,
      limit: 0,
      retryAt: Math.min(...protections.map((entry) => entry.ends_at)),
      reason: 'interim_protection'
    };
  }
  const restrictions = activeRestrictions(guildId, userId, now);
  for (const restriction of restrictions) {
    for (const rule of rules(restriction, 'agent_calls_per_window')) {
      const since = now - rule.windowSeconds * 1000;
      const usage = restrictionUsageWindow(restriction.id, 'agent_call', since);
      if (usage.count >= rule.maximum) {
        return {
          ok: false,
          used: usage.count,
          limit: rule.maximum,
          retryAt: (usage.oldest ?? now) + rule.windowSeconds * 1000
        };
      }
    }
  }
  for (const restriction of restrictions) {
    if (rules(restriction, 'agent_calls_per_window').length > 0) {
      recordRestrictionUsage(restriction.id, 'agent_call', eventId);
    }
  }
  return { ok: true };
}

function blockedMessageReason(message, restriction, now) {
  if (rules(restriction, 'block_links').length > 0 && LINK_RE.test(message.content ?? '')) return 'リンク投稿が制限されています';
  if (rules(restriction, 'block_attachments').length > 0 && message.attachments?.size > 0) return '添付投稿が制限されています';
  if (rules(restriction, 'block_mentions').length > 0
    && ((message.mentions?.users?.size ?? 0) > 0
      || (message.mentions?.roles?.size ?? 0) > 0
      || (message.mentions?.channels?.size ?? 0) > 0
      || message.mentions?.everyone)) {
    return 'メンションが制限されています';
  }
  for (const rule of rules(restriction, 'messages_per_window')) {
    const since = now - rule.windowSeconds * 1000;
    const used = restrictionUsageCount(restriction.id, 'message', since);
    if (used >= rule.maximum) return `${rule.windowSeconds}秒あたり${rule.maximum}件の発言上限です`;
  }
  return null;
}

export async function enforceMessageRestrictions(message) {
  if (!message?.guildId || message.author?.bot) return false;
  const now = Date.now();
  const courtCase = message.channel?.isThread?.() ? getCaseByPublicThread(message.channelId) : null;
  const protections = activeInterimProtections(message.guildId, message.author.id, now);
  if (protections.length > 0) {
    const ownOpenCase = courtCase
      && ['defense', 'appeal'].includes(courtCase.status)
      && courtCase.accused_id === message.author.id
      && protections.some((entry) => entry.case_id === courtCase.id);
    if (!ownOpenCase) {
      const protection = protections[0];
      const reason = '一時保全中は自分の事件投稿だけに発言できます';
      const deleted = await message.delete().then(() => true).catch(() => false);
      writeAudit({
        guildId: message.guildId,
        actorType: 'system',
        action: deleted ? 'interim_protection.message_blocked' : 'interim_protection.enforcement_failed',
        targetType: 'interim_protection',
        targetId: protection.id,
        detail: { caseId: protection.case_id, messageId: message.id, channelId: message.channelId, reason }
      });
      if (deleted) {
        await message.author.send(`${message.guild?.name ?? 'このコミュニティ'}では一時保全中のため、自分の裁判事件でだけ発言できます。制限は自動終了します。`).catch(() => {});
      }
      // 削除権限が壊れていても、この投稿を活動資格・AI・統治受付へ流さない。
      return true;
    }
  }
  // 公開裁判所での当事者の答弁・上訴だけは、別の制裁profileで妨げない。
  // 第三者が事件投稿へ書けば通常の制裁対象となり、裁判所を回避経路にできない。
  if (courtCase
    && ['defense', 'appeal'].includes(courtCase.status)
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
    await message.author.send(`${message.guild?.name ?? 'このコミュニティ'}の制裁 #${restriction.sanction_id} により投稿を削除しました: ${reason}`).catch(() => {});
    return true;
  }
  for (const restriction of restrictions) {
    if (rules(restriction, 'messages_per_window').length > 0) {
      recordRestrictionUsage(restriction.id, 'message', message.id);
    }
  }
  return false;
}

export async function enforceReactionRestrictions(reaction, user) {
  if (!reaction?.message?.guildId || user?.bot) return false;
  if (!hasInterimProtection(reaction.message.guildId, user.id)
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

export async function enforceVoiceRestrictions(_oldState, newState) {
  if (!newState?.guild?.id || !newState.member || !newState.channelId) return false;
  if (!hasInterimProtection(newState.guild.id, newState.member.id)
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

export async function enforceThreadRestrictions(thread) {
  const ownerId = thread?.ownerId;
  if (!thread?.guildId || !ownerId || (!hasInterimProtection(thread.guildId, ownerId)
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
