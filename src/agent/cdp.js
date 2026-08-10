// Chrome DevTools Protocol の最小クライアント。
//
// deckide (src/utils/agent-browser.ts) と同じ考え方だが、こちらは「外付け」に徹する:
// Chrome を起動も終了もせず、既に 9222 で待っている共有ブラウザに相乗りするだけ。
// deckide 側が keepAlive で常駐させているので、こちらは繋ぐだけで済む。
// ブラウザが居なければブラウザ系のツールを丸ごと出さない (トークンの節約にもなる)。

import { agentConfig } from './config.js';

// Node 22 以降は global の WebSocket が使える。無い場合は discord.js が連れてくる ws に落とす。
async function createSocket(url) {
  if (typeof WebSocket === 'function') {
    return new WebSocket(url);
  }

  const { WebSocket: NodeWebSocket } = await import('ws');
  return new NodeWebSocket(url);
}

function endpoint(path) {
  return `http://${agentConfig.cdpHost}:${agentConfig.cdpPort}${path}`;
}

async function fetchJson(path, { method = 'GET', timeoutMs = 5000 } = {}) {
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
      return JSON.parse(text);
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
export async function cdpAvailable() {
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

export async function listPages() {
  const targets = await fetchJson('/json/list');
  return (Array.isArray(targets) ? targets : [])
    .filter((target) => target.type === 'page' && !String(target.url ?? '').startsWith('devtools://'));
}

export async function createPage(url = 'about:blank') {
  // 新しい Chrome は /json/new を PUT でしか受けない。
  return fetchJson(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
}

export async function closePage(targetId) {
  await fetchJson(`/json/close/${targetId}`);
  sessions.get(targetId)?.close();
  sessions.delete(targetId);
  if (activeTargetId === targetId) activeTargetId = null;
}

export async function activatePage(targetId) {
  await fetchJson(`/json/activate/${targetId}`);
  activeTargetId = targetId;
}

const RING_SIZE = 50;

class CdpSession {
  constructor(socket, targetId) {
    this.socket = socket;
    this.targetId = targetId;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;

    // console / network はイベントで流れてくるので、接続中ずっと拾って輪バッファに溜める。
    this.consoleLog = [];
    this.requests = [];

    socket.addEventListener('message', (event) => this.handleMessage(event.data));
    socket.addEventListener('close', () => this.rejectAll(new Error('CDP connection closed')));
    socket.addEventListener('error', () => this.rejectAll(new Error('CDP connection error')));
  }

  handleMessage(data) {
    let parsed;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }

    if (typeof parsed.id === 'number') {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;

      this.pending.delete(parsed.id);
      clearTimeout(pending.timer);

      if (parsed.error) pending.reject(new Error(parsed.error.message ?? 'CDP command failed'));
      else pending.resolve(parsed.result);
      return;
    }

    this.handleEvent(parsed);
  }

  handleEvent({ method, params }) {
    const push = (ring, value) => {
      ring.push(value);
      if (ring.length > RING_SIZE) ring.shift();
    };

    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(' ');
      push(this.consoleLog, { level: params.type, text });
      return;
    }

    if (method === 'Log.entryAdded') {
      push(this.consoleLog, { level: params.entry?.level, text: params.entry?.text });
      return;
    }

    if (method === 'Runtime.exceptionThrown') {
      push(this.consoleLog, {
        level: 'error',
        text: params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text
      });
      return;
    }

    if (method === 'Network.responseReceived') {
      push(this.requests, {
        method: params.response?.requestHeaders?.[':method'] ?? 'GET',
        status: params.response?.status,
        type: params.type,
        url: params.response?.url
      });
    }
  }

  send(method, params, timeoutMs = agentConfig.browserTimeoutMs) {
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
        this.socket.send(JSON.stringify(params ? { id, method, params } : { id, method }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Runtime.evaluate の薄いラッパ。await も通す。 */
  async evaluate(expression, { returnByValue = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: true
    });

    if (result?.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description ?? details.text ?? 'evaluate failed');
    }

    return result?.result?.value;
  }

  rejectAll(error) {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  close() {
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      // 閉じられないときは放置してよい (相手は外部プロセス)
    }
    this.rejectAll(new Error('CDP connection closed'));
  }
}

const sessions = new Map(); // targetId -> CdpSession
let activeTargetId = null;

function waitForOpen(socket, timeoutMs = 10_000) {
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
 */
export async function getSession(targetId) {
  let pages = await listPages();

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
    wanted = pages[0]?.id;
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

  const socket = await createSocket(page.webSocketDebuggerUrl);
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

  return session;
}

export function getActiveTargetId() {
  return activeTargetId;
}

export function closeAllSessions() {
  for (const session of sessions.values()) session.close();
  sessions.clear();
  activeTargetId = null;
}
