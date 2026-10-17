import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle,
  type APISelectMenuOption, type BaseInteraction, type InteractionReplyOptions, type ButtonInteraction, type Guild, type GuildBasedChannel, type ModalSubmitInteraction,
  type StringSelectMenuInteraction
} from 'discord.js';
import { db as archive } from '../archive/db.js';
import { canRead } from '../archive/permissions.js';
import {
  countChildren, episodeTimeline, episodesFor, getEpisode, getNode, linkedPages, listChildren, loadPublicChannels,
  memoryDb, nameOf, parentOf, searchEpisodes, searchNodes, topLevels, type MemoryNode
} from './store.js';
import { replyWithSiteLink, siteConfigFor, type SiteTarget } from './site.js';
import { errorCode, errorMessage, type QuoteFilter } from './types.js';

// /memory explore: 記憶を Discord の中でたどる画面。本人にだけ見える。
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
// 原文 (決め台詞・根拠の発言の本文とリンク) は、そのチャンネルを見られる人にだけ出す。/memory include で
// ロールの要るチャンネルも記憶に入る (要約とページは誰にでも出す) ので、本人だけの画面は見ている人の
// 権限で、共有した画面は「今のチャンネル」か @everyone が読めるチャンネルのものだけに絞る。
//
// 画面の状態はボタン・メニューの ID に数字で持たせる (日本語のパスは ID の上限 100 字を超えうる)。
//   n:<ページ>:<子の何件目から>   e:<出来事>:<開いたページ>   t:<ページ>:<何件目から>   root   s (探す)
//   share:<画面>  mine:<画面>
// ID は Discord から返ってくる値なので信用しない。サーバーはいつも interaction の guildId で絞り、
// 数は 0 以上の整数に丸める。

const PREFIX = 'memx';
const TZ_MS = 9 * 3_600_000;
const CHILDREN_PER_PAGE = 20;
const TIMELINE_PER_PAGE = 10;
const COLOR = '#2b2d31';
const HIDDEN_NOTE = '-# 見られないチャンネルの発言は省きました';
const day = (ms: number): string => new Date(ms + TZ_MS).toISOString().slice(0, 10);
const month = (ms: number): string => day(ms).slice(0, 7);
const clip = (text: unknown, max: number): string => { const t = String(text ?? ''); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
// ID の数。数でない・負のものは 0。何件目から (offset) は LIMIT に渡すので上限で止める
// (作り替えた ID で子ページを全部読ませない)
const MAX_OFFSET = 100_000;
const idOf = (value: unknown): number => { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
const offsetOf = (value: unknown): number => Math.min(idOf(value), MAX_OFFSET);

type MenuRow = ActionRowBuilder<StringSelectMenuBuilder>;
type ButtonRow = ActionRowBuilder<ButtonBuilder>;

/** 1つの画面 (メッセージの中身)。 */
export interface MemoryView {
  content: string;
  embeds: EmbedBuilder[];
  components: (MenuRow | ButtonRow)[];
}

interface MenuOption {
  label: string;
  description: string;
  value: string;
}

const KIND_EMOJI: ReadonlyArray<readonly [RegExp, string]> = [
  [/レスバ|議論|口論|論争|揉め/, '⚔️'], [/ネタ|名言|迷言|ミーム|ノリ/, '😂'], [/事件|炎上|障害|トラブル/, '🔥'],
  [/決定|ルール/, '✅'], [/告知|お知らせ|リリース/, '📢'], [/技術|開発|実装/, '🛠️'], [/企画|大会|イベント/, '🎪'],
  [/近況|雑談/, '💬']
];
// embed は説明・欄・題・見出し・足元を合わせて 6000 字まで。欄を先に決め、残りを説明に回す
function fitDescription(embed: EmbedBuilder, text: string, max = 3800): EmbedBuilder {
  const data = embed.toJSON();
  const used = (data.title?.length ?? 0) + (data.author?.name?.length ?? 0) + (data.footer?.text?.length ?? 0)
    + (data.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  return embed.setDescription(clip(text, Math.max(200, Math.min(max, 5900 - used))));
}

/** 同じ値の選択肢は Discord が拒否するので1つにまとめ、25件で切る。 */
function uniqueOptions(options: MenuOption[]): MenuOption[] {
  const seen = new Set<string>();
  return options.filter((option) => !seen.has(option.value) && seen.add(option.value)).slice(0, 25);
}

const kindEmoji = (kind: string | null | undefined): string => KIND_EMOJI.find(([re]) => re.test(kind ?? ''))?.[1] ?? '📜';
const stars = (n: number | null | undefined): string => '★'.repeat(Math.max(1, Math.min(3, n ?? 2)));

/** 本文を読める形に: [[path]] は太字の名前、[e12] は消す (出来事はメニューで開く)。 */
export function renderText(text: unknown): string {
  return String(text ?? '')
    .replace(/\[\[([^\]]+)\]\]/g, (_, path: string) => `**${nameOf(path.trim())}**`)
    .replace(/\s*\[e\d+\]/g, '')
    .replace(/^#{1,2}\s+/gm, '### ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function nodeById(guildId: string, id: unknown): MemoryNode | null {
  const row = memoryDb().prepare<[string, number], { path: string }>('SELECT path FROM nodes WHERE guild_id = ? AND id = ?').get(guildId, Number(id));
  return row ? getNode(guildId, row.path) : null;
}

const breadcrumb = (path: string): string => ['📖 記憶', ...(path ? path.split('/') : [])].join(' › ');

const select = (customId: string, placeholder: string, options: MenuOption[]): MenuRow => new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
  new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(uniqueOptions(options))
);
const button = (customId: string, label: string, { disabled = false, style = ButtonStyle.Secondary }: { disabled?: boolean; style?: ButtonStyle } = {}): ButtonBuilder =>
  new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
const buttonRow = (...buttons: ButtonBuilder[]): ButtonRow => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

/**
 * 「サイトで開く」ボタン。押した人にだけ、サイトへのリンクを返す (共有した画面を、リンクで埋めない)。
 * サイトの設定が無い・別のサーバーなら null (ボタンを出さない)。target は画面と同じ表し方 (root / n:<ページ> / e:<出来事>)。
 */
function siteButton(guildId: string, target: string): ButtonBuilder | null {
  return siteConfigFor(guildId) ? button(`${PREFIX}:site:${target}`, '🌐 サイトで開く') : null;
}

/** 画面の target を、サイトの行き先にする。存在しなければ null。 */
function siteTargetFor(guildId: string, target: string): { target: SiteTarget; label: string } | null {
  const [kind, rawId] = target.split(':');
  if (target === 'root') return { target: { kind: 'home' }, label: '記憶' };
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id < 0) return null;
  if (kind === 'n') {
    const node = nodeById(guildId, id);
    return node ? { target: node.path ? { kind: 'page', path: node.path } : { kind: 'home' }, label: node.path || '記憶' } : null;
  }
  if (kind === 'e') {
    const episode = getEpisode(guildId, id);
    return episode ? { target: { kind: 'episode', id }, label: `出来事 e${id}: ${episode.title}` } : null;
  }
  return null;
}

/** 本人だけの画面には「みんなに見せる」、共有した画面には「自分で開く」。 */
const shareButton = (target: string, shared: boolean): ButtonBuilder => shared
  ? button(`${PREFIX}:mine:${target}`, '🔎 自分で開く')
  : button(`${PREFIX}:share:${target}`, '📢 みんなに見せる', { style: ButtonStyle.Success });

const episodeOption = (episode: { id: number; kind: string; title: string; summary?: string; at_ms: number }, fromId: number | null | undefined): MenuOption => ({
  label: clip(`${kindEmoji(episode.kind)} ${episode.title}`, 100),
  description: clip(`${day(episode.at_ms)}${episode.kind ? ` · ${episode.kind}` : ''} · ${episode.summary ?? ''}`, 100),
  value: `e:${episode.id}:${fromId ?? 0}`
});

function pageCount(guildId: string, path: string): number {
  const like = `${path.replace(/[%_\\]/g, (c) => `\\${c}`)}/%`;
  return memoryDb().prepare<[string, string], { c: number }>("SELECT COUNT(*) AS c FROM nodes WHERE guild_id = ? AND path LIKE ? ESCAPE '\\'").get(guildId, like)?.c ?? 0;
}

export function pageView(guildId: string, node: MemoryNode, { offset = 0, shared = false }: { offset?: number; shared?: boolean } = {}): MemoryView {
  const isRoot = !node.path;
  const lines: string[] = [];
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
    .setTitle(clip(isRoot ? '記憶' : nameOf(node.path), 250));

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

  const components: (MenuRow | ButtonRow)[] = [];
  const pageOptions: MenuOption[] = [];
  const seen = new Set<number>();
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

  const parentPath = node.path ? parentOf(node.path) : null;
  const parent = parentPath !== null ? getNode(guildId, parentPath) : null;
  const nav = [
    button(parent ? `${PREFIX}:n:${parent.id}` : `${PREFIX}:noop:up`, '↑ 親', { disabled: !parent }),
    button(`${PREFIX}:root`, '🏠 根')
  ];
  if (totalChildren > CHILDREN_PER_PAGE) {
    nav.push(button(`${PREFIX}:n:${node.id}:${Math.max(0, offset - CHILDREN_PER_PAGE)}`, '◀ 前', { disabled: offset === 0 }));
    nav.push(button(`${PREFIX}:n:${node.id}:${offset + CHILDREN_PER_PAGE}`, `次 ▶ (${offset + 1}〜${Math.min(totalChildren, offset + CHILDREN_PER_PAGE)}/${totalChildren})`,
      { disabled: offset + CHILDREN_PER_PAGE >= totalChildren }));
  }
  components.push(buttonRow(...nav));
  const tools = [button(`${PREFIX}:s`, '🔍 探す', { style: ButtonStyle.Primary })];
  if (episodes.length) tools.push(button(`${PREFIX}:t:${node.id}:0`, '🕒 年表'));
  tools.push(shareButton(isRoot ? 'root' : `n:${node.id}:${offset}`, shared));
  const site = siteButton(guildId, isRoot ? 'root' : `n:${node.id}`);
  if (site) tools.push(site);
  components.push(buttonRow(...tools));
  return { content: '', embeds: [embed], components };
}

interface SourceRow {
  message_id: string;
  channel_id: string;
  author_name: string;
  content: string;
  created_at: number;
}

/**
 * canQuote: そのチャンネルの原文を、この画面を見る人に見せてよいか
 * (viewerQuoteFilter / sharedQuoteFilter)。見せられない発言は本文もリンクも出さない。
 */
export function episodeView(guildId: string, id: number,
  { fromId = 0, shared = false, canQuote }: { fromId?: number; shared?: boolean; canQuote: QuoteFilter }): MemoryView {
  const episode = getEpisode(guildId, id);
  const back = fromId ? nodeById(guildId, fromId) : null;
  const navRow = (): ButtonRow => buttonRow(
    ...(back ? [button(`${PREFIX}:n:${back.id}`, clip(`← ${nameOf(back.path) || '根'}`, 80))] : []),
    button(`${PREFIX}:root`, '🏠 根'),
    button(`${PREFIX}:s`, '🔍 探す', { style: ButtonStyle.Primary }),
    ...(episode ? [shareButton(`e:${id}:${fromId}`, shared)] : []),
    ...(episode ? [siteButton(guildId, `e:${id}`)].filter((entry): entry is ButtonBuilder => entry !== null) : [])
  );
  if (!episode) return { content: `出来事 e${id} はありません。`, embeds: [], components: [navRow()] };

  const channel = archive.prepare<[string], { name: string }>('SELECT name FROM channels WHERE channel_id = ?').get(episode.channel_id);
  const open = new Set(loadPublicChannels(guildId)?.channelIds ?? []);
  const ids = [...new Set([...(episode.highlights ?? []), ...episode.sources])].slice(0, 12);
  const readable = ids.length ? archive.prepare<string[], SourceRow>(`
    SELECT message_id, channel_id, author_name, content, created_at FROM messages
    WHERE message_id IN (${ids.map(() => '?').join(',')}) AND deleted = 0 ORDER BY created_at
  `).all(...ids).filter((row) => open.has(row.channel_id)) : [];
  // 記憶に入れたチャンネルでも、この画面を見る人が見られないチャンネルの原文は出さない
  const rows = readable.filter((row) => canQuote(row.channel_id));
  const hidden = readable.length - rows.length;
  const link = (row: SourceRow): string => `https://discord.com/channels/${guildId}/${row.channel_id}/${row.message_id}`;
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
  if (hidden) lines.push('', HIDDEN_NOTE);
  else if (!rows.length) lines.push('', '-# 根拠の発言は消されたか、読めないチャンネルになりました');

  const embed = new EmbedBuilder().setColor(COLOR)
    .setAuthor({ name: clip(`${day(episode.at_ms)} · #${channel?.name ?? episode.channel_id}${episode.kind ? ` · ${episode.kind}` : ''} · ${stars(episode.importance)}`, 250) })
    .setTitle(clip(`${kindEmoji(episode.kind)} ${episode.title}`, 250));
  if (episode.nodes.length) embed.addFields({ name: '関わり', value: clip(episode.nodes.map((path) => `**${nameOf(path)}**`).join(' · '), 1024) });
  const around = [...episode.before.map((item) => `⬅ ${day(item.at_ms)} ${item.title}`), ...episode.after.map((item) => `➡ ${day(item.at_ms)} ${item.title}`)];
  if (around.length) embed.addFields({ name: '前後の出来事', value: clip(around.join('\n'), 1024) });
  embed.setFooter({ text: `e${episode.id}` });
  fitDescription(embed, lines.join('\n'));

  const options: MenuOption[] = [];
  for (const path of episode.nodes) {
    const node = getNode(guildId, path);
    if (node && options.length < 25) options.push({ label: clip(`📁 ${nameOf(path)}`, 100), description: clip(node.summary || path, 100), value: `n:${node.id}` });
  }
  for (const [mark, list] of [['⬅', episode.before], ['➡', episode.after]] as const) {
    for (const item of list) {
      if (options.length < 25) options.push({ label: clip(`${mark} ${item.title}`, 100), description: day(item.at_ms), value: `e:${item.id}:${fromId}` });
    }
  }
  const components: (MenuRow | ButtonRow)[] = options.length ? [select(`${PREFIX}:open:related`, '関わったページ・前後の出来事を開く', options)] : [];
  components.push(navRow());
  return { content: '', embeds: [embed], components };
}

export function timelineView(guildId: string, node: MemoryNode, { offset = 0, shared = false }: { offset?: number; shared?: boolean } = {}): MemoryView {
  const { total, rows } = episodeTimeline(guildId, node.path, { offset, limit: TIMELINE_PER_PAGE });
  const embed = new EmbedBuilder().setColor(COLOR)
    .setAuthor({ name: clip(breadcrumb(node.path), 250) })
    .setTitle(clip(`🕒 ${nameOf(node.path) || '記憶'} の年表`, 250))
    .setDescription(rows.length
      ? clip(rows.map((episode) => `${kindEmoji(episode.kind)} **${day(episode.at_ms)}** ${episode.title}\n-# ${clip(renderText(episode.summary), 110)}`).join('\n'), 3800)
      : 'まだ出来事がありません。')
    .setFooter({ text: `${total ? `${offset + 1}〜${offset + rows.length} / ${total} 件` : '0 件'} · 古い順` });
  const components: (MenuRow | ButtonRow)[] = [];
  if (rows.length) components.push(select(`${PREFIX}:open:timeline`, '📜 出来事を開く', rows.map((episode) => episodeOption(episode, node.id))));
  components.push(buttonRow(
    button(`${PREFIX}:n:${node.id}`, clip(`← ${nameOf(node.path) || '根'}`, 80)),
    button(`${PREFIX}:t:${node.id}:${Math.max(0, offset - TIMELINE_PER_PAGE)}`, '◀ 前', { disabled: offset === 0 }),
    button(`${PREFIX}:t:${node.id}:${offset + TIMELINE_PER_PAGE}`, '次 ▶', { disabled: offset + TIMELINE_PER_PAGE >= total }),
    button(`${PREFIX}:root`, '🏠 根'),
    shareButton(`t:${node.id}:${offset}`, shared)
  ));
  return { content: '', embeds: [embed], components };
}

export function searchView(guildId: string, query: string): MemoryView {
  const pages = searchNodes(guildId, query, 10);
  const episodes = searchEpisodes(guildId, query, 10);
  const lines: string[] = [];
  if (pages.length) lines.push('**ページ**', ...pages.map((row) => `📁 **${row.path}** ${row.summary ?? ''}`));
  if (episodes.length) lines.push('', '**出来事**', ...episodes.map((row) => `${kindEmoji(row.kind)} ${day(row.at_ms)} ${row.title}`));
  const embed = new EmbedBuilder().setColor(COLOR)
    .setAuthor({ name: '📖 記憶 › 探す' })
    .setTitle(clip(`🔍 「${query}」`, 250))
    .setDescription(lines.length ? clip(lines.join('\n'), 3800) : '見つかりませんでした。別の言い方で探すか、原文は /search で。');
  const options: MenuOption[] = [];
  for (const row of pages) {
    const node = getNode(guildId, row.path);
    if (node) options.push({ label: clip(`📁 ${nameOf(row.path)}`, 100), description: clip(row.summary || row.path, 100), value: `n:${node.id}` });
  }
  for (const row of episodes) if (options.length < 25) options.push(episodeOption(row, 0));
  const components: (MenuRow | ButtonRow)[] = [];
  if (options.length) components.push(select(`${PREFIX}:open:search`, '開く', options));
  components.push(buttonRow(
    button(`${PREFIX}:s`, '🔍 もう一度探す', { style: ButtonStyle.Primary }),
    button(`${PREFIX}:root`, '🏠 根')
  ));
  return { content: '', embeds: [embed], components };
}

export function rootView(guildId: string, { shared = false }: { shared?: boolean } = {}): MemoryView {
  const root = getNode(guildId, '');
  return root ? pageView(guildId, root, { shared }) : { content: '記憶はまだできていません。', embeds: [], components: [] };
}

/**
 * `root` / `n:12[:offset]` / `e:34[:from]` / `t:12[:offset]` を画面にする。shared は共有したメッセージの中か。
 * canQuote は出来事の原文をこの画面を見る人に見せてよいか (本人だけの画面は viewerQuoteFilter、共有は sharedQuoteFilter)。
 */
export function viewFor(guildId: string, target: unknown, { shared = false, canQuote }: { shared?: boolean; canQuote: QuoteFilter }): MemoryView {
  const view = buildView(guildId, target, { shared, canQuote });
  return shared ? fitShared(view) : view;
}

function buildView(guildId: string, target: unknown, { shared, canQuote }: { shared: boolean; canQuote: QuoteFilter }): MemoryView {
  if (target === 'root') return rootView(guildId, { shared });
  const [kind, id, extra] = String(target).split(':');
  if (kind === 'e') return episodeView(guildId, Number(id), { fromId: idOf(extra), shared, canQuote });
  const node = nodeById(guildId, id);
  if (!node) return rootView(guildId, { shared });
  if (kind === 't') return timelineView(guildId, node, { offset: offsetOf(extra), shared });
  return pageView(guildId, node, { offset: offsetOf(extra), shared });
}

// 新しいメッセージ (共有・自分で開く・/memory explore の最初の画面) は、embed とメニューを合わせた大きさにも上限がある。日本語は1文字3バイトなので、
// 大きいページ (あかり: メニュー 9.6KB + embed 8.3KB) で 40005 Message size exceeds maximum allowed になった
// (同じ大きさでも、本人だけの画面の書き換えは通る)。共有する画面だけ、収まるまで削る
export const SHARED_BYTES = 12000;
const viewBytes = (view: MemoryView): number => Buffer.byteLength(JSON.stringify({
  content: view.content, embeds: view.embeds.map((embed) => embed.toJSON()), components: view.components.map((row) => row.toJSON())
}));

export function fitShared(view: MemoryView): MemoryView {
  const menus = view.components.flatMap((row): (StringSelectMenuBuilder | ButtonBuilder)[] => row.components)
    .filter((part): part is StringSelectMenuBuilder => part instanceof StringSelectMenuBuilder);
  const trimMenus = (count: number, length: number): void => {
    for (const menu of menus) {
      menu.setOptions(menu.options.slice(0, count).flatMap((option) => {
        const { label, value } = option.data;
        if (label === undefined || value === undefined) return [];   // 組み立てるときに必ず入れている
        const data: APISelectMenuOption = { ...option.data, label, value, description: length ? clip(option.data.description, length) : undefined };
        if (!data.description) delete data.description;
        return [data];
      }));
    }
  };
  trimMenus(15, 40);
  const embed = view.embeds[0];
  // 本文を削り、それでも収まらなければメニューの説明を消して数を減らす
  for (let round = 0; viewBytes(view) > SHARED_BYTES && round < 12; round += 1) {
    const description = embed?.data.description ?? '';
    if (embed && description.length > 600) embed.setDescription(clip(description, Math.floor(description.length * 0.75)));
    else if (round < 10) trimMenus(10, 0);
    else trimMenus(5, 0);
  }
  return view;
}

/** 原文を出してよいかを調べるチャンネル。アーカイブ済みのスレッドはキャッシュに無いので親で判定する (非公開スレッドは出さない)。 */
function sourceChannel(guild: Guild, channelId: string): GuildBasedChannel | null {
  const cached = guild.channels.cache.get(channelId);
  if (cached) return cached;
  const row = archive.prepare<[string], { parent_id: string | null; is_thread: number; is_private: number }>(
    'SELECT parent_id, is_thread, is_private FROM channels WHERE channel_id = ?'
  ).get(channelId);
  if (!row?.is_thread || row.is_private || !row.parent_id) return null;
  return guild.channels.cache.get(row.parent_id) ?? null;
}

/**
 * 本人だけの画面 (ephemeral): 押した人がそのチャンネルを読める (ViewChannel と ReadMessageHistory) ものだけ。
 * サーバーや人がキャッシュに無ければ判定できないので出さない。
 */
export function viewerQuoteFilter(interaction: BaseInteraction): QuoteFilter {
  if (!interaction.inCachedGuild()) return () => false;
  const { guild, member } = interaction;
  return (channelId) => {
    const channel = sourceChannel(guild, channelId);
    return Boolean(channel && canRead(channel, member));
  };
}

const isNsfw = (channel: unknown): boolean =>
  typeof channel === 'object' && channel !== null && 'nsfw' in channel && channel.nsfw === true;
// スレッドは親チャンネルの NSFW を引き継ぐ
const inNsfw = (channel: unknown): boolean =>
  isNsfw(channel) || (typeof channel === 'object' && channel !== null && 'parent' in channel && isNsfw(channel.parent));

/**
 * 共有した画面 (誰でも見える): 今のチャンネルの発言か、@everyone が読めるチャンネルの発言だけ。
 * そのメッセージを見られる人の中に、元のチャンネルを見られない人がいるかもしれないため。
 * NSFW のチャンネルの発言は NSFW のチャンネルでだけ (1つの出来事の根拠は複数のチャンネルにまたがることがある)。
 */
export function sharedQuoteFilter(interaction: BaseInteraction): QuoteFilter {
  const here = interaction.channelId;
  const hereNsfw = inNsfw(interaction.channel);
  const guild = interaction.inCachedGuild() ? interaction.guild : null;
  return (channelId) => {
    if (here && channelId === here) return true;
    const channel = guild ? sourceChannel(guild, channelId) : null;
    if (!guild || !channel || (inNsfw(channel) && !hereNsfw)) return false;
    return Boolean(canRead(channel, guild.roles.everyone));
  };
}

type MemoryInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

/**
 * NSFW チャンネルの出来事 (原文の引用が載る) は NSFW のチャンネルにだけ共有する。
 * ページの本文は出どころが混ざるので見分けない (本人だけの画面と同じく誰でも開ける)。
 */
function shareRefusal(interaction: MemoryInteraction, guildId: string, target: string): string | null {
  const [kind, id] = target.split(':');
  if (kind !== 'e') return null;
  const episode = getEpisode(guildId, Number(id));
  const source = episode ? interaction.guild?.channels?.cache?.get(episode.channel_id) : undefined;
  if (isNsfw(source) && !isNsfw(interaction.channel)) return 'NSFW チャンネルの出来事は、NSFW のチャンネルでだけ共有できます。';
  return null;
}

const sharedIn = (interaction: MemoryInteraction): boolean => Boolean(interaction.message) && !interaction.message?.flags?.has?.(MessageFlags.Ephemeral);

function searchModal(): ModalBuilder {
  return new ModalBuilder().setCustomId(`${PREFIX}:q`).setTitle('記憶を探す').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('query').setLabel('探す語 (人・作ったもの・ネタ・レスバなど)')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100))
  );
}

export async function handleMemoryComponent(interaction: MemoryInteraction): Promise<boolean> {
  const customId = interaction.customId ?? '';
  if (!customId.startsWith(`${PREFIX}:`)) return false;
  const [, action, ...rest] = customId.split(':');
  const guildId = interaction.guildId ?? '';
  const shared = sharedIn(interaction);
  // 共有したメッセージは書き換えても「誰が共有したか」の一行を残し、最後に操作した人を足す
  // (誰でも操作できるので、他の人が押すと見ていた画面が急に変わる。誰が変えたか分かるように)
  const keep = (view: MemoryView): MemoryView & { allowedMentions?: { parse: [] } } => (shared ? {
    ...view,
    content: `${String(interaction.message?.content ?? '').replace(/ · 最後に操作: <@!?[^>]+>$/, '')} · 最後に操作: ${interaction.user}`,
    allowedMentions: { parse: [] }
  } : view);
  // 先に受け付けだけを返し、画面はそのあと書き換える。Discord は3秒以内に返事が無い操作を
  // 「失敗しました」にする (受け付けの後の書き換えは15分まで効く)
  const update = async (view: MemoryView): Promise<void> => { await interaction.deferUpdate(); await interaction.editReply(view); };
  // 新しいメッセージ (共有・自分で開く) はすぐ送る。画面は 25ms でできるので3秒に余裕がある。
  // 「考え中」を出してから書き換える形 (deferReply → editReply) は、ページを共有したときに
  // Discord が書き換えを毎回 500 で拒否した (2026-10-16)
  const reply = async (view: MemoryView & { allowedMentions?: { parse: [] } }, { ephemeral = false } = {}): Promise<void> => {
    await interaction.reply(ephemeral ? { ...view, flags: MessageFlags.Ephemeral } : view);
  };
  try {
    // 原文を出してよい範囲。共有したメッセージ (と、これから共有するもの) は誰でも見るので広く見せない
    const viewerQuotes = viewerQuoteFilter(interaction);
    const sharedQuotes = sharedQuoteFilter(interaction);
    if (action === 'noop') { await interaction.deferUpdate(); return true; }
    // 探す: ボタンで入力欄を出し、送られたら結果の画面に差し替える (入力欄は最初の返事でしか出せない)
    if (action === 's' && !interaction.isModalSubmit()) { await interaction.showModal(searchModal()); return true; }
    if (action === 'q' && interaction.isModalSubmit?.()) {
      const view = searchView(guildId, interaction.fields.getTextInputValue('query').trim());
      await update(keep(shared ? fitShared(view) : view));
      return true;
    }
    if (action === 'share') {
      const target = rest.join(':') || 'root';
      const refusal = shareRefusal(interaction, guildId, target);
      if (refusal) { await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); return true; }
      await reply({
        ...viewFor(guildId, target, { shared: true, canQuote: sharedQuotes }),
        content: `-# 📖 ${interaction.user} が記憶を共有しました · ボタンは誰でも操作できます (全員の画面が変わります)`,
        allowedMentions: { parse: [] }
      });
      return true;
    }
    if (action === 'site') {
      // 共有した画面でも、リンクは押した人専用 (その人にだけ返す)
      const config = siteConfigFor(guildId);
      const destination = config ? siteTargetFor(guildId, rest.join(':') || 'root') : null;
      if (!config || !destination) {
        await interaction.reply({ content: 'このページはサイトにありません。', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return true;
      }
      await replyWithSiteLink(interaction, config, destination.target, destination.label);
      return true;
    }
    if (action === 'mine') {
      // 本人だけでも新しいメッセージなので大きさの上限に収める
      await reply(fitShared(viewFor(guildId, rest.join(':') || 'root', { canQuote: viewerQuotes })), { ephemeral: true });
      return true;
    }
    const target = interaction.isStringSelectMenu?.() ? interaction.values[0] ?? 'root'
      : action === 'root' ? 'root' : [action, ...rest].join(':');
    await update(keep(viewFor(guildId, target, { shared, canQuote: shared ? sharedQuotes : viewerQuotes })));
  } catch (error) {
    // どの操作が、操作から何ミリ秒で落ちたかを残す。1秒以内の Unknown interaction (10062) は
    // 時間切れではなく、同じ bot のトークンで動いている別のプロセスが先に返事したことを疑う
    const ageMs = Date.now() - (interaction.createdTimestamp ?? Date.now());
    const value = interaction.isStringSelectMenu?.() ? ` = ${interaction.values[0]}` : '';
    console.error(`memory explore failed: ${customId}${value} by ${interaction.user?.id}`
      + ` on ${interaction.message?.id ?? '-'} (${shared ? 'shared' : 'private'}) after ${ageMs}ms:`,
      errorCode(error) ?? '', errorMessage(error));
    if (errorCode(error) === 10062 && ageMs < 2500) {
      console.error('memory explore: Discord did not know this interaction within 2.5s; another process may be answering with the same bot token');
    }
    const notice: InteractionReplyOptions = { content: `開けませんでした: ${clip(errorMessage(error), 150)} (もう一度押すか、/memory explore で開き直してください)`,
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
    await (interaction.deferred || interaction.replied ? interaction.followUp(notice) : interaction.reply(notice)).catch(() => {});
  }
  return true;
}
