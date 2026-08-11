// メンションで呼ばれる AI エージェント。
//
//   @bot この議論まとめて
//   @bot どっちが正しい？        (口論しているメッセージにリプライしつつ)
//   @bot たこが前に言ってた実装方針どこ？
//
// 呼ばれた時点で直近の会話を渡してしまうので、多くの場合ツールを1回も呼ばずに答える。

import { AttachmentBuilder } from 'discord.js';
import { canManageIndex, getChannelScope } from '../archive/permissions.js';
import { closeBrowserSandbox } from './browser.js';
import { agentConfig, agentEnabled } from './config.js';
import {
  RefTable,
  chunkForDiscord,
  expandCitations,
  fromDiscordMessage
} from './format.js';
import { runAgent } from './llm.js';
import { buildSystemPrompt, buildUserContent } from './prompt.js';
import {
  finalizeCall,
  recordToolCalls,
  releaseCall,
  remainingFor,
  reserveCall,
  usdToTokens,
  weighTokens
} from './ratelimit.js';
import { ThinkingIndicator, toolLabel } from './thinking.js';
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

/**
 * ブラウザを「操作」できる人。
 *
 * ManageGuild では出さない。モデレータ権限は普通に何人も持っているのに、
 * 生 CDP と eval は共有 Chrome に載っているログイン済みセッションに届く
 * (Cookie の吸い出しも root でのファイル書き込みも射程に入る)。
 * 名指しの許可リストだけにして、既定では誰も持たない。
 */
function canUseFullBrowser(member) {
  if (agentConfig.browserFullForAll) return true;
  return agentConfig.browserTrustedUsers.includes(member.id);
}

function limitMessage(reservation) {
  if (reservation.scope === 'busy') {
    return 'いま他の人の質問を処理中です。少し待ってからもう一度呼んでください。';
  }

  const at = `<t:${Math.floor(reservation.retryAt / 1000)}:R>`;
  const hours = Math.round(reservation.windowMs / 3_600_000);
  const window = hours === 24 ? '1日' : `${hours}時間`;
  const amount = `$${reservation.usedUsd.toFixed(3)} / $${reservation.limitUsd.toFixed(2)}`;

  return reservation.scope === 'user'
    ? `使用量の上限に達しました (1人あたり${window} ${amount})。${at} に空きます。`
    : `サーバー全体の使用量の上限に達しました (${window} ${amount})。${at} に空きます。`;
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

  // 管理者は上限を通らない。上限は荒らしを止める壁で、運営を縛るものではない。
  const admin = canManageIndex(member);

  const reservation = reserveCall({
    guildId: guild.id,
    channelId: message.channelId,
    userId: message.author.id,
    admin
  });

  if (!reservation.ok) {
    await message.reply({ content: limitMessage(reservation), allowedMentions: NO_MENTIONS })
      .catch(() => {});
    return;
  }

  // ここから先は必ず try の中で組み立てる。
  // 確保した枠を返さずに抜けると、同時実行の空きが永久に戻らない。
  //
  // リクエスト全体のタイムアウトは持たない。止めるのはトークンの予算だけで、
  // 時間で畳むと「払ったのに謝り文だけ返す」ことになる (実際にそうなっていた)。
  // 応答が来ないソケットは llm.js が1回ごとに畳む。
  let finished = false;
  let indicator = null;
  let ctx = null;

  // 例外や中断でも使ったぶんが残るように、外で持って runAgent に渡す。
  const usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 };

  try {
    const refs = new RefTable();
    ctx = {
      client,
      guild,
      channel: message.channel,
      member,
      refs,
      screenshots: [],
      channelScope: getChannelScope(guild, member),
      browserFull: canUseFullBrowser(member),
      // ツールの中から表示を差し替えられるようにする。キーワード検索から
      // 意味検索へ自動で回すときに数秒止まるので、そこを黙らせない。
      setStatus: (status) => indicator?.setStatus(status)
    };

    // 経過表示を出しておく。この先の準備 (ブラウザの生存確認や
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
    // query を省略した意味検索で「いまの会話」を使う
    ctx.recent = recent;

    const system = buildSystemPrompt(ctx, toolset);
    const userContent = buildUserContent({
      ctx,
      prompt: stripMention(message.content, client.user.id),
      recent,
      replyTarget,
      refs
    });

    const result = await runAgent({
      system,
      userContent,
      toolset,
      usage,
      // 止めるのはトークンだけ。上限はドルで持っているのでここで換算する。
      // 1回ぶんの暴走ガードと、その人の残りのうち小さい方。
      // 管理者は残りが Infinity なので、暴走ガードだけが効く。
      budget: Math.min(usdToTokens(agentConfig.requestUsd), remainingFor(message.author.id, admin)),
      weigh: weighTokens,
      onToolCall: (name, args) => indicator.setStatus(toolLabel(name, args))
    });

    finalizeCall(reservation.id, {
      status: 'ok',
      rounds: result.rounds,
      usage: result.usage
    });
    recordToolCalls(reservation.id, result.used);
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
    console.error('Agent request failed:', error);

    // API 側の障害は数えない。ただし途中まで払ったトークンは記録に残す
    // (9往復してタイムアウトしたぶんを0として捨てると請求と乖離する)。
    if (!finished) releaseCall(reservation.id, usage);

    // エラー文を出す前に経過表示を片付ける
    await indicator?.stop();

    await message.reply({
      content: 'エージェントの実行に失敗しました。しばらくしてからもう一度試してください。',
      allowedMentions: NO_MENTIONS
    }).catch(() => {});
  } finally {
    // 取りこぼしの保険。stop() は何度呼んでも安全。
    await indicator?.stop();
    // 隔離タブは実行ごとに捨てる。残すと次の人が中身を読める。
    if (ctx) await closeBrowserSandbox(ctx).catch(() => {});
  }
}
