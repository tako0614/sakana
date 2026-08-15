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
  // 割った断片の最短。1〜2 字の断片ばかり作ると `<|a|>w<|a|>w` になる
  splitMin: Number(process.env.LLM_SHAPE_SPLIT_MIN ?? 3),
  // 返信の印を付ける割合。evex は発言の 17.2%。掲示板は「直前に答える」形が
  // 5 割を超えるので、3 本に 1 本にして近づける
  replyEvery: Number(process.env.LLM_SHAPE_REPLY_EVERY ?? 3)
};

// **連投の長さの分布を evex に合わせる。**
//
// 最初は「改行のあるところで全部割る / 上限 6」にしていた。割合 (連投率) は
// 合わせられるが、**分布が合わない**。実測 (evex 1,354,092 まとまり / なりきり):
//
//         1連    2連    3連    4連    5連    6連   7+
//   evex  72.7%  17.8%  5.5%  2.0%  0.9%  0.4%  0.7%   平均 1.47
//   旧    75.1%  11.3%  5.2%  3.0%  1.6%  3.1%  0.8%   平均 1.59
//
// **6連が 7.8 倍**なのは上限 6 にちょうど溜まっていたから (実装の癖がそのまま
// データに出ていた)。一番多いはずの 2連は逆に足りない。bot の返答が細切れの
// 連投になったのはこれが効いている。
//
// なので「何回割るか」ではなく **「何連投にするか」を先に決めて、その数に
// なるように行を束ねる**。12 行の投稿は 6 連投ではなく 2 連投 (6 行ずつ) になる。
const RUN_WEIGHTS = [[1, 727], [2, 178], [3, 55], [4, 20], [5, 9], [6, 4], [7, 7]];

/**
 * その投稿を何連投にするか。**乱数は使わない** — 作り直すたびに中身が変わると、
 * コーパスの差なのか学習の揺れなのか分からなくなる。
 * 977 は 1000 と互いに素なので、索引の並びに偏りを持ち込まずに散る。
 */
function targetRun(index) {
  let x = (index * 977) % 1000;
  for (const [length, weight] of RUN_WEIGHTS) {
    if (x < weight) return length;
    x -= weight;
  }
  return 1;
}

const NL = '<nl>';

/**
 * 1 投稿を Discord の発言列に割る。
 *
 * 割らない判断をしたときは 1 要素のまま返す。**`<nl>` を消さない** —
 * 消すと段1 に `<nl>` がまったく出なくなり、今度は evex 側の 0.10 が浮く。
 */
function splitPost(content, index, opts) {
  const { splitMin } = opts;

  const want = targetRun(index);
  if (want <= 1 || !content.includes(NL)) return [content];

  const lines = content.split(NL).map((x) => x.trim()).filter(Boolean);
  if (lines.length < 2) return [content];

  // **狙った数になるように束ねる。**行数が足りなければその数まで。
  // 12 行を 2 連投にするなら 6 行ずつの発言 2 つ (`<nl>` は本文に残る)
  const pieces = Math.min(want, lines.length);
  const perPiece = Math.ceil(lines.length / pieces);
  const bundled = [];
  for (let i = 0; i < lines.length; i += perPiece) {
    bundled.push(lines.slice(i, i + perPiece).join(NL));
  }

  // 短すぎる断片は前にくっつける。`<|a|>w<|a|>w` を作らないため
  const merged = [];
  for (const piece of bundled) {
    if (merged.length && piece.length < splitMin) merged[merged.length - 1] += NL + piece;
    else merged.push(piece);
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
