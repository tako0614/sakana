import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getTopText, getTopVoice, getUserTextRank, getUserVoiceRank } from './db.js';

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('top')
      .setDescription('サーバーのスコアランキングを表示します。'),
    async execute(interaction) {
      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      
      if (!guildId) {
        return interaction.reply({ content: 'このコマンドはサーバー内でのみ使用できます。', ephemeral: true });
      }

      // DBから上位とユーザーのランクを取得
      const topText = getTopText(guildId, 5);
      const topVoice = getTopVoice(guildId, 5);
      const userText = getUserTextRank(guildId, userId);
      const userVoice = getUserVoiceRank(guildId, userId);

      // 上位リストを文字列に整形する関数
      const formatTopList = (list, xpKey) => {
        if (list.length === 0) return '該当なし';
        return list.map((user, i) => `#${i + 1} | <@${user.id}> XP: \`${user[xpKey]}\``).join('\n');
      };

      const textValue = [
        formatTopList(topText, 'xp_text'),
        `**#${userText.rank} | <@${userId}> XP:** \`${userText.xp}\``,
        '✨ **More?** `/top text`'
      ].join('\n');

      const voiceValue = [
        formatTopList(topVoice, 'xp_voice'),
        `**#${userVoice.rank} | <@${userId}> XP:** \`${userVoice.xp}\``,
        '✨ **More?** `/top voice`'
      ].join('\n');

      const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('📋 Guild Score Leaderboards')
        .addFields(
          {
            name: 'TOP 5 TEXT 💬',
            value: textValue,
            inline: true
          },
          {
            name: 'TOP 5 VOICE 🎙️',
            value: voiceValue,
            inline: true
          }
        );

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
