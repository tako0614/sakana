import { AttachmentBuilder, type Message } from 'discord.js';
import { analyzeDesire } from './desire-jev.js';
import { renderDesireHtml } from './emotion-image.js';
import { getMessageAuthorAvatarUrl, renderHtmlImage, replySafely, withRenderSlot } from './emotion.js';

// 「よっきゅう」: リプライ先の発言の三大欲求 (食欲・睡眠欲・性欲) を判定モデル (jev、desire-jev.ts) で読み、3 本のゲージの画像にして返す。
// きもち (emotion.ts) と同じ流れで、どのチャンネル・誰の発言にも使える。画像の描画の枠はきもちと共有する。

const desireTriggerText = process.env.DESIRE_TRIGGER_TEXT ?? 'よっきゅう';

export function isDesireRequest(message: Message): boolean {
  return message.content.trim() === desireTriggerText && Boolean(message.reference?.messageId);
}

export async function handleDesireRequest(message: Message): Promise<void> {
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

  try {
    const slot = await withRenderSlot(async () => {
      if ('sendTyping' in message.channel) await message.channel.sendTyping();
      const result = await analyzeDesire(targetText);
      return renderHtmlImage(renderDesireHtml({
        authorName: targetMessage.member?.displayName ?? targetMessage.author.displayName ?? targetMessage.author.username,
        avatarUrl: getMessageAuthorAvatarUrl(targetMessage),
        text: targetText,
        result
      }));
    });
    if (slot.busy) {
      await replySafely(message, 'いま画像づくりが混んでいます。少し待ってからもう一度どうぞ。');
      return;
    }
    await replySafely(message, { files: [new AttachmentBuilder(slot.value, { name: 'yokkyu.png' })] });
  } catch (error) {
    console.error('Failed to analyze desire:', error);
    await replySafely(message, '欲求の分析に失敗しました。少し待ってからもう一度どうぞ。');
  }
}
