import {
  ChannelType,
  type AnyThreadChannel,
  type Attachment,
  type Client,
  type ForumChannel,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type MediaChannel,
  type Message,
  type MessageReaction,
  type NewsChannel,
  type PartialMessage,
  type PartialMessageReaction,
  type TextBasedChannel,
  type TextChannel
} from 'discord.js';
import { discordStructure } from '../conversation/message.js';
import {
  db,
  channelGaps,
  channelMessageRange,
  channelTailGap,
  countChannelMessages,
  getChannelState,
  getGuildState,
  isBusy,
  listChannelStates,
  listSpans,
  markMessageDeleted,
  recordSpan,
  replaceReactions,
  retryBusy,
  saveMessage,
  savePage,
  setGuildState,
  snowflakeToMs,
  updateChannelState,
  upsertChannel
} from './db.js';
import { errorCode, errorMessage, field } from './guards.js';
import { MESSAGE_CHANNEL_TYPES, THREAD_CONTAINER_TYPES, canRead, isThreadType } from './permissions.js';
import type {
  ArchiveJob,
  ChannelInput,
  CoverageJob,
  IndexFailure,
  IndexJob,
  LinkRecord,
  MessageRecord,
  ReactionRecord,
  RunningJob
} from './types.js';

const FETCH_DELAY_MS = Number(process.env.ARCHIVE_FETCH_DELAY_MS ?? 150);
const PAGE_SIZE = 100;
const LINK_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/gi;

const runningJobs = new Map<string, RunningJob>(); // guildId -> job

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** スレッドをぶら下げるチャンネル (THREAD_CONTAINER_TYPES の種別)。 */
type ThreadContainer = TextChannel | NewsChannel | ForumChannel | MediaChannel;

/** 発言を持つ種別か (MESSAGE_CHANNEL_TYPES)。種別が分かれば discord.js の型も決まる。 */
function holdsMessages(channel: GuildBasedChannel): channel is GuildTextBasedChannel {
  return MESSAGE_CHANNEL_TYPES.has(channel.type);
}

/** スレッドをぶら下げる種別か (THREAD_CONTAINER_TYPES)。 */
function isThreadContainer(channel: GuildBasedChannel): channel is ThreadContainer {
  return THREAD_CONTAINER_TYPES.has(channel.type);
}

/** 発言を取りに行けるチャンネルか (messages.fetch を持つ)。 */
function canFetchMessages(channel: GuildBasedChannel | null): channel is GuildTextBasedChannel {
  return channel !== null && 'messages' in channel && typeof channel.messages?.fetch === 'function';
}

/** サーバーのチャンネルか (DM には guildId が無い)。 */
function isGuildChannel(channel: TextBasedChannel | null | undefined): channel is GuildTextBasedChannel {
  return typeof channel === 'object' && channel !== null && 'guildId' in channel;
}

/** 権限不足で読めなかった (Missing Access / Missing Permissions / 403)。 */
function isAccessDenied(code: string | number | undefined): boolean {
  return code === 403 || code === 50001 || code === 50013;
}

function extractLinks(content: string): LinkRecord[] {
  const links: LinkRecord[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(LINK_PATTERN)) {
    const url = match[0].replace(/[.,;:!?]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);

    let domain = '';
    try {
      domain = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }

    links.push({ url: url.slice(0, 500), domain });
  }

  return links;
}

function attachmentKind(attachment: Attachment): string {
  const type = attachment.contentType ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * discord.js の Message を DB 行に変換する。
 * extra には本文以外の検索対象 (添付ファイル名 / 埋め込み文言 / URL) を詰める。
 */
/**
 * 転送 (forward) された発言の本文。
 *
 * 転送は content が空で、中身は message_snapshots 側に入る。見ないまま取り込むと
 * 本文なしの行になり、検索に永久に引っかからない。返信の鎖 (agent/index.js) だけが
 * 対応済みで、取り込み側は素通りしていた。
 *
 * 投稿者は Discord が渡してこないので名前は出さない。誰の発言かの取り違えは
 * 捏造と同じ害になるので、転送だと分かる印だけ付ける。
 */
function forwardedContent(message: Message | PartialMessage): string {
  const snapshots = [...(message.messageSnapshots?.values() ?? [])];
  if (snapshots.length === 0) return '';

  const parts = snapshots
    .map((snapshot) => String(snapshot?.content ?? '').trim())
    .filter(Boolean);

  return parts.length > 0 ? `[転送] ${parts.join('\n')}` : '';
}

/** リアクションの絵文字を保存する形にする。カスタム絵文字は <:name:id> */
function reactionEmoji(reaction: MessageReaction | PartialMessageReaction): string {
  return reaction.emoji.id
    ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>`
    : reaction.emoji.name ?? '';
}

export function toRecord(message: Message | PartialMessage): MessageRecord {
  // Forwarded text belongs to the snapshot, never to the forwarding author.
  const content = message.content ?? '';
  const attachments = [...message.attachments.values()];
  const kinds = new Set(attachments.map(attachmentKind));

  const extraParts: string[] = [];
  // Searchable quoted material remains separate from sender-authored content.
  const forwarded = forwardedContent(message);
  if (forwarded) extraParts.push(forwarded);
  for (const attachment of attachments) {
    extraParts.push(attachment.name ?? '');
    if (attachment.description) extraParts.push(attachment.description);
  }
  for (const embed of message.embeds ?? []) {
    extraParts.push(embed.title ?? '', embed.description ?? '', embed.author?.name ?? '', embed.footer?.text ?? '');
    for (const embedField of embed.fields ?? []) {
      extraParts.push(embedField.name ?? '', embedField.value ?? '');
    }
  }
  for (const sticker of message.stickers?.values() ?? []) {
    extraParts.push(sticker.name ?? '');
  }

  const links = extractLinks(content);
  for (const link of links) extraParts.push(link.url);

  const reactions: ReactionRecord[] = [...(message.reactions?.cache?.values() ?? [])].map((reaction) => ({
    emoji: reactionEmoji(reaction),
    count: reaction.count ?? 0
  }));

  const channel = message.channel;

  return {
    message_id: message.id,
    guild_id: message.guildId ?? message.guild?.id ?? '',
    channel_id: message.channelId,
    parent_id: channel?.isThread?.() ? channel.parentId : null,
    author_id: message.author?.id ?? '0',
    author_name: message.member?.displayName ?? message.author?.globalName ?? message.author?.username ?? '',
    is_bot: message.author?.bot ? 1 : 0,
    content,
    extra: extraParts.filter(Boolean).join('\n'),
    created_at: message.createdTimestamp,
    edited_at: message.editedTimestamp ?? null,
    reply_to: message.reference?.messageId ?? null,
    structure_json: JSON.stringify(discordStructure(message)),
    attachment_count: attachments.length,
    attachment_kinds: kinds.size > 0 ? ` ${[...kinds].join(' ')} ` : '',
    embed_count: message.embeds?.length ?? 0,
    sticker_count: message.stickers?.size ?? 0,
    link_count: links.length,
    reaction_count: reactions.reduce((sum, reaction) => sum + reaction.count, 0),
    char_count: Array.from(content).length,
    pinned: message.pinned ? 1 : 0,
    mentions: [...(message.mentions?.users?.keys() ?? [])],
    reactions,
    links
  };
}

/**
 * フォーラムのタグを ` 名前 名前 ` の形にする。
 *
 * appliedTags は ID の配列で、名前は親フォーラムの availableTags 側にある。
 * ID のまま持つと検索のたびに親を引く羽目になるので、取り込みの時点で名前に直す。
 * 親が取れない (キャッシュに無い) ときは空にする — ID を混ぜると `tag:` が
 * 数字にしか当たらなくなり、静かに0件を返す方が悪い。
 */
function appliedTags(channel: GuildBasedChannel): string {
  if (!('appliedTags' in channel)) return '';
  const ids = channel.appliedTags;
  if (!Array.isArray(ids) || ids.length === 0) return '';

  const parent = channel.parent;
  const available = parent && 'availableTags' in parent ? parent.availableTags : undefined;
  if (!Array.isArray(available) || available.length === 0) return '';

  const names = ids
    .flatMap((id) => {
      const name = available.find((tag) => tag.id === id)?.name;
      return name ? [name] : [];
    })
    .map((name) => name.toLowerCase().replace(/\s+/g, '_'));

  return names.length > 0 ? ` ${names.join(' ')} ` : '';
}

function channelRow(channel: GuildBasedChannel): ChannelInput {
  return {
    channel_id: channel.id,
    guild_id: channel.guildId ?? channel.guild?.id ?? '',
    parent_id: isThreadType(channel.type) ? channel.parentId : null,
    name: channel.name ?? '',
    type: channel.type,
    is_thread: isThreadType(channel.type) ? 1 : 0,
    is_private: channel.type === ChannelType.PrivateThread ? 1 : 0,
    applied_tags: appliedTags(channel),
    // スレッドに topic は無い。フォーラム本体とテキストチャンネルだけが持つ。
    topic: String(('topic' in channel ? channel.topic : null) ?? '').slice(0, 500)
  };
}

async function collectThreads(
  channel: ThreadContainer,
  botMember: GuildMember,
  errors: IndexFailure[] = [],
  skipped: (string | IndexFailure)[] = []
): Promise<AnyThreadChannel[]> {
  const threads: AnyThreadChannel[] = [];

  const active = await channel.threads.fetchActive().catch((error: unknown) => {
    errors.push({ channelId: channel.id, stage: 'active_threads', code: errorCode(error, 'code') ?? errorCode(error, 'status') ?? 'unavailable' });
    return null;
  });
  if (active) threads.push(...active.threads.values());

  for (const type of ['public', 'private'] as const) {
    if (type === 'private' && channel.type !== ChannelType.GuildText) continue;
    let before: string | number | undefined;

    // All-private pagination uses timestamps; joined-private pagination uses
    // thread snowflakes. discord.js supports both when given the right cursor.
    let fetchAll = type === 'private';
    let exhausted = false;

    for (let page = 0; page < 200; page += 1) {
      let failure: unknown;
      let fetched = await channel.threads
        .fetchArchived({ type, fetchAll, limit: PAGE_SIZE, before })
        .catch((error: unknown) => { failure = error; return null; });

      if (!fetched && fetchAll && isAccessDenied(errorCode(failure, 'status') ?? errorCode(failure, 'code'))) {
        fetchAll = false;
        before = undefined;
        fetched = await channel.threads
          .fetchArchived({ type, limit: PAGE_SIZE, before })
          .catch((error: unknown) => { failure = error; return null; });

        if (fetched) {
          console.warn(
            `ManageThreads が無いため #${channel.name ?? channel.id} の非公開スレッドは参加済みのぶんだけ取り込みます。`
          );
        }
      }

      if (!fetched) {
        const item: IndexFailure = {
          channelId: channel.id,
          stage: `${type}_threads`,
          code: errorCode(failure, 'code') ?? errorCode(failure, 'status') ?? 'unavailable'
        };
        if (isAccessDenied(errorCode(failure, 'status') ?? errorCode(failure, 'code'))) skipped.push(item);
        else errors.push(item);
        exhausted = true; break;
      }
      if (fetched.threads.size === 0) { exhausted = true; break; }

      threads.push(...fetched.threads.values());

      let oldest = Infinity;
      for (const thread of fetched.threads.values()) {
        // 注意: discord.js のスレッドに archivedTimestamp は無い (正しくは archiveTimestamp)。
        // 実物では常に createdTimestamp に落ちている。型付けで表に出たが、取り込みの
        // ページ送りを変えないためそのまま読む (検査の模造品は archivedTimestamp を持つ)。
        const archived = field(thread, 'archivedTimestamp');
        const stamp = (typeof archived === 'number' ? archived : null) ?? thread.createdTimestamp ?? 0;
        if (stamp < oldest) oldest = stamp;
      }

      if (!fetched.hasMore) { exhausted = true; break; }
      const next = type === 'private' && !fetchAll
        ? [...fetched.threads.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))[0] : oldest;
      if (!Number.isFinite(oldest) || next === before) {
        errors.push({ channelId: channel.id, stage: `${type}_threads`, code: 'pagination_stalled' });
        exhausted = true; break;
      }
      before = next;
      await sleep(FETCH_DELAY_MS);
    }

    if (!exhausted) {
      errors.push({ channelId: channel.id, stage: `${type}_threads`, code: 'page_limit' });
      console.warn(
        `#${channel.name ?? channel.id} の${type === 'private' ? '非公開' : '公開'}アーカイブ済みスレッドが200ページ上限に達しました。取りきれていません。`
      );
    }
  }

  const unique = new Map<string, AnyThreadChannel>();
  for (const thread of threads) {
    if (!canRead(thread, botMember)) continue;
    unique.set(thread.id, thread);
  }

  return [...unique.values()];
}

export interface IndexableChannels {
  channels: GuildTextBasedChannel[];
  skipped: (string | IndexFailure)[];
  /** bot が読めなかったチャンネルの ID (公開の進捗表示で名前を出さずに済むように) */
  skippedIds: string[];
  errors: IndexFailure[];
}

/**
 * ギルド内でメッセージを取得できるチャンネル (スレッド含む) を全部集める。
 */
export async function collectIndexableChannels(guild: Guild): Promise<IndexableChannels> {
  const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!botMember) return { channels: [], skipped: [], skippedIds: [], errors: [{ code: 'bot_member_unavailable' }] };

  const result: GuildTextBasedChannel[] = [];
  const skipped: (string | IndexFailure)[] = [];
  const skippedIds: string[] = [];
  const errors: IndexFailure[] = [];

  for (const channel of guild.channels.cache.values()) {
    const messageChannel = holdsMessages(channel) && !isThreadType(channel.type) ? channel : null;
    const container = isThreadContainer(channel) ? channel : null;

    if (!messageChannel && !container) continue;

    if (!canRead(channel, botMember)) {
      skipped.push(channel.name ?? channel.id);
      skippedIds.push(channel.id);
      continue;
    }

    if (messageChannel) result.push(messageChannel);

    if (container) {
      const threads = await collectThreads(container, botMember, errors, skipped);
      result.push(...threads);
      await sleep(FETCH_DELAY_MS);
    }
  }

  return { channels: [...new Map(result.map((channel) => [channel.id, channel])).values()], skipped, skippedIds, errors };
}

interface ChannelJobContext {
  mode: string;
  job: ArchiveJob;
}

async function indexChannel(channel: GuildTextBasedChannel, { mode, job }: ChannelJobContext): Promise<number> {
  upsertChannel(channelRow(channel));

  const state = getChannelState(channel.id);
  let indexed = 0;

  const counted = (messages: readonly Message[]): void => {
    indexed += messages.length;
    job.messagesIndexed += messages.length;
  };

  // --- 新しい方向へ (前回の続きから最新まで) ---
  let newest = state?.newest_id ?? null;

  if (newest) {
    let after: string = newest;
    for (;;) {
      if (job.cancelled) return indexed;

      const batch = await channel.messages.fetch({ after, limit: PAGE_SIZE });
      const messages = [...batch.values()].sort((a, b) => (a.createdTimestamp - b.createdTimestamp));
      const last = messages.at(-1)?.id;
      if (!last) break;

      // 発言・区間・位置をページごとに1トランザクションで書く。落ちても直前のページまでは
      // 「取った」と言え、やり直しは同じページを取り直して上書きするだけ。
      savePage(channel.id, messages.map(toRecord), [after, last], { newest_id: last });
      counted(messages);
      newest = last;
      after = last;

      if (batch.size < PAGE_SIZE) break;
      await sleep(FETCH_DELAY_MS);
    }
  }

  // --- 古い方向へ (未完了なら最古まで遡る) ---
  const needsBackfill = mode === 'full' && state?.complete !== 1;

  if (needsBackfill || !newest) {
    let before = state?.oldest_id ?? null;

    for (;;) {
      if (job.cancelled) return indexed;

      const batch = await channel.messages.fetch(before ? { before, limit: PAGE_SIZE } : { limit: PAGE_SIZE });
      const messages = [...batch.values()].sort((a, b) => (b.createdTimestamp - a.createdTimestamp));
      const latest = messages[0];
      const oldest = messages.at(-1)?.id;
      if (!latest || !oldest) {
        updateChannelState(channel.id, { complete: 1 });
        break;
      }

      const reachedStart = batch.size < PAGE_SIZE;

      // 新しい側の端は before (無ければ今回の最新)。ページ内は連続しているので
      // その範囲を1区間として記録する。発言・区間・位置は1トランザクションで書く。
      savePage(channel.id, messages.map(toRecord), [oldest, before ?? latest.id], {
        oldest_id: oldest,
        ...(newest ? {} : { newest_id: latest.id }),
        ...(reachedStart ? { complete: 1 } : {})
      });
      counted(messages);
      newest ??= latest.id;
      before = oldest;

      if (reachedStart) break;

      if (!needsBackfill) break; // update モードでは初回分だけ入れて終わり

      await sleep(FETCH_DELAY_MS);
    }
  }

  updateChannelState(channel.id, {
    message_count: countChannelMessages(channel.id),
    last_error: null
  });

  return indexed;
}

// 追いつきが済んだチャンネル。プロセス内だけの状態で、切断のたびに捨てる。
// これが入っているチャンネルは gateway が連続して繋がっているので、
// 新着メッセージで区間を伸ばしてよい。
const catchupDone = new Set<string>();

export function resetCatchup(): void {
  catchupDone.clear();
}

export function markCatchupDone(channelId: string): void {
  catchupDone.add(channelId);
}

/**
 * 記録済み区間の末尾から今まで取りに行く。
 *
 * bot が落ちている間の分はここでしか埋まらない。live indexing は
 * 追いつきが済むまで区間を伸ばさないので、停止中の穴が消えずに残っている。
 */
async function catchupChannel(channel: GuildTextBasedChannel, { job }: { job: ArchiveJob }): Promise<number> {
  const spans = listSpans(channel.id);
  let anchor = spans.at(-1)?.to_id ?? null;

  if (!anchor) {
    // 区間が無いのに取り込み済みのメッセージがある = channel_spans を入れる前に
    // 取ったチャンネル (と live indexing だけで作られたチャンネル)。
    //
    // ここで「追いつき済み」の印だけ付けて帰ると、復帰後の最初の1通が
    // recordSpan(停止前の newest_id, 今の id) を書いてダウン期間を「取った」ことに
    // してしまい、穴が永久に隠れる。手持ちの範囲を初期区間として1本作ってから追いつく。
    //
    // 限界: この1本は「oldest〜newest は連続して持っている」という仮定を置く。
    // 内側に穴があっても DB からは判別できない。それでも、末尾の穴 (= 停止中の欠損) は
    // これで必ず埋まるので、印だけ付けて帰る現状より確実に良い。
    const range = channelMessageRange(channel.id);
    if (!range.oldestId || !range.newestId) return 0; // 本当に空。/index build の仕事

    recordSpan(channel.id, range.oldestId, range.newestId);
    anchor = range.newestId;
  }

  let cursor = anchor;
  let indexed = 0;

  for (;;) {
    if (job.cancelled) return indexed;

    const batch = await channel.messages.fetch({ after: cursor, limit: PAGE_SIZE });
    const messages = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const last = messages.at(-1)?.id;
    if (!last) break;

    savePage(channel.id, messages.map(toRecord), [cursor, last], { newest_id: last });
    indexed += messages.length;
    job.messagesIndexed += messages.length;
    cursor = last;

    if (batch.size < PAGE_SIZE) break;
    await sleep(FETCH_DELAY_MS);
  }

  if (indexed > 0) {
    updateChannelState(channel.id, { message_count: countChannelMessages(channel.id) });
  }

  // ここまで来たら現在時刻に追いついている。以降は live で伸ばしてよい。
  markCatchupDone(channel.id);
  return indexed;
}

/**
 * 区間の隙間を埋める。ダウンが複数回あった場合など、末尾以外に空いた穴が対象。
 */
async function fillGaps(channel: GuildTextBasedChannel, { job }: { job: ArchiveJob }): Promise<number> {
  let filled = 0;

  for (const gap of channelGaps(channel.id)) {
    let cursor = gap.afterId;

    for (;;) {
      if (job.cancelled) return filled;

      const batch = await channel.messages.fetch({ after: cursor, limit: PAGE_SIZE });
      const messages = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      const last = messages.at(-1)?.id;
      if (!last) break;

      savePage(channel.id, messages.map(toRecord), [cursor, last], null);
      filled += messages.length;
      job.messagesIndexed += messages.length;
      cursor = last;

      // 穴の向こう側に届いたら、recordSpan が両側を1本にまとめている
      if ((snowflakeToMs(last) ?? -Infinity) >= gap.toMs) break;
      if (batch.size < PAGE_SIZE) break;
      await sleep(FETCH_DELAY_MS);
    }
  }

  if (filled > 0) {
    updateChannelState(channel.id, { message_count: countChannelMessages(channel.id) });
  }

  return filled;
}

export interface CoverageJobOptions {
  mode?: 'catchup' | 'verify';
  onProgress?: (job: CoverageJob) => void;
}

/**
 * 起動直後の追いつき / 穴埋め。mode: 'catchup' | 'verify'
 * verify は隙間まで面倒を見る (catchup は末尾だけ)。
 */
export async function runCoverageJob(guild: Guild, { mode = 'catchup', onProgress = () => {} }: CoverageJobOptions = {}): Promise<CoverageJob | null> {
  if (!getGuildState(guild.id)) return null;

  const job: CoverageJob = {
    guildId: guild.id,
    mode,
    cancelled: false,
    startedAt: Date.now(),
    messagesIndexed: 0,
    channelsDone: 0,
    channelsTotal: 0,
    currentChannel: null,
    gapsClosed: 0
  };

  claimJob(guild.id, job);

  try {
    // インデックス済みのチャンネルだけが対象。新規発見は /index build の仕事。
    const known = listChannelStates(guild.id);
    job.channelsTotal = known.length;
    onProgress(job);

    for (const row of known) {
      if (job.cancelled) break;

      const channel = guild.channels.cache.get(row.channel_id)
        ?? await guild.channels.fetch(row.channel_id).catch(() => null);

      if (canFetchMessages(channel)) {
        job.currentChannel = channel.name ?? channel.id;
        job.currentChannelId = channel.id;
        onProgress(job);

        try {
          // 末尾の未検証ぶんも「穴」として数える (停止中の欠損はここに出る)
          const countGaps = (): number => channelGaps(channel.id).length + (channelTailGap(channel.id) ? 1 : 0);
          const before = countGaps();
          // ロックで落ちても、位置はページごとに保存してあるので続きからやり直せる
          await retryBusy(() => catchupChannel(channel, { job }), { label: `catch-up ${channel.id}` });

          if (mode === 'verify') {
            await retryBusy(() => fillGaps(channel, { job }), { label: `gap fill ${channel.id}` });

            // 先頭まで遡れていないチャンネルは、区間の隙間としては見えないので
            // ここで続きを取る。indexChannel の後方走査が oldest_id から再開する。
            if (getChannelState(channel.id)?.complete !== 1) {
              await retryBusy(() => indexChannel(channel, { mode: 'full', job }), { label: `index ${channel.id}` });
            }
          }

          job.gapsClosed += Math.max(0, before - countGaps());
        } catch (error) {
          console.error(`Failed to catch up channel ${row.channel_id}:`, error);
          updateChannelState(row.channel_id, { last_error: errorMessage(error).slice(0, 300) });
        }
      }

      job.channelsDone += 1;
      onProgress(job);
    }

    return job;
  } finally {
    releaseJob(guild.id);
  }
}

// 起動時は ShardReady と ClientReady の両方から呼ばれるので、二重に走らせない。
let catchupRunning = false;

/** 全ギルドの追いつき。起動直後と再接続後に呼ぶ。 */
export async function catchupAllGuilds(client: Client): Promise<void> {
  if (catchupRunning) return;
  catchupRunning = true;

  // 無言で走ると、単一フライトのロックを握っている間に /index embed を叩いた人が
  // 「既に別のジョブが実行中」しか見えず、何を待てばいいのか分からない。
  const startedAt = Date.now();
  console.log('Catch-up started. Other index jobs are blocked until it finishes.');

  try {
    await catchupGuilds(client);
  } finally {
    catchupRunning = false;
    console.log(`Catch-up finished in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
  }
}

async function catchupGuilds(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    const state = getGuildState(guild.id);
    if (!state) continue;

    // 再起動で打ち切られた /index build は「実行中」のまま残る。ジョブは
    // プロセス内にしか無いので、中断に直して、追いつきの後にやり直す
    // (まだ回っていなかったチャンネル・新しく見つかったスレッドを取りこぼさない)。
    // 「中断」のままのものも含める: やり直しの途中でまた再起動されても、終わるまで続ける
    const interrupted = ['running', 'interrupted'].includes(state.status) && !getRunningJob(guild.id) && state.mode === 'full';
    if (state.status === 'running' && !getRunningJob(guild.id)) {
      setGuildState(guild.id, { status: 'interrupted', finished_at: Date.now(), current_channel: null });
    }

    try {
      const job = await runCoverageJob(guild, { mode: 'catchup' });
      if (job && job.messagesIndexed > 0) {
        console.log(`Catch-up indexed ${job.messagesIndexed} message(s) in ${guild.name}.`);
      }
      if (interrupted) {
        // 済んだチャンネルは新着を見るだけ、未完了のものは続きから遡る
        console.log(`Restarting the interrupted /index build for ${guild.name}.`);
        const rerun = await runIndexJob(guild, { mode: 'full' });
        console.log(`Interrupted /index build finished for ${guild.name}: ${rerun.channelsDone}/${rerun.channelsTotal} channel(s), `
          + `${rerun.messagesIndexed} message(s), ${rerun.errors?.length ?? 0} error(s).`);
      } else {
        const resumed = await resumeIncomplete(guild);
        if (resumed) {
          console.log(`Resumed ${resumed.channelsDone}/${resumed.channelsTotal} unfinished channel(s) in ${guild.name}: `
            + `${resumed.messagesIndexed} message(s).`);
        }
      }
    } catch (error) {
      console.error(`Catch-up failed for ${guild.id}:`, error);
    }
  }
}

/**
 * 途中で止まったチャンネル (ロック・不具合・再起動で打ち切られた /index build) を、
 * 起動時に続きから取り直す。位置はページごとに保存してあるので、取り直しは続きから。
 * 全チャンネルを回す verify より軽い (未完了とエラーのものだけ)。
 * 2026-10 に #nsfw がロックで約2年分を取り損ねたまま、誰も取り直さなかった。
 */
export async function resumeIncomplete(guild: Guild): Promise<ArchiveJob | null> {
  const rows = listChannelStates(guild.id).filter((row) => row.complete !== 1 || row.last_error);
  if (rows.length === 0) return null;

  const job: ArchiveJob = {
    guildId: guild.id,
    mode: 'resume',
    cancelled: false,
    startedAt: Date.now(),
    messagesIndexed: 0,
    channelsDone: 0,
    channelsTotal: rows.length,
    currentChannel: null
  };
  claimJob(guild.id, job);
  try {
    for (const row of rows) {
      if (job.cancelled) break;
      const channel = guild.channels.cache.get(row.channel_id)
        ?? await guild.channels.fetch(row.channel_id).catch(() => null);
      if (canFetchMessages(channel)) {
        job.currentChannel = channel.name ?? channel.id;
        job.currentChannelId = channel.id;
        try {
          await retryBusy(() => indexChannel(channel, { mode: 'full', job }), { label: `resume ${channel.id}` });
        } catch (error) {
          console.error(`Failed to resume channel ${channel.id}:`, error);
          updateChannelState(channel.id, { last_error: errorMessage(error).slice(0, 300) });
        }
      }
      job.channelsDone += 1;
    }
    return job;
  } finally {
    releaseJob(guild.id);
  }
}

/**
 * チャンネルごとの被覆状況。/index status 用。
 * 区間の隙間だけでなく、未検証の末尾 (停止中に流れた分) も数える。
 */
// チャンネル作成から最初の発言までは普通に空くので、これ未満は穴と見なさない。
const HEAD_TOLERANCE_MS = 86_400_000;

export interface CoverageReport {
  verifiedFull: boolean;
  /** 全履歴の列挙記録にあったチャンネル ID (記録の中身をそのまま) */
  verifiedChannelIds: unknown[];
  /** archive_state に残した列挙の記録 (JSON をそのまま。無ければ null) */
  enumeration: unknown;
  gapCount: number;
  gapMs: number;
  worst: { channelId: string; gaps: number; ms: number }[];
  unspanned: string[];
  headMissing: { channelId: string; ms: number }[];
  headMissingCount: number;
  clean: boolean;
}

function readEnumeration(guildId: string): unknown {
  const row = db.prepare<[string], { value: string }>('SELECT value FROM archive_state WHERE key=?').get(`archive-full-coverage:${guildId}`);
  try {
    const parsed: unknown = JSON.parse(row?.value ?? 'null');
    return parsed;
  } catch {
    return null;
  }
}

export function coverageReport(guildId: string): CoverageReport {
  const channels = listChannelStates(guildId);
  const enumeration = readEnumeration(guildId);
  const recordedIds = field(enumeration, 'channelIds');
  const verifiedChannelIds: unknown[] = Array.isArray(recordedIds) ? recordedIds : [];
  const recordedErrors = field(enumeration, 'errors');
  const verifiedFull = Boolean(field(enumeration, 'schema') === 1 && field(enumeration, 'guildId') === guildId && field(enumeration, 'complete')
    && field(enumeration, 'mode') === 'full' && verifiedChannelIds.length
    && !(Array.isArray(recordedErrors) && recordedErrors.length > 0)
    && verifiedChannelIds.every((id) => channels.some((row) => row.channel_id === id && row.complete === 1 && !row.last_error)));
  let gapCount = 0;
  let gapMs = 0;
  const worst: { channelId: string; gaps: number; ms: number }[] = [];
  const unspanned: string[] = [];
  const headMissing: { channelId: string; ms: number }[] = [];

  for (const row of channels) {
    const spans = listSpans(row.channel_id);
    const first = spans[0];

    // 区間が1本も無いのにメッセージがある = 区間管理を入れる前に取ったチャンネル。
    // 区間が無い間は隙間も末尾も計算できないので、被覆の計算から漏れている。
    if (!first && row.message_count > 0) unspanned.push(row.channel_id);

    // 先頭に届いていないぶん。区間の隙間では絶対に見えない
    // (半分だけ取り込んだチャンネルは「連続した1本の区間」に見えるため)。
    if (row.complete !== 1 && first) {
      const createdAt = snowflakeToMs(row.channel_id);
      const missing = createdAt ? first.from_ms - createdAt : 0;
      if (missing > HEAD_TOLERANCE_MS) {
        headMissing.push({ channelId: row.channel_id, ms: missing });
      }
    }

    const gaps: { fromMs: number; toMs: number }[] = [...channelGaps(row.channel_id)];
    const tail = channelTailGap(row.channel_id);
    if (tail) gaps.push(tail);
    if (gaps.length === 0) continue;

    const total = gaps.reduce((sum, gap) => sum + Math.max(0, gap.toMs - gap.fromMs), 0);
    gapCount += gaps.length;
    gapMs += total;
    worst.push({ channelId: row.channel_id, gaps: gaps.length, ms: total });
  }

  worst.sort((a, b) => b.ms - a.ms);
  headMissing.sort((a, b) => b.ms - a.ms);

  return {
    verifiedFull, verifiedChannelIds, enumeration,
    gapCount,
    gapMs,
    worst: worst.slice(0, 5),
    unspanned,
    headMissing: headMissing.slice(0, 5),
    headMissingCount: headMissing.length,
    clean: gapCount === 0 && unspanned.length === 0 && headMissing.length === 0
  };
}

/**
 * ジョブの単一フライト。取り込みと埋め込みで共有する。
 * 7.8GiB のコンテナで10万件フェッチと埋め込みを同時に走らせたくないし、
 * 共有すれば /index cancel と /index status が両方に無改造で効く。
 */
export function claimJob(guildId: string, job: RunningJob): void {
  const running = runningJobs.get(guildId);
  if (running) {
    throw new Error(`このサーバーでは既に別のジョブが実行中です (${running.mode ?? '不明'})。`);
  }
  runningJobs.set(guildId, job);
}

export function releaseJob(guildId: string): void {
  runningJobs.delete(guildId);
}

export function getRunningJob(guildId: string): RunningJob | undefined {
  return runningJobs.get(guildId);
}

export function cancelJob(guildId: string): boolean {
  const job = runningJobs.get(guildId);
  if (!job) return false;
  job.cancelled = true;
  return true;
}

export interface IndexJobOptions {
  mode?: 'full' | 'update';
  onProgress?: (job: IndexJob) => void;
}

/**
 * ギルド全体のインデックス作成。
 * mode: 'full' = 最古まで遡る / 'update' = 前回の続きだけ
 */
export async function runIndexJob(guild: Guild, { mode = 'full', onProgress = () => {} }: IndexJobOptions = {}): Promise<IndexJob> {
  const job: IndexJob = {
    guildId: guild.id,
    mode,
    cancelled: false,
    startedAt: Date.now(),
    messagesIndexed: 0,
    channelsDone: 0,
    channelsTotal: 0,
    currentChannel: null
  };
  const saveEnumeration = (complete = false): void => {
    if (mode !== 'full') return;
    db.prepare<[string, string]>(`INSERT INTO archive_state(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(`archive-full-coverage:${guild.id}`,
      JSON.stringify({ schema: 1, guildId: guild.id, mode, startedAt: job.startedAt, finishedAt: complete ? Date.now() : null,
        complete, channelIds: job.channelIds ?? [], skipped: job.skipped ?? [], errors: job.errors ?? [] }));
  };

  claimJob(guild.id, job);
  saveEnumeration();
  setGuildState(guild.id, {
    status: 'running',
    mode,
    started_at: job.startedAt,
    finished_at: null,
    messages_indexed: 0,
    channels_done: 0,
    channels_total: 0,
    current_channel: null,
    last_error: null
  });

  try {
    const { channels, skipped, skippedIds, errors } = await collectIndexableChannels(guild);
    job.channelsTotal = channels.length;
    job.skipped = skipped;
    job.skippedIds = skippedIds;
    job.errors = errors;
    job.channelIds = channels.map((channel) => channel.id);
    saveEnumeration();
    setGuildState(guild.id, { channels_total: channels.length });
    onProgress(job);

    // ロックの取り合いは待ってやり直す。位置はページごとに保存してあるので、
    // やり直しは続きから。1チャンネルの失敗でジョブ全体の「全件取得」を落とさない。
    const indexOne = (channel: GuildTextBasedChannel): Promise<number> => retryBusy(() => indexChannel(channel, { mode, job }), { label: `index ${channel.id}` });
    const failed: GuildTextBasedChannel[] = [];

    for (const channel of channels) {
      if (job.cancelled) break;

      job.currentChannel = channel.name ?? channel.id;
      job.currentChannelId = channel.id;
      onProgress(job);

      try {
        await indexOne(channel);
      } catch (error) {
        console.error(`Failed to index channel ${channel.id} (will retry once at the end):`, error);
        failed.push(channel);
      }

      job.channelsDone += 1;
      setGuildState(guild.id, {
        channels_done: job.channelsDone,
        messages_indexed: job.messagesIndexed,
        current_channel: job.currentChannel
      });
      onProgress(job);
    }

    // 一時的な失敗 (ロック・Discord の一時エラー) は、最後にもう一周すると通ることが多い
    for (const channel of failed) {
      if (job.cancelled) break;
      job.currentChannel = `${channel.name ?? channel.id} (再試行)`;
      job.currentChannelId = channel.id;
      onProgress(job);
      try {
        await indexOne(channel);
      } catch (error) {
        errors.push({ channelId: channel.id, stage: 'messages', code: errorCode(error, 'code') ?? errorCode(error, 'status') ?? 'unavailable' });
        console.error(`Failed to index channel ${channel.id}:`, error);
        upsertChannel(channelRow(channel));
        updateChannelState(channel.id, { last_error: errorMessage(error).slice(0, 300) });
      }
    }

    setGuildState(guild.id, {
      status: job.cancelled ? 'cancelled' : 'idle',
      finished_at: Date.now(),
      messages_indexed: job.messagesIndexed,
      channels_done: job.channelsDone,
      current_channel: null
    });
    saveEnumeration(!job.cancelled && !errors.length && job.channelsDone === job.channelsTotal);

    return job;
  } catch (error) {
    setGuildState(guild.id, {
      status: 'error',
      finished_at: Date.now(),
      last_error: errorMessage(error).slice(0, 300)
    });
    throw error;
  } finally {
    releaseJob(guild.id);
  }
}

/**
 * インデックス済みのサーバーでは、新着メッセージをそのまま追記していく。
 * これがないと /index を回すたびに差分を取りに行くことになる。
 */
// 新着の書き込みがロックで失敗したら、少し待って入れ直す (取りこぼさない)。
const LIVE_RETRIES = 5;
function retryLive(label: string, attempt: number, run: () => void): void {
  if (attempt >= LIVE_RETRIES) {
    console.error(`${label}: database stayed locked, giving up (the next catch-up will fill it)`);
    return;
  }
  setTimeout(run, 2000 * 2 ** attempt).unref?.();
}

export function indexLiveMessage(message: Message, attempt = 0): void {
  if (!message.guildId) return;
  if (!getGuildState(message.guildId)) return;

  try {
    if (isGuildChannel(message.channel) && !getChannelState(message.channelId)) {
      upsertChannel(channelRow(message.channel));
    }

    const previous = getChannelState(message.channelId)?.newest_id ?? null;

    saveMessage(toRecord(message));
    updateChannelState(message.channelId, { newest_id: message.id });

    // 区間を伸ばすのは「このチャンネルの追いつきが済んでいる」ときだけ。
    // 接続が切れている間の分は gateway から届かないので、追いつき前に伸ばすと
    // 落ちていた期間を「取った」ことにしてしまい、穴が永久に隠れる。
    if (previous && catchupDone.has(message.channelId)) {
      recordSpan(message.channelId, previous, message.id);
    }
  } catch (error) {
    if (isBusy(error)) return retryLive('live message', attempt, () => indexLiveMessage(message, attempt + 1));
    console.error('Failed to index live message:', error);
  }
}

export function indexLiveEdit(message: Message | PartialMessage, attempt = 0): void {
  if (!message.guildId || !message.author) return;
  if (!getGuildState(message.guildId)) return;

  try {
    saveMessage(toRecord(message));
  } catch (error) {
    if (isBusy(error)) return retryLive('live edit', attempt, () => indexLiveEdit(message, attempt + 1));
    console.error('Failed to index edited message:', error);
  }
}

export function markLiveDelete(message: Message | PartialMessage, attempt = 0): void {
  // 削除イベントは partial で届くことがあるので guildId を複数経路から拾う
  const channel = message.channel;
  const guildId = message.guildId ?? message.guild?.id ?? (isGuildChannel(channel) ? channel.guildId : null);
  if (!guildId || !getGuildState(guildId)) return;

  try {
    markMessageDeleted(message.id);
  } catch (error) {
    if (isBusy(error)) return retryLive('live delete', attempt, () => markLiveDelete(message, attempt + 1));
    console.error('Failed to mark message deleted:', error);
  }
}

// 誰が押したかを記録するか。既定は on。
const RECORD_REACTION_USERS = !['0', 'false', 'no', 'off']
  .includes(String(process.env.ARCHIVE_REACTION_USERS ?? '').toLowerCase());

// これを超えた絵文字は誰が押したかを取りに行かない。
// users.fetch() は絵文字1つにつき API 1回で、大量に付いた絵文字の全員は
// 「誰が押した？」の答えとしても要らない (数の話になる)。
const REACTION_USER_CAP = 25;

export async function syncLiveReactions(message: Message | PartialMessage | null | undefined): Promise<void> {
  if (!message?.guildId) return;
  if (!getGuildState(message.guildId)) return;

  try {
    const cached = [...(message.reactions?.cache?.values() ?? [])];
    const reactions: ReactionRecord[] = [];

    for (const reaction of cached) {
      const emoji = reactionEmoji(reaction);
      const count = reaction.count ?? 0;

      // 押した人はここでしか取れない。過去ぶんの一括取得はしない方針なので、
      // リアクションが動いたこの瞬間に1メッセージぶんだけ拾う。
      // 取れなかったら users を付けずに返す (空配列で「誰も押していない」にしない)。
      let users: string[] | undefined;
      if (RECORD_REACTION_USERS && count > 0 && count <= REACTION_USER_CAP) {
        const fetched = await reaction.users.fetch({ limit: REACTION_USER_CAP }).catch(() => null);
        if (fetched) users = [...fetched.keys()];
      }

      reactions.push(users ? { emoji, count, users } : { emoji, count });
    }

    await retryBusy(() => replaceReactions(message.id, reactions), { label: 'reactions' });
  } catch (error) {
    console.error('Failed to sync reactions:', error);
  }
}
