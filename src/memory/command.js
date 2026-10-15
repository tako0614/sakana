import { execFile } from 'node:child_process';
import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { canManageIndex } from '../archive/permissions.js';
import { pausedBy, setPaused, treeConfig } from './build.js';
import { snapshotPublicChannels } from './snapshot.js';
import { memoryStatus } from './status.js';
import { includeChannel, includedChannels, removeIncluded } from './store.js';
import { hasMemory, runMemoryTool } from './tool.js';

// /memory: 記憶の本の進み具合を見る・止める (管理者)、ページや出来事を開く (誰でも)。
// 記憶は公開チャンネルだけから作っているので、開くのは誰に見せてもよい。
// 返事は本人にだけ見える形にする (チャンネルを流さない)。

const UNIT = process.env.MEMORY_TREE_SYSTEMD_UNIT ?? 'sakana-memory.service';
const ADMIN_ONLY = new Set(['status', 'pause', 'resume', 'include', 'exclude']);
const number = (value) => Number(value ?? 0).toLocaleString('en-US');
const percent = (part, whole) => (whole > 0 ? `${Math.min(100, (part / whole) * 100).toFixed(1)}%` : '-');
const ago = (ms) => (ms ? `<t:${Math.floor(ms / 1000)}:R>` : '-');

function statusEmbed(status) {
  const progress = status.totals
    ? `${number(status.read)} / ${number(status.totals.messages)} 件 (${percent(status.read, status.totals.messages)})`
    : `${number(status.read)} 件 (総数は builder の初回で数える)`;
  const eta = status.remaining === 0 ? '読み終えた (新着は1時間おき)'
    : status.etaHours === null ? '直近1時間に進んでいないので見込みなし'
      : `あと約 ${status.etaHours < 1 ? `${Math.ceil(status.etaHours * 60)} 分` : `${status.etaHours.toFixed(1)} 時間`} (直近1時間 ${number(status.lastHour.messages)} 件)`;
  const state = status.paused ? `⏸ 一時停止中 (${status.paused.by})`
    : status.running ? '▶ 読み込み中' : '待機中 (timer が1時間おきに起動)';
  const budget = status.budgetUsd > 0 ? ` / 上限 $${status.budgetUsd}` : '';
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
      { name: '費用', value: `$${status.spentUsd.toFixed(3)}${budget} (${number(status.calls)} 回)`, inline: true },
      { name: 'モデル', value: treeConfig.models.join(' → ').slice(0, 1000), inline: true },
      { name: '追加したチャンネル (@everyone 以外)', value: status.included.length
        ? status.included.map((id) => `<#${id}>`).join(' ').slice(0, 1000) : 'なし (公開チャンネルだけ)' }
    );
}

/** builder をすぐ起こす。失敗しても timer が1時間以内に起こすので黙って諦める。 */
function wakeBuilder() {
  if (!UNIT) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('systemctl', ['start', '--no-block', UNIT], { timeout: 10_000 }, (error) => resolve(!error));
  });
}

/** 根拠の発言へのリンク。memory ツールの「1) …」の番号に合わせる。 */
function sourceLinks(guildId, refs) {
  if (!refs.entries.length) return '';
  return '\n\n根拠: ' + refs.entries
    .map((entry, i) => `[${i + 1}](https://discord.com/channels/${guildId}/${entry.channelId}/${entry.messageId})`)
    .join(' ');
}

export const memoryCommand = {
  data: new SlashCommandBuilder()
    .setName('memory')
    .setDescription('記憶の本 (過去ログを整理したもの) を見る')
    .addSubcommand((sub) => sub.setName('show').setDescription('ページを開く (説明・子・つながり・出来事)')
      .addStringOption((option) => option.setName('path').setDescription('例: people/たこ。空なら根')))
    .addSubcommand((sub) => sub.setName('search').setDescription('ページと出来事を探す')
      .addStringOption((option) => option.setName('query').setDescription('探す語').setRequired(true)))
    .addSubcommand((sub) => sub.setName('episode').setDescription('出来事と根拠の発言を開く')
      .addStringOption((option) => option.setName('id').setDescription('出来事の番号。例: e12').setRequired(true)))
    .addSubcommand((sub) => sub.setName('status').setDescription('読み込みの進み具合と費用 (管理者)'))
    .addSubcommand((sub) => sub.setName('pause').setDescription('読み込みを一時停止する (管理者)'))
    .addSubcommand((sub) => sub.setName('resume').setDescription('読み込みを再開する (管理者)'))
    .addSubcommand((sub) => sub.setName('include').setDescription('@everyone が見られないチャンネルも記憶に入れる (管理者)')
      .addChannelOption((option) => option.setName('channel').setDescription('入れるチャンネル (その下のスレッドも入る)').setRequired(true)))
    .addSubcommand((sub) => sub.setName('exclude').setDescription('追加したチャンネルを外す。読んだ分は残る (管理者)')
      .addChannelOption((option) => option.setName('channel').setDescription('外すチャンネル').setRequired(true))),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'サーバー内で使ってください。', flags: MessageFlags.Ephemeral });
      return;
    }
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    if (ADMIN_ONLY.has(sub)) {
      const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
      if (!canManageIndex(member)) {
        await interaction.reply({ content: 'この操作は「サーバー管理」権限を持つ人か `ARCHIVE_ADMIN_USERS` の人だけが使えます。', flags: MessageFlags.Ephemeral });
        return;
      }
    }

    // DB を読む前に受け付ける (Discord の応答期限は3秒)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (sub === 'status') {
        const status = { ...memoryStatus(guildId, { budgetUsd: treeConfig.budgetUsd }), included: includedChannels(guildId) };
        await interaction.editReply({ embeds: [statusEmbed(status)] });
        return;
      }
      if (sub === 'include' || sub === 'exclude') {
        const channel = interaction.options.getChannel('channel');
        if (sub === 'include') includeChannel(guildId, channel.id, interaction.user.username);
        const removed = sub === 'exclude' && removeIncluded(guildId, channel.id);
        // 控えをすぐ書き直して builder を起こす (次の区切りから読む / 読まない)
        snapshotPublicChannels(interaction.client);
        const woke = sub === 'include' && await wakeBuilder();
        await interaction.editReply(sub === 'include'
          ? `<#${channel.id}> とその下のスレッドを記憶に入れます。このチャンネルを見られない人にも思い出されます。${woke ? '読み込みを起動しました。' : ''}`
          : removed ? `<#${channel.id}> を外しました。これから先は読みません (読んだ分の記憶は残ります)。`
            : `<#${channel.id}> は追加したチャンネルではありません (公開チャンネルは外せません)。`);
        return;
      }
      if (sub === 'pause') {
        setPaused(guildId, interaction.user.username);
        await interaction.editReply('一時停止しました。読みかけの区切りが終わったところで止まります (読んだ分は失いません)。');
        return;
      }
      if (sub === 'resume') {
        const was = pausedBy(guildId);
        setPaused(guildId, null);
        const woke = await wakeBuilder();
        await interaction.editReply(`${was ? '再開しました。' : '止まっていませんでした。'}${woke ? '読み込みを起動しました。' : 'builder は1時間以内に timer から起動します。'}`);
        return;
      }
      if (!hasMemory(guildId)) {
        await interaction.editReply('記憶の本はまだできていません。');
        return;
      }
      const refs = { entries: [], add(entry) { this.entries.push(entry); return this.entries.length; } };
      const args = sub === 'show' ? { path: interaction.options.getString('path') ?? '' }
        : sub === 'search' ? { query: interaction.options.getString('query') }
          : { episode: interaction.options.getString('id') };
      const text = runMemoryTool({ guildId, refs }, args) + sourceLinks(guildId, refs);
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#2b2d31')
        .setDescription(text.length > 4000 ? `${text.slice(0, 3990)}\n…(以下略)` : text)] });
    } catch (error) {
      console.error('memory command failed:', error);
      await interaction.editReply(`失敗しました: ${String(error?.message ?? error).slice(0, 200)}`).catch(() => {});
    }
  }
};

export const memoryCommands = [memoryCommand];
