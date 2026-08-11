// エージェントの使用量の確認と、上限の変更 (管理者用)。
//
// 上限を env だけで持つと、変えるたびに再起動が必要で、
// 「今いくら使っているのか」も分からない。実行中に見て触れるようにする。

import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { canManageIndex } from '../archive/permissions.js';
import { agentConfig } from './config.js';
import { TUNABLES, getUsage, listTunables, setTunable } from './ratelimit.js';

const KEY_LABELS = {
  user_token_limit: '1人あたりの上限 (換算トークン / 窓)',
  global_token_limit: '全体の上限 (換算トークン / 窓)',
  max_concurrent: '同時実行数',
  weight_input: '重み: 入力 (キャッシュミス)',
  weight_cached: '重み: 入力 (キャッシュヒット)',
  weight_output: '重み: 出力'
};

function formatAmount(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value * 100) / 100);
}

function usageEmbed(userId) {
  const usage = getUsage(userId);
  const userHours = Math.round(agentConfig.userWindowMs / 3_600_000);
  const globalHours = Math.round(agentConfig.globalWindowMs / 3_600_000);

  const embed = new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle('🧮 エージェントの使用量')
    .setDescription([
      '数えているのは呼び出し回数ではなく「換算トークン」。',
      '入力・キャッシュヒット・出力で単価が違うので、重みを掛けて合算している。'
    ].join(''))
    .addFields(
      {
        name: `あなた (直近 ${userHours} 時間)`,
        value: `${formatAmount(usage.user)} / ${formatAmount(usage.userLimit)}`,
        inline: true
      },
      {
        name: `全体 (直近 ${globalHours} 時間)`,
        value: `${formatAmount(usage.global)} / ${formatAmount(usage.globalLimit)}`,
        inline: true
      },
      { name: '実行中', value: String(usage.running), inline: true }
    );

  embed.addFields({
    name: '上限と重み',
    value: listTunables()
      .map((row) => `${KEY_LABELS[row.key] ?? row.key}: \`${row.value}\`${row.overridden ? ` (既定 ${row.defaultValue})` : ''}`)
      .join('\n')
  });

  return embed;
}

export const agentCommands = [
  {
    data: new SlashCommandBuilder()
      .setName('agentlimit')
      .setDescription('エージェントの使用量を見る / 上限を変える')
      // /index と同じ理由で可視性は開けて、実行可否は execute 側で判定する
      // (default_member_permissions で絞ると許可リストの人からも見えなくなる)。
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((sub) => sub
        .setName('show')
        .setDescription('いまの使用量と上限を表示します'))
      .addSubcommand((sub) => sub
        .setName('set')
        .setDescription('上限や重みを変えます (管理者用)')
        .addStringOption((option) => option
          .setName('key')
          .setDescription('変える項目')
          .setRequired(true)
          .addChoices(...Object.keys(TUNABLES).map((key) => ({ name: key, value: key }))))
        .addNumberOption((option) => option
          .setName('value')
          .setDescription('新しい値。省略すると .env の既定に戻します')
          .setRequired(false))),

    async execute(interaction) {
      const sub = interaction.options.getSubcommand();

      if (sub === 'show') {
        await interaction.reply({
          embeds: [usageEmbed(interaction.user.id)],
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
      if (!canManageIndex(member)) {
        await interaction.reply({
          content: '上限を変えられるのは「サーバー管理」権限を持つ人か、`ARCHIVE_ADMIN_USERS` に登録された人だけです。',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const key = interaction.options.getString('key');
      const value = interaction.options.getNumber('value');

      // value 省略で既定に戻す。戻す手段が無いと怖くて触れない。
      const ok = setTunable(key, value ?? null, interaction.user.id);
      if (!ok) {
        await interaction.reply({ content: `その値は使えません: ${value}`, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.reply({
        content: value === null || value === undefined
          ? `${key} を .env の既定に戻しました。`
          : `${key} を ${value} にしました。`,
        embeds: [usageEmbed(interaction.user.id)],
        flags: MessageFlags.Ephemeral
      });
    }
  }
];
