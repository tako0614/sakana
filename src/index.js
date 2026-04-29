import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits
} from 'discord.js';
import { commandMap } from './commands.js';
import { handleEmotionRequest, isEmotionRequest } from './emotion.js';

const token = process.env.DISCORD_TOKEN;
const ossTargetUsername = process.env.OSS_TARGET_USERNAME ?? 'kurage.1';
const ossTriggerText = process.env.OSS_TRIGGER_TEXT ?? 'oss';
const ossResponseText = process.env.OSS_RESPONSE_TEXT ?? 'oss!';

if (!token) {
  console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and set your bot token.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) {
    return;
  }

  if (isEmotionRequest(message)) {
    await handleEmotionRequest(message);
    return;
  }

  if (message.author.username !== ossTargetUsername) {
    return;
  }

  if (message.content.trim().toLowerCase() !== ossTriggerText.toLowerCase()) {
    return;
  }

  try {
    await message.channel.send(ossResponseText);
  } catch (error) {
    console.error('Failed to send oss response:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = commandMap.get(interaction.commandName);
  if (!command) {
    await interaction.reply({
      content: 'Unknown command.',
      ephemeral: true
    });
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Failed to run /${interaction.commandName}:`, error);

    const response = {
      content: 'コマンド実行中にエラーが発生しました。',
      ephemeral: true
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(response);
    } else {
      await interaction.reply(response);
    }
  }
});

client.login(token);
