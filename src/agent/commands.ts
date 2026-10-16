// エージェントの使用量の確認と、上限の変更 (管理者用)。
//
// 上限を env だけで持つと、変えるたびに再起動が必要で、
// 「今いくら使っているのか」も分からない。実行中に見て触れるようにする。
//
// 表示も勘定も実際の請求額 (OpenRouter の usage.cost、USD)。モデルを選べるので
// 固定の単価でトークンを換算すると請求とずれる。単価と重みは、実費が返らなかった
// 古い記録を見積もるときだけ使う。

import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction
} from 'discord.js';

import { canManageIndex } from '../archive/permissions.js';
import { agentConfig } from './config.js';
import {
  TUNABLES,
  type TunableKey,
  getTunable,
  getUsage,
  grantDailyUsd,
  listGrants,
  listTunables,
  resetUsage,
  setTunable
} from './ratelimit.js';
import { AGENT_ENGINES } from './engines.js';

const KEY_LABELS: Record<TunableKey, string> = {
  user_daily_usd: '1人あたり/日 ($)',
  global_daily_usd: '全体/日 ($)',
  request_usd: '1リクエストの上限 ($)',
  price_in: '古い記録の見積もり用: 入力単価 ($/1Mトークン)',
  weight_cached: '古い記録の見積もり用: キャッシュ入力の重み',
  weight_output: '古い記録の見積もり用: 出力の重み',
  max_concurrent: '同時実行数'
};

function usageEmbed(userId: string): EmbedBuilder {
  const usage = getUsage(userId);
  const hours = Math.round(agentConfig.userWindowMs / 3_600_000);
  const window = hours === 24 ? '直近24時間' : `直近 ${hours} 時間`;

  const line = (used: number, limit: number): string => (
    limit > 0 ? `$${used.toFixed(3)} / $${limit.toFixed(2)}` : `$${used.toFixed(3)} / 無制限`
  );

  const embed = new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle('🧮 エージェントの使用量')
    .setDescription('上限も使用量も OpenRouter の実際の請求額 (USD)。モデルは /model で選ぶ: '
      + Object.entries(AGENT_ENGINES).map(([key, model]) => `${key} = \`${model}\``).join(' / '))
    .addFields(
      { name: `あなた (${window})`, value: line(usage.userUsd, usage.userLimitUsd), inline: true },
      { name: `全体 (${window})`, value: line(usage.globalUsd, usage.globalLimitUsd), inline: true },
      { name: '実行中', value: String(usage.running), inline: true }
    );

  // 上限に乗らないぶん (管理者・リセット済み) があると、上の数字は支出と一致しない。
  // ずれているときだけ実支出を出す (いつも出すと欄が2倍になって読みにくい)。
  const drift = usage.globalBilledUsd - usage.globalUsd;
  if (drift > 0.0005) {
    embed.addFields({
      name: `実支出 (${window}・上限には乗らないぶんを含む)`,
      value: `全体 $${usage.globalBilledUsd.toFixed(3)} / あなた $${usage.userBilledUsd.toFixed(3)}`
    });
  }

  embed.addFields({
    name: '設定',
    value: listTunables()
      .map((row) => `${KEY_LABELS[row.key] ?? row.key}: \`${row.value}\`${row.overridden ? ` (既定 ${row.defaultValue})` : ''}`)
      .join('\n')
  });

  // 1リクエストの上限 (実行中はこの額で道具を外して答えさせる)
  embed.addFields({ name: '1リクエストの暴走ガード', value: `$${getTunable('request_usd')}`, inline: true });

  const grants = listGrants();
  if (grants.length > 0) {
    embed.addFields({
      name: `個別に付与 (${grants.length})`,
      value: grants.map((row) => `<@${row.userId}> $${row.usd.toFixed(2)}`).join('\n').slice(0, 1000)
    });
  }

  embed.setFooter({
    text: '未初期化サーバーの管理者は金額上限を通りません。統治初期化後はManageGuildを信頼根拠にせず、設定した特別有権者ロールの回数枠を別に適用します。'
      + '金額は OpenRouter が返した実費。実費の返らなかった古い記録だけ単価と重みで見積もっています。'
  });

  return embed;
}

async function requireAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  // キャッシュ済みのサーバーなら GuildMember が載っている。載っていなければ取りに行く
  // (API の生のメンバーは permissions が文字列なので、そのままでは判定できない)。
  const member = interaction.inCachedGuild()
    ? interaction.member
    : (await interaction.guild?.members.fetch(interaction.user.id).catch(() => null)) ?? null;
  if (canManageIndex(member)) return true;

  await interaction.reply({
    content: '上限を変えられるのは「サーバー管理」権限を持つ人か、`ARCHIVE_ADMIN_USERS` に登録された人だけです。',
    allowedMentions: { parse: [] },
    flags: MessageFlags.Ephemeral
  });
  return false;
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
        .setDescription('上限や単価を変えます (管理者用)')
        .addStringOption((option) => option
          .setName('key')
          .setDescription('変える項目')
          .setRequired(true)
          .addChoices(...Object.keys(TUNABLES).map((key) => ({ name: key, value: key }))))
        .addNumberOption((option) => option
          .setName('value')
          .setDescription('新しい値。省略すると .env の既定に戻します')
          .setRequired(false)))
      .addSubcommand((sub) => sub
        .setName('grant')
        .setDescription('特定の人の1日上限を上げます (管理者用)')
        .addUserOption((option) => option
          .setName('user')
          .setDescription('対象')
          .setRequired(true))
        .addNumberOption((option) => option
          .setName('usd')
          .setDescription('1日あたりの上限 (ドル)。0 でその人だけ無制限')
          .setRequired(true)))
      .addSubcommand((sub) => sub
        .setName('revoke')
        .setDescription('個別の付与を取り消して既定に戻します (管理者用)')
        .addUserOption((option) => option
          .setName('user')
          .setDescription('対象')
          .setRequired(true)))
      .addSubcommand((sub) => sub
        .setName('reset')
        .setDescription('いまの使用量を消して上限を空けます (管理者用)')
        .addUserOption((option) => option
          .setName('user')
          .setDescription('この人だけ。省略すると全員')
          .setRequired(false))),

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
      const sub = interaction.options.getSubcommand();

      if (sub === 'show') {
        await interaction.reply({
          embeds: [usageEmbed(interaction.user.id)],
          allowedMentions: { parse: [] },
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (!await requireAdmin(interaction)) return;

      if (sub === 'reset') {
        const target = interaction.options.getUser('user');
        const cleared = resetUsage(target?.id ?? null);

        await interaction.reply({
          content: target
            ? `${target} の使用量を消しました (${cleared} 件)。記録は残っています。`
            : `全員の使用量を消しました (${cleared} 件)。記録は残っています。`,
          embeds: [usageEmbed(interaction.user.id)],
          allowedMentions: { parse: [] },
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (sub === 'grant' || sub === 'revoke') {
        // user は必須の項目なので必ず入っている
        const target = interaction.options.getUser('user', true);
        const usd = sub === 'grant' ? interaction.options.getNumber('usd') : null;

        if (!grantDailyUsd(target.id, usd, interaction.user.id)) {
          await interaction.reply({ content: `その値は使えません: ${usd}`, allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.reply({
          content: sub === 'grant'
            ? `${target} の1日上限を $${usd} にしました${usd === 0 ? ' (無制限)' : ''}。`
            : `${target} の付与を取り消して既定に戻しました。`,
          embeds: [usageEmbed(interaction.user.id)],
          allowedMentions: { parse: [] },
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const key = interaction.options.getString('key');
      const value = interaction.options.getNumber('value');

      // value 省略で既定に戻す。戻す手段が無いと怖くて触れない。
      if (!setTunable(key, value ?? null, interaction.user.id)) {
        await interaction.reply({ content: `その値は使えません: ${value}`, allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.reply({
        content: value === null || value === undefined
          ? `${key} を .env の既定に戻しました。`
          : `${key} を ${value} にしました。`,
        embeds: [usageEmbed(interaction.user.id)],
        allowedMentions: { parse: [] },
        flags: MessageFlags.Ephemeral
      });
    }
  }
];
