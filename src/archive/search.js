import { db, setRegexBudget } from './db.js';
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

const TZ_OFFSET_SECONDS = TZ_OFFSET_HOURS * 3600;
const LOCAL_EPOCH = `m.created_at / 1000 + ${TZ_OFFSET_SECONDS}`;

// trigram インデックスは3文字以上でしか引けない。
// 1〜2文字の語は LIKE にフォールバックする (遅いが、日本語では避けられない)。
const MIN_FTS_LENGTH = 3;

const REGEX_SCAN_BUDGET = Number(process.env.ARCHIVE_REGEX_BUDGET ?? 300_000);

export const SORT_MODES = {
  new: 'm.created_at DESC',
  old: 'm.created_at ASC',
  reactions: 'm.reaction_count DESC, m.created_at DESC',
  long: 'm.char_count DESC, m.created_at DESC',
  random: 'RANDOM()'
};

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function ftsPhrase(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

class Compiler {
  constructor(guildId) {
    this.guildId = guildId;
    this.params = [];
    this.includesDeleted = false;
    this.usesRegex = false;
  }

  push(value) {
    this.params.push(value);
    return '?';
  }

  compile(node) {
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

  compileTerm(value) {
    if (!value) return '1';

    if (Array.from(value).length >= MIN_FTS_LENGTH) {
      return `m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${this.push(ftsPhrase(value))})`;
    }

    const pattern = `%${escapeLike(value)}%`;
    return `(m.content LIKE ${this.push(pattern)} ESCAPE '\\' OR m.extra LIKE ${this.push(pattern)} ESCAPE '\\')`;
  }

  compileFilter(key, rawValue) {
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

      case 'before': {
        // before:2024-05-01 はその日を含まない / before:7d は「7日より前」
        const { start } = parseDateRange(value);
        return `m.created_at < ${this.push(start)}`;
      }

      case 'after': {
        // after:2024-05-01 はその日を含まない / after:7d は「直近7日」
        const { start, end, relative } = parseDateRange(value);
        return `m.created_at >= ${this.push(relative ? start : end)}`;
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
        try {
          const [, body, flags] = /^\/(.*)\/([a-z]*)$/s.exec(pattern) ?? [null, pattern, 'i'];
          new RegExp(body, flags);
        } catch (error) {
          throw new QueryError(`正規表現が不正です: ${error.message}`);
        }
        this.usesRegex = true;
        return `regexp(${this.push(pattern)}, m.content)`;
      }

      default:
        throw new QueryError(`不明なフィルタです: \`${key}:\``);
    }
  }

  compileUser(column, value, nameColumn) {
    const id = parseSnowflake(value);
    if (id) return `${column} = ${this.push(id)}`;

    const name = value.replace(/^@/, '');
    if (!name) throw new QueryError('from: にはユーザーを指定してください。');
    return `${nameColumn} LIKE ${this.push(`%${escapeLike(name)}%`)} ESCAPE '\\'`;
  }

  // <:name:id> / :name: / 素の絵文字 のどれで書かれても引けるようにする
  compileReaction(value) {
    const raw = value.trim();
    if (!raw) throw new QueryError('reaction: には絵文字を指定してください。');

    const exists = (condition) => `EXISTS (
      SELECT 1 FROM message_reactions mr WHERE mr.message_id = m.message_id AND ${condition}
    )`;

    const custom = /^<a?:([^:]+):(\d+)>$/.exec(raw);
    if (custom) {
      return exists(`mr.emoji LIKE ${this.push(`%:${escapeLike(custom[1])}:${custom[2]}>`)} ESCAPE '\\'`);
    }

    const named = /^:([^:]+):$/.exec(raw);
    if (named) {
      return exists(`mr.emoji LIKE ${this.push(`%:${escapeLike(named[1])}:%`)} ESCAPE '\\'`);
    }

    return exists(`mr.emoji = ${this.push(raw)}`);
  }

  compileChannel(value) {
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

  compileHas(value) {
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

  compileIs(value) {
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
      default:
        throw new QueryError(`is: に指定できない値です: \`${value}\` (bot/human/edited/pinned/reply/thread/deleted)`);
    }
  }
}

/**
 * クエリ文字列と追加条件から SQL の WHERE 句を組み立てる。
 */
export function buildSearch({ guildId, query = '', extra = [], channelScope, allowDeleted = false, sort = 'new' }) {
  const { ast, directives } = parseQuery(query);
  const compiler = new Compiler(guildId);

  const clauses = ['m.guild_id = ?'];
  const params = [guildId];

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

  const sortKey = directives.sort ?? sort;
  const orderBy = SORT_MODES[sortKey] ?? SORT_MODES.new;

  return {
    where: clauses.join(' AND '),
    params,
    orderBy,
    sortKey: SORT_MODES[sortKey] ? sortKey : 'new',
    terms: collectTerms(ast),
    usesRegex: compiler.usesRegex
  };
}

// vectors.js の走査も buildSearch 由来の SQL を使うので、regex: が混ざったときに
// 走査上限を素通りしないよう共有する。予算の実装を二重に持たない。
export function withRegexGuard(usesRegex, run) {
  if (!usesRegex) return run();

  setRegexBudget(REGEX_SCAN_BUDGET);
  try {
    return run();
  } catch (error) {
    if (String(error?.message ?? '').includes('regex scan budget exceeded')) {
      throw new QueryError(
        `正規表現の走査量が上限 (${REGEX_SCAN_BUDGET.toLocaleString()}件) を超えました。from: / in: / after: などで範囲を絞ってください。`
      );
    }
    throw error;
  } finally {
    setRegexBudget(Infinity);
  }
}

export function search(options, { limit = 10, offset = 0 } = {}) {
  const built = buildSearch(options);

  return withRegexGuard(built.usesRegex, () => {
    const rows = db.prepare(`
      SELECT m.* FROM messages m
      WHERE ${built.where}
      ORDER BY ${built.orderBy}
      LIMIT ? OFFSET ?
    `).all(...built.params, limit, offset);

    return { rows, built };
  });
}

export function countSearch(options) {
  const built = buildSearch(options);

  return withRegexGuard(built.usesRegex, () => (
    db.prepare(`SELECT COUNT(*) AS count FROM messages m WHERE ${built.where}`).get(...built.params).count
  ));
}

// 「話題 (term)」はここに入れられない。1行1件の scalar 式ではなく、本文を
// トークン化して行を増やす処理なので terms.js に分けている。
const GROUP_EXPRESSIONS = {
  author: 'm.author_id',
  channel: 'm.channel_id',
  month: `strftime('%Y-%m', ${LOCAL_EPOCH}, 'unixepoch')`,
  day: `strftime('%Y-%m-%d', ${LOCAL_EPOCH}, 'unixepoch')`,
  hour: `CAST(strftime('%H', ${LOCAL_EPOCH}, 'unixepoch') AS INTEGER)`,
  weekday: `CAST(strftime('%w', ${LOCAL_EPOCH}, 'unixepoch') AS INTEGER)`,
  year: `strftime('%Y', ${LOCAL_EPOCH}, 'unixepoch')`
};

/**
 * 検索条件をそのまま集計する。「このワードを一番使っているのは誰か」など。
 */
export function aggregateSearch(options, groupBy, { limit = 10, orderByKey = false } = {}) {
  const expression = GROUP_EXPRESSIONS[groupBy];
  if (!expression) throw new QueryError(`集計軸が不正です: ${groupBy}`);

  const built = buildSearch(options);
  const order = orderByKey === 'desc'
    ? 'bucket DESC'
    : orderByKey
      ? 'bucket ASC'
      : 'count DESC, bucket ASC';

  return withRegexGuard(built.usesRegex, () => (
    db.prepare(`
      SELECT ${expression} AS bucket, COUNT(*) AS count
      FROM messages m
      WHERE ${built.where}
      GROUP BY bucket
      ORDER BY ${order}
      LIMIT ?
    `).all(...built.params, limit)
  ));
}

const SAMPLE_SLICES = Number(process.env.ARCHIVE_TERM_SLICES ?? 48);

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
export function sampleMessages(options, { cap = 4000, range = null, slices = SAMPLE_SLICES } = {}) {
  const built = buildSearch(options);

  return withRegexGuard(built.usesRegex, () => {
    const spread = range
      && Number.isFinite(range.from)
      && Number.isFinite(range.to)
      && Number(range.total) > cap
      && range.to > range.from;

    if (!spread) {
      const rows = db.prepare(`
        SELECT m.content AS content, m.is_bot AS is_bot
        FROM messages m WHERE ${built.where} LIMIT ?
      `).all(...built.params, cap);
      return { rows, mode: rows.length >= cap ? 'head' : 'all' };
    }

    const per = Math.max(1, Math.ceil(cap / slices));
    const width = Math.max(1, Math.ceil((range.to - range.from + 1) / slices));
    const statement = db.prepare(`
      SELECT m.content AS content, m.is_bot AS is_bot
      FROM messages m
      WHERE ${built.where} AND m.created_at >= ? AND m.created_at < ?
      ORDER BY m.created_at
      LIMIT ?
    `);

    const rows = [];
    for (let i = 0; i < slices && rows.length < cap; i += 1) {
      const from = range.from + i * width;
      rows.push(...statement.all(...built.params, from, from + width, per));
    }

    return { rows, mode: 'stratified' };
  });
}

/** ギルド全体の期間。層化サンプリングの範囲決めに使う。 */
export function guildTimeRange(guildId) {
  // MIN/MAX を1本の集計にすると索引が使われないことがあるので2本に分ける
  const first = db.prepare(
    'SELECT created_at AS at FROM messages WHERE guild_id = ? ORDER BY created_at ASC LIMIT 1'
  ).get(guildId);
  const last = db.prepare(
    'SELECT created_at AS at FROM messages WHERE guild_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(guildId);
  const total = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE guild_id = ?').get(guildId).count;

  if (!first || !last) return null;
  return { from: first.at, to: last.at, total };
}

export function searchSummary(options) {
  const built = buildSearch(options);

  return withRegexGuard(built.usesRegex, () => (
    db.prepare(`
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
    `).get(...built.params)
  ));
}

/**
 * ヒットしたメッセージの前後を取り出す。Discord の検索は1件しか見せてくれない。
 */
export function getContext(messageId, { before = 3, after = 3, channelScope } = {}) {
  const target = db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
  if (!target) return null;

  if (channelScope && !isChannelAllowed(target.channel_id, channelScope)) return null;

  const older = db.prepare(`
    SELECT * FROM messages
    WHERE channel_id = ? AND created_at < ? AND deleted = 0
    ORDER BY created_at DESC LIMIT ?
  `).all(target.channel_id, target.created_at, before).reverse();

  const newer = db.prepare(`
    SELECT * FROM messages
    WHERE channel_id = ? AND created_at > ? AND deleted = 0
    ORDER BY created_at ASC LIMIT ?
  `).all(target.channel_id, target.created_at, after);

  return { target, older, newer };
}

export function isChannelAllowed(channelId, channelScope) {
  if (!channelScope) return true;
  if (channelScope.mode === 'none') return false;
  if (channelScope.ids.length === 0) return true;

  const included = channelScope.ids.includes(channelId);
  return channelScope.mode === 'exclude' ? !included : included;
}

export function topReactionEmojis(guildId, { limit = 15, since = null } = {}) {
  const clauses = ['m.guild_id = ?', 'm.deleted = 0'];
  const params = [guildId];

  if (since) {
    clauses.push('m.created_at >= ?');
    params.push(since);
  }

  return db.prepare(`
    SELECT mr.emoji AS emoji, SUM(mr.count) AS count
    FROM message_reactions mr
    JOIN messages m ON m.message_id = mr.message_id
    WHERE ${clauses.join(' AND ')}
    GROUP BY mr.emoji
    ORDER BY count DESC
    LIMIT ?
  `).all(...params, limit);
}

export function topDomains(guildId, { limit = 15, since = null } = {}) {
  const clauses = ['m.guild_id = ?', 'm.deleted = 0'];
  const params = [guildId];

  if (since) {
    clauses.push('m.created_at >= ?');
    params.push(since);
  }

  return db.prepare(`
    SELECT ml.domain AS domain, COUNT(*) AS count
    FROM message_links ml
    JOIN messages m ON m.message_id = ml.message_id
    WHERE ${clauses.join(' AND ')}
    GROUP BY ml.domain
    ORDER BY count DESC
    LIMIT ?
  `).all(...params, limit);
}
