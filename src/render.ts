import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';

// HTML → 画像の描画に使う Chrome の共有部分 (きもち・よっきゅう・agent の image ツール)。
// 共有ブラウザ (agent の browser ツール、CDP の 9222) とは別に、描画のたびに headless で起動して閉じる。

// 描画に使う Chrome。以前は node-html-to-image が古い puppeteer と Chrome 128 を抱えていた (既知の脆弱性つき)
export const chromePath = process.env.EMOTION_CHROME_PATH ?? '/usr/bin/google-chrome';
export const renderTimeoutMs = 30_000;

// 描画が重い (Chrome の起動)。連打で止まらないよう同時に2件まで
const MAX_RUNNING = 2;
let running = 0;

/** 描画の枠を 1 つ取る。空いていなければ null。使い終えたら返された関数を呼ぶ (二重に呼んでも 1 回だけ返す)。 */
export function takeRenderSlot(): (() => void) | null {
  if (running >= MAX_RUNNING) return null;
  running += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running -= 1;
  };
}

/** 描画の枠 (きもち・よっきゅう・image ツール共通で同時に 2 件)。空いていなければ busy。 */
export async function withRenderSlot<T>(run: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
  const release = takeRenderSlot();
  if (!release) return { busy: true };
  try {
    return { busy: false, value: await run() };
  } finally {
    release();
  }
}

// 描画用の Chrome にも bot の秘密は渡さない
function chromeEnv(): Record<string, string> {
  const keys = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'FONTCONFIG_PATH', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'];
  return Object.fromEntries(keys.flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

// Chrome のプロファイル (毎回作って捨てる) は tmpfs に置く。本番 (CT102) は / が遅い loop デバイスで、
// 既定の /tmp に置くと、終了 (close) だけで 5〜6 秒かかっていた。tmpfs なら 0.03 秒。数十 MB を数秒だけ使う。
const PROFILE_ROOT = process.env.RENDER_PROFILE_ROOT ?? '/dev/shm';
const PROFILE_PREFIX = 'sakana-chrome-';
const STALE_PROFILE_MS = 30 * 60_000;

/** 落ちたときに残ったプロファイルを片付ける (30 分より古いものだけ。動いている描画のものには触らない)。 */
function sweepStaleProfiles(): void {
  try {
    for (const name of readdirSync(PROFILE_ROOT)) {
      if (!name.startsWith(PROFILE_PREFIX)) continue;
      const path = join(PROFILE_ROOT, name);
      if (Date.now() - statSync(path).mtimeMs > STALE_PROFILE_MS) rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // 片付けられなくても描画には関係ない
  }
}

/** tmpfs が使えればそこに、使えなければ null (puppeteer が既定の場所に作る)。 */
function makeProfileDir(): string | null {
  try {
    if (!existsSync(PROFILE_ROOT)) return null;
    sweepStaleProfiles();
    return mkdtempSync(join(PROFILE_ROOT, PROFILE_PREFIX));
  } catch {
    return null;
  }
}

/** 描画用の headless Chrome を起こす。呼んだ側が必ず close する。 */
export async function launchRenderChrome(timeoutMs = renderTimeoutMs): Promise<Browser> {
  const profile = makeProfileDir();
  try {
    const browser = await launchChrome(timeoutMs, profile);
    // Chrome が終わったら (落ちても) プロファイルを消す。終わる間際に子プロセスが書き足すので、少し置いてもう一度消す
    if (profile) {
      const remove = (): void => rmSync(profile, { recursive: true, force: true });
      browser.process()?.once('exit', () => {
        remove();
        setTimeout(remove, 3000).unref();
      });
    }
    return browser;
  } catch (error) {
    if (profile) rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

function launchChrome(timeoutMs: number, profile: string | null): Promise<Browser> {
  return puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    timeout: timeoutMs,
    ...(profile ? { userDataDir: profile } : {}),
    // Chrome は一時フォルダに通信用のソケットを作り、そのパスが 108 文字を超えると起動しない
    env: { ...chromeEnv(), TMPDIR: (process.env.TMPDIR ?? '/tmp').length > 60 ? '/tmp' : (process.env.TMPDIR ?? '/tmp') },
    // root で動くコンテナなので sandbox は使えない。代わりに JavaScript を止め、外への読み込みを絞る
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
      '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-default-apps', '--mute-audio']
  });
}

/**
 * Chrome を使う処理に期限を付ける。期限が来たら Chrome を強制終了する (puppeteer の待ちが途中で止まっても、枠を押さえ続けない)。
 * 期限切れは DrawError にして、モデルに直して出し直させる。
 */
async function withChrome<T>(timeoutMs: number, run: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await launchRenderChrome(timeoutMs);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    browser.process()?.kill('SIGKILL');
  }, timeoutMs);
  try {
    return await run(browser);
  } catch (error) {
    if (timedOut) throw new DrawError('描画が時間内に終わりませんでした。要素や外部の読み込みを減らして簡素にしてください。');
    throw error;
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- agent の image ツール (draw)

export const DRAW_MIN_WIDTH = 320;
export const DRAW_MAX_WIDTH = 1600;
export const DRAW_DEFAULT_WIDTH = 800;
/** 入力の HTML の大きさ (文字数) */
export const DRAW_MAX_HTML = 100_000;
/** 描く高さの上限 (CSS px)。超えたぶんは切る */
export const DRAW_MAX_HEIGHT = 4000;
/** 出来上がった PNG の大きさの上限 (Discord の添付の上限 10MB より小さく) */
export const DRAW_MAX_BYTES = 8 * 1024 * 1024;
const DRAW_TIMEOUT_MS = 15_000;

/** 描画する文書の方針。外へは何も取りに行かない。画像は data: だけ。 */
export const DRAW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

/** 描画できなかった理由 (モデルに返して、直して出し直させる)。 */
export class DrawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrawError';
  }
}

/**
 * 外から読み込もうとするものを取り除く。安全のためではなく (CSP と通信の遮断で止まっている)、遅さと固まりを避けるため:
 * 遮断された @import は load が終わるまで 9 秒ほど待たされ、組み合わさると期限を超える。
 * モデルは Google Fonts の @import / <link> をよく書くので、先に落とす。
 */
export function stripExternalLoads(fragment: string): string {
  return fragment
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
    .replace(/@import\b[^;{}]*;?/gi, '');
}

/** モデルが書いた HTML / SVG の断片を、コードが用意した骨組み (文字コード・CSP・既定の見た目) の body に入れる。 */
export function drawDocument(fragment: string): string {
  return [
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${DRAW_CSP}">`,
    '<style>',
    'html,body{margin:0;padding:0}',
    'body{box-sizing:border-box;padding:16px;background:#fff;color:#1f2328;line-height:1.5;',
    'font-family:"Noto Sans CJK JP","Noto Sans JP","Noto Sans CJK SC","Noto Sans",sans-serif}',
    '</style></head><body>',
    stripExternalLoads(fragment).trim(),
    '</body></html>'
  ].join('');
}

/** 描画の Chrome に取りに行かせてよいのは、文書の中の data: だけ。 */
export function isAllowedDrawRequest(url: string): boolean {
  return url.startsWith('data:') || url === 'about:blank';
}

export interface DrawnImage {
  png: Buffer;
  /** CSS px の幅と高さ (PNG の画素数ではない) */
  width: number;
  height: number;
  /** 内容が幅からはみ出している */
  overflowX: boolean;
  /** 高さの上限で切った */
  clipped: boolean;
}

/**
 * HTML / SVG の断片を PNG にする。JavaScript は最初から無効、外へのリクエストは data: 以外すべて遮断。
 * 呼ぶ側が withRenderSlot / takeRenderSlot で枠を取っておくこと。
 */
export async function renderDraw(fragment: string, { width = DRAW_DEFAULT_WIDTH }: { width?: number } = {}): Promise<DrawnImage> {
  if (!fragment.trim()) throw new DrawError('html が空です。');
  if (fragment.length > DRAW_MAX_HTML) throw new DrawError(`html が大きすぎます (${DRAW_MAX_HTML} 文字まで)。簡素にしてください。`);
  const cssWidth = Math.min(DRAW_MAX_WIDTH, Math.max(DRAW_MIN_WIDTH, Math.round(Number.isFinite(width) ? width : DRAW_DEFAULT_WIDTH)));

  return withChrome(DRAW_TIMEOUT_MS, async (browser) => {
    const page = await browser.newPage();
    // 文書を読む前に止める。スクリプトは CSP でも止まるが、二重にしておく
    await page.setJavaScriptEnabled(false);
    // 高さは 1 から始める (内容の高さは、ビューポートより低くならないので、大きいと測れない)
    await page.setViewport({ width: cssWidth, height: 1, deviceScaleFactor: cssWidth <= 1000 ? 2 : 1 });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (isAllowedDrawRequest(request.url())) void request.continue();
      else void request.abort('blockedbyclient');
    });
    await page.setContent(drawDocument(fragment), { waitUntil: 'load', timeout: DRAW_TIMEOUT_MS });

    // 大きさは JavaScript を使わずに CDP で測る
    const session = await page.createCDPSession();
    const metrics = await session.send('Page.getLayoutMetrics');
    const content = metrics.cssContentSize ?? metrics.contentSize;
    const fullHeight = Math.max(1, Math.ceil(content.height));
    const height = Math.min(DRAW_MAX_HEIGHT, fullHeight);
    const png = Buffer.from(await page.screenshot({
      type: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: cssWidth, height }
    }));
    if (png.length > DRAW_MAX_BYTES) throw new DrawError('出来上がった画像が大きすぎます (8MB まで)。要素や色数を減らして簡素にしてください。');
    return { png, width: cssWidth, height, overflowX: content.width > cssWidth + 1, clipped: fullHeight > DRAW_MAX_HEIGHT };
  });
}

// ---------------------------------------------------------------- agent の image ツール (look の縮小)

/** 読ませる画像の長辺 (px)。これより大きいものは縮める。 */
export const VISION_MAX_SIDE = 1568;

/**
 * 大きい画像を、描画用の Chrome で長辺 VISION_MAX_SIDE の JPEG に縮める (画像ライブラリを足さずに済ませる)。
 * 呼ぶ側が枠を取っておくこと。JavaScript は無効、外への読み込みは無し。
 */
export async function shrinkForVision(data: Buffer, mime: string): Promise<Buffer> {
  return withChrome(DRAW_TIMEOUT_MS, async (browser) => {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setViewport({ width: VISION_MAX_SIDE, height: VISION_MAX_SIDE });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (isAllowedDrawRequest(request.url())) void request.continue();
      else void request.abort('blockedbyclient');
    });
    const html = [
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="${DRAW_CSP}">`,
      `<style>html,body{margin:0;background:#fff}img{display:block;max-width:${VISION_MAX_SIDE}px;max-height:${VISION_MAX_SIDE}px}</style>`,
      `<img src="data:${mime};base64,${data.toString('base64')}">`
    ].join('');
    await page.setContent(html, { waitUntil: 'load', timeout: DRAW_TIMEOUT_MS });
    const image = await page.$('img');
    if (!image) throw new Error('shrink: no image element');
    return Buffer.from(await image.screenshot({ type: 'jpeg', quality: 82 }));
  });
}
