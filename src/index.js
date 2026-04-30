import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  EmbedBuilder
} from 'discord.js';
import cron from 'node-cron';
import { commandMap } from './commands.js';
import { handleEmotionRequest, isEmotionRequest } from './emotion.js';
import { addTextXP, addVoiceXP, getTopXP } from './db.js';

const token = process.env.DISCORD_TOKEN;
const ossTargetUsername = process.env.OSS_TARGET_USERNAME ?? 'kurage.1';
const ossTriggerText = process.env.OSS_TRIGGER_TEXT ?? 'oss';
const ossResponseText = process.env.OSS_RESPONSE_TEXT ?? 'oss!';
const leaderboardChannelId = process.env.LEADERBOARD_CHANNEL_ID; // 毎日送信するチャンネルIDを指定

if (!token) {
  console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and set your bot token.');
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ]
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

client.on('shardError', (error) => {
  console.error('Discord shard error:', error);
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  // 毎日0時00分20秒に特定のチャンネルへランキングを送信
  cron.schedule('20 0 0 * * *', async () => {
    try {
      if (!leaderboardChannelId) {
        console.log('LEADERBOARD_CHANNEL_ID is not set in .env. Skipping daily leaderboard.');
        return;
      }

      const channel = await client.channels.fetch(leaderboardChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;

      const guildId = channel.guildId;

      // 期間は 'all' ではなく 'day' を指定して24時間のランキングを送信する
      const topText = getTopXP(guildId, 'text', 'day', 5);
      const topVoice = getTopXP(guildId, 'voice', 'day', 5);

      const formatTopList = (list) => {
        if (list.length === 0) return '該当なし';
        return list.map((user, i) => `#${i + 1} | <@${user.id}> XP: \`${user.xp}\``).join('\n');
      };

      const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('📋 Daily Guild Score Leaderboards (Past 24h)')
        .addFields(
          {
            name: 'TOP 5 TEXT 💬',
            value: formatTopList(topText) || '該当なし',
            inline: true
          },
          {
            name: 'TOP 5 VOICE 🎙️',
            value: formatTopList(topVoice) || '該当なし',
            inline: true
          }
        );

      await channel.send({ embeds: [embed] }).catch(console.error);
    } catch (error) {
      console.error('Failed to send daily leaderboard:', error);
    }
  });
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await handleGuildMemberAdd(member);
  } catch (error) {
    console.error('Unhandled error in guild member add handler:', error);
  }
});

async function handleGuildMemberAdd(member) {
  const targetGuildId = '1255359848644608035';
  const targetChannelId = '1487488490697658408';

  if (member.guild.id === targetGuildId) {
    const channel = await member.guild.channels.fetch(targetChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      await channel
        .send(`<@${member.id}> さん\nEvex Developersへようこそ！\nここで自己紹介してって言ってほしいかも`)
        .catch((error) => {
          console.error('Failed to send welcome message:', error);
        });
    }
  }
}

const textCooldowns = new Map(); // guildId-userId -> timestamp

client.on(Events.MessageCreate, async (message) => {
  try {
    await handleMessageCreate(message);
  } catch (error) {
    console.error('Unhandled error in message handler:', error);
  }
});

async function handleMessageCreate(message) {
  if (message.author.bot || !message.guildId) {
    return;
  }

  // メッセージ送信時にText XPを付与 (ProBot仕様: 1分に1回, 15〜25XPをランダム付与)
  const now = Date.now();
  const cooldownKey = `${message.guildId}-${message.author.id}`;
  const lastTextTime = textCooldowns.get(cooldownKey) || 0;

  if (now - lastTextTime >= 60000) {
    const xp = Math.floor(Math.random() * 11) + 15; // 15〜25のランダム値
    addTextXP(message.guildId, message.author.id, xp);
    textCooldowns.set(cooldownKey, now);
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
}

// 通話の入退室時間を記録するMap
const voiceSessions = new Map(); // guildId-userId -> timestamp

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  try {
    handleVoiceStateUpdate(oldState, newState);
  } catch (error) {
    console.error('Unhandled error in voice state handler:', error);
  }
});

function handleVoiceStateUpdate(oldState, newState) {
  const memberId = newState.member?.id;
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!memberId || !guildId || newState.member?.user.bot) return;

  const joined = !oldState.channelId && newState.channelId;
  const left = oldState.channelId && !newState.channelId;
  const switched = oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId;

  const sessionKey = `${guildId}-${memberId}`;

  if (joined || (switched && !voiceSessions.has(sessionKey))) {
    // 参加時にタイムスタンプを記録
    voiceSessions.set(sessionKey, Date.now());
  } else if (left) {
    // 退出時に滞在時間からVoice XPを計算して付与
    const joinTime = voiceSessions.get(sessionKey);
    if (joinTime) {
      const durationMs = Date.now() - joinTime;
      const minutes = Math.floor(durationMs / 60000);
      if (minutes > 0) {
        // ProBot風: 1分ごとに15〜25のXPを計算して合算
        let totalXP = 0;
        for (let i = 0; i < minutes; i++) {
          totalXP += Math.floor(Math.random() * 11) + 15;
        }
        addVoiceXP(guildId, memberId, totalXP);
      }
      voiceSessions.delete(sessionKey);
    }
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteractionCreate(interaction);
  } catch (error) {
    console.error('Unhandled error in interaction handler:', error);
  }
});

async function handleInteractionCreate(interaction) {
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

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(response);
      } else {
        await interaction.reply(response);
      }
    } catch (replyError) {
      console.error(`Failed to send /${interaction.commandName} error response:`, replyError);
    }
  }
}

client.login(token);
