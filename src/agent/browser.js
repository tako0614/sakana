// ブラウザ操作ツール。外付け Chrome (deckide が 9222 に常駐させている共有ブラウザ) を CDP で叩く。
//
// 「Chrome が提供するやつ全部」を出したいが、ツール定義を15個並べると
// 毎ターンその分のトークンを払うことになる。なので tool は `browser` 1つだけにして、
// action の enum で全機能に振り分ける。生 CDP の抜け穴 (action: "cdp") も用意して、
// ここに実装していないドメインも呼べるようにしてある。

import { agentConfig } from './config.js';
import {
  activatePage,
  closePage,
  createIsolatedPage,
  createPage,
  getSession,
  listPages
} from './cdp.js';
import { truncate } from './format.js';

// 閲覧するだけの action。誰でも使える。
const READ_ACTIONS = new Set([
  'open', 'text', 'html', 'links', 'screenshot', 'wait',
  'back', 'forward', 'reload', 'scroll', 'console', 'network'
]);

// ブラウザを操作する / 既存タブを覗く action。
// 共有ブラウザにはオーナーのログインセッションが載っているので、既定では信頼済みの人だけ。
const FULL_ACTIONS = new Set([
  'click', 'type', 'key', 'eval', 'cdp', 'tabs', 'tab', 'new_tab', 'close_tab'
]);

const MAX_SCREENSHOTS = 2;

// 信頼されていない人向けの隔離タブ。オーナーが開いている業務タブを読ませないため、
// この bot が自分で作ったタブだけを触らせる。
let sandboxTargetId = null;

export const browserToolDefinition = {
  type: 'function',
  function: {
    name: 'browser',
    description: [
      '外付け Chrome を操作する。貼られた URL の中身を実際に開いて確かめるときに使う。',
      'action: open(url を開いて本文を返す) / text(本文) / links(リンク一覧) / html /',
      'screenshot(返信に画像を添付) / click / type / key / scroll / wait / eval /',
      'back / forward / reload / tabs / tab / new_tab / close_tab / console / network /',
      'cdp(生の CDP メソッド)。'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '実行する操作' },
        url: { type: 'string', description: 'open / new_tab で開く URL' },
        selector: { type: 'string', description: 'click / type / scroll / wait の対象 CSS セレクタ' },
        text: { type: 'string', description: 'type で入力する文字列' },
        key: { type: 'string', description: 'key で押すキー (Enter / Escape / Tab など)' },
        expression: { type: 'string', description: 'eval で評価する JavaScript' },
        method: { type: 'string', description: 'cdp で呼ぶメソッド名 (例: Page.printToPDF)' },
        params: { type: 'object', description: 'cdp のパラメータ' },
        dy: { type: 'number', description: 'scroll の縦移動量 (px)' },
        ms: { type: 'number', description: 'wait の待ち時間 (ms)' },
        index: { type: 'number', description: 'tab / close_tab の対象タブ番号' },
        submit: { type: 'boolean', description: 'type のあとに Enter を押すか' }
      },
      required: ['action']
    }
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeUrl(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('url を指定してください。');

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);

  const allowed = agentConfig.browserAllowLocal
    ? new Set(['http:', 'https:', 'file:', 'about:', 'data:', 'chrome:'])
    : new Set(['http:', 'https:', 'about:']);

  if (!allowed.has(parsed.protocol)) {
    throw new Error(`このスキームは許可されていません: ${parsed.protocol}`);
  }

  if (!agentConfig.browserAllowLocal && /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(parsed.hostname)) {
    throw new Error('ローカル/内部ネットワークへのアクセスは許可されていません。');
  }

  return parsed.href;
}

/**
 * 隔離タブを用意する。信頼されていない人はこのタブしか触れない。
 *
 * 重要: 共有プロファイルに普通のタブを作ると Cookie を引き継ぐので、
 * オーナーがログイン済みのサイト (管理画面や決済ダッシュボード) を
 * 誰でも開いて読めてしまう。必ず独立コンテキストで作る。
 */
async function getSandboxSession() {
  const pages = await listPages();

  if (sandboxTargetId && !pages.some((page) => page.id === sandboxTargetId)) {
    sandboxTargetId = null;
    sandboxContextId = null;
  }

  if (!sandboxTargetId) {
    const created = await createIsolatedPage('about:blank');
    sandboxTargetId = created?.targetId ?? null;
    sandboxContextId = created?.browserContextId ?? null;
    if (!sandboxTargetId) throw new Error('ブラウザのタブを開けませんでした。');
  }

  return getSession(sandboxTargetId);
}

function resolveSession(ctx) {
  return ctx.browserFull ? getSession() : getSandboxSession();
}

async function waitForLoad(session, timeoutMs = agentConfig.browserTimeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await session.evaluate('document.readyState').catch(() => null);
    if (state === 'complete' || state === 'interactive') return;
    await sleep(200);
  }
}

const READABLE_SNIPPET = `(() => {
  const pick = document.querySelector('article, main, [role="main"]') || document.body;
  return {
    title: document.title || '',
    url: location.href,
    text: (pick && pick.innerText) || ''
  };
})()`;

async function readPage(session, limit) {
  const page = await session.evaluate(READABLE_SNIPPET);
  if (!page) return 'ページを読み取れませんでした。';

  return [
    `title: ${truncate(page.title, 200)}`,
    `url: ${page.url}`,
    '---',
    truncate(page.text, limit) || '(本文が取れませんでした。JS 描画待ちなら wait を挟んでください)'
  ].join('\n');
}

async function boundingBox(session, selector) {
  const box = await session.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`);

  if (!box) throw new Error(`要素が見つかりません: ${selector}`);
  return box;
}

export async function runBrowserAction(ctx, args = {}) {
  const action = String(args.action ?? '').trim().toLowerCase();

  if (!action) return 'action を指定してください。';

  if (!READ_ACTIONS.has(action) && !FULL_ACTIONS.has(action)) {
    return `未対応の action です: ${action}`;
  }

  if (FULL_ACTIONS.has(action) && !ctx.browserFull) {
    return [
      `action "${action}" はブラウザを操作する権限が必要なので、この人には許可されていません。`,
      'open / text / links / screenshot などの閲覧系だけ使えます。'
    ].join(' ');
  }

  const session = await resolveSession(ctx);
  const textLimit = agentConfig.browserTextChars;

  switch (action) {
    case 'open': {
      const url = normalizeUrl(args.url);
      await session.send('Page.navigate', { url });
      await waitForLoad(session);
      await sleep(300); // 描画が追いつくまで少し待つ
      return readPage(session, textLimit);
    }

    case 'text':
      return readPage(session, textLimit);

    case 'html': {
      const html = await session.evaluate('document.documentElement.outerHTML');
      return truncate(html, textLimit);
    }

    case 'links': {
      const links = await session.evaluate(`(() => {
        const out = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.href;
          if (!href || seen.has(href) || href.startsWith('javascript:')) continue;
          seen.add(href);
          const label = (a.innerText || a.title || '').replace(/\\s+/g, ' ').trim();
          out.push({ label: label.slice(0, 80), href });
          if (out.length >= 40) break;
        }
        return out;
      })()`);

      if (!links?.length) return 'リンクが見つかりませんでした。';
      return links.map((link) => `- ${link.label || '(no text)'} → ${link.href}`).join('\n');
    }

    case 'screenshot': {
      if (ctx.screenshots.length >= MAX_SCREENSHOTS) {
        return `スクリーンショットは1回の実行で ${MAX_SCREENSHOTS} 枚までです。`;
      }

      const shot = await session.send('Page.captureScreenshot', { format: 'png' });
      if (!shot?.data) return 'スクリーンショットを取得できませんでした。';

      ctx.screenshots.push(Buffer.from(shot.data, 'base64'));
      const info = await session.evaluate('({ title: document.title, url: location.href })');

      // 画像自体はモデルに渡さない (テキストモデルだし、渡せてもトークンが重い)。
      // 返信に添付して人間に見せる。
      return [
        `スクリーンショットを撮って返信に添付しました (${ctx.screenshots.length}枚目)。`,
        `title: ${truncate(info?.title, 200)}`,
        `url: ${info?.url}`
      ].join('\n');
    }

    case 'click': {
      if (!args.selector) return 'click には selector を指定してください。';

      const box = await boundingBox(session, args.selector);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await session.send('Input.dispatchMouseEvent', {
          type,
          x: box.x,
          y: box.y,
          button: 'left',
          clickCount: 1
        });
      }

      await sleep(400);
      await waitForLoad(session, 5000);
      return `クリックしました: ${args.selector}`;
    }

    case 'type': {
      if (!args.selector) return 'type には selector を指定してください。';

      const box = await boundingBox(session, args.selector);
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await session.send('Input.insertText', { text: String(args.text ?? '') });

      if (args.submit) {
        for (const type of ['keyDown', 'keyUp']) {
          await session.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        }
        await sleep(500);
        await waitForLoad(session, 8000);
      }

      return `入力しました: ${args.selector}`;
    }

    case 'key': {
      const key = String(args.key ?? '');
      if (!key) return 'key を指定してください。';

      for (const type of ['keyDown', 'keyUp']) {
        await session.send('Input.dispatchKeyEvent', { type, key, code: key });
      }
      return `${key} を押しました。`;
    }

    case 'scroll': {
      if (args.selector) {
        await boundingBox(session, args.selector);
        return `${args.selector} までスクロールしました。`;
      }

      const dy = Number(args.dy ?? 600);
      await session.evaluate(`window.scrollBy(0, ${dy})`);
      return `${dy}px スクロールしました。`;
    }

    case 'wait': {
      if (args.selector) {
        const deadline = Date.now() + Math.min(Number(args.ms ?? 10_000), agentConfig.browserTimeoutMs);
        while (Date.now() < deadline) {
          const found = await session.evaluate(`Boolean(document.querySelector(${JSON.stringify(args.selector)}))`);
          if (found) return `${args.selector} が現れました。`;
          await sleep(300);
        }
        return `${args.selector} は現れませんでした。`;
      }

      await sleep(Math.min(Number(args.ms ?? 1000), 10_000));
      return '待ちました。';
    }

    case 'back':
    case 'forward': {
      const history = await session.send('Page.getNavigationHistory');
      const target = history.currentIndex + (action === 'back' ? -1 : 1);
      const entry = history.entries?.[target];
      if (!entry) return `${action} できる履歴がありません。`;

      await session.send('Page.navigateToHistoryEntry', { entryId: entry.id });
      await waitForLoad(session);
      return readPage(session, Math.min(textLimit, 1500));
    }

    case 'reload': {
      await session.send('Page.reload');
      await waitForLoad(session);
      return readPage(session, Math.min(textLimit, 1500));
    }

    case 'eval': {
      if (!args.expression) return 'expression を指定してください。';
      const value = await session.evaluate(String(args.expression));
      const rendered = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      return truncate(rendered, textLimit);
    }

    case 'cdp': {
      if (!args.method) return 'method を指定してください。';
      const result = await session.send(String(args.method), args.params ?? undefined);
      return truncate(JSON.stringify(result ?? null), textLimit);
    }

    case 'tabs': {
      const pages = await listPages();
      if (!pages.length) return 'タブがありません。';
      return pages
        .map((page, index) => `${index + 1}) ${truncate(page.title, 80)} → ${page.url}`)
        .join('\n');
    }

    case 'tab': {
      const pages = await listPages();
      const page = pages[Number(args.index ?? 1) - 1];
      if (!page) return 'そのタブはありません。tabs で番号を確認してください。';

      await activatePage(page.id);
      await getSession(page.id);
      return `タブ ${args.index} に切り替えました: ${truncate(page.title, 80)}`;
    }

    case 'new_tab': {
      const url = args.url ? normalizeUrl(args.url) : 'about:blank';
      const created = await createPage(url);
      if (!created?.id) return 'タブを開けませんでした。';

      const next = await getSession(created.id);
      await waitForLoad(next);
      return readPage(next, Math.min(textLimit, 2000));
    }

    case 'close_tab': {
      if (!Number.isFinite(Number(args.index))) {
        return 'close_tab には index を指定してください (tabs で番号を確認)。';
      }

      const pages = await listPages();
      const page = pages[Number(args.index) - 1];
      if (!page) return 'そのタブはありません。';

      await closePage(page.id);
      return `タブ ${args.index} を閉じました。`;
    }

    case 'console': {
      const entries = session.consoleLog.slice(-20);
      if (!entries.length) return 'console には何も出ていません。';
      return entries.map((entry) => `[${entry.level}] ${truncate(entry.text, 200)}`).join('\n');
    }

    case 'network': {
      const entries = session.requests.slice(-25);
      if (!entries.length) return '記録されたリクエストがありません。';
      return entries.map((entry) => `${entry.status} ${entry.type} ${truncate(entry.url, 160)}`).join('\n');
    }

    default:
      return `未対応の action です: ${action}`;
  }
}
