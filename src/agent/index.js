// メンションで呼ばれる AI エージェント。
//
//   @bot この議論まとめて
//   @bot どっちが正しい？        (口論しているメッセージにリプライしつつ)
//   @bot たこが前に言ってた実装方針どこ？
//
// 呼ばれた時点で直近の会話を渡してしまうので、多くの場合ツールを1回も呼ばずに答える。

import { AttachmentBuilder } from 'discord.js';
import {
  canBotAttach,
  canBotSpeak,
  canManageIndex,
  getChannelScope
} from '../archive/permissions.js';
import { isBareAck } from './ack.js';
import { closeBrowserSandbox } from './browser.js';
import { agentConfig, agentEnabled } from './config.js';
import {
  RefTable,
  chunkForDiscord,
  describeExtras,
  expandCitations,
  fromDiscordMessage
} from './format.js';
import { runAgent } from './llm.js';
import { buildSystemPrompt, buildUserContent } from './prompt.js';
import {
  finalizeCall,
  isAgentReply,
  recordToolCalls,
  releaseCall,
  remainingFor,
  rememberAgentReply,
  reserveCall,
  usdToTokens,
  weighTokens
} from './ratelimit.js';
import { engineFor } from '../mimic/prefs.js';
import { handleMimicRequest } from '../mimic/respond.js';
import { ThinkingIndicator, isIndicatorMessage, toolLabel } from './thinking.js';
import { buildToolset } from './tools.js';
import { reserveGovernanceAgentAttempt } from '../governance/service.js';

const NO_MENTIONS = { parse: [], repliedUser: false };

// 回答の1通目だけ、聞いた人に通知を出す。
//
// 全部 NO_MENTIONS にしていたので、30〜60秒待たされた挙句リプライの ping が
// 飛ばず、答えが返ったことに気付けなかった。本文中のメンションは引き続き無効
// (`parse: []`)。誤爆を防ぐのはそちらの役目で、返信先への通知とは別の話。
const PING_ASKER = { parse: [], repliedUser: true };

// bot が出す定型文の先頭。回答ではないので、次の実行の背景に混ぜない。
// 金額と時刻が可変なので前方一致で見る。
const NOTICE_BUSY = 'いま処理が立て込んでいます';
const NOTICE_USER_LIMIT = '使用量の上限に達しました';
const NOTICE_GLOBAL_LIMIT = 'サーバー全体の使用量の上限に達しました';
const NOTICE_ERROR = 'エージェントの実行に失敗しました';

const NOTICE_HEADS = [NOTICE_BUSY, NOTICE_USER_LIMIT, NOTICE_GLOBAL_LIMIT, NOTICE_ERROR];

/**
 * その発言が bot の出した定型文か。直近の会話に混ぜないために使う。
 *
 * 経過表示と同じ理由。混ぜると「上限に達しました」が `←自分の発言` として
 * 次の実行の材料になり、モデルが自分の断り文を会話の一部として読む。
 */
export function isAgentNotice(message, selfId) {
  if (!selfId || message?.authorId !== selfId) return false;

  const content = String(message.content ?? '');
  return NOTICE_HEADS.some((head) => content.startsWith(head));
}

// エージェントが投稿した回答の ID。これへのリプライだけを会話の続きとして扱う。
// リプライ元をいちいち fetch すると返信のたびに API を1回叩くので、
// 自分が送ったものを覚えておいて突き合わせる。メモリは速い経路で、実体は DB
// (再起動を挟んでも続けられるように)。
const OWN_REPLY_LIMIT = 500;
const ownReplies = new Set();

function rememberOwnReply(messageId, callId) {
  if (!messageId) return;

  ownReplies.add(messageId);
  // 古いものから落とす (Set は挿入順を保つ)
  while (ownReplies.size > OWN_REPLY_LIMIT) {
    ownReplies.delete(ownReplies.values().next().value);
  }

  rememberAgentReply(messageId, callId);
}

/**
 * 入口は2つ。
 *   1. bot への直接メンション
 *   2. エージェントの「回答」へのリプライ (会話の続き)
 *
 * 2 は回答だけ。以前は「bot が書いたメッセージなら続き」と見なす保険を入れていて
 * (再起動でメモリの一覧が消えるため)、経過表示・ウェルカム・上限の断り文・エラー文への
 * リプライでも起動していた。回答の ID を DB に持つことで保険が要らなくなった。
 *
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

  const repliedTo = message.reference?.messageId;
  if (!repliedTo) return false;

  if (!ownReplies.has(repliedTo) && !isAgentReply(repliedTo)) return false;

  // 相槌には反応しない。「ありがとう」のたびに直近30件を積み直して
  // 1回ぶん払うのは高すぎる。メンションは上で通してあるので、明示的に
  // 呼ばれたぶんは相槌でも答える。
  return !isBareAck(message.content);
}

/**
 * メンションだけ抜く。
 *
 * 改行は残す。以前は `\s+` を1つの空白に畳んでいて、箇条書き・貼り付けたログ・
 * コードが1行に潰れたままモデルへ渡っていた (人が読んでいる形と違うものを
 * 読ませることになる)。畳むのは行の中の連続空白だけ。
 */
export function stripMention(content, clientId) {
  return String(content ?? '')
    .replace(new RegExp(`<@!?${clientId}>`, 'g'), ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
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

/** 末尾に出すモデル名。`deepseek-v4-flash` を `deepseek v4 flash` にする。 */
function modelLabel() {
  return agentConfig.model.replace(/-/g, ' ');
}

function limitMessage(reservation) {
  if (reservation.scope === 'busy') {
    // 「他の人の質問」とは言わない。自分の2本目でもここに来る。
    return `${NOTICE_BUSY}。少し待ってからもう一度呼んでください。`;
  }

  const at = `<t:${Math.floor(reservation.retryAt / 1000)}:R>`;
  const hours = Math.round(reservation.windowMs / 3_600_000);
  const window = hours === 24 ? '1日' : `${hours}時間`;
  const amount = `$${reservation.usedUsd.toFixed(3)} / $${reservation.limitUsd.toFixed(2)}`;

  return reservation.scope === 'user'
    ? `${NOTICE_USER_LIMIT} (1人あたり${window} ${amount})。${at} に空きます。`
    : `${NOTICE_GLOBAL_LIMIT} (${window} ${amount})。${at} に空きます。`;
}

function attemptLimitMessage(reservation) {
  const at = reservation.retryAt ? ` <t:${Math.floor(reservation.retryAt / 1000)}:R>に空きます。` : '';
  if (reservation.scope === 'sanction') {
    return `${NOTICE_USER_LIMIT}。現在の判決でエージェント利用が制限されています。${at}`;
  }
  return `${NOTICE_USER_LIMIT} (prompt injection対策の24時間回数枠 ${reservation.used}/${reservation.limit})。${at}`;
}

/**
 * リプライで返す。失敗したらチャンネルに直接送る。
 *
 * 処理中に依頼が消されると `message.reply` は 50035
 * (message_reference[MESSAGE_REFERENCE_UNKNOWN_MESSAGE]) で落ちる。
 * 実測で2回起きていて、そのたびに出来上がった回答を丸ごと捨てていた
 * (エラー文の返信も同じ理由で失敗するので、ユーザーには何も出ないままトークンだけ払う)。
 * 返信先が消えていても答えは残す。
 */
async function replyOrSend(message, payload) {
  try {
    return await message.reply(payload);
  } catch (error) {
    console.error('reply failed, sending to the channel instead:', error?.message ?? error);
    return await message.channel.send(payload).catch(() => null);
  }
}

async function fetchRecent(channel, { exclude, selfId, limit }) {
  if (limit <= 0 || typeof channel.messages?.fetch !== 'function') return [];

  try {
    // 経過表示のぶんだけ多めに取る。捨てる件数が読めないので少し余裕を持たせる。
    const fetched = await channel.messages.fetch({ limit: Math.min(limit + 8, 100) });
    return [...fetched.values()]
      .filter((message) => !exclude.has(message.id))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((message) => fromDiscordMessage(message, channel.name))
      // 自分の経過表示と断り文は会話ではない。混ぜると枠を食うし、自分の発言として
      // 読まれる。ID で除くだけでは足りない (落ちた実行が消し損ねたぶんが残っている)。
      .filter((message) => !isIndicatorMessage(message, selfId) && !isAgentNotice(message, selfId))
      .slice(-limit);
  } catch (error) {
    console.error('Failed to preload recent messages:', error);
    return [];
  }
}

// 返信でつながっている分だけさかのぼる。
//
// 以前は 1ホップ (message.fetchReference()) だけだった。話題が3つ並行している
// チャンネルではそれで足りない: 直近30件はその混ざったログなので、どの話の続きなのかを
// モデルが推測することになり、答えが混ざる。
// 鎖をたどれば「いまの話題」だけを取り出せる。
const REPLY_CHAIN_LIMIT = 6;

export async function fetchReplyChain(message, channelName) {
  const chain = [];
  const seen = new Set([message.id]);
  // 参照を持っているのは「いま見ている側」なので、ホップごとに進める
  let node = message;
  let parentId = message.reference?.messageId ?? null;

  while (parentId && chain.length < REPLY_CHAIN_LIMIT && !seen.has(parentId)) {
    seen.add(parentId);

    // 転送 (forward) は本文が message_snapshots 側に入り、参照先が別チャンネルなので
    // channel.messages.fetch では取れない。スナップショットがあるならそれを使う。
    const snapshot = node.messageSnapshots?.get(parentId) ?? null;

    // 直近30件を先に取ってあるのでキャッシュに載っていることが多い。
    // 載っていないぶんだけ取りに行く (削除済みなら鎖はそこで切れる)。
    const parent = snapshot
      ?? message.channel.messages?.cache?.get(parentId)
      ?? await message.channel.messages.fetch(parentId).catch(() => null);

    if (!parent) break;

    const entry = fromDiscordMessage(parent, parent.channel?.name ?? channelName);

    // 転送のスナップショットに投稿者は入ってこない。分からないまま名前を出すと
    // 取り違えるので、そう書く (誰の発言かの取り違えは捏造と同じ害になる)。
    if (snapshot) entry.authorName = '転送された発言 (投稿者不明)';

    chain.push(entry);
    node = parent;
    parentId = parent.reference?.messageId ?? null;
  }

  return chain.reverse();
}

export async function handleAgentRequest(message, client) {
  const guild = message.guild;
  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);

  if (!member) return;

  // /model で自作モデルを選んでいる人はそちらへ回す。
  //
  // 起動条件 (メンション / 回答へのリプライ) は共通にしておきたいので、判定の後・
  // 予約の前で分ける。予約より前なのは、あちらは API を叩かないので費用がゼロで、
  // ドル換算の上限に混ぜると請求と乖離するから。
  if (engineFor(message.author.id) === 'evex') {
    const recent = await message.channel.messages
      .fetch({ limit: 20 })
      .then((found) => [...found.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp))
      .catch(() => [message]);

    await handleMimicRequest(message, client, { recent });
    return;
  }

  // 送れない場所では走らない。
  //
  // 経過表示も回答も送信に失敗するので、最後まで回しても出るものが無い。
  // それでもトークンと同時実行の枠は消費していた (thinking.js は送信失敗を
  // 握り潰して続行し、replyOrSend の2段構えも両方落ちる)。枠を取る前に見る。
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me || !canBotSpeak(message.channel, me)) {
    console.warn(
      `Skipping an agent request in #${message.channel?.name ?? message.channelId}: the bot cannot speak there.`
    );
    return;
  }

  // 統治サーバーではManageGuildを自動的な信頼根拠にしない。指定されたtrusted roleは
  // 回数枠だけを増やし、ブラウザ操作権や司法・立法権限とは結び付けない。
  const attempt = reserveGovernanceAgentAttempt(member, message.id);
  if (!attempt.ok) {
    await replyOrSend(message, { content: attemptLimitMessage(attempt), allowedMentions: NO_MENTIONS });
    return;
  }
  const admin = !attempt.governed && canManageIndex(member);

  const reservation = reserveCall({
    guildId: guild.id,
    channelId: message.channelId,
    userId: message.author.id,
    admin,
    skipUserLimit: attempt.governed
  });

  if (!reservation.ok) {
    await replyOrSend(message, { content: limitMessage(reservation), allowedMentions: NO_MENTIONS });
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
      // このサーバーでの bot 自身のメンバー。表示名をモデルに渡すのに要る
      // (ニックネームはサーバーごとに違うので client.user では足りない)。
      me,
      refs,
      screenshots: [],
      channelScope: getChannelScope(guild, member),
      browserFull: canUseFullBrowser(member),
      // 添付できないだけなら本文は出せるので実行は止めない。撮ったのに貼れない
      // ときだけ、その旨を回答に添える (黙って落とすと撮れたつもりで話が進む)。
      canAttach: canBotAttach(message.channel, me),
      // ツールの中から表示を差し替えられるようにする。キーワード検索から
      // 意味検索へ自動で回すときに数秒止まるので、そこを黙らせない。
      setStatus: (status) => indicator?.setStatus(status)
    };

    // 経過表示を出しておく。この先の準備 (ブラウザの生存確認や
    // 直近メッセージの取得) にも時間がかかるので、一番先に出す。
    indicator = new ThinkingIndicator(message.channel);
    await indicator.start();

    const toolset = await buildToolset(ctx);

    // 直近を先に取る (鎖のたどり先がキャッシュに載るので API を叩かずに済む)
    const preloaded = await fetchRecent(message.channel, {
      // 依頼そのものと、いま出している経過表示は渡さない
      exclude: new Set([message.id, indicator.messageId].filter(Boolean)),
      selfId: client.user?.id,
      limit: agentConfig.preloadMessages
    });
    const replyChain = await fetchReplyChain(message, message.channel.name);

    // 鎖に入ったものは背景から抜く。同じ発言を2回載せてもトークンだけ増える。
    const inChain = new Set(replyChain.map((entry) => entry.messageId));
    const recent = preloaded.filter((entry) => !inChain.has(entry.messageId));

    // query を省略した意味検索で「いまの会話」を使う
    ctx.recent = recent;
    ctx.thread = replyChain;

    const system = buildSystemPrompt(ctx, toolset);
    const userContent = buildUserContent({
      ctx,
      prompt: stripMention(message.content, client.user.id),
      // 依頼に貼られた画像・埋め込み・スタンプ。中身は読めないが、存在を
      // 伝えないと「これ何？」に対して直近の会話の話をしてしまう。
      extras: describeExtras(message),
      recent,
      replyChain,
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
      budget: Math.min(
        usdToTokens(agentConfig.requestUsd),
        remainingFor(message.author.id, admin, { skipUserLimit: attempt.governed })
      ),
      // 時間の壁。トークンが余っていても、同時実行の枠を何時間も押さえさせない。
      // 超えてもツールが外れるだけなので、答えはその場の材料で必ず書かれる。
      deadlineAt: Date.now() + agentConfig.deadlineMs,
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
      ? expandCitations(result.text.trim(), refs, { label: modelLabel() })
      : 'うまく答えをまとめられませんでした。条件を絞ってもう一度聞いてください。';

    // 撮ったのに貼れないときは黙らない (画像が出ている前提で読まれる)
    const blocked = ctx.screenshots.length > 0 && !ctx.canAttach;
    const chunks = chunkForDiscord(
      blocked
        ? `${answer}\n\n-# (スクリーンショットは撮ったけど、このチャンネルにファイルを添付する権限が無くて貼れなかった)`
        : answer
    );

    const files = ctx.canAttach
      ? ctx.screenshots.map(
        (buffer, index) => new AttachmentBuilder(buffer, { name: `screenshot-${index + 1}.png` })
      )
      : [];

    for (const [index, chunk] of chunks.entries()) {
      const payload = {
        content: chunk,
        // 1通目だけ聞いた人に通知する。2通目以降で鳴らすと同じ答えで2回鳴る。
        allowedMentions: index === 0 ? PING_ASKER : NO_MENTIONS,
        // 添付は最後のメッセージにまとめてつける
        ...(index === chunks.length - 1 && files.length > 0 ? { files } : {})
      };

      const sent = index === 0
        ? await replyOrSend(message, payload)
        : await message.channel.send(payload);

      // これへのリプライを会話の続きとして受け付ける
      rememberOwnReply(sent?.id, reservation.id);
    }
  } catch (error) {
    console.error('Agent request failed:', error);

    // API 側の障害は数えない。ただし途中まで払ったトークンは記録に残す
    // (9往復してタイムアウトしたぶんを0として捨てると請求と乖離する)。
    if (!finished) releaseCall(reservation.id, usage);

    // エラー文を出す前に経過表示を片付ける
    await indicator?.stop();

    await replyOrSend(message, {
      content: `${NOTICE_ERROR}。しばらくしてからもう一度試してください。`,
      allowedMentions: NO_MENTIONS
    });
  } finally {
    // 取りこぼしの保険。stop() は何度呼んでも安全。
    await indicator?.stop();
    // 隔離タブは実行ごとに捨てる。残すと次の人が中身を読める。
    if (ctx) await closeBrowserSandbox(ctx).catch(() => {});
  }
}
