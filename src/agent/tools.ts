// エージェントが使えるツール。
//
// 数を絞るのが方針。ツール定義は毎ターン送り直すので、1つ増やすたびに
// 全往復ぶんのトークンが増える。使えないツールは最初から出さない
// (アーカイブ未構築なら検索系を出さない / Chrome が居なければブラウザを出さない)。
//
// ここにあるツールはどれも読み取りだけで、書き込み・投稿・権限の変更はしない。
// 引数はモデルが組み立てたもの (= 外から来た値) なので、どれも unknown として受け、
// 使う場所で形を確かめる。結果の本文にもユーザーの発言が入るが、それは材料であって命令ではない。

import type { GuildBasedChannel, Message } from 'discord.js';
import { createCoach } from './coach.js';
import { hasMemory, memoryToolDefinition, runMemoryToolWithMeaning } from '../memory/tool.js';
import { db as archiveDb, getGuildState, msToSnowflake, snowflakeToMs } from '../archive/db.js';
import { MESSAGE_CHANNEL_TYPES, canRead, isForumType, isThreadType } from '../archive/permissions.js';
import { QueryError, collectTerms, parseDateRange, parseQuery } from '../archive/query.js';
import { aggregateSearch, isChannelAllowed, search, searchSummary, searchThreads, type SearchSummary, type ThreadHitRow } from '../archive/search.js';
import { topTerms } from '../archive/terms.js';
import type { FilterCondition, MessageRow, QueryNode, SearchOptions } from '../archive/types.js';
import type { ChunkFilters } from '../archive/vectors.js';
import type { AgentToolset } from '../ai/runtime.js';
import { prewarm } from '../embed/worker.js';
import { governance as governanceRecords } from './boundary.js';
import { browserToolDefinition, runBrowserAction } from './browser.js';
import { infoDefinition, runInfo } from './info.js';
import { governanceDefinition, runGovernanceInfo } from './governance.js';
import { resolveAuthorFilter, resolveMemberId } from './members.js';
import { looksLikeSentence } from './sentence.js';
import { runSemanticSearch, semanticAvailable } from './semantic.js';
import { cdpAvailable } from './cdp.js';
import { agentConfig } from './config.js';
import {
  formatMessageLines,
  fromArchiveRow,
  fromDiscordMessage,
  fromRawMessage,
  isRawMessage,
  parseDiscordRef,
  shortTime,
  truncate,
  type RawMessage
} from './format.js';
import {
  errorMessage,
  isRecord,
  type AgentContext,
  type AgentMessage,
  type ToolArgs,
  type ToolDefinition
} from './types.js';

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// モデルが渡す文字列の長さの上限。ここを超えるぶんは検索にも解析にも使わない
// (パーサや LIKE パターンに長大な入力を流さない)。
const MAX_QUERY_CHARS = 500;
const MAX_ARG_CHARS = 200;
const MAX_NAME_CHARS = 100;
// 読む位置の飛ばし幅。Discord の検索 API の offset 上限に近い値で頭打ちにする。
const MAX_OFFSET = 10_000;
// チャンネル指定の個数。読めるのは MAX_CHANNELS_PER_READ までだが、超えたことは伝えたいので少し余裕を持たせる。
const MAX_CHANNEL_ARGS = 20;

/** 検索ツールが何を出せるか。定義の出し分けと実行時の振り分けの両方で使う。 */
export interface SearchFlags {
  archiveAvailable: boolean;
  semanticAvailable: boolean;
}

/** 検索の1モードの結果。empty は「0件だった」(自動で意味検索に回す判断に使う)。 */
interface SearchOutcome {
  empty: boolean;
  text: string;
}

type Direction = 'around' | 'before' | 'after';

const isWindowDirection = (value: string): value is Direction => (
  value === 'around' || value === 'before' || value === 'after'
);

/** at を解いた起点。 */
export type Anchor =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'message'; messageId: string; channelId: string | null; createdAt: number | null }
  | { kind: 'time'; messageId: string; channelId: null; createdAt: number };

/** メッセージ一覧を取れるチャンネル。フォーラム本体のように取れないものは入らない。 */
type MessageHost = Extract<GuildBasedChannel, { messages: unknown }>;

/** discord.js の型には載らない偽物 (検証用) も通るよう、実際に fetch できるかで見分ける。 */
function hasMessageManager(channel: GuildBasedChannel): channel is MessageHost {
  return 'messages' in channel && typeof channel.messages?.fetch === 'function';
}

function channelName(ctx: Pick<AgentContext, 'guild'>, channelId: string): string {
  const cached = ctx.guild.channels.cache.get(channelId);
  if (cached?.name) return cached.name;

  try {
    const row = archiveDb
      .prepare<[string, string], { name: string | null }>('SELECT name FROM channels WHERE guild_id = ? AND channel_id = ?')
      .get(ctx.guild.id, channelId);
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
function authorLabel(ctx: Pick<AgentContext, 'guild'>, authorId: string): string {
  const cached = ctx.guild.members.cache.get(authorId);
  if (cached?.displayName) return cached.displayName;

  try {
    const row = archiveDb.prepare<[string, string], { author_name: string | null }>(`
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

/**
 * 名前からアーカイブ済みスレッド (フォーラムの投稿を含む) の ID を引く。
 *
 * 閉じた投稿はギルドのキャッシュに載らないので、名前で指定しても見つからなかった
 * (検索ヒットの番号を at に渡す経路だけが通っていた)。取り込み済みなら当時の名前を
 * 覚えているので、そこから ID を出して取りに行く。
 *
 * 非公開スレッドは名前で掘り当てられないようにする。getChannelScope が
 * 「親の権限では判定できない」として弾いている相手を、ここから通してはいけない。
 */
function archivedThreadId(ctx: Pick<AgentContext, 'guild'>, name: string): string | null {
  try {
    const pattern = `%${name.slice(0, MAX_NAME_CHARS).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const row = archiveDb.prepare<[string, string], { channel_id: string }>(`
      SELECT channel_id FROM channels
      WHERE guild_id = ? AND is_thread = 1 AND is_private = 0 AND name LIKE ? ESCAPE '\\'
      ORDER BY LENGTH(name), message_count DESC
      LIMIT 1
    `).get(ctx.guild.id, pattern);

    return row?.channel_id ?? null;
  } catch {
    // アーカイブが無い構成でも動くようにする
    return null;
  }
}

export async function resolveChannel(
  ctx: Pick<AgentContext, 'guild' | 'channel'>,
  value: unknown
): Promise<GuildBasedChannel | null> {
  if (!value) return ctx.channel;

  // リンクなら channel の位置から取る。先頭のスノーフレークを掴むと
  // サーバー ID をチャンネル ID として扱うことになる。
  const parsed = parseDiscordRef(value);
  const id = parsed?.channelId ?? parsed?.messageId ?? null;
  if (id) {
    const cached = ctx.guild.channels.cache.get(id);
    if (cached) return cached;

    // アーカイブ済みスレッドはキャッシュに載っていない。ID が分かっているなら取りに行く。
    // これが無いと、検索でスレッドの発言が出ても前後を読めない。
    // guild.channels.fetch はこのサーバーの中だけを引く (別サーバーの ID は null になる)。
    return ctx.guild.channels.fetch(id).catch(() => null);
  }

  const name = String(value).slice(0, MAX_NAME_CHARS).replace(/^#/, '').toLowerCase();
  const channels = [...ctx.guild.channels.cache.values()];

  const cached = channels.find((channel) => channel.name?.toLowerCase() === name)
    ?? channels.find((channel) => channel.name?.toLowerCase().includes(name));
  if (cached) return cached;

  // キャッシュに無い = 閉じた投稿かもしれない。権限は呼び出し側の
  // assertReadable が (取ってきた実体に対して) 見るので、ここでは ID を出すだけ。
  const archived = archivedThreadId(ctx, name);
  return archived ? await ctx.guild.channels.fetch(archived).catch(() => null) : null;
}

/** チャンネル指定を配列にそろえる。"a, b" でも ["a","b"] でも受ける。 */
function normalizeChannelArg(value: unknown): string[] | null {
  if (value === null || value === undefined || value === '') return null;

  // 長さを抑えてから割る (モデルが巨大な配列や文字列を渡しても、ここから先は固定量)
  const list: unknown[] = Array.isArray(value)
    ? value.slice(0, MAX_CHANNEL_ARGS)
    : String(value).slice(0, MAX_ARG_CHARS * MAX_CHANNEL_ARGS).split(/[,、]/).slice(0, MAX_CHANNEL_ARGS);

  const cleaned = list.map((entry) => String(entry).trim().slice(0, MAX_ARG_CHARS)).filter(Boolean);
  return cleaned.length > 0 ? cleaned : null;
}

function compactCount(value: unknown): string {
  const n = Number(value ?? 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** channels 表の1行 (describeChannels が使う列)。 */
interface ChannelRow {
  channel_id: string;
  parent_id: string | null;
  is_thread: number | null;
  message_count: number | null;
  topic: string | null;
}

/** discord.js のチャンネルの説明文。持たない種類 (ボイスやスレッド) は空。 */
function topicOf(channel: GuildBasedChannel): string {
  return 'topic' in channel ? channel.topic ?? '' : '';
}

function positionOf(channel: GuildBasedChannel): number {
  return 'rawPosition' in channel ? channel.rawPosition ?? 0 : 0;
}

export interface ChannelDescription {
  total: number;
  hiddenByFilter: number;
  hasThreads: boolean;
  truncated: boolean;
  text: string;
}

/**
 * 実行者が読めるチャンネルの一覧。
 *
 * system prompt には載せない。チャンネル数の多いサーバーだと毎ターン払うことに
 * なるので、必要になったときだけ channels 経由で取りに行かせる。
 * 発言数の多い順に並べる (どこに話が溜まっているかの判断材料になる)。
 *
 * 単位は「入れ物」。スレッドとフォーラムの投稿は親に足し込んで、個別には出さない:
 *   - フォーラム本体は MESSAGE_CHANNEL_TYPES に無いので、以前は一覧から丸ごと
 *     抜けていた (投稿は取り込まれているのに、その置き場の名前が出ない)
 *   - 逆にアクティブなスレッドはキャッシュに載るので個別に並び、賑やかな
 *     チャンネルの投稿だけで上位30件が埋まっていた
 *   - 閉じた投稿はどちらにも出ない
 * 「どこに話が溜まっているか」を知るための道具なので、入れ物で数えるのが正しい。
 */
export function describeChannels(
  ctx: Pick<AgentContext, 'guild' | 'member'>,
  { limit = 30, filter = null }: { limit?: number; filter?: unknown } = {}
): ChannelDescription | null {
  // 自分の発言数と、ぶら下がっているスレッドの発言数を分けて持つ
  const own = new Map<string, number>();
  const childMessages = new Map<string, number>();
  const childCount = new Map<string, number>();
  const topics = new Map<string, string>();

  try {
    const rows = archiveDb
      .prepare<[string], ChannelRow>('SELECT channel_id, parent_id, is_thread, message_count, topic FROM channels WHERE guild_id = ?')
      .all(ctx.guild.id);

    for (const row of rows) {
      const count = row.message_count ?? 0;

      if (row.is_thread && row.parent_id) {
        childMessages.set(row.parent_id, (childMessages.get(row.parent_id) ?? 0) + count);
        childCount.set(row.parent_id, (childCount.get(row.parent_id) ?? 0) + 1);
      } else {
        own.set(row.channel_id, count);
        if (row.topic) topics.set(row.channel_id, row.topic);
      }
    }
  } catch {
    // アーカイブが無い構成でも動く
  }

  const needle = filter ? String(filter).slice(0, MAX_NAME_CHARS).replace(/^#/, '').toLowerCase() : null;

  const visible: { channel: GuildBasedChannel; count: number; threads: number; forum: boolean; topic: string }[] = [];
  let hiddenByFilter = 0;

  for (const channel of ctx.guild.channels.cache.values()) {
    // スレッドは親に足し込んであるので個別には出さない。
    // フォーラム / メディアは自分では発言を持たないが、投稿の置き場なので出す。
    const holdsMessages = MESSAGE_CHANNEL_TYPES.has(channel.type) && !isThreadType(channel.type);
    if (!holdsMessages && !isForumType(channel.type)) continue;
    if (!canRead(channel, ctx.member)) continue;

    if (needle && !channel.name?.toLowerCase().includes(needle)) {
      hiddenByFilter += 1;
      continue;
    }

    visible.push({
      channel,
      count: (own.get(channel.id) ?? 0) + (childMessages.get(channel.id) ?? 0),
      threads: childCount.get(channel.id) ?? 0,
      forum: isForumType(channel.type),
      // 取り込み前でもキャッシュには載っている
      topic: topics.get(channel.id) ?? topicOf(channel)
    });
  }

  if (visible.length === 0) return null;

  const hasCounts = visible.some((entry) => entry.count > 0);
  visible.sort((a, b) => (
    hasCounts
      ? b.count - a.count
      : positionOf(a.channel) - positionOf(b.channel)
  ));

  const shown = visible.slice(0, limit);

  // 説明文は絞り込んだときだけ出す。全チャンネルぶん並べると出力が数倍になり、
  // 「どこに話が溜まっているか」を見たいだけの呼び出しでその費用を払うことになる。
  const withTopics = shown.length <= 10 && shown.some((entry) => entry.topic);

  const names = shown.map((entry) => {
    const parts: string[] = [];
    if (hasCounts && entry.count > 0) parts.push(compactCount(entry.count));
    // 投稿がぶら下がっていることは出す。フォーラムでは発言数より件数が効く。
    if (entry.threads > 0) parts.push(`${entry.forum ? '投稿' : 'スレ'}${compactCount(entry.threads)}`);

    const head = parts.length > 0 ? `#${entry.channel.name}(${parts.join('・')})` : `#${entry.channel.name}`;
    return withTopics && entry.topic ? `${head} — ${truncate(entry.topic, 60)}` : head;
  });

  return {
    total: visible.length,
    hiddenByFilter,
    hasThreads: shown.some((entry) => entry.threads > 0),
    truncated: visible.length > shown.length,
    // 説明文を出したときは1行1件。並べて書くと読めない
    text: names.join(withTopics ? '\n' : ' ')
  };
}

export const channelsDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'channels',
    description: [
      '読めるチャンネルの一覧を発言数の多い順に返す。あなたは呼ばれたチャンネル以外の名前を',
      '知らないので、どこを読むか決めたいときに使う。',
      'ただし search はチャンネル名を知らなくても全チャンネル横断で引けるので、',
      '「どこで話していたか」を知りたいだけならこれを呼ぶ必要はない。'
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '名前に含む文字で絞る (例: dev)' },
        limit: { type: 'number', description: '件数 (既定 30、最大 100)' }
      }
    }
  }
};

function listChannels(ctx: AgentContext, args: ToolArgs): string {
  const limit = clampLimit(args.limit, 30, 100);
  const filter = args.filter ? String(args.filter).slice(0, MAX_NAME_CHARS) : null;
  const result = describeChannels(ctx, { limit, filter });

  if (!result) {
    return filter
      ? `"${filter}" に一致する、読めるチャンネルはありませんでした。`
      : '読めるチャンネルがありませんでした。';
  }

  const lines = [
    `読めるチャンネル ${result.total} 件${result.truncated ? ` (発言数の多い順に ${limit} 件だけ表示)` : ''}・括弧内は発言数`,
    result.text
  ];

  // 見えないチャンネルがあること自体は隠さないが、名前は出さない
  if (result.hiddenByFilter > 0) {
    lines.push(`(filter で ${result.hiddenByFilter} 件を除外)`);
  }

  // スレッド名が一覧に無いことを言わないと、「そのスレッドは無い」と読まれる。
  // 名前を知らなくても search は横断で引けるので、そちらへ寄せる。
  if (result.hasThreads) {
    lines.push(
      'スレッドとフォーラムの投稿は親に集計してあり、個別の名前は出していない'
        + '(search は投稿の中まで横断で引ける。`in:#親の名前` でその配下だけに絞れる)。'
    );
  }

  lines.push('ここに無いチャンネルは呼んだ人に閲覧権限がないので読めない。');
  return lines.join('\n');
}

/** 実行者に見えないチャンネルは、ツール経由でも絶対に見せない。 */
function assertReadable<T extends GuildBasedChannel>(ctx: Pick<AgentContext, 'guild' | 'member'>, channel: T | null | undefined): T {
  if (!channel) throw new Error('そのチャンネルは見つかりませんでした。');
  const owner = channel.guildId ?? channel.guild?.id;
  if (owner && String(owner) !== String(ctx.guild.id)) throw new Error('別サーバーのチャンネルは読めません。');
  if (!canRead(channel, ctx.member)) {
    throw new Error('そのチャンネルは呼び出した人に閲覧権限がないので読めません。');
  }
  return channel;
}

function collectExtra(args: ToolArgs): FilterCondition[] {
  const extra: FilterCondition[] = [];
  if (args.author) extra.push({ key: 'from', value: String(args.author) });
  if (args.channel) extra.push({ key: 'in', value: String(args.channel) });
  if (args.after) extra.push({ key: 'after', value: String(args.after) });
  if (args.before) extra.push({ key: 'before', value: String(args.before) });
  if (args.has) extra.push({ key: 'has', value: String(args.has) });
  return extra;
}

/** searchOptions が作る options。query / extra / sort は必ず入っている。 */
interface ResolvedSearchOptions extends SearchOptions {
  query: string;
  extra: FilterCondition[];
  sort: string;
}

/**
 * 検索の3モード (keyword / count / meaning) が共有する options。
 *
 * 1本にまとめるのが要点。以前は3箇所で同じ6キーを組んでいて、実際に2つずれていた:
 * 意味検索の側が has: を落としていたのと、集計の側が author を表示名のまま渡していて
 * author_name LIKE になっていた (author_name は書いた時点のスナップショットなので、
 * 改名した人の集計が黙って減る)。組み立てが1本なら二度と分岐しない。
 */
async function searchOptions(
  ctx: AgentContext,
  args: ToolArgs,
  { query, sort, extra = [] }: { query?: unknown; sort?: string; extra?: FilterCondition[] } = {}
): Promise<ResolvedSearchOptions> {
  return {
    guildId: ctx.guild.id,
    query: String(query ?? args.query ?? ''),
    extra: [
      ...collectExtra({ ...args, author: await resolveAuthorFilter(ctx, args.author) }),
      ...extra
    ],
    channelScope: ctx.channelScope,
    allowDeleted: false,
    sort: sort ?? (lower(args.sort) || 'new')
  };
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

/** 読み飛ばす件数。負や NaN は 0、大きすぎる値は MAX_OFFSET で止める。 */
function offsetOf(args: ToolArgs): number {
  return Math.min(MAX_OFFSET, Math.max(0, Math.floor(Number(args.offset) || 0)));
}

/**
 * 文字列の引数を上限の長さで切った写しを作る。
 *
 * パーサ・LIKE・日付の解釈には、モデルが渡した長さのまま流さない。
 * 文字列でない値 (配列など) は触らない。
 */
function boundedArgs(args: ToolArgs): ToolArgs {
  const out: ToolArgs = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === 'string'
      ? value.slice(0, key === 'query' ? MAX_QUERY_CHARS : MAX_ARG_CHARS)
      : value;
  }
  return out;
}

// ---------------------------------------------------------------- search

const ARCHIVE_QUERY_HELP = [
  'query の書き方: 空白で AND / `OR` / `-除外` / `"引用符で句"` / `(括弧)` /',
  '`regex:/pattern/` (本文のみ。空白を含むときは `regex:"/a b/"`) / `reactions:>5` / `reaction:👍` / `len:>200` / `hour:22-4` /',
  '`weekday:sat,sun` / `domain:github.com` / `mentions:@user` / `tag:解決済み` (フォーラム) /',
  '`is:bot|human|edited|pinned|unanswered`。'
].join(' ');

export function searchToolDefinition({ archiveAvailable, semanticAvailable }: SearchFlags): ToolDefinition {
  // 使えないモードは出さない。定義は毎ターン送り直すので、出せば毎ターン払う。
  const modes = [
    'keyword',
    ...(semanticAvailable ? ['meaning'] : []),
    ...(archiveAvailable ? ['count', 'posts'] : [])
  ];

  const description = [
    'このサーバーの過去ログを検索する。過去の言動を調べるときはこれ。',
    'mode:keyword (既定) は文字列一致。既定は Discord 本体の検索 (全期間) で、',
    archiveAvailable
      ? `次を書いたときだけローカルの取り込み済みログを引く: ${ARCHIVE_QUERY_HELP}どちらを引いたかは結果の1行目に出る。`
      : 'まだローカルへの取り込みが済んでいないので単純なキーワードのみ。',
    ...(semanticAvailable ? [
      'mode:meaning は言い方が違っても意味が近い発言を探す。query は単語ではなく文で書く',
      '(参照番号を渡すとその発言に似た発言を探す)。キーワードで0件かつ query が文なら',
      '意味検索も同じ呼び出しの中で自動で走るので、呼び直さなくてよい。'
    ] : []),
    ...(archiveAvailable ? [
      'mode:count は個別の発言を返さず数だけ返すので安い。特定の人の件数は author に名前を渡し、query は空か絞りたい語だけにする',
      '(人名や「文字数」を query に書くと、その語を含む発言を数えるので 0 件になる)。by:term はその条件でよく話している話題を出す。',
      'mode:posts はスレッド / フォーラムの投稿を単位にして返す (タイトルも本文も見る)。',
      '「どの投稿でその話をしているか」を知りたいときはこれ。番号を read の at に渡せば中に入れる。'
    ] : [])
  ].join('');

  const properties = {
    query: { type: 'string', description: '検索語 / mode:meaning では探したい主張を文で' },
    ...(modes.length > 1 ? { mode: { type: 'string', enum: modes, description: '既定 keyword' } } : {}),
    ...(archiveAvailable ? { by: { type: 'string', enum: AGGREGATE_AXES, description: 'mode:count の集計軸 (既定 author)' } } : {}),
    author: { type: 'string', description: '投稿者 (表示名か ID)' },
    channel: { type: 'string', description: 'チャンネル (#名前か ID)' },
    after: { type: 'string', description: 'この日以降 (2024-05-01 / 2024-05 / 2020 / 7d / today)' },
    before: { type: 'string', description: 'この日より前' },
    has: { type: 'string', description: 'link / image / video / file / embed / sticker (reaction / code はローカルのみ)' },
    sort: { type: 'string', description: 'new / old / relevance / reactions / long (後ろ2つはローカルのみ。mode:keyword だけ効く)' },
    ...(archiveAvailable ? { source: { type: 'string', description: 'discord (既定) / archive。ローカル専用の条件を書けば指定しなくてもローカルを引く' } } : {}),
    offset: { type: 'number', description: '先頭から飛ばす件数。古い方を見るなら sort:old か during: のほうが早い' },
    limit: { type: 'number', description: '件数 (既定 10、最大 25)' }
  };

  return {
    type: 'function',
    function: { name: 'search', description, parameters: { type: 'object', properties } }
  };
}

/**
 * 3つのモードの入口。
 *
 * 以前は search_messages / aggregate_messages / semantic_search の3ツールだった。
 * 同じ6キーの options を3箇所で組んでいて実際に2箇所ずれていたし、定義の
 * 7割は JSON Schema の枠なので、ツールを減らすほど毎ターンの固定費が減る。
 */
export async function runSearch(ctx: AgentContext, rawArgs: ToolArgs, flags: SearchFlags): Promise<string> {
  const args = boundedArgs(rawArgs);
  const mode = lower(args.mode) || 'keyword';
  const limit = clampLimit(args.limit, 10, 25);

  if (mode === 'count') {
    if (!flags.archiveAvailable) {
      return '集計はローカルの取り込みが要る。管理者が `/index build` を実行するまでは使えません。';
    }
    return aggregateMessages(ctx, args);
  }

  if (mode === 'posts') {
    if (!flags.archiveAvailable) {
      return '投稿の検索はローカルの取り込みが要る。管理者が `/index build` を実行するまでは使えません。';
    }
    return searchPosts(ctx, args, limit);
  }

  if (mode === 'meaning') {
    if (!flags.semanticAvailable) {
      return '意味検索は今使えません (ベクトル未作成)。mode を外してキーワードで引いてください。';
    }
    return meaningSearch(ctx, args, limit, { escalated: false });
  }

  if (mode !== 'keyword') {
    return `mode が不正です: ${String(args.mode)}。keyword / meaning / count / posts のどれかです。`;
  }

  const { source, needs } = pickSearchSource(args, flags.archiveAvailable);

  if (source === 'unavailable') {
    return 'このサーバーはまだローカルに取り込まれていません。管理者が `/index build` を実行するまでは Discord 側の検索だけ使えます。';
  }

  if (source === 'unsupported') {
    return `${needs.join(' / ')} はローカルの取り込み済みログにしか無い条件です。まだ取り込まれていないので、この条件を外して引き直してください。`;
  }

  // 自動で回したときは、なぜ回したかを結果の1行目に出す
  // (どちらを引いたか分からないまま読ませない)
  const note = needs.length > 0 ? `${needs.join(' ')} はローカルのみ` : null;

  const outcome = source === 'archive'
    ? await searchViaArchive(ctx, args, limit, note)
    : await searchViaDiscord(ctx, args, limit, flags.archiveAvailable);

  if (!outcome.empty) return outcome.text;

  const escalation = await escalateToMeaning(ctx, args, limit, flags);
  return escalation ? `${outcome.text}\n${escalation}` : outcome.text;
}

// 会話のまとまりに対して掛けられる絞り込み。
// 発言単位の条件 (regex / reactions / len / has ...) はまとまりには掛けられない。
const CHUNK_FILTER_KEYS = new Set(['from', 'in', 'after', 'before', 'during', 'on']);

/** chunkFilters の結果。error があれば絞り込みは作れていない。 */
type ChunkFilterResult =
  | { error: string }
  | { error?: undefined; filters: ChunkFilters; unusable: string[] };

/**
 * 意味検索の絞り込みを解く。
 * まとまりの属性 (参加者・チャンネル・期間) しか使えないので、
 * 掛けられない条件は黙って落とさず呼び出し側に返して報告させる。
 */
async function chunkFilters(ctx: AgentContext, args: ToolArgs, lifted: FilterCondition[] = []): Promise<ChunkFilterResult> {
  const filters: ChunkFilters = {};
  const unusable: string[] = [];

  let author: unknown = args.author ?? null;
  const channels = normalizeChannelArg(args.channel) ?? [];
  let after: unknown = args.after ?? null;
  let before: unknown = args.before ?? null;
  let during: string | null = null;

  for (const entry of lifted) {
    if (!CHUNK_FILTER_KEYS.has(entry.key)) {
      unusable.push(entry.key);
      continue;
    }
    if (entry.key === 'from') author ??= entry.value;
    if (entry.key === 'in') channels.push(entry.value);
    if (entry.key === 'after') after ??= entry.value;
    if (entry.key === 'before') before ??= entry.value;
    if (entry.key === 'during' || entry.key === 'on') during ??= entry.value;
  }

  if (author) {
    const id = await resolveMemberId(ctx, author);
    if (!id) return { error: `"${String(author)}" という人が見つかりませんでした。表示名を確認するか、ユーザー ID を指定してください。` };
    filters.authorId = id;
  }

  if (channels.length > 0) {
    const ids: string[] = [];
    for (const name of channels.slice(0, 5)) {
      const channel = assertReadable(ctx, await resolveChannel(ctx, name));
      ids.push(channel.id);
    }
    filters.channelIds = ids;
  }

  if (during) {
    const range = parseDateRange(during);
    filters.fromMs = range.start;
    filters.toMs = range.end;
  } else {
    if (after) filters.fromMs = parseDateRange(String(after)).start;
    if (before) filters.toMs = parseDateRange(String(before)).start;
  }

  return { filters, unusable };
}

/**
 * query を省略されたら「いまの会話」を query にする。
 * 「これ前にも話した？」がキーワードを思い付かずに成立するのが要点。
 */
function recentConversationText(ctx: AgentContext): string {
  // 話題が並行しているチャンネルでは直近12件が混ざったログになるので、
  // 返信でつながっている側があるならそれを使う (それが今の話題そのもの)。
  const source = (ctx.thread?.length ?? 0) >= 2 ? ctx.thread ?? [] : (ctx.recent ?? []);
  const selfId = ctx.client?.user?.id;

  // 自分の過去の回答は外す。探したいのは人が書いた発言なので、
  // 自分の要約文を混ぜると自分の言い回しに近いものを引きに行くことになる。
  const recent = source
    .filter((message) => message.content?.trim() && message.authorId !== selfId)
    .slice(-12);
  if (recent.length < 2) return '';
  // 1件ずつ長さを抑える (埋め込みに渡す文字数に上限を持たせる)
  return recent.map((message) => `${message.authorName}: ${message.content.slice(0, MAX_QUERY_CHARS)}`).join('\n');
}

/**
 * 意味検索。query は「埋め込む文」と「絞り込み」に割ってから渡す。
 */
async function meaningSearch(
  ctx: AgentContext,
  args: ToolArgs,
  limit: number,
  { escalated = false }: { escalated?: boolean } = {}
): Promise<string> {
  const raw = String(args.query ?? '').trim();

  // 参照番号を渡されたらその発言文を query にする (「これに似た発言」が無料で付く)
  const referenced = raw ? ctx.refs.resolve(raw) : null;
  const split = splitMeaningQuery(referenced?.content ? referenced.content : raw);

  const recent = ctx.recent ?? [];
  const usingRecent = !split.text;
  const queryText = split.text || recentConversationText(ctx);

  if (!queryText) return 'query を指定してください (省略するといまの会話を使いますが、会話がまだ短いです)。';

  const resolved = await chunkFilters(ctx, args, split.lifted);
  if (resolved.error !== undefined) return resolved.error;

  if (!escalated) ctx.usedMeaning = true;

  const body = await runSemanticSearch(ctx, {
    queryText,
    filters: resolved.filters,
    // いまの会話を query にしたときは、その会話自身が1位に来ても意味がない
    excludeId: referenced?.messageId ?? (usingRecent ? recent[recent.length - 1]?.messageId : null) ?? null,
    limit,
    escalated
  });

  // 指定された条件を黙って落とすのが一番悪い。落としたら言う。
  const notes = [
    usingRecent ? '(query 省略なので、いまの会話に近い過去の会話を探した)' : '',
    resolved.unusable.length > 0
      ? `(${resolved.unusable.map((key) => `${key}:`).join(' / ')} は会話のまとまりには掛けられないので無視した)`
      : '',
    split.dropped.length > 0
      ? `(query の ${split.dropped.map((key) => `${key}:`).join(' / ')} は OR / 除外 の下にあるので絞り込みに使えず無視した)`
      : ''
  ].filter(Boolean);

  return notes.length > 0 ? `${body}\n${notes.join('')}` : body;
}

/**
 * キーワードで0件だったときに、同じ呼び出しの中で意味検索も走らせる。
 *
 * これが無いとモデルは mode:meaning に手を伸ばさない (実測された失敗はまさに
 * 「Discord のキーワード検索が言い換えを外して、そのまま0件で答える」)。
 * mode という引数は無視され続けうるので、到達性はこちらで担保する。
 *
 * 撃つのは0件のときだけ。件数が少ないだけなら正しく絞れているのが普通で、
 * 「言っていない」と誤読されるのは0件のときにしか起きない。
 */
async function escalateToMeaning(ctx: AgentContext, args: ToolArgs, limit: number, flags: SearchFlags): Promise<string | null> {
  if (!flags.semanticAvailable) return null;
  // 1実行1回だけ。モデルが自分で意味検索を使ったなら重ねない
  if (ctx.escalated || ctx.usedMeaning) return null;
  const raw = String(args.query ?? '').trim();
  if (!raw) return null;
  if (!looksLikeSentence(splitMeaningQuery(raw).text)) return null;

  // await の前に立てる (同じラウンドの並列呼び出しで二重に走らせない)
  ctx.escalated = true;
  ctx.setStatus?.('検索 → 意味検索');

  const body = await meaningSearch(ctx, args, limit, { escalated: true })
    .catch((error: unknown) => {
      console.error('Meaning escalation failed:', error);
      return null;
    });

  if (!body) return null;

  // 「0件だった」だけのときは見出しを付けない (1行で足りる)
  return body.startsWith('(')
    ? body
    : `--- キーワードは0件。query が文だったので意味検索も続けて走らせた ---\n${body}`;
}

// Discord の検索 API が受ける has: の値。ローカルはこれ以外も持っているので、
// 差がそのまま「ローカルにしか無い条件」になる。
const DISCORD_HAS = new Set(['link', 'embed', 'file', 'video', 'image', 'sound', 'sticker', 'poll']);
// Map で引く (オブジェクトだと `constructor` のような名前が Object.prototype の関数に当たる)
const HAS_ALIASES = new Map([['url', 'link'], ['attachment', 'file'], ['audio', 'sound']]);

// Discord 側にある並び順。reactions / long / random はローカルの ORDER BY なので無い。
const DISCORD_SORTS = new Set(['', 'new', 'old', 'relevance']);

// sort / source は大小と前後の空白がぶれる。1か所で揃えないと
// `=== 'relevance'` の比較が静かに外れて、指定した並び順が黙って無視される。
function lower(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * ローカル (取り込み済みログ) にしか無い条件を数え上げる。
 *
 * 判定は query.js のパーサを通す。ここで独自の正規表現を書くと regex:/(a|b)/ の
 * 括弧や -"a b" の否定の扱いが DSL 本体とずれ、片方だけ直したときに静かに壊れる。
 * 解釈できないクエリは DSL ではない素の語とみなす (Discord 側に DSL は無いので、
 * 記号混じりの語はそのまま渡すのが正しい)。
 */
function archiveOnlyNeeds(args: ToolArgs): string[] {
  const needs = new Set<string>();

  const sort = lower(args.sort);
  if (!DISCORD_SORTS.has(sort)) needs.add(`sort:${sort}`);

  if (args.has) {
    const has = lower(args.has);
    if (!DISCORD_HAS.has(HAS_ALIASES.get(has) ?? has)) needs.add(`has:${has}`);
  }

  // Discord は語も人もチャンネルも無い「期間だけ」の検索を受けない。
  // ローカルは期間だけで引けるので、これもローカルの機能として扱う。
  if (!args.query && !args.author && !args.channel && !args.has && (args.after || args.before)) {
    needs.add('期間だけの絞り込み');
  }

  try {
    const { ast, directives } = parseQuery(String(args.query ?? ''));

    if (directives.sort && !DISCORD_SORTS.has(directives.sort)) needs.add(`sort:${directives.sort}`);

    const walk = (node: QueryNode | null): void => {
      if (!node) return;
      switch (node.type) {
        case 'filter':
          needs.add(`${node.key}:`);
          return;
        case 'or':
          needs.add('OR');
          node.nodes.forEach((child) => walk(child));
          return;
        case 'and':
          node.nodes.forEach((child) => walk(child));
          return;
        case 'not':
          needs.add('-除外');
          walk(node.node);
          return;
        case 'term':
          return;
      }
    };

    walk(ast);
  } catch {
    // 解釈できない = DSL ではない。素の語として Discord に渡す
  }

  return [...needs];
}

export type SearchSource = 'archive' | 'discord' | 'unsupported' | 'unavailable';

/**
 * どちらの検索元を使うか決める。
 *
 * 既定は Discord 本体。ローカルは取り込みが途中で死んでいることがあり、
 * そのときの0件を「言っていない」と読まれるのがいちばん高い誤りなので、
 * 常に中身を持っている側を既定にする。ローカルにしか無い条件を使っている
 * ときだけそちらへ回し、回したことは出力の1行目で必ず言う。
 */
export function pickSearchSource(args: ToolArgs, archiveAvailable: boolean): { source: SearchSource; needs: string[] } {
  const asked = lower(args.source);
  const needs = archiveOnlyNeeds(args);

  // 指定された条件を黙って落として検索すると「その条件で0件」と読まれる。
  // source:discord と明示されていても、引けない条件が混ざっていたら回す。
  if (needs.length > 0) {
    return archiveAvailable ? { source: 'archive', needs } : { source: 'unsupported', needs };
  }

  if (asked === 'archive') {
    return archiveAvailable ? { source: 'archive', needs } : { source: 'unavailable', needs };
  }

  return { source: 'discord', needs };
}

async function searchViaArchive(ctx: AgentContext, args: ToolArgs, limit: number, note: string | null = null): Promise<SearchOutcome> {
  const options = await searchOptions(ctx, args);

  if (!options.query && options.extra.length === 0) {
    return { empty: false, text: '検索条件を1つ以上指定してください。' };
  }

  const origin = `検索元: ローカル${note ? ` (${note})` : ''}`;
  const summary = searchSummary(options);

  if (!summary.count) {
    // 0件を「言っていない」と読まれると困る。取り込みの穴の可能性を示す。
    return {
      empty: true,
      text: [
        `該当するメッセージはありませんでした (${origin})。取り込みの穴かもしれない。`,
        'ローカル専用の条件を外せば Discord 本体を引ける。'
      ].join('')
    };
  }

  const offset = offsetOf(args);
  const { rows } = search(options, { limit, offset });
  const messages = rows.map((row) => fromArchiveRow(row, channelName(ctx, row.channel_id)));

  const shown = offset > 0 ? `表示 ${offset + 1}〜${offset + messages.length} 件` : `表示 ${messages.length} 件`;
  const lines = [
    `${summary.count} 件ヒット (${summary.authors} 人 / ${channelCountLabel(summary)}) ・ ${shown} ・ ${origin}`,
    `期間: ${shortTime(summary.first_at)} 〜 ${shortTime(summary.last_at)}`
  ];

  // 既定は新しい順なので、件数が多いと直近だけを見て「昔は言っていない」と
  // 結論されがちになる。まだ先があることと、その辿り方をここで言う。
  if (summary.count > offset + messages.length && options.sort === 'new') {
    lines.push('(新しい順の先頭のみ。古い方を見るなら sort:old か during: で期間を指定する)');
  }

  lines.push(formatMessageLines(messages, {
    refs: ctx.refs,
    selfId: ctx.client?.user?.id,
    showChannel: true,
    bodyChars: agentConfig.messageChars
  }));

  return { empty: false, text: lines.join('\n') };
}

function channelCountLabel(summary: SearchSummary): string {
  return `${summary.channels} チャンネル`;
}

/** splitMeaningQuery の結果。 */
export interface MeaningQuery {
  /** 埋め込む文 */
  text: string;
  /** 絞り込みに持ち上げた filter */
  lifted: FilterCondition[];
  /** OR / 否定の下にあって使えなかった filter のキー */
  dropped: string[];
}

/**
 * mode:meaning の query を「埋め込む文」と「候補を絞るフィルタ」に割る。
 *
 * 割らずに丸ごと埋め込むと `from:@たこ レビュー要らない` の `from:@たこ` が
 * ただの文字列としてベクトル化され、絞れていない結果を「その人の中から探した結果」
 * として読まれる。逆に丸ごとフィルタにすると素の語が部分一致条件として残り、
 * 「言い換えを跨ぐ」という目的そのものが消える (その語を含む行しか出ない)。
 *
 * 持ち上げるのは根の AND 直下の filter だけ。OR や否定の下にあるものを
 * トップレベルの AND に混ぜると条件の意味が変わる
 * (`(from:@a OR from:@b)` を両方 AND にすると必ず0件になる)。
 */
export function splitMeaningQuery(raw: unknown): MeaningQuery {
  const text = String(raw ?? '');

  let ast: QueryNode | null;
  try {
    ({ ast } = parseQuery(text));
  } catch {
    // 解釈できない = DSL ではない。素の文として扱う
    return { text, lifted: [], dropped: [] };
  }

  const lifted: FilterCondition[] = [];
  const dropped: string[] = [];

  const collectFilterKeys = (node: QueryNode, out: string[]): void => {
    switch (node.type) {
      case 'filter':
        out.push(node.key);
        return;
      case 'not':
        collectFilterKeys(node.node, out);
        return;
      case 'and':
      case 'or':
        node.nodes.forEach((child) => collectFilterKeys(child, out));
        return;
      case 'term':
        return;
    }
  };

  const walk = (node: QueryNode | null): void => {
    if (!node) return;
    switch (node.type) {
      case 'and':
        node.nodes.forEach((child) => walk(child));
        return;
      case 'filter':
        lifted.push({ key: node.key, value: node.value });
        return;
      case 'or':
      case 'not':
        collectFilterKeys(node, dropped);
        return;
      case 'term':
        return;
    }
  };

  walk(ast);

  return {
    // 持ち上げが無いなら生の文字列をそのまま返す (collectTerms は括弧と
    // 引用符を落とすので、割る必要が無いときは触らない)
    text: lifted.length === 0 ? text : collectTerms(ast).join(' '),
    lifted,
    dropped
  };
}

/**
 * Discord の content に渡す文字列。
 *
 * 素の語だけを渡す。AST は `a b` と `a AND b` を区別できないので生の文字列を
 * 渡すと AND がそれ自体検索語として飛ぶ。空白を含む語は句なので引用符を戻す。
 */
function discordContent(raw: string): string {
  try {
    const { ast } = parseQuery(raw);
    const terms = collectTerms(ast).map((term) => (/\s/.test(term) ? `"${term}"` : term));
    return terms.length > 0 ? terms.join(' ') : raw;
  } catch {
    return raw;
  }
}

/**
 * after: / before: を Discord の min_id / max_id に直す。
 *
 * 変換せずに捨てると、絞れていない結果を「期間で絞った結果」として読まれる。
 * 境目の意味は search.js の before / after にそろえる。ずれると同じ条件でも
 * 検索元ごとに違う結果が出て、どちらが正しいのか分からなくなる:
 *   after:2024-05-01  → その日を含む   (created_at >= start)
 *   before:2024-05-01 → その日を含まない (created_at < start)
 */
function dateBounds(args: ToolArgs): { minId?: string; maxId?: string; error?: string } {
  const bounds: { minId?: string; maxId?: string; error?: string } = {};

  if (args.after) {
    const { start } = parseDateRange(String(args.after));
    const id = msToSnowflake(start);
    // 2015年より前の下限は指定しなくても同じ (Discord にそれ以前の発言は無い)
    if (id && id !== '0') bounds.minId = id;
  }

  if (args.before) {
    const { start } = parseDateRange(String(args.before));
    const id = BigInt(msToSnowflake(start) ?? '0');
    if (id <= 0n) {
      return { error: `${String(args.before)} より前の発言は Discord にはありません (Discord は 2015 年から)。` };
    }
    // created_at < start と同じにするため境目の ID を1つ戻す
    // (max_id が境界を含むかは公開されていないので、含む側に寄せておく)
    bounds.maxId = String(id - 1n);
  }

  return bounds;
}

/**
 * 検索結果から「一致した発言」だけを取り出す。
 *
 * messages は [[一致した発言, 前後の文脈, ...], ...] の形で、組の中で hit が
 * 立っている1件だけが一致した発言。平坦化すると limit より多く並ぶうえ、
 * 一致していない発言まで「ヒット」として読まれる。
 * hit が付かない形で返ることもあるので、その場合は組の真ん中を採る
 * (Discord は一致した発言を中心に前後を付ける)。外しても採るのは1件なので、
 * 件数と limit の関係は狂わない。
 */
function pickHits(data: unknown): RawMessage[] {
  const groups: unknown[] = isRecord(data) && Array.isArray(data.messages) ? data.messages : [];
  const hits: RawMessage[] = [];

  for (const group of groups) {
    const list: unknown[] = (Array.isArray(group) ? group : [group]).filter(Boolean);
    const picked = list.length <= 1
      ? list[0]
      : list.find((message) => isRecord(message) && message.hit) ?? list[Math.floor(list.length / 2)];
    if (isRawMessage(picked)) hits.push(picked);
  }

  return hits;
}

/**
 * Discord の検索は権限を見ないので、ここで実行者の目で絞る。
 * キャッシュに無いチャンネルは落とす (漏らすより落とすほうが安全)。
 * ただしアーカイブ済みスレッドはキャッシュに載らないことが多いので、
 * getChannelScope と同じ規則で親チャンネルの権限を見る。
 */
function canSeeHit(ctx: AgentContext, channelId: string): boolean {
  const cached = ctx.guild.channels.cache.get(channelId);
  if (cached) return canRead(cached, ctx.member);

  try {
    const row = archiveDb
      .prepare<[string, string], { parent_id: string | null; is_thread: number | null; is_private: number | null }>(
        'SELECT parent_id, is_thread, is_private FROM channels WHERE guild_id = ? AND channel_id = ?'
      )
      .get(ctx.guild.id, channelId);

    if (!row?.is_thread || row.is_private || !row.parent_id) return false;
    const parent = ctx.guild.channels.cache.get(row.parent_id);
    return parent ? canRead(parent, ctx.member) : false;
  } catch {
    return false;
  }
}

async function searchViaDiscord(ctx: AgentContext, args: ToolArgs, limit: number, archiveAvailable: boolean): Promise<SearchOutcome> {
  const query = new URLSearchParams();
  query.set('limit', String(Math.min(limit, 25)));

  if (args.query) query.set('content', discordContent(String(args.query)));

  if (args.author) {
    // Discord の検索 API は author_id しか受けないので、名前は ID に直す。
    // 直せないときは黙って無視せず、そう伝える (絞れていない結果を渡すと誤読される)。
    const author = await resolveMemberId(ctx, args.author);
    if (!author) {
      return { empty: false, text: `"${String(args.author)}" という人が見つかりませんでした。表示名を確認するか、ユーザー ID を指定してください。` };
    }
    query.set('author_id', author);
  }

  if (args.channel) {
    const channel = assertReadable(ctx, await resolveChannel(ctx, args.channel));
    query.set('channel_id', channel.id);
  }

  // ローカルの別名 (audio / attachment / url) をそのまま送ると 400 になる
  if (args.has) {
    const has = lower(args.has);
    query.set('has', HAS_ALIASES.get(has) ?? has);
  }

  // 絞り込みが1つも無いと Discord 側で弾かれるので、並び順だけの指定は条件と数えない。
  if (!args.query && !args.author && !args.channel && !args.has) {
    return { empty: false, text: '検索条件を1つ以上指定してください。' };
  }

  const bounds = dateBounds(args);
  if (bounds.error) return { empty: false, text: bounds.error };
  if (bounds.minId) query.set('min_id', bounds.minId);
  if (bounds.maxId) query.set('max_id', bounds.maxId);

  const sort = lower(args.sort);
  if (sort === 'relevance') query.set('sort_by', 'relevance');
  if (sort === 'old') query.set('sort_order', 'asc');

  const offset = offsetOf(args);
  if (offset > 0) query.set('offset', String(offset));

  let data: unknown;
  try {
    data = await ctx.client.rest.get(`/guilds/${ctx.guild.id}/messages/search`, { query });
  } catch (error) {
    return { empty: false, text: `Discord の検索 API が失敗しました: ${truncate(errorMessage(error), 200)}` };
  }

  // インデックス構築中は 202。retry_after は 0 で来ることがあるので真偽で見ない
  // (0 を未指定と読むと、この分岐を抜けて「0件」として報告してしまう)。
  const reply = isRecord(data) ? data : {};
  const retryAfter = Number(reply.retry_after);
  if (reply.code === 110000 || Number.isFinite(retryAfter) || reply.doing_deep_historical_index) {
    return {
      empty: false,
      text: [
        'Discord 側の検索インデックスがまだ準備できていません',
        Number.isFinite(retryAfter) ? ` (${Math.max(1, Math.ceil(retryAfter))} 秒後に再試行可)。` : '。',
        archiveAvailable ? 'source:archive なら今すぐ引ける。' : 'read で直接読むほうが確実です。'
      ].join('')
    };
  }

  // 読めないチャンネルのヒットは、件数にも注記にも一切出さない。
  // 「除いた」と言うだけで、読めないチャンネルにその語があるかどうかが分かってしまう
  // (権限の無い人が語を変えながら呼べば、非公開チャンネルの中身を探る道具になる)。
  const visible = pickHits(data).filter((message) => canSeeHit(ctx, message.channel_id));

  if (visible.length === 0) {
    return {
      empty: true,
      text: [
        '該当するメッセージはありませんでした (検索元: Discord)。',
        'Discord の検索は語の切れ目に厳しいので、短い語や言い換えで引き直すと出ることがある。',
        archiveAvailable ? '正規表現・OR・リアクション数で攻めるならローカル側も引ける。' : ''
      ].join('')
    };
  }

  const messages = visible
    .slice(0, limit)
    .map((message) => fromRawMessage(message, ctx.guild.id, channelName(ctx, message.channel_id)));

  // 生の total_results は出さない。呼んだ人に見えないチャンネルのヒットまで
  // 数えているので、件数だけが権限を越えてしまう。
  return {
    empty: false,
    text: [
      `表示 ${messages.length} 件 ・ 検索元: Discord`
        + (sort === 'relevance' ? ' (関連度順)' : '')
        + (visible.length >= limit ? ' ・ limit ぶん埋まったのでこれで全部とは限らない' : ''),
      formatMessageLines(messages, {
        refs: ctx.refs,
        selfId: ctx.client?.user?.id,
        showChannel: true,
        bodyChars: agentConfig.messageChars
      })
    ].join('\n')
  };
}


// ---------------------------------------------------------------- mode:posts (投稿)

/**
 * 投稿 (スレッド / フォーラムの投稿) を単位にして探す。
 *
 * 発言単位で返すと「どの投稿の話か」が読み手に分からない。フォーラムでは
 * 1投稿 = 1話題なので、そこを単位にしないと「○○の投稿ある？」に答えられない。
 */
async function searchPosts(ctx: AgentContext, args: ToolArgs, limit: number): Promise<string> {
  const options = await searchOptions(ctx, args);

  if (!options.query && options.extra.length === 0) {
    return '検索条件を1つ以上指定してください。';
  }

  // タイトル一致に使う素の語。フィルタ (from: など) は語ではないので外れる。
  let titleTerms: string[] = [];
  try {
    const { ast } = parseQuery(options.query);
    titleTerms = collectTerms(ast).slice(0, 4);
  } catch {
    // 解釈できないクエリは素の語として扱う
    titleTerms = options.query ? [options.query] : [];
  }

  const offset = offsetOf(args);
  const rows: ThreadHitRow[] = searchThreads(options, { limit, offset, titleTerms });

  if (rows.length === 0) {
    return [
      '条件に合う投稿はありませんでした。',
      'スレッドの外 (普通のチャンネル) の発言は mode:posts では出ないので、mode を外して引き直すこと。'
    ].join('');
  }

  const lines = rows.map((row) => {
    const ref = ctx.refs.add({
      guildId: ctx.guild.id,
      channelId: row.channel_id,
      channelName: row.name,
      // 起点は中にある実在の発言。スレッド ID は親側の発言なので around に使えない
      messageId: row.oldest_id ?? row.newest_id ?? row.channel_id,
      authorId: '0',
      authorName: 'unknown',
      content: row.name,
      createdAt: snowflakeToMs(row.oldest_id ?? row.newest_id ?? '0') ?? undefined
    });

    const where = row.parent_id ? `#${channelName(ctx, row.parent_id)}` : '';
    const last = snowflakeToMs(row.newest_id ?? '0') ?? 0;
    const tags = String(row.applied_tags ?? '').trim();

    const tail = [
      `${row.message_count ?? 0}件`,
      row.hits > 0 ? `一致${row.hits}` : null,
      row.title_hit ? 'タイトル一致' : null,
      tags ? `[${tags.split(/\s+/).join(' ')}]` : null,
      last > 0 ? `最終 ${shortTime(last)}` : null
    ].filter(Boolean).join(' ');

    return `${ref}) [${row.name}${where ? ` ${where}` : ''}] ${tail}`;
  });

  const notes = [
    '中を読むなら at にその番号を渡す。',
    // タグは取り込み時点のもの。当たらない = 付いていない、ではない
    /tag:/.test(options.query) || options.extra.some((entry) => entry.key === 'tag')
      ? '(タグは取り込んだ時点のもの。取り込み前の投稿には付いていないので、0件を「そのタグは無い」と読まないこと)'
      : null
  ].filter(Boolean);

  return [
    `投稿 ${rows.length} 件${offset > 0 ? ` (${offset + 1} 件目から)` : ''} ・ タイトル一致を上に、次にヒット数の多い順`,
    ...lines,
    ...notes
  ].join('\n');
}

// ---------------------------------------------------------------- read

export function readDefinition(archiveAvailable: boolean): ToolDefinition {
  const directions = ['around', 'before', 'after', ...(archiveAvailable ? ['replies'] : [])];

  return {
    type: 'function',
    function: {
      name: 'read',
      description: [
        'チャンネルのメッセージを時系列で読む。呼ばれたチャンネルの直近の流れは既に渡してあるので、',
        '検索で出た発言の前後を追うときや、別のチャンネル・別の時期を読みたいときに使う。',
        'at に search の参照番号を渡せばその発言の周辺を読む (別チャンネルのヒットでも channel の指定は不要)。',
        'フォーラムを channel に渡すと投稿の一覧を番号付きで返すので、読みたい投稿の番号を at に渡す。',
        '検索結果だけでは文脈が分からないので、断定する前にこれで周辺を読むこと。',
        'channel は "general, dev" のようにカンマ区切りで最大5つ渡せる。見比べたいときは1件ずつ呼ばない。'
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'チャンネル。カンマ区切りで複数可 (最大5)。省略時は at の発言のチャンネル、無ければ呼ばれたチャンネル' },
          at: { type: 'string', description: '起点。参照番号 / メッセージ ID / 日付 (2024-05-01 / 2020-04 / 7d) / 省略で最新' },
          direction: {
            type: 'string',
            enum: directions,
            description: archiveAvailable
              ? '既定 around。replies は at への返信と返信元を辿る (誰が誰に答えていないかが分かる)'
              : '既定 around'
          },
          expand: { type: 'string', enum: ['conversation'], description: '無言で区切られた会話のまとまりまで広げる' },
          limit: { type: 'number', description: '件数 (既定 30、最大 100)' }
        }
      }
    }
  };
}

const MAX_CHANNELS_PER_READ = 5;

// Discord のメッセージ ID の形。起点に使う前にこれで確かめる
// (BigInt() に渡す文字列がこの形でないと SyntaxError で落ちる)。
const SNOWFLAKE_PATTERN = /^\d{1,20}$/;

/**
 * 起点の前後を読む。
 *
 * around は「そのチャンネルに実在するメッセージ ID」でしか当てにできない。
 * 別チャンネルのヒットや日付から作った ID は、そのチャンネルには存在しないので
 * around には渡せない (合成しても元の ID と位置的に同じで、状況は変わらない)。
 * before / after は ID の大小比較として動くので、そちらを2回引いて挟む。
 */
async function fetchAround(channel: MessageHost, anchorId: string, limit: number, { exact }: { exact: boolean }): Promise<Message<true>[]> {
  if (exact) return [...(await channel.messages.fetch({ around: anchorId, limit })).values()];

  const back = Math.ceil(limit / 2);
  const forward = Math.max(1, limit - back);

  const [older, newer] = await Promise.all([
    channel.messages.fetch({ before: anchorId, limit: back }).then((c) => [...c.values()]).catch((): Message<true>[] => []),
    // 境目を含めたいので1つ戻す (dateBounds と同じ考え方)
    channel.messages.fetch({ after: String(BigInt(anchorId) - 1n), limit: forward }).then((c) => [...c.values()]).catch((): Message<true>[] => [])
  ]);

  return [...older, ...newer];
}

/**
 * 起点と向きに応じてメッセージを取る。起点が無ければ最新から。
 * 起点の ID が Discord のメッセージ ID の形でなければ、取りに行く前に断る
 * (参照表の ID はモデルが渡した文字列を含みうる。呼び出し側の try で文面になる)。
 */
async function fetchWindow(
  channel: MessageHost,
  anchor: Anchor,
  direction: Direction,
  limit: number,
  exact: boolean
): Promise<Message<true>[]> {
  if (anchor.kind === 'none' || anchor.kind === 'error') {
    return [...(await channel.messages.fetch({ limit })).values()];
  }

  if (!SNOWFLAKE_PATTERN.test(anchor.messageId)) {
    throw new Error('起点がメッセージ ID の形ではないので読めません。検索し直した番号か、日付を渡してください。');
  }

  // 日付から作った ID はどのチャンネルにも実在しないので around は挟み込みで読む
  if (direction === 'around') return fetchAround(channel, anchor.messageId, limit, { exact });

  const page = direction === 'before'
    ? { before: anchor.messageId, limit }
    : { after: anchor.messageId, limit };
  return [...(await channel.messages.fetch(page)).values()];
}

/**
 * 1回の呼び出しで複数チャンネルを読む。往復を増やさずに横断できるようにするため。
 * 日付の起点は全チャンネルに効く (「2020年4月頃、この2つで何を話していたか」)。
 */
async function readManyChannels(
  ctx: AgentContext,
  wanted: string[],
  args: ToolArgs,
  { anchor = { kind: 'none' }, direction = 'around' }: { anchor?: Anchor; direction?: Direction } = {}
): Promise<string> {
  const targets = wanted.slice(0, MAX_CHANNELS_PER_READ);
  const total = clampLimit(args.limit, 30, 100);
  const perChannel = Math.max(5, Math.floor(total / targets.length));

  const sections: string[] = [];
  const problems: string[] = [];

  for (const name of targets) {
    let channel: GuildBasedChannel;
    try {
      channel = assertReadable(ctx, await resolveChannel(ctx, name));
    } catch (error) {
      problems.push(`${name}: ${errorMessage(error)}`);
      continue;
    }

    // フォーラムが混ざっていても行き止まりにしない。投稿の一覧を1区画として出す。
    if (isForumType(channel.type)) {
      sections.push(await listThreadContainer(ctx, channel, Math.min(perChannel, 20)));
      continue;
    }

    if (!hasMessageManager(channel)) {
      problems.push(`#${channel.name}: メッセージを取得できない種類のチャンネルです`);
      continue;
    }

    let fetched: Message<true>[];
    try {
      // 日付から作った ID はどのチャンネルにも実在しないので必ず挟み込みで読む (exact: false)
      fetched = await fetchWindow(channel, anchor, direction, perChannel, false);
    } catch (error) {
      problems.push(`#${channel.name}: ${truncate(errorMessage(error), 80)}`);
      continue;
    }

    const messages = fetched
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((message) => fromDiscordMessage(message, channel.name));

    sections.push([
      `--- #${channel.name} (${messages.length}件) ---`,
      messages.length === 0
        ? '(発言なし)'
        : formatMessageLines(messages, {
          refs: ctx.refs,
          selfId: ctx.client?.user?.id,
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

/**
 * メッセージ ID から、それがどのチャンネルの発言かを引く。
 *
 * 検索結果の番号を経由せずに生の ID (やリンク) を渡されたとき、どこを読めばいいかが
 * 分からないと「呼ばれたチャンネル」に落ちる。他所の ID でそこを around すると、
 * 取れないか、まるで無関係な場所を読む。readReplies が同じ引き方をしているので、
 * 材料は最初からあった。
 *
 * 実行者に見えないチャンネルは返さない。ここを通すと、ID を知っているだけで
 * 権限のないチャンネルの前後が読めてしまう。
 */
function locateMessage(ctx: Pick<AgentContext, 'guild' | 'channelScope'>, messageId: string | null | undefined): string | null {
  if (!messageId) return null;

  try {
    const row = archiveDb
      .prepare<[string, string], { channel_id: string }>('SELECT channel_id FROM messages WHERE guild_id = ? AND message_id = ?')
      .get(ctx.guild.id, String(messageId));

    if (!row?.channel_id) return null;
    return isChannelAllowed(row.channel_id, ctx.channelScope) ? row.channel_id : null;
  } catch {
    // アーカイブが無い構成でも動くようにする
    return null;
  }
}

/**
 * at を起点に解く。参照番号 / メッセージ ID / 日付 のどれでも受ける。
 *
 * 数字の扱いに注意が要る。1〜4桁の数字は参照番号のつもりで書かれているので、
 * 表に無ければエラーにする。parseDateRange の Date.parse フォールバックは緩く、
 * ここを素通りさせると古い番号が黙って謎の日付になる。
 */
export function resolveAnchor(ctx: Pick<AgentContext, 'guild' | 'refs' | 'channelScope'>, at: unknown): Anchor {
  const text = String(at ?? '').trim().slice(0, MAX_ARG_CHARS);
  if (!text) return { kind: 'none' };

  const entry = ctx.refs.resolve(text);
  if (entry?.messageId) {
    return {
      kind: 'message',
      messageId: entry.messageId,
      // どのチャンネルか分からないままだと runRead が「呼ばれたチャンネル」に
      // 落ちて、他所の ID でそこを探しに行く。アーカイブが知っているなら埋める。
      channelId: entry.channelId ?? locateMessage(ctx, entry.messageId),
      createdAt: entry.createdAt ?? null
    };
  }

  const bare = text.replace(/^[#[]|]$/g, '');

  // 年は日付として通す (2020 は参照番号ではなく年のつもり)
  if (!/^(19|20)\d{2}$/.test(bare) && /^\d{1,4}$/.test(bare)) {
    return { kind: 'error', message: `参照番号 ${bare} は今の結果にありません。検索してから番号を渡してください。` };
  }

  try {
    const { start } = parseDateRange(bare);
    const snowflake = msToSnowflake(start);
    if (!snowflake || snowflake === '0') {
      return { kind: 'error', message: `${bare} は Discord より前なので起点にできません (Discord は 2015 年から)。` };
    }
    return { kind: 'time', messageId: snowflake, channelId: null, createdAt: start };
  } catch {
    return { kind: 'error', message: `at を読めませんでした: ${truncate(text, 60)}` };
  }
}

/** 会話のまとまりに刈った結果。trimmed が false なら刈っていない。 */
interface ConversationCut {
  messages: AgentMessage[];
  trimmed: boolean;
  threshold?: number;
  gapBefore?: number | null;
  gapAfter?: number | null;
  hitStart?: boolean;
  hitEnd?: boolean;
}

/**
 * 取得したページを「無言で区切られたひとまとまり」に刈る。
 *
 * 閾値は固定しない。静かなチャンネルでは全部が別会話になり、賑やかな
 * チャンネルでは一晩が1会話になるので、ページ内の間隔の中央値から決める。
 */
function trimToConversation(messages: AgentMessage[], anchorId: string): ConversationCut {
  if (messages.length < 3) return { messages, trimmed: false };

  // i は 0 〜 messages.length - 1 の範囲でしか呼ばない
  const at = (i: number): number => messages[i]?.createdAt ?? 0;

  const gaps: number[] = [];
  for (let i = 1; i < messages.length; i += 1) {
    gaps.push(at(i) - at(i - 1));
  }

  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const threshold = Math.min(6 * 3_600_000, Math.max(5 * 60_000, median * 6));

  const center = Math.max(0, messages.findIndex((message) => message.messageId === anchorId));
  let start = center;
  let end = center;

  while (start > 0 && at(start) - at(start - 1) <= threshold) start -= 1;
  while (end < messages.length - 1 && at(end + 1) - at(end) <= threshold) end += 1;

  // 短すぎると文脈にならないので最低5件は返す
  while (end - start + 1 < Math.min(5, messages.length)) {
    if (start > 0) start -= 1;
    else if (end < messages.length - 1) end += 1;
    else break;
  }

  return {
    messages: messages.slice(start, end + 1),
    trimmed: true,
    threshold,
    gapBefore: start > 0 ? at(start) - at(start - 1) : null,
    gapAfter: end < messages.length - 1 ? at(end + 1) - at(end) : null,
    hitStart: start === 0,
    hitEnd: end === messages.length - 1
  };
}

function durationLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}時間` : `${Math.round(hours / 24)}日`;
}

/** listThreadContainer が使う channels 表の行。 */
interface ThreadListRow {
  channel_id: string;
  name: string;
  message_count: number | null;
  oldest_id: string | null;
  newest_id: string | null;
}

/**
 * フォーラム / メディアの投稿一覧。
 *
 * フォーラム本体は発言を持たない (discord.js の ForumChannel に `.messages` が無い) ので、
 * `read channel:#フォーラム` は「メッセージを取得できません」で行き止まりだった。
 * 中身は全部スレッドなので、ここで一覧を出して番号を振り、そのまま `at` に渡せるようにする。
 *
 * 起点にする ID はスレッド ID ではなく `oldest_id` (中にある実在の発言)。
 * スレッド ID は「そのスレッドが始まった親の発言」なので、投稿の中では
 * around の起点にならないことがある (フォーラムだけは両者が一致する)。
 */
async function listThreadContainer(ctx: AgentContext, container: GuildBasedChannel, limit: number): Promise<string> {
  let rows: ThreadListRow[] = [];
  try {
    rows = archiveDb.prepare<[string, string, number], ThreadListRow>(`
      SELECT channel_id, name, message_count, oldest_id, newest_id
      FROM channels
      WHERE guild_id = ? AND parent_id = ? AND is_thread = 1 AND is_private = 0
      ORDER BY CAST(newest_id AS INTEGER) DESC
      LIMIT ?
    `).all(ctx.guild.id, container.id, limit);
  } catch {
    // アーカイブが無い構成でも動く
  }

  const label = isForumType(container.type) ? '投稿' : 'スレッド';
  const visible = rows.filter((row) => isChannelAllowed(row.channel_id, ctx.channelScope));

  // 取り込み前でも行き止まりにしない。生きている投稿だけは API から拾える。
  if (visible.length === 0) {
    const threadManager = 'threads' in container ? container.threads : undefined;
    const active = await threadManager?.fetchActive?.().catch(() => null);
    // fetchActive は権限を見ずに全部返す。非公開スレッドなど、呼んだ人に読めないものは出さない。
    const threads = [...(active?.threads?.values() ?? [])]
      .filter((thread) => canRead(thread, ctx.member))
      .slice(0, limit);

    if (threads.length === 0) return `#${container.name} には読める${label}がありませんでした。`;

    const lines = threads.map((thread) => {
      const ref = ctx.refs.add({
        guildId: ctx.guild.id,
        channelId: thread.id,
        channelName: thread.name,
        messageId: thread.id,
        authorId: thread.ownerId ?? '0',
        authorName: 'unknown',
        content: thread.name,
        createdAt: thread.createdTimestamp ?? Date.now()
      });
      return `${ref}) [${thread.name}] ${thread.messageCount ?? '?'}件`;
    });

    return [
      `#${container.name} の${label} ${threads.length} 件 (取り込み前なので、いま開いているぶんだけ)`,
      ...lines,
      `(中を読むなら at にその番号。閉じた${label}まで見るには管理者の \`/index build\` が要る)`
    ].join('\n');
  }

  const lines = visible.map((row) => {
    const ref = ctx.refs.add({
      guildId: ctx.guild.id,
      channelId: row.channel_id,
      channelName: row.name,
      // 中にある実在の発言を起点にする (無ければ最後の発言)
      messageId: row.oldest_id ?? row.newest_id ?? row.channel_id,
      authorId: '0',
      authorName: 'unknown',
      content: row.name,
      createdAt: snowflakeToMs(row.oldest_id ?? row.newest_id ?? '0') ?? undefined
    });

    const last = snowflakeToMs(row.newest_id ?? '0') ?? 0;
    const tail = [`${row.message_count ?? 0}件`, last > 0 ? `最終 ${shortTime(last)}` : null]
      .filter(Boolean)
      .join(' ');

    return `${ref}) [${row.name}] ${tail}`;
  });

  return [
    `#${container.name} の${label} ${visible.length} 件 (最終発言の新しい順)`,
    ...lines,
    `(中を読むなら at にその番号 / この配下だけを検索するなら search の query に \`in:#${container.name}\`)`
  ].join('\n');
}

export async function runRead(ctx: AgentContext, rawArgs: ToolArgs): Promise<string> {
  const args = boundedArgs(rawArgs);
  const wanted = normalizeChannelArg(args.channel);
  const direction = lower(args.direction) || 'around';
  const anchor = resolveAnchor(ctx, args.at);

  if (anchor.kind === 'error') return anchor.message;

  if (direction === 'replies') {
    if (anchor.kind !== 'message') return 'replies には at に参照番号かメッセージ ID を渡してください。';
    if (wanted && wanted.length > 1) return 'replies は1つの発言を起点にするので、channel を複数渡さないでください。';
    return readReplies(ctx, anchor.messageId, args);
  }

  if (!isWindowDirection(direction)) {
    return `direction が不正です: ${String(args.direction)}。around / before / after / replies のどれかです。`;
  }

  // 複数チャンネル: 日付の起点は全部に効くが、参照番号は1チャンネルの話なので断る
  if (wanted && wanted.length > 1) {
    if (anchor.kind === 'message') {
      return '参照番号を起点にするときは channel を1つにしてください (その発言はそのチャンネルのものです)。';
    }
    return readManyChannels(ctx, wanted, args, { anchor, direction });
  }

  // 参照番号から来た channel_id は確定値なので名前解決を通さない。
  // 呼ばれたチャンネルを既定にすると、別チャンネルのヒットの前後が追えない。
  const named = wanted?.[0];
  const channel = assertReadable(
    ctx,
    named !== undefined
      ? await resolveChannel(ctx, named)
      : anchor.kind === 'message' && anchor.channelId
        ? ctx.guild.channels.cache.get(anchor.channelId)
          ?? await ctx.guild.channels.fetch(anchor.channelId).catch(() => null)
        : ctx.channel
  );

  // フォーラム / メディアは中身が全部スレッドなので、投稿の一覧を返す
  if (isForumType(channel.type)) {
    return listThreadContainer(ctx, channel, clampLimit(args.limit, 20, 50));
  }

  if (!hasMessageManager(channel)) {
    return 'そのチャンネルからはメッセージを取得できません。';
  }

  const limit = clampLimit(args.limit, 30, 100);
  let raw: Message<true>[];

  try {
    // 同一チャンネルの実在メッセージなら around が使える
    const exact = anchor.kind === 'message' && (!anchor.channelId || anchor.channelId === channel.id);
    raw = await fetchWindow(channel, anchor, direction, limit, exact);
  } catch (error) {
    return `メッセージを取得できませんでした: ${truncate(errorMessage(error), 200)}`;
  }

  let messages = raw
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((message) => fromDiscordMessage(message, channel.name));

  if (messages.length === 0) return 'メッセージがありませんでした。';

  const notes: string[] = [];

  if (lower(args.expand) === 'conversation') {
    const cut = trimToConversation(messages, anchor.kind === 'message' || anchor.kind === 'time' ? anchor.messageId : '');
    messages = cut.messages;

    if (cut.trimmed) {
      const parts: string[] = [];
      // 端に当たったことを言わないと、切れた会話を完結したものとして読まれる
      if (cut.hitStart) parts.push('前はページの端まで続いている');
      else if (cut.gapBefore) parts.push(`前は${durationLabel(cut.gapBefore)}の無言`);
      if (cut.hitEnd) parts.push('後ろはページの端まで続いている');
      else if (cut.gapAfter) parts.push(`後ろは${durationLabel(cut.gapAfter)}の無言`);
      notes.push(`会話のまとまり (${parts.join('、')}で切れている)`);
    }
  }

  const sameChannel = channel.id === ctx.channel.id;
  const period = messages.length > 1
    ? ` ${shortTime(messages[0]?.createdAt)}〜${shortTime(messages[messages.length - 1]?.createdAt)}`
    : '';

  return [
    `#${channel.name} ${messages.length} 件${period}${notes.length ? ` ・ ${notes.join(' ・ ')}` : ''}`,
    formatMessageLines(messages, {
      refs: ctx.refs,
      selfId: ctx.client?.user?.id,
      showChannel: !sameChannel,
      bodyChars: agentConfig.messageChars
    }),
    // 次の一手はここに書く。system prompt は毎ターン払うが、これは使ったときだけ
    `(続きは at:${messages.length > 1 ? '最後の番号' : 'この番号'} direction:after / 同じ頃の別チャンネルは channel を変えて同じ番号を at に)`
  ].join('\n');
}

/**
 * 返信の連鎖をたどる。
 *
 * 「この発言に返信したのは誰か」は Discord の API では引けない (全件走査になる)。
 * reply_to と idx_msg_reply を持っているのはこのためで、ここが初めての利用箇所。
 * 時系列に並べれば返信は必ず親より後に来るので、既存の ↩N 表示が木の形を描く。
 */
async function readReplies(ctx: AgentContext, anchorMessageId: string, args: ToolArgs): Promise<string> {
  const limit = clampLimit(args.limit, 30, 100);

  let target: MessageRow | undefined;
  try {
    target = archiveDb
      .prepare<[string, string], MessageRow>('SELECT * FROM messages WHERE guild_id = ? AND message_id = ? AND deleted = 0')
      .get(ctx.guild.id, anchorMessageId);
  } catch {
    return '返信の辿り方はローカルの取り込みが要る。管理者が `/index build` を実行するまでは direction:around で周辺を読んでください。';
  }

  if (!target) {
    return 'その発言はローカルに取り込まれていません (直近の発言か、取り込みの穴)。direction:around で周辺を読んでください。';
  }

  if (!isChannelAllowed(target.channel_id, ctx.channelScope)) {
    return 'その発言があるチャンネルは読めません。';
  }

  const byId = new Map<string, MessageRow>();
  const add = (row: MessageRow | undefined): boolean => {
    if (!row || row.guild_id !== ctx.guild.id || row.deleted || !isChannelAllowed(row.channel_id, ctx.channelScope)) return false;
    byId.set(row.message_id, row);
    return true;
  };

  add(target);

  // 親を遡る (8ホップまで)
  const parentStmt = archiveDb.prepare<[string, string], MessageRow>(
    'SELECT * FROM messages WHERE guild_id = ? AND message_id = ? AND deleted = 0'
  );
  let cursor: string | null | undefined = target.reply_to;
  for (let hop = 0; hop < 8 && cursor; hop += 1) {
    const parent = parentStmt.get(ctx.guild.id, cursor);
    if (!parent || byId.has(parent.message_id)) break;
    if (!add(parent)) break;
    cursor = parent.reply_to;
  }

  // 子を深さ3まで
  const childStmt = archiveDb.prepare<[string, string, number], MessageRow>(
    'SELECT * FROM messages WHERE guild_id = ? AND reply_to = ? AND deleted = 0 ORDER BY created_at LIMIT ?'
  );
  let frontier = [target.message_id];
  for (let depth = 0; depth < 3 && frontier.length > 0 && byId.size < limit; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of childStmt.all(ctx.guild.id, id, limit)) {
        if (byId.has(child.message_id)) continue;
        if (add(child)) next.push(child.message_id);
        if (byId.size >= limit) break;
      }
      if (byId.size >= limit) break;
    }
    frontier = next;
  }

  const messages = [...byId.values()]
    .sort((a, b) => a.created_at - b.created_at)
    .slice(0, limit)
    .map((row) => fromArchiveRow(row, channelName(ctx, row.channel_id)));

  const replies = messages.length - 1;

  return [
    `返信の連鎖 ${messages.length} 件 (起点への返信を含む${replies === 0 ? '。返信は付いていない' : ''})`,
    formatMessageLines(messages, {
      refs: ctx.refs,
      selfId: ctx.client?.user?.id,
      showChannel: true,
      bodyChars: agentConfig.messageChars
    }),
    '↩N は「N番に返信した」の意味。噛み合っていない箇所は返信が付いていないところ。'
  ].join('\n');
}

// ---------------------------------------------------------------- mode:count (集計)

// 説明文と検証で同じ配列を使う。片方だけ増やすと、モデルは存在しない軸を投げてくる。
const AGGREGATE_AXES = ['author', 'channel', 'year', 'month', 'day', 'hour', 'weekday', 'term'];

/**
 * 話題 (特徴語) の集計。
 *
 * 標本であることを必ず書く。ここに無い語を「言っていない」と読まれると、
 * ダブスタ判定のような用途で結論が逆になる。
 */
function formatTermAggregate(options: SearchOptions, summary: SearchSummary): string {
  // 件数があれば期間の両端はある。無ければ標本の期間指定は付けない (topTerms の既定と同じ)
  const { first_at: from, last_at: to } = summary;
  const result = topTerms(options, {
    range: from !== null && to !== null ? { from, to, total: summary.count } : null
  });

  if (result.rows.length === 0) {
    return [
      `${result.messages} 件を走査しましたが、特徴的な語は見つかりませんでした。`,
      '(発言が少ないか、サーバー全体と傾向が同じ)'
    ].join('');
  }

  const lines = [
    `合計 ${summary.count} 件 / 走査 ${result.messages} 件`
      + (result.mode === 'stratified' ? ' (期間全体から等間隔に抽出した標本)' : ''),
    `期間: ${shortTime(summary.first_at)} 〜 ${shortTime(summary.last_at)}`,
    `--- 話題 (サーバー全体 ${result.baseline.messages} 件との比較) ---`,
    result.rows.map((row) => `${row.term}: ${row.count}件 (全体比 ${row.ratio.toFixed(1)}倍)`).join('\n'),
    '件数はその語を含む発言数。頻度順ではなく「この条件で偏って多い語」順。',
    '実際の発言はこの語を query に入れて search で読むこと。'
  ];

  if (result.weakBaseline) {
    lines.push('(注記) 比較する母集団が小さいので、ほぼ単純な頻度順です。');
  }

  if (summary.count > result.messages) {
    lines.push('(注記) 全件ではなく標本です。ここに無い語を「言っていない」と結論しないこと。after: / before: で期間を絞ると精度が上がります。');
  }

  return lines.join('\n');
}

async function aggregateMessages(ctx: AgentContext, args: ToolArgs): Promise<string> {
  const options = await searchOptions(ctx, args, { sort: 'new' });

  // 未知の軸を黙って author にすり替えると、モデルは「頼んだ軸の集計を得た」と
  // 思い込んで別の数字を読む。間違ったデータを渡すより、言い直させるほうが安い。
  // 省略は許す (モデルは by をよく省くし、その場合の既定は自明)。
  const by = args.by === undefined || args.by === null || args.by === ''
    ? 'author'
    : String(args.by);

  if (!AGGREGATE_AXES.includes(by)) {
    return `by が不正です: ${by}。使えるのは ${AGGREGATE_AXES.join(' / ')} です。`;
  }

  const summary = searchSummary(options);
  if (!summary.count) return '該当するメッセージはありませんでした。';

  // term は SQL の GROUP BY ではなく本文のトークン化なので別処理
  if (by === 'term') return formatTermAggregate(options, summary);

  const rows = aggregateSearch(options, by, { limit: clampLimit(args.limit, by === 'month' ? 24 : 15, 50) });

  const label = (bucket: string | number | null): string => {
    if (by === 'author') return authorLabel(ctx, String(bucket));
    if (by === 'channel') return `#${channelName(ctx, String(bucket))}`;
    if (by === 'weekday') return `${WEEKDAY_LABELS[Number(bucket)] ?? String(bucket)}曜`;
    if (by === 'hour') return `${String(bucket).padStart(2, '0')}時`;
    return String(bucket);
  };

  // 効かない引数を黙って無視すると「並べ替えた結果」として読まれる
  const inert = ['sort', 'offset', 'source'].filter((key) => args[key] !== undefined && args[key] !== '');

  return [
    `合計 ${summary.count} 件 / ${summary.authors} 人 / ${summary.channels} チャンネル`
      + (inert.length > 0 ? ` (mode:count では ${inert.join(' / ')} は効かない)` : ''),
    `期間: ${shortTime(summary.first_at)} 〜 ${shortTime(summary.last_at)} ・ 平均 ${Math.round(summary.avg_length ?? 0)} 文字`,
    `--- ${by} 別 ---`,
    rows.map((row) => `${label(row.bucket)}: ${row.count}`).join('\n')
  ].join('\n');
}

// ---------------------------------------------------------------- 組み立て

/** 1つのツール。定義とハンドラを組にして持つ。 */
interface ToolEntry {
  definition: ToolDefinition;
  handler: (args: ToolArgs) => string | Promise<string>;
}

/** buildToolset の結果。runtime に渡す部分に加えて、プロンプトの出し分けに使う可用性を持つ。 */
export interface Toolset extends AgentToolset {
  archiveAvailable: boolean;
  browserAvailable: boolean;
  governanceAvailable: boolean;
  memoryAvailable: boolean;
  semanticAvailable: boolean;
}

/**
 * この実行で使えるツールだけを集める。
 */
export async function buildToolset(ctx: AgentContext): Promise<Toolset> {
  const archiveAvailable = Boolean(getGuildState(ctx.guild.id));
  // 記憶ができているサーバーだけ。根は system に、残りはこのツールでたどる
  const memoryAvailable = Boolean(hasMemory(ctx.guild.id));
  const browserAvailable = await cdpAvailable();
  const governanceAvailable = Boolean(governanceRecords.getGovernanceGuild(ctx.guild.id));

  // ベクトルがあるときだけ意味検索のモードを出す。無いギルドで定義ぶんを払わない。
  const semanticReady = archiveAvailable && await semanticAvailable(ctx.guild.id);

  if (semanticReady) {
    // モデルのロードに数秒かかるので、await せず先に温めておく。
    // モデルが「ツールを呼ぶ」と判断する往復の間に間に合う。
    prewarm();
  }

  const flags: SearchFlags = { archiveAvailable, semanticAvailable: semanticReady };

  // 定義とハンドラを1つのリストから作る。別々に持つと名前を1つ間違えただけで
  // 「そのツールはありません」がその会話の残り全部で返り、しかも気付けない。
  const entries: ToolEntry[] = [
    { definition: searchToolDefinition(flags), handler: (args) => runSearch(ctx, args, flags) },
    { definition: readDefinition(archiveAvailable), handler: (args) => runRead(ctx, args) },
    { definition: channelsDefinition, handler: (args) => listChannels(ctx, args) }
  ];
  if (governanceAvailable) {
    entries.push({ definition: governanceDefinition, handler: (args) => runGovernanceInfo(ctx, args) });
  }
  entries.push({ definition: infoDefinition, handler: (args) => runInfo(ctx, args) });
  if (memoryAvailable) {
    entries.push({
      definition: memoryToolDefinition,
      handler: async (args) => String(await runMemoryToolWithMeaning({ guildId: ctx.guild.id, refs: ctx.refs, channelScope: ctx.channelScope }, args))
    });
  }
  if (browserAvailable) {
    entries.push({ definition: browserToolDefinition(ctx.browserFull), handler: (args) => runBrowserAction(ctx, args) });
  }

  const definitions = entries.map((entry) => entry.definition);
  const coach = createCoach();
  // Map で引く。モデルが渡す名前を素のオブジェクトの添字にすると、
  // `constructor` や `toString` が Object.prototype の関数に当たってしまう。
  const handlers = new Map(entries.map((entry) => [entry.definition.function.name, entry.handler] as const));

  return {
    definitions,
    archiveAvailable,
    browserAvailable,
    governanceAvailable,
    memoryAvailable,
    semanticAvailable: semanticReady,

    async call(name: string, args: unknown): Promise<string> {
      // 結果に、同じ呼び出しの繰り返し・空振りの連続への助言を足す (coach.ts)
      const handler = handlers.get(name);
      if (!handler) return coach(name, args, `そのツールはありません: ${String(name).slice(0, MAX_NAME_CHARS)}`);

      try {
        return coach(name, args, String((await handler(isRecord(args) ? args : {})) ?? ''));
      } catch (error) {
        if (error instanceof QueryError) return coach(name, args, `クエリが不正です: ${error.message}`);
        console.error(`Agent tool ${name} failed:`, error);
        return coach(name, args, `ツールの実行に失敗しました: ${truncate(errorMessage(error), 200)}`);
      }
    }
  };
}
