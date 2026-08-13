import {
  getOperationalSetting,
  recentActorActivity,
  recentConversationActivity,
  recentGuildActivity
} from './db.js';
import { normalizeActivityContent, sha256 } from './policy.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function grams(value) {
  const normalized = normalizeActivityContent(value).replace(/[^\p{L}\p{N}]+/gu, '');
  const result = new Set();
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index + size <= normalized.length; index += 1) {
      result.add(normalized.slice(index, index + size));
    }
  }
  return result;
}

export function contextRelevance(query, content) {
  const left = grams(query);
  const right = grams(content);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

function normalizeRow(row) {
  const content = String(row.content ?? '').slice(0, 1000);
  return {
    messageId: String(row.message_id ?? row.messageId),
    channelId: String(row.channel_id ?? row.channelId),
    parentId: row.parent_id ?? row.parentId ?? null,
    authorId: String(row.user_id ?? row.authorId),
    content,
    contentHash: String(row.content_hash ?? row.contentHash ?? sha256(normalizeActivityContent(content))),
    occurredAt: Number(row.created_at ?? row.occurredAt)
  };
}

function uniqueRows(rows, sourceMessageId) {
  const seen = new Set([String(sourceMessageId)]);
  return rows.filter((row) => {
    if (!row?.messageId || seen.has(String(row.messageId))) return false;
    seen.add(String(row.messageId));
    return true;
  });
}

function targetIds(message, anchor, conversation) {
  const explicit = [...(message.mentions?.users?.keys?.() ?? [])]
    .filter((id) => id !== message.author.id && id !== message.client.user?.id);
  if (anchor?.authorId && anchor.authorId !== message.author.id && !anchor.authorIsBot) {
    explicit.unshift(anchor.authorId);
  }
  if (explicit.length > 0) return [...new Set(explicit)].slice(0, 10);
  const counts = new Map();
  for (const row of conversation) {
    if (row.authorId === message.author.id) continue;
    counts.set(row.authorId, (counts.get(row.authorId) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id);
}

export function investigationContextSettings(guildId) {
  return {
    conversationLimit: getOperationalSetting(guildId, 'investigation_conversation_limit'),
    actorLimit: getOperationalSetting(guildId, 'investigation_actor_limit'),
    guildLimit: getOperationalSetting(guildId, 'investigation_guild_limit'),
    conversationHours: getOperationalSetting(guildId, 'investigation_conversation_hours'),
    lookbackDays: getOperationalSetting(guildId, 'investigation_lookback_days'),
    caseLimit: getOperationalSetting(guildId, 'investigation_case_limit')
  };
}

export function collectInvestigationContext(message, request, anchor = null, now = Date.now()) {
  const settings = investigationContextSettings(message.guildId);
  const conversation = recentConversationActivity(
    message.guildId,
    message.channelId,
    now - settings.conversationHours * HOUR_MS,
    settings.conversationLimit
  ).map(normalizeRow);
  if (anchor && !conversation.some((row) => row.messageId === String(anchor.messageId))) {
    conversation.push(normalizeRow(anchor));
  }
  const actors = targetIds(message, anchor, conversation);
  const perActorLimit = Math.max(1, Math.ceil(settings.actorLimit / Math.max(1, actors.length)));
  const actorRows = actors.flatMap((userId) => recentActorActivity(
    message.guildId,
    userId,
    now - settings.lookbackDays * DAY_MS,
    perActorLimit
  ).map(normalizeRow))
    .sort((left, right) => right.occurredAt - left.occurredAt)
    .slice(0, settings.actorLimit)
    .sort((left, right) => left.occurredAt - right.occurredAt);
  const guildRows = recentGuildActivity(
    message.guildId,
    now - settings.lookbackDays * DAY_MS,
    Math.min(500, Math.max(settings.guildLimit, settings.guildLimit * 2))
  ).map(normalizeRow)
    .sort((left, right) => {
      const difference = contextRelevance(request, right.content) - contextRelevance(request, left.content);
      return difference || right.occurredAt - left.occurredAt;
    })
    .slice(0, settings.guildLimit)
    .sort((left, right) => left.occurredAt - right.occurredAt);
  return {
    settings,
    targetUserIds: actors,
    messages: uniqueRows([...conversation, ...actorRows, ...guildRows], message.id)
  };
}

export function evidenceLink(guildId, row) {
  return `https://discord.com/channels/${guildId}/${row.channelId}/${row.messageId}`;
}
