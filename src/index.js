import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  EmbedBuilder,
  MessageFlags,
  Partials
} from 'discord.js';
import cron from 'node-cron';
import { commandMap } from './commands.js';
import { enforceGuildAllowlist, isAllowedGuild } from './guilds.js';
import { handleEmotionRequest, isEmotionRequest } from './emotion.js';
import { addTextXP, addVoiceXP, getTopXP } from './db.js';
import { handleArchiveComponent } from './archive/commands.js';
import {
  catchupAllGuilds,
  indexLiveEdit,
  indexLiveMessage,
  markLiveDelete,
  resetCatchup,
  syncLiveReactions
} from './archive/indexer.js';
import { handleAgentRequest, isAgentRequest } from './agent/index.js';
import { agentEnabled } from './agent/config.js';
import { sweepStaleIndicators } from './agent/indicators.js';
import { pruneCalls } from './agent/ratelimit.js';
import { sweepEnabledGuilds } from './archive/embed-job.js';
import { embedConfig } from './embed/config.js';
import { governanceConfig } from './governance/config.js';
import { handleGovernanceComponent } from './governance/commands.js';
import { handleGovernanceMention } from './governance/intake.js';
import { deleteActivity } from './governance/db.js';
import {
  onGuildChannelCreate,
  onGuildRoleDelete,
  onTrustedRoleChange,
  recordCourtSubmission,
  recordCourtSubmissionEdit,
  recordGovernanceMessage,
  detectAutomaticEnforcement,
  runGovernanceScheduler
} from './governance/service.js';
import {
  enforceMessageRestrictions,
  enforceReactionRestrictions,
  enforceThreadRestrictions,
  enforceVoiceRestrictions
} from './governance/restrictions.js';

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
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ],
  // 編集/削除/リアクションはキャッシュに無いメッセージにも届くので partial を有効にする
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Closing the Discord connection.`);

  const forcedExit = setTimeout(() => {
    console.error('Graceful shutdown timed out.');
    process.exit(1);
  }, 15_000);
  forcedExit.unref();

  try {
    await client.destroy();
    clearTimeout(forcedExit);
    process.exit(0);
  } catch (error) {
    console.error('Graceful shutdown failed:', error);
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

client.on('shardError', (error) => {
  console.error('Discord shard error:', error);
});

// 切断した時点で「連続して繋がっている」保証が切れる。
// 以降の新着で区間を伸ばすと、切れていた間の穴を取ったことにしてしまうので、
// 追いつき済みの印を捨てて再接続後のキャッチアップに任せる。
client.on(Events.ShardDisconnect, () => {
  console.log('Shard disconnected. Coverage tracking will re-verify on reconnect.');
  resetCatchup();
});

client.on(Events.ShardReconnecting, () => {
  resetCatchup();
});

// 再接続 (resume ではなく再 identify) のあとは取りこぼしを取りに行く
client.on(Events.ShardReady, () => {
  catchupAllGuilds(client).catch((error) => {
    console.error('Catch-up after reconnect failed:', error);
  });
});

// 招待された瞬間に退出する。許可外のサーバーには何も残さない。
client.on(Events.GuildCreate, (guild) => {
  enforceGuildAllowlist(guild.client).catch((error) => {
    console.error('Failed to enforce the guild allowlist:', error);
  });
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(
    agentEnabled
      ? 'AI agent is enabled. Mention the bot to use it.'
      : 'DEEPSEEK_API_KEY is not set. The AI agent is disabled.'
  );

  // 許可していないサーバーに入っていたら出る
  enforceGuildAllowlist(readyClient).catch((error) => {
    console.error('Failed to enforce the guild allowlist:', error);
  });

  // 前回落ちたときに消し損ねた「thinking」を片付ける。
  // 残すとチャンネルに経過表示が出たまま積み上がる。
  sweepStaleIndicators(readyClient).catch((error) => {
    console.error('Failed to clean up leftover thinking indicators:', error);
  });

  // 古い呼び出し履歴を毎日掃除する (制限の窓より十分長く残す)
  cron.schedule('0 30 4 * * *', () => pruneCalls());

  // 意味検索のベクトルを夜間に追随させる。
  // on-write にすると 1GiB の Python を24時間常駐させ、MessageCreate の
  // ホットパスに往復を足すことになるので、まとめて夜にやる。
  cron.schedule(embedConfig.sweepCron, () => {
    sweepEnabledGuilds(readyClient).catch((error) => {
      console.error('Embed sweep failed:', error);
    });
  });

  // 落ちていた間に流れたメッセージを取りに行く。
  // live indexing は追いつくまで区間を伸ばさないので、ここで埋めないと
  // 停止していた期間が穴のまま残る。時間がかかるので待たない。
  catchupAllGuilds(readyClient).catch((error) => {
    console.error('Catch-up failed:', error);
  });

  if (governanceConfig.enabled) {
    const run = () => runGovernanceScheduler(readyClient).catch((error) => {
      console.error('Governance scheduler failed:', error);
    });
    run();
    const timer = setInterval(run, Math.max(10_000, governanceConfig.schedulerIntervalMs));
    timer.unref();
  }

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
        .send(`<@${member.id}> さん\nEvex Developersへようこそ！\nここで自己紹介してって言ってほしいかも\nhttps://discord.com/channels/1255359848644608035/1445478071221223515`)
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
  // 許可外のサーバーでは記録も応答もしない (退出が効くまでの間も含めて)
  if (!message.guildId || !isAllowedGuild(message.guildId)) {
    return;
  }

  // インデックス済みのサーバーなら、新しい発言もそのままアーカイブに足していく。
  // bot の発言も検索対象にしたいのでここで先に呼ぶ。
  indexLiveMessage(message);

  if (message.author.bot) {
    // AIだけのコミュニティではbotの通常会話も立法上の事実資料になる。
    // 統治面の公式投稿はrecordGovernanceMessage側で除外し、botを自動処罰の対象にはしない。
    if (governanceConfig.enabled) {
      recordGovernanceMessage(message);
      if (message.author.id !== client.user.id && await handleGovernanceMention(message)) return;
    }
    return;
  }

  // 制裁はXP・活動資格・AI呼び出しより先に適用する。削除対象の発言が投票資格へ
  // 混ざったり、制限中の依頼がモデルまで届いたりしないようにする。
  if (governanceConfig.enabled && await enforceMessageRestrictions(message)) return;
  if (governanceConfig.enabled) {
    const courtResult = await recordCourtSubmission(message);
    // 上訴制限で削除した投稿をXP・活動記録・通常agentへ流さない。
    if (courtResult === 'blocked') return;
    const activityRecorded = recordGovernanceMessage(message);
    if (activityRecorded) {
      await detectAutomaticEnforcement(message).catch((error) => {
        console.error('Automatic governance enforcement failed:', error);
      });
    }
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

  // @通報 は一般agentより先に、権限を持たない構造化受付へ渡す。
  // role mentionを一般会話の文脈として解釈させると、統治操作との境界が曖昧になる。
  if (governanceConfig.enabled && await handleGovernanceMention(message)) {
    return;
  }

  // @bot と直接メンションされたら AI エージェントに渡す。
  if (isAgentRequest(message, client)) {
    await handleAgentRequest(message, client);
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

client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
  try {
    if (!isAllowedGuild(newMessage.guildId)) return;
    const message = newMessage.partial ? await newMessage.fetch() : newMessage;
    indexLiveEdit(message);
    if (governanceConfig.enabled) {
      deleteActivity(message.id);
      if (message.author.bot) {
        recordGovernanceMessage(message);
        return;
      }
      if (await enforceMessageRestrictions(message)) return;
      const courtResult = await recordCourtSubmissionEdit(message);
      if (courtResult === 'blocked') return;
      recordGovernanceMessage(message);
    }
  } catch (error) {
    console.error('Unhandled error in message update handler:', error);
  }
});

client.on(Events.MessageDelete, (message) => {
  try {
    if (!isAllowedGuild(message.guildId)) return;
    markLiveDelete(message);
    if (governanceConfig.enabled) deleteActivity(message.id);
  } catch (error) {
    console.error('Unhandled error in message delete handler:', error);
  }
});

client.on(Events.MessageBulkDelete, (messages) => {
  try {
    for (const message of messages.values()) {
      if (!isAllowedGuild(message.guildId)) continue;
      markLiveDelete(message);
      if (governanceConfig.enabled) deleteActivity(message.id);
    }
  } catch (error) {
    console.error('Unhandled error in bulk delete handler:', error);
  }
});

async function handleReactionChange(reaction) {
  try {
    if (!isAllowedGuild(reaction.message?.guildId)) return;
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    await syncLiveReactions(message);
  } catch (error) {
    console.error('Unhandled error in reaction handler:', error);
  }
}

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (governanceConfig.enabled && await enforceReactionRestrictions(reaction, user)) return;
    await handleReactionChange(reaction);
  } catch (error) {
    console.error('Unhandled error in reaction add handler:', error);
  }
});
client.on(Events.MessageReactionRemove, (reaction) => handleReactionChange(reaction));
client.on(Events.MessageReactionRemoveEmoji, (reaction) => handleReactionChange(reaction));
client.on(Events.MessageReactionRemoveAll, (message) => handleReactionChange({ message }));

// 通話の入退室時間を記録するMap
const voiceSessions = new Map(); // guildId-userId -> timestamp

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    if (governanceConfig.enabled && await enforceVoiceRestrictions(oldState, newState)) return;
    handleVoiceStateUpdate(oldState, newState);
  } catch (error) {
    console.error('Unhandled error in voice state handler:', error);
  }
});

function handleVoiceStateUpdate(oldState, newState) {
  const memberId = newState.member?.id;
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!memberId || !guildId || newState.member?.user.bot) return;
  if (!isAllowedGuild(guildId)) return;

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
  if (!isAllowedGuild(interaction.guildId)) {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: 'この bot は許可されたサーバーでのみ動きます。',
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
    return;
  }

  const governanceComponent = interaction.isButton()
    || interaction.isModalSubmit()
    || interaction.isRoleSelectMenu()
    || interaction.isUserSelectMenu();
  if (governanceComponent && governanceConfig.enabled && await handleGovernanceComponent(interaction)) return;

  if (interaction.isButton()) {
    await handleArchiveComponent(interaction);
    return;
  }
  if (governanceComponent) return;

  // 補完は isChatInputCommand() が false なので、下の分岐まで来ると黙って落ちる。
  // 候補が出ないだけで理由が表示されないので、ここで先に捌く。
  if (interaction.isAutocomplete()) {
    const target = commandMap.get(interaction.commandName);
    if (target?.autocomplete) {
      try {
        await target.autocomplete(interaction);
      } catch (error) {
        console.error(`Autocomplete failed for /${interaction.commandName}:`, error);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = commandMap.get(interaction.commandName);
  if (!command) {
    await interaction.reply({
      content: 'Unknown command.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Failed to run /${interaction.commandName}:`, error);

    const response = {
      content: 'コマンド実行中にエラーが発生しました。',
      flags: MessageFlags.Ephemeral
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

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  if (!governanceConfig.enabled || !isAllowedGuild(newMember.guild.id)) return;
  onTrustedRoleChange(oldMember, newMember).catch((error) => {
    console.error('Failed to audit trusted role change:', error);
  });
});

client.on(Events.ChannelCreate, (channel) => {
  if (!governanceConfig.enabled || !isAllowedGuild(channel.guildId)) return;
  onGuildChannelCreate(channel).catch((error) => {
    console.error('Failed to sync governance channel permissions:', error);
  });
});

client.on(Events.GuildRoleDelete, (role) => {
  if (!governanceConfig.enabled || !isAllowedGuild(role.guild.id)) return;
  onGuildRoleDelete(role).catch((error) => {
    console.error('Failed to fail-close after trusted role deletion:', error);
  });
});

client.on(Events.ThreadCreate, (thread) => {
  if (!governanceConfig.enabled || !isAllowedGuild(thread.guildId)) return;
  enforceThreadRestrictions(thread).catch((error) => {
    console.error('Failed to enforce thread restriction:', error);
  });
});

client.login(token);
