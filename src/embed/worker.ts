// 埋め込みワーカーのライフサイクル。
//
// emotion.ts の spawn トランスポートを踏襲するが、2点を変える。
//   1. モデルのロードは1回だけ。プロセスを立てたままにする (常駐)。
//      1件ごとにロードしていると数十万件のバックフィルは不可能。
//   2. stdout を全部文字列連結しない。行単位で切り出して捨てる。
//      既存の analyzeEmotion は全出力を溜めるので、ストリーミングでは破綻する。
//
// 使われない間はアイドルで落とすので、24時間 1GiB 常駐にはならない。

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isRecord, type JsonRecord } from '../ai/types.js';
import { embedConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, '../../scripts/embed-texts.py');

const MAX_LINE = 8 * 1024 * 1024;
const STDERR_RING = 20;
const BACKOFF_MS = [1000, 5000, 30_000];
const CIRCUIT_BREAK_MS = 600_000;

export type EmbedKind = 'passage' | 'query';
export type EmbedEncode = 'int8' | 'float32';

/** 1回の embed の結果。vectors は base64、scales は int8 の逆量子化の倍率 (float32 は 1)。 */
export interface EmbedReply extends JsonRecord {
  id: number;
  ok: true;
  dim: number;
  vectors: string[];
  scales: number[];
}

/** 起動時の ready の行 (モデル名・次元など)。 */
export type WorkerInfo = JsonRecord;

interface EmbedPayload {
  op: 'embed';
  kind: EmbedKind;
  encode: EmbedEncode;
  texts: readonly string[];
}

interface Task {
  payload: EmbedPayload;
  resolve: (message: EmbedReply) => void;
  reject: (error: unknown) => void;
}

interface PendingEntry {
  resolve: (message: EmbedReply) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

type WorkerProcess = ChildProcessByStdio<Writable, Readable, Readable>;

let child: WorkerProcess | null = null;
let ready: Promise<WorkerInfo> | null = null;
let info: WorkerInfo | null = null;
let nextId = 1;

const pending = new Map<number, PendingEntry>(); // id -> { resolve, reject, timer }
const queue: Task[] = []; // { payload, resolve, reject, priority }
let inFlight = false;
let stderrRing: string[] = [];
let idleTimer: NodeJS.Timeout | null = null;
let failures = 0;
let disabledUntil = 0;

// ワーカーに渡す環境変数。bot の秘密 (DISCORD_TOKEN・OPENROUTER_API_KEY・GOVERNANCE_LAW_API_TOKEN など) は渡さない
// (モデルのコードは外から来る)。Hugging Face の設定 (HF_TOKEN を含む) はモデルの取得に要るので残す。
// TOKENIZERS_PARALLELISM のような設定は名前の途中に TOKEN があるだけなので残る
const SECRET_ENV = /SECRET|PASSWORD|PASSWD|CREDENTIAL|(TOKEN|_KEY)$/i;

function workerEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => value !== undefined && (key.startsWith('HF_') || !SECRET_ENV.test(key))));
}

function recordStderr(text: unknown): void {
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    stderrRing.push(line.slice(0, 300));
    if (stderrRing.length > STDERR_RING) stderrRing.shift();
  }
}

function stderrTail(): string {
  return stderrRing.slice(-5).join(' | ') || '(no stderr)';
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleShutdown(): void {
  clearIdleTimer();
  if (!child) return;

  idleTimer = setTimeout(() => {
    if (pending.size === 0 && queue.length === 0) shutdown();
  }, embedConfig.idleMs);
  idleTimer.unref?.();
}

function rejectAll(error: unknown): void {
  for (const [id, entry] of pending) {
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  for (let task = queue.shift(); task; task = queue.shift()) {
    task.reject(error);
  }
}

function teardown(error: unknown): void {
  const dying = child;
  child = null;
  ready = null;
  info = null;
  inFlight = false;
  clearIdleTimer();

  if (dying) {
    try {
      dying.kill('SIGKILL');
    } catch {
      // 既に死んでいる
    }
  }

  rejectAll(error);
}

export function shutdown(): void {
  if (!child) return;

  try {
    child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`);
  } catch {
    // 書けないなら殺すだけ
  }

  const dying = child;
  setTimeout(() => {
    try {
      dying.kill('SIGTERM');
    } catch { /* ignore */ }
  }, 2000).unref?.();

  teardown(new Error('embed worker shut down'));
}

// bot が落ちるときに 1GiB の python を残さない
process.once('exit', () => {
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch { /* ignore */ }
  }
});

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
const isNumberList = (value: unknown): value is number[] => Array.isArray(value) && value.every((item: unknown) => typeof item === 'number');

/** ワーカーが返した行は形を確かめてから使う (ベクトルと倍率が揃っていること)。 */
function isEmbedReply(message: JsonRecord): message is EmbedReply {
  return message.ok === true && typeof message.id === 'number' && typeof message.dim === 'number'
    && isStringList(message.vectors) && isNumberList(message.scales);
}

function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    recordStderr(`unparsable line: ${line.slice(0, 200)}`);
    return;
  }
  if (!isRecord(message)) {
    recordStderr(`unexpected line: ${line.slice(0, 200)}`);
    return;
  }

  if (message.op === 'log') {
    if (message.level === 'error') console.error('embed worker:', message.message);
    return;
  }

  if (message.op === 'ready') {
    info = message;
    return;
  }

  if (typeof message.id !== 'number') return;
  const entry = pending.get(message.id);
  if (!entry) return;

  pending.delete(message.id);
  clearTimeout(entry.timer);

  if (isEmbedReply(message)) entry.resolve(message);
  else if (message.ok) entry.reject(new Error('embed worker returned a malformed reply'));
  else entry.reject(new Error(typeof message.error === 'string' ? message.error : 'embed failed'));
}

function start(): Promise<WorkerInfo> {
  if (ready) return ready;

  if (Date.now() < disabledUntil) {
    return Promise.reject(new Error('embed worker is temporarily disabled after repeated failures'));
  }

  stderrRing = [];

  ready = new Promise<WorkerInfo>((resolvePromise, reject) => {
    let settled = false;
    let worker: WorkerProcess;

    try {
      worker = spawn(embedConfig.pythonBin, [scriptPath], {
        env: {
          ...workerEnv(),
          SEMANTIC_MODEL_NAME: embedConfig.modelName,
          ...(embedConfig.modelRevision ? { SEMANTIC_MODEL_REVISION: embedConfig.modelRevision } : {}),
          SEMANTIC_MAX_LENGTH: String(embedConfig.maxLength),
          SEMANTIC_THREADS: String(embedConfig.threads),
          SEMANTIC_MICRO_BATCH: String(embedConfig.microBatch),
          SEMANTIC_NICE: String(embedConfig.nice)
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      child = worker;
    } catch (error) {
      ready = null;
      reject(error);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`embed worker did not become ready in ${embedConfig.startupTimeoutMs}ms: ${stderrTail()}`);
      teardown(error);
      reject(error);
    }, embedConfig.startupTimeoutMs);
    timer.unref?.();

    // 行単位で切り出して即捨てる。全部溜めるとバックフィルで破綻する。
    let buffer = '';
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', (chunk: string) => {
      buffer += chunk;

      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) handleLine(line);
        index = buffer.indexOf('\n');
      }

      if (buffer.length > MAX_LINE) {
        const error = new Error('embed worker produced an oversized line');
        teardown(error);
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
        return;
      }

      if (!settled && info) {
        settled = true;
        clearTimeout(timer);
        failures = 0;
        resolvePromise(info);
      }
    });

    worker.stderr.setEncoding('utf8');
    worker.stderr.on('data', (chunk: string) => recordStderr(chunk));

    worker.on('error', (error) => {
      teardown(error);
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    });

    worker.on('exit', (code, signal) => {
      const error = new Error(`embed worker exited (code=${code} signal=${signal}): ${stderrTail()}`);

      failures += 1;
      if (failures >= BACKOFF_MS.length) {
        disabledUntil = Date.now() + CIRCUIT_BREAK_MS;
        console.error(`embed worker failed ${failures} times. Disabling for 10 minutes.`);
      }

      teardown(error);
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    });
  });

  return ready;
}

function pump(): void {
  if (inFlight || queue.length === 0 || !child) return;

  const task = queue.shift();
  if (!task) return;
  const worker = child;
  inFlight = true;

  const id = nextId++;
  const payload = { id, ...task.payload };
  const timeoutMs = task.payload.kind === 'query'
    ? embedConfig.queryTimeoutMs
    : embedConfig.requestTimeoutMs + 250 * (task.payload.texts?.length ?? 1);

  const timer = setTimeout(() => {
    pending.delete(id);
    inFlight = false;
    // 固まった torch は待っても戻らないので、殺して作り直す
    const error = new Error(`embed request timed out after ${timeoutMs}ms`);
    teardown(error);
    task.reject(error);
  }, timeoutMs);
  timer.unref?.();

  pending.set(id, {
    resolve: (message) => {
      inFlight = false;
      task.resolve(message);
      scheduleIdleShutdown();
      pump();
    },
    reject: (error) => {
      inFlight = false;
      task.reject(error);
      pump();
    },
    timer
  });

  try {
    worker.stdin.write(`${JSON.stringify(payload)}\n`);
  } catch (error) {
    pending.delete(id);
    clearTimeout(timer);
    inFlight = false;
    task.reject(error);
  }
}

/**
 * 文章をベクトルにする。
 * kind:'query' は優先度が高い — Discord のユーザーがバックフィル1バッチ
 * (約200ms) 以上待たないように、キューの先頭に差し込む。
 */
export async function embedTexts(texts: readonly string[],
  { kind = 'passage', encode = 'int8' }: { kind?: EmbedKind; encode?: EmbedEncode } = {}): Promise<EmbedReply> {
  if (!embedConfig.enabled) throw new Error('semantic search is disabled');

  await start();
  clearIdleTimer();

  return new Promise<EmbedReply>((resolvePromise, reject) => {
    const task: Task = { payload: { op: 'embed', kind, encode, texts }, resolve: resolvePromise, reject };
    if (kind === 'query') queue.unshift(task);
    else queue.push(task);
    pump();
  });
}

/** ロードだけ先に始める。await しないで呼ぶ。 */
export function prewarm(): void {
  if (!embedConfig.enabled || !embedConfig.prewarm) return;
  if (child || Date.now() < disabledUntil) return;

  start().then(() => scheduleIdleShutdown()).catch(() => {
    // 前もってのロードなので、失敗しても黙って諦める (実際の呼び出しで報告される)
  });
}

export function workerInfo(): WorkerInfo | null {
  return info;
}

export function isDisabled(): boolean {
  return Date.now() < disabledUntil;
}
