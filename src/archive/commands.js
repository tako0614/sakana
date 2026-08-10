import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder
} from 'discord.js';

import { countMessages, getGuildState, listChannelStates, purgeGuild } from './db.js';
import { cancelJob, coverageReport, getRunningJob, runCoverageJob, runIndexJob } from './indexer.js';
import { canManageIndex, canSeeDeleted, getChannelScope } from './permissions.js';
import { QueryError } from './query.js';
import {
  aggregateSearch,
  countSearch,
  getContext,
  search,
  searchSummary,
  topDomains,
  topReactionEmojis
} from './search.js';
import {
  bar,
  excerpt,
  formatNumber,
  formatRanking,
  formatResult,
  messageLink,
  relativeTime,
  shortDate,
  sparkline
} from './render.js';

const PAGE_SIZE = 5;
const SESSION_TTL_MS = 15 * 60_000;
const NO_MENTIONS = { parse: [] };
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

const sessions = new Map();

function saveSession(token, payload) {
  const now = Date.now();
  for (const [key, value] of sessions) {
    if (value.expiresAt <= now) sessions.delete(key);
  }
  sessions.set(token, { ...payload, expiresAt: now + SESSION_TTL_MS });
}

function requireGuild(interaction) {
  if (!interaction.guildId) {
    interaction.reply({ content: 'このコマンドはサーバー内でのみ使用できます。', flags: MessageFlags.Ephemeral });
    return false;
  }
  return true;
}

function collectFilters(interaction) {
  const extra = [];

  const user = interaction.options.getUser('from');
  if (user) extra.push({ key: 'from', value: user.id });

  const channel = interaction.options.getChannel('in');
  if (channel) extra.push({ key: 'in', value: channel.id });

  const after = interaction.options.getString('after');
  if (after) extra.push({ key: 'after', value: after });

  const before = interaction.options.getString('before');
  if (before) extra.push({ key: 'before', value: before });

  const has = interaction.options.getString('has');
  if (has) extra.push({ key: 'has', value: has });

  return extra;
}

function describeQuery(query, extra) {
  const parts = [];
  if (query) parts.push(query);
  for (const condition of extra) {
    const value = /^\d{16,21}$/.test(condition.value) && condition.key === 'from'
      ? `<@${condition.value}>`
      : /^\d{16,21}$/.test(condition.value) && condition.key === 'in'
        ? `<#${condition.value}>`
        : condition.value;
    parts.push(`${condition.key}:${value}`);
  }
  return parts.join(' ') || '(条件なし)';
}

async function buildSearchOptions(interaction, { sort } = {}) {
  const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);

  return {
    guildId: interaction.guildId,
    query: interaction.options.getString('query') ?? '',
    extra: collectFilters(interaction),
    channelScope: getChannelScope(interaction.guild, member),
    allowDeleted: canSeeDeleted(member),
    sort: sort ?? interaction.options.getString('sort') ?? 'new'
  };
}

function emptyArchiveEmbed() {
  return new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle('インデックスがまだありません')
    .setDescription('管理者が `/index build` を実行するとサーバーの過去ログを取り込めます。');
}

function renderSearchPage({ options, page, total, label }) {
  const offset = page * PAGE_SIZE;
  const { rows, built } = search(options, { limit: PAGE_SIZE, offset });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const embed = new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle(`🔎 ${formatNumber(total)} 件ヒット`)
    .setDescription(
      rows.length === 0
        ? '該当するメッセージがありませんでした。'
        : rows.map((row, index) => formatResult(row, offset + index + 1, built.terms)).join('\n\n').slice(0, 4000)
    )
    .setFooter({ text: `${page + 1} / ${pages} ページ ・ 並び順: ${built.sortKey} ・ ${label}`.slice(0, 2000) });

  return { embed, rows, built, pages };
}

function paginationRow(token, page, pages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`archive:page:${token}:${page - 1}`)
      .setLabel('前へ')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`archive:page:${token}:${page + 1}`)
      .setLabel('次へ')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages - 1),
    new ButtonBuilder()
      .setCustomId(`archive:shuffle:${token}`)
      .setLabel('ランダムに1件')
      .setStyle(ButtonStyle.Secondary)
  );
}

function queryErrorText(error) {
  return `⚠️ ${error.message}`;
}

// ---------------------------------------------------------------- /index

const indexCommand = {
  data: new SlashCommandBuilder()
    .setName('index')
    .setDescription('サーバーの過去ログを検索インデックスに取り込みます (管理者用)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub
      .setName('build')
      .setDescription('全チャンネルを最古まで遡って取り込みます (時間がかかります)'))
    .addSubcommand((sub) => sub
      .setName('update')
      .setDescription('前回の続きから最新のメッセージだけを取り込みます'))
    .addSubcommand((sub) => sub
      .setName('verify')
      .setDescription('取りこぼした期間 (bot 停止中など) を探して埋めます'))
    .addSubcommand((sub) => sub
      .setName('status')
      .setDescription('インデックスの状態を表示します'))
    .addSubcommand((sub) => sub
      .setName('cancel')
      .setDescription('実行中のインデックス作成を中止します'))
    .addSubcommand((sub) => sub
      .setName('reset')
      .setDescription('このサーバーのインデックスを全削除します')),

  async execute(interaction) {
    if (!requireGuild(interaction)) return;

    const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
    if (!canManageIndex(member)) {
      await interaction.reply({
        content: 'このコマンドは「サーバー管理」権限を持つ人だけが使えます。',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'status') return showStatus(interaction);
    if (sub === 'cancel') return cancelIndex(interaction);
    if (sub === 'reset') return confirmReset(interaction);
    if (sub === 'verify') return startVerify(interaction);

    return startIndex(interaction, sub === 'build' ? 'full' : 'update');
  }
};

async function showStatus(interaction) {
  const guildId = interaction.guildId;
  const state = getGuildState(guildId);
  const job = getRunningJob(guildId);
  const channels = listChannelStates(guildId);

  if (!state) {
    await interaction.reply({ embeds: [emptyArchiveEmbed()], flags: MessageFlags.Ephemeral });
    return;
  }

  const incomplete = channels.filter((channel) => channel.complete !== 1);
  const failed = channels.filter((channel) => channel.last_error);

  const embed = new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle('📚 インデックスの状態')
    .addFields(
      { name: '状態', value: job ? `実行中 (${job.mode})` : state.status, inline: true },
      { name: 'メッセージ数', value: formatNumber(countMessages(guildId)), inline: true },
      { name: 'チャンネル数', value: formatNumber(channels.length), inline: true }
    );

  if (job) {
    embed.addFields({
      name: '進捗',
      value: [
        `チャンネル: ${job.channelsDone} / ${job.channelsTotal}`,
        `取り込み: ${formatNumber(job.messagesIndexed)} 件`,
        `現在: ${job.currentChannel ?? '-'}`
      ].join('\n')
    });
  } else if (state.finished_at) {
    embed.addFields({ name: '最終実行', value: relativeTime(state.finished_at), inline: true });
  }

  // 「取りこぼしが無いか」に答えられるようにする。単一カーソルだった頃は
  // 落ちていた期間の穴が見えなかった。
  const coverage = coverageReport(guildId);
  embed.addFields({
    name: '被覆',
    value: coverage.gapCount === 0
      ? '穴なし (記録済みの区間が連続しています)'
      : [
        `⚠️ 穴 ${coverage.gapCount} 件 (合計 ${formatDuration(coverage.gapMs)})`,
        ...coverage.worst.map((entry) => `<#${entry.channelId}> ${entry.gaps}件 / ${formatDuration(entry.ms)}`),
        '`/index verify` で埋められます (削除済みメッセージは復元できません)'
      ].join('\n')
  });

  if (incomplete.length > 0) {
    embed.addFields({
      name: `未完了のチャンネル (${incomplete.length})`,
      value: incomplete.slice(0, 10).map((channel) => `<#${channel.channel_id}>`).join(' ') || '-'
    });
  }

  if (failed.length > 0) {
    embed.addFields({
      name: `エラーが出たチャンネル (${failed.length})`,
      value: failed.slice(0, 5).map((channel) => `<#${channel.channel_id}>: ${channel.last_error}`).join('\n').slice(0, 1000)
    });
  }

  const top = channels.slice(0, 10);
  if (top.length > 0) {
    const max = top[0].message_count;
    embed.addFields({
      name: 'メッセージが多いチャンネル',
      value: top.map((channel) => `<#${channel.channel_id}> ${bar(channel.message_count, max, 10)} \`${formatNumber(channel.message_count)}\``).join('\n')
    });
  }

  await interaction.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間${minutes % 60}分`;
  return `${Math.floor(hours / 24)}日${hours % 24}時間`;
}

async function startVerify(interaction) {
  if (!getGuildState(interaction.guildId)) {
    await interaction.reply({ embeds: [emptyArchiveEmbed()], flags: MessageFlags.Ephemeral });
    return;
  }

  if (getRunningJob(interaction.guildId)) {
    await interaction.reply({ content: '既に別のジョブが実行中です。`/index status` で確認できます。', flags: MessageFlags.Ephemeral });
    return;
  }

  const before = coverageReport(interaction.guildId);

  await interaction.reply({
    content: before.gapCount === 0
      ? '🔍 記録済みの穴はありませんが、末尾の取りこぼしがないか確認します。'
      : `🔍 穴 ${before.gapCount} 件 (合計 ${formatDuration(before.gapMs)}) を埋めます。`
  });

  // 進捗は interaction ではなく通常メッセージに出す (トークンは15分で切れる)
  const statusMessage = await interaction.channel
    ?.send({ embeds: [verifyEmbed(null)] })
    .catch(() => null);

  let lastEdit = 0;
  const onProgress = (job) => {
    const now = Date.now();
    if (now - lastEdit < 5000) return;
    lastEdit = now;
    statusMessage?.edit({ embeds: [verifyEmbed(job)] }).catch(() => {});
  };

  try {
    const job = await runCoverageJob(interaction.guild, { mode: 'verify', onProgress });
    const after = coverageReport(interaction.guildId);
    await statusMessage?.edit({ embeds: [verifyEmbed(job, after, true)] }).catch(() => {});
  } catch (error) {
    console.error('Verify job failed:', error);
    await statusMessage?.edit({
      embeds: [new EmbedBuilder().setColor('#ed4245').setTitle('確認に失敗しました').setDescription(String(error.message ?? error).slice(0, 2000))]
    }).catch(() => {});
  }
}

function verifyEmbed(job, after = null, done = false) {
  const embed = new EmbedBuilder()
    .setColor(done ? '#3ba55d' : '#2b2d31')
    .setTitle(done ? '✅ 取りこぼしの確認が終わりました' : '🔍 取りこぼしを確認中…');

  if (!job) {
    embed.setDescription('チャンネルを走査しています…');
    return embed;
  }

  const ratio = job.channelsTotal > 0 ? job.channelsDone / job.channelsTotal : 0;

  embed.setDescription([
    `${bar(ratio * 100, 100, 20)} ${Math.round(ratio * 100)}%`,
    '',
    `チャンネル: **${job.channelsDone} / ${job.channelsTotal}**`,
    `取り込み: **${formatNumber(job.messagesIndexed)}** 件`,
    `埋めた穴: **${job.gapsClosed}**`,
    job.cancelled ? '⏹️ 中止しました' : `現在: ${job.currentChannel ?? '-'}`
  ].join('\n'));

  if (done && after) {
    embed.addFields({
      name: '残りの穴',
      value: after.gapCount === 0
        ? 'なし'
        : `${after.gapCount} 件 (合計 ${formatDuration(after.gapMs)})。削除済みメッセージは Discord 側にも無いので埋まりません。`
    });
  }

  return embed;
}

async function cancelIndex(interaction) {
  const cancelled = cancelJob(interaction.guildId);
  await interaction.reply({
    content: cancelled ? '中止をリクエストしました。現在のチャンネルの処理が終わり次第停止します。' : '実行中のインデックス作成はありません。',
    flags: MessageFlags.Ephemeral
  });
}

async function confirmReset(interaction) {
  const count = countMessages(interaction.guildId);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`archive:reset:${interaction.user.id}`)
      .setLabel('削除する')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`archive:cancelreset:${interaction.user.id}`)
      .setLabel('やめる')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({
    content: `⚠️ このサーバーのインデックス **${formatNumber(count)} 件** を削除します。取り込み直すには再度 \`/index build\` が必要です。`,
    components: [row],
    flags: MessageFlags.Ephemeral
  });
}

async function startIndex(interaction, mode) {
  if (getRunningJob(interaction.guildId)) {
    await interaction.reply({ content: '既にインデックス作成が実行中です。`/index status` で進捗を確認できます。', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({
    content: mode === 'full'
      ? '📚 全チャンネルの過去ログ取り込みを開始します。進捗はこのチャンネルに投稿します。'
      : '🔄 差分の取り込みを開始します。'
  });

  // 進捗表示は interaction ではなく通常メッセージに出す。
  // interaction のトークンは15分で切れるが、全件取り込みはそれより長くかかるため。
  const statusMessage = await interaction.channel
    ?.send({ embeds: [jobEmbed(null, mode)] })
    .catch(() => null);

  let lastEdit = 0;

  const onProgress = (job) => {
    const now = Date.now();
    if (now - lastEdit < 5000) return;
    lastEdit = now;
    statusMessage?.edit({ embeds: [jobEmbed(job, mode)] }).catch(() => {});
  };

  try {
    const job = await runIndexJob(interaction.guild, { mode, onProgress });
    await statusMessage?.edit({ embeds: [jobEmbed(job, mode, true)] }).catch(() => {});
  } catch (error) {
    console.error('Index job failed:', error);
    await statusMessage?.edit({
      embeds: [new EmbedBuilder().setColor('#ed4245').setTitle('インデックス作成に失敗しました').setDescription(String(error.message ?? error).slice(0, 2000))]
    }).catch(() => {});
  }
}

function jobEmbed(job, mode, done = false) {
  const embed = new EmbedBuilder()
    .setColor(done ? (job?.cancelled ? '#faa61a' : '#3ba55d') : '#2b2d31')
    .setTitle(done
      ? (job?.cancelled ? '⏹️ インデックス作成を中止しました' : '✅ インデックス作成が完了しました')
      : '📚 インデックス作成中…');

  if (!job) {
    embed.setDescription('チャンネル一覧を取得しています…');
    return embed;
  }

  const ratio = job.channelsTotal > 0 ? job.channelsDone / job.channelsTotal : 0;

  embed.setDescription([
    `${bar(ratio * 100, 100, 20)} ${Math.round(ratio * 100)}%`,
    '',
    `チャンネル: **${job.channelsDone} / ${job.channelsTotal}**`,
    `取り込み: **${formatNumber(job.messagesIndexed)}** 件`,
    job.cancelled ? '⏹️ 中止しました' : `現在: ${job.currentChannel ?? '-'}`,
    `モード: ${mode === 'full' ? '全件' : '差分'}`
  ].join('\n'));

  if (done && job.skipped?.length > 0) {
    embed.addFields({
      name: `Bot が読めなかったチャンネル (${job.skipped.length})`,
      value: job.skipped.slice(0, 15).join(', ').slice(0, 1000)
    });
  }

  return embed;
}

// ---------------------------------------------------------------- /search

const searchCommand = {
  data: new SlashCommandBuilder()
    .setName('search')
    .setDescription('過去ログを検索します (OR / 除外 / 正規表現 / リアクション数などが使えます)')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) => option
      .setName('query')
      .setDescription('例: 会議 -中止 / "明日の予定" / (猫 OR 犬) has:image / regex:/^https?/')
      .setRequired(false))
    .addUserOption((option) => option
      .setName('from')
      .setDescription('投稿者で絞り込む')
      .setRequired(false))
    .addChannelOption((option) => option
      .setName('in')
      .setDescription('チャンネルで絞り込む (スレッドも含む)')
      .setRequired(false))
    .addStringOption((option) => option
      .setName('after')
      .setDescription('この日より後 (2024-05-01 / 2024-05 / 7d / today)')
      .setRequired(false))
    .addStringOption((option) => option
      .setName('before')
      .setDescription('この日より前 (2024-05-01 / 2024-05 / 7d)')
      .setRequired(false))
    .addStringOption((option) => option
      .setName('has')
      .setDescription('添付や種類で絞り込む')
      .setRequired(false)
      .addChoices(
        { name: 'link (URL入り)', value: 'link' },
        { name: 'image (画像)', value: 'image' },
        { name: 'video (動画)', value: 'video' },
        { name: 'file (添付あり)', value: 'file' },
        { name: 'embed (埋め込み)', value: 'embed' },
        { name: 'reaction (リアクションあり)', value: 'reaction' },
        { name: 'code (コードブロック)', value: 'code' }
      ))
    .addStringOption((option) => option
      .setName('sort')
      .setDescription('並び順')
      .setRequired(false)
      .addChoices(
        { name: '新しい順', value: 'new' },
        { name: '古い順', value: 'old' },
        { name: 'リアクションが多い順', value: 'reactions' },
        { name: '長い順', value: 'long' },
        { name: 'ランダム', value: 'random' }
      )),

  async execute(interaction) {
    if (!requireGuild(interaction)) return;

    if (!getGuildState(interaction.guildId)) {
      await interaction.reply({ embeds: [emptyArchiveEmbed()], flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();

    let options;
    try {
      options = await buildSearchOptions(interaction);

      if (!options.query && options.extra.length === 0) {
        await interaction.editReply({ content: '検索条件を1つ以上指定してください。使い方は `/searchhelp` で確認できます。' });
        return;
      }

      const total = countSearch(options);
      const label = describeQuery(options.query, options.extra);
      const { embed, pages } = renderSearchPage({ options, page: 0, total, label });

      const token = interaction.id;
      saveSession(token, { options, total, label, userId: interaction.user.id });

      await interaction.editReply({
        embeds: [embed],
        components: total > PAGE_SIZE ? [paginationRow(token, 0, pages)] : [],
        allowedMentions: NO_MENTIONS
      });
    } catch (error) {
      if (error instanceof QueryError) {
        await interaction.editReply({ content: queryErrorText(error) });
        return;
      }
      throw error;
    }
  }
};

// ---------------------------------------------------------------- /searchstats

const AGGREGATIONS = {
  author: { limit: 10, orderByKey: false, label: (row) => `<@${row.bucket}>`, title: '投稿者' },
  channel: { limit: 10, orderByKey: false, label: (row) => `<#${row.bucket}>`, title: 'チャンネル' },
  year: { limit: 20, orderByKey: 'asc', label: (row) => `\`${row.bucket}\``, title: '年別' },
  month: { limit: 24, orderByKey: 'desc', label: (row) => `\`${row.bucket}\``, title: '月別 (直近24ヶ月)' },
  day: { limit: 30, orderByKey: 'desc', label: (row) => `\`${row.bucket}\``, title: '日別 (直近30日)' },
  hour: { limit: 24, orderByKey: 'asc', label: (row) => `\`${String(row.bucket).padStart(2, '0')}時\``, title: '時間帯' },
  weekday: { limit: 7, orderByKey: 'asc', label: (row) => `\`${WEEKDAY_LABELS[row.bucket]}曜\``, title: '曜日' }
};

const searchStatsCommand = {
  data: new SlashCommandBuilder()
    .setName('searchstats')
    .setDescription('検索条件に一致したメッセージを集計します (誰が / どこで / いつ)')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) => option
      .setName('query')
      .setDescription('/search と同じ書き方が使えます')
      .setRequired(false))
    .addStringOption((option) => option
      .setName('by')
      .setDescription('集計軸 (省略時は投稿者)')
      .setRequired(false)
      .addChoices(
        { name: '投稿者', value: 'author' },
        { name: 'チャンネル', value: 'channel' },
        { name: '年別', value: 'year' },
        { name: '月別', value: 'month' },
        { name: '日別', value: 'day' },
        { name: '時間帯', value: 'hour' },
        { name: '曜日', value: 'weekday' }
      ))
    .addUserOption((option) => option.setName('from').setDescription('投稿者で絞り込む').setRequired(false))
    .addChannelOption((option) => option.setName('in').setDescription('チャンネルで絞り込む').setRequired(false))
    .addStringOption((option) => option.setName('after').setDescription('この日より後').setRequired(false))
    .addStringOption((option) => option.setName('before').setDescription('この日より前').setRequired(false)),

  async execute(interaction) {
    if (!requireGuild(interaction)) return;

    if (!getGuildState(interaction.guildId)) {
      await interaction.reply({ embeds: [emptyArchiveEmbed()], flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();

    try {
      const options = await buildSearchOptions(interaction);
      const by = interaction.options.getString('by') ?? 'author';
      const config = AGGREGATIONS[by] ?? AGGREGATIONS.author;

      const summary = searchSummary(options);

      if (!summary.count) {
        await interaction.editReply({ content: '該当するメッセージがありませんでした。' });
        return;
      }

      let rows = aggregateSearch(options, by, { limit: config.limit, orderByKey: config.orderByKey });
      if (config.orderByKey === 'desc') rows = rows.reverse();

      const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle(`📊 集計: ${config.title}`)
        .setDescription(`条件: \`${describeQuery(options.query, options.extra).slice(0, 200)}\``)
        .addFields(
          { name: 'ヒット数', value: formatNumber(summary.count), inline: true },
          { name: '人数', value: formatNumber(summary.authors), inline: true },
          { name: 'チャンネル数', value: formatNumber(summary.channels), inline: true },
          { name: '平均文字数', value: formatNumber(Math.round(summary.avg_length ?? 0)), inline: true },
          { name: 'リアクション合計', value: formatNumber(summary.reactions), inline: true },
          { name: '期間', value: `${shortDate(summary.first_at)} 〜 ${shortDate(summary.last_at)}`, inline: true },
          { name: config.title, value: formatRanking(rows, config.label).slice(0, 1024) || '該当なし' }
        );

      if (config.orderByKey) {
        embed.addFields({
          name: '推移',
          value: `\`${sparkline(rows.map((row) => row.count))}\``
        });
      }

      await interaction.editReply({ embeds: [embed], allowedMentions: NO_MENTIONS });
    } catch (error) {
      if (error instanceof QueryError) {
        await interaction.editReply({ content: queryErrorText(error) });
        return;
      }
      throw error;
    }
  }
};

// ---------------------------------------------------------------- /context

const contextCommand = {
  data: new SlashCommandBuilder()
    .setName('context')
    .setDescription('メッセージの前後を並べて表示します (検索結果の文脈を追うため)')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) => option
      .setName('message')
      .setDescription('メッセージのリンクか ID')
      .setRequired(true))
    .addIntegerOption((option) => option
      .setName('range')
      .setDescription('前後に表示する件数 (既定 4, 最大 10)')
      .setMinValue(1)
      .setMaxValue(10)
      .setRequired(false)),

  async execute(interaction) {
    if (!requireGuild(interaction)) return;

    const raw = interaction.options.getString('message');
    const ids = [...raw.matchAll(/\d{16,21}/g)].map((match) => match[0]);
    const messageId = ids[ids.length - 1];

    if (!messageId) {
      await interaction.reply({ content: 'メッセージのリンクか ID を指定してください。', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();

    const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
    const range = interaction.options.getInteger('range') ?? 4;
    const result = getContext(messageId, {
      before: range,
      after: range,
      channelScope: getChannelScope(interaction.guild, member)
    });

    if (!result || result.target.guild_id !== interaction.guildId) {
      await interaction.editReply({ content: 'そのメッセージはインデックスに無いか、閲覧権限がありません。' });
      return;
    }

    const line = (row, highlight) => {
      const body = excerpt(row.content || row.extra, [], 220);
      return highlight
        ? `**➤ <@${row.author_id}>** ${relativeTime(row.created_at)}\n> **${body}**`
        : `<@${row.author_id}> ${relativeTime(row.created_at)}\n> ${body}`;
    };

    const embed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle('🧵 前後の文脈')
      .setDescription([
        ...result.older.map((row) => line(row, false)),
        line(result.target, true),
        ...result.newer.map((row) => line(row, false))
      ].join('\n\n').slice(0, 4000))
      .setFooter({ text: '➤ が指定したメッセージ' })
      .addFields({ name: 'チャンネル', value: `<#${result.target.channel_id}> ・ [跳ぶ](${messageLink(result.target)})` });

    await interaction.editReply({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
};

// ---------------------------------------------------------------- /archivestats

const archiveStatsCommand = {
  data: new SlashCommandBuilder()
    .setName('archivestats')
    .setDescription('アーカイブ全体の傾向 (よく使われるリアクション / よく貼られるドメイン) を表示します')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) => option
      .setName('period')
      .setDescription('集計期間')
      .setRequired(false)
      .addChoices(
        { name: '全期間', value: 'all' },
        { name: '直近30日', value: '30d' },
        { name: '直近7日', value: '7d' }
      )),

  async execute(interaction) {
    if (!requireGuild(interaction)) return;

    if (!getGuildState(interaction.guildId)) {
      await interaction.reply({ embeds: [emptyArchiveEmbed()], flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();

    const period = interaction.options.getString('period') ?? 'all';
    const since = period === '7d'
      ? Date.now() - 7 * 86_400_000
      : period === '30d'
        ? Date.now() - 30 * 86_400_000
        : null;

    const emojis = topReactionEmojis(interaction.guildId, { limit: 10, since });
    const domains = topDomains(interaction.guildId, { limit: 10, since });

    const embed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle('📈 アーカイブの傾向')
      .setFooter({ text: period === 'all' ? '全期間' : `直近${period}` })
      .addFields(
        {
          name: 'よく付くリアクション',
          value: formatRanking(emojis.map((row) => ({ bucket: row.emoji, count: row.count })), (row) => row.bucket).slice(0, 1024) || '該当なし'
        },
        {
          name: 'よく貼られるドメイン',
          value: formatRanking(domains.map((row) => ({ bucket: row.domain, count: row.count })), (row) => `\`${row.bucket}\``).slice(0, 1024) || '該当なし'
        }
      );

    await interaction.editReply({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
};

// ---------------------------------------------------------------- /searchhelp

const searchHelpCommand = {
  data: new SlashCommandBuilder()
    .setName('searchhelp')
    .setDescription('検索クエリの書き方を表示します'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle('🔎 検索クエリの書き方')
      .setDescription('Discord 標準の検索ではできない、OR / 除外 / 括弧 / 正規表現 / 数値条件が使えます。')
      .addFields(
        {
          name: '基本',
          value: [
            '`会議 場所` … 両方を含む',
            '`"明日の会議"` … 空白込みでそのまま含む',
            '`会議 OR ミーティング` … どちらか',
            '`会議 -中止` … 中止を含まない',
            '`(猫 OR 犬) かわいい` … 括弧でまとめる'
          ].join('\n')
        },
        {
          name: '絞り込み',
          value: [
            '`from:@user` `in:#channel` `mentions:@user` `replyto:@user`',
            '`after:2024-05-01` `before:2024-06` `during:2024-05` `after:7d`',
            '`has:link|image|video|audio|file|embed|sticker|reaction|reply|code|mention`',
            '`is:bot|human|edited|pinned|reply|thread`'
          ].join('\n')
        },
        {
          name: 'Discord ではできない条件',
          value: [
            '`reactions:>5` … リアクションが5個より多い',
            '`reaction:👍` … 特定のリアクションが付いている',
            '`len:>200` `len:<10` … 文字数',
            '`hour:22-4` … 深夜帯の発言だけ',
            '`weekday:sat,sun` … 土日の発言だけ',
            '`domain:github.com` … 特定サイトのURLが貼られたもの',
            '`regex:/^\\d+$/` … 正規表現 (本文のみ。添付名や埋め込み文言は見ません)',
            '`regex:"/a b/i"` … 空白や `)` 単体を含むパターンは引用符で囲む'
          ].join('\n')
        },
        {
          name: '並び順',
          value: '`sort:new` `sort:old` `sort:reactions` `sort:long` `sort:random`'
        },
        {
          name: '組み合わせ例',
          value: [
            '`(バグ OR 不具合) in:#dev after:30d sort:reactions`',
            '`from:@me has:link domain:github.com`',
            '`regex:/^(?!.*http).{200,}/ hour:0-5`'
          ].join('\n')
        },
        {
          name: '関連コマンド',
          value: [
            '`/searchstats` … 同じ条件で「誰が/どこで/いつ」を集計',
            '`/context` … ヒットしたメッセージの前後を表示',
            '`/archivestats` … リアクション・ドメインの傾向'
          ].join('\n')
        }
      );

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
};

// ---------------------------------------------------------------- ボタン

export async function handleArchiveComponent(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('archive:')) return false;

  const [, action, ...rest] = interaction.customId.split(':');

  if (action === 'reset' || action === 'cancelreset') {
    if (rest[0] !== interaction.user.id) {
      await interaction.reply({ content: 'この操作は実行した本人だけができます。', flags: MessageFlags.Ephemeral });
      return true;
    }

    if (action === 'cancelreset') {
      await interaction.update({ content: 'キャンセルしました。', components: [] });
      return true;
    }

    purgeGuild(interaction.guildId);
    await interaction.update({ content: '🗑️ このサーバーのインデックスを削除しました。', components: [] });
    return true;
  }

  const token = rest[0];
  const session = sessions.get(token);

  if (!session || session.expiresAt <= Date.now()) {
    await interaction.reply({ content: 'この検索結果は古くなりました。もう一度 `/search` を実行してください。', flags: MessageFlags.Ephemeral });
    return true;
  }

  if (session.userId !== interaction.user.id) {
    await interaction.reply({ content: 'この検索を実行した本人だけがページを移動できます。', flags: MessageFlags.Ephemeral });
    return true;
  }

  try {
    if (action === 'shuffle') {
      const { rows, built } = search({ ...session.options, sort: 'random' }, { limit: 1, offset: 0 });
      if (rows.length === 0) {
        await interaction.reply({ content: '該当がありませんでした。', flags: MessageFlags.Ephemeral });
        return true;
      }

      const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('🎲 ランダムに1件')
        .setDescription(formatResult(rows[0], 1, built.terms));

      await interaction.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
      return true;
    }

    if (action === 'page') {
      const page = Math.max(0, Number(rest[1]) || 0);
      const { embed, pages } = renderSearchPage({
        options: session.options,
        page,
        total: session.total,
        label: session.label
      });

      await interaction.update({
        embeds: [embed],
        components: [paginationRow(token, page, pages)],
        allowedMentions: NO_MENTIONS
      });
      return true;
    }
  } catch (error) {
    if (error instanceof QueryError) {
      await interaction.reply({ content: queryErrorText(error), flags: MessageFlags.Ephemeral });
      return true;
    }
    throw error;
  }

  return false;
}

export const archiveCommands = [
  indexCommand,
  searchCommand,
  searchStatsCommand,
  contextCommand,
  archiveStatsCommand,
  searchHelpCommand
];
