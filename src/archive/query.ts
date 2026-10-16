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

import type { QueryNode } from './types.js';

export type { QueryNode };

export const TZ_OFFSET_HOURS = Number(process.env.ARCHIVE_TZ_OFFSET_HOURS ?? 9);

const TZ_OFFSET_MS = TZ_OFFSET_HOURS * 3_600_000;

const FILTER_KEYS: ReadonlySet<string> = new Set([
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
  'tag',
  'regex', 're'
]);

const DIRECTIVE_KEYS: ReadonlySet<string> = new Set(['sort']);

const WEEKDAYS: Readonly<Record<string, number>> = {
  sun: 0, sunday: 0, 日: 0,
  mon: 1, monday: 1, 月: 1,
  tue: 2, tuesday: 2, 火: 2,
  wed: 3, wednesday: 3, 水: 3,
  thu: 4, thursday: 4, 木: 4,
  fri: 5, friday: 5, 金: 5,
  sat: 6, saturday: 6, 土: 6
};

export class QueryError extends Error {}

interface OpenToken {
  type: '(';
  text: string;
}

interface CloseToken {
  type: ')';
  text: string;
}

interface WordToken {
  type: 'word';
  text: string;
  quoted: boolean;
  dashes: number;
  /** 既知のフィルタ / 指示子のときだけ付く */
  key?: string;
  value?: string;
}

type Token = OpenToken | CloseToken | WordToken;

type Classified =
  | { type: 'or' }
  | { type: 'and' }
  | { type: 'not' }
  | { type: 'leaf'; negated: boolean; node: QueryNode };

export interface ParsedQuery {
  ast: QueryNode | null;
  directives: Record<string, string>;
}

// 先頭の - は tokenize で数える。classify で数えると -"foo bar" の - が
// 引用符処理に食われて否定が落ちる。
// ( の直前の - は従来どおり素の語として残す (-(a OR b) は今も否定にならない)。
const LEADING_DASHES = /^(-+)(?=[^\s()])/;
const FILTER_HEAD = /^([A-Za-z_]+):/;

/**
 * フィルタの値を「そのまま」読む。
 *
 *   ・空白で終わる (従来どおり。from:a in:b を2語に割るため)
 *   ・"..." で囲めば空白も値に入る (regex:"/a b/i")
 *   ・括弧は対応が取れている限り値の一部。(from:@a OR from:@b) の閉じ括弧は値にしない
 *   ・\ の次の1文字はそのまま (regex の \( \) を括弧として数えないため)
 */
function readFilterValue(input: string, start: number): { text: string; quoted: boolean; index: number } {
  let index = start;
  let text = '';
  let quoted = false;
  let depth = 0;

  while (index < input.length) {
    const char = input.charAt(index);

    if (/\s/.test(char)) break;

    if (char === '"') {
      quoted = true;
      index += 1;
      while (index < input.length && input[index] !== '"') {
        text += input.charAt(index);
        index += 1;
      }
      index += 1; // 閉じ引用符 (無ければ末尾)
      continue;
    }

    if (char === '\\' && index + 1 < input.length) {
      text += char + input.charAt(index + 1);
      index += 2;
      continue;
    }

    if (char === '(') depth += 1;
    if (char === ')') {
      if (depth === 0) break; // グループの閉じ括弧なので値には入れない
      depth -= 1;
    }

    text += char;
    index += 1;
  }

  return { text, quoted, index };
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input.charAt(index);

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({ type: char, text: char });
      index += 1;
      continue;
    }

    let dashes = 0;
    const dash = LEADING_DASHES.exec(input.slice(index));
    if (dash?.[1]) {
      dashes = dash[1].length;
      index += dash[1].length;
    }

    // 既知のフィルタ / 指示子だと分かった時点で、値を丸ごと読む。
    // regex:/(べき|絶対)/ の括弧やスラッシュを壊さないため。
    // 知らないキー (http: や 12: など) は従来の語スキャンに落として挙動を変えない。
    const head = FILTER_HEAD.exec(input.slice(index));
    const name = head?.[1];
    const key = name ? name.toLowerCase() : null;

    if (head && name && key && (FILTER_KEYS.has(key) || DIRECTIVE_KEYS.has(key))) {
      const value = readFilterValue(input, index + head[0].length);
      index = value.index;
      tokens.push({
        type: 'word',
        // フィルタ扱いしないときに使う素の語。従来と同じ見え方にするため元の大小を保つ
        text: `${name}:${value.text}`,
        quoted: value.quoted,
        dashes,
        key,
        value: value.text
      });
      continue;
    }

    let text = '';
    let quoted = false;

    while (index < input.length) {
      const current = input.charAt(index);

      if (/\s/.test(current) || current === '(' || current === ')') {
        break;
      }

      if (current === '"') {
        quoted = true;
        index += 1;
        while (index < input.length && input[index] !== '"') {
          text += input.charAt(index);
          index += 1;
        }
        index += 1; // 閉じ引用符 (無ければ末尾)
        continue;
      }

      text += current;
      index += 1;
    }

    if (text.length > 0 || quoted) {
      tokens.push({ type: 'word', text, quoted, dashes });
    }
  }

  return tokens;
}

function classify(token: WordToken): Classified {
  // 演算子と見なすのは素の語だけ。-OR は昔から「OR を含まない」の意味なので
  // dashes が付いていたら演算子にしない。
  if (!token.quoted && token.dashes === 0) {
    const upper = token.text.toUpperCase();
    if (upper === 'OR' || upper === '|' || upper === '||') return { type: 'or' };
    if (upper === 'AND' || upper === '&' || upper === '&&') return { type: 'and' };
    if (upper === 'NOT') return { type: 'not' };
  }

  const negated = token.dashes % 2 === 1;

  if (token.key && FILTER_KEYS.has(token.key)) {
    return { type: 'leaf', negated, node: { type: 'filter', key: token.key, value: token.value ?? '' } };
  }

  // sort: のようにフィルタでないキーは従来どおり素の語として扱う
  return { type: 'leaf', negated, node: { type: 'term', value: token.text } };
}

/** 次の語が演算子か (括弧はどれでもない)。 */
function kindOf(token: Token): Classified['type'] {
  return token.type === 'word' ? classify(token).type : 'leaf';
}

export function parseQuery(input: string | null | undefined): ParsedQuery {
  const directives: Record<string, string> = {};
  const tokens: Token[] = [];

  for (const token of tokenize(input ?? '')) {
    // sort: は AST に載せない。-sort:new / sort:"new" は従来どおり検索語扱い。
    if (token.type === 'word' && token.key && token.dashes === 0 && !token.quoted && DIRECTIVE_KEYS.has(token.key)) {
      directives[token.key] = (token.value ?? '').toLowerCase();
      continue;
    }
    tokens.push(token);
  }

  let position = 0;

  const peek = (): Token | undefined => tokens[position];

  function parseOr(): QueryNode {
    const nodes = [parseAnd()];

    for (let next = peek(); next && next.type === 'word' && classify(next).type === 'or'; next = peek()) {
      position += 1;
      nodes.push(parseAnd());
    }

    return nodes.length === 1 && nodes[0] ? nodes[0] : { type: 'or', nodes };
  }

  function parseAnd(): QueryNode {
    const nodes = [parseUnary()];

    for (let next = peek(); next && next.type !== ')'; next = peek()) {
      const kind = kindOf(next);
      if (kind === 'or') break;
      if (kind === 'and') position += 1;
      const after = peek();
      if (!after || after.type === ')') break;
      nodes.push(parseUnary());
    }

    return nodes.length === 1 && nodes[0] ? nodes[0] : { type: 'and', nodes };
  }

  function parseUnary(): QueryNode {
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
export function collectTerms(ast: QueryNode | null | undefined, out: string[] = []): string[] {
  if (!ast) return out;

  if (ast.type === 'term') {
    out.push(ast.value);
  } else if (ast.type === 'not') {
    // 否定語はハイライトしない
  } else if (ast.type === 'and' || ast.type === 'or') {
    for (const node of ast.nodes) collectTerms(node, out);
  }

  return out;
}

export function parseSnowflake(value: string | null | undefined): string | null {
  const match = /(\d{16,21})/.exec(value ?? '');
  return match?.[1] ?? null;
}

function localParts(timestamp: number): { year: number; month: number; day: number } {
  const shifted = new Date(timestamp + TZ_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate()
  };
}

function localTimestamp(year: number, month: number, day: number): number {
  return Date.UTC(year, month, day) - TZ_OFFSET_MS;
}

const RELATIVE_UNITS: Readonly<Record<string, number>> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000,
  y: 31_536_000_000
};

export interface DateRange {
  start: number;
  end: number;
  relative: boolean;
}

// 日付表現を { start, end } (end は含まない) に変換する。
// relative: true のときは「今から N 前」という相対指定なので before:/after: の解釈を変える。
export function parseDateRange(raw: string | null | undefined): DateRange {
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
  const unit = relative?.[2] ? RELATIVE_UNITS[relative[2]] : undefined;
  if (relative && unit !== undefined) {
    return { start: now - Number(relative[1]) * unit, end: now, relative: true };
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

  const parsed = Date.parse(raw ?? '');
  if (!Number.isNaN(parsed)) {
    return { start: parsed, end: parsed + 1, relative: false };
  }

  throw new QueryError(`日付を解釈できません: \`${raw}\` (例: 2024-05-01 / 2024-05 / 7d / today)`);
}

export type ComparisonOperator = '=' | '>' | '<' | '>=' | '<=';

export function parseComparison(raw: string | null | undefined): { operator: ComparisonOperator; value: number } {
  const match = /^(>=|<=|>|<|=)?\s*(\d+)$/.exec((raw ?? '').trim());
  if (!match) throw new QueryError(`数値条件を解釈できません: \`${raw}\` (例: >5, <=100, 3)`);

  const operator = match[1];
  return {
    operator: operator === '>' || operator === '<' || operator === '>=' || operator === '<=' ? operator : '=',
    value: Number(match[2])
  };
}

export function parseHourRange(raw: string | null | undefined): { from: number; to: number } {
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

export function parseWeekdays(raw: string | null | undefined): number[] {
  const parts = (raw ?? '').split(/[,、\s]+/).filter(Boolean);
  const days: number[] = [];

  for (const part of parts) {
    // 自前のキーだけを見る (constructor や __proto__ を曜日として拾わない)
    const key = part.toLowerCase();
    const day = Object.hasOwn(WEEKDAYS, key) ? WEEKDAYS[key] : undefined;
    if (day === undefined) throw new QueryError(`曜日を解釈できません: \`${part}\` (例: sat,sun / 土,日)`);
    days.push(day);
  }

  if (days.length === 0) throw new QueryError('曜日が指定されていません。');
  return [...new Set(days)];
}
