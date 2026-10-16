import { execFile } from 'node:child_process';
import {
  EmbedBuilder, MessageFlags, SlashCommandBuilder,
  type ChatInputCommandInteraction, type InteractionEditReplyOptions
} from 'discord.js';
import { canManageIndex } from '../archive/permissions.js';
import { pausedBy, setPaused, treeConfig } from './build.js';
import { fitShared, rootView, viewFor, viewerQuoteFilter } from './explore.js';
import { snapshotPublicChannels } from './snapshot.js';
import { memoryStatus, type MemoryStatus } from './status.js';
import {
  OTHERS, addTopLevel, includeChannel, includedChannels, listChildren, memoryDb, moveSubtree, normalizePath, removeIncluded,
  removeTopLevel, topLevels
} from './store.js';
import { parseEpisodeId, siteOrigin, siteUrl, type SiteTarget } from './site.js';
import { hasMemory, runMemoryTool, type MemoryRefTable } from './tool.js';
import { errorMessage } from './types.js';

// /memory: 記憶の本の進み具合を見る・止める (管理者)、ページや出来事を開く (誰でも)。
// 記憶 (要約とページ) は公開チャンネルと管理者が入れたチャンネルから作っていて、開くのは誰に見せてもよい。
// ただし出来事の原文 (根拠の発言とそのリンク) は、開いた人が見られるチャンネルのものだけ出す。
// 返事は本人にだけ見える形にし (チャンネルを流さない)、誰にも通知しない (allowedMentions)。

const UNIT = process.env.MEMORY_TREE_SYSTEMD_UNIT ?? 'sakana-memory.service';
const ADMIN_ONLY = new Set(['status', 'pause', 'resume', 'include', 'exclude', 'list', 'add', 'remove']);
// 返事に入る名前やパスは利用者の入力。@everyone などを書かれても誰にも通知しない
const NO_PINGS = { parse: [] };

/** 最上位の一覧と、その下のページ数。 */
function categoryList(guildId: string): string {
  const count = memoryDb().prepare<[string, string], { c: number }>("SELECT COUNT(*) AS c FROM nodes WHERE guild_id = ? AND path LIKE ? ESCAPE '\\'");
  return topLevels(guildId).map((path) => {
    const node = listChildren(guildId, '', 50).find((row) => row.path === path);
    const pages = count.get(guildId, `${path.replace(/[%_\\]/g, (c) => `\\${c}`)}/%`)?.c ?? 0;
    return `- **${path}** (${pages}) ${node?.summary ?? ''}${path === OTHERS ? ' ← 受け皿' : ''}`;
  }).join('\n');
}
const number = (value: number | null | undefined): string => Number(value ?? 0).toLocaleString('en-US');
const percent = (part: number, whole: number): string => (whole > 0 ? `${Math.min(100, (part / whole) * 100).toFixed(1)}%` : '-');
const ago = (ms: number | null | undefined): string => (ms ? `<t:${Math.floor(ms / 1000)}:R>` : '-');

function statusEmbed(status: MemoryStatus & { included: string[] }): EmbedBuilder {
  const progress = status.totals
    ? `${number(status.read)} / ${number(status.totals.messages)} 件 (${percent(status.read, status.totals.messages)})`
    : `${number(status.read)} 件 (総数は builder の初回で数える)`;
  const eta = status.remaining === 0 ? '読み終えた (新着は15分おきに見て、会話が1時間止まったら読む)'
    : status.etaHours === null ? '直近1時間に進んでいないので見込みなし'
      : `あと約 ${status.etaHours < 1 ? `${Math.ceil(status.etaHours * 60)} 分` : `${status.etaHours.toFixed(1)} 時間`} (直近1時間 ${number(status.lastHour.messages)} 件)`;
  const state = status.paused ? `⏸ 一時停止中 (${status.paused.by})`
    : status.running ? '▶ 読み込み中' : '待機中 (timer が15分おきに起動)';
  const budget = status.budgetUsd > 0 ? ` / 月の上限 $${status.budgetUsd}` : '';
  return new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle('🧠 記憶の本')
    .addFields(
      { name: '状態', value: state, inline: true },
      { name: '最後に読んだ区切り', value: ago(status.lastDoneAt), inline: true },
      { name: '読んだ発言', value: progress },
      { name: '見込み', value: eta },
      { name: 'チャンネル', value: `${status.channels.caughtUp} / ${status.channels.total} を最新まで読んだ`, inline: true },
      { name: '区切り', value: `${number(status.done)} 回${status.failed ? ` / 失敗 ${status.failed}` : ''}`, inline: true },
      { name: '記憶', value: `ページ ${number(status.memory.pages)} / 出来事 ${number(status.memory.episodes)} / つながり ${number(status.memory.links)}`
        + (status.memory.pendingPages ? ` / 統合待ち ${status.memory.pendingPages} ページ` : '') },
      { name: '費用', value: `今月 $${(status.monthUsd ?? status.spentUsd).toFixed(3)}${budget} (累計 $${status.spentUsd.toFixed(3)} · ${number(status.calls)} 回)`, inline: true },
      { name: 'モデル', value: treeConfig.models.join(' → ').slice(0, 1000), inline: true },
      { name: '追加したチャンネル (@everyone 以外)', value: status.included.length
        ? status.included.map((id) => `<#${id}>`).join(' ').slice(0, 1000) : 'なし (公開チャンネルだけ)' }
    );
}

/** builder をすぐ起こす。失敗しても timer が1時間以内に起こすので黙って諦める。 */
function wakeBuilder(): Promise<boolean> {
  if (!UNIT) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('systemctl', ['start', '--no-block', UNIT], { timeout: 10_000 }, (error) => resolve(!error));
  });
}

/** 根拠の発言へのリンク。memory ツールの「1) …」の番号に合わせる。 */
function sourceLinks(guildId: string, refs: { entries: { channelId: string; messageId: string }[] }): string {
  if (!refs.entries.length) return '';
  return '\n\n根拠: ' + refs.entries
    .map((entry, i) => `[${i + 1}](https://discord.com/channels/${guildId}/${entry.channelId}/${entry.messageId})`)
    .join(' ');
}

/** /memory url: サイトのトップ・ページ・出来事の URL を、チャンネルにそのまま出す。存在しないものは本人にだけ断る。 */
async function replyWithSiteUrl(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const refuse = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_PINGS });
  const origin = siteOrigin();
  if (!origin) {
    await refuse('記憶の本のサイトはまだ設定されていません (MEMORY_SITE_PUBLIC_URL または GOVERNANCE_LAW_SITE_URL)。');
    return;
  }
  const { getEpisode, getNode } = await import('./store.js');
  const idText = interaction.options.getString('id');
  const pathText = (interaction.options.getString('path') ?? '').replace(/^\/+|\/+$/g, '').trim();
  let target: SiteTarget = { kind: 'home' };
  let label = '記憶の本';
  if (idText) {
    const id = parseEpisodeId(idText);
    const episode = id === null ? null : getEpisode(guildId, id);
    if (id === null || !episode) {
      await refuse(`出来事 ${idText.slice(0, 20)} は記憶の本にありません。`);
      return;
    }
    target = { kind: 'episode', id };
    label = `出来事 e${id}: ${episode.title}`;
  } else if (pathText) {
    const node = getNode(guildId, pathText);
    if (!node) {
      await refuse(`ページ「${pathText.slice(0, 60)}」は記憶の本にありません。`);
      return;
    }
    target = { kind: 'page', path: node.path };
    label = `${node.path}${node.summary ? ` — ${node.summary}` : ''}`;
  }
  // <> で囲むと、ログインが要るページのプレビュー (「ログインしてください」の画面) が展開されない
  await interaction.reply({
    content: `📖 **${label.slice(0, 200)}**\n<${siteUrl(origin, target)}>\n-# このサーバーのメンバーだけ読めます (Discord でログインします)`,
    allowedMentions: NO_PINGS
  });
}

export const memoryCommand = {
  data: new SlashCommandBuilder()
    .setName('memory')
    .setDescription('記憶の本 (過去ログを整理したもの) を見る')
    .addSubcommand((sub) => sub.setName('explore').setDescription('記憶の本をメニューでたどって読む')
      .addStringOption((option) => option.setName('path').setDescription('最初に開くページ。例: people/たこ。空なら根')))
    .addSubcommand((sub) => sub.setName('show').setDescription('ページを開く (説明・子・つながり・出来事)')
      .addStringOption((option) => option.setName('path').setDescription('例: people/たこ。空なら根')))
    .addSubcommand((sub) => sub.setName('search').setDescription('ページと出来事を探す')
      .addStringOption((option) => option.setName('query').setDescription('探す語').setRequired(true)))
    .addSubcommand((sub) => sub.setName('episode').setDescription('出来事と根拠の発言を開く')
      .addStringOption((option) => option.setName('id').setDescription('出来事の番号。例: e12').setRequired(true)))
    .addSubcommand((sub) => sub.setName('url').setDescription('記憶の本のサイトの URL を出す (サーバーのメンバーだけ読める)')
      .addStringOption((option) => option.setName('path').setDescription('開くページ。例: people/たこ。空ならトップ'))
      .addStringOption((option) => option.setName('id').setDescription('開く出来事の番号。例: e12')))
    .addSubcommand((sub) => sub.setName('status').setDescription('読み込みの進み具合と費用 (管理者)'))
    .addSubcommand((sub) => sub.setName('pause').setDescription('読み込みを一時停止する (管理者)'))
    .addSubcommand((sub) => sub.setName('resume').setDescription('読み込みを再開する (管理者)'))
    .addSubcommand((sub) => sub.setName('include').setDescription('@everyone が見られないチャンネルも記憶に入れる (管理者)')
      .addChannelOption((option) => option.setName('channel').setDescription('入れるチャンネル (その下のスレッドも入る)').setRequired(true)))
    .addSubcommand((sub) => sub.setName('exclude').setDescription('追加したチャンネルを外す。読んだ分は残る (管理者)')
      .addChannelOption((option) => option.setName('channel').setDescription('外すチャンネル').setRequired(true)))
    .addSubcommandGroup((group) => group.setName('category').setDescription('最上位の分類を見る・増やす・消す (管理者)')
      .addSubcommand((sub) => sub.setName('list').setDescription('最上位の一覧'))
      .addSubcommand((sub) => sub.setName('add').setDescription('最上位を作る。from で others の下などから昇格')
        .addStringOption((option) => option.setName('name').setDescription('最上位の名前 (例: debates)').setRequired(true))
        .addStringOption((option) => option.setName('description').setDescription('何を入れる分類か (書き手が振り分けに使う)'))
        .addStringOption((option) => option.setName('from').setDescription('昇格させるページ (例: others/レスバ集)')))
      .addSubcommand((sub) => sub.setName('remove').setDescription('最上位を消す。中身は others の下へ移す')
        .addStringOption((option) => option.setName('name').setDescription('消す最上位').setRequired(true)))),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'サーバー内で使ってください。', flags: MessageFlags.Ephemeral });
      return;
    }
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    if (ADMIN_ONLY.has(sub)) {
      const member = interaction.member ?? await interaction.guild?.members.fetch(interaction.user.id) ?? null;
      if (!canManageIndex(member)) {
        await interaction.reply({ content: 'この操作は「サーバー管理」権限を持つ人か `ARCHIVE_ADMIN_USERS` の人だけが使えます。', flags: MessageFlags.Ephemeral });
        return;
      }
    }
    // URL はみんなに見せるための返事なので、本人だけにはしない (サイトはログインが要るので URL が見えても読めない)
    if (sub === 'url') {
      await replyWithSiteUrl(interaction, guildId);
      return;
    }
    // 本人だけの返事でも利用者の入力を含むので、誰にも通知しない
    const edit = (options: string | InteractionEditReplyOptions): Promise<unknown> =>
      interaction.editReply(typeof options === 'string' ? { content: options, allowedMentions: NO_PINGS } : { ...options, allowedMentions: NO_PINGS });

    // DB を読む前に受け付ける (Discord の応答期限は3秒)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (sub === 'status') {
        const status = { ...memoryStatus(guildId, { budgetUsd: treeConfig.budgetUsd }), included: includedChannels(guildId) };
        await edit({ embeds: [statusEmbed(status)] });
        return;
      }
      if (interaction.options.getSubcommandGroup?.(false) === 'category') {
        if (sub === 'list') {
          await edit({ embeds: [new EmbedBuilder().setColor('#2b2d31').setTitle('記憶の本の最上位')
            .setDescription(`${categoryList(guildId)}\n\n書き手は必ずこの中から選び、合わなければ ${OTHERS} に入れる。最上位の下は自由。`)] });
          return;
        }
        if (sub === 'add') {
          const name = normalizePath(interaction.options.getString('name') ?? '');
          const from = (interaction.options.getString('from') ?? '').replace(/^\/+|\/+$/g, '').trim();
          if (!name || name.includes('/')) throw new Error('最上位の名前に / は使えません');
          const path = addTopLevel(guildId, name, interaction.options.getString('description') ?? '');
          let moved = 0;
          if (from) moved = moveSubtree(guildId, from, path);
          await edit(`最上位 **${path}** を作りました。${from ? ` ${from} の ${moved} ページを移しました。` : ''}次の区切りから書き手が使います。`);
          return;
        }
        if (sub === 'remove') {
          const name = interaction.options.getString('name') ?? '';
          const moved = removeTopLevel(guildId, name);
          await edit(`最上位 **${normalizePath(name)}** を消し、中身 ${moved} ページを ${OTHERS}/${normalizePath(name)} に移しました。`);
          return;
        }
      }
      if (sub === 'include' || sub === 'exclude') {
        const channel = interaction.options.getChannel('channel', true);
        if (sub === 'include') includeChannel(guildId, channel.id, interaction.user.username);
        const removed = sub === 'exclude' && removeIncluded(guildId, channel.id);
        // 控えをすぐ書き直して builder を起こす (次の区切りから読む / 読まない)
        snapshotPublicChannels(interaction.client);
        const woke = sub === 'include' && await wakeBuilder();
        await edit(sub === 'include'
          ? `<#${channel.id}> とその下のスレッドを記憶に入れます。このチャンネルを見られない人にも思い出されます。${woke ? '読み込みを起動しました。' : ''}`
          : removed ? `<#${channel.id}> を外しました。これから先は読みません (読んだ分の記憶は残ります)。`
            : `<#${channel.id}> は追加したチャンネルではありません (公開チャンネルは外せません)。`);
        return;
      }
      if (sub === 'pause') {
        setPaused(guildId, interaction.user.username);
        await edit('一時停止しました。読みかけの区切りが終わったところで止まります (読んだ分は失いません)。');
        return;
      }
      if (sub === 'resume') {
        const was = pausedBy(guildId);
        setPaused(guildId, null);
        const woke = await wakeBuilder();
        await edit(`${was ? '再開しました。' : '止まっていませんでした。'}${woke ? '読み込みを起動しました。' : 'builder は1時間以内に timer から起動します。'}`);
        return;
      }
      if (!hasMemory(guildId)) {
        await edit('記憶の本はまだできていません。');
        return;
      }
      // 出来事の原文は、このコマンドを使った人が見られるチャンネルのものだけ
      const canQuote = viewerQuoteFilter(interaction);
      if (sub === 'explore') {
        const path = (interaction.options.getString('path') ?? '').replace(/^\/+|\/+$/g, '').trim();
        const { getNode } = await import('./store.js');
        const node = path ? getNode(guildId, path) : null;
        // 最初の画面は新しいメッセージなので大きさの上限に収める (書き換えは上限が緩い)
        await edit(fitShared(node ? viewFor(guildId, `n:${node.id}`, { canQuote }) : rootView(guildId)));
        return;
      }
      const entries: { channelId: string; messageId: string }[] = [];
      const refs: MemoryRefTable & { entries: typeof entries } = { entries, add(entry) { entries.push(entry); return entries.length; } };
      const args = sub === 'show' ? { path: interaction.options.getString('path') ?? '' }
        : sub === 'search' ? { query: interaction.options.getString('query') }
          : { episode: interaction.options.getString('id') };
      const text = runMemoryTool({ guildId, refs, canQuote }, args) + sourceLinks(guildId, refs);
      await edit({ embeds: [new EmbedBuilder().setColor('#2b2d31')
        .setDescription(text.length > 4000 ? `${text.slice(0, 3990)}\n…(以下略)` : text)] });
    } catch (error) {
      console.error('memory command failed:', error);
      await edit(`失敗しました: ${errorMessage(error).slice(0, 200)}`).catch(() => {});
    }
  }
};

export const memoryCommands = [memoryCommand];
