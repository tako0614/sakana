// /model evex を選んだ人への返答。素のチャットボットとして扱う。
//
// このモデルは 94万件から作った 5.87M で、道具も system プロンプトも使えない。
// 指示に従わせようとしても学習中に一度も見ていない形になるので崩れるだけ。
// できるのは「会話の続きを1発言書く」ことだけなので、それだけをやる。
//
// 話者は会話ごとに出現順で振る相対トークン (<|a|>, <|b|>, ...)。実在の人物には
// 紐づかないので、そもそも「誰かに成り代わる」ことができない。
// bot は会話に加わる新しい参加者として、次の空いている役で喋る。
//
// 使用量の記録もしない。API を叩いていないので費用がゼロで、
// ドル換算の上限 (agent_calls) に混ぜると請求と乖離する。

import { chunkForDiscord } from '../agent/format.js';
import { generate, mimicConfig, roleScheme } from './client.js';
import { assignRoles, buildPrompt, firstTurn, messageText, nextRole } from './serialize.js';

const NO_MENTIONS = { parse: [], repliedUser: false };

// CPU 推論はコアを張り付かせるので、同時に1件だけ通す。
// 待たせる方が、全員ぶん遅くするより素直。
let running = 0;
const MAX_CONCURRENT = 1;

// 直近の何件を文脈にするか。学習時の会話は 20 件 / 1200 字で切ってあるので、
// それより長い文脈を渡すと学習中に見ていない形になる。
const CONTEXT_MESSAGES = 16;

// 返すのは1発言だけ。会話ごと生成させると「他の人の発言まで捏造した長文」になる。
// 短すぎる返答は引き直す。
//
// 正規化トークン (<url> / <file>) はサーバー側で既定禁止にしてあるが、それでも
// 「これ」のような 2 文字が 12% ほど出る (禁止前は 38% が記号だけだった)。
// CPU で数秒かかるので回数は絞る。
const MIN_CHARS = 3;
const MAX_TRIES = 3;

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
    const messages = recent
      .filter((entry) => !entry.author?.bot && (entry.content ?? '').trim())
      .slice(-CONTEXT_MESSAGES);

    // この会話に出てくる人だけに役を振る。誰が誰かは持たない。
    // 役の種類はサーバーの申告に従う (載っている世代で違う)。
    const known = await roleScheme();
    const roles = assignRoles(messages.map((entry) => entry.author?.id), known);
    const history = messages.map((entry) => ({
      token: roles.get(entry.author?.id),
      reply: Boolean(entry.reference?.messageId),
      content: messageText(entry.content)
    }));

    // bot は新しい参加者として喋る
    const prompt = buildPrompt(history, nextRole(roles, known));

    let body = '';
    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      const result = await generate({ prompt });
      // プロンプトぶんを落として、生成された続きだけを見る
      body = firstTurn(String(result.text ?? '').slice(prompt.length));
      if (body.length >= MIN_CHARS) break;
    }

    if (!body) {
      await message.reply({
        content: '(何も出てきませんでした。もう一度呼ぶと違うものが出ます)',
        allowedMentions: NO_MENTIONS
      }).catch(() => {});
      return;
    }

    // どのモデルが書いたかを毎回出す (DeepSeek 側と同じ形)
    const note = `\n-# ${mimicConfig.label}`;

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
