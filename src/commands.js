import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getTopXP, getUserRank } from './db.js';

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('top')
      .setDescription('サーバーのスコアランキングを表示します。')
      .addStringOption(option => 
        option.setName('type')
          .setDescription('確認したいランキングの種類 (text/voice)')
          .setRequired(false)
          .addChoices(
            { name: 'text', value: 'text' },
            { name: 'voice', value: 'voice' },
            { name: 'all', value: 'all' }
          ))
      .addStringOption(option => 
        option.setName('period')
          .setDescription('確認したい期間 (day/week/month/all)')
          .setRequired(false)
          .addChoices(
            { name: 'day (1日)', value: 'day' },
            { name: 'week (1週間)', value: 'week' },
            { name: 'month (1ヶ月)', value: 'month' },
            { name: 'all (全期間)', value: 'all' }
          )),
    async execute(interaction) {
      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      
      if (!guildId) {
        return interaction.reply({ content: 'このコマンドはサーバー内でのみ使用できます。', ephemeral: true });
      }

      // オプションの取得（デフォルトは両方表示の全期間）
      const type = interaction.options.getString('type') || 'all';
      const period = interaction.options.getString('period') || 'all';

      // 期間の表示用文字
      const periodLabel = period === 'day' ? '(Past 24h)' : period === 'week' ? '(Past 7d)' : period === 'month' ? '(Past 30d)' : '';

      // ランキング表示用のフィールド値を生成するヘルパー
      const buildFieldValue = (topList, userRank, listType) => {
        if (topList.length === 0) {
          // 誰もいない場合は「該当なし」＋自分の行（元の挙動を維持）
          const userLine = `**#${userRank.rank} | <@${userId}> XP:** \`${userRank.xp}\``;
          return `該当なし\n${userLine}`;
        }

        const isInTop = topList.some(u => u.id === userId);
        const formattedList = topList.map((user, i) => {
          const entry = `#${i + 1} | <@${user.id}> XP: \`${user.xp}\``;
          // 自分がTOP Nにいる場合は太字に
          return user.id === userId ? `**${entry}**` : entry;
        }).join('\n');

        if (isInTop) {
          // TOP N内にいるので追加行は不要
          return formattedList;
        } else {
          // TOP N外なので末尾に自分の行を追加
          const userLine = `**#${userRank.rank} | <@${userId}> XP:** \`${userRank.xp}\``;
          return `${formattedList}\n${userLine}`;
        }
      };

      const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle(`📋 Guild Score Leaderboards ${periodLabel}`.trim());

      if (type === 'all' || type === 'text') {
        const limit = type === 'text' ? 10 : 5; // textのみ指定時は10件表示
        const topText = getTopXP(guildId, 'text', period, limit);
        const userText = getUserRank(guildId, userId, 'text', period);

        embed.addFields({
          name: 'TOP TEXT 💬',
          value: buildFieldValue(topText, userText),
          inline: type === 'all'
        });
      }

      if (type === 'all' || type === 'voice') {
        const limit = type === 'voice' ? 10 : 5; // voiceのみ指定時は10件表示
        const topVoice = getTopXP(guildId, 'voice', period, limit);
        const userVoice = getUserRank(guildId, userId, 'voice', period);
        embed.addFields({
          name: 'TOP VOICE 🎙️',
          value: buildFieldValue(topVoice, userVoice),
          inline: type === 'all'
        });
      }

      await interaction.reply({ embeds: [embed] });
    }
  }
];

export const commandData = commands.map((command) => command.data.toJSON());
export const commandMap = new Map(commands.map((command) => [command.data.name, command]));
