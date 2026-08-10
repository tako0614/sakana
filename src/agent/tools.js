// エージェントが使えるツール。
//
// 数を絞るのが方針。ツール定義は毎ターン送り直すので、1つ増やすたびに
// 全往復ぶんのトークンが増える。使えないツールは最初から出さない
// (アーカイブ未構築なら検索系を出さない / Chrome が居なければブラウザを出さない)。

import { db as archiveDb, getGuildState } from '../archive/db.js';
import { MESSAGE_CHANNEL_TYPES, canRead } from '../archive/permissions.js';
import { QueryError } from '../archive/query.js';
import { aggregateSearch, search, searchSummary } from '../archive/search.js';
import { browserToolDefinition, runBrowserAction } from './browser.js';
import { cdpAvailable } from './cdp.js';
import { agentConfig } from './config.js';
import {
  formatMessages,
  fromArchiveRow,
  fromDiscordMessage,
  fromRawMessage,
  shortTime,
  truncate
} from './format.js';

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

function channelName(ctx, channelId) {
  const cached = ctx.guild.channels.cache.get(channelId);
  if (cached?.name) return cached.name;

  try {
    const row = archiveDb.prepare('SELECT name FROM channels WHERE channel_id = ?').get(channelId);
    if (row?.name) return row.name;
  } catch {
    // アーカイブが無い構成でも動くようにする
  }

  return channelId;
}

/**
 * ユーザー ID を人が読める名前にする。
 * メンバーキャッシュに居ないことは普通にあるので、アーカイブに残っている
 * 表示名まで見る。生の ID を出すのは最後の手段 (19桁はトークンの無駄で、
 * モデルにも人間にも読めない)。
 */
function authorLabel(ctx, authorId) {
  const cached = ctx.guild.members.cache.get(authorId);
  if (cached?.displayName) return cached.displayName;

  try {
    const row = archiveDb.prepare(`
      SELECT author_name FROM messages
      WHERE guild_id = ? AND author_id = ? AND author_name != ''
      ORDER BY created_at DESC LIMIT 1
    `).get(ctx.guild.id, authorId);
    if (row?.author_name) return row.author_name;
  } catch {
    // アーカイブが無い構成でも動くようにする
  }

  return `user:${authorId}`;
}

async function resolveChannel(ctx, value) {
  if (!value) return ctx.channel;

  const id = /(\d{16,21})/.exec(String(value))?.[1];
  if (id) {
    const cached = ctx.guild.channels.cache.get(id);
    if (cached) return cached;

    // アーカイブ済みスレッドはキャッシュに載っていない。ID が分かっているなら取りに行く。
    // これが無いと、検索でスレッドの発言が出ても前後を読めない。
    return ctx.guild.channels.fetch(id).catch(() => null);
  }

  const name = String(value).replace(/^#/, '').toLowerCase();
  const channels = [...ctx.guild.channels.cache.values()];

  return channels.find((channel) => channel.name?.toLowerCase() === name)
    ?? channels.find((channel) => channel.name?.toLowerCase().includes(name))
    ?? null;
}

/** チャンネル指定を配列にそろえる。"a, b" でも ["a","b"] でも受ける。 */
function normalizeChannelArg(value) {
  if (value === null || value === undefined || value === '') return null;

  const list = Array.isArray(value)
    ? value
    : String(value).split(/[,、]/);

  const cleaned = list.map((entry) => String(entry).trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : null;
}

function compactCount(value) {
  const n = Number(value ?? 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * 実行者が読めるチャンネルの一覧。system prompt に載せる。
 *
 * モデルはこれが無いとチャンネル名を当てずっぽうで書くしかない。
 * 毎回送るが、内容が安定しているので DeepSeek のコンテキストキャッシュに乗る。
 * 発言数の多い順に並べて、多すぎるときは切る。
 */
export function describeChannels(ctx, { limit = 30 } = {}) {
  let counts = new Map();
  try {
    const rows = archiveDb
      .prepare('SELECT channel_id, message_count FROM channels WHERE guild_id = ?')
      .all(ctx.guild.id);
    counts = new Map(rows.map((row) => [row.channel_id, row.message_count]));
  } catch {
    // アーカイブが無い構成でも動く
  }

  const visible = [];
  for (const channel of ctx.guild.channels.cache.values()) {
    if (!MESSAGE_CHANNEL_TYPES.has(channel.type)) continue;
    if (!canRead(channel, ctx.member)) continue;
    visible.push({ channel, count: counts.get(channel.id) ?? 0 });
  }

  if (visible.length === 0) return null;

  const hasCounts = visible.some((entry) => entry.count > 0);
  visible.sort((a, b) => (
    hasCounts
      ? b.count - a.count
      : (a.channel.rawPosition ?? 0) - (b.channel.rawPosition ?? 0)
  ));

  const shown = visible.slice(0, limit);
  const names = shown.map((entry) => (
    hasCounts && entry.count > 0
      ? `#${entry.channel.name}(${compactCount(entry.count)})`
      : `#${entry.channel.name}`
  ));

  return {
    total: visible.length,
    truncated: visible.length > shown.length,
    text: names.join(' ')
  };
}

/** 実行者に見えないチャンネルは、ツール経由でも絶対に見せない。 */
function assertReadable(ctx, channel) {
  if (!channel) throw new Error('そのチャンネルは見つかりませんでした。');
  if (!canRead(channel, ctx.member)) {
    throw new Error('そのチャンネルは呼び出した人に閲覧権限がないので読めません。');
  }
  return channel;
}

function collectExtra(args) {
  const extra = [];
  if (args.author) extra.push({ key: 'from', value: String(args.author) });
  if (args.channel) extra.push({ key: 'in', value: String(args.channel) });
  if (args.after) extra.push({ key: 'after', value: String(args.after) });
  if (args.before) extra.push({ key: 'before', value: String(args.before) });
  if (args.has) extra.push({ key: 'has', value: String(args.has) });
  return extra;
}

function clampLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

// ---------------------------------------------------------------- search_messages

const ARCHIVE_QUERY_HELP = [
  'query の書き方: 空白で AND / `OR` / `-除外` / `"引用符で句"` / `(括弧)` /',
  '`regex:/pattern/` / `reactions:>5` / `reaction:👍` / `len:>200` / `hour:22-4` /',
  '`weekday:sat,sun` / `domain:github.com` / `mentions:@user` / `is:bot|human|edited|pinned`。'
].join(' ');

function searchToolDefinition(archiveAvailable) {
  return {
    type: 'function',
    function: {
      name: 'search_messages',
      description: archiveAvailable
        ? `このサーバーの過去ログを検索する。過去の言動を調べるときはこれ。${ARCHIVE_QUERY_HELP}`
        : 'このサーバーの過去ログを Discord の検索 API で検索する。query は単純なキーワードのみ。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '検索語' },
          author: { type: 'string', description: '投稿者 (表示名か ID)' },
          channel: { type: 'string', description: 'チャンネル (#名前か ID)' },
          after: { type: 'string', description: 'この日より後 (2024-05-01 / 2024-05 / 7d / today)' },
          before: { type: 'string', description: 'この日より前' },
          has: { type: 'string', description: 'link / image / video / file / embed / reaction / code' },
          sort: { type: 'string', description: 'new / old / reactions / long (既定 new)' },
          limit: { type: 'number', description: '件数 (既定 10、最大 25)' }
        }
      }
    }
  };
}

async function searchViaArchive(ctx, args, limit) {
  const options = {
    guildId: ctx.guild.id,
    query: String(args.query ?? ''),
    extra: collectExtra(args),
    channelScope: ctx.channelScope,
    allowDeleted: false,
    sort: String(args.sort ?? 'new')
  };

  if (!options.query && options.extra.length === 0) {
    return '検索条件を1つ以上指定してください。';
  }

  const summary = searchSummary(options);
  if (!summary.count) return '該当するメッセージはありませんでした。';

  const { rows } = search(options, { limit, offset: 0 });
  const messages = rows.map((row) => fromArchiveRow(row, channelName(ctx, row.channel_id)));

  return [
    `${summary.count} 件ヒット (${summary.authors} 人 / ${channelCountLabel(summary)}) ・ 表示 ${messages.length} 件`,
    `期間: ${shortTime(summary.first_at)} 〜 ${shortTime(summary.last_at)}`,
    formatMessages(messages, {
      refs: ctx.refs,
      showChannel: true,
      bodyChars: agentConfig.messageChars
    })
  ].join('\n');
}

function channelCountLabel(summary) {
  return `${summary.channels} チャンネル`;
}

async function searchViaDiscord(ctx, args, limit) {
  const query = new URLSearchParams();
  query.set('limit', String(Math.min(limit, 25)));

  if (args.query) query.set('content', String(args.query));

  if (args.author) {
    // Discord の検索 API は author_id しか受けないので、名前は ID に直す。
    // 直せないときは黙って無視せず、そう伝える (絞れていない結果を渡すと誤読される)。
    const author = resolveMemberId(ctx, args.author);
    if (!author) {
      return `"${args.author}" という人が見つかりませんでした。表示名を確認するか、ユーザー ID を指定してください。`;
    }
    query.set('author_id', author);
  }

  if (args.channel) {
    const channel = assertReadable(ctx, await resolveChannel(ctx, args.channel));
    query.set('channel_id', channel.id);
  }

  if (args.has) query.set('has', String(args.has));

  // 絞り込みが1つも無いと Discord 側で弾かれるので、並び順だけの指定は条件と数えない。
  if (!args.query && !args.author && !args.channel && !args.has) {
    return '検索条件を1つ以上指定してください。';
  }

  if (args.sort === 'old') query.set('sort_order', 'asc');

  let data;
  try {
    data = await ctx.client.rest.get(`/guilds/${ctx.guild.id}/messages/search`, { query });
  } catch (error) {
    return `Discord の検索 API が失敗しました: ${truncate(error.message, 200)}`;
  }

  // インデックス構築中は 202 が返る。
  if (data?.code === 110000 || data?.retry_after) {
    return [
      'Discord 側の検索インデックスがまだ準備できていません',
      `(${data.retry_after ?? '?'} 秒後に再試行可)。`,
      'read_channel で直接読むほうが確実です。'
    ].join(' ');
  }

  // messages は [[msg], [msg]] の形で返ることがあるので平坦化する。
  const raw = (data?.messages ?? []).flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));

  const messages = raw
    .filter((message) => {
      const channel = ctx.guild.channels.cache.get(message.channel_id);
      return channel ? canRead(channel, ctx.member) : false;
    })
    .map((message) => fromRawMessage(message, ctx.guild.id, channelName(ctx, message.channel_id)));

  if (messages.length === 0) return '該当するメッセージはありませんでした。';

  return [
    `${data?.total_results ?? messages.length} 件ヒット ・ 表示 ${messages.length} 件`,
    formatMessages(messages, {
      refs: ctx.refs,
      showChannel: true,
      bodyChars: agentConfig.messageChars
    })
  ].join('\n');
}

function resolveMemberId(ctx, value) {
  if (!value) return null;

  const id = /(\d{16,21})/.exec(String(value))?.[1];
  if (id) return id;

  const name = String(value).replace(/^@/, '').toLowerCase();
  const member = ctx.guild.members.cache.find((candidate) => (
    candidate.displayName?.toLowerCase() === name
    || candidate.user.username?.toLowerCase() === name
    || candidate.user.globalName?.toLowerCase() === name
  )) ?? ctx.guild.members.cache.find((candidate) => (
    candidate.displayName?.toLowerCase().includes(name)
    || candidate.user.username?.toLowerCase().includes(name)
  ));

  return member?.id ?? null;
}

// ---------------------------------------------------------------- read_channel

const readChannelDefinition = {
  type: 'function',
  function: {
    name: 'read_channel',
    description: [
      'チャンネルのメッセージを時系列で読む。呼ばれたチャンネルの直近の流れは既に渡してあるので、',
      'それより前 (before) / 後 (after) / ある発言の周辺 (around) を追いたいときや、',
      '別チャンネルを読みたいときに使う。',
      'search_messages のヒット番号をそのまま around に渡せば、その発言の前後の流れが読める',
      '(別チャンネルのヒットでも channel の指定は不要。自動でそのチャンネルを読む)。',
      '検索結果だけでは文脈が分からないときは、まずこれで周辺を読むこと。',
      'channel は "general, dev, random" のように複数まとめて渡せる (最大5つ)。',
      '複数チャンネルを見比べたいときは1件ずつ呼ばず、まとめて渡すこと。'
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'チャンネル。カンマ区切りで複数可 (最大5)。省略時は参照番号のチャンネル、無ければ呼ばれたチャンネル' },
        after: { type: 'string', description: 'この参照番号より後を読む' },
        before: { type: 'string', description: 'この参照番号より前を読む' },
        around: { type: 'string', description: 'この参照番号の前後を読む (検索ヒットの文脈を追うのに使う)' },
        limit: { type: 'number', description: '件数 (既定 30、最大 100)' }
      }
    }
  }
};

const MAX_CHANNELS_PER_READ = 5;

/** 1回の呼び出しで複数チャンネルを読む。往復を増やさずに横断できるようにするため。 */
async function readManyChannels(ctx, wanted, args) {
  const targets = wanted.slice(0, MAX_CHANNELS_PER_READ);
  const total = clampLimit(args.limit, 30, 100);
  const perChannel = Math.max(5, Math.floor(total / targets.length));

  const sections = [];
  const problems = [];

  for (const name of targets) {
    let channel;
    try {
      channel = assertReadable(ctx, await resolveChannel(ctx, name));
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
      continue;
    }

    if (typeof channel.messages?.fetch !== 'function') {
      problems.push(`#${channel.name}: メッセージを取得できない種類のチャンネルです`);
      continue;
    }

    let fetched;
    try {
      fetched = await channel.messages.fetch({ limit: perChannel });
    } catch (error) {
      problems.push(`#${channel.name}: ${truncate(error.message, 80)}`);
      continue;
    }

    const messages = [...fetched.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((message) => fromDiscordMessage(message, channel.name));

    sections.push([
      `--- #${channel.name} (${messages.length}件) ---`,
      messages.length === 0
        ? '(発言なし)'
        : formatMessages(messages, {
          refs: ctx.refs,
          showChannel: false,
          bodyChars: agentConfig.messageChars
        })
    ].join('\n'));
  }

  if (wanted.length > MAX_CHANNELS_PER_READ) {
    problems.push(`一度に読めるのは ${MAX_CHANNELS_PER_READ} チャンネルまでなので、残りは省きました`);
  }

  if (sections.length === 0) {
    return problems.length > 0 ? problems.join('\n') : 'メッセージがありませんでした。';
  }

  return [...sections, ...(problems.length > 0 ? [`(注記) ${problems.join(' / ')}`] : [])].join('\n\n');
}

async function readChannel(ctx, args) {
  const wanted = normalizeChannelArg(args.channel);

  // 複数チャンネル指定は横断読みに回す (anchor は1チャンネル前提なので使わない)
  if (wanted && wanted.length > 1) {
    return readManyChannels(ctx, wanted, args);
  }

  // before / after / around は同時に使えない。指定された順で1つだけ採る。
  let anchor = null;
  let anchorKey = null;

  for (const key of ['around', 'after', 'before']) {
    const entry = ctx.refs.resolve(args[key]);
    if (entry?.messageId) {
      anchor = entry;
      anchorKey = key;
      break;
    }
  }

  // 検索結果の番号を渡されたら、その発言があったチャンネルを読む。
  // 呼ばれたチャンネルを既定にしてしまうと、別チャンネルのヒットの前後が
  // 追えない (そのチャンネルに無い ID を引いて失敗する)。
  // 参照番号から来た channel_id は確定値なので、名前解決を通さず直接引く。
  const channel = assertReadable(
    ctx,
    wanted
      ? await resolveChannel(ctx, wanted[0])
      : anchor?.channelId
        ? ctx.guild.channels.cache.get(anchor.channelId)
          ?? await ctx.guild.channels.fetch(anchor.channelId).catch(() => null)
        : ctx.channel
  );

  if (typeof channel.messages?.fetch !== 'function') {
    return 'そのチャンネルからはメッセージを取得できません。';
  }

  const limit = clampLimit(args.limit, 30, 100);
  const options = { limit };
  if (anchor && anchorKey) options[anchorKey] = anchor.messageId;

  let fetched;
  try {
    fetched = await channel.messages.fetch(options);
  } catch (error) {
    return `メッセージを取得できませんでした: ${truncate(error.message, 200)}`;
  }

  const messages = [...fetched.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((message) => fromDiscordMessage(message, channel.name));

  if (messages.length === 0) return 'メッセージがありませんでした。';

  const sameChannel = channel.id === ctx.channel.id;

  return [
    `#${channel.name} ${messages.length} 件`,
    formatMessages(messages, {
      refs: ctx.refs,
      showChannel: !sameChannel,
      bodyChars: agentConfig.messageChars
    })
  ].join('\n');
}

// ---------------------------------------------------------------- aggregate_messages

const aggregateDefinition = {
  type: 'function',
  function: {
    name: 'aggregate_messages',
    description: [
      '検索条件に一致した発言を集計する。「一番言っているのは誰か」「いつ増えたか」を',
      '数で示したいときに使う。個別の発言は返らないので件数を知りたいときはこちらが安い。'
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '検索語 (search_messages と同じ書き方)' },
        by: { type: 'string', description: 'author / channel / year / month / day / hour / weekday' },
        author: { type: 'string', description: '投稿者で絞る' },
        channel: { type: 'string', description: 'チャンネルで絞る' },
        after: { type: 'string', description: 'この日より後' },
        before: { type: 'string', description: 'この日より前' }
      }
    }
  }
};

async function aggregateMessages(ctx, args) {
  const options = {
    guildId: ctx.guild.id,
    query: String(args.query ?? ''),
    extra: collectExtra(args),
    channelScope: ctx.channelScope,
    allowDeleted: false,
    sort: 'new'
  };

  const by = ['author', 'channel', 'year', 'month', 'day', 'hour', 'weekday'].includes(args.by)
    ? args.by
    : 'author';

  const summary = searchSummary(options);
  if (!summary.count) return '該当するメッセージはありませんでした。';

  const rows = aggregateSearch(options, by, { limit: by === 'month' ? 24 : 15 });

  const label = (bucket) => {
    if (by === 'author') return authorLabel(ctx, bucket);
    if (by === 'channel') return `#${channelName(ctx, bucket)}`;
    if (by === 'weekday') return `${WEEKDAY_LABELS[bucket]}曜`;
    if (by === 'hour') return `${String(bucket).padStart(2, '0')}時`;
    return String(bucket);
  };

  return [
    `合計 ${summary.count} 件 / ${summary.authors} 人 / ${summary.channels} チャンネル`,
    `期間: ${shortTime(summary.first_at)} 〜 ${shortTime(summary.last_at)} ・ 平均 ${Math.round(summary.avg_length ?? 0)} 文字`,
    `--- ${by} 別 ---`,
    rows.map((row) => `${label(row.bucket)}: ${row.count}`).join('\n')
  ].join('\n');
}

// ---------------------------------------------------------------- 組み立て

/**
 * この実行で使えるツールだけを集める。
 */
export async function buildToolset(ctx) {
  const archiveAvailable = Boolean(getGuildState(ctx.guild.id));
  const browserAvailable = await cdpAvailable();

  const definitions = [searchToolDefinition(archiveAvailable), readChannelDefinition];
  const handlers = {
    search_messages: (args) => (archiveAvailable
      ? searchViaArchive(ctx, args, clampLimit(args.limit, 10, 25))
      : searchViaDiscord(ctx, args, clampLimit(args.limit, 10, 25))),
    read_channel: (args) => readChannel(ctx, args)
  };

  if (archiveAvailable) {
    definitions.push(aggregateDefinition);
    handlers.aggregate_messages = (args) => aggregateMessages(ctx, args);
  }

  if (browserAvailable) {
    definitions.push(browserToolDefinition);
    handlers.browser = (args) => runBrowserAction(ctx, args);
  }

  return {
    definitions,
    archiveAvailable,
    browserAvailable,

    async call(name, args) {
      const handler = handlers[name];
      if (!handler) return `そのツールはありません: ${name}`;

      try {
        const result = await handler(args ?? {});
        return applyBudget(ctx, String(result ?? ''));
      } catch (error) {
        if (error instanceof QueryError) return `クエリが不正です: ${error.message}`;
        console.error(`Agent tool ${name} failed:`, error);
        return `ツールの実行に失敗しました: ${truncate(error.message ?? String(error), 200)}`;
      }
    }
  };
}

/**
 * ツール出力の総量に上限を設ける。長い会話で膨らみ続けるのを止めるため。
 */
function applyBudget(ctx, text) {
  if (ctx.budget.remaining <= 0) {
    return '(ツール出力の上限に達しました。ここまでの情報で答えてください)';
  }

  if (text.length <= ctx.budget.remaining) {
    ctx.budget.remaining -= text.length;
    return text;
  }

  const clipped = text.slice(0, ctx.budget.remaining);
  ctx.budget.remaining = 0;
  return `${clipped}\n(以降は上限のため省略。ここまでの情報で答えてください)`;
}
