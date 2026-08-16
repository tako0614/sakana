import { getOperationalSetting } from './db.js';
import { normalizeActivityContent } from './policy.js';

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

// 席が自分で調べるようになったので、事前に会話を詰め込む必要はない。呼びかけから
// 分かる範囲の手がかり（明示的なmentionと返信先の投稿者）だけを席へ渡す。
export function investigationTargets(message, anchor = null) {
  const explicit = [...(message.mentions?.users?.keys?.() ?? [])]
    .filter((id) => id !== message.author.id && id !== message.client.user?.id);
  if (anchor?.authorId && anchor.authorId !== message.author.id && !anchor.authorIsBot) {
    explicit.unshift(anchor.authorId);
  }
  return [...new Set(explicit)].slice(0, 10);
}

export function investigationContextSettings(guildId) {
  return {
    lookbackDays: getOperationalSetting(guildId, 'investigation_lookback_days'),
    caseLimit: getOperationalSetting(guildId, 'investigation_case_limit')
  };
}

export function evidenceLink(guildId, row) {
  return `https://discord.com/channels/${guildId}/${row.channelId}/${row.messageId}`;
}
