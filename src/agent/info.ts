// 「素性」を引くツール。
//
// search / read はログの本文を返す道具で、「たこってどんな人？」「このサーバーいつから？」
// 「これ誰が押した？」には答えられない。データは全部どこかにあるのに、エージェントからは
// 届いていなかった (topReactionEmojis は /archivestats 専用、XP は src/db.js に置いたまま)。
//
// 定義は薄く、出力は厚く。
// ツール定義は毎ラウンド送り直すので、action ごとの説明はスキーマに書かない。
// 代わりに返り値の末尾へ次の一手を1行添えて、そこで使い方を教える
// (read が `(続きは at:… )` を書いているのと同じ)。

import { getTopXP } from '../db.js';
import { db as archiveDb, reactionUsers } from '../archive/db.js';
import { archive, type SearchOptions } from './boundary.js';
import { shortTime, truncate } from './format.js';
import { resolveMemberId } from './members.js';
import { numberField, stringField, type AgentContext, type ToolArgs, type ToolDefinition } from './types.js';

type InfoContext = Pick<AgentContext, 'guild' | 'refs' | 'channelScope'>;

const ACTIONS = ['member', 'guild', 'emoji', 'activity', 'reactions'];

/** getTopXP の行。src/db.js の SQL が返す形。 */
function xpRow(value: unknown): { id: string; xp: number } | null {
  const id = stringField(value, 'id');
  const xp = numberField(value, 'xp');
  return id !== undefined && xp !== undefined ? { id, xp } : null;
}

/** reactionUsers の行。 */
function reactionUserRow(value: unknown): { emoji: string; user_id: string } | null {
  const emoji = stringField(value, 'emoji');
  const userId = stringField(value, 'user_id');
  return emoji !== undefined && userId !== undefined ? { emoji, user_id: userId } : null;
}

const present = <T>(value: T | null): value is T => value !== null;

export const infoDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'info',
    description:
      '人・サーバー・絵文字・活動量・リアクションの「素性」を引く。'
      + '発言の中身ではなく、誰がどんな人か / いつからあるか / 誰が押したか を知りたいときに使う。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
        who: { type: 'string', description: 'member の対象 (表示名か ID)' },
        at: { type: 'string', description: 'reactions の対象 (参照番号かメッセージ ID)' },
        period: { type: 'string', description: 'activity / emoji の期間 (7d / 30d / all)' }
      },
      required: ['action']
    }
  }
};

function periodMs(value: unknown): number | null {
  const text = String(value ?? '').trim().toLowerCase();
  const match = /^(\d+)\s*d$/.exec(text);
  if (match) return Number(match[1]) * 86_400_000;
  if (text === 'all' || text === '') return null;
  if (text === 'week') return 7 * 86_400_000;
  if (text === 'month') return 30 * 86_400_000;
  return null;
}

// ---------------------------------------------------------------- member

async function memberInfo(ctx: InfoContext, args: ToolArgs): Promise<string> {
  const who = String(args.who ?? '').trim();
  if (!who) return 'who に人を指定してください (表示名かユーザー ID)。';

  const id = await resolveMemberId(ctx, who);
  if (!id) return `"${who}" という人が見つかりませんでした。表示名を確認するか、ユーザー ID を指定してください。`;

  const member = ctx.guild.members.cache.get(id)
    ?? await ctx.guild.members.fetch(id).catch(() => null);

  const lines: string[] = [];

  if (member) {
    const roles = [...member.roles.cache.values()]
      .filter((role) => role.name !== '@everyone')
      .sort((a, b) => b.position - a.position)
      .slice(0, 8)
      .map((role) => role.name);

    lines.push(
      `${member.displayName} (${member.user?.username ?? '?'} / ID ${id})`
      + `${member.user?.bot ? ' ・bot' : ''}`
    );
    if (member.joinedTimestamp) lines.push(`参加: ${shortTime(member.joinedTimestamp)}`);
    if (roles.length > 0) lines.push(`ロール: ${roles.join(' ')}`);
  } else {
    // 退出済みでもアーカイブには残っている。「居ない」で終わらせない。
    lines.push(`ID ${id} ・いまはこのサーバーに居ない (退出済みか、取得できなかった)`);
  }

  // 発言の履歴はアーカイブから。取り込み前なら素性だけ返す。
  const options: SearchOptions = {
    guildId: ctx.guild.id,
    query: '',
    extra: [{ key: 'from', value: id }],
    channelScope: ctx.channelScope,
    allowDeleted: false,
    sort: 'new'
  };

  let summary = null;
  try {
    summary = archive.searchSummary(options);
  } catch {
    // アーカイブが無い構成でも動く
  }

  if (!summary?.count) {
    lines.push('取り込み済みのログにこの人の発言はありません (未取り込みか、読めるチャンネルには書いていない)。');
    return lines.join('\n');
  }

  lines.push(
    `発言 ${summary.count} 件 (${shortTime(summary.first_at)} 〜 ${shortTime(summary.last_at)})`
    + ` ・ 平均 ${Math.round(summary.avg_length ?? 0)} 文字 ・ ${summary.channels} チャンネル`
  );

  const channels = archive.aggregateSearch(options, 'channel', { limit: 3 });
  if (channels.length > 0) {
    const label = channels
      .map((row) => `#${channelLabel(ctx, String(row.bucket))}(${row.count})`)
      .join(' ');
    lines.push(`よく居る: ${label}`);
  }

  const partners = replyPartners(ctx, id);
  if (partners.length > 0) {
    lines.push(`よく返信する相手: ${partners.map((row) => `${row.name}(${row.count})`).join(' ')}`);
  }

  const hours = archive.aggregateSearch(options, 'hour', { limit: 3 });
  if (hours.length > 0) {
    lines.push(`よく喋る時間: ${hours.map((row) => `${String(row.bucket).padStart(2, '0')}時`).join(' ')}`);
  }

  lines.push('発言そのものを見るなら search の author にこの ID を渡す。');
  return lines.join('\n');
}

function channelLabel(ctx: InfoContext, channelId: string): string {
  const cached = ctx.guild.channels.cache.get(channelId);
  if (cached?.name) return cached.name;

  try {
    const row = archiveDb.prepare<[string, string], { name: string | null }>(
      'SELECT name FROM channels WHERE guild_id = ? AND channel_id = ?'
    ).get(ctx.guild.id, channelId);
    if (row?.name) return row.name;
  } catch {
    // アーカイブが無い構成でも動く
  }

  return channelId;
}

/**
 * よく返信している相手。
 *
 * 「誰と話しているか」はチャンネルでは分からない (同じチャンネルに全員居る)。
 * reply_to を辿って初めて相手が出る。idx_msg_reply があるのでこの向きで引ける。
 */
function replyPartners(ctx: InfoContext, userId: string): { id: string; name: string | null; count: number }[] {
  try {
    const visible = archive.buildSearch({ guildId: ctx.guild.id, channelScope: ctx.channelScope });
    const rows = archiveDb.prepare<(string | number)[], { id: string; name: string | null; count: number }>(`
      WITH visible AS (SELECT m.* FROM messages m WHERE ${visible.where})
      SELECT p.author_id AS id, p.author_name AS name, COUNT(*) AS count
      FROM visible m
      JOIN visible p ON p.message_id = m.reply_to
      WHERE m.guild_id = ? AND m.author_id = ? AND m.deleted = 0 AND p.author_id != ?
      GROUP BY p.author_id
      ORDER BY count DESC
      LIMIT 5
    `).all(...visible.params, ctx.guild.id, userId, userId);

    return rows.filter((row) => row.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- guild

/**
 * 取り込み済みの量。数えるのは呼んだ人に見えるチャンネルだけ。
 *
 * 以前はサーバー全体を数えていたので、件数・チャンネル数・最終発言の日時から
 * 見えないチャンネルがあること・いつ動いていたかが分かってしまっていた。
 */
function visibleArchiveStats(ctx: InfoContext): { total: number; firstAt: number | null; lastAt: number | null; channels: number; threads: number } {
  const channels = archiveDb.prepare<[string], { channel_id: string; is_thread: number | null }>(
    'SELECT channel_id, is_thread FROM channels WHERE guild_id = ?'
  ).all(ctx.guild.id).filter((row) => archive.isChannelAllowed(row.channel_id, ctx.channelScope));

  const visible = archive.buildSearch({ guildId: ctx.guild.id, channelScope: ctx.channelScope });
  const range = archiveDb.prepare<(string | number)[], { first_at: number | null; last_at: number | null; total: number }>(
    `SELECT MIN(m.created_at) AS first_at, MAX(m.created_at) AS last_at, COUNT(*) AS total FROM messages m WHERE ${visible.where}`
  ).get(...visible.params);

  return {
    total: range?.total ?? 0,
    firstAt: range?.first_at ?? null,
    lastAt: range?.last_at ?? null,
    channels: channels.length,
    threads: channels.filter((row) => row.is_thread).length
  };
}

async function guildInfo(ctx: InfoContext): Promise<string> {
  const guild = ctx.guild;
  const lines = [
    `${guild.name} (ID ${guild.id})`,
    `作成: ${shortTime(guild.createdTimestamp)} ・ メンバー ${guild.memberCount ?? '?'} 人`
  ];

  try {
    const stats = visibleArchiveStats(ctx);

    if (stats.total > 0) {
      lines.push(
        `取り込み済み: ${stats.total} 件 (${shortTime(stats.firstAt)} 〜 ${shortTime(stats.lastAt)})`
        + ` ・ ${stats.channels} チャンネル (うちスレッド ${stats.threads})`
      );
    } else {
      lines.push('取り込み済みのログはありません (管理者が `/index build` を実行するまで過去ログは引けない)。');
    }
  } catch {
    lines.push('ローカルの取り込みは無効です。');
  }

  try {
    const { modelId } = await archive.resolveModel();
    const coverage = archive.chunkCoverage(guild.id, modelId);
    if (coverage.done > 0) {
      lines.push(`意味検索: 会話の ${Math.round(coverage.ratio * 100)}% が埋め込み済み`);
    }
  } catch {
    // 意味検索が無い構成でも動く
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------- emoji

/**
 * よく押されている絵文字。呼んだ人に見えるチャンネルの発言についたぶんだけ数える。
 *
 * archive/search.js の topReactionEmojis はサーバー全体を数えるので、見えない
 * チャンネルで使われている絵文字まで出ていた。絞り方は search と同じ buildSearch。
 */
function visibleReactionEmojis(ctx: InfoContext, { limit, since }: { limit: number; since: number | null }): { emoji: string; count: number }[] {
  const visible = archive.buildSearch({ guildId: ctx.guild.id, channelScope: ctx.channelScope });
  const params: (string | number)[] = [...visible.params, ...(since ? [since] : []), limit];

  return archiveDb.prepare<(string | number)[], { emoji: string; count: number }>(`
    SELECT mr.emoji AS emoji, SUM(mr.count) AS count
    FROM message_reactions mr
    JOIN messages m ON m.message_id = mr.message_id
    WHERE ${visible.where}${since ? ' AND m.created_at >= ?' : ''}
    GROUP BY mr.emoji
    ORDER BY count DESC
    LIMIT ?
  `).all(...params);
}

function emojiInfo(ctx: InfoContext, args: ToolArgs): string {
  const span = periodMs(args.period);
  const since = span ? Date.now() - span : null;

  let rows: { emoji: string; count: number }[] = [];
  try {
    rows = visibleReactionEmojis(ctx, { limit: 12, since });
  } catch {
    return '絵文字の集計はローカルの取り込みが要る。管理者が `/index build` を実行するまでは使えません。';
  }

  if (rows.length === 0) return 'リアクションの記録がありません。';

  return [
    `よく押されている絵文字${since && span ? ` (直近${Math.round(span / 86_400_000)}日)` : ' (全期間)'}`,
    rows.map((row) => `${row.emoji} ${row.count}`).join(' ・ '),
    '特定の絵文字が付いた発言を探すなら search の query に `reaction:👍`。'
  ].join('\n');
}

// ---------------------------------------------------------------- activity

const XP_PERIODS = { day: '直近24時間', week: '直近7日', month: '直近30日', all: '全期間' };
type XpPeriod = keyof typeof XP_PERIODS;

const isXpPeriod = (value: string): value is XpPeriod => Object.hasOwn(XP_PERIODS, value);

function activityInfo(ctx: InfoContext, args: ToolArgs): string {
  const text = String(args.period ?? '').trim().toLowerCase();
  // getTopXP は day / week / month / all しか受けない
  const period: XpPeriod = isXpPeriod(text) ? text : 'month';

  const render = (rows: unknown[]): string => {
    const valid = rows.map(xpRow).filter(present);
    return valid.length === 0
      ? '該当なし'
      : valid.map((row, index) => `${index + 1}. ${memberLabel(ctx, row.id)} ${row.xp}`).join(' / ');
  };

  const label = XP_PERIODS[period];

  return [
    `活動量 (${label}) ・ XP は発言と通話から付く目安で、発言数そのものではない`,
    `テキスト: ${render(getTopXP(ctx.guild.id, 'text', period, 5))}`,
    `通話: ${render(getTopXP(ctx.guild.id, 'voice', period, 5))}`,
    '発言数そのものを数えるなら search の mode:count by:author。'
  ].join('\n');
}

function memberLabel(ctx: InfoContext, userId: string): string {
  const cached = ctx.guild.members.cache.get(userId);
  if (cached?.displayName) return cached.displayName;

  try {
    const row = archiveDb.prepare<[string, string], { author_name: string | null }>(`
      SELECT author_name FROM messages
      WHERE guild_id = ? AND author_id = ? AND author_name != ''
      ORDER BY created_at DESC LIMIT 1
    `).get(ctx.guild.id, userId);
    if (row?.author_name) return row.author_name;
  } catch {
    // アーカイブが無い構成でも動く
  }

  return `user:${userId}`;
}

// ---------------------------------------------------------------- reactions

function reactionsInfo(ctx: InfoContext, args: ToolArgs): string {
  const entry = ctx.refs.resolve(args.at);
  if (!entry?.messageId) {
    return 'at に参照番号かメッセージ ID を渡してください (検索してから番号を渡す)。';
  }

  const location = locate(ctx, entry.messageId);
  if (!location || !archive.isChannelAllowed(location, ctx.channelScope)) {
    return 'その発言はこのサーバーに無いか、閲覧権限がありません。';
  }
  let counts: { emoji: string; count: number }[] = [];
  try {
    counts = archiveDb
      .prepare<[string], { emoji: string; count: number }>('SELECT emoji, count FROM message_reactions WHERE message_id = ? ORDER BY count DESC')
      .all(entry.messageId);
  } catch {
    return 'リアクションの記録はローカルの取り込みが要る。管理者が `/index build` を実行するまでは使えません。';
  }

  if (counts.length === 0) return 'その発言にリアクションは付いていません (取り込み済みの範囲では)。';

  const users = reactionUsers(entry.messageId).map(reactionUserRow).filter(present);
  const byEmoji = new Map<string, string[]>();
  for (const row of users) {
    const names = byEmoji.get(row.emoji) ?? [];
    names.push(memberLabel(ctx, row.user_id));
    byEmoji.set(row.emoji, names);
  }

  const lines = counts.map((row) => {
    const names = byEmoji.get(row.emoji);
    return names?.length
      ? `${row.emoji} ${row.count} — ${truncate(names.join(' '), 200)}`
      : `${row.emoji} ${row.count} — 誰が押したかは記録なし`;
  });

  // 記録が無いことを「誰も押していない」と読まれるのが一番高い誤り。必ず書く。
  if (byEmoji.size < counts.length) {
    lines.push('(押した人の記録はこの機能を入れた後に動いたリアクションのぶんだけ。古い発言では数しか残っていない)');
  }

  return lines.join('\n');
}

function locate(ctx: InfoContext, messageId: string): string | null {
  try {
    return archiveDb
      .prepare<[string, string], { channel_id: string }>('SELECT channel_id FROM messages WHERE guild_id = ? AND message_id = ? AND deleted = 0')
      .get(ctx.guild.id, String(messageId))?.channel_id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 入口

export async function runInfo(ctx: InfoContext, args: ToolArgs = {}): Promise<string> {
  const action = String(args.action ?? '').trim().toLowerCase();

  switch (action) {
    case 'member': return memberInfo(ctx, args);
    case 'guild': return guildInfo(ctx);
    case 'emoji': return emojiInfo(ctx, args);
    case 'activity': return activityInfo(ctx, args);
    case 'reactions': return reactionsInfo(ctx, args);
    default:
      return `action が不正です: ${String(args.action)}。使えるのは ${ACTIONS.join(' / ')} です。`;
  }
}
