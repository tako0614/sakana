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

      // 上位リストを文字列に整形する関数
      const formatTopList = (list) => {
        if (list.length === 0) return '該当なし';
        return list.map((user, i) => `#${i + 1} | <@${user.id}> XP: \`${user.xp}\``).join('\n');
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
          value: [
            formatTopList(topText),
            `**#${userText.rank} | <@${userId}> XP:** \`${userText.xp}\``
          ].join('\n'),
          inline: type === 'all'
        });
      }

      if (type === 'all' || type === 'voice') {
        const limit = type === 'voice' ? 10 : 5; // voiceのみ指定時は10件表示
        const topVoice = getTopXP(guildId, 'voice', period, limit);
        const userVoice = getUserRank(guildId, userId, 'voice', period);

        embed.addFields({
          name: 'TOP VOICE 🎙️',
          value: [
            formatTopList(topVoice),
            `**#${userVoice.rank} | <@${userId}> XP:** \`${userVoice.xp}\``
          ].join('\n'),
          inline: type === 'all'
        });
      }

      await interaction.reply({ embeds: [embed] });
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Bot の応答速度を確認します。'),
    async execute(interaction) {
      const sent = await interaction.reply({
        content: 'Pinging...',
        fetchReply: true
      });

      const latency = sent.createdTimestamp - interaction.createdTimestamp;
      await interaction.editReply(`Pong! ${latency}ms`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('echo')
      .setDescription('入力したメッセージをそのまま返します。')
      .addStringOption((option) =>
        option
          .setName('text')
          .setDescription('返してほしいテキスト')
          .setRequired(true)
      ),
    async execute(interaction) {
      const text = interaction.options.getString('text', true);
      await interaction.reply(text);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('help')
      .setDescription('使えるコマンドを表示します。'),
    async execute(interaction) {
      await interaction.reply([
        '**Commands**',
        '`/ping` - Bot の応答速度を確認',
        '`/echo text:<message>` - メッセージを返す',
        '`/help` - このヘルプを表示'
      ].join('\n'));
    }
  }
];

export const commandData = commands.map((command) => command.data.toJSON());
export const commandMap = new Map(commands.map((command) => [command.data.name, command]));
