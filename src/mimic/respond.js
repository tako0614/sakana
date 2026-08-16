// /model evex を選んだ人への返答。素のチャットボットとして扱う。
//
// このモデルは 94万件から作った 5.87M で、道具も system プロンプトも使えない。
// 指示に従わせようとしても学習中に一度も見ていない形になるので崩れるだけ。
// できるのは「会話の続きを書く」ことだけなので、それだけをやる。
// 同じ人が続けて喋るぶんは残す (学習データの話者の塊のうち 27.4% が2連続以上)。
// **他人が喋り出したら必ず切る** — 実在の人の発言を捏造して本人のサーバーに
// 流す方が、短く切るより害が大きい。
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
import { ENDPOINTS, continuationOf, endpointFor, generate, roleScheme } from './client.js';
import { mimicFormat } from './impersonate.js';
import { personaFor } from './persona.js';
import {
  PLAIN_SCHEME, assignPlainRoles, buildPlainPrompt, channelRankOf, isUnusableReply,
  labelFor, labelledSpeakers, plainOwnTurns, plainText
} from './plain.js';
import { assignRoles, buildPrompt, messageText, nextRole, ownTurns } from './serialize.js';
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

// 返すのは**その人が続けて喋ったぶんまで**。他人が喋り出したら切る —
// 会話ごと生成させると「他の人の発言まで捏造した長文」になる。
// 切り出しは plainOwnTurns / ownTurns 側 (既定4発言 / 400字)。
//
// 短すぎる返答は引き直す。正規化トークン (<url> / <file>) はサーバー側で既定禁止に
// してあるが、それでも「これ」のような 2 文字が 12% ほど出る
// (禁止前は 38% が記号だけだった)。CPU で数秒かかるので回数は絞る。
//
// **3 字は緩すぎた。** 「うーん」「まじ？」「草」が全部通るので、単語だけの返答が
// そのまま流れていた。このサーバーの発言も 45.3% が10字以下なので短いのは自然だが、
// **話しかけられて答える場面**では引き直す方がいい。8 字にすると「うーん」は落ちて
// 「@A UDPの方が速いと思うよ」は通る。
//
// 引き直しは温度そのままの再サンプリングなので、確率分布の裾から別の候補が出る。
// 3 回引いても短いままなら、それがそのモデルの答えなのでそのまま出す
// (空にして「何も出てきませんでした」を出す方が体験が悪い)。
const MIN_CHARS = Number(process.env.MIMIC_MIN_CHARS ?? 8);
const MAX_TRIES = Number(process.env.MIMIC_MAX_TRIES ?? 3);

/**
 * 独自トークン形式 (evex-1 / evex-2)。会話に出てくる人に役を振って、
 * bot は**自分が既に持っている役** — または /as で選ばれた人の話者トークン — で喋る。
 */
async function tokenRequest(messages, { wanted, engine, channelId, selfId }) {
  const scheme = await roleScheme(engine);

  // **学習と同じ振り方にする。**名前を持つ人は固有トークン、それ以外だけに役を配る。
  //
  // 以前は文脈の全員に役を配っていた。build-corpus.mjs は名前持ちを <|sN|> で
  // 書いているので、`-akku-` が居る会話は学習時 `<|s0|>`・推論時 `<|a|>` になり、
  // **モデルから見て別の形**だった (speakers.js の「48人ぶんが丸ごと遊んでいた」)。
  // 申告に無いトークンは渡さないので、話者を持たない世代では今までと同じ動きになる。
  //
  // evex-1 も evex-2 も corpus-v1 (48人) で学習している (evex-2 の中身は
  // `v1-lr1e-3-mask` で、v1 との違いは LR とマスクだけ) ので、3 世代とも
  // これが学習時の形。役だけのコーパスで回した v2-base12 / v2-wd は完走していない。
  const declared = new Set(scheme?.speakers ?? []);
  const namedOf = (authorId) => {
    const token = authorId ? tokenFor(authorId) : null;      // opt-out はここで null
    return token && declared.has(token) ? token : null;
  };

  // 申告に無いトークンは渡さない
  const token = wanted ? tokenFor(wanted) : null;
  const as = token && declared.has(token) ? token : null;

  // **`/as` のときは bot 自身の過去の返答もその人に寄せる。**
  //
  // 末尾だけ差し替えていたので、実際に流れていたのはこの形だった:
  //
  //   だこ: chromeの話してないねん
  //   <|a|>: (bot の前の返答)      ← bot 自身は役 A のまま
  //   だこ: @A さかなのこと好き？    ← A 宛て = bot 宛て
  //   <|s0|>:                     ← ここを「あかり」に書かせていた
  //
  // モデルから見ると「だこが A に聞いた。さて**あかり**が喋る番」なので、
  // 答えないのが正しい振る舞いになる。[[bot-speaks-as-own-role]] で直したのと
  // 同じ形が `/as` の経路に残っていた (実使用で 3 件中 2 件がこれで外していた)。
  //
  // **本人がその窓に居るときは寄せない。**同じトークンに 2 人が乗ると、
  // それこそ学習で一度も無かった形になる。
  const personaPresent = wanted != null && messages.some((entry) => entry.authorId === wanted);
  const speakAs = as && !personaPresent ? as : null;

  // 固有トークンを持つ人 (と `/as` 中の bot) は先に決める。役はその残りに配る —
  // bot に役を配ってから寄せると <|a|> が誰にも使われないまま残り、
  // 役が飛んだ会話という学習に無い形になる
  const identity = (authorId) =>
    (speakAs && selfId && authorId === selfId ? speakAs : namedOf(authorId));

  const roles = assignRoles(
    messages.map((entry) => entry.authorId).filter((authorId) => !identity(authorId)),
    scheme
  );
  const tokenOf = (authorId) => identity(authorId) ?? roles.get(authorId) ?? null;

  // 誰への返信かを解決する。文脈の中に相手が居るときだけ置く —
  // 居ない相手を指すと、モデルが一度も見ていない形になる
  const authorOfMessage = new Map(messages.filter((e) => e.id).map((e) => [e.id, e.authorId]));

  const turns = messages.map((entry) => {
    const target = entry.replyToId ? authorOfMessage.get(entry.replyToId) ?? null : null;
    return {
      token: tokenOf(entry.authorId),
      reply: entry.isReply,
      // 自分への返信は情報が無いので置かない (build-corpus.mjs と同じ判断)
      replyTo: target && target !== entry.authorId ? tokenOf(target) : null,
      content: messageText(entry.content)
    };
  });

  // 自分が既に喋っているならその役で続ける (下の plainRequest と同じ理由)
  const mine = selfId ? tokenOf(selfId) : null;
  const trailing = as ?? mine ?? nextRole(roles, scheme);

  // **チャンネルを窓の先頭に置く (evex-4 以降)。**
  //
  // 学習側は `<|c2|><|conv|>...` の形で組んである。ここで渡さないと、
  // モデルが学習中ずっと持っていた話題の手がかりが推論だけ常に欠けた形になる。
  // ft 系には最初からあったのに evex 系は evex-3.5 まで無かった。
  //
  // **申告が空の世代には何も置かない。**語彙に `<|c0|>` が無い evex-3.5 以前に
  // 渡すとバイトに分解されて、窓の先頭から形が崩れる。
  const channel = channelTokenOf(channelId, scheme);

  // **常に「反応された発言」として書かせる (evex-4.1 以降)。**
  //
  // 学習側では、リアクションが付いた発言の話者トークンの直前に `<|hi|>` が
  // 置いてある。推論で同じ位置に置くと「このサーバーが反応する種類の発言」を
  // 狙える。段3 と違って**土台を上書きしていない**ので、外せば元の分布に戻る。
  // 申告が無い世代 (evex-4 以前) では null になり、何も置かれない
  const quality = scheme?.quality ?? null;

  return {
    prompt: `${channel ?? ''}${buildPrompt(turns, trailing, { quality })}`,
    // 末尾に置いたトークンを渡す。同じ人の連投は残し、他人が喋り出したら切る
    cut: (text) => ownTurns(text, trailing),
    trailing,
    as
  };
}

/**
 * チャンネル ID をその世代のチャンネルトークンに直す。
 *
 * 順位表 (channels.json) は ft 系の `#chN` と**同じもの**を使う。何個まで名前を
 * 持つかは**モデルの申告**に従う — 順位表だけ増やしても、語彙に無いトークンは
 * 渡せない。
 */
function channelTokenOf(channelId, scheme) {
  const tokens = scheme?.channels ?? [];
  if (!tokens.length || !channelId) return null;

  const rank = channelRankOf(channelId, tokens.length);
  return rank == null ? scheme.channelOverflow ?? null : tokens[rank];
}

/**
 * 素の日本語形式 (evex-ft-1)。名前を持つ人は表示名、持たない人は役。
 * **学習側 (build-sft.mjs) と同じ規則でないと形がずれる** — 名前持ちに役を配ると
 * 「たこ」と「B」が同一人物という、学習中に一度も無かった形になる。
 */
function plainRequest(messages, { wanted, channelId, selfId }) {
  const as = wanted ? labelFor(wanted) : null;

  // `/as` のときは bot 自身の過去の返答もその人に寄せる (tokenRequest と同じ理由)。
  // 本人がその窓に居るときは寄せない — 同じラベルに 2 人が乗る形になる
  const personaPresent = wanted != null && messages.some((entry) => entry.authorId === wanted);
  const speakAs = as && !personaPresent ? as : null;
  const identity = (id) => (speakAs && selfId && id === selfId ? speakAs : labelFor(id));

  const ids = messages.map((entry) => entry.authorId);
  const roles = assignPlainRoles(ids.filter((id) => !identity(id)));
  const labelOf = (id) => identity(id) ?? roles.get(id) ?? null;

  const turns = messages.map((entry) => ({
    role: labelOf(entry.authorId),
    content: plainText(entry.content, labelOf)
  })).filter((turn) => turn.role && turn.content);

  // **自分が既に喋っているならその役で続ける。**
  //
  // `nextRole()` で毎回「次の空き役」にしていたので、bot 自身の過去の返答を文脈に
  // 入れる修正を入れた時点で整合が壊れていた。実際に流れていたプロンプトがこれ:
  //
  //   だこ: @A あ
  //   A: 確かにVPS提供する側としては悪いことしてにゃいぞ   ← bot 自身 (役 A)
  //   だこ: @A 日本の首都どこにゃ                        ← @A 宛て = bot 宛て
  //   B:                                              ← ここを書かせていた
  //
  // モデルから見ると「だこが A に質問した。さて B が喋る番」なので、
  // **答えないのが正しい振る舞い**になる。噛み合わないのは当然だった。
  const mine = selfId ? labelOf(selfId) : null;
  const trailing = as ?? mine ?? nextRole(roles, PLAIN_SCHEME);

  return {
    prompt: buildPlainPrompt(turns, { channelId, trailingRole: trailing }),
    // 末尾に置いたラベルを渡す。同じ人の連投は残し、他人が喋り出したら切る
    cut: (text) => plainOwnTurns(text, trailing),
    trailing,
    as
  };
}

/**
 * 会話 + `/as` の指定から、その世代の形式でプロンプトを組む。
 *
 * `/mimic` (impersonate.js) と**別の経路**なので分けて確かめられるようにしてある。
 * あちらはお題だけを渡すが、こちらはチャンネルの会話を並べた末尾に人格のラベルを
 * 置く。同じラベルでも前に何が並んでいるかで出るものが変わるので、
 * `/mimic` が動いていても `/as` が効いているとは限らない。
 *
 * 返すのは { prompt, cut, trailing, as }。trailing は末尾に置いた話者ラベルで、
 * 推論サーバーの打ち切り (stop_label) と切り出しの両方に使う。
 * as が null なら人格は乗っていない
 * (その世代がその人を知らない = 渡すと未学習のラベルになるので落としている)。
 */
export async function buildMimicPrompt(
  messages, { wanted = null, engine = 'evex', channelId = null, selfId = null } = {}
) {
  return await mimicFormat(engine) === 'plain'
    ? plainRequest(messages, { wanted, channelId, selfId })
    : tokenRequest(messages, { wanted, engine, channelId, selfId });
}

// **`-#` の行は文脈に入れない。**あれは Discord の小文字表示 (subtext) の指定で
// あって発言ではない。自分の返答に付けている `-# evex-5.2-b / たこ として` や
// `-# thinking 3 秒前` がそのまま入ると、モデルが footer ごと真似し始める。
//
// **末尾の1行だけ消す形では足りなかった。**前は `/\n-#[^\n]*$/` で消していたが、
// あれは「フッターがちょうど最後の行にある」ときしか当たらない。後ろに改行が
// 1つ残っているだけで素通りするし、本文の途中にある `-#` は当然残る。
// **行単位で落とす。**
const SUBTEXT = /^\s*-#(?:\s|$)/;

function stripSubtext(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => !SUBTEXT.test(line))
    .join('\n')
    .trim();
}

// その返答を書いたモデル。footer の先頭に必ずモデル名が入っている
// (自作側は `-# evex-2 / たこ として`、DeepSeek 側は `-# deepseek-... 引用`)。
//
// **長さで分けるのをやめた。** 自作モデルの返答は 120 字以下という前提で切って
// いたが、同じ人の連投を残すようにして最長 400 字になったので、長さでは
// DeepSeek 側の回答と区別できない。区別を誤ると学習データに無い長文が文脈に入る。
const SELF_LABELS = new Set(Object.values(ENDPOINTS).map((endpoint) => endpoint.label));
const FOOTER_LABEL = /\n-#[ 　]*([^\n/]+?)[ 　]*(?:\/|$)/;

function bySelfHosted(text) {
  const found = String(text ?? '').match(FOOTER_LABEL);
  return Boolean(found && SELF_LABELS.has(found[1].trim()));
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
    isReply: Boolean(entry.reference?.messageId ?? entry.replyTo),
    // **誰への返信かを残す。**evex-3 以降は `<|re|><|sM|>` で相手も学習している。
    // 真偽だけ持っていた頃は、賑やかなチャンネルで噛み合いの信号を捨てていた
    replyToId: entry.reference?.messageId ?? entry.replyTo ?? null
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
    // 覚えていなかった (毎回はじめて話しかけられた形になる)。自作モデルが書いた
    // ものは学習データと同じ形なので収まる。DeepSeek 側の回答は落とす。
    const own = (turn) => selfId && turn.authorId === selfId;
    const mine = (turn) => bySelfHosted(turn.content);
    //
    // **落とすのは選別した後。**bySelfHosted は footer のラベルを見て
    // 「自作モデルが書いたものか」を判定しているので、先に消すと自分の返答が
    // 全部よそ者あつかいになって文脈から丸ごと消える。
    // **人の発言も通す。**利用者が `-# ` で書いた行も同じく見た目の指定なので、
    // 文脈に入れる意味が無い (全部消えたらその turn ごと落ちる)。
    const usable = (turns) => turns
      .filter((turn) => (own(turn) ? mine(turn) : !turn.isBot))
      .map((turn) => ({ ...turn, content: stripSubtext(turn.content) }))
      .filter((turn) => turn.content.trim());
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
    const built = await buildMimicPrompt(messages, {
      wanted, engine, channelId: message.channelId, selfId
    });

    // **一番長い候補を残す。** 以前は毎回 body を上書きしていたので、1 回目が
    // 「うーん」(短いが使える) で 3 回目が添付だけ (使えない) のとき、空になって
    // 「何も出てきませんでした」を出していた。引き直しで悪くなるのは筋が通らない。
    let body = '';
    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      const result = await generate({
        prompt: built.prompt, engine, stopLabel: built.trailing
      });
      // プロンプトぶんを落として、生成された続きだけを見る
      const got = built.cut(continuationOf(result.text, built.prompt));
      // 添付だけの返答は bot が画像を投稿できないので意味が無い。引き直す
      if (!isUnusableReply(got) && got.length > body.length) body = got;
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
