import { SlashCommandBuilder } from 'discord.js';

export const commands = [
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
