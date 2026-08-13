// 「その人として喋らせる」本体。載っている世代で手が変わる。
//
//   evex-1    / 上位48人   <|sN|> を差す
//   evex-ft-1 / 147人      `-akku-:` のように表示名を置く
//   どちらも外の人          本人の実発言を例に見せて、役で続けさせる
//
// 前2つは深い。「にゃい」のような癖は本人の全期間から出てくる (重みに入っている)。
// 例を見せる方は数件から表面 (語彙・長さ・テンション) を真似るだけなので浅いが、
// 対象が全員になるうえ直近の口癖と話題が乗る。
//
// evex-ft-1 が個人を持てるのは、コーパスの話者ラベルを表示名にしたから。
// 最初は相対の役 (A/B/C) にしていて、そのときは原理的に不可能だった —
// 実測で役 A の中身は 1,062 人ぶんで、最多の人でも 10.4% (全体シェア 9.4% とほぼ同じ)。

import { continuationOf, endpointFor, generate, roleScheme } from './client.js';
import {
  assignPlainRoles, buildPlainPrompt, isUnusableReply, labelFor, plainOwnTurns, plainText
} from './plain.js';
import { buildPrompt, messageText, ownTurns } from './serialize.js';
import { exampleTurns, hasOptedOut, tokenFor } from './speakers.js';

// 短すぎる返答は引き直す。CPU で数秒かかるので回数は絞る。
// respond.js と同じ既定 (3 字だと「うーん」「草」が通って単語だけの返答が流れる)
const MIN_CHARS = Number(process.env.MIMIC_MIN_CHARS ?? 8);
const MAX_TRIES = Number(process.env.MIMIC_MAX_TRIES ?? 3);

/**
 * 載っている世代がどちらの形式か。
 *
 * evex-1 / evex-2 は独自の制御記号、evex-ft-1 は素の日本語。取り違えるとモデルが
 * 一度も見ていない入力を受け取り、例外を出さずに静かに崩れる (evex-1 に <|a|> を
 * 渡して実際に壊した)。既定は推論サーバーの申告から判定し、env で上書きできる。
 */
export async function mimicFormat(engine = 'evex') {
  const { format } = endpointFor(engine);
  if (format === 'plain' || format === 'tokens') return format;

  const scheme = await roleScheme(engine);
  // 申告が取れないときは素の形式とみなす。llama.cpp で配信する evex-ft-1 は
  // server.py の /health を持たない
  return scheme?.roles?.length ? 'tokens' : 'plain';
}

/** その人の話者トークンが使えるか (上位48人 かつ 独自トークンの世代)。 */
export async function canUseToken(userId, engine = 'evex') {
  if (await mimicFormat(engine) !== 'tokens') return false;

  const scheme = await roleScheme(engine);
  // 相対の役だけの世代 (evex-2) は個人に紐づかないので不可
  if (!scheme?.speakers?.length) return false;

  const token = tokenFor(userId);
  return Boolean(token && scheme.speakers.includes(token));
}

/** 独自トークン形式のプロンプト。 */
async function tokenPrompt(userId, { topic, engine }) {
  const scheme = await roleScheme(engine);
  const token = tokenFor(userId);
  const other = scheme?.overflow ?? '<|other|>';

  if (token && scheme?.speakers?.includes(token)) {
    // 本命。お題があれば誰かが振った形にして、その人に答えさせる
    const turns = topic ? [{ token: other, reply: false, content: messageText(topic) }] : [];
    return { prompt: buildPrompt(turns, token), how: 'token', trailing: token };
  }

  // 48人の外。実発言を例に出して、同じ調子の続きを書かせる
  const examples = exampleTurns(userId);
  const turns = [];
  for (const example of examples) {
    if (example.prompt) turns.push({ token: other, reply: false, content: messageText(example.prompt) });
    turns.push({ token: other, reply: Boolean(example.prompt), content: messageText(example.reply) });
  }
  if (topic) turns.push({ token: other, reply: false, content: messageText(topic) });

  return {
    prompt: buildPrompt(turns, other),
    how: examples.length ? 'examples' : 'empty',
    trailing: other
  };
}

/** 素の日本語形式 (evex-ft-1) のプロンプト。 */
function plainPrompt(userId, { topic, channelId, askerId }) {
  const label = labelFor(userId);
  // 話しかける側も、ラベルを持っていれば本人の名前で置く。学習データは
  // 名前持ちと役が混在した会話なので、この形はそのまま分布の中にある
  const asker = (askerId && labelFor(askerId)) || assignPlainRoles(['asker']).get('asker');

  if (label) {
    // 本命。ラベルを置くだけで、重みに入っている本人の口調が出る。
    // 147人ぶんの発言 (全体の 96.6%) がこの形で学習されている
    const turns = topic ? [{ role: asker, content: plainText(topic) }] : [];
    return {
      prompt: buildPlainPrompt(turns, { channelId, trailingRole: label }),
      how: 'label',
      trailing: label
    };
  }

  // 147人の外。実発言を例に出して、同じ調子の続きを書かせる。
  // 本人には役を割り当てる — 学習していない名前を置くと、モデルが一度も見ていない
  // ラベルになって崩れる
  const me = assignPlainRoles(['target', 'asker']).get('target');
  const examples = exampleTurns(userId);
  const turns = [];
  for (const example of examples) {
    if (example.prompt) turns.push({ role: asker, content: plainText(example.prompt) });
    turns.push({ role: me, content: plainText(example.reply) });
  }
  if (topic) turns.push({ role: asker, content: plainText(topic) });

  return {
    prompt: buildPlainPrompt(turns, { channelId, trailingRole: me }),
    how: examples.length ? 'examples' : 'empty',
    trailing: me
  };
}

/**
 * その人として1発言書かせる。
 *
 * 返すのは { text, how }。how は 'token' / 'label' (どちらも重みに焼き付いた本人) か
 * 'examples' (実発言を例に真似) で、どちらで作ったかを表示に出す —
 * 深さが違うので、見た人が期待を合わせられる方がいい。
 */
export async function impersonate(userId, { topic = null, channelId = null, askerId = null, engine = 'evex' } = {}) {
  if (hasOptedOut(userId)) {
    return { text: null, how: 'opted-out' };
  }

  const format = await mimicFormat(engine);
  const built = format === 'plain'
    ? plainPrompt(userId, { topic, channelId, askerId })
    : await tokenPrompt(userId, { topic, engine });

  if (built.how === 'empty') return { text: null, how: 'empty' };

  // 同じ人の連投は残し、他人が喋り出したら切る。末尾に置いたラベルが要る
  const cut = format === 'plain'
    ? (text) => plainOwnTurns(text, built.trailing)
    : (text) => ownTurns(text, built.trailing);

  // 一番長い候補を残す。上書きにすると、引き直しで使える返答を捨てることがある
  // (1 回目が「うーん」で 3 回目が添付だけ → 空になる)
  let text = '';
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const result = await generate({
      prompt: built.prompt, engine, stopLabel: built.trailing
    });
    const got = cut(continuationOf(result.text, built.prompt));
    if (!isUnusableReply(got) && got.length > text.length) text = got;
    if (text.length >= MIN_CHARS) break;
  }

  return { text: text || null, how: built.how };
}
