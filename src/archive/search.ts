import { resolve } from 'node:path';
import { db } from './db.js';
import { errorMessage, isRecord } from './guards.js';
import {
  QueryError,
  TZ_OFFSET_HOURS,
  collectTerms,
  parseComparison,
  parseDateRange,
  parseHourRange,
  parseQuery,
  parseSnowflake,
  parseWeekdays
} from './query.js';
import {
  REGEX_MAX_PATTERN_LENGTH,
  RegexBudgetExceeded,
  RegexTimedOut,
  RegexUnavailable,
  compileRegex,
  regexRefusal,
  runRegexStatements,
  type RegexStatement
} from './regex.js';
import type {
  AggregateRow,
  ChannelScope,
  CountRow,
  MessageRow,
  QueryNode,
  SearchOptions,
  SqlParam
} from './types.js';

const TZ_OFFSET_SECONDS = TZ_OFFSET_HOURS * 3600;
const LOCAL_EPOCH = `m.created_at / 1000 + ${TZ_OFFSET_SECONDS}`;

// trigram インデックスは3文字以上でしか引けない。
// 1〜2文字の語は LIKE にフォールバックする (遅いが、日本語では避けられない)。
const MIN_FTS_LENGTH = 3;

const REGEX_SCAN_BUDGET = Number(process.env.ARCHIVE_REGEX_BUDGET ?? 300_000);

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// 正規表現の照合はワーカーで行い、これを過ぎたら打ち切る (regex.ts)。
// メインスレッドが1回に待つのはこの時間まで。
const REGEX_TIMEOUT_MS = positiveEnv('ARCHIVE_REGEX_TIMEOUT_MS', 2000);
// サーバーごとの持ち時間。REGEX_WINDOW_MS の間に正規表現の照合で待ってよい合計。
// 1回あたりは短くても、重いパターンを連打されたり (/searchstats は1回で3本流す)
// すると待ち時間が積み上がって bot が止まり続けるため。時間切れになったら使い切り扱い。
const REGEX_WINDOW_MS = positiveEnv('ARCHIVE_REGEX_WINDOW_MS', 15_000);
const REGEX_WINDOW_BUDGET_MS = positiveEnv('ARCHIVE_REGEX_WINDOW_BUDGET_MS', 4000);

interface RegexUsage {
  since: number;
  spent: number;
}

const regexUsage = new Map<string, RegexUsage>();

// ワーカーは同じファイルを読み取り専用で開き直す
const ARCHIVE_PATH = db.memory ? ':memory:' : resolve(db.name);

export type SortKey = 'new' | 'old' | 'reactions' | 'long' | 'random';

// rowid のタイブレークを付ける理由: created_at だけだと同一ミリ秒の行の順序が
// 不定になり、ページ送りのたびに並びが変わって重複と欠落が出る。
// idx_msg_guild_time は末尾に rowid を含むので、これを足しても索引で並べられる。
export const SORT_MODES: Readonly<Record<SortKey, string>> = {
  new: 'm.created_at DESC, m.rowid DESC',
  old: 'm.created_at ASC, m.rowid ASC',
  reactions: 'm.reaction_count DESC, m.created_at DESC, m.rowid DESC',
  long: 'm.char_count DESC, m.created_at DESC, m.rowid DESC',
  random: 'RANDOM()'
};

// 利用者の sort: をそのまま添字にしない (constructor などで SQL が壊れる)
function isSortKey(value: string): value is SortKey {
  return Object.hasOwn(SORT_MODES, value);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function ftsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

class Compiler {
  readonly guildId: string;
  readonly params: SqlParam[] = [];
  includesDeleted = false;
  usesRegex = false;

  constructor(guildId: string) {
    this.guildId = guildId;
  }

  push(value: SqlParam): string {
    this.params.push(value);
    return '?';
  }

  compile(node: QueryNode | null): string {
    if (!node) return '1';

    switch (node.type) {
      case 'and':
        return `(${node.nodes.map((child) => this.compile(child)).join(' AND ')})`;
      case 'or':
        return `(${node.nodes.map((child) => this.compile(child)).join(' OR ')})`;
      case 'not':
        return `(NOT ${this.compile(node.node)})`;
      case 'term':
        return this.compileTerm(node.value);
      case 'filter':
        return this.compileFilter(node.key, node.value);
      default:
        throw new QueryError('内部エラー: 不明なノードです。');
    }
  }

  compileTerm(value: string): string {
    if (!value) return '1';

    if (Array.from(value).length >= MIN_FTS_LENGTH) {
      return `m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${this.push(ftsPhrase(value))})`;
    }

    const pattern = `%${escapeLike(value)}%`;
    return `(m.content LIKE ${this.push(pattern)} ESCAPE '\\' OR m.extra LIKE ${this.push(pattern)} ESCAPE '\\')`;
  }

  compileFilter(key: string, rawValue: string): string {
    const value = rawValue.trim();

    switch (key) {
      case 'from':
      case 'author':
        return this.compileUser('m.author_id', value, 'm.author_name');

      case 'in':
      case 'channel':
        return this.compileChannel(value);

      case 'mentions':
      case 'mention': {
        const id = parseSnowflake(value);
        if (!id) throw new QueryError('mentions: にはユーザーの ID かメンションを指定してください。');
        return `EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.message_id AND mm.user_id = ${this.push(id)})`;
      }

      case 'replyto': {
        const id = parseSnowflake(value);
        if (!id) throw new QueryError('replyto: にはユーザーの ID かメンションを指定してください。');
        return `EXISTS (SELECT 1 FROM messages p WHERE p.message_id = m.reply_to AND p.author_id = ${this.push(id)})`;
      }

      case 'has':
        return this.compileHas(value.toLowerCase());

      case 'is':
        return this.compileIs(value.toLowerCase());

      case 'tag':
        return this.compileTag(value);

      case 'before': {
        // before:2024-05-01 はその日を含まない / before:7d は「7日より前」
        const { start } = parseDateRange(value);
        return `m.created_at < ${this.push(start)}`;
      }

      case 'after': {
        // after:2024-05-01 はその日を含む / after:2020 は 2020-01-01 以降 / after:7d は「直近7日」
        //
        // 以前は絶対日付のとき end を下限にしていた。すると after:2020 が
        // 「2021-01-01 以降」になり、after:2020 before:2021 が必ず0件になる
        // (after:today も常に0件)。古い発言を探そうとした側からは
        // 「昔のメッセージが無い」ように見えるので、含む側にそろえた。
        const { start } = parseDateRange(value);
        return `m.created_at >= ${this.push(start)}`;
      }

      case 'during':
      case 'on': {
        const { start, end } = parseDateRange(value);
        return `(m.created_at >= ${this.push(start)} AND m.created_at < ${this.push(end)})`;
      }

      case 'reactions': {
        const { operator, value: number } = parseComparison(value);
        return `m.reaction_count ${operator} ${this.push(number)}`;
      }

      case 'reaction':
        return this.compileReaction(value);

      case 'len':
      case 'length': {
        const { operator, value: number } = parseComparison(value);
        return `m.char_count ${operator} ${this.push(number)}`;
      }

      case 'hour': {
        const { from, to } = parseHourRange(value);
        const expression = `CAST(strftime('%H', ${LOCAL_EPOCH}, 'unixepoch') AS INTEGER)`;
        return from <= to
          ? `(${expression} BETWEEN ${this.push(from)} AND ${this.push(to)})`
          : `(${expression} >= ${this.push(from)} OR ${expression} <= ${this.push(to)})`;
      }

      case 'weekday':
      case 'day': {
        const days = parseWeekdays(value);
        const placeholders = days.map((day) => this.push(day)).join(', ');
        return `CAST(strftime('%w', ${LOCAL_EPOCH}, 'unixepoch') AS INTEGER) IN (${placeholders})`;
      }

      case 'domain': {
        const domain = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
        if (!domain) throw new QueryError('domain: にはドメイン名を指定してください。');
        return `EXISTS (
          SELECT 1 FROM message_links ml
          WHERE ml.message_id = m.message_id
            AND (ml.domain = ${this.push(domain)} OR ml.domain LIKE ${this.push(`%.${escapeLike(domain)}`)} ESCAPE '\\')
        )`;
      }

      case 'regex':
      case 're': {
        // /.../ で囲まれているときだけ trim する。regex:"foo " のような裸のパターンでは
        // 末尾の空白に意味があるので、共通の trim を通してはいけない。
        // なお regexp() は m.content だけを見る (m.extra は見ない)。
        // extra まで広げると regexp の評価回数が倍になり、共有の走査上限を食い潰す。
        const pattern = /^\s*\/.*\/[a-z]*\s*$/s.test(rawValue) ? rawValue.trim() : rawValue;
        if (!pattern.trim()) throw new QueryError('regex: にはパターンを指定してください。');
        // 長すぎるパターンはコンパイルもしない
        if (pattern.length > REGEX_MAX_PATTERN_LENGTH) {
          throw new QueryError(`正規表現が長すぎます (最大 ${REGEX_MAX_PATTERN_LENGTH} 文字)。`);
        }
        try {
          compileRegex(pattern);
        } catch (error) {
          throw new QueryError(`正規表現が不正です: ${errorMessage(error)}`);
        }
        // 長い発言1件で止まる形 ((a+)+ など) と長すぎるパターンはここで断る (regex.ts)
        const refusal = regexRefusal(pattern);
        if (refusal) throw new QueryError(refusal);
        this.usesRegex = true;
        return `regexp(${this.push(pattern)}, m.content)`;
      }

      default:
        throw new QueryError(`不明なフィルタです: \`${key}:\``);
    }
  }

  compileUser(column: string, value: string, nameColumn: string): string {
    const id = parseSnowflake(value);
    if (id) return `${column} = ${this.push(id)}`;

    const name = value.replace(/^@/, '');
    if (!name) throw new QueryError('from: にはユーザーを指定してください。');
    return `${nameColumn} LIKE ${this.push(`%${escapeLike(name)}%`)} ESCAPE '\\'`;
  }

  // <:name:id> / :name: / 素の絵文字 のどれで書かれても引けるようにする
  compileReaction(value: string): string {
    const raw = value.trim();
    if (!raw) throw new QueryError('reaction: には絵文字を指定してください。');

    const exists = (condition: string): string => `EXISTS (
      SELECT 1 FROM message_reactions mr WHERE mr.message_id = m.message_id AND ${condition}
    )`;

    const custom = /^<a?:([^:]+):(\d+)>$/.exec(raw);
    if (custom?.[1] && custom[2]) {
      return exists(`mr.emoji LIKE ${this.push(`%:${escapeLike(custom[1])}:${custom[2]}>`)} ESCAPE '\\'`);
    }

    const named = /^:([^:]+):$/.exec(raw);
    if (named?.[1]) {
      return exists(`mr.emoji LIKE ${this.push(`%:${escapeLike(named[1])}:%`)} ESCAPE '\\'`);
    }

    return exists(`mr.emoji = ${this.push(raw)}`);
  }

  compileChannel(value: string): string {
    const id = parseSnowflake(value);
    if (id) {
      // スレッドは親チャンネルの一部として扱う
      return `(m.channel_id = ${this.push(id)} OR m.parent_id = ${this.push(id)})`;
    }

    const name = value.replace(/^#/, '');
    if (!name) throw new QueryError('in: にはチャンネルを指定してください。');

    const pattern = `%${escapeLike(name)}%`;
    return `(
      m.channel_id IN (SELECT channel_id FROM channels WHERE guild_id = ${this.push(this.guildId)} AND name LIKE ${this.push(pattern)} ESCAPE '\\')
      OR m.parent_id IN (SELECT channel_id FROM channels WHERE guild_id = ${this.push(this.guildId)} AND name LIKE ${this.push(pattern)} ESCAPE '\\')
    )`;
  }

  compileHas(value: string): string {
    switch (value) {
      case 'link':
      case 'url':
        return 'm.link_count > 0';
      case 'image':
        return "m.attachment_kinds LIKE '% image %'";
      case 'video':
        return "m.attachment_kinds LIKE '% video %'";
      case 'audio':
      case 'sound':
        return "m.attachment_kinds LIKE '% audio %'";
      case 'file':
      case 'attachment':
        return 'm.attachment_count > 0';
      case 'embed':
        return 'm.embed_count > 0';
      case 'sticker':
        return 'm.sticker_count > 0';
      case 'reaction':
        return 'm.reaction_count > 0';
      case 'reply':
        return 'm.reply_to IS NOT NULL';
      case 'code':
        return "m.content LIKE '%```%'";
      case 'mention':
        return 'EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.message_id)';
      default:
        throw new QueryError(`has: に指定できない値です: \`${value}\` (link/image/video/audio/file/embed/sticker/reaction/reply/code/mention)`);
    }
  }

  compileIs(value: string): string {
    switch (value) {
      case 'bot':
        return 'm.is_bot = 1';
      case 'human':
        return 'm.is_bot = 0';
      case 'edited':
        return 'm.edited_at IS NOT NULL';
      case 'pinned':
        return 'm.pinned = 1';
      case 'reply':
        return 'm.reply_to IS NOT NULL';
      case 'thread':
        return 'm.parent_id IS NOT NULL';
      case 'deleted':
        this.includesDeleted = true;
        return 'm.deleted = 1';
      // 「誰も答えていない投稿」。人間が投稿者しか喋っていないスレッドを指す。
      // 発言ではなくスレッドの性質なので相関副問い合わせになるが、
      // idx_msg_channel_time があるので候補1件あたり範囲スキャン1本で済む。
      case 'unanswered':
        return `(
          m.parent_id IS NOT NULL AND (
            SELECT COUNT(DISTINCT x.author_id) FROM messages x
            WHERE x.channel_id = m.channel_id AND x.deleted = 0 AND x.is_bot = 0
          ) <= 1
        )`;
      default:
        throw new QueryError(
          `is: に指定できない値です: \`${value}\` (bot/human/edited/pinned/reply/thread/unanswered/deleted)`
        );
    }
  }

  /**
   * フォーラムのタグ。channels.applied_tags に ` 名前 名前 ` で入っている。
   *
   * 取り込み前の行はタグが空なので、当たらないこと自体が「タグが無い」とは限らない。
   * それを読み違えないための注記は呼び出し側 (tools.js) が出す。
   */
  compileTag(value: string): string {
    const name = String(value).replace(/^#/, '').toLowerCase().replace(/\s+/g, '_');
    if (!name) throw new QueryError('tag: にはタグ名を指定してください。');

    return `m.channel_id IN (
      SELECT channel_id FROM channels
      WHERE guild_id = ${this.push(this.guildId)}
        AND applied_tags LIKE ${this.push(`% ${escapeLike(name)} %`)} ESCAPE '\\'
    )`;
  }
}

export interface BuiltSearch {
  where: string;
  params: SqlParam[];
  orderBy: string;
  sortKey: SortKey;
  terms: string[];
  usesRegex: boolean;
}

/**
 * クエリ文字列と追加条件から SQL の WHERE 句を組み立てる。
 */
export function buildSearch({ guildId, query = '', extra = [], channelScope, allowDeleted = false, sort = 'new' }: SearchOptions): BuiltSearch {
  const { ast, directives } = parseQuery(query);
  const compiler = new Compiler(guildId);

  const clauses = ['m.guild_id = ?'];
  const params: SqlParam[] = [guildId];

  if (ast) {
    const sql = compiler.compile(ast);
    clauses.push(sql);
    params.push(...compiler.params);
  }

  for (const condition of extra) {
    const sub = new Compiler(guildId);
    const sql = sub.compileFilter(condition.key, condition.value);
    clauses.push(sql);
    params.push(...sub.params);
    if (sub.usesRegex) compiler.usesRegex = true;
    if (sub.includesDeleted) compiler.includesDeleted = true;
  }

  if (compiler.includesDeleted && !allowDeleted) {
    throw new QueryError('`is:deleted` を使うには「メッセージの管理」権限が必要です。');
  }

  if (!compiler.includesDeleted) {
    clauses.push('m.deleted = 0');
  }

  if (channelScope) {
    if (channelScope.mode === 'none') {
      clauses.push('0');
    } else if (channelScope.ids.length > 0) {
      const placeholders = channelScope.ids.map(() => '?').join(', ');
      clauses.push(`m.channel_id ${channelScope.mode === 'exclude' ? 'NOT IN' : 'IN'} (${placeholders})`);
      params.push(...channelScope.ids);
    }
  }

  const requested = directives.sort ?? sort;
  const sortKey: SortKey = isSortKey(requested) ? requested : 'new';

  return {
    where: clauses.join(' AND '),
    params,
    orderBy: SORT_MODES[sortKey],
    sortKey,
    terms: collectTerms(ast),
    usesRegex: compiler.usesRegex
  };
}

// ---------------------------------------------------------------- 実行

/**
 * SQL を流す先。regex: を含む検索はワーカー (regex.ts) に、それ以外はメインの接続に流す。
 * 行の型はメインの prepare<引数, 行>() と同じく呼び出し側が SQL に合わせて決める。
 */
export interface SqlExecutor {
  all<Row extends object>(sql: string, params: readonly SqlParam[]): Row[];
  get<Row extends object>(sql: string, params: readonly SqlParam[]): Row | undefined;
  allMany<Row extends object>(statements: readonly { sql: string; params: readonly SqlParam[] }[]): Row[][];
}

const mainExecutor: SqlExecutor = {
  all: <Row extends object>(sql: string, params: readonly SqlParam[]): Row[] => db.prepare<SqlParam[], Row>(sql).all(...params),
  get: <Row extends object>(sql: string, params: readonly SqlParam[]): Row | undefined => db.prepare<SqlParam[], Row>(sql).get(...params),
  allMany: <Row extends object>(statements: readonly { sql: string; params: readonly SqlParam[] }[]): Row[][] => statements
    .map(({ sql, params }) => db.prepare<SqlParam[], Row>(sql).all(...params))
};

/** ワーカーが返した行。SQLite の行を構造化複製しただけのものか確かめる。 */
function workerRows<Row extends object>(value: unknown): Row[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error('regex worker returned malformed rows');
  // 確かめたのは「行の配列」まで。列の型はメインの prepare<, Row>() と同じく SQL が決める
  return value as Row[];
}

function workerExecutor(deadline: number): SqlExecutor {
  let budget = REGEX_SCAN_BUDGET;

  const run = (statements: readonly RegexStatement[]): unknown[] => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new RegexTimedOut('regex search deadline passed');
    const { results, evaluated } = runRegexStatements(statements, { path: ARCHIVE_PATH, timeoutMs, budget });
    // 走査の上限は1回の検索 (withRegexGuard の1回) 全体で共有する
    budget = Math.max(0, budget - evaluated);
    if (results.length !== statements.length) throw new Error('regex worker returned a partial result');
    return results;
  };

  return {
    all: <Row extends object>(sql: string, params: readonly SqlParam[]): Row[] => workerRows<Row>(run([{ sql, params, mode: 'all' }])[0]),
    get: <Row extends object>(sql: string, params: readonly SqlParam[]): Row | undefined => {
      const [row] = run([{ sql, params, mode: 'get' }]);
      return row === null || row === undefined ? undefined : workerRows<Row>([row])[0];
    },
    allMany: <Row extends object>(statements: readonly { sql: string; params: readonly SqlParam[] }[]): Row[][] => run(
      statements.map(({ sql, params }) => ({ sql, params, mode: 'all' }))
    ).map((rows) => workerRows<Row>(rows))
  };
}

/** そのサーバーの持ち時間の記録。窓を過ぎていれば新しく始める。 */
function usageFor(guildId: string, now: number): RegexUsage {
  const current = regexUsage.get(guildId);
  if (current && now - current.since < REGEX_WINDOW_MS) return current;
  const fresh = { since: now, spent: 0 };
  regexUsage.set(guildId, fresh);
  return fresh;
}

// vectors.js の走査も buildSearch 由来の SQL を使うので、regex: が混ざったときに
// 走査上限と時間切れを素通りしないよう共有する。予算の実装を二重に持たない。
//
// run には SQL の流し先 (SqlExecutor) が渡る。regex: を含む検索の SQL は必ずこれで流すこと
// (メインの接続の regexp() は評価を断る)。guildId ごとに待ってよい時間を数える。
export function withRegexGuard<T>(usesRegex: boolean, run: (exec: SqlExecutor) => T, guildId = ''): T {
  if (!usesRegex) return run(mainExecutor);

  const started = Date.now();
  const usage = usageFor(guildId, started);
  const left = REGEX_WINDOW_BUDGET_MS - usage.spent;
  if (left <= 0) {
    const wait = Math.max(1, Math.ceil((usage.since + REGEX_WINDOW_MS - started) / 1000));
    throw new QueryError(`正規表現の検索が続いたため一時的に止めています。${wait} 秒ほど待ってから試してください。`);
  }

  const timeoutMs = Math.min(REGEX_TIMEOUT_MS, left);
  try {
    return run(workerExecutor(started + timeoutMs));
  } catch (error) {
    if (error instanceof RegexBudgetExceeded || errorMessage(error).includes('regex scan budget exceeded')) {
      throw new QueryError(
        `正規表現の走査量が上限 (${REGEX_SCAN_BUDGET.toLocaleString()}件) を超えました。from: / in: / after: などで範囲を絞ってください。`
      );
    }
    if (error instanceof RegexTimedOut) {
      // 時間切れを出したサーバーは、窓が明けるまで正規表現を受け付けない
      usage.spent = REGEX_WINDOW_BUDGET_MS;
      throw new QueryError(
        `正規表現の照合が ${(timeoutMs / 1000).toLocaleString()} 秒で終わらなかったので打ち切りました。`
        + 'from: / in: / after: などで範囲を絞るか、パターンを単純にしてください。'
      );
    }
    if (error instanceof RegexUnavailable) {
      throw new QueryError('この構成 (メモリ上のアーカイブ) では正規表現検索を使えません。');
    }
    throw error;
  } finally {
    usage.spent += Date.now() - started;
  }
}

export interface SearchPage {
  rows: MessageRow[];
  built: BuiltSearch;
}

export function search(options: SearchOptions, { limit = 10, offset = 0 }: { limit?: number; offset?: number } = {}): SearchPage {
  const built = buildSearch(options);

  return withRegexGuard(built.usesRegex, (exec) => {
    const rows = exec.all<MessageRow>(`
      SELECT m.* FROM messages m
      WHERE ${built.where}
      ORDER BY ${built.orderBy}
      LIMIT ? OFFSET ?
    `, [...built.params, limit, offset]);

    return { rows, built };
  }, options.guildId);
}

export function countSearch(options: SearchOptions): number {
  const built = buildSearch(options);

  return withRegexGuard(built.usesRegex, (exec) => (
    exec.get<CountRow>(`SELECT COUNT(*) AS count FROM messages m WHERE ${built.where}`, built.params)?.count ?? 0
  ), options.guildId);
}

export interface SearchVisibility {
  /** 一致した件数 (countSearch と同じ) */
  total: number;
  /** そのうち sharedChannelIds の外にあるもの・削除済みのもの */
  restricted: number;
}

/**
 * 一致した件数と、そのうち「公開の場に出せない」件数を1回の走査で数える。
 *
 * 公開の返事に載せてよいのは、そのチャンネルにいる全員が見られる発言だけ
 * (実行者の権限で見えるものとは限らない)。sharedChannelIds の外の発言と
 * 削除済みの発言が1件でも当たれば、呼び出し側は本人にだけ見せる。
 */
export function countSearchVisibility(options: SearchOptions, sharedChannelIds: readonly string[]): SearchVisibility {
  const built = buildSearch(options);
  const shared = JSON.stringify([...new Set(sharedChannelIds)]);

  return withRegexGuard(built.usesRegex, (exec) => {
    const row = exec.get<{ total: number; restricted: number | null }>(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN m.deleted = 1 OR m.channel_id NOT IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END) AS restricted
      FROM messages m
      WHERE ${built.where}
    `, [shared, ...built.params]);
    return { total: row?.total ?? 0, restricted: row?.restricted ?? 0 };
  }, options.guildId);
}

// 「話題 (term)」はここに入れられない。1行1件の scalar 式ではなく、本文を
// トークン化して行を増やす処理なので terms.js に分けている。
const GROUP_EXPRESSIONS: Readonly<Record<string, string>> = {
  author: 'm.author_id',
  channel: 'm.channel_id',
  month: `strftime('%Y-%m', ${LOCAL_EPOCH}, 'unixepoch')`,
  day: `strftime('%Y-%m-%d', ${LOCAL_EPOCH}, 'unixepoch')`,
  hour: `CAST(strftime('%H', ${LOCAL_EPOCH}, 'unixepoch') AS INTEGER)`,
  weekday: `CAST(strftime('%w', ${LOCAL_EPOCH}, 'unixepoch') AS INTEGER)`,
  year: `strftime('%Y', ${LOCAL_EPOCH}, 'unixepoch')`
};

export interface ThreadHitRow {
  channel_id: string;
  name: string;
  parent_id: string | null;
  message_count: number;
  oldest_id: string | null;
  newest_id: string | null;
  applied_tags: string;
  hits: number;
  first_hit: number | null;
  last_hit: number | null;
  title_hit: number;
}

export interface ThreadSearchOptions {
  limit?: number;
  offset?: number;
  titleTerms?: readonly string[];
}

/**
 * 検索条件をそのまま集計する。「このワードを一番使っているのは誰か」など。
 */
/**
 * 投稿 (スレッド) を単位にして探す。
 *
 * 発言単位の検索では「どの投稿の話か」が分からない。フォーラムでは1つの投稿が
 * 1つの話題なので、そこを単位にしないと「○○について聞いてる投稿ある？」に答えられない。
 *
 * 当たり方は2通りあって、両方拾う:
 *   - 本文が当たった (既存の WHERE をそのまま使って channel_id で畳む)
 *   - タイトルが当たった (本文に1度も出てこない語がタイトルにはあることが多い。
 *     「ビルドが通らない」という投稿の中で誰も「ビルド」と書かない、が普通に起きる)
 *
 * 並びはタイトル一致を上に、次にヒット数。タイトルが当たっている投稿は
 * 「その話題そのもの」なので、本文に多く出てくる投稿より確実に効く。
 */
export function searchThreads(options: SearchOptions, { limit = 10, offset = 0, titleTerms = [] }: ThreadSearchOptions = {}): ThreadHitRow[] {
  const built = buildSearch(options);
  const titleParams: SqlParam[] = [];

  // タイトル一致。語は AND (クエリの意味に合わせる)
  const titleSql = titleTerms.length > 0
    ? titleTerms.map((term) => {
      titleParams.push(`%${escapeLike(term)}%`);
      return "c.name LIKE ? ESCAPE '\\'";
    }).join(' AND ')
    : '0';

  // 外側にも実行者のスコープを掛ける。内側 (m.*) だけだと、
  // タイトルだけが当たった投稿が権限を越えて出てしまう。
  const scope = options.channelScope;
  const scopeIds = scope && scope.mode !== 'none' && scope.ids.length > 0 ? scope.ids : [];
  let scopeSql = '1';
  if (scope?.mode === 'none') {
    scopeSql = '0';
  } else if (scope && scopeIds.length > 0) {
    scopeSql = `c.channel_id ${scope.mode === 'exclude' ? 'NOT IN' : 'IN'} (${scopeIds.map(() => '?').join(', ')})`;
  }

  const sql = `
    WITH body AS (
      SELECT m.channel_id AS channel_id,
             COUNT(*) AS hits,
             MIN(m.created_at) AS first_hit,
             MAX(m.created_at) AS last_hit
      FROM messages m
      WHERE ${built.where}
      GROUP BY m.channel_id
    )
    SELECT c.channel_id, c.name, c.parent_id, c.message_count, c.oldest_id, c.newest_id, c.applied_tags,
           COALESCE(b.hits, 0) AS hits,
           b.first_hit, b.last_hit,
           (${titleSql}) AS title_hit
    FROM channels c
    LEFT JOIN body b ON b.channel_id = c.channel_id
    WHERE c.guild_id = ? AND c.is_thread = 1 AND c.is_private = 0
      AND (${scopeSql})
      AND (b.hits > 0 OR (${titleSql}))
    ORDER BY title_hit DESC, hits DESC, CAST(c.newest_id AS INTEGER) DESC
    LIMIT ? OFFSET ?
  `;

  // プレースホルダの順番: 内側 WHERE → SELECT のタイトル一致 → guild → スコープ
  //                       → WHERE のタイトル一致 → limit → offset
  const bound: SqlParam[] = [
    ...built.params,
    ...titleParams,
    options.guildId,
    ...scopeIds,
    ...titleParams,
    limit,
    offset
  ];

  return withRegexGuard(built.usesRegex, (exec) => exec.all<ThreadHitRow>(sql, bound), options.guildId);
}

export interface AggregateOptions {
  limit?: number;
  orderByKey?: boolean | 'asc' | 'desc';
}

export function aggregateSearch(options: SearchOptions, groupBy: string, { limit = 10, orderByKey = false }: AggregateOptions = {}): AggregateRow[] {
  // 集計軸は SQL に埋め込むので、表にある名前だけ通す (constructor などを拾わない)
  const expression = Object.hasOwn(GROUP_EXPRESSIONS, groupBy) ? GROUP_EXPRESSIONS[groupBy] : undefined;
  if (!expression) throw new QueryError(`集計軸が不正です: ${groupBy}`);

  const built = buildSearch(options);
  const order = orderByKey === 'desc'
    ? 'bucket DESC'
    : orderByKey
      ? 'bucket ASC'
      : 'count DESC, bucket ASC';

  return withRegexGuard(built.usesRegex, (exec) => (
    exec.all<AggregateRow>(`
      SELECT ${expression} AS bucket, COUNT(*) AS count
      FROM messages m
      WHERE ${built.where}
      GROUP BY bucket
      ORDER BY ${order}
      LIMIT ?
    `, [...built.params, limit])
  ), options.guildId);
}

const SAMPLE_SLICES = Number(process.env.ARCHIVE_TERM_SLICES ?? 48);

export interface SampleRow {
  content: string;
  is_bot: number;
}

export interface TimeRange {
  from: number;
  to: number;
  total: number;
}

export interface SampleOptions {
  cap?: number;
  range?: TimeRange | null;
  slices?: number;
}

export interface Sample {
  rows: SampleRow[];
  mode: 'head' | 'all' | 'stratified';
}

/**
 * 検索条件に一致した本文を「時間で層化した標本」として取り出す。
 *
 * ORDER BY RANDOM() は数百万行だと全走査になるので使わない。期間を等分して
 * (guild_id, created_at) インデックスの範囲スキャンを何本か引く。
 * 直近だけを見ると「昔の話題」が落ちてしまい、立場の変遷が検出できなくなるので、
 * 期間全体から均等に拾うことが要件。
 *
 * is_bot の除外は SQL ではなく呼び出し側の JS でやる。is_bot は索引に無く、
 * WHERE に入れて LIMIT と併用すると bot が連投したスライスを無制限に走査する。
 */
export function sampleMessages(options: SearchOptions, { cap = 4000, range = null, slices = SAMPLE_SLICES }: SampleOptions = {}): Sample {
  const built = buildSearch(options);

  return withRegexGuard(built.usesRegex, (exec): Sample => {
    const spread = range
      && Number.isFinite(range.from)
      && Number.isFinite(range.to)
      && Number(range.total) > cap
      && range.to > range.from;

    if (!range || !spread) {
      const rows = exec.all<SampleRow>(`
        SELECT m.content AS content, m.is_bot AS is_bot
        FROM messages m WHERE ${built.where} LIMIT ?
      `, [...built.params, cap]);
      return { rows, mode: rows.length >= cap ? 'head' : 'all' };
    }

    const per = Math.max(1, Math.ceil(cap / slices));
    const width = Math.max(1, Math.ceil((range.to - range.from + 1) / slices));
    const sql = `
      SELECT m.content AS content, m.is_bot AS is_bot
      FROM messages m
      WHERE ${built.where} AND m.created_at >= ? AND m.created_at < ?
      ORDER BY m.created_at
      LIMIT ?
    `;

    const statements = Array.from({ length: Math.max(0, slices) }, (_, i) => {
      const from = range.from + i * width;
      return { sql, params: [...built.params, from, from + width, per] };
    });

    const rows: SampleRow[] = [];
    if (built.usesRegex) {
      // ワーカーには全スライスをまとめて渡す (1往復で済む)。打ち切りの位置は1本ずつ引くのと同じ
      for (const page of exec.allMany<SampleRow>(statements)) {
        if (rows.length >= cap) break;
        rows.push(...page);
      }
    } else {
      for (const statement of statements) {
        if (rows.length >= cap) break;
        rows.push(...exec.all<SampleRow>(statement.sql, statement.params));
      }
    }

    return { rows, mode: 'stratified' };
  }, options.guildId);
}

/** ギルド全体の期間。層化サンプリングの範囲決めに使う。 */
export function guildTimeRange(guildId: string): TimeRange | null {
  // MIN/MAX を1本の集計にすると索引が使われないことがあるので2本に分ける
  const first = db.prepare<[string], { at: number }>(
    'SELECT created_at AS at FROM messages WHERE guild_id = ? ORDER BY created_at ASC LIMIT 1'
  ).get(guildId);
  const last = db.prepare<[string], { at: number }>(
    'SELECT created_at AS at FROM messages WHERE guild_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(guildId);
  const total = db.prepare<[string], CountRow>('SELECT COUNT(*) AS count FROM messages WHERE guild_id = ?').get(guildId)?.count ?? 0;

  if (!first || !last) return null;
  return { from: first.at, to: last.at, total };
}

export interface SearchSummary {
  count: number;
  authors: number;
  channels: number;
  first_at: number | null;
  last_at: number | null;
  avg_length: number | null;
  reactions: number | null;
}

const EMPTY_SUMMARY: SearchSummary = {
  count: 0, authors: 0, channels: 0, first_at: null, last_at: null, avg_length: null, reactions: null
};

export function searchSummary(options: SearchOptions): SearchSummary {
  const built = buildSearch(options);

  return withRegexGuard(built.usesRegex, (exec) => (
    exec.get<SearchSummary>(`
      SELECT
        COUNT(*) AS count,
        COUNT(DISTINCT m.author_id) AS authors,
        COUNT(DISTINCT m.channel_id) AS channels,
        MIN(m.created_at) AS first_at,
        MAX(m.created_at) AS last_at,
        AVG(m.char_count) AS avg_length,
        SUM(m.reaction_count) AS reactions
      FROM messages m
      WHERE ${built.where}
    `, built.params) ?? EMPTY_SUMMARY
  ), options.guildId);
}

export interface ContextOptions {
  guildId?: string;
  before?: number;
  after?: number;
  channelScope?: ChannelScope | null;
}

export interface MessageContext {
  target: MessageRow;
  older: MessageRow[];
  newer: MessageRow[];
}

/**
 * ヒットしたメッセージの前後を取り出す。Discord の検索は1件しか見せてくれない。
 */
export function getContext(messageId: string, { guildId, before = 3, after = 3, channelScope }: ContextOptions = {}): MessageContext | null {
  if (!guildId) throw new Error('Message context requires a guildId');
  const target = db.prepare<[string, string], MessageRow>('SELECT * FROM messages WHERE guild_id = ? AND message_id = ? AND deleted = 0')
    .get(guildId, messageId);
  if (!target) return null;

  if (channelScope && !isChannelAllowed(target.channel_id, channelScope)) return null;

  const older = db.prepare<[string, number, number], MessageRow>(`
    SELECT * FROM messages
    WHERE channel_id = ? AND created_at < ? AND deleted = 0
    ORDER BY created_at DESC LIMIT ?
  `).all(target.channel_id, target.created_at, before).reverse();

  const newer = db.prepare<[string, number, number], MessageRow>(`
    SELECT * FROM messages
    WHERE channel_id = ? AND created_at > ? AND deleted = 0
    ORDER BY created_at ASC LIMIT ?
  `).all(target.channel_id, target.created_at, after);

  return { target, older, newer };
}

export function isChannelAllowed(channelId: string, channelScope: ChannelScope | null | undefined): boolean {
  if (!channelScope) return true;
  if (channelScope.mode === 'none') return false;
  if (channelScope.ids.length === 0) return true;

  const included = channelScope.ids.includes(channelId);
  return channelScope.mode === 'exclude' ? !included : included;
}

export interface TopOptions {
  limit?: number;
  since?: number | null;
  /** 渡したときはこのチャンネルの発言だけを数える (公開の返事に使うとき) */
  channelIds?: readonly string[];
}

function topClauses(guildId: string, since: number | null | undefined, channelIds: readonly string[] | undefined): { where: string; params: SqlParam[] } {
  const clauses = ['m.guild_id = ?', 'm.deleted = 0'];
  const params: SqlParam[] = [guildId];

  if (since) {
    clauses.push('m.created_at >= ?');
    params.push(since);
  }

  if (channelIds) {
    clauses.push('m.channel_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify([...new Set(channelIds)]));
  }

  return { where: clauses.join(' AND '), params };
}

export function topReactionEmojis(guildId: string, { limit = 15, since = null, channelIds }: TopOptions = {}): { emoji: string; count: number }[] {
  const { where, params } = topClauses(guildId, since, channelIds);

  return db.prepare<SqlParam[], { emoji: string; count: number }>(`
    SELECT mr.emoji AS emoji, SUM(mr.count) AS count
    FROM message_reactions mr
    JOIN messages m ON m.message_id = mr.message_id
    WHERE ${where}
    GROUP BY mr.emoji
    ORDER BY count DESC
    LIMIT ?
  `).all(...params, limit);
}

export function topDomains(guildId: string, { limit = 15, since = null, channelIds }: TopOptions = {}): { domain: string; count: number }[] {
  const { where, params } = topClauses(guildId, since, channelIds);

  return db.prepare<SqlParam[], { domain: string; count: number }>(`
    SELECT ml.domain AS domain, COUNT(*) AS count
    FROM message_links ml
    JOIN messages m ON m.message_id = ml.message_id
    WHERE ${where}
    GROUP BY ml.domain
    ORDER BY count DESC
    LIMIT ?
  `).all(...params, limit);
}
