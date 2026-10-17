// メンションで呼ばれる AI エージェント。
//
//   @bot この議論まとめて
//   @bot どっちが正しい？        (口論しているメッセージにリプライしつつ)
//   @bot たこが前に言ってた実装方針どこ？
//
// 呼ばれた時点で直近の会話を渡してしまうので、多くの場合ツールを1回も呼ばずに答える。

import { DEFAULT_AGENT_ENGINE, agentModelFor, isAgentEngine } from './engines.js';
import {
  AttachmentBuilder,
  MessageReferenceType,
  type Client,
  type GuildMember,
  type Message,
  type MessageMentionOptions,
  type MessageReplyOptions
} from 'discord.js';
import { canBotAttach, canBotSpeak, canManageIndex, getChannelScope } from '../archive/permissions.js';
import { meaningReader, recallWithMeaning, type RecallParts } from '../memory/recall.js';
import { siteConfigFor, siteUrl } from '../memory/site.js';
import { getEpisode } from '../memory/store.js';
import { isSelfHosted } from '../mimic/client.js';
import { engineFor } from '../mimic/prefs.js';
import { handleMimicRequest } from '../mimic/respond.js';
import { isBareAck } from './ack.js';
import { governance, type GovernanceReservation } from './boundary.js';
import { closeBrowserSandbox } from './browser.js';
import { failureNotice } from './failure.js';
import { stripAddressNarration } from './narration.js';
import { dropRestartedAnswer } from './repeat.js';
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
  getTunable,
  isAgentReply,
  recordToolCalls,
  releaseCall,
  remainingFor,
  rememberAgentReply,
  reserveCall,
  usdToBudget,
  weighCost,
  type Reservation,
  type TokenUsage
} from './ratelimit.js';
import { ThinkingIndicator, isIndicatorMessage, toolLabel } from './thinking.js';
import { buildToolset } from './tools.js';
import {
  errorCode,
  errorMessage,
  type AgentContext,
  type AgentMessage,
  type ReferenceState,
  type ReplyChain
} from './types.js';

// 本文中のメンション (@everyone / @here / ロール / ユーザー) は一切通知にしない。
// ユーザーやモデルの文章がそのまま届く場所なので、parse を空にして明示する。
const NO_MENTIONS: MessageMentionOptions = { parse: [], repliedUser: false };

// 回答の1通目だけ、聞いた人に通知を出す。
//
// 全部 NO_MENTIONS にしていたので、30〜60秒待たされた挙句リプライの ping が
// 飛ばず、答えが返ったことに気付けなかった。本文中のメンションは引き続き無効
// (`parse: []`)。誤爆を防ぐのはそちらの役目で、返信先への通知とは別の話。
const PING_ASKER: MessageMentionOptions = { parse: [], repliedUser: true };

// bot が出す定型文の先頭。回答ではないので、次の実行の背景に混ぜない。
// 金額と時刻が可変なので前方一致で見る。
const NOTICE_BUSY = 'いま処理が立て込んでいます';
const NOTICE_USER_LIMIT = '使用量の上限に達しました';
const NOTICE_GLOBAL_LIMIT = 'サーバー全体の使用量の上限に達しました';
const NOTICE_ERROR = 'エージェントの実行に失敗しました';

const NOTICE_HEADS = [NOTICE_BUSY, NOTICE_USER_LIMIT, NOTICE_GLOBAL_LIMIT, NOTICE_ERROR];

/** 1つの Discord 入力を指す4つの ID。 */
export interface ChatRunIdentity {
  guildId: string | null | undefined;
  channelId: string | null | undefined;
  memberId: string | null | undefined;
  messageId: string | null | undefined;
}

export function chatRunId({ guildId, channelId, memberId, messageId }: ChatRunIdentity): string {
  const identity = [guildId, channelId, memberId, messageId].map((value) => String(value ?? '').trim());
  if (identity.some((value) => !value)) throw new Error('Chat run identity requires guild, channel, member and message IDs');
  return `discord-chat:${JSON.stringify(identity)}`;
}

/**
 * その発言が bot の出した定型文か。直近の会話に混ぜないために使う。
 *
 * 経過表示と同じ理由。混ぜると「上限に達しました」が `←自分の発言` として
 * 次の実行の材料になり、モデルが自分の断り文を会話の一部として読む。
 */
export function isAgentNotice(
  message: { authorId?: string; content?: string } | null | undefined,
  selfId: string | null | undefined
): boolean {
  if (!selfId || message?.authorId !== selfId) return false;

  const content = String(message.content ?? '');
  return NOTICE_HEADS.some((head) => content.startsWith(head));
}

// エージェントが投稿した回答の ID。これへのリプライだけを会話の続きとして扱う。
// リプライ元をいちいち fetch すると返信のたびに API を1回叩くので、
// 自分が送ったものを覚えておいて突き合わせる。メモリは速い経路で、実体は DB
// (再起動を挟んでも続けられるように)。
const OWN_REPLY_LIMIT = 500;
const ownReplies = new Set<string>();

function rememberOwnReply(messageId: string | null | undefined, callId?: number): void {
  if (!messageId) return;

  ownReplies.add(messageId);
  // 古いものから落とす (Set は挿入順を保つ)
  for (const oldest of ownReplies) {
    if (ownReplies.size <= OWN_REPLY_LIMIT) break;
    ownReplies.delete(oldest);
  }

  rememberAgentReply(messageId, callId ?? null);
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
export function isAgentRequest(message: Message, client: Client): boolean {
  if (!agentEnabled) return false;
  // bot / webhook の発言では起動しない。自分の回答への返信で自分が起動する輪を作らないため。
  if (!message.guildId || message.author?.bot || message.webhookId) return false;
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
export function stripMention(content: unknown, clientId: string): string {
  // clientId はスノーフレークだが、正規表現に埋めるので念のため記号を逃がしておく
  const escaped = String(clientId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(content ?? '')
    .replace(new RegExp(`<@!?${escaped}>`, 'g'), ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const GOVERNANCE_TOPIC_PATTERN = /(憲法|法令集|官報|法律|現行法|法案|改憲|立法|司法|裁判|判決|違憲|上訴|処分|制裁|行政行為|統治)/;

/**
 * 統治に関する自然文は、選択中の雑談用mimic modelでは処理しない。
 * mimic modelにはsystem promptもtoolも無く、正本DBを読めないため。
 */
export function isGovernanceAgentTopic(content: unknown): boolean {
  return GOVERNANCE_TOPIC_PATTERN.test(String(content ?? ''));
}

/**
 * ブラウザを「操作」できる人。
 *
 * ManageGuild では出さない。モデレータ権限は普通に何人も持っているのに、
 * 生 CDP と eval は共有 Chrome に載っているログイン済みセッションに届く
 * (Cookie の吸い出しも root でのファイル書き込みも射程に入る)。
 * 名指しの許可リストだけにして、既定では誰も持たない。
 */
function canUseFullBrowser(member: Pick<GuildMember, 'id'>): boolean {
  if (agentConfig.browserFullForAll) return true;
  return agentConfig.browserTrustedUsers.includes(member.id);
}

/** 末尾に出すモデル名。
 *
 * 以前はハイフンを空白にしていたが、自作モデル側が `evex-ft-1-preview` の形なので
 * そちらと揃える。`/model` の表示・フッター・env の値が全部同じ綴りになる。
 */
function modelLabel(model: string = agentConfig.model): string {
  return model;
}

function limitMessage(reservation: Extract<Reservation, { ok: false }>): string {
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

function attemptLimitMessage(reservation: GovernanceReservation): string {
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
async function replyOrSend(message: Message<true>, payload: MessageReplyOptions): Promise<Message<true> | null> {
  try {
    return await message.reply(payload);
  } catch (error) {
    console.error('reply failed, sending to the channel instead:', errorMessage(error));
    return await message.channel.send(payload).catch(() => null);
  }
}

async function fetchRecent(
  channel: Message<true>['channel'],
  { exclude, selfId, limit }: { exclude: Set<string>; selfId: string | undefined; limit: number }
): Promise<AgentMessage[]> {
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

export async function fetchReplyChain(message: Message<true>, channelName?: string | null): Promise<ReplyChain> {
  const chain: AgentMessage[] = [];
  const seen = new Set<string>([message.id]);
  let state: ReferenceState = 'not_applicable';
  let node: Message<true> = message;
  while (node.reference?.messageId && chain.length < REPLY_CHAIN_LIMIT) {
    // A forwarded snapshot is quoted material attached to the sender's message.
    // It is not an interlocutor, nor a hop in this conversation's reply chain.
    if (node.reference.type === MessageReferenceType.Forward || node.messageSnapshots?.size) {
      state = chain.length ? state : 'snapshot';
      break;
    }
    const parentId = node.reference.messageId;
    if (seen.has(parentId)) { state = 'cycle'; break; }
    seen.add(parentId);
    const targetChannelId = node.reference.channelId ?? node.channelId;
    // Never follow a reference into a broader/different audience during preload.
    // The read tool can resolve explicit requests under its permission checks.
    const targetChannel = targetChannelId === message.channelId ? message.channel : undefined;
    if (!targetChannel) {
      state = 'unavailable'; break;
    }
    let parent: Message<true> | undefined = targetChannel.messages?.cache?.get(parentId);
    if (!parent) {
      try { parent = await targetChannel.messages.fetch(parentId); }
      catch (error) { state = Number(errorCode(error)) === 10008 ? 'deleted' : 'unavailable'; break; }
    }
    if (!parent) { state = 'unavailable'; break; }
    chain.push(fromDiscordMessage(parent, parent.channel?.name ?? channelName));
    state = 'resolved';
    node = parent;
  }
  if (chain.length === REPLY_CHAIN_LIMIT && node.reference?.messageId) state = 'depth_limit';
  return Object.assign(chain.reverse(), { referenceState: state });
}

export async function handleAgentRequest(message: Message<true>, client: Client<true>): Promise<void> {
  const guild = message.guild;
  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);

  if (!member) return;

  // /model で自作モデルを選んでいる人はそちらへ回す。
  //
  // 起動条件 (メンション / 回答へのリプライ) は共通にしておきたいので、判定の後・
  // 予約の前で分ける。予約より前なのは、あちらは API を叩かないので費用がゼロで、
  // ドル換算の上限に混ぜると請求と乖離するから。
  const governanceTopic = Boolean(governance.getGovernanceGuild(guild.id))
    && isGovernanceAgentTopic(message.content);
  const chosen = engineFor(message.author.id, guild.id);
  // 会話 agent のモデルはその人が /model で選んだもの (ling / glm / qwen / luna / deepseek / mimo)。
  // 自作モデルを選んでいる人が統治の話をしたときは既定のモデルで答える
  const model = agentModelFor(isAgentEngine(chosen) ? chosen : DEFAULT_AGENT_ENGINE);
  // 自作モデル側はどれも「会話の続きを1発言書く」だけ。道具も検索も使えない。
  //
  // 名前を並べていたら evex-1 を足したときに書き足し忘れ、選んだ人が黙って
  // DeepSeek に回っていた (料金も掛かる)。自前で配信しているものは ENDPOINTS に
  // 全部載っているので、そちらを唯一の名簿にする
  if (isSelfHosted(chosen) && !governanceTopic) {
    const recent = await message.channel.messages
      .fetch({ limit: 20 })
      .then((found) => [...found.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp))
      .catch(() => [message]);

    // リプ先も渡す。DeepSeek 側は 6 ホップ辿って渡しているのに、自作モデル側は
    // 直近 20 件だけ見ていた。「/model を変えると挙動が変わり過ぎる」原因のひとつ。
    const chain = await fetchReplyChain(message, message.channel.name).catch(() => []);

    // 記録関数を渡す (import すると agent/index.js ⇄ mimic/respond.js の循環になる)。
    // これが無いと自作モデルの返答にリプしても起動条件に合わず無反応だった。
    await handleMimicRequest(message, client, {
      recent, chain, engine: chosen, remember: rememberOwnReply, selfId: client.user.id
    });
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
  const attempt = governance.reserveGovernanceAgentAttempt(member, message.id);
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
  // 枠を確保した reserveCall から try に入るまでの間に await も例外もない
  // (枠の返却は finalizeCall か releaseCall のどちらか1回だけ。下の finished で守る)。
  //
  // リクエスト全体のタイムアウトは持たない。止めるのはトークンの予算だけで、
  // 時間で畳むと「払ったのに謝り文だけ返す」ことになる (実際にそうなっていた)。
  // 応答が来ないソケットは llm.js が1回ごとに畳む。
  let finished = false;
  let indicator: ThinkingIndicator | null = null;
  let ctx: AgentContext | null = null;

  // 例外や中断でも、この呼び出しで新たに使ったぶんは残す。
  // 再開前の累計をこの新しい予約に付け替えないため、runAgent が
  // この object に書くのは呼び出し単位の差分だけ。
  const usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 };

  try {
    const refs = new RefTable();
    const runContext: AgentContext = {
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
      // ブラウザを操作できるかは人 (ID の許可リスト) だけで決まる。モデルの出力や
      // 会話の中身からは変えられない。
      browserFull: canUseFullBrowser(member),
      // 添付できないだけなら本文は出せるので実行は止めない。撮ったのに貼れない
      // ときだけ、その旨を回答に添える (黙って落とすと撮れたつもりで話が進む)。
      canAttach: canBotAttach(message.channel, me),
      // ツールの中から表示を差し替えられるようにする。キーワード検索から
      // 意味検索へ自動で回すときに数秒止まるので、そこを黙らせない。
      setStatus: (status) => indicator?.setStatus(status)
    };
    ctx = runContext;

    // 経過表示を出しておく。この先の準備 (ブラウザの生存確認や
    // 直近メッセージの取得) にも時間がかかるので、一番先に出す。
    const thinking = new ThinkingIndicator(message.channel);
    indicator = thinking;
    await thinking.start();

    const toolset = await buildToolset(runContext);

    // 直近を先に取る (鎖のたどり先がキャッシュに載るので API を叩かずに済む)
    const preloaded = await fetchRecent(message.channel, {
      // 依頼そのものと、いま出している経過表示は渡さない
      exclude: new Set([message.id, thinking.messageId].filter((id): id is string => Boolean(id))),
      selfId: client.user.id,
      limit: agentConfig.preloadMessages
    });
    const replyChain = await fetchReplyChain(message, message.channel.name);

    // 鎖に入ったものは背景から抜く。同じ発言を2回載せてもトークンだけ増える。
    const inChain = new Set(replyChain.map((entry) => entry.messageId));
    const recent = preloaded.filter((entry) => !inChain.has(entry.messageId));

    // query を省略した意味検索で「いまの会話」を使う
    runContext.recent = recent;
    runContext.thread = replyChain;

    const system = buildSystemPrompt(runContext, toolset);
    const request = stripMention(message.content, client.user.id);
    // 呼ばれたときの想起: 名前の照合 + 意味の近い記憶 (間に合わなければ名前だけ)
    const recalled = toolset.memoryAvailable ? await recallSafely(guild.id, request, replyChain, recent) : null;
    const userContent = buildUserContent({
      ctx: runContext,
      prompt: request,
      // 依頼に貼られた画像・埋め込み・スタンプ。中身は読めないが、存在を
      // 伝えないと「これ何？」に対して直近の会話の話をしてしまう。
      extras: describeExtras(message),
      recent,
      replyChain,
      requestMessage: { ...fromDiscordMessage(message), referenceState: replyChain.referenceState },
      refs,
      recall: recalled?.text ?? ''
    });

    const result = await runAgent({
      model,
      guildId: guild.id,
      // 考えている途中の想起: 往復ごとに、いま調べていることに近い記憶のうち、まだ出していないものを足す
      ...(toolset.memoryAvailable ? { memory: { read: meaningReader(guild.id, { request, shown: recalled ?? undefined }) } } : {}),
      // Discord input identity survives a process restart, so an unfinished
      // run resumes from its checkpoint instead of starting over. Completed
      // runs still use the runtime's default reuseCompleted=false behavior if
      // the event is handled again.
      runId: chatRunId({ guildId: guild.id, channelId: message.channelId,
        memberId: member.id, messageId: message.id }),
      system,
      userContent,
      toolset,
      usage,
      // 予算は実際の請求額 (OpenRouter の usage.cost) で数える。単位はマイクロドル。
      // 1回ぶんの暴走ガードと、その人の残りのうち小さい方。
      // 管理者は残りが Infinity なので、暴走ガードだけが効く。
      budget: Math.min(
        usdToBudget(getTunable('request_usd')),
        remainingFor(message.author.id, admin, { skipUserLimit: attempt.governed })
      ),
      // 時間の壁。トークンが余っていても、同時実行の枠を何時間も押さえさせない。
      // 超えてもツールが外れるだけなので、答えはその場の材料で必ず書かれる。
      deadlineAt: Date.now() + agentConfig.deadlineMs,
      weigh: weighCost,
      onToolCall: (name, args) => thinking.setStatus(toolLabel(name, args))
    });

    finalizeCall(reservation.id, {
      status: 'ok',
      rounds: result.invocation.rounds,
      usage: result.invocation.usage
    });
    // 枠は finalizeCall が返した。以降に何が起きても releaseCall で二重に返さない。
    finished = true;
    recordToolCalls(reservation.id, result.used);

    // 回答ができたので経過表示は消す。回答は新しいメッセージとして送るので、
    // 待っている間に会話が進んでいても一番下に出る。
    await thinking.stop();

    // text は runtime が provider の content をそのまま返したもの (空でないことだけ確かめてある)。
    // 文字列でなければ回答として使わない
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    const answer = text
      ? expandCitations(stripAddressNarration(dropRestartedAnswer(text), member.displayName), refs, {
        label: modelLabel(model), selfId: client.user.id, episodeUrl: (id) => memoryEpisodeUrl(guild.id, id)
      })
      : 'うまく答えをまとめられませんでした。条件を絞ってもう一度聞いてください。';

    // 撮ったのに貼れないときは黙らない (画像が出ている前提で読まれる)
    const blocked = runContext.screenshots.length > 0 && !runContext.canAttach;
    const chunks = chunkForDiscord(
      blocked
        ? `${answer}\n\n-# (スクリーンショットは撮ったけど、このチャンネルにファイルを添付する権限が無くて貼れなかった)`
        : answer
    );

    const files = runContext.canAttach
      ? runContext.screenshots.map(
        (buffer, index) => new AttachmentBuilder(buffer, { name: `screenshot-${index + 1}.png` })
      )
      : [];

    for (const [index, chunk] of chunks.entries()) {
      const payload: MessageReplyOptions = {
        content: chunk,
        // 1通目だけ聞いた人に通知する。2通目以降で鳴らすと同じ答えで2回鳴る。
        // モデルの文章に @everyone / ロールが入っていても、どちらも parse が空なので通知にならない。
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
      content: failureNotice(NOTICE_ERROR, error),
      allowedMentions: NO_MENTIONS
    });
  } finally {
    // 取りこぼしの保険。stop() は何度呼んでも安全。
    await indicator?.stop();
    // 隔離タブは実行ごとに捨てる。残すと次の人が中身を読める。
    if (ctx) await closeBrowserSandbox(ctx).catch(() => {});
  }
}

/** 記憶の出来事 (e12) の URL。サイトが無いサーバー・実在しない番号 (モデルの作り話) は null。 */
function memoryEpisodeUrl(guildId: string, id: number): string | null {
  const config = siteConfigFor(guildId);
  if (!config || !Number.isSafeInteger(id) || id <= 0) return null;
  return getEpisode(guildId, id) ? siteUrl(config.origin, guildId, { kind: 'episode', id }) : null;
}

/**
 * 依頼と返信先を強い手がかり、直近の会話を弱い手がかりにして思い出す。
 * 記憶が読めなくても会話は止めない。
 */
async function recallSafely(guildId: string, request: string, replyChain: AgentMessage[], recent: AgentMessage[]): Promise<RecallParts | null> {
  try {
    return await recallWithMeaning(guildId, {
      request: [request, ...replyChain.map((entry) => entry.content ?? '')].join('\n'),
      context: recent.slice(-10).map((entry) => entry.content ?? '').join('\n')
    });
  } catch (error) {
    console.error('Memory recall failed:', error);
    return null;
  }
}
