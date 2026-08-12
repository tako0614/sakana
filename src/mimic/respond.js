// /model evex を選んだ人への返答。
//
// エージェントとは別経路。あのモデルは道具も system プロンプトも使えず、
// 「会話の続きを書く」ことしかできない。無理に指示に従わせようとしても
// 学習中に一度も見ていない形なので崩れるだけなので、素直に続きを書かせる。
//
// 使用量の記録もしない。API を叩いていないので費用がゼロで、
// ドル換算の上限 (agent_calls) に混ぜると請求と乖離する。

import { chunkForDiscord } from '../agent/format.js';
import { generate, speakerFor } from './client.js';
import { buildPrompt, humanize, messageText } from './serialize.js';

const NO_MENTIONS = { parse: [], repliedUser: false };

// CPU 推論はコアを張り付かせるので、同時に1件だけ通す。
// 待たせる方が、全員ぶん遅くするより素直。
let running = 0;
const MAX_CONCURRENT = 1;

// 直前の何件を文脈にするか。学習時の会話は 20 件 / 1200 字で切ってあるので、
// それより長い文脈を渡しても学習中に見ていない形になる。
const CONTEXT_MESSAGES = 16;

function speakerToken(userId) {
  return speakerFor(userId)?.token ?? '<|other|>';
}

/**
 * 直近の会話を学習時と同じ形に並べる。
 * 末尾に話者トークンを置いて、その人として続きを書かせる。
 */
function promptFrom(messages, asUserId) {
  const turns = messages.map((message) => ({
    token: speakerToken(message.author?.id ?? message.authorId),
    reply: Boolean(message.reference?.messageId ?? message.replyTo),
    content: messageText(message.content)
  }));

  return buildPrompt(turns, speakerToken(asUserId));
}

/**
 * 誰として書かせるかを決める。
 *
 * 指名が無ければ「呼んだ人以外で直近に喋っていた人」。自分自身として書かせると
 * 会話が続かないし、bot 自身の話者トークンは学習データに無い。
 */
function pickSpeaker(messages, callerId) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = messages[i].author?.id;
    if (id && id !== callerId && speakerFor(id)) return id;
  }
  return callerId;
}

export async function handleMimicRequest(message, client, { recent = [] } = {}) {
  if (running >= MAX_CONCURRENT) {
    await message.reply({
      content: 'いま別の生成を回しています。少し待ってからもう一度呼んでください。',
      allowedMentions: NO_MENTIONS
    }).catch(() => {});
    return;
  }

  running += 1;
  let typing = null;

  try {
    // 生成中は typing を出す。数秒かかるので黙っていると落ちたように見える
    await message.channel.sendTyping().catch(() => {});
    typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
    typing.unref?.();

    const history = recent
      .filter((entry) => !entry.author?.bot)
      .slice(-CONTEXT_MESSAGES);

    const asUserId = pickSpeaker(history, message.author.id);
    const prompt = promptFrom(history, asUserId);

    const result = await generate({ prompt });
    const nameOf = (rank) => {
      const found = speakerFor(asUserId);
      return found?.rank === rank ? found.name : `s${rank}`;
    };

    // プロンプトぶんを落として、生成された続きだけを見せる
    const grown = String(result.text ?? '').slice(prompt.length);
    const body = humanize(grown, nameOf).trim();

    if (!body) {
      await message.reply({
        content: '(何も出てきませんでした。もう一度呼ぶと違うものが出ます)',
        allowedMentions: NO_MENTIONS
      }).catch(() => {});
      return;
    }

    const who = speakerFor(asUserId)?.name ?? 'だれか';
    const head = `-# Evex (自作 5.87M) が ${who} として書いたもの。事実ではありません。`;

    for (const [index, chunk] of chunkForDiscord(`${head}\n${body}`).entries()) {
      const payload = { content: chunk, allowedMentions: NO_MENTIONS };
      if (index === 0) await message.reply(payload).catch(() => message.channel.send(payload));
      else await message.channel.send(payload).catch(() => {});
    }
  } catch (error) {
    console.error('Mimic request failed:', error);

    await message.reply({
      content: error?.down
        ? 'Evex の推論プロセスが起動していません。`/model` で DeepSeek に戻せます。'
        : `Evex での生成に失敗しました: ${error?.message ?? '不明なエラー'}`,
      allowedMentions: NO_MENTIONS
    }).catch(() => {});
  } finally {
    if (typing) clearInterval(typing);
    running -= 1;
  }
}
