import { getOperationalSetting } from './db.js';
import { normalizeActivityContent } from './policy.js';

function grams(value: unknown): Set<string> {
  const normalized = normalizeActivityContent(value).replace(/[^\p{L}\p{N}]+/gu, '');
  const result = new Set<string>();
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index + size <= normalized.length; index += 1) {
      result.add(normalized.slice(index, index + size));
    }
  }
  return result;
}

export function contextRelevance(query: unknown, content: unknown): number {
  const left = grams(query);
  const right = grams(content);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

/** 呼びかけの投稿のうち、調査対象の手がかりとして読む項目。 */
export interface InvestigationMessage {
  author: { id: string };
  client: { user?: { id: string } | null };
  mentions?: { users?: { keys?(): Iterable<string> } | null } | null;
}

export interface InvestigationAnchor {
  authorId?: string | null;
  authorIsBot?: boolean;
}

// 席が自分で調べるようになったので、事前に会話を詰め込む必要はない。呼びかけから
// 分かる範囲の手がかり（明示的なmentionと返信先の投稿者）だけを席へ渡す。
export function investigationTargets(message: InvestigationMessage, anchor: InvestigationAnchor | null = null): string[] {
  const explicit = [...(message.mentions?.users?.keys?.() ?? [])]
    .filter((id) => id !== message.author.id && id !== message.client.user?.id);
  if (anchor?.authorId && anchor.authorId !== message.author.id && !anchor.authorIsBot) {
    explicit.unshift(anchor.authorId);
  }
  return [...new Set(explicit)].slice(0, 10);
}

export function investigationContextSettings(guildId: string): { lookbackDays: number; caseLimit: number } {
  return {
    lookbackDays: getOperationalSetting(guildId, 'investigation_lookback_days'),
    caseLimit: getOperationalSetting(guildId, 'investigation_case_limit')
  };
}

export function evidenceLink(guildId: string, row: { channelId: string; messageId: string }): string {
  return `https://discord.com/channels/${guildId}/${row.channelId}/${row.messageId}`;
}
