import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder } from 'discord.js';
import { db as archive } from '../archive/db.js';
import {
  episodesFor, getEpisode, getNode, linkedPages, listChildren, loadPublicChannels, memoryDb, nameOf, parentOf
} from './store.js';

// /memory explore: 記憶の本を Discord の中でたどる画面。本人にだけ見える。
// ページ → 子・つながったページ・関わった出来事、出来事 → 関わったページ・前後の出来事・根拠の発言。
// メニューの値はページ・出来事の番号 (日本語のパスは Discord の値の上限 100 字を超えうる)。

const PREFIX = 'memx';
const TZ_MS = 9 * 3_600_000;
const day = (ms) => new Date(ms + TZ_MS).toISOString().slice(0, 10);
const clip = (text, max) => { const t = String(text ?? ''); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

function nodeById(guildId, id) {
  const row = memoryDb().prepare('SELECT path FROM nodes WHERE guild_id = ? AND id = ?').get(guildId, Number(id));
  return row ? getNode(guildId, row.path) : null;
}

function pageOptions(guildId, node) {
  const seen = new Set();
  const options = [];
  const push = (path, summary, prefix) => {
    if (seen.has(path) || options.length >= 25) return;
    const target = getNode(guildId, path);
    if (!target) return;
    seen.add(path);
    options.push({ label: clip(`${prefix}${path ? nameOf(path) : '(根)'}`, 100), description: clip(summary || path, 100), value: `n:${target.id}` });
  };
  for (const child of listChildren(guildId, node.path, 20)) push(child.path, child.summary, '📁 ');
  if (node.path) for (const link of linkedPages(guildId, node.path, 8)) push(link.path, link.summary, '🔗 ');
  return options;
}

const select = (customId, placeholder, options) => new ActionRowBuilder().addComponents(
  new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(options)
);

function navigation(guildId, node) {
  const parent = node?.path ? getNode(guildId, parentOf(node.path)) : null;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(parent ? `${PREFIX}:n:${parent.id}` : `${PREFIX}:noop`).setLabel('↑ 親')
      .setStyle(ButtonStyle.Secondary).setDisabled(!parent),
    new ButtonBuilder().setCustomId(`${PREFIX}:root`).setLabel('根').setStyle(ButtonStyle.Secondary)
  );
}

export function pageView(guildId, node) {
  const lines = [];
  if (node.aliases?.length) lines.push(`別名: ${node.aliases.join(', ')}`);
  if (node.body) lines.push(node.body);
  if (node.pending) lines.push('', '**まだ本文に統合していない新しい知識**', node.pending.trim().split('\n').slice(0, 10).join('\n'));
  if (!node.body && !node.pending) lines.push('(まだ本文がありません。下のメニューから子ページを開けます)');
  const embed = new EmbedBuilder().setColor('#2b2d31')
    .setTitle(clip(`📖 ${node.path || '記憶の本 (根)'}`, 250))
    .setDescription(clip(lines.join('\n'), 4000));
  if (node.summary) embed.setAuthor({ name: clip(node.summary, 250) });
  if (node.first_at) embed.setFooter({ text: `期間 ${day(node.first_at).slice(0, 7)}〜${day(node.last_at ?? node.first_at).slice(0, 7)}` });

  const components = [];
  const pages = pageOptions(guildId, node);
  // 1つのメッセージの中で部品の ID は重複できない (Discord が拒否する)
  if (pages.length) components.push(select(`${PREFIX}:open:pages`, '📁 子ページ / 🔗 つながりを開く', pages));
  const episodes = node.path ? episodesFor(guildId, node.path, 25) : [];
  if (episodes.length) {
    components.push(select(`${PREFIX}:open:episodes`, '📜 関わった出来事を開く', episodes.map((episode) => ({
      label: clip(`e${episode.id} ${episode.title}`, 100), description: clip(`${day(episode.at_ms)} ${episode.summary}`, 100), value: `e:${episode.id}`
    }))));
  }
  components.push(navigation(guildId, node));
  return { content: '', embeds: [embed], components };
}

export function episodeView(guildId, id) {
  const episode = getEpisode(guildId, id);
  if (!episode) return { content: `出来事 e${id} はありません。`, embeds: [], components: [navigation(guildId, null)] };
  const channel = archive.prepare('SELECT name FROM channels WHERE channel_id = ?').get(episode.channel_id);
  const open = new Set(loadPublicChannels(guildId)?.channelIds ?? []);
  const ids = episode.sources.slice(0, 10);
  const sources = ids.length ? archive.prepare(`
    SELECT message_id, channel_id, author_name, content, created_at FROM messages
    WHERE message_id IN (${ids.map(() => '?').join(',')}) AND deleted = 0 ORDER BY created_at
  `).all(...ids).filter((row) => open.has(row.channel_id)) : [];
  const lines = [
    episode.summary,
    '',
    ...(sources.length ? ['**根拠の発言**', ...sources.map((row) =>
      `[${new Date(row.created_at + TZ_MS).toISOString().slice(5, 16).replace('T', ' ')}](https://discord.com/channels/${guildId}/${row.channel_id}/${row.message_id}) ${row.author_name}: ${clip(row.content.replace(/\s*\n\s*/g, ' / '), 160)}`)]
      : ['根拠の発言: (消されたか、読めないチャンネルになりました)'])
  ];
  const embed = new EmbedBuilder().setColor('#2b2d31')
    .setTitle(clip(`📜 e${episode.id} ${episode.title}`, 250))
    .setAuthor({ name: `${day(episode.at_ms)} #${channel?.name ?? episode.channel_id}` })
    .setDescription(clip(lines.join('\n'), 4000));

  const options = [];
  for (const path of episode.nodes) {
    const node = getNode(guildId, path);
    if (node && options.length < 25) options.push({ label: clip(`📁 ${path}`, 100), description: clip(node.summary || path, 100), value: `n:${node.id}` });
  }
  for (const [mark, list] of [['⬅ 前', episode.before], ['➡ 後', episode.after]]) {
    for (const item of list) {
      if (options.length < 25) options.push({ label: clip(`${mark} e${item.id} ${item.title}`, 100), description: day(item.at_ms), value: `e:${item.id}` });
    }
  }
  const components = options.length ? [select(`${PREFIX}:open:related`, '関わったページ・前後の出来事を開く', options)] : [];
  components.push(navigation(guildId, null));
  return { content: '', embeds: [embed], components };
}

export function rootView(guildId) {
  const root = getNode(guildId, '');
  return root ? pageView(guildId, root) : { content: '記憶の本はまだできていません。', embeds: [], components: [] };
}

/** `n:12` / `e:34` / `root` を画面にする。 */
export function viewFor(guildId, target) {
  if (target === 'root') return rootView(guildId);
  const [kind, id] = String(target).split(':');
  if (kind === 'e') return episodeView(guildId, Number(id));
  const node = nodeById(guildId, id);
  return node ? pageView(guildId, node) : rootView(guildId);
}

export async function handleMemoryComponent(interaction) {
  const customId = interaction.customId ?? '';
  if (!customId.startsWith(`${PREFIX}:`)) return false;
  const [, action, arg] = customId.split(':');
  if (action === 'noop') { await interaction.deferUpdate(); return true; }
  const target = interaction.isStringSelectMenu?.() ? interaction.values[0]
    : action === 'root' ? 'root' : `${action}:${arg}`;
  try {
    await interaction.update(viewFor(interaction.guildId, target));
  } catch (error) {
    console.error('memory explore failed:', error);
    await interaction.reply({ content: `開けませんでした: ${clip(error.message, 150)}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  return true;
}
