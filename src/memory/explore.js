import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle
} from 'discord.js';
import { db as archive } from '../archive/db.js';
import {
  countChildren, episodeTimeline, episodesFor, getEpisode, getNode, linkedPages, listChildren, loadPublicChannels,
  memoryDb, nameOf, parentOf, searchEpisodes, searchNodes, topLevels
} from './store.js';

// /memory explore: 記憶の本を Discord の中でたどる画面。本人にだけ見える。
//
//   ページ   パンくず・説明・本文 ([[リンク]] は太字の名前、[e12] は消してメニューへ)・
//            子ページ (ページ送り)・つながり・最近の出来事
//   出来事   種類・日付・チャンネル・重要度、要約、決め台詞 (原文の引用)、根拠の発言へのリンク
//   年表     そのページに関わる出来事を古い順に10件ずつ
//   探す     入力欄からページと出来事を探す
//
//   共有     📢 で今の画面をチャンネルに出す。出したメッセージのボタンは誰が押しても全員の画面が変わる
//            (一緒にたどる)。🔎 で押した人にだけ同じ画面を開く (ひとりで寄り道する)
//
// 画面の状態はボタン・メニューの ID に数字で持たせる (日本語のパスは ID の上限 100 字を超えうる)。
//   n:<ページ>:<子の何件目から>   e:<出来事>:<開いたページ>   t:<ページ>:<何件目から>   root   s (探す)
//   share:<画面>  mine:<画面>

const PREFIX = 'memx';
const TZ_MS = 9 * 3_600_000;
const CHILDREN_PER_PAGE = 20;
const TIMELINE_PER_PAGE = 10;
const COLOR = '#2b2d31';
const day = (ms) => new Date(ms + TZ_MS).toISOString().slice(0, 10);
const month = (ms) => day(ms).slice(0, 7);
const clip = (text, max) => { const t = String(text ?? ''); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

const KIND_EMOJI = [
  [/レスバ|議論|口論|論争|揉め/, '⚔️'], [/ネタ|名言|迷言|ミーム|ノリ/, '😂'], [/事件|炎上|障害|トラブル/, '🔥'],
  [/決定|ルール/, '✅'], [/告知|お知らせ|リリース/, '📢'], [/技術|開発|実装/, '🛠️'], [/企画|大会|イベント/, '🎪'],
  [/近況|雑談/, '💬']
];
// embed は説明・欄・題・見出し・足元を合わせて 6000 字まで。欄を先に決め、残りを説明に回す
function fitDescription(embed, text, max = 3800) {
  const data = embed.toJSON();
  const used = (data.title?.length ?? 0) + (data.author?.name?.length ?? 0) + (data.footer?.text?.length ?? 0)
    + (data.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  return embed.setDescription(clip(text, Math.max(200, Math.min(max, 5900 - used))));
}

/** 同じ値の選択肢は Discord が拒否するので1つにまとめ、25件で切る。 */
function uniqueOptions(options) {
  const seen = new Set();
  return options.filter((option) => !seen.has(option.value) && seen.add(option.value)).slice(0, 25);
}

const kindEmoji = (kind) => KIND_EMOJI.find(([re]) => re.test(kind ?? ''))?.[1] ?? '📜';
const stars = (n) => '★'.repeat(Math.max(1, Math.min(3, n ?? 2)));

/** 本文を読める形に: [[path]] は太字の名前、[e12] は消す (出来事はメニューで開く)。 */
export function renderText(text) {
  return String(text ?? '')
    .replace(/\[\[([^\]]+)\]\]/g, (_, path) => `**${nameOf(path.trim())}**`)
    .replace(/\s*\[e\d+\]/g, '')
    .replace(/^#{1,2}\s+/gm, '### ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function nodeById(guildId, id) {
  const row = memoryDb().prepare('SELECT path FROM nodes WHERE guild_id = ? AND id = ?').get(guildId, Number(id));
  return row ? getNode(guildId, row.path) : null;
}

const breadcrumb = (path) => ['📖 記憶の本', ...(path ? path.split('/') : [])].join(' › ');

const select = (customId, placeholder, options) => new ActionRowBuilder().addComponents(
  new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(uniqueOptions(options))
);
const button = (customId, label, { disabled = false, style = ButtonStyle.Secondary } = {}) =>
  new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);

/** 本人だけの画面には「みんなに見せる」、共有した画面には「自分で開く」。 */
const shareButton = (target, shared) => shared
  ? button(`${PREFIX}:mine:${target}`, '🔎 自分で開く')
  : button(`${PREFIX}:share:${target}`, '📢 みんなに見せる', { style: ButtonStyle.Success });

const episodeOption = (episode, fromId) => ({
  label: clip(`${kindEmoji(episode.kind)} ${episode.title}`, 100),
  description: clip(`${day(episode.at_ms)}${episode.kind ? ` · ${episode.kind}` : ''} · ${episode.summary ?? ''}`, 100),
  value: `e:${episode.id}:${fromId ?? 0}`
});

function pageCount(guildId, path) {
  const like = `${path.replace(/[%_\\]/g, (c) => `\\${c}`)}/%`;
  return memoryDb().prepare("SELECT COUNT(*) AS c FROM nodes WHERE guild_id = ? AND path LIKE ? ESCAPE '\\'").get(guildId, like).c;
}

export function pageView(guildId, node, { offset = 0, shared = false } = {}) {
  const isRoot = !node.path;
  const lines = [];
  if (node.summary && !isRoot) lines.push(`*${node.summary}*`, '');
  if (node.body) {
    lines.push(renderText(node.body));
  } else if (node.pending) {
    // まだ本文に書き直していないページは、溜まった知識を短く見せる
    const facts = node.pending.trim().split('\n').map((line) => renderText(line.replace(/^-\s*/, ''))).filter(Boolean);
    lines.push('📝 まとめ中 (次の統合で本文になります)', ...facts.slice(0, 8).map((fact) => `・${clip(fact, 160)}`));
    if (facts.length > 8) lines.push(`…ほか ${facts.length - 8} 件`);
  } else if (isRoot) {
    lines.push('まだ概要はありません。読み込みが進むと書かれます。下の分類から開けます。');
  } else {
    lines.push('まだ本文がありません。下のメニューから子ページを開けます。');
  }
  if (node.aliases?.length) lines.push('', `-# 別名: ${node.aliases.join(', ')}`);

  const embed = new EmbedBuilder().setColor(COLOR)
    .setAuthor({ name: clip(breadcrumb(node.path), 250) })
    .setTitle(clip(isRoot ? '記憶の本' : nameOf(node.path), 250));

  const totalChildren = countChildren(guildId, node.path);
  const children = listChildren(guildId, node.path, offset + CHILDREN_PER_PAGE).slice(offset);
  if (isRoot) {
    // 説明が長いと 1024 字で後ろの分類が切れるので短く
    const tops = topLevels(guildId).map((path) => `📁 **${path}** (${pageCount(guildId, path)}) ${clip(getNode(guildId, path)?.summary ?? '', 36)}`);
    if (tops.length) embed.addFields({ name: '分類', value: clip(tops.join('\n'), 1024) });
  } else if (totalChildren) {
    embed.addFields({ name: `子ページ (${totalChildren})`, value: clip(children.slice(0, 12).map((child) => nameOf(child.path)).join(' · '), 1024), inline: false });
  }
  const links = isRoot ? [] : linkedPages(guildId, node.path, 6);
  if (links.length) embed.addFields({ name: 'つながり', value: clip(links.map((link) => `**${nameOf(link.path)}**`).join(' · '), 1024) });
  const episodes = isRoot ? [] : episodesFor(guildId, node.path, 25);
  if (episodes.length) {
    const recent = [...episodes].sort((a, b) => b.at_ms - a.at_ms).slice(0, 3)
      .map((episode) => `${kindEmoji(episode.kind)} ${day(episode.at_ms)} ${episode.title}`);
    embed.addFields({ name: `最近の出来事 (${episodeTimeline(guildId, node.path, { limit: 0 }).total})`, value: clip(recent.join('\n'), 1024) });
  }
  // 本文はあるが、まだ本文に入っていない知識がある (本文は長いので末尾に書くと切れる。足元に出す)
  const waiting = node.body && node.pending ? node.pending.split('\n').filter(Boolean).length : 0;
  const footer = [node.first_at ? `期間 ${month(node.first_at)}〜${month(node.last_at ?? node.first_at)}` : null,
    node.updated_at ? `更新 ${day(node.updated_at)}` : null,
    waiting ? `📝 本文に入る前の知識 ${waiting} 件` : null].filter(Boolean).join(' · ');
  if (footer) embed.setFooter({ text: footer });
  fitDescription(embed, lines.join('\n'));

  const components = [];
  const pageOptions = [];
  const seen = new Set();
  for (const child of children) {
    const target = getNode(guildId, child.path);
    if (!target || seen.has(target.id)) continue;
    seen.add(target.id);
    pageOptions.push({ label: clip(`📁 ${nameOf(child.path)}`, 100), description: clip(child.summary || `${child.children} 子ページ`, 100), value: `n:${target.id}` });
  }
  for (const link of links) {
    const target = getNode(guildId, link.path);
    if (!target || seen.has(target.id) || pageOptions.length >= 25) continue;
    seen.add(target.id);
    pageOptions.push({ label: clip(`🔗 ${nameOf(link.path)}`, 100), description: clip(link.summary || link.path, 100), value: `n:${target.id}` });
  }
  // 1つのメッセージの中で部品の ID は重複できない (Discord が拒否する)
  if (pageOptions.length) components.push(select(`${PREFIX}:open:pages`, isRoot ? '📁 分類を開く' : '📁 子ページ / 🔗 つながりを開く', pageOptions));
  if (episodes.length) components.push(select(`${PREFIX}:open:episodes`, '📜 関わった出来事を開く', episodes.map((episode) => episodeOption(episode, node.id))));

  const parent = node.path ? getNode(guildId, parentOf(node.path)) : null;
  const nav = [
    button(parent ? `${PREFIX}:n:${parent.id}` : `${PREFIX}:noop:up`, '↑ 親', { disabled: !parent }),
    button(`${PREFIX}:root`, '🏠 根')
  ];
  if (totalChildren > CHILDREN_PER_PAGE) {
    nav.push(button(`${PREFIX}:n:${node.id}:${Math.max(0, offset - CHILDREN_PER_PAGE)}`, '◀ 前', { disabled: offset === 0 }));
    nav.push(button(`${PREFIX}:n:${node.id}:${offset + CHILDREN_PER_PAGE}`, `次 ▶ (${offset + 1}〜${Math.min(totalChildren, offset + CHILDREN_PER_PAGE)}/${totalChildren})`,
      { disabled: offset + CHILDREN_PER_PAGE >= totalChildren }));
  }
  components.push(new ActionRowBuilder().addComponents(nav));
  const tools = [button(`${PREFIX}:s`, '🔍 探す', { style: ButtonStyle.Primary })];
  if (episodes.length) tools.push(button(`${PREFIX}:t:${node.id}:0`, '🕒 年表'));
  tools.push(shareButton(isRoot ? 'root' : `n:${node.id}:${offset}`, shared));
  components.push(new ActionRowBuilder().addComponents(tools));
  return { content: '', embeds: [embed], components };
}

export function episodeView(guildId, id, { fromId = 0, shared = false } = {}) {
  const episode = getEpisode(guildId, id);
  const back = fromId ? nodeById(guildId, fromId) : null;
  const navRow = () => new ActionRowBuilder().addComponents([
    ...(back ? [button(`${PREFIX}:n:${back.id}`, clip(`← ${nameOf(back.path) || '根'}`, 80))] : []),
    button(`${PREFIX}:root`, '🏠 根'),
    button(`${PREFIX}:s`, '🔍 探す', { style: ButtonStyle.Primary }),
    ...(episode ? [shareButton(`e:${id}:${fromId}`, shared)] : [])
  ]);
  if (!episode) return { content: `出来事 e${id} はありません。`, embeds: [], components: [navRow()] };

  const channel = archive.prepare('SELECT name FROM channels WHERE channel_id = ?').get(episode.channel_id);
  const open = new Set(loadPublicChannels(guildId)?.channelIds ?? []);
  const ids = [...new Set([...(episode.highlights ?? []), ...episode.sources])].slice(0, 12);
  const rows = ids.length ? archive.prepare(`
    SELECT message_id, channel_id, author_name, content, created_at FROM messages
    WHERE message_id IN (${ids.map(() => '?').join(',')}) AND deleted = 0 ORDER BY created_at
  `).all(...ids).filter((row) => open.has(row.channel_id)) : [];
  const link = (row) => `https://discord.com/channels/${guildId}/${row.channel_id}/${row.message_id}`;
  const highlighted = new Set(episode.highlights ?? []);
  const quotes = rows.filter((row) => highlighted.has(row.message_id));
  const evidence = rows.filter((row) => !highlighted.has(row.message_id));
  const lines = [renderText(episode.summary)];
  if (quotes.length) {
    lines.push('', ...quotes.map((row) => `> 「${clip(row.content.replace(/\s*\n\s*/g, ' / '), 200)}」\n> — ${row.author_name} [↗](${link(row)})`));
  }
  if (evidence.length) {
    lines.push('', '**根拠の発言**', ...evidence.map((row) =>
      `[${new Date(row.created_at + TZ_MS).toISOString().slice(5, 16).replace('T', ' ')}](${link(row)}) ${row.author_name}: ${clip(row.content.replace(/\s*\n\s*/g, ' / '), 120)}`));
  }
  if (!rows.length) lines.push('', '-# 根拠の発言は消されたか、読めないチャンネルになりました');

  const embed = new EmbedBuilder().setColor(COLOR)
    .setAuthor({ name: clip(`${day(episode.at_ms)} · #${channel?.name ?? episode.channel_id}${episode.kind ? ` · ${episode.kind}` : ''} · ${stars(episode.importance)}`, 250) })
    .setTitle(clip(`${kindEmoji(episode.kind)} ${episode.title}`, 250));
  if (episode.nodes.length) embed.addFields({ name: '関わり', value: clip(episode.nodes.map((path) => `**${nameOf(path)}**`).join(' · '), 1024) });
  const around = [...episode.before.map((item) => `⬅ ${day(item.at_ms)} ${item.title}`), ...episode.after.map((item) => `➡ ${day(item.at_ms)} ${item.title}`)];
  if (around.length) embed.addFields({ name: '前後の出来事', value: clip(around.join('\n'), 1024) });
  embed.setFooter({ text: `e${episode.id}` });
  fitDescription(embed, lines.join('\n'));

  const options = [];
  for (const path of episode.nodes) {
    const node = getNode(guildId, path);
    if (node && options.length < 25) options.push({ label: clip(`📁 ${nameOf(path)}`, 100), description: clip(node.summary || path, 100), value: `n:${node.id}` });
  }
  for (const [mark, list] of [['⬅', episode.before], ['➡', episode.after]]) {
    for (const item of list) {
      if (options.length < 25) options.push({ label: clip(`${mark} ${item.title}`, 100), description: day(item.at_ms), value: `e:${item.id}:${fromId}` });
    }
  }
  const components = options.length ? [select(`${PREFIX}:open:related`, '関わったページ・前後の出来事を開く', options)] : [];
  components.push(navRow());
  return { content: '', embeds: [embed], components };
}

export function timelineView(guildId, node, { offset = 0, shared = false } = {}) {
  const { total, rows } = episodeTimeline(guildId, node.path, { offset, limit: TIMELINE_PER_PAGE });
  const embed = new EmbedBuilder().setColor(COLOR)
    .setAuthor({ name: clip(breadcrumb(node.path), 250) })
    .setTitle(clip(`🕒 ${nameOf(node.path) || '記憶の本'} の年表`, 250))
    .setDescription(rows.length
      ? clip(rows.map((episode) => `${kindEmoji(episode.kind)} **${day(episode.at_ms)}** ${episode.title}\n-# ${clip(renderText(episode.summary), 110)}`).join('\n'), 3800)
      : 'まだ出来事がありません。')
    .setFooter({ text: `${total ? `${offset + 1}〜${offset + rows.length} / ${total} 件` : '0 件'} · 古い順` });
  const components = [];
  if (rows.length) components.push(select(`${PREFIX}:open:timeline`, '📜 出来事を開く', rows.map((episode) => episodeOption(episode, node.id))));
  components.push(new ActionRowBuilder().addComponents(
    button(`${PREFIX}:n:${node.id}`, clip(`← ${nameOf(node.path) || '根'}`, 80)),
    button(`${PREFIX}:t:${node.id}:${Math.max(0, offset - TIMELINE_PER_PAGE)}`, '◀ 前', { disabled: offset === 0 }),
    button(`${PREFIX}:t:${node.id}:${offset + TIMELINE_PER_PAGE}`, '次 ▶', { disabled: offset + TIMELINE_PER_PAGE >= total }),
    button(`${PREFIX}:root`, '🏠 根'),
    shareButton(`t:${node.id}:${offset}`, shared)
  ));
  return { content: '', embeds: [embed], components };
}

export function searchView(guildId, query) {
  const pages = searchNodes(guildId, query, 10);
  const episodes = searchEpisodes(guildId, query, 10);
  const lines = [];
  if (pages.length) lines.push('**ページ**', ...pages.map((row) => `📁 **${row.path}** ${row.summary ?? ''}`));
  if (episodes.length) lines.push('', '**出来事**', ...episodes.map((row) => `${kindEmoji(row.kind)} ${day(row.at_ms)} ${row.title}`));
  const embed = new EmbedBuilder().setColor(COLOR)
    .setAuthor({ name: '📖 記憶の本 › 探す' })
    .setTitle(clip(`🔍 「${query}」`, 250))
    .setDescription(lines.length ? clip(lines.join('\n'), 3800) : '見つかりませんでした。別の言い方で探すか、原文は /search で。');
  const options = [];
  for (const row of pages) {
    const node = getNode(guildId, row.path);
    if (node) options.push({ label: clip(`📁 ${nameOf(row.path)}`, 100), description: clip(row.summary || row.path, 100), value: `n:${node.id}` });
  }
  for (const row of episodes) if (options.length < 25) options.push(episodeOption(row, 0));
  const components = [];
  if (options.length) components.push(select(`${PREFIX}:open:search`, '開く', options));
  components.push(new ActionRowBuilder().addComponents(
    button(`${PREFIX}:s`, '🔍 もう一度探す', { style: ButtonStyle.Primary }),
    button(`${PREFIX}:root`, '🏠 根')
  ));
  return { content: '', embeds: [embed], components };
}

export function rootView(guildId, { shared = false } = {}) {
  const root = getNode(guildId, '');
  return root ? pageView(guildId, root, { shared }) : { content: '記憶の本はまだできていません。', embeds: [], components: [] };
}

/** `root` / `n:12[:offset]` / `e:34[:from]` / `t:12[:offset]` を画面にする。shared は共有したメッセージの中か。 */
export function viewFor(guildId, target, { shared = false } = {}) {
  if (target === 'root') return rootView(guildId, { shared });
  const [kind, id, extra] = String(target).split(':');
  if (kind === 'e') return episodeView(guildId, Number(id), { fromId: Number(extra) || 0, shared });
  const node = nodeById(guildId, id);
  if (!node) return rootView(guildId, { shared });
  if (kind === 't') return timelineView(guildId, node, { offset: Number(extra) || 0, shared });
  return pageView(guildId, node, { offset: Number(extra) || 0, shared });
}

/**
 * NSFW チャンネルの出来事 (原文の引用が載る) は NSFW のチャンネルにだけ共有する。
 * ページの本文は出どころが混ざるので見分けない (本人だけの画面と同じく誰でも開ける)。
 */
function shareRefusal(interaction, target) {
  const [kind, id] = String(target).split(':');
  if (kind !== 'e') return null;
  const episode = getEpisode(interaction.guildId, Number(id));
  const source = episode && interaction.guild?.channels?.cache?.get(episode.channel_id);
  if (source?.nsfw && !interaction.channel?.nsfw) return 'NSFW チャンネルの出来事は、NSFW のチャンネルでだけ共有できます。';
  return null;
}

const sharedIn = (interaction) => Boolean(interaction.message) && !interaction.message.flags?.has?.(MessageFlags.Ephemeral);

function searchModal() {
  return new ModalBuilder().setCustomId(`${PREFIX}:q`).setTitle('記憶の本を探す').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel('探す語 (人・作ったもの・ネタ・レスバなど)')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100))
  );
}

export async function handleMemoryComponent(interaction) {
  const customId = interaction.customId ?? '';
  if (!customId.startsWith(`${PREFIX}:`)) return false;
  const [, action, ...rest] = customId.split(':');
  const shared = sharedIn(interaction);
  // 共有したメッセージは書き換えても「誰が共有したか」の一行を残す
  const keep = (view) => (shared ? { ...view, content: interaction.message.content ?? '' } : view);
  try {
    if (action === 'noop') { await interaction.deferUpdate(); return true; }
    // 探す: ボタンで入力欄を出し、送られたら結果の画面に差し替える
    if (action === 's') { await interaction.showModal(searchModal()); return true; }
    if (action === 'q' && interaction.isModalSubmit?.()) {
      await interaction.update(keep(searchView(interaction.guildId, interaction.fields.getTextInputValue('query').trim())));
      return true;
    }
    if (action === 'share') {
      const target = rest.join(':') || 'root';
      const refusal = shareRefusal(interaction, target);
      if (refusal) { await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral }); return true; }
      await interaction.reply({
        ...viewFor(interaction.guildId, target, { shared: true }),
        content: `-# 📖 ${interaction.user} が記憶の本を共有しました · ボタンは誰でも操作できます (全員の画面が変わります)`,
        allowedMentions: { parse: [] }
      });
      return true;
    }
    if (action === 'mine') {
      await interaction.reply({ ...viewFor(interaction.guildId, rest.join(':') || 'root'), flags: MessageFlags.Ephemeral });
      return true;
    }
    const target = interaction.isStringSelectMenu?.() ? interaction.values[0]
      : action === 'root' ? 'root' : [action, ...rest].join(':');
    await interaction.update(keep(viewFor(interaction.guildId, target, { shared })));
  } catch (error) {
    console.error('memory explore failed:', error);
    await interaction.reply({ content: `開けませんでした: ${clip(error.message, 150)}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  return true;
}
