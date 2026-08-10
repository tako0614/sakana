import { escapeMarkdown } from 'discord.js';

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function messageLink(row) {
  return `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.message_id}`;
}

export function relativeTime(timestamp) {
  return `<t:${Math.floor(timestamp / 1000)}:R>`;
}

export function shortDate(timestamp) {
  return `<t:${Math.floor(timestamp / 1000)}:d>`;
}

function sanitize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * ヒットした語のまわりを切り出して、その語を太字にする。
 */
export function excerpt(content, terms, maxLength = 180) {
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

export function formatResult(row, index, terms) {
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

export function sparkline(values) {
  const max = Math.max(...values, 1);
  return values
    .map((value) => BLOCKS[Math.min(BLOCKS.length - 1, Math.round((value / max) * (BLOCKS.length - 1)))])
    .join('');
}

export function bar(value, max, width = 12) {
  const filled = Math.round((value / Math.max(max, 1)) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

export function formatRanking(rows, label) {
  if (rows.length === 0) return '該当なし';

  const max = rows[0].count;
  return rows
    .map((row, index) => `\`${String(index + 1).padStart(2)}\` ${label(row)} ${bar(row.count, max, 10)} \`${row.count.toLocaleString()}\``)
    .join('\n');
}

export function formatNumber(value) {
  return Number(value ?? 0).toLocaleString('ja-JP');
}
