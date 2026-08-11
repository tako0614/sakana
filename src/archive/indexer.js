import { ChannelType } from 'discord.js';
import {
  channelGaps,
  channelMessageRange,
  channelTailGap,
  countChannelMessages,
  getChannelState,
  getGuildState,
  listChannelStates,
  listSpans,
  markMessageDeleted,
  recordSpan,
  replaceReactions,
  saveMessage,
  saveMessages,
  setGuildState,
  snowflakeToMs,
  updateChannelState,
  upsertChannel
} from './db.js';
import { MESSAGE_CHANNEL_TYPES, THREAD_CONTAINER_TYPES, canRead, isThreadType } from './permissions.js';

const FETCH_DELAY_MS = Number(process.env.ARCHIVE_FETCH_DELAY_MS ?? 150);
const PAGE_SIZE = 100;
const LINK_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/gi;

const runningJobs = new Map(); // guildId -> job

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractLinks(content) {
  const links = [];
  const seen = new Set();

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

function attachmentKind(attachment) {
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
export function toRecord(message) {
  const content = message.content ?? '';
  const attachments = [...message.attachments.values()];
  const kinds = new Set(attachments.map(attachmentKind));

  const extraParts = [];
  for (const attachment of attachments) {
    extraParts.push(attachment.name ?? '');
    if (attachment.description) extraParts.push(attachment.description);
  }
  for (const embed of message.embeds ?? []) {
    extraParts.push(embed.title ?? '', embed.description ?? '', embed.author?.name ?? '', embed.footer?.text ?? '');
    for (const field of embed.fields ?? []) {
      extraParts.push(field.name ?? '', field.value ?? '');
    }
  }
  for (const sticker of message.stickers?.values() ?? []) {
    extraParts.push(sticker.name ?? '');
  }

  const links = extractLinks(content);
  for (const link of links) extraParts.push(link.url);

  const reactions = [...(message.reactions?.cache?.values() ?? [])].map((reaction) => ({
    emoji: reaction.emoji.id ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name,
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

function channelRow(channel) {
  return {
    channel_id: channel.id,
    guild_id: channel.guildId ?? channel.guild?.id ?? '',
    parent_id: isThreadType(channel.type) ? channel.parentId : null,
    name: channel.name ?? '',
    type: channel.type,
    is_thread: isThreadType(channel.type) ? 1 : 0,
    is_private: channel.type === ChannelType.PrivateThread ? 1 : 0
  };
}

async function collectThreads(channel, botMember) {
  const threads = [];

  const active = await channel.threads.fetchActive().catch(() => null);
  if (active) threads.push(...active.threads.values());

  for (const type of ['public', 'private']) {
    let before;

    // private は fetchAll を付けないと discord.js が before をリクエストに載せず
    // (ThreadManager が type==='public' || fetchAll のときだけ before を送る)、
    // さらに「bot が参加済み」のスレッドしか返さない経路を使う。
    // つまり同じ1ページ目を200回引き直して、101件目以降は永久に取り込まれない。
    // fetchAll には ManageThreads が要るので、拒否されたら従来の経路に落とす。
    let fetchAll = type === 'private';
    let exhausted = false;

    for (let page = 0; page < 200; page += 1) {
      let fetched = await channel.threads
        .fetchArchived({ type, fetchAll, limit: PAGE_SIZE, before })
        .catch(() => null);

      if (!fetched && fetchAll) {
        fetchAll = false;
        fetched = await channel.threads
          .fetchArchived({ type, limit: PAGE_SIZE, before })
          .catch(() => null);

        if (fetched) {
          console.warn(
            `ManageThreads が無いため #${channel.name ?? channel.id} の非公開スレッドは参加済みのぶんだけ取り込みます。`
          );
        }
      }

      if (!fetched || fetched.threads.size === 0) { exhausted = true; break; }

      threads.push(...fetched.threads.values());

      let oldest = Infinity;
      for (const thread of fetched.threads.values()) {
        const stamp = thread.archivedTimestamp ?? thread.createdTimestamp ?? 0;
        if (stamp < oldest) oldest = stamp;
      }

      if (!fetched.hasMore || !Number.isFinite(oldest)) { exhausted = true; break; }

      // before が効かない経路では次ページを引いても同じ結果なので、ここで打ち切る
      if (type === 'private' && !fetchAll) { exhausted = true; break; }

      before = oldest;
      await sleep(FETCH_DELAY_MS);
    }

    if (!exhausted) {
      console.warn(
        `#${channel.name ?? channel.id} の${type === 'private' ? '非公開' : '公開'}アーカイブ済みスレッドが200ページ上限に達しました。取りきれていません。`
      );
    }
  }

  const unique = new Map();
  for (const thread of threads) {
    if (!canRead(thread, botMember)) continue;
    unique.set(thread.id, thread);
  }

  return [...unique.values()];
}

/**
 * ギルド内でメッセージを取得できるチャンネル (スレッド含む) を全部集める。
 */
export async function collectIndexableChannels(guild) {
  const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!botMember) return { channels: [], skipped: [] };

  const result = [];
  const skipped = [];

  for (const channel of guild.channels.cache.values()) {
    const hasMessages = MESSAGE_CHANNEL_TYPES.has(channel.type) && !isThreadType(channel.type);
    const hasThreads = THREAD_CONTAINER_TYPES.has(channel.type);

    if (!hasMessages && !hasThreads) continue;

    if (!canRead(channel, botMember)) {
      skipped.push(channel.name ?? channel.id);
      continue;
    }

    if (hasMessages) result.push(channel);

    if (hasThreads) {
      const threads = await collectThreads(channel, botMember);
      result.push(...threads);
      await sleep(FETCH_DELAY_MS);
    }
  }

  return { channels: result, skipped };
}

async function indexChannel(channel, { mode, job }) {
  upsertChannel(channelRow(channel));

  const state = getChannelState(channel.id) ?? {};
  let indexed = 0;

  const persist = (messages) => {
    if (messages.length === 0) return;
    saveMessages(messages.map(toRecord));
    indexed += messages.length;
    job.messagesIndexed += messages.length;
  };

  // --- 新しい方向へ (前回の続きから最新まで) ---
  let newest = state.newest_id ?? null;

  if (newest) {
    for (;;) {
      if (job.cancelled) return indexed;

      const batch = await channel.messages.fetch({ after: newest, limit: PAGE_SIZE });
      if (batch.size === 0) break;

      const messages = [...batch.values()].sort((a, b) => (a.createdTimestamp - b.createdTimestamp));
      persist(messages);

      // 区間はページごとに書く。落ちても直前のページまでは「取った」と言える。
      recordSpan(channel.id, newest, messages[messages.length - 1].id);

      newest = messages[messages.length - 1].id;
      updateChannelState(channel.id, { newest_id: newest });

      if (batch.size < PAGE_SIZE) break;
      await sleep(FETCH_DELAY_MS);
    }
  }

  // --- 古い方向へ (未完了なら最古まで遡る) ---
  const needsBackfill = mode === 'full' && state.complete !== 1;

  if (needsBackfill || !newest) {
    let before = state.oldest_id ?? null;

    for (;;) {
      if (job.cancelled) return indexed;

      const batch = await channel.messages.fetch(before ? { before, limit: PAGE_SIZE } : { limit: PAGE_SIZE });
      if (batch.size === 0) {
        updateChannelState(channel.id, { complete: 1 });
        break;
      }

      const messages = [...batch.values()].sort((a, b) => (b.createdTimestamp - a.createdTimestamp));
      persist(messages);

      // 新しい側の端は before (無ければ今回の最新)。ページ内は連続しているので
      // その範囲を1区間として記録する。
      recordSpan(channel.id, messages[messages.length - 1].id, before ?? messages[0].id);

      if (!newest) {
        newest = messages[0].id;
        updateChannelState(channel.id, { newest_id: newest });
      }

      before = messages[messages.length - 1].id;
      updateChannelState(channel.id, { oldest_id: before });

      if (batch.size < PAGE_SIZE) {
        updateChannelState(channel.id, { complete: 1 });
        break;
      }

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
const catchupDone = new Set();

export function resetCatchup() {
  catchupDone.clear();
}

export function markCatchupDone(channelId) {
  catchupDone.add(channelId);
}

/**
 * 記録済み区間の末尾から今まで取りに行く。
 *
 * bot が落ちている間の分はここでしか埋まらない。live indexing は
 * 追いつきが済むまで区間を伸ばさないので、停止中の穴が消えずに残っている。
 */
async function catchupChannel(channel, { job }) {
  const spans = listSpans(channel.id);
  let anchor = spans.length > 0 ? spans[spans.length - 1].to_id : null;

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
    if (batch.size === 0) break;

    const messages = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    saveMessages(messages.map(toRecord));
    indexed += messages.length;
    job.messagesIndexed += messages.length;

    recordSpan(channel.id, cursor, messages[messages.length - 1].id);
    cursor = messages[messages.length - 1].id;
    updateChannelState(channel.id, { newest_id: cursor });

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
async function fillGaps(channel, { job }) {
  let filled = 0;

  for (const gap of channelGaps(channel.id)) {
    let cursor = gap.afterId;

    for (;;) {
      if (job.cancelled) return filled;

      const batch = await channel.messages.fetch({ after: cursor, limit: PAGE_SIZE });
      if (batch.size === 0) break;

      const messages = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      saveMessages(messages.map(toRecord));
      filled += messages.length;
      job.messagesIndexed += messages.length;

      const last = messages[messages.length - 1].id;
      recordSpan(channel.id, cursor, last);
      cursor = last;

      // 穴の向こう側に届いたら、recordSpan が両側を1本にまとめている
      if (snowflakeToMs(last) >= gap.toMs) break;
      if (batch.size < PAGE_SIZE) break;
      await sleep(FETCH_DELAY_MS);
    }
  }

  if (filled > 0) {
    updateChannelState(channel.id, { message_count: countChannelMessages(channel.id) });
  }

  return filled;
}

/**
 * 起動直後の追いつき / 穴埋め。mode: 'catchup' | 'verify'
 * verify は隙間まで面倒を見る (catchup は末尾だけ)。
 */
export async function runCoverageJob(guild, { mode = 'catchup', onProgress = () => {} } = {}) {
  if (!getGuildState(guild.id)) return null;

  const job = {
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

      if (channel && typeof channel.messages?.fetch === 'function') {
        job.currentChannel = channel.name ?? channel.id;
        onProgress(job);

        try {
          // 末尾の未検証ぶんも「穴」として数える (停止中の欠損はここに出る)
          const countGaps = () => channelGaps(channel.id).length + (channelTailGap(channel.id) ? 1 : 0);
          const before = countGaps();
          await catchupChannel(channel, { job });

          if (mode === 'verify') {
            await fillGaps(channel, { job });

            // 先頭まで遡れていないチャンネルは、区間の隙間としては見えないので
            // ここで続きを取る。indexChannel の後方走査が oldest_id から再開する。
            if (getChannelState(channel.id)?.complete !== 1) {
              await indexChannel(channel, { mode: 'full', job });
            }
          }

          job.gapsClosed += Math.max(0, before - countGaps());
        } catch (error) {
          console.error(`Failed to catch up channel ${row.channel_id}:`, error);
          updateChannelState(row.channel_id, { last_error: String(error.message ?? error).slice(0, 300) });
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
export async function catchupAllGuilds(client) {
  if (catchupRunning) return;
  catchupRunning = true;

  try {
    await catchupGuilds(client);
  } finally {
    catchupRunning = false;
  }
}

async function catchupGuilds(client) {
  for (const guild of client.guilds.cache.values()) {
    if (!getGuildState(guild.id)) continue;

    try {
      const job = await runCoverageJob(guild, { mode: 'catchup' });
      if (job?.messagesIndexed > 0) {
        console.log(`Catch-up indexed ${job.messagesIndexed} message(s) in ${guild.name}.`);
      }
    } catch (error) {
      console.error(`Catch-up failed for ${guild.id}:`, error);
    }
  }
}

/**
 * チャンネルごとの被覆状況。/index status 用。
 * 区間の隙間だけでなく、未検証の末尾 (停止中に流れた分) も数える。
 */
// チャンネル作成から最初の発言までは普通に空くので、これ未満は穴と見なさない。
const HEAD_TOLERANCE_MS = 86_400_000;

export function coverageReport(guildId) {
  const channels = listChannelStates(guildId);
  let gapCount = 0;
  let gapMs = 0;
  const worst = [];
  const unspanned = [];
  const headMissing = [];

  for (const row of channels) {
    const spans = listSpans(row.channel_id);

    // 区間が1本も無いのにメッセージがある = 区間管理を入れる前に取ったチャンネル。
    // 区間が無い間は隙間も末尾も計算できないので、被覆の計算から漏れている。
    if (spans.length === 0 && row.message_count > 0) unspanned.push(row.channel_id);

    // 先頭に届いていないぶん。区間の隙間では絶対に見えない
    // (半分だけ取り込んだチャンネルは「連続した1本の区間」に見えるため)。
    if (row.complete !== 1 && spans.length > 0) {
      const createdAt = snowflakeToMs(row.channel_id);
      const missing = createdAt ? spans[0].from_ms - createdAt : 0;
      if (missing > HEAD_TOLERANCE_MS) {
        headMissing.push({ channelId: row.channel_id, ms: missing });
      }
    }

    const gaps = [...channelGaps(row.channel_id)];
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
export function claimJob(guildId, job) {
  if (runningJobs.has(guildId)) {
    throw new Error('このサーバーでは既に別のジョブが実行中です。');
  }
  runningJobs.set(guildId, job);
}

export function releaseJob(guildId) {
  runningJobs.delete(guildId);
}

export function getRunningJob(guildId) {
  return runningJobs.get(guildId);
}

export function cancelJob(guildId) {
  const job = runningJobs.get(guildId);
  if (!job) return false;
  job.cancelled = true;
  return true;
}

/**
 * ギルド全体のインデックス作成。
 * mode: 'full' = 最古まで遡る / 'update' = 前回の続きだけ
 */
export async function runIndexJob(guild, { mode = 'full', onProgress = () => {} } = {}) {
  const job = {
    guildId: guild.id,
    mode,
    cancelled: false,
    startedAt: Date.now(),
    messagesIndexed: 0,
    channelsDone: 0,
    channelsTotal: 0,
    currentChannel: null
  };

  claimJob(guild.id, job);
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
    const { channels, skipped } = await collectIndexableChannels(guild);
    job.channelsTotal = channels.length;
    job.skipped = skipped;
    setGuildState(guild.id, { channels_total: channels.length });
    onProgress(job);

    for (const channel of channels) {
      if (job.cancelled) break;

      job.currentChannel = channel.name ?? channel.id;
      onProgress(job);

      try {
        await indexChannel(channel, { mode, job });
      } catch (error) {
        console.error(`Failed to index channel ${channel.id}:`, error);
        upsertChannel(channelRow(channel));
        updateChannelState(channel.id, { last_error: String(error.message ?? error).slice(0, 300) });
      }

      job.channelsDone += 1;
      setGuildState(guild.id, {
        channels_done: job.channelsDone,
        messages_indexed: job.messagesIndexed,
        current_channel: job.currentChannel
      });
      onProgress(job);
    }

    setGuildState(guild.id, {
      status: job.cancelled ? 'cancelled' : 'idle',
      finished_at: Date.now(),
      messages_indexed: job.messagesIndexed,
      channels_done: job.channelsDone,
      current_channel: null
    });

    return job;
  } catch (error) {
    setGuildState(guild.id, {
      status: 'error',
      finished_at: Date.now(),
      last_error: String(error.message ?? error).slice(0, 300)
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
export function indexLiveMessage(message) {
  if (!message.guildId) return;
  if (!getGuildState(message.guildId)) return;

  try {
    if (message.channel && !getChannelState(message.channelId)) {
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
    console.error('Failed to index live message:', error);
  }
}

export function indexLiveEdit(message) {
  if (!message.guildId || !message.author) return;
  if (!getGuildState(message.guildId)) return;

  try {
    saveMessage(toRecord(message));
  } catch (error) {
    console.error('Failed to index edited message:', error);
  }
}

export function markLiveDelete(message) {
  // 削除イベントは partial で届くことがあるので guildId を複数経路から拾う
  const guildId = message.guildId ?? message.guild?.id ?? message.channel?.guildId;
  if (!guildId || !getGuildState(guildId)) return;

  try {
    markMessageDeleted(message.id);
  } catch (error) {
    console.error('Failed to mark message deleted:', error);
  }
}

export function syncLiveReactions(message) {
  if (!message?.guildId) return;
  if (!getGuildState(message.guildId)) return;

  try {
    const reactions = [...(message.reactions?.cache?.values() ?? [])].map((reaction) => ({
      emoji: reaction.emoji.id ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name,
      count: reaction.count ?? 0
    }));

    replaceReactions(message.id, reactions);
  } catch (error) {
    console.error('Failed to sync reactions:', error);
  }
}
