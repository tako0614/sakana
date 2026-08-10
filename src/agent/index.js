// メンションで呼ばれる AI エージェント。
//
//   @bot この議論まとめて
//   @bot どっちが正しい？        (口論しているメッセージにリプライしつつ)
//   @bot たこが前に言ってた実装方針どこ？
//
// 呼ばれた時点で直近の会話を渡してしまうので、多くの場合ツールを1回も呼ばずに答える。

import { AttachmentBuilder } from 'discord.js';
import { getChannelScope } from '../archive/permissions.js';
import { agentConfig, agentEnabled } from './config.js';
import {
  RefTable,
  chunkForDiscord,
  expandCitations,
  fromDiscordMessage
} from './format.js';
import { runAgent } from './llm.js';
import { buildSystemPrompt, buildUserContent } from './prompt.js';
import { finalizeCall, releaseCall, reserveCall } from './ratelimit.js';
import { ThinkingIndicator } from './thinking.js';
import { buildToolset } from './tools.js';

const NO_MENTIONS = { parse: [], repliedUser: false };

// エージェントが投稿した回答の ID。これへのリプライを会話の続きとして扱う。
// リプライ元をいちいち fetch すると、返信のたびに API を1回叩くことになるので、
// 自分が送ったものだけ覚えておいて突き合わせる。
const OWN_REPLY_LIMIT = 500;
const ownReplies = new Set();

function rememberOwnReply(messageId) {
  if (!messageId) return;
  ownReplies.add(messageId);
  // 古いものから落とす (Set は挿入順を保つ)
  while (ownReplies.size > OWN_REPLY_LIMIT) {
    ownReplies.delete(ownReplies.values().next().value);
  }
}

/**
 * 入口は2つ。
 *   1. bot への直接メンション
 *   2. エージェントの回答へのリプライ (会話の続き)
 * @everyone / ロールメンション / リプライの自動メンションでは起動しない。
 */
export function isAgentRequest(message, client) {
  if (!agentEnabled) return false;
  if (!message.guildId || message.author?.bot) return false;
  if (!client.user) return false;

  const mentioned = message.mentions.has(client.user, {
    ignoreDirect: false,
    ignoreRoles: true,
    ignoreEveryone: true,
    ignoreRepliedUser: true
  });

  if (mentioned) return true;

  // エージェントの回答へのリプライなら、メンション無しでも続きとして扱う。
  const repliedTo = message.reference?.messageId;
  if (!repliedTo) return false;

  if (ownReplies.has(repliedTo)) return true;

  // 再起動を挟むと ownReplies は空になる。リプライの通知が付いていれば
  // それで bot 宛だと分かるので、そちらも見る (追加の API 呼び出しは無し)。
  return message.mentions.repliedUser?.id === client.user.id;
}

function stripMention(content, clientId) {
  return String(content ?? '')
    .replace(new RegExp(`<@!?${clientId}>`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canUseFullBrowser(member) {
  if (agentConfig.browserFullForAll) return true;
  if (agentConfig.browserTrustedUsers.includes(member.id)) return true;
  return Boolean(member.permissions?.has('ManageGuild'));
}

function limitMessage(reservation) {
  if (reservation.scope === 'busy') {
    return 'いま他の人の質問を処理中です。少し待ってからもう一度呼んでください。';
  }

  const at = `<t:${Math.floor(reservation.retryAt / 1000)}:R>`;
  const hours = Math.round(reservation.windowMs / 3_600_000);

  return reservation.scope === 'user'
    ? `呼び出しの上限に達しました (1人あたり ${hours} 時間で ${reservation.limit} 回)。${at} に空きます。`
    : `サーバー全体の上限に達しました (${hours} 時間で ${reservation.limit} 回)。${at} に空きます。`;
}

async function fetchRecent(channel, excludeId, limit) {
  if (limit <= 0 || typeof channel.messages?.fetch !== 'function') return [];

  try {
    const fetched = await channel.messages.fetch({ limit: Math.min(limit + 1, 100) });
    return [...fetched.values()]
      .filter((message) => message.id !== excludeId)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-limit)
      .map((message) => fromDiscordMessage(message, channel.name));
  } catch (error) {
    console.error('Failed to preload recent messages:', error);
    return [];
  }
}

export async function handleAgentRequest(message, client) {
  const guild = message.guild;
  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);

  if (!member) return;

  const reservation = reserveCall({
    guildId: guild.id,
    channelId: message.channelId,
    userId: message.author.id
  });

  if (!reservation.ok) {
    await message.reply({ content: limitMessage(reservation), allowedMentions: NO_MENTIONS })
      .catch(() => {});
    return;
  }

  // ここから先は必ず try の中で組み立てる。
  // 確保した枠を返さずに抜けると、同時実行の空きと呼び出し回数が永久に戻らない。
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), agentConfig.timeoutMs);

  let finished = false;
  let indicator = null;

  try {
    const refs = new RefTable();
    const ctx = {
      client,
      guild,
      channel: message.channel,
      member,
      refs,
      budget: { remaining: agentConfig.maxToolChars },
      screenshots: [],
      channelScope: getChannelScope(guild, member),
      browserFull: canUseFullBrowser(member)
    };

    // 「-# thinking (10s)」を出しておく。この先の準備 (ブラウザの生存確認や
    // 直近メッセージの取得) にも時間がかかるので、一番先に出す。
    indicator = new ThinkingIndicator(message.channel);
    await indicator.start();

    const toolset = await buildToolset(ctx);

    const replyTarget = message.reference?.messageId
      ? await message.fetchReference()
        .then((referenced) => fromDiscordMessage(referenced, message.channel.name))
        .catch(() => null)
      : null;

    const recent = await fetchRecent(message.channel, message.id, agentConfig.preloadMessages);

    const system = buildSystemPrompt(ctx, toolset);
    const userContent = buildUserContent({
      prompt: stripMention(message.content, client.user.id),
      recent,
      replyTarget,
      refs
    });

    const result = await runAgent({
      system,
      userContent,
      toolset,
      signal: controller.signal,
      onToolCall: (name) => indicator.setStatus(name)
    });

    finalizeCall(reservation.id, {
      status: 'ok',
      rounds: result.rounds,
      usage: result.usage
    });
    finished = true;

    // 回答ができたので経過表示は消す。回答は新しいメッセージとして送るので、
    // 待っている間に会話が進んでいても一番下に出る。
    await indicator.stop();

    const answer = result.text?.trim()
      ? expandCitations(result.text.trim(), refs)
      : 'うまく答えをまとめられませんでした。条件を絞ってもう一度聞いてください。';

    const chunks = chunkForDiscord(answer);
    const files = ctx.screenshots.map(
      (buffer, index) => new AttachmentBuilder(buffer, { name: `screenshot-${index + 1}.png` })
    );

    for (const [index, chunk] of chunks.entries()) {
      const payload = {
        content: chunk,
        allowedMentions: NO_MENTIONS,
        // 添付は最後のメッセージにまとめてつける
        ...(index === chunks.length - 1 && files.length > 0 ? { files } : {})
      };

      const sent = index === 0
        ? await message.reply(payload)
        : await message.channel.send(payload);

      // これへのリプライを会話の続きとして受け付ける
      rememberOwnReply(sent?.id);
    }
  } catch (error) {
    const aborted = error.name === 'AbortError';
    console.error('Agent request failed:', error);

    // API 側の障害やタイムアウトは呼び出し回数に数えない (制限は寛大に)。
    if (!finished) releaseCall(reservation.id);

    // エラー文を出す前に経過表示を片付ける
    await indicator?.stop();

    await message.reply({
      content: aborted
        ? '時間内に答えを作れませんでした。もう少し範囲を絞って聞いてください。'
        : 'エージェントの実行に失敗しました。しばらくしてからもう一度試してください。',
      allowedMentions: NO_MENTIONS
    }).catch(() => {});
  } finally {
    // 取りこぼしの保険。stop() は何度呼んでも安全。
    await indicator?.stop();
    clearTimeout(timeout);
  }
}
