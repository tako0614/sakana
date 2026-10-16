// Chrome DevTools Protocol の最小クライアント。
//
// deckide (src/utils/agent-browser.ts) と同じ考え方だが、こちらは「外付け」に徹する:
// Chrome を起動も終了もせず、既に 9222 で待っている共有ブラウザに相乗りするだけ。
// deckide 側が keepAlive で常駐させているので、こちらは繋ぐだけで済む。
// ブラウザが居なければブラウザ系のツールを丸ごと出さない (トークンの節約にもなる)。
//
// Chrome から返ってくるものはすべて unknown として受け、使う側で形を確かめる。

import { agentConfig } from './config.js';
import { isRecord, recordField, stringField } from './types.js';

// Node 22 以降は global の WebSocket が使える (package.json の engines は >=22.13)。
// 以前は無いときに ws へ落としていたが、対応する Node では通らない道で、型も無いので外した。
function createSocket(url: string): WebSocket {
  if (typeof WebSocket !== 'function') {
    throw new Error('この Node には WebSocket がありません (Node 22 以降が必要です)。');
  }
  return new WebSocket(url);
}

function endpoint(path: string): string {
  return `http://${agentConfig.cdpHost}:${agentConfig.cdpPort}${path}`;
}

async function fetchJson(path: string, { method = 'GET', timeoutMs = 5000 }: { method?: string; timeoutMs?: number } = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const response = await fetch(endpoint(path), { method, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`CDP ${path} failed (${response.status})`);
    }

    const text = await response.text();
    if (!text) return null;

    try {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timer);
  }
}

// 生存確認は呼び出しごとに走るので、結果を少しキャッシュする。
// Chrome が居ないときに毎回 1.5 秒待たされるのを避けるため。
let probeCache = { at: 0, alive: false };
const PROBE_TTL_MS = 60_000;

/** 9222 に Chrome が居るか。居なければブラウザ系ツールを登録しない。 */
export async function cdpAvailable(): Promise<boolean> {
  if (!agentConfig.browserEnabled) return false;

  if (Date.now() - probeCache.at < PROBE_TTL_MS) {
    return probeCache.alive;
  }

  let alive = false;
  try {
    await fetchJson('/json/version', { timeoutMs: 1500 });
    alive = true;
  } catch {
    alive = false;
  }

  probeCache = { at: Date.now(), alive };
  return alive;
}

/** /json/list の1件。使う項目だけ確かめて持つ。 */
export interface PageTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string | undefined;
}

function toPageTarget(value: unknown): PageTarget | null {
  const id = stringField(value, 'id');
  const type = stringField(value, 'type');
  if (!id || !type) return null;
  return {
    id,
    type,
    title: stringField(value, 'title') ?? '',
    url: stringField(value, 'url') ?? '',
    webSocketDebuggerUrl: stringField(value, 'webSocketDebuggerUrl')
  };
}

export async function listPages(): Promise<PageTarget[]> {
  const targets = await fetchJson('/json/list');
  return (Array.isArray(targets) ? targets : [])
    .map(toPageTarget)
    .filter((target): target is PageTarget => (
      target !== null && target.type === 'page' && !target.url.startsWith('devtools://')
    ));
}

export async function createPage(url = 'about:blank'): Promise<unknown> {
  // 新しい Chrome は /json/new を PUT でしか受けない。
  return fetchJson(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
}

// ブラウザ全体に繋ぐ接続。タブの作成/破棄と、独立コンテキストの作成に使う。
let browserSession: CdpSession | null = null;

async function getBrowserSession(): Promise<CdpSession> {
  if (browserSession && !browserSession.closed && browserSession.socket.readyState === 1) {
    return browserSession;
  }

  const version = await fetchJson('/json/version');
  const url = stringField(version, 'webSocketDebuggerUrl');
  if (!url) throw new Error('ブラウザの DevTools エンドポイントが取れませんでした。');

  const socket = createSocket(url);
  await waitForOpen(socket);
  browserSession = new CdpSession(socket, 'browser');
  return browserSession;
}

/**
 * Cookie も storage も共有しない独立コンテキストにタブを作る。
 *
 * 共有プロファイルにタブを足すだけでは、オーナーのログイン状態をそのまま
 * 引き継いでしまう (誰でも Stripe や管理画面を開いて読めてしまう)。
 * 信頼していない相手にブラウザを触らせるときは必ずこちらを使う。
 */
export async function createBrowserContext(): Promise<string> {
  const browser = await getBrowserSession();
  const result = await browser.send('Target.createBrowserContext', {
    disposeOnDetach: false
  });
  const browserContextId = stringField(result, 'browserContextId');
  // 無いまま進むと createTarget が既定プロファイル (ログイン済み) にタブを作る。ここで止める
  if (!browserContextId) throw new Error('隔離したブラウザのコンテキストを作れませんでした。');
  return browserContextId;
}

/** 指定したコンテキストにタブを足す。同じ実行の中で複数タブを開くときに使う。 */
export async function createPageInContext(url: string, browserContextId: string): Promise<string | null> {
  const browser = await getBrowserSession();
  const result = await browser.send('Target.createTarget', { url, browserContextId });
  return stringField(result, 'targetId') ?? null;
}

export async function createIsolatedPage(url = 'about:blank'): Promise<{ targetId: string | null; browserContextId: string }> {
  const browserContextId = await createBrowserContext();
  const targetId = await createPageInContext(url, browserContextId);
  return { targetId, browserContextId };
}

export async function disposeBrowserContext(browserContextId: string | null | undefined): Promise<void> {
  if (!browserContextId) return;
  try {
    const browser = await getBrowserSession();
    await browser.send('Target.disposeBrowserContext', { browserContextId });
  } catch {
    // 既に消えている場合は何もしない
  }
}

/** 送信と購読だけを持つ CDP 接続。CdpSession が満たす (検証では偽物を渡す)。 */
export interface CdpConnection {
  send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    sessionId?: string
  ): Promise<unknown>;
  on(method: string, handler: CdpHandler): () => void;
}

/**
 * 隔離コンテキストの中でページが開いたポップアップ (window.open / target=_blank) を閉じる。
 *
 * ポップアップは元のタブとは別のターゲットなので、元のタブに張った通信の検査が届かない。
 * そこでは何を読み込まれても見張れないうえ、同じオリジンの元ページから触れる。
 * 自分で作ったタブには opener が付かないので、opener が付いたページだけを閉じればよい。
 * browser には、ブラウザ全体に繋いだ接続を渡す。戻り値は購読の解除。
 */
export async function watchPopups(browser: CdpConnection, browserContextId: string): Promise<() => void> {
  const stop = browser.on('Target.targetCreated', (params) => {
    const info = recordField(params, 'targetInfo');
    if (stringField(info, 'browserContextId') !== browserContextId) return;
    if (stringField(info, 'type') !== 'page' || stringField(info, 'openerId') === undefined) return;

    const targetId = stringField(info, 'targetId');
    if (targetId) browser.send('Target.closeTarget', { targetId }).catch(() => {});
  });

  try {
    await browser.send('Target.setDiscoverTargets', { discover: true });
  } catch (error) {
    stop();
    throw error;
  }

  return stop;
}

export async function closePopupsIn(browserContextId: string): Promise<() => void> {
  return watchPopups(await getBrowserSession(), browserContextId);
}

export async function closePage(targetId: string): Promise<void> {
  await fetchJson(`/json/close/${targetId}`);
  sessions.get(targetId)?.close();
  sessions.delete(targetId);
  if (activeTargetId === targetId) activeTargetId = null;
}

export async function activatePage(targetId: string): Promise<void> {
  await fetchJson(`/json/activate/${targetId}`);
  activeTargetId = targetId;
}

const RING_SIZE = 50;

export interface ConsoleEntry {
  level: string | undefined;
  text: string | undefined;
}

export interface RequestEntry {
  method: string;
  status: number | undefined;
  type: string | undefined;
  url: string | undefined;
}

/**
 * イベントの購読口。params は Chrome から来たままなので unknown。
 * sessionId は子のターゲット (別プロセスの iframe など、Target.setAutoAttach で付いたもの) の
 * イベントのときだけ入る。返事を返すときは同じ sessionId で送る。
 */
export type CdpHandler = (params: unknown, sessionId: string | undefined) => unknown;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function messageText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return null;
}

export class CdpSession {
  socket: WebSocket;
  targetId: string;
  nextId: number;
  pending: Map<number, Pending>;
  closed: boolean;
  consoleLog: ConsoleEntry[];
  requests: RequestEntry[];
  listeners: Map<string, Set<CdpHandler>>;

  constructor(socket: WebSocket, targetId: string) {
    this.socket = socket;
    this.targetId = targetId;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;

    // console / network はイベントで流れてくるので、接続中ずっと拾って輪バッファに溜める。
    this.consoleLog = [];
    this.requests = [];

    // Fetch.requestPaused のように、呼び出し側が返事をしないとページが止まる
    // イベントがあるので、method ごとの購読口を持つ。
    this.listeners = new Map();

    socket.addEventListener('message', (event) => this.handleMessage(event.data));
    socket.addEventListener('close', () => this.rejectAll(new Error('CDP connection closed')));
    socket.addEventListener('error', () => this.rejectAll(new Error('CDP connection error')));
  }

  handleMessage(data: unknown): void {
    const text = messageText(data);
    if (text === null) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    if (typeof parsed.id === 'number') {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;

      this.pending.delete(parsed.id);
      clearTimeout(pending.timer);

      if (parsed.error) pending.reject(new Error(stringField(parsed.error, 'message') ?? 'CDP command failed'));
      else pending.resolve(parsed.result);
      return;
    }

    const method = stringField(parsed, 'method');
    if (method) this.handleEvent(method, parsed.params, stringField(parsed, 'sessionId'));
  }

  /** method を購読する。同じ method に複数登録できる。 */
  on(method: string, handler: CdpHandler): () => void {
    let subscribed = this.listeners.get(method);
    if (!subscribed) {
      subscribed = new Set();
      this.listeners.set(method, subscribed);
    }
    subscribed.add(handler);
    return () => { this.listeners.get(method)?.delete(handler); };
  }

  handleEvent(method: string, params: unknown, sessionId?: string): void {
    const subscribed = this.listeners.get(method);
    if (subscribed) {
      for (const handler of subscribed) {
        // 購読側の失敗でイベントループを壊さない (Fetch は非同期に返事をする)
        Promise.resolve().then(() => handler(params, sessionId)).catch(() => {});
      }
    }

    // console / network の輪バッファはこのタブ自身のぶんだけ。子のターゲット
    // (iframe や worker) のイベントを混ぜると、どのページの出力か分からなくなる。
    if (sessionId !== undefined) return;

    const push = <T>(ring: T[], value: T): void => {
      ring.push(value);
      if (ring.length > RING_SIZE) ring.shift();
    };

    if (method === 'Runtime.consoleAPICalled') {
      const args = isRecord(params) && Array.isArray(params.args) ? params.args : [];
      const text = args
        .map((arg: unknown) => {
          const value = isRecord(arg) ? arg.value : undefined;
          return value ?? stringField(arg, 'description') ?? stringField(arg, 'type');
        })
        .join(' ');
      push(this.consoleLog, { level: stringField(params, 'type'), text });
      return;
    }

    if (method === 'Log.entryAdded') {
      const entry = recordField(params, 'entry');
      push(this.consoleLog, { level: stringField(entry, 'level'), text: stringField(entry, 'text') });
      return;
    }

    if (method === 'Runtime.exceptionThrown') {
      const details = recordField(params, 'exceptionDetails');
      push(this.consoleLog, {
        level: 'error',
        text: stringField(recordField(details, 'exception'), 'description') ?? stringField(details, 'text')
      });
      return;
    }

    if (method === 'Network.responseReceived') {
      const response = recordField(params, 'response');
      const status = response?.status;
      push(this.requests, {
        method: stringField(recordField(response, 'requestHeaders'), ':method') ?? 'GET',
        status: typeof status === 'number' ? status : undefined,
        type: stringField(params, 'type'),
        url: stringField(response, 'url')
      });
    }
  }

  /** sessionId を渡すと、Target.setAutoAttach で付いた子のターゲットに宛てて送る。 */
  send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = agentConfig.browserTimeoutMs,
    sessionId?: string
  ): Promise<unknown> {
    if (this.closed || this.socket.readyState !== 1) {
      return Promise.reject(new Error('CDP connection is not open'));
    }

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.socket.send(JSON.stringify({
          id,
          method,
          ...(params ? { params } : {}),
          ...(sessionId ? { sessionId } : {})
        }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Runtime.evaluate の薄いラッパ。await も通す。戻り値はページが作ったものなので unknown。 */
  async evaluate(expression: string, { returnByValue = true }: { returnByValue?: boolean } = {}): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: true
    });

    const details = recordField(result, 'exceptionDetails');
    if (details) {
      throw new Error(stringField(recordField(details, 'exception'), 'description') ?? stringField(details, 'text') ?? 'evaluate failed');
    }

    return recordField(result, 'result')?.value;
  }

  rejectAll(error: Error): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      // 閉じられないときは放置してよい (相手は外部プロセス)
    }
    this.rejectAll(new Error('CDP connection closed'));
  }
}

const sessions = new Map<string, CdpSession>(); // targetId -> CdpSession
let activeTargetId: string | null = null;

function waitForOpen(socket: WebSocket, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket connect timed out')), timeoutMs);
    timer.unref?.();

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });

    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP WebSocket connect failed'));
    }, { once: true });
  });
}

/**
 * 操作対象のタブに繋ぐ。指定が無ければ前回のタブ、それも無ければ先頭のタブ。
 * タブが1つも無ければ about:blank を開く。
 *
 * targetId を明示したときは代替に落ちない。隔離タブが消えた瞬間に
 * pages[0] (= オーナーのログイン済みタブ) を掴ませてしまうため。
 */
export async function getSession(targetId?: string | null): Promise<CdpSession> {
  let pages = await listPages();

  if (targetId && !pages.some((page) => page.id === targetId)) {
    sessions.get(targetId)?.close();
    sessions.delete(targetId);
    throw new Error('操作していたタブが閉じられました。もう一度開き直してください。');
  }

  let wanted = targetId ?? activeTargetId;
  if (wanted && !pages.some((page) => page.id === wanted)) {
    // タブが閉じられていた
    sessions.get(wanted)?.close();
    sessions.delete(wanted);
    wanted = null;
  }

  if (!wanted) {
    if (pages.length === 0) {
      await createPage('about:blank');
      pages = await listPages();
    }
    wanted = pages[0]?.id ?? null;
  }

  if (!wanted) throw new Error('操作できるタブがありません。');

  const cached = sessions.get(wanted);
  if (cached && !cached.closed && cached.socket.readyState === 1) {
    activeTargetId = wanted;
    return cached;
  }

  const page = pages.find((candidate) => candidate.id === wanted);
  if (!page?.webSocketDebuggerUrl) {
    throw new Error('このタブには DevTools で接続できません。');
  }

  const socket = createSocket(page.webSocketDebuggerUrl);
  await waitForOpen(socket);

  const session = new CdpSession(socket, wanted);
  sessions.set(wanted, session);
  activeTargetId = wanted;

  // console / network を拾うために必要な分だけ有効化する。
  await Promise.all([
    session.send('Page.enable').catch(() => {}),
    session.send('Runtime.enable').catch(() => {}),
    session.send('Log.enable').catch(() => {}),
    session.send('Network.enable').catch(() => {})
  ]);

  await applyStealth(session);

  return session;
}

// 反検知。deckide と同じ方針で「正直で整合の取れた実 Chrome」に寄せる。
// plugins や WebGL ベンダを偽装すると、かえって不整合が検知信号になるのでやらない。
// navigator.webdriver は起動フラグ --disable-blink-features=AutomationControlled で
// 既に落ちているが、保険として undefined を維持する。
const STEALTH_SOURCE = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  if (!window.chrome) { window.chrome = { runtime: {} }; }
  Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en-US', 'en'] });
  try {
    const q = window.navigator.permissions && window.navigator.permissions.query;
    if (q) {
      window.navigator.permissions.query = (p) => (
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : q(p)
      );
    }
  } catch (e) { /* ignore */ }
`;

async function applyStealth(session: CdpSession): Promise<void> {
  // best-effort。失敗してもブラウジング自体は続ける。
  await session
    .send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SOURCE })
    .catch(() => {});
}

export function getActiveTargetId(): string | null {
  return activeTargetId;
}

export function closeAllSessions(): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
  activeTargetId = null;
}
