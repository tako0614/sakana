// 検索クエリ DSL のパーサ。
//
//   会議 場所            → 両方を含む (AND)
//   "明日の会議"          → 空白込みの部分一致 (フレーズ)
//   会議 OR ミーティング   → どちらか
//   会議 -中止            → 中止を含まない
//   (a OR b) c           → 括弧でグループ化
//   from:@user in:#general has:image after:2024-01 reactions:>5 regex:/^w+$/i
//
// Discord 標準検索と違い OR / NOT / 括弧 / 正規表現 / リアクション数 / 文字数 /
// 時間帯 / 曜日 / ドメインを組み合わせられる。

export const TZ_OFFSET_HOURS = Number(process.env.ARCHIVE_TZ_OFFSET_HOURS ?? 9);

const TZ_OFFSET_MS = TZ_OFFSET_HOURS * 3_600_000;

const FILTER_KEYS = new Set([
  'from', 'author',
  'in', 'channel',
  'mentions', 'mention',
  'replyto',
  'has',
  'is',
  'before', 'after', 'during', 'on',
  'reactions',
  'reaction',
  'len', 'length',
  'hour',
  'weekday', 'day',
  'domain',
  'regex', 're'
]);

const DIRECTIVE_KEYS = new Set(['sort']);

const WEEKDAYS = {
  sun: 0, sunday: 0, 日: 0,
  mon: 1, monday: 1, 月: 1,
  tue: 2, tuesday: 2, 火: 2,
  wed: 3, wednesday: 3, 水: 3,
  thu: 4, thursday: 4, 木: 4,
  fri: 5, friday: 5, 金: 5,
  sat: 6, saturday: 6, 土: 6
};

export class QueryError extends Error {}

function tokenize(input) {
  const tokens = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({ type: char, text: char });
      index += 1;
      continue;
    }

    let text = '';
    let quoted = false;

    while (index < input.length) {
      const current = input[index];

      if (/\s/.test(current) || current === '(' || current === ')') {
        break;
      }

      if (current === '"') {
        quoted = true;
        index += 1;
        while (index < input.length && input[index] !== '"') {
          text += input[index];
          index += 1;
        }
        index += 1; // 閉じ引用符 (無ければ末尾)
        continue;
      }

      text += current;
      index += 1;
    }

    if (text.length > 0 || quoted) {
      tokens.push({ type: 'word', text, quoted });
    }
  }

  return tokens;
}

function splitFilter(text) {
  const separator = text.indexOf(':');
  if (separator <= 0) return null;

  const key = text.slice(0, separator).toLowerCase();
  if (!/^[a-z_]+$/.test(key)) return null;

  return { key, value: text.slice(separator + 1) };
}

function classify(token) {
  if (!token.quoted) {
    const upper = token.text.toUpperCase();
    if (upper === 'OR' || upper === '|' || upper === '||') return { type: 'or' };
    if (upper === 'AND' || upper === '&' || upper === '&&') return { type: 'and' };
    if (upper === 'NOT') return { type: 'not' };
  }

  let text = token.text;
  let negated = false;

  while (!token.quoted && text.startsWith('-') && text.length > 1) {
    negated = !negated;
    text = text.slice(1);
  }

  const filter = token.quoted ? null : splitFilter(text);
  if (filter && FILTER_KEYS.has(filter.key)) {
    return { type: 'leaf', negated, node: { type: 'filter', key: filter.key, value: filter.value } };
  }

  return { type: 'leaf', negated, node: { type: 'term', value: text } };
}

export function parseQuery(input) {
  const directives = {};
  const tokens = [];

  for (const token of tokenize(input ?? '')) {
    if (token.type === 'word' && !token.quoted) {
      const filter = splitFilter(token.text);
      if (filter && DIRECTIVE_KEYS.has(filter.key)) {
        directives[filter.key] = filter.value.toLowerCase();
        continue;
      }
    }
    tokens.push(token);
  }

  let position = 0;

  const peek = () => tokens[position];

  function parseOr() {
    const nodes = [parseAnd()];

    while (peek() && peek().type === 'word' && classify(peek()).type === 'or') {
      position += 1;
      nodes.push(parseAnd());
    }

    return nodes.length === 1 ? nodes[0] : { type: 'or', nodes };
  }

  function parseAnd() {
    const nodes = [parseUnary()];

    while (peek() && peek().type !== ')') {
      const kind = peek().type === 'word' ? classify(peek()).type : 'leaf';
      if (kind === 'or') break;
      if (kind === 'and') position += 1;
      if (!peek() || peek().type === ')') break;
      nodes.push(parseUnary());
    }

    return nodes.length === 1 ? nodes[0] : { type: 'and', nodes };
  }

  function parseUnary() {
    const token = peek();
    if (!token) throw new QueryError('クエリが途中で終わっています。');

    if (token.type === '(') {
      position += 1;
      const node = parseOr();
      if (peek()?.type !== ')') throw new QueryError('括弧が閉じられていません。');
      position += 1;
      return node;
    }

    if (token.type === ')') {
      throw new QueryError('対応する開き括弧がありません。');
    }

    const classified = classify(token);
    if (classified.type === 'or' || classified.type === 'and') {
      throw new QueryError(`演算子 ${token.text} の位置が正しくありません。`);
    }

    position += 1;

    if (classified.type === 'not') {
      return { type: 'not', node: parseUnary() };
    }

    return classified.negated ? { type: 'not', node: classified.node } : classified.node;
  }

  if (tokens.length === 0) {
    return { ast: null, directives };
  }

  const ast = parseOr();
  if (position < tokens.length) {
    throw new QueryError('クエリを解釈できませんでした。括弧の対応を確認してください。');
  }

  return { ast, directives };
}

// AST から検索語だけを集める (結果のハイライト用)。
export function collectTerms(ast, out = []) {
  if (!ast) return out;

  if (ast.type === 'term') {
    out.push(ast.value);
  } else if (ast.type === 'not') {
    // 否定語はハイライトしない
  } else if (ast.nodes) {
    for (const node of ast.nodes) collectTerms(node, out);
  }

  return out;
}

export function parseSnowflake(value) {
  const match = /(\d{16,21})/.exec(value ?? '');
  return match ? match[1] : null;
}

function localParts(timestamp) {
  const shifted = new Date(timestamp + TZ_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate()
  };
}

function localTimestamp(year, month, day) {
  return Date.UTC(year, month, day) - TZ_OFFSET_MS;
}

const RELATIVE_UNITS = {
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000,
  y: 31_536_000_000
};

// 日付表現を { start, end } (end は含まない) に変換する。
// relative: true のときは「今から N 前」という相対指定なので before:/after: の解釈を変える。
export function parseDateRange(raw) {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) throw new QueryError('日付が空です。');

  const now = Date.now();

  if (value === 'today' || value === '今日') {
    const { year, month, day } = localParts(now);
    return { start: localTimestamp(year, month, day), end: localTimestamp(year, month, day + 1), relative: false };
  }

  if (value === 'yesterday' || value === '昨日') {
    const { year, month, day } = localParts(now);
    return { start: localTimestamp(year, month, day - 1), end: localTimestamp(year, month, day), relative: false };
  }

  const relative = /^(\d+)(h|d|w|mo|y)$/.exec(value);
  if (relative) {
    return { start: now - Number(relative[1]) * RELATIVE_UNITS[relative[2]], end: now, relative: true };
  }

  const ymd = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (ymd) {
    const [year, month, day] = [Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])];
    return { start: localTimestamp(year, month, day), end: localTimestamp(year, month, day + 1), relative: false };
  }

  const ym = /^(\d{4})[-/](\d{1,2})$/.exec(value);
  if (ym) {
    const [year, month] = [Number(ym[1]), Number(ym[2]) - 1];
    return { start: localTimestamp(year, month, 1), end: localTimestamp(year, month + 1, 1), relative: false };
  }

  const y = /^(\d{4})$/.exec(value);
  if (y) {
    return { start: localTimestamp(Number(y[1]), 0, 1), end: localTimestamp(Number(y[1]) + 1, 0, 1), relative: false };
  }

  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    return { start: parsed, end: parsed + 1, relative: false };
  }

  throw new QueryError(`日付を解釈できません: \`${raw}\` (例: 2024-05-01 / 2024-05 / 7d / today)`);
}

export function parseComparison(raw) {
  const match = /^(>=|<=|>|<|=)?\s*(\d+)$/.exec((raw ?? '').trim());
  if (!match) throw new QueryError(`数値条件を解釈できません: \`${raw}\` (例: >5, <=100, 3)`);

  return { operator: match[1] === '=' || !match[1] ? '=' : match[1], value: Number(match[2]) };
}

export function parseHourRange(raw) {
  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec((raw ?? '').trim());
  if (match) {
    return { from: Number(match[1]) % 24, to: Number(match[2]) % 24 };
  }

  const single = /^(\d{1,2})$/.exec((raw ?? '').trim());
  if (single) {
    const hour = Number(single[1]) % 24;
    return { from: hour, to: hour };
  }

  throw new QueryError(`時間帯を解釈できません: \`${raw}\` (例: 22-4, 9-18, 3)`);
}

export function parseWeekdays(raw) {
  const parts = (raw ?? '').split(/[,、\s]+/).filter(Boolean);
  const days = [];

  for (const part of parts) {
    const day = WEEKDAYS[part.toLowerCase()];
    if (day === undefined) throw new QueryError(`曜日を解釈できません: \`${part}\` (例: sat,sun / 土,日)`);
    days.push(day);
  }

  if (days.length === 0) throw new QueryError('曜日が指定されていません。');
  return [...new Set(days)];
}
