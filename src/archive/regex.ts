import { createRequire } from 'node:module';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { field, isRecord } from './guards.js';
import type { SqlParam } from './types.js';

// 正規表現検索 (regex:/.../) の安全装置。
//
// regexp() は SQLite が1行ごとに呼ぶ JS の関数で、以前はメインスレッドで評価していた。
// (a+)+$ のようなパターンは長い発言1件で何十秒も返ってこず、その間 bot 全体
// (全サーバーの応答・取り込み・リアクション) が止まる。走査件数の上限は
// 「何件見たか」しか数えないので、1件で詰まるのは防げなかった。
//
// そこで3段で止める:
//   1. 量指定子を入れ子にしたグループ ((a+)+ / (a*b?)* など) は組み立ての時点で断る
//   2. パターンの長さと、照合に渡す本文の長さに上限を置く
//   3. 照合は使い捨てのワーカースレッド (読み取り専用の別接続) で行い、
//      時間内に終わらなければワーカーごと止める
// 1 と 2 をすり抜ける重い形 (.*a.*b を長い本文に掛ける等) も 3 で必ず止まる。
// メインスレッドが止まるのは結果を待つ間だけで、それも timeoutMs で必ず戻る。

export const REGEX_MAX_PATTERN_LENGTH = 300;
// Discord の本文は最大 4000 字 (Nitro)。実在する本文は切らずに照合できる
export const REGEX_MAX_INPUT_LENGTH = 4000;

export class RegexBudgetExceeded extends Error {}
export class RegexTimedOut extends Error {}
export class RegexUnavailable extends Error {}

export interface RegexLiteral {
  body: string;
  flags: string;
}

/** `/body/flags` ならその中身。裸のパターンは従来どおり大文字小文字を区別しない。 */
export function regexLiteral(pattern: string): RegexLiteral {
  const match = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  return match ? { body: match[1] ?? '', flags: match[2] ?? '' } : { body: pattern, flags: 'i' };
}

/** 照合に使う RegExp を作る。作れないパターンは例外 (呼び出し側で QueryError にする)。 */
export function compileRegex(pattern: string): RegExp {
  const { body, flags } = regexLiteral(pattern);
  return new RegExp(body, flags);
}

interface Quantifier {
  min: number;
  max: number;
  length: number;
}

const BRACE_QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/;

/** i の位置の量指定子 (*, +, ?, {n,m} と後ろの怠惰指定 ?) を読む。無ければ null。 */
function readQuantifier(body: string, i: number): Quantifier | null {
  const char = body[i];
  let quantifier: Quantifier | null = null;

  if (char === '*') quantifier = { min: 0, max: Infinity, length: 1 };
  else if (char === '+') quantifier = { min: 1, max: Infinity, length: 1 };
  else if (char === '?') quantifier = { min: 0, max: 1, length: 1 };
  else if (char === '{') {
    const brace = BRACE_QUANTIFIER.exec(body.slice(i));
    if (brace) {
      const min = Number(brace[1]);
      const max = brace[2] ? (brace[3] ? Number(brace[3]) : Infinity) : min;
      quantifier = { min, max, length: brace[0].length };
    }
  }

  if (quantifier && body[i + quantifier.length] === '?') quantifier.length += 1;
  return quantifier;
}

/** \ から始まるエスケープの長さ。\u{...} \p{...} \k<...> は括弧の中まで含める。 */
function escapeLength(body: string, i: number): number {
  const next = body[i + 1];
  if ((next === 'u' || next === 'p' || next === 'P') && body[i + 2] === '{') {
    const close = body.indexOf('}', i + 3);
    return close < 0 ? 2 : close - i + 1;
  }
  if (next === 'k' && body[i + 2] === '<') {
    const close = body.indexOf('>', i + 3);
    return close < 0 ? 2 : close - i + 1;
  }
  return 2;
}

/** [ から対応する ] の次までの長さ。v フラグでは [ ] が入れ子になる。 */
function classLength(body: string, i: number, nested: boolean): number {
  let depth = 0;
  for (let j = i; j < body.length; j += 1) {
    const char = body[j];
    if (char === '\\') { j += 1; continue; }
    if (char === '[' && (depth === 0 || nested)) depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return j - i + 1;
    }
  }
  return body.length - i;
}

/** ( から始まるグループの頭 ((?: (?= (?<= (?<name> (?i: など) の長さ。 */
function groupHeadLength(body: string, i: number): number {
  if (body[i + 1] !== '?') return 1;
  const kind = body[i + 2];
  if (kind === ':' || kind === '=' || kind === '!') return 3;
  if (kind === '<') {
    if (body[i + 3] === '=' || body[i + 3] === '!') return 4;
    const close = body.indexOf('>', i + 3);
    return close < 0 ? 3 : close - i + 1;
  }
  const colon = body.indexOf(':', i + 2);
  return colon < 0 ? 2 : colon - i + 1;
}

const NESTED_QUANTIFIER = '量指定子を入れ子にしたグループ (例: `(a+)+` `(\\w*\\s?)*`) は、長い発言1件で処理が止まるため使えません。'
  + '`(?:ab)+` のように中身を固定するか、`a+` のように外側の繰り返しを外してください。';

/**
 * 処理が爆発しうる形なら理由を返す。受け付けてよければ null。
 *
 * 見るのは「繰り返すグループの中に、長さの変わる量指定子がある」形 (star height > 1)。
 * これは長い本文に対して指数時間になる典型で、ワーカーの時間切れを待つまでもなく断れる。
 * 先読み ^(?!.*http).{200,} や選択 (a|b) は繰り返されていないので通す。
 * 構文として不正なパターンは先に new RegExp() で弾いておくこと (ここは正しい構文を前提にする)。
 */
export function regexRefusal(pattern: string): string | null {
  if (pattern.length > REGEX_MAX_PATTERN_LENGTH) {
    return `正規表現が長すぎます (最大 ${REGEX_MAX_PATTERN_LENGTH} 文字)。`;
  }

  const { body, flags } = regexLiteral(pattern);
  const nestedClasses = flags.includes('v');
  // グループごとに「中に長さの変わる量指定子があるか」を持つ。先頭はパターン全体
  const stack: boolean[] = [false];
  // 直前の要素が閉じたグループなら、その中身に量指定子があったか
  let closed: boolean | null = null;

  for (let i = 0; i < body.length;) {
    const char = body[i];

    if (char === '\\') {
      i += escapeLength(body, i);
      closed = null;
      continue;
    }
    if (char === '[') {
      i += classLength(body, i, nestedClasses);
      closed = null;
      continue;
    }
    if (char === '(') {
      i += groupHeadLength(body, i);
      stack.push(false);
      closed = null;
      continue;
    }
    if (char === ')') {
      const inner = stack.length > 1 ? stack.pop() === true : false;
      if (inner) stack[stack.length - 1] = true;
      closed = inner;
      i += 1;
      continue;
    }

    const quantifier = readQuantifier(body, i);
    if (quantifier) {
      if (closed === true && quantifier.max > 1) return NESTED_QUANTIFIER;
      if (quantifier.min !== quantifier.max) stack[stack.length - 1] = true;
      i += quantifier.length;
      closed = null;
      continue;
    }

    closed = null;
    i += 1;
  }

  return null;
}

// ---------------------------------------------------------------- ワーカー

export interface RegexStatement {
  sql: string;
  params: readonly SqlParam[];
  mode: 'all' | 'get';
}

export interface RegexRunOptions {
  /** 読み取り専用で開き直す DB ファイル */
  path: string;
  timeoutMs: number;
  /** regexp() を評価してよい回数 (走査の上限) */
  budget: number;
}

export interface RegexRunResult {
  results: unknown[];
  /** 実際に regexp() を評価した回数 */
  evaluated: number;
}

const DRIVER = createRequire(import.meta.url).resolve('better-sqlite3');

// ワーカーの中身。TypeScript のローダーを通さずに起動できるよう素の JS で書く
// (execArgv を空にして tsx を読み込ませない。起動は 20ms ほどで済む)。
// regexp() の挙動 (/body/flags の解釈・不正なパターンは不一致・NULL は不一致) は
// 以前メインスレッドにあった実装と同じ。
const WORKER_SOURCE = `
'use strict';
const { workerData } = require('node:worker_threads');
const { port, flag, driver, path, statements, budget, maxInput } = workerData;
let evaluated = 0;
let reply;
try {
  const Database = require(driver);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma('cache_size = -16384');
    const compiled = new Map();
    const compile = (pattern) => {
      if (compiled.has(pattern)) return compiled.get(pattern);
      const match = /^\\/(.*)\\/([a-z]*)$/s.exec(pattern);
      let regex = null;
      try { regex = match ? new RegExp(match[1], match[2]) : new RegExp(pattern, 'i'); } catch { regex = null; }
      compiled.set(pattern, regex);
      return regex;
    };
    db.function('regexp', { deterministic: true }, (pattern, value) => {
      if (value == null) return 0;
      if (evaluated >= budget) throw new Error('regex scan budget exceeded');
      evaluated += 1;
      const regex = compile(String(pattern));
      if (!regex) return 0;
      const text = String(value);
      try {
        regex.lastIndex = 0;
        return regex.test(text.length > maxInput ? text.slice(0, maxInput) : text) ? 1 : 0;
      } catch {
        return 0;
      }
    });
    const results = statements.map(({ sql, params, mode }) => {
      const statement = db.prepare(sql);
      return mode === 'get' ? (statement.get(...params) ?? null) : statement.all(...params);
    });
    reply = { ok: true, results, evaluated };
  } finally {
    db.close();
  }
} catch (error) {
  const message = String((error && error.message) || error).slice(0, 300);
  reply = { ok: false, budget: message.includes('regex scan budget exceeded'), message, evaluated };
}
try {
  port.postMessage(reply);
} catch (error) {
  port.postMessage({ ok: false, budget: false, message: 'regex worker could not send its result', evaluated });
}
Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);
`;

type WorkerReply =
  | { ok: true; results: unknown[]; evaluated: number }
  | { ok: false; budget: boolean; message: string; evaluated: number };

function parseReply(value: unknown): WorkerReply {
  if (!isRecord(value)) throw new Error('regex worker returned no result');
  const evaluatedValue = field(value, 'evaluated');
  const evaluated = typeof evaluatedValue === 'number' && Number.isFinite(evaluatedValue) ? evaluatedValue : 0;

  if (field(value, 'ok') === true) {
    const results = field(value, 'results');
    if (!Array.isArray(results)) throw new Error('regex worker returned a malformed result');
    return { ok: true, results, evaluated };
  }

  const message = field(value, 'message');
  return {
    ok: false,
    budget: field(value, 'budget') === true,
    message: typeof message === 'string' ? message : 'regex worker failed',
    evaluated
  };
}

/**
 * SQL をワーカーの読み取り専用接続で順に実行し、結果を同期で返す。
 *
 * 呼び出し側 (search() など) は同期の API なので Atomics.wait で待つ。
 * timeoutMs を過ぎたらワーカーを止めて RegexTimedOut を投げる。止めたワーカーは
 * V8 の割り込みで正規表現の途中でも打ち切られる (待ち続けることはない)。
 */
export function runRegexStatements(statements: readonly RegexStatement[], { path, timeoutMs, budget }: RegexRunOptions): RegexRunResult {
  if (!path || path === ':memory:') throw new RegexUnavailable('regex search needs a file-backed archive');

  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    execArgv: [],
    workerData: { port: port2, flag, driver: DRIVER, path, statements, budget, maxInput: REGEX_MAX_INPUT_LENGTH },
    transferList: [port2],
    resourceLimits: { maxOldGenerationSizeMb: 256 }
  });
  // 結果を受け取った後のワーカーがプロセスの終了を引き止めないようにする
  worker.unref();
  // 落ちたワーカーの 'error' を拾わないとプロセスごと落ちる。結果は時間切れとして扱う
  worker.on('error', (error: Error) => {
    console.warn('archive regex worker failed:', error.message);
  });

  try {
    const waited = Atomics.wait(flag, 0, 0, Math.max(1, timeoutMs));
    if (waited === 'timed-out') {
      void worker.terminate();
      throw new RegexTimedOut(`regex search did not finish within ${timeoutMs}ms`);
    }

    const reply = parseReply(receiveMessageOnPort(port1)?.message);
    if (reply.ok) return { results: reply.results, evaluated: reply.evaluated };
    if (reply.budget) throw new RegexBudgetExceeded('regex scan budget exceeded');
    throw new Error(reply.message);
  } finally {
    port1.close();
  }
}
