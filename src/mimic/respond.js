// /model evex を選んだ人への返答。素のチャットボットとして扱う。
//
// このモデルは 94万件から作った 5.87M で、道具も system プロンプトも使えない。
// 指示に従わせようとしても学習中に一度も見ていない形になるので崩れるだけ。
// できるのは「会話の続きを1発言書く」ことだけなので、それだけをやる。
//
// 誰かに成り代わらせない。話者は <|other|> (上位48人に入らない 2,599 人ぶんの
// 発言 = このサーバーの平均的な声) で固定する。特定の人の名前で書かせると
// 「その人が実際に言ったこと」を思い出して出しうるので、既定にはしない。
//
// 使用量の記録もしない。API を叩いていないので費用がゼロで、
// ドル換算の上限 (agent_calls) に混ぜると請求と乖離する。

import { chunkForDiscord } from '../agent/format.js';
import { generate, speakerFor } from './client.js';
import { buildPrompt, firstTurn, messageText } from './serialize.js';

const NO_MENTIONS = { parse: [], repliedUser: false };

// CPU 推論はコアを張り付かせるので、同時に1件だけ通す。
// 待たせる方が、全員ぶん遅くするより素直。
let running = 0;
const MAX_CONCURRENT = 1;

// 直近の何件を文脈にするか。学習時の会話は 20 件 / 1200 字で切ってあるので、
// それより長い文脈を渡すと学習中に見ていない形になる。
const CONTEXT_MESSAGES = 16;

// 返すのは1発言だけ。会話ごと生成させると「他の人の発言まで捏造した長文」になる。
const VOICE = '<|other|>';

function speakerToken(userId) {
  return speakerFor(userId)?.token ?? VOICE;
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
    // 数秒かかるので typing を出す。黙っていると落ちたように見える
    await message.channel.sendTyping().catch(() => {});
    typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
    typing.unref?.();

    // bot の発言は文脈に入れない。学習データが人間ぶんだけなので、
    // bot の長い回答が混ざると学習中に見ていない形になる。
    const history = recent
      .filter((entry) => !entry.author?.bot && (entry.content ?? '').trim())
      .slice(-CONTEXT_MESSAGES)
      .map((entry) => ({
        token: speakerToken(entry.author?.id),
        reply: Boolean(entry.reference?.messageId),
        content: messageText(entry.content)
      }));

    const prompt = buildPrompt(history, VOICE);
    const result = await generate({ prompt });

    // プロンプトぶんを落として、生成された続きだけを見る
    const body = firstTurn(String(result.text ?? '').slice(prompt.length));

    if (!body) {
      await message.reply({
        content: '(何も出てきませんでした。もう一度呼ぶと違うものが出ます)',
        allowedMentions: NO_MENTIONS
      }).catch(() => {});
      return;
    }

    // 事実ではないことは毎回出す。94万件を何周もしているので、
    // 実際の発言をそのまま再生していることがある。
    const note = `\n-# Evex (このサーバーの94万件で学習した 5.87M)。事実の保証はありません。`;

    for (const [index, chunk] of chunkForDiscord(body + note).entries()) {
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
