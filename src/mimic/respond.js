// /model evex を選んだ人への返答。素のチャットボットとして扱う。
//
// このモデルは 94万件から作った 5.87M で、道具も system プロンプトも使えない。
// 指示に従わせようとしても学習中に一度も見ていない形になるので崩れるだけ。
// できるのは「会話の続きを1発言書く」ことだけなので、それだけをやる。
//
// bot は会話に加わる新しい参加者として、次の空いている役で喋る。
//
// ただし `/as` で人格を選んでいる人には、その人として喋る。載っている世代で手が違う:
//
//   evex-1    上位48人の話者トークン <|sN|> を差す
//   evex-ft-1 表示名をラベルに置く (`-akku-:`)
//
// どちらも本人の履歴が重みに入っているので、差し替えるだけで口調が変わる
// (evex-1 で実測: -akku- は技術寄りで長め、it's o は「まじ？」のような短い口語)。
// 形式を取り違えるとモデルが一度も見ていない入力を受け取り、例外を出さずに
// 静かに崩れる (evex-1 に <|a|> を渡して実際に壊した)。
//
// 使用量の記録もしない。API を叩いていないので費用がゼロで、
// ドル換算の上限 (agent_calls) に混ぜると請求と乖離する。

import { chunkForDiscord } from '../agent/format.js';
import { endpointFor, generate, roleScheme } from './client.js';
import { mimicFormat } from './impersonate.js';
import { personaFor } from './persona.js';
import {
  PLAIN_SCHEME, assignPlainRoles, buildPlainPrompt, isAttachmentOnly, labelFor,
  labelledSpeakers, plainFirstTurn, plainText
} from './plain.js';
import { assignRoles, buildPrompt, firstTurn, messageText, nextRole } from './serialize.js';
import { hasOptedOut, learnedSpeakers, tokenFor } from './speakers.js';

const NO_MENTIONS = { parse: [], repliedUser: false };

// CPU 推論はコアを張り付かせるので、同時に1件だけ通す。
// 待たせる方が、全員ぶん遅くするより素直。
let running = 0;
const MAX_CONCURRENT = 1;

// 直近の何件を文脈にするか。学習時の会話の切り方に合わせる —
// それより長い文脈を渡すと学習中に見ていない形になる。
// evex-1 は 20 件 / 1200 字、evex-ft-1 は 60 件 / 3600 字 (中位 438 トークン) で
// 切ってあるので、短い方に合わせておけばどちらでも分布の中に入る。
const CONTEXT_MESSAGES = 16;

// 返すのは1発言だけ。会話ごと生成させると「他の人の発言まで捏造した長文」になる。
// 短すぎる返答は引き直す。
//
// 正規化トークン (<url> / <file>) はサーバー側で既定禁止にしてあるが、それでも
// 「これ」のような 2 文字が 12% ほど出る (禁止前は 38% が記号だけだった)。
// CPU で数秒かかるので回数は絞る。
const MIN_CHARS = 3;
const MAX_TRIES = 3;

/**
 * 独自トークン形式 (evex-1 / evex-2)。会話に出てくる人に役を振って、
 * bot は次の空いている役 — または /as で選ばれた人の話者トークン — で喋る。
 */
async function tokenRequest(messages, { wanted, engine }) {
  const scheme = await roleScheme(engine);
  const roles = assignRoles(messages.map((entry) => entry.authorId), scheme);
  const turns = messages.map((entry) => ({
    token: roles.get(entry.authorId),
    reply: entry.isReply,
    content: messageText(entry.content)
  }));

  // 申告に無いトークンは渡さない
  const token = wanted ? tokenFor(wanted) : null;
  const as = token && scheme?.speakers?.includes(token) ? token : null;

  return {
    prompt: buildPrompt(turns, as ?? nextRole(roles, scheme)),
    cut: firstTurn,
    as
  };
}

/**
 * 素の日本語形式 (evex-ft-1)。名前を持つ人は表示名、持たない人は役。
 * **学習側 (build-sft.mjs) と同じ規則でないと形がずれる** — 名前持ちに役を配ると
 * 「たこ」と「B」が同一人物という、学習中に一度も無かった形になる。
 */
function plainRequest(messages, { wanted, channelId }) {
  const ids = messages.map((entry) => entry.authorId);
  const roles = assignPlainRoles(ids.filter((id) => !labelFor(id)));
  const labelOf = (id) => labelFor(id) ?? roles.get(id) ?? null;

  const turns = messages.map((entry) => ({
    role: labelOf(entry.authorId),
    content: plainText(entry.content, labelOf)
  })).filter((turn) => turn.role && turn.content);

  const as = wanted ? labelFor(wanted) : null;

  return {
    prompt: buildPlainPrompt(turns, {
      channelId,
      trailingRole: as ?? nextRole(roles, PLAIN_SCHEME)
    }),
    cut: plainFirstTurn,
    as
  };
}

// 自分の返答に付けている `-# evex-1 / たこ として` を落とす。
// 文脈に入れるときに残すと、モデルが footer ごと真似し始める。
const FOOTER = /\n-#[^\n]*$/;

function stripFooter(text) {
  let out = String(text ?? '');
  while (FOOTER.test(out)) out = out.replace(FOOTER, '');
  return out.trim();
}

/**
 * Discord のメッセージと、返信の鎖 (fromDiscordMessage の形) を同じ形にそろえる。
 * 2つの経路から来るので、ここで1つにしないと片方の欠けに気付けない。
 */
function toTurn(entry) {
  return {
    id: entry.id ?? entry.messageId ?? null,
    authorId: entry.author?.id ?? entry.authorId ?? null,
    isBot: entry.author?.bot ?? Boolean(entry.isBot),
    content: entry.content ?? '',
    isReply: Boolean(entry.reference?.messageId ?? entry.replyTo)
  };
}

export async function handleMimicRequest(
  message, client, { recent = [], chain = [], engine = 'evex', remember = null, selfId = null } = {}
) {
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

    // 他の bot の発言は文脈に入れない。学習データが人間ぶんだけなので、
    // LLM bot の長い回答が混ざると学習中に見ていない形になる。
    //
    // **自分の返答だけは入れる。** 外していたので、リプで続けても前に何を言ったかを
    // 覚えていなかった (毎回はじめて話しかけられた形になる)。短い1発言なので
    // 学習データと同じ形に収まる。長いものは DeepSeek 側の回答なので落とす。
    const OWN_MAX_CHARS = 120;
    const own = (turn) => selfId && turn.authorId === selfId;
    const usable = (turns) => turns
      .map((turn) => (own(turn) ? { ...turn, content: stripFooter(turn.content) } : turn))
      .filter((turn) => turn.content.trim())
      .filter((turn) => (own(turn) ? turn.content.length <= OWN_MAX_CHARS : !turn.isBot));
    const recentTurns = usable(recent.map(toTurn));

    // 返信の鎖を足す。これが無いと「何にリプしたか」が分からないまま返answerを書く —
    // DeepSeek 側は 6 ホップ辿って渡しているのに、こちらは直近 20 件だけ見ていた。
    // 「/model を変えると挙動が変わり過ぎる」原因のひとつ。
    // 鎖は古い方が先なので、直近の前に置けば時系列で並ぶ。
    const known = new Set(recentTurns.map((turn) => turn.id).filter(Boolean));
    const older = usable(chain.map(toTurn)).filter((turn) => !turn.id || !known.has(turn.id));

    const messages = [...older, ...recentTurns].slice(-CONTEXT_MESSAGES);

    // /as で選ばれている人。抜けている人は無視する
    const persona = personaFor(message.author.id);
    const wanted = persona && !hasOptedOut(persona) ? persona : null;

    // 載っている世代で形式が違う。取り違えるとモデルが一度も見ていない入力を
    // 受け取り、例外を出さずに静かに崩れる (evex-1 に <|a|> を渡して実際に壊した)
    const built = await mimicFormat(engine) === 'plain'
      ? plainRequest(messages, { wanted, channelId: message.channelId })
      : await tokenRequest(messages, { wanted, engine });

    let body = '';
    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      const result = await generate({ prompt: built.prompt, engine });
      // プロンプトぶんを落として、生成された続きだけを見る
      body = built.cut(String(result.text ?? '').slice(built.prompt.length));
      // 添付だけの返答は bot が画像を投稿できないので意味が無い。引き直す
      if (isAttachmentOnly(body)) body = '';
      if (body.length >= MIN_CHARS) break;
    }

    if (!body) {
      await message.reply({
        content: '(何も出てきませんでした。もう一度呼ぶと違うものが出ます)',
        allowedMentions: NO_MENTIONS
      }).catch(() => {});
      return;
    }

    // どのモデルが書いたかを毎回出す (DeepSeek 側と同じ形)。
    // 人格を差しているなら誰なのかも出す — 実在の人の口調で喋っているので、
    // 生成物だと分かる印は必ず付ける
    const asName = built.as
      ? (labelledSpeakers().concat(learnedSpeakers()).find((row) => row.userId === persona)?.name ?? null)
      : null;
    const note = `\n-# ${endpointFor(engine).label}${asName ? ` / ${asName} として` : ''}`;

    // 送った返答を記録する。起動条件は「メンション or 回答へのリプライ」だが、
    // 記録していなかったので **evex の返答にリプしても無反応**だった
    // (DeepSeek 側だけが rememberOwnReply を呼んでいた)。
    for (const [index, chunk] of chunkForDiscord(body + note).entries()) {
      const payload = { content: chunk, allowedMentions: NO_MENTIONS };
      const sent = index === 0
        ? await message.reply(payload).catch(() => message.channel.send(payload).catch(() => null))
        : await message.channel.send(payload).catch(() => null);
      if (sent?.id) remember?.(sent.id);
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
