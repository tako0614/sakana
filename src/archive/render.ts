import { escapeMarkdown } from 'discord.js';
import type { MessageRow } from './types.js';

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function messageLink(row: Pick<MessageRow, 'guild_id' | 'channel_id' | 'message_id'>): string {
  return `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.message_id}`;
}

export function relativeTime(timestamp: number): string {
  return `<t:${Math.floor(timestamp / 1000)}:R>`;
}

export function shortDate(timestamp: number): string {
  return `<t:${Math.floor(timestamp / 1000)}:d>`;
}

function sanitize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * ヒットした語のまわりを切り出して、その語を太字にする。
 */
export function excerpt(content: string, terms: readonly string[], maxLength = 180): string {
  const flat = sanitize(content);
  if (!flat) return '*(本文なし)*';

  let start = 0;
  const lower = flat.toLowerCase();

  for (const term of terms) {
    if (!term) continue;
    const at = lower.indexOf(term.toLowerCase());
    if (at >= 0) {
      start = Math.max(0, at - Math.floor(maxLength / 3));
      break;
    }
  }

  let slice = flat.slice(start, start + maxLength);
  if (start > 0) slice = `…${slice}`;
  if (start + maxLength < flat.length) slice = `${slice}…`;

  let escaped = escapeMarkdown(slice);

  for (const term of terms) {
    if (!term || Array.from(term).length < 1) continue;
    const escapedTerm = escapeMarkdown(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    escaped = escaped.replace(new RegExp(escapedTerm, 'gi'), (match) => `**${match}**`);
  }

  return escaped;
}

export type ResultRow = Pick<
  MessageRow,
  'guild_id' | 'channel_id' | 'message_id' | 'author_id' | 'created_at' | 'reaction_count' | 'deleted' | 'edited_at' | 'content' | 'extra'
>;

export function formatResult(row: ResultRow, index: number, terms: readonly string[]): string {
  const meta = [
    `<@${row.author_id}>`,
    `<#${row.channel_id}>`,
    relativeTime(row.created_at)
  ];

  if (row.reaction_count > 0) meta.push(`⭐${row.reaction_count}`);
  if (row.deleted) meta.push('🗑️削除済み');
  if (row.edited_at) meta.push('✏️');

  return [
    `**${index}.** ${meta.join(' ・ ')} ・ [跳ぶ](${messageLink(row)})`,
    `> ${excerpt(row.content || row.extra, terms)}`
  ].join('\n');
}

export function sparkline(values: readonly number[]): string {
  const max = Math.max(...values, 1);
  return values
    .map((value) => BLOCKS[Math.min(BLOCKS.length - 1, Math.round((value / max) * (BLOCKS.length - 1)))] ?? '')
    .join('');
}

export function bar(value: number, max: number, width = 12): string {
  const filled = Math.round((value / Math.max(max, 1)) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

export function formatRanking<Row extends { count: number }>(rows: readonly Row[], label: (row: Row) => string): string {
  const first = rows[0];
  if (!first) return '該当なし';

  const max = first.count;
  return rows
    .map((row, index) => `\`${String(index + 1).padStart(2)}\` ${label(row)} ${bar(row.count, max, 10)} \`${row.count.toLocaleString()}\``)
    .join('\n');
}

export function formatNumber(value: number | bigint | string | null | undefined): string {
  return Number(value ?? 0).toLocaleString('ja-JP');
}
