import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttachmentBuilder, type Message, type MessageReplyOptions } from 'discord.js';
import puppeteer from 'puppeteer-core';
import { IMAGE_HOSTS, renderEmotionHtml, type EmotionImageInput, type EmotionResult } from './emotion-image.js';

// 「きもち」: リプライ先の発言の感情を Python のモデルで読み、画像にして返す。

const __dirname = dirname(fileURLToPath(import.meta.url));
const analyzerScript = resolve(__dirname, '../scripts/analyze-emotions.py');

const emotionTriggerText = process.env.EMOTION_TRIGGER_TEXT ?? 'きもち';
const pythonBin = process.env.EMOTION_PYTHON_BIN ?? 'python3';
const analysisTimeoutMs = Number(process.env.EMOTION_ANALYSIS_TIMEOUT_MS ?? 180_000);
// 描画に使う Chrome。以前は node-html-to-image が古い puppeteer と Chrome 128 を抱えていた (既知の脆弱性つき)
const chromePath = process.env.EMOTION_CHROME_PATH ?? '/usr/bin/google-chrome';
const renderTimeoutMs = 30_000;
// 解析も描画も重い (モデルの読み込み・Chrome の起動)。連打で止まらないよう同時に2件まで
const MAX_RUNNING = 2;
let running = 0;

export function isEmotionRequest(message: Message): boolean {
  return message.content.trim() === emotionTriggerText && Boolean(message.reference?.messageId);
}

export async function handleEmotionRequest(message: Message): Promise<void> {
  let targetMessage: Message;

  try {
    targetMessage = await message.fetchReference();
  } catch (error) {
    console.error('Failed to fetch referenced message:', error);
    await replySafely(message, 'リプライ先のメッセージが削除されているか、取得できませんでした。');
    return;
  }

  const targetText = targetMessage.content.trim();
  if (!targetText) {
    await replySafely(message, 'リプライ先に分析できるテキストがありません。');
    return;
  }
  if (running >= MAX_RUNNING) {
    await replySafely(message, 'いま気持ち分析が混んでいます。少し待ってからもう一度どうぞ。');
    return;
  }

  running += 1;
  try {
    if ('sendTyping' in message.channel) await message.channel.sendTyping();
    const result = await analyzeEmotion(targetText);
    const image = await renderEmotionImage({
      authorName: targetMessage.member?.displayName ?? targetMessage.author.displayName ?? targetMessage.author.username,
      avatarUrl: getMessageAuthorAvatarUrl(targetMessage),
      text: targetText,
      result
    });

    const attachment = new AttachmentBuilder(image, { name: 'kimochi.png' });
    await replySafely(message, { files: [attachment] });
  } catch (error) {
    console.error('Failed to analyze emotion:', error);
    await replySafely(message, {
      content: [
        '気持ち分析に失敗しました。',
        'Python 依存関係が未設定の場合は `pip install -r requirements.txt` を実行してください。'
      ].join('\n')
    });
  } finally {
    running -= 1;
  }
}

/** 解析スクリプトの出力を確かめる。形が違えば失敗にする (画像の描画に変な値を渡さない)。 */
export function parseEmotionResult(raw: unknown): EmotionResult {
  const emotions = (raw as { emotions?: unknown } | null)?.emotions;
  if (!Array.isArray(emotions) || emotions.length === 0) throw new Error('Invalid analyzer output: no emotions');
  return {
    emotions: emotions.map((item: unknown) => {
      const { label, score } = (item ?? {}) as { label?: unknown; score?: unknown };
      if (typeof label !== 'string' || typeof score !== 'number' || !Number.isFinite(score)) {
        throw new Error('Invalid analyzer output: bad emotion entry');
      }
      return { label: label.slice(0, 40), score };
    })
  };
}

// 解析スクリプトに渡す環境変数。bot の秘密 (Discord のトークンや API キー) は渡さない
const ANALYZER_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'HF_HOME', 'HF_HUB_OFFLINE', 'TRANSFORMERS_CACHE',
  'TRANSFORMERS_OFFLINE', 'XDG_CACHE_HOME', 'CUDA_VISIBLE_DEVICES', 'OMP_NUM_THREADS', 'EMOTION_MODEL_NAME', 'EMOTION_MAX_LENGTH'];

function analyzerEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(ANALYZER_ENV_KEYS.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));
}

function analyzeEmotion(text: string): Promise<EmotionResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonBin, [analyzerScript], { env: analyzerEnv(), stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Emotion analysis timed out after ${analysisTimeoutMs}ms`));
    }, analysisTimeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    child.on('error', (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(stderr || `Emotion analyzer exited with code ${code}`));
        return;
      }
      try {
        resolvePromise(parseEmotionResult(JSON.parse(stdout)));
      } catch (error) {
        reject(new Error(`Invalid analyzer output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });

    child.stdin.end(JSON.stringify({ text }));
  });
}

// 描画用の Chrome にも bot の秘密は渡さない
function chromeEnv(): Record<string, string> {
  const keys = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'FONTCONFIG_PATH', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'];
  return Object.fromEntries(keys.flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

/** Discord のアバター画像だけ取りに行かせる。ほかの URL (内部のサービス・file://) は描画側の Chrome でも止める。 */
export function isAllowedImageRequest(url: string): boolean {
  if (url.startsWith('data:') || url === 'about:blank') return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && IMAGE_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

export async function renderEmotionImage(input: EmotionImageInput): Promise<Buffer> {
  const html = renderEmotionHtml(input);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    timeout: renderTimeoutMs,
    // Chrome は一時フォルダに通信用のソケットを作り、そのパスが 108 文字を超えると起動しない
    env: { ...chromeEnv(), TMPDIR: (process.env.TMPDIR ?? '/tmp').length > 60 ? '/tmp' : (process.env.TMPDIR ?? '/tmp') },
    // root で動くコンテナなので sandbox は使えない。代わりに JavaScript を止め、外への読み込みを絞る
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
      '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-default-apps', '--mute-audio']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 540 });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (isAllowedImageRequest(request.url())) void request.continue();
      else void request.abort('blockedbyclient');
    });
    await page.setContent(html, { waitUntil: 'load', timeout: renderTimeoutMs });
    await page.setJavaScriptEnabled(false);
    const body = await page.$('body');
    if (!body) throw new Error('emotion image has no body');
    return Buffer.from(await body.screenshot({ type: 'png', omitBackground: true }));
  } finally {
    await browser.close();
  }
}

function getMessageAuthorAvatarUrl(message: Message): string {
  const avatarOptions = { extension: 'png', size: 128, forceStatic: true } as const;
  return message.member?.displayAvatarURL(avatarOptions) ?? message.author.displayAvatarURL(avatarOptions);
}

async function replySafely(message: Message, response: string | MessageReplyOptions): Promise<void> {
  // 誰にも通知を飛ばさない (リプライ先・本文の @ も含めて)
  const allowedMentions = { parse: [], repliedUser: false };
  const replyOptions: MessageReplyOptions = typeof response === 'string'
    ? { content: response, allowedMentions }
    : { ...response, allowedMentions };

  try {
    await message.reply(replyOptions);
  } catch (error) {
    console.error('Failed to reply to emotion request:', error);
  }
}
