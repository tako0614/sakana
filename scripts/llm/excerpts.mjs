// 「噛み合った箇所」と「長い発言」を切り出す規則。**判定だけを持つ。**
//
// build-sft.mjs (Qwen 用 / `名前: 本文` の平文) と build-corpus.mjs (evex 用 /
// 記号トークン) の両方から使う。形が違うのは並べ方だけで、**どこを拾うかは同じ**
// なので、条件を2箇所に持つと必ずずれる。
//
// 返すのは会話ではなく **[from, to] の索引**。窓の中身の作り方は呼ぶ側が持つ
// (平文なら `名前: 本文` の行、evex なら <|sN|> の並び)。ここで会話まで組むと、
// どちらか一方の形に寄ってもう一方が使えなくなる。
//
// 条件の数字は evex-ft-2 / ft-3 で実測して決めたもの。**動かすと ft 系が再現しない**
// (噛み合い 23,111 / 長い発言 32,593 が一致することで移植の正しさを見ている)。

/**
 * 呼ぶ側が渡す turn の形:
 *
 *   key     話者の識別子。同一人物の連投を弾くのに使うだけなので何でも良い
 *   raw     本文そのまま
 *   body    raw から先頭の宛先 (`@名前 `) を落としたもの。宛先が無ければ raw と同じ
 *   target  宛先の key。無ければ null
 */

export const EXCERPT = {
  // 応答として認める最短。20字だと該当が 6,418 箇所しか無くて信号が足りない。
  // 12字なら「@えだまめ Trie Treeとradixどっちも搭載ってどう？」のような、
  // 短いが確実に噛み合っている発言が入る
  qaMinAnswer: Number(process.env.LLM_QA_MIN_ANSWER ?? 12),
  // 切り出しに付ける直前の文脈の行数。単発で置くと文脈なしで喋ることを学ぶ
  qaContext: Number(process.env.LLM_QA_CONTEXT ?? 2),
  // 長い発言とみなす長さ。40字以上は 25,565 箇所あり、その 91% が名前持ちのもの
  longMin: Number(process.env.LLM_LONG_MIN ?? 40),
  // 長い発言を匿名の役に移す割合 (4本に1本)。噛み合い側より低いのは、
  // 長い発言が個人の声そのもので、役に移すとなりきりの材料が減るから
  longAnonEvery: Number(process.env.LLM_LONG_ANON_EVERY ?? 4),
  // 噛み合いを匿名の役に移す割合 (2本に1本)。bot は既定で匿名の役で喋るのに、
  // 噛み合いの信号の 88.1% が名前持ちだったので、半分をそちらに寄せる
  qaAnonEvery: Number(process.env.LLM_QA_ANON_EVERY ?? 2)
};

const ENDS_WITH_QUESTION = /[?？][\s　]*$/;

/** 先頭の `@名前 ` を宛先として切り出す。build-sft の元の正規表現と同じ。 */
export const ADDRESSED = /^@([^\s]{1,12})[\s　]+([\s\S]*)$/;

/**
 * **前の人に噛み合っている**箇所の索引を返す。
 *
 * 拾うのは2種類。どちらも「直前の発言を受けて別人が中身のあることを言った」形:
 *
 *   1. 直前が疑問符で終わり、別人が答えている
 *   2. 直前の人に宛てている (`@名前` / 返信先)
 *
 * **長さではなく噛み合いを狙う。**`うーん` が駄目なのは短いからではなく前の発言を
 * 受けていないから。
 */
export function responseExcerptRanges(turns, opts = EXCERPT) {
  const { qaMinAnswer, qaContext } = { ...EXCERPT, ...opts };
  const ranges = [];

  for (let i = 1; i < turns.length; i += 1) {
    const before = turns[i - 1];
    const after = turns[i];
    if (before.key === after.key) continue;

    // 宛先は「誰に答えたか」の印なので、中身の長さから除いて数える
    if (after.body.length < qaMinAnswer) continue;

    const answersQuestion = ENDS_WITH_QUESTION.test(before.raw);
    const addressesPrev = after.target != null && after.target === before.key;
    if (!answersQuestion && !addressesPrev) continue;

    ranges.push([Math.max(0, i - 1 - qaContext), i]);
  }

  return ranges;
}

/**
 * **長い発言そのもの**の索引を返す。噛み合いだけ増やしても「単語しか吐かない」は
 * 直らない — 12字に緩めた時点で、短い応答の信号も増やしていることになる。
 *
 * 長さは `raw` で見る (宛先を含む)。噛み合い側が `body` で見るのと**わざと違う** —
 * ft-2 / ft-3 がこの形で出ているので、揃えると 32,593 が動く。
 */
export function longExcerptRanges(turns, opts = EXCERPT) {
  const { longMin, qaContext } = { ...EXCERPT, ...opts };
  const ranges = [];

  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i].raw.length < longMin) continue;
    const from = Math.max(0, i - qaContext);
    if (i === from) continue;          // 会話の頭なら文脈が無いので使わない
    ranges.push([from, i]);
  }

  return ranges;
}
