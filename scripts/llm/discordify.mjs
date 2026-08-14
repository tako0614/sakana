// 外部の会話を **Discord の粒度** に直す。build-external / build-jesc / build-2ch
// の 3 つから使う。条件を 3 箇所に持つと必ずずれるので、ここにだけ置く。
//
// --- なぜ要るのか ---
//
// 段1 の 89% は外部データだが、**evex の形のうち 2 つが外部に一度も出てこない**。
// v7 の実測 (発言あたり):
//
//                  evex(段2)  なりきり  JESC  open2ch
//   `<|re|>` 返信     17.2%      0%      0%      0%     ← 完全に欠けている
//   連投              28.2%      5.9%    0%      0%     ← ほぼ無い
//   中位字数            8         35      14      19     ← 1投稿=1長文
//   `<nl>`/発言       0.10       1.25     0      0.36
//
// つまり `<|re|>` と連投は**段2 の evex だけで覚えている**。段1 を 7 倍に
// スケールしても、この 2 つの形については土台がまったく増えていない。
//
// --- 直し方 ---
//
// 中身は変えず、**並べ方だけを Discord に直す**。掲示板の 1 投稿は Discord なら
// 複数の発言に分かれて出るので、改行で割って連投にする:
//
//   元: <|a|>ワイもそう思うわ<nl>でも金が無い<nl>どうしよ
//   後: <|a|>ワイもそう思うわ<|a|>でも金が無い<|a|>どうしよ
//
// これで 連投・中位字数・`<nl>` の 3 つが同時に evex に寄る。
//
// 返信は、掲示板も字幕も**そもそも直前の発言に答えている**ので、
// 印を付けること自体は嘘ではない。ただし全部に付けると 5 割を超えて
// evex (17.2%) から離れるので、割合を決めて間引く。
//
// --- 乱数を使わない ---
//
// `Math.random()` を使うと作り直すたびに中身が変わって、コーパスの差なのか
// 学習の揺れなのか分からなくなる。索引から決める。

export const SHAPE = {
  // 複数行の投稿を連投に割る割合。1.0 にすると `<nl>` が消えすぎるので、
  // evex の `<nl>`/発言 0.10 に合わせて少し残す
  splitEvery: Number(process.env.LLM_SHAPE_SPLIT_EVERY ?? 5),   // 5 本に 4 本を割る
  // 1 投稿を割ってよい最大数。長い投稿が 20 連投になると窓が 1 人で埋まる
  splitMax: Number(process.env.LLM_SHAPE_SPLIT_MAX ?? 6),
  // 割った断片の最短。1〜2 字の断片ばかり作ると `<|a|>w<|a|>w` になる
  splitMin: Number(process.env.LLM_SHAPE_SPLIT_MIN ?? 3),
  // 返信の印を付ける割合。evex は発言の 17.2%。掲示板は「直前に答える」形が
  // 5 割を超えるので、3 本に 1 本にして近づける
  replyEvery: Number(process.env.LLM_SHAPE_REPLY_EVERY ?? 3)
};

const NL = '<nl>';

/**
 * 1 投稿を Discord の発言列に割る。
 *
 * 割らない判断をしたときは 1 要素のまま返す。**`<nl>` を消さない** —
 * 消すと段1 に `<nl>` がまったく出なくなり、今度は evex 側の 0.10 が浮く。
 */
function splitPost(content, index, opts) {
  const { splitEvery, splitMax, splitMin } = opts;

  if (index % splitEvery === 0) return [content];        // 5 本に 1 本は残す
  if (!content.includes(NL)) return [content];

  const lines = content.split(NL).map((x) => x.trim()).filter(Boolean);
  if (lines.length < 2) return [content];

  // 短すぎる断片は前にくっつける。`<|a|>w<|a|>w` を作らないため
  const merged = [];
  for (const line of lines) {
    if (merged.length && line.length < splitMin) {
      merged[merged.length - 1] += NL + line;
    } else {
      merged.push(line);
    }
  }

  // 上限を超えるぶんは最後の 1 発言にまとめる
  if (merged.length > splitMax) {
    const tail = merged.splice(splitMax - 1);
    merged.push(tail.join(NL));
  }

  return merged.length > 1 ? merged : [content];
}

/**
 * 投稿の列を Discord の形の turn 列に直す。
 *
 * posts: [{ token, content }] — content は messageText を通した後のもの
 * seed:  索引の起点。窓ごとにずらすと、同じ投稿でも窓が変われば割り方が変わる
 *
 * 返り値は buildPrompt がそのまま食える [{ token, reply, replyTo, content }]。
 */
export function discordify(posts, seed = 0, opts = SHAPE) {
  const cfg = { ...SHAPE, ...opts };
  const turns = [];
  let at = seed;

  for (const post of posts) {
    const pieces = splitPost(post.content, at, cfg);
    at += 1;

    pieces.forEach((content, i) => {
      const previous = turns[turns.length - 1];

      // 返信の印は**話者が変わる境目にだけ**置く。自分への返信は evex 側でも
      // 落としている (連投の続きに `<|re|>` が付くだけで情報が無い)
      const mark = i === 0
        && previous != null
        && previous.token !== post.token
        && at % cfg.replyEvery === 0;

      turns.push({
        token: post.token,
        reply: mark,
        replyTo: mark ? previous.token : null,
        content
      });
    });
  }

  return turns;
}
