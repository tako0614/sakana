import { AttachmentBuilder, type Message, type MessageReplyOptions } from 'discord.js';
import { IMAGE_HOSTS, renderEmotionHtml, type EmotionImageInput, type EmotionResult } from './emotion-image.js';
import { analyzeEmotion } from './emotion-jev.js';
import { launchRenderChrome, renderTimeoutMs, takeRenderSlot } from './render.js';

// 「きもち」: リプライ先の発言の感情を判定モデル (jev、emotion-jev.ts) で読み、画像にして返す。

const emotionTriggerText = process.env.EMOTION_TRIGGER_TEXT ?? 'きもち';
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
  const release = takeRenderSlot();
  if (!release) {
    await replySafely(message, 'いま気持ち分析が混んでいます。少し待ってからもう一度どうぞ。');
    return;
  }
  try {
    if ('sendTyping' in message.channel) await message.channel.sendTyping();
    const result = parseEmotionResult(await analyzeEmotion(targetText));
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
      content: '気持ち分析に失敗しました。少し待ってからもう一度どうぞ。'
    });
  } finally {
    release();
  }
}

/** 解析結果の形を確かめる。形が違えば失敗にする (画像の描画に変な値を渡さない)。 */
export function parseEmotionResult(raw: unknown): EmotionResult {
  const { emotions, neutral } = (raw ?? {}) as { emotions?: unknown; neutral?: unknown };
  if (!Array.isArray(emotions) || emotions.length === 0) throw new Error('Invalid analyzer output: no emotions');
  return {
    emotions: emotions.map((item: unknown) => {
      const { label, score } = (item ?? {}) as { label?: unknown; score?: unknown };
      if (typeof label !== 'string' || typeof score !== 'number' || !Number.isFinite(score)) {
        throw new Error('Invalid analyzer output: bad emotion entry');
      }
      return { label: label.slice(0, 40), score };
    }),
    ...(neutral === true ? { neutral: true } : {})
  };
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

export const renderEmotionImage = (input: EmotionImageInput): Promise<Buffer> => renderHtmlImage(renderEmotionHtml(input));

/** HTML (emotion-image.tsx が作る 960x540 の 1 枚) を Chrome で PNG にする。きもち・よっきゅう共通。 */
export async function renderHtmlImage(html: string): Promise<Buffer> {
  const browser = await launchRenderChrome(renderTimeoutMs);
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

export function getMessageAuthorAvatarUrl(message: Message): string {
  const avatarOptions = { extension: 'png', size: 128, forceStatic: true } as const;
  return message.member?.displayAvatarURL(avatarOptions) ?? message.author.displayAvatarURL(avatarOptions);
}

export async function replySafely(message: Message, response: string | MessageReplyOptions): Promise<void> {
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
