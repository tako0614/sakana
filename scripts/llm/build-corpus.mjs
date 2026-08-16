// 生の書き出し (export-raw.mjs) から学習用のテキストを作る。ローカルで何度でも回す。
//
//   node scripts/llm/build-corpus.mjs [入力 corpus-v3/] [出力 corpus-v4/]
//
// 出力:
//   train.txt / val.txt   1行1会話。sentencepiece と学習の両方がこれを読む
//   speakers.json         話者トークンの割り当て (userId / 表示名を含む = **手元だけ**)
//   stats.json            作った条件と件数
//
// **出力を corpus/ にしないこと。** あそこには evex-2 の tok.model と対の
// speakers.json (48人) が入っている。上書きすると載っているモデルが孤児になる。
//
// --- v4 で変えたこと ---
//
// evex-2 のコーパスには、evex-ft-2 / ft-3 で測って効いた工夫がひとつも入っていない。
// あちらは全部コーパス側の話なので、記号に翻訳してそのまま持ち込む:
//
//   1. 上位147人に固有トークン (evex-1 は48人 / 被覆 85.3% → 96.6%)
//   2. 返信先を残す `<|re|><|sM|>` (真偽だけだと**誰に答えたかを捨てている**)
//   3. 窓を 60分 / 60件 / 3600字 に (検索用の 15分 / 20件 / 1200字 は学習には短い)
//   4. 噛み合った箇所と長い発言を切り出して重く見せる (excerpts.mjs)
//   5. 窓の切り方をずらして 3 通りに増やす
//
// 5 は**新しい情報を増やさない**。同じ発言が違う位置・違う文脈長で 3 回出るだけで、
// epoch という単位が 3 倍に薄まる。evex-2 の 12 epoch に相当するのは v4 の 4 epoch。
//
// 空の発言 (添付だけ) は v3 と同じく `<file>` のままにする。build-sft.mjs は
// `[画像]` のような種類名に直しているが、あちらは語彙 151,936 の Qwen で、
// こちらは 4096 の自作。17,889 件ぶんの同じ短い文字列を足すと、それ自体が
// 強い誘引になって evex-1 の「返答の 38% が (画像)」に戻る。`<file>` なら
// train.py が損失から外せる (--mask-tokens)。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';

// 「どこを拾うか」は build-sft.mjs (Qwen 用) と同じ規則。条件を2箇所に持つとずれる
import {
  EXCERPT, longExcerptRanges, reactedExcerptRanges, responseExcerptRanges
} from './excerpts.mjs';

// 会話の切り方は意味検索と同じ `splitIntoChunks` を使う。定義を2箇所に持つと必ず
// ずれるので、ここでは実装せず import する。ただしあのモジュールは読み込み時に
// archive.sqlite を開くので、触られても困らないスクラッチのパスを向けてから import する。
process.env.ARCHIVE_DB_PATH = path.join(os.tmpdir(), 'sakana-corpus-scratch.sqlite');
const { splitIntoChunks } = await import('../../src/archive/chunks.js');
const {
  ROLE_TOKENS, ROLE_OVERFLOW, assignRoles, buildPrompt, messageText
} = await import('../../src/mimic/serialize.js');

const src = process.argv[2] ?? 'corpus-v3';
const dst = process.argv[3] ?? 'corpus-v4';

// 発言がこれ以上ある人に固有トークンを与える。build-sft.mjs と同じ 200 件 = 147人。
// evex-1 は 2000 件 (48人 / 被覆 85.3%) だった。語彙 4096 のうち user_defined が
// 99 個増えて実マージが約 140 減るが、被覆の増分 (+11.3pt) の方が大きい
const NAMED_MIN_MESSAGES = Number(process.env.LLM_NAMED_MIN ?? 200);

// 窓。build-sft.mjs の CHUNK と同じ値 —
//   沈黙15分 上限1200   中位 262 tok / 8割位  350   ← evex-2 まで
//   沈黙60分 上限3600   中位 557 tok / 8割位 1003   ← これ (context 1024 にほぼ収まる)
const CHUNK = {
  gapMs: Number(process.env.LLM_CHUNK_GAP_MS ?? 60 * 60 * 1000),
  maxMessages: Number(process.env.LLM_CHUNK_MAX_MESSAGES ?? 60),
  maxChars: Number(process.env.LLM_CHUNK_MAX_CHARS ?? 3600)
};

// 切り出しが train に占める割合の目標。**ft-2 / ft-3 で測って効いた値。**
// 基のコーパスが増えるとそのままでは薄まるので、周回数をここから逆算する。
// 多すぎても駄目 — build-sft.mjs の実測で 28.5% にすると窓の中身が
// 3〜4 行の短い会話ばかりになり、元の長い会話が学べなくなる
// **切り出しは「一問一答 ⇔ 会話の流れ」の調整つまみ。**
//
// 切り出しは 3〜4 turn の短い窓なので「短く punchy に返す」を教える。素の窓は
// 「会話を自然に続ける」を教える。割合を下げるほど流れ寄りになる。
//
// evex-4.1 で偶然この割合まで下がったとき (周回数の上限 3 に張り付いた)、
// `conversational.py` の噛み合いは 53.3% → 36.7% に落ちたが、**使った本人は
// 4.1 の方が良いと言った。**噛み合いは「質問の語を拾ったか」しか見ないので、
// 話を広げる返しを低く評価する。実機の返答:
//
//   evex-4    いや、今日が明けましてよ                      (短く投げっぱなし)
//   evex-4.1  はい。まずね、テストの点数を取らないといけなくて… (話が展開する)
//
// なので **4.1 の実績値をそのまま目標にする**。以前の 12.3% / 25.6% は
// evex-ft-2 / ft-3 で測った値で、別のモデル族・別の狙いのもの。
// 一問一答を強くしたいときは上げる (LLM_QA_SHARE などで振れる)。
const QA_SHARE = Number(process.env.LLM_QA_SHARE ?? 0.084);
const LONG_SHARE = Number(process.env.LLM_LONG_SHARE ?? 0.161);
const REACTED_SHARE = Number(process.env.LLM_REACTED_SHARE ?? 0.033);

// 窓の切り方を変えて増やす。**train だけに掛ける** —
// val に掛けると中身が重複して loss の意味が変わる。
//
// 最初は「開始位置を 20 件ずらす」でやったが、**ほとんど効かなかった**
// (36,647 窓のうち 35,858 が同じ本文)。splitIntoChunks は主に沈黙時間で切るので、
// 読み始める位置を変えても境界がほぼ動かない。切り方そのものを変える必要がある。
//
// 実測 (直前の切り方と重複しない割合):
//   60分/60件/3600字   18,810 会話 (基準 / val もこれ)
//   30分/60件/2400字   21,503 会話 のうち 58.2% が新しい窓
//  120分/60件/5400字   16,529 会話 のうち 51.4% が新しい窓
//
// 効くのは境界だけではない。`assignRoles` は会話ごとなので、まとまりが変われば
// **名前を持たない人に付く役も変わる**。同じ発言が <|a|> でも <|c|> でも出る。
//
// **v7 で 3 → 5 通りに増やした。**外部が 23.3M → 167M トークンになったので、
// 段1 の中の evex 比率も段2 に配る計算量の割合も薄まる。対処として素朴に
// epoch を増やすと**同じ本文を見る回数が増えて丸暗記に寄る**。切り方を増やせば、
// 増えるのは「同じ発言を違う位置・違う文脈長・違う役で見る回数」なので、
// 逐語コピーを上げずに evex 側の材料を増やせる。
const MINUTE = 60_000;
const TILINGS = [
  { gapMs: 60 * MINUTE, maxMessages: 60, maxChars: 3600 },
  { gapMs: 30 * MINUTE, maxMessages: 60, maxChars: 2400 },
  { gapMs: 120 * MINUTE, maxMessages: 60, maxChars: 5400 },
  { gapMs: 15 * MINUTE, maxMessages: 60, maxChars: 1500 },
  { gapMs: 180 * MINUTE, maxMessages: 60, maxChars: 7200 },
  // **evex-4.1 で 5 → 8 通りに。**evex度を上げるのに「同じ本文を何周もする」のは
  // 丸暗記に寄るだけなので、**違う切り方を増やして材料そのものを厚くする**。
  // 件数の上限も振る — 沈黙と字数だけだと、賑やかな時間帯の切れ目が動かない
  { gapMs: 45 * MINUTE, maxMessages: 24, maxChars: 3000 },
  { gapMs: 90 * MINUTE, maxMessages: 100, maxChars: 4500 },
  { gapMs: 20 * MINUTE, maxMessages: 40, maxChars: 1800 }
].slice(0, Number(process.env.LLM_TILINGS ?? 8));

// val は「最後の N 日ぶんの会話」。ランダム分割にしない —
// 「草」「www」のような完全一致が 23% あるので、時間で切らないと val が嘘になる
const VAL_DAYS = Number(process.env.LLM_VAL_DAYS ?? 14);

const authors = JSON.parse(await readFile(path.join(src, 'authors.json'), 'utf8'));

// --- 話者トークンを決める ---
//
// 発言数の多い順。同じ人が世代をまたいで同じ番号になる保証は無い (人数が変われば
// 順位も変わる) ので、**speakers.json は世代ごとに別ファイルで持つ**。
// 共有すると古い世代に未学習のトークンが渡る。

const named = [...authors]
  .filter((a) => !a.bot && a.count >= NAMED_MIN_MESSAGES)
  .sort((a, b) => b.count - a.count);

const tokenByIdx = new Map(named.map((a, rank) => [a.idx, `<|s${rank}|>`]));
const speakerTokens = named.map((_, rank) => `<|s${rank}|>`);

// --- 生データを読む ---

const byChannel = new Map();
let read = 0;
let bots = 0;

// readline は使わない。U+2028 / U+2029 も行終端として扱うので、それを含む本文で
// JSON レコードが割れる (実データに 5 件あった)。
const raw = gunzipSync(await readFile(path.join(src, 'raw.jsonl.gz'))).toString('utf8');

for (const line of raw.split('\n')) {
  if (!line) continue;
  read += 1;

  // 列が 6 個の古い書き出しも読める。extra と reply_author は後から足した
  // 列が 8 個までの古い書き出しも読める。reaction_count は後から足した
  const [ch, author, createdAt, isBot, isReply, content, , replyAuthor, reactions] =
    JSON.parse(line);
  if (isBot) { bots += 1; continue; }

  const text = messageText(content);

  if (!byChannel.has(ch)) byChannel.set(ch, []);
  byChannel.get(ch).push({
    author,
    created_at: createdAt,
    reply: isReply,
    reply_author: replyAuthor ?? null,
    reactions: reactions ?? 0,
    content: text,
    char_count: text.length
  });
}

// --- 会話を組む ---

/**
 * ひとまとまりを turn の列にする。
 *
 * 名前を持たない人だけに `<|a|>..<|h|>` を振る。名前持ちに役を配ると、同じ会話で
 * 「<|s3|>」と「<|b|>」が同一人物という矛盾した形になる (build-sft.mjs と同じ判断)。
 */
function toTurns(chunk) {
  const unnamed = chunk.map((row) => row.author).filter((idx) => !tokenByIdx.has(idx));
  const roles = assignRoles(unnamed);
  const tokenOf = (idx) => (idx == null ? null : tokenByIdx.get(idx) ?? roles.get(idx) ?? null);

  return chunk.map((row) => {
    const self = tokenOf(row.author);
    // 自分への返信は情報が無いので置かない (連投の続きに `<|re|>` が付くだけ)
    const target = row.reply_author != null && row.reply_author !== row.author
      ? tokenOf(row.reply_author)
      : null;

    return {
      token: self,
      reply: Boolean(row.reply),
      replyTo: target,
      content: row.content,
      // **サーバーが実際に反応した発言**の印。切り出しの判定に使う。
      //
      // `hi` は**プロンプトにも出す** (evex-4.1 以降)。段3 で「リアクション付き
      // だけで追加学習」をやったら噛み合いが 53.3% → 36.7% に落ちたが、あれは
      // 土台を上書きしたのが敗因。**条件付けとして置くだけなら土台は壊れない**し、
      // 推論で置かなければ元に戻せる
      reactions: row.reactions ?? 0,
      hi: (row.reactions ?? 0) >= EXCERPT.reactedMin,
      // excerpts.mjs の判定に渡す形。宛先は別に持っているので raw と body は同じ
      key: self,
      raw: row.content,
      body: row.content,
      target
    };
  });
}

// --- チャンネルトークン ---
//
// **evex 系は evex-1 から一度も入れていなかった。**ft 系は窓の先頭に
// `#ch0..#ch15` を置いていて（上位16chで全体の97%）、話題の手がかりになっている。
// 技術雑談か雑談かゲームかで口調も語彙も変わるのに、モデルはそれを知らずに書いていた。
//
// 件数の多い順に 16 個だけ名前を持ち、それ以外は `<|cx|>` に潰す。
// **推論側も同じ順位表を使う**必要がある (channels.json の順位がそのまま対応表)。
const NAMED_CHANNELS = Number(process.env.LLM_NAMED_CHANNELS ?? 16);
const channels = JSON.parse(await readFile(path.join(src, 'channels.json'), 'utf8'));
const channelRank = new Map(
  [...channels].sort((a, b) => b.count - a.count)
    .slice(0, NAMED_CHANNELS)
    .map((c, rank) => [c.idx, `<|c${rank}|>`])
);
const CHANNEL_OVERFLOW = '<|cx|>';
const channelToken = (ch) => channelRank.get(ch) ?? CHANNEL_OVERFLOW;

// 会話の先頭にチャンネルを置く。`<|conv|>` より前に出すのは、
// 「どのチャンネルの会話が始まる」という順序にするため
// **`ch != null` で見る。**索引 0 は falsy なので、`ch ?` と書くと
// 番号 0 のチャンネルだけ無タグになる (実測で train 1 行が漏れた)
const wrap = (turns, ch = null) =>
  `${ch != null ? channelToken(ch) : ''}${buildPrompt(turns)}<|end|>`;

// 基準の切り方。val と切り出しはここからしか作らない
const base = [];

for (const [ch, rows] of byChannel) {
  for (const chunk of splitIntoChunks(rows, CHUNK)) {
    if (chunk.length < 2) continue;              // 1 発言だけの「会話」は交代を教えない
    const turns = toTurns(chunk);
    base.push({ at: chunk[chunk.length - 1].created_at, ch, turns, text: wrap(turns, ch) });
  }
}

base.sort((a, b) => a.at - b.at);

const newest = base[base.length - 1]?.at ?? Date.now();
const cutoff = newest - VAL_DAYS * 86_400_000;

const valAll = base.filter((c) => c.at >= cutoff);
const trainBase = base.filter((c) => c.at < cutoff);

// --- 窓の切り方をずらして増やす (train だけ) ---
//
// 同じ発言が違う位置・違う文脈長で出る。境界が偶然一致した窓は落とす —
// 完全に同じ本文が並ぶと「写せば当たる」形になる。

const train = [];
const seen = new Set();
let duplicates = 0;

const push = (conv) => {
  if (seen.has(conv.text)) { duplicates += 1; return; }
  seen.add(conv.text);
  train.push(conv);
};

for (const conv of trainBase) push(conv);

// 基準以外の切り方。同じ本文になった窓は落とす
for (const cfg of TILINGS.slice(1)) {
  for (const [ch, rows] of byChannel) {
    for (const chunk of splitIntoChunks(rows, cfg)) {
      if (chunk.length < 2) continue;
      const at = chunk[chunk.length - 1].created_at;
      if (at >= cutoff) continue;                // val の期間には掛けない
      const turns = toTurns(chunk);
      push({ at, ch, turns, text: wrap(turns, ch) });
    }
  }
}

// --- 返信の鎖で窓を作る ---
//
// ここまでの窓は**時間の輪切り**だけ。Discord は複数の話題が同時に流れるので、
// ひとつの窓に無関係なやり取りが混ざる。返信が 113,001 件あるので、
// **鎖をたどってスレッド単位の窓**も作る。時間の窓とは違う塊になるので、
// 「同じ発言を違う文脈で見せる」という水増しの狙いがそのまま働く。
//
// **親は「返信先の本人の直近の発言」で近似する。**export-raw.mjs は message_id では
// なく相手の author 番号だけを書き出しているので、正確な親は引けない。Discord の
// 返信はほぼ直近の発言に付くので実害は小さく、取り違えても「その 2 人のやり取り」
// にはなるため、話題ごとにまとめるという狙いは保てる。
//
// **戻って引き直すことはしない。**正確な親が要るなら export-raw.mjs に列を足して
// アーカイブを取り直す必要があり、それは bot サーバ側の作業になる。
const REPLY_MAX_GAP_MS = Number(process.env.LLM_REPLY_GAP_MS ?? 6 * 60 * 60 * 1000);
const REPLY_MIN_MESSAGES = Number(process.env.LLM_REPLY_MIN ?? 3);

let chainCandidates = 0;
let chainWindows = 0;

if (Number(process.env.LLM_REPLY_CHAINS ?? 1)) {
  for (const [ch, rows] of byChannel) {
    const lastByAuthor = new Map();
    const parent = new Int32Array(rows.length).fill(-1);
    const children = new Map();

    rows.forEach((row, i) => {
      if (row.reply && row.reply_author != null && row.reply_author !== row.author) {
        const at = lastByAuthor.get(row.reply_author);
        if (at != null && row.created_at - rows[at].created_at <= REPLY_MAX_GAP_MS) {
          parent[i] = at;
          if (!children.has(at)) children.set(at, []);
          children.get(at).push(i);
        }
      }
      lastByAuthor.set(row.author, i);
    });

    // 根 = 親を持たず子を持つ発言。そこから木を丸ごと集める。
    // 枝分かれは畳んで時系列に並べ直す — 読む側は 1 本の会話しか知らない
    for (let root = 0; root < rows.length; root += 1) {
      if (parent[root] !== -1 || !children.has(root)) continue;

      const tree = [];
      const stack = [root];
      while (stack.length) {
        const i = stack.pop();
        tree.push(i);
        for (const c of children.get(i) ?? []) stack.push(c);
      }
      if (tree.length < REPLY_MIN_MESSAGES) continue;
      chainCandidates += 1;

      tree.sort((a, b) => a - b);            // rows は時系列なので索引順 = 時系列
      const picked = tree.map((i) => rows[i]);

      // 長い鎖は件数と字数だけで割る。**沈黙では切らない** (Infinity) —
      // 返信で繋がっている以上、間が空いていても同じ話題
      for (const chunk of splitIntoChunks(picked, { ...CHUNK, gapMs: Infinity })) {
        if (chunk.length < REPLY_MIN_MESSAGES) continue;
        const at = chunk[chunk.length - 1].created_at;
        if (at >= cutoff) continue;          // val の期間には掛けない
        const turns = toTurns(chunk);
        const before = train.length;
        push({ at, ch, turns, text: wrap(turns, ch) });
        if (train.length > before) chainWindows += 1;
      }
    }
  }
}

const tiledCount = train.length;
const tiledChars = train.reduce((sum, c) => sum + c.text.length, 0);

// --- 噛み合いと長い発言を重く見せる ---
//
// 切り出しは**基準の切り方からだけ**取る。別の切り方から取っても、切り出しは
// 3〜4 turn の局所的な範囲なので同じ本文にしかならない。
//
// 代わりに周回数で量を合わせる。基のコーパスが増えているのに 1 周のままだと
// train に占める割合が薄まって信号にならず、増やしすぎると窓の中身が短い会話
// ばかりになる。**ft で測って効いた割合に一番近くなる周回数を選ぶ。**
// 周ごとに匿名化する側をずらすので、複製どうしは同じ本文にならない。

/**
 * 切り出しの話者を**匿名の役に付け替える**。
 *
 * bot は `/as` を指定されていないとき匿名の役で喋る (`nextRole`)。ところが
 * 噛み合いの信号の 88.1% は名前持ちのものなので、そのままでは既定の経路に届かない。
 * 中身は変えず、誰が言ったかだけを出現順の役に移す。
 */
function anonymise(turns) {
  const map = new Map();
  const roleFor = (token) => {
    if (!token) return token;
    if (!map.has(token)) {
      map.set(token, ROLE_TOKENS[map.size] ?? ROLE_OVERFLOW);
    }
    return map.get(token);
  };

  // 先に全員へ役を振る。返信先がまだ喋っていない人でも引けるように
  for (const turn of turns) roleFor(turn.token);

  return turns.map((turn) => ({
    ...turn,
    token: roleFor(turn.token),
    replyTo: turn.replyTo ? roleFor(turn.replyTo) : null
  }));
}

// 切り出しは**元の会話のチャンネルを引き継ぐ**。落とすと `<|cx|>` 扱いになって、
// せっかく足したチャンネルの信号が切り出しのぶんだけ薄まる
const slice = (conv, [from, to]) => ({ turns: conv.turns.slice(from, to + 1), ch: conv.ch });

const qaExcerpts = trainBase.flatMap((conv) =>
  responseExcerptRanges(conv.turns).map((range) => slice(conv, range)));
const longExcerpts = trainBase.flatMap((conv) =>
  longExcerptRanges(conv.turns).map((range) => slice(conv, range)));
// **サーバーが実際に反応した発言。**`長い` や `噛み合った` はこちらの推測だが、
// これはサーバー自身が良いと示した直接の信号
const reactedExcerpts = trainBase.flatMap((conv) =>
  reactedExcerptRanges(conv.turns).map((range) => slice(conv, range)));

const sizeOf = (list) => list.reduce((sum, x) => sum + wrap(x.turns, x.ch).length, 0);
const qaPerRound = sizeOf(qaExcerpts);
const longPerRound = sizeOf(longExcerpts);
const reactedPerRound = sizeOf(reactedExcerpts);

/**
 * 目標の割合に一番近い周回数の組を選ぶ。
 *
 * 割合の分母は train 全体なので、噛み合いと長い発言は互いの周回数に依存する。
 * 候補が 1〜3 の 9 通りしかないので、素直に全部試して二乗誤差で選ぶ。
 */
// 周回数の上限。**3 では足りない。**切り方を 5 → 8 通りに増やしたとき、
// 素の窓が 1.54 倍になったのに周回数は 3 で頭打ちになり、噛み合い切り出しの
// 割合が 11.9% → 8.4% (目標 12.3%) まで薄まった。噛み合いの実測もほぼ同じ比で
// 53.3% → 36.7% に落ちている。**基のコーパスを増やすほどここが効く。**
const MAX_ROUNDS = Number(process.env.LLM_MAX_ROUNDS ?? 8);

function pickRounds() {
  let best = null;
  for (let nQa = 1; nQa <= MAX_ROUNDS; nQa += 1) {
    for (let nLong = 1; nLong <= MAX_ROUNDS; nLong += 1) {
      for (let nRe = 1; nRe <= MAX_ROUNDS; nRe += 1) {
        const total = tiledChars + nQa * qaPerRound + nLong * longPerRound
          + nRe * reactedPerRound;
        const error = ((nQa * qaPerRound / total) - QA_SHARE) ** 2
          + ((nLong * longPerRound / total) - LONG_SHARE) ** 2
          + ((nRe * reactedPerRound / total) - REACTED_SHARE) ** 2;
        if (!best || error < best.error) best = { nQa, nLong, nRe, error };
      }
    }
  }
  return best;
}

const { nQa: QA_ROUNDS, nLong: LONG_ROUNDS, nRe: REACTED_ROUNDS } = pickRounds();

let qaChars = 0;
let longChars = 0;
let reactedChars = 0;

// 噛み合いは 2 本に 1 本を匿名化。周ごとにずらすので、同じ切り出しの複製は
// 名前持ちと役が交互になる
for (let round = 0; round < QA_ROUNDS; round += 1) {
  qaExcerpts.forEach((x, i) => {
    // **1 は「全部」。**素朴に `% 1 === 1` と書くと 1 本も匿名化されない
    // (x % 1 は常に 0)。切り出しだけ全匿名にするのに 1 を使う
    const anon = EXCERPT.qaAnonEvery <= 1 || (i + round) % EXCERPT.qaAnonEvery === 1;
    const used = anon ? anonymise(x.turns) : x.turns;
    const text = wrap(used, x.ch);
    qaChars += text.length;
    train.push({ at: cutoff - 1, ch: x.ch, turns: used, text });
  });
}

// 長い発言は 4 本に 1 本だけ (残りは名前持ちのまま = なりきりの材料)
for (let round = 0; round < LONG_ROUNDS; round += 1) {
  longExcerpts.forEach((x, i) => {
    const anon = EXCERPT.longAnonEvery <= 1 || (i + round) % EXCERPT.longAnonEvery === 0;
    const used = anon ? anonymise(x.turns) : x.turns;
    const text = wrap(used, x.ch);
    longChars += text.length;
    train.push({ at: cutoff - 1, ch: x.ch, turns: used, text });
  });
}

// --- 話者ごとの切り出し (evex-5.2) ---
//
// **`/as` が壊れている。**弁別性の実測 (同じ人を 2 回引いた重なり − 他人との重なり):
//
//   evex-3.5  上位 -1.3% / 下位 +3.7%   ← 評判 1 位
//   evex-5.1  上位 +0.1% / 下位 +1.5%   ← 誰を指名しても似たことしか言わない
//
// 話者トークンは**その人が喋ったときにしか勾配が来ない**ので、段1 の外部を
// 23.3M → 158M にしたぶん相対的に薄まった。学習率で補正しようとして失敗済み
// (下位の弁別性 0.0%) — **出現回数そのものを増やすしかない。**
//
// 147 人それぞれから同じ本数だけ切り出し、**足りない人は繰り返して底上げする**。
// 発言数は最多 55,964 / 最少 203 で 276 倍の開きがあるので、ここを均すのが狙い。
// **匿名化しない** (名前のまま出すのが目的)。
const PER_SPEAKER = Number(process.env.LLM_PER_SPEAKER ?? 0);
const SPEAKER_MAX_REPEAT = Number(process.env.LLM_SPEAKER_MAX_REPEAT ?? 4);

let speakerExcerpts = [];
let speakerStats = { speakers: 0, unique: 0, emitted: 0, chars: 0 };

if (PER_SPEAKER > 0) {
  const bySpeaker = new Map();
  for (const conv of trainBase) {
    conv.turns.forEach((turn, i) => {
      if (!turn.token || !turn.token.startsWith('<|s')) return;
      const from = Math.max(0, i - EXCERPT.qaContext);
      if (i === from) return;                 // 会話の頭は文脈が無い
      if (!bySpeaker.has(turn.token)) bySpeaker.set(turn.token, []);
      bySpeaker.get(turn.token).push(slice(conv, [from, i]));
    });
  }

  for (const [, found] of bySpeaker) {
    speakerStats.speakers += 1;
    speakerStats.unique += found.length;
    // 足りない人は巡回して埋める。**上限を置く** — 203 件の人を 400 本にすると
    // 同じ本文が 2 回出る。4 倍を超えると丸暗記に寄るので、そこで止める
    const want = Math.min(PER_SPEAKER, found.length * SPEAKER_MAX_REPEAT);
    for (let i = 0; i < want; i += 1) speakerExcerpts.push(found[i % found.length]);
  }

  for (const x of speakerExcerpts) {
    const text = wrap(x.turns, x.ch);         // **匿名化しない**
    speakerStats.emitted += 1;
    speakerStats.chars += text.length;
    train.push({ at: cutoff - 1, ch: x.ch, turns: x.turns, text });
  }
}

// **リアクションの付いた発言。**段3 でここだけを流すので、
// train に混ぜるぶんとは別に `reacted` にも溜めておく
const reacted = [];
for (let round = 0; round < REACTED_ROUNDS; round += 1) {
  reactedExcerpts.forEach((x, i) => {
    const anon = EXCERPT.reactedAnonEvery <= 1
      || (i + round) % EXCERPT.reactedAnonEvery === 0;
    const used = anon ? anonymise(x.turns) : x.turns;
    const text = wrap(used, x.ch);
    reactedChars += text.length;
    train.push({ at: cutoff - 1, ch: x.ch, turns: used, text });
    if (round === 0) reacted.push(text);
  });
}

// --- val をきれいにする ---
//
// **train に同じ本文がある会話を外す。**「草」「www」のような完全一致の短文が
// 23% あるので、時間で切っても中身が同じ会話は残る。残すと val が「暗記できたか」
// を測ることになる。切り出しと水増しまで含めた最終の train と突き合わせる。

const trainTexts = new Set(train.map((c) => c.text));
const valSeen = new Set();
const val = [];
let valLeaked = 0;
let valDuplicated = 0;

for (const conv of valAll) {
  if (trainTexts.has(conv.text)) { valLeaked += 1; continue; }
  if (valSeen.has(conv.text)) { valDuplicated += 1; continue; }
  valSeen.add(conv.text);
  val.push(conv);
}

// --- 書き出し ---

await mkdir(dst, { recursive: true });

await writeFile(path.join(dst, 'train.txt'), `${train.map((c) => c.text).join('\n')}\n`);
await writeFile(path.join(dst, 'val.txt'), `${val.map((c) => c.text).join('\n')}\n`);

// --- 段1 (事前学習) の train を作る ---
//
// **二段にする。**段1 で外部の会話を混ぜて土台を作り、段2 は evex だけで仕上げる。
// 混合比だけで evex 率を守ろうとすると、外部が数倍あるぶん永久に薄まる。
// 最後が evex なら分布は evex に戻り、土台の恩恵だけ取れる。
//
// **段1 の evex 側は素の会話 (base.txt) を使う。**
// 最初は切り出しまで足した train.txt を入れていたが、それだと土台作りの段から
// 同じ発言を 2.08 回見せることになり、**段2 用の水増しを前借りする**形だった。
// 素の会話にすると外部比率も 40% → 約 76% になって「土台」らしくなる。
//
// 段1 にも evex を入れるのは、**147 個の話者トークンをここで動かしておく**ため。
// 外部には役しか出てこないので、入れないと `<|sN|>` の埋め込みが段2 で
// 初期値から始まることになる。
//
// val は段1 でも evex のものを使う (train.py が {corpus}/val.txt を読む)。
// 「外部を混ぜている最中に evex の val がどう動くか」が見たい値そのもの。

const baseLines = trainBase.map((c) => c.text);
await writeFile(path.join(dst, 'base.txt'), `${baseLines.join('\n')}\n`);

// **段1 の中の evex 比率を目標で固定する。**
//
// 外部を増やすほど段1 の evex が薄まる。v5 は 5.2M / 23.3M = 22% だったが、
// v7 は外部が 3 倍になるので素のままだと 6.7% で、**147 個の話者トークンが
// 段1 で 1 周しか勾配を受けない**。段2 で戻すとはいえ、初期値に近いまま
// 段2 に渡すのは損。
//
// 足りない分は**同じ本文を繰り返さず、別の切り方と返信の鎖から足す**
// (train の先頭 tiledCount 件 = 切り出しを除いた窓の水増し全部)。
// 同じ発言が違う位置・違う文脈長・違う役で出るので、素朴な複製より効く。
// プールを使い切ったら初めて先頭から巡回する。
const BASE_SHARE = Number(process.env.LLM_BASE_SHARE ?? 0.15);

const evexPool = train.slice(0, tiledCount).map((c) => c.text);
const poolChars = evexPool.reduce((sum, l) => sum + l.length, 0);

let pretrainStats = null;

// **複数受ける。**v7 では なりきり掲示板 と JESC 字幕 の 2 本を混ぜる。
// 1 本しか受けない作りのままだと、混ぜるのに事前の cat が要って手順が増える
const externalPaths = (process.env.LLM_EXTERNAL ?? '')
  .split(',').map((x) => x.trim()).filter(Boolean);

if (externalPaths.length) {
  // **流しながら書く。**外部は 200M 字を超えるので、全部を配列に持つと
  // 文字列だけで GB 級になる (最初 `push(...lines)` で call stack も溢れた)。
  const sink = createWriteStream(path.join(dst, 'pretrain.txt'), { encoding: 'utf8' });
  const emit = (line) => new Promise((resolve) => {
    if (sink.write(`${line}\n`)) resolve();
    else sink.once('drain', resolve);
  });

  const perFile = [];
  let externalConversations = 0;
  let externalChars = 0;

  for (const file of externalPaths) {
    let conversations = 0;
    let fileChars = 0;
    let leaked = 0;
    let rest = '';

    // `\n` だけで切る。readline は U+2028 / U+2029 / U+0085 も行終端にする
    for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
      const parts = (rest + chunk).split('\n');
      rest = parts.pop();
      for (const line of parts) {
        if (!line) continue;
        // **外部に話者トークンが混ざっていないこと。**破れると <|s0|> が
        // なりきり掲示板や字幕やなんJ の口調を覚える
        if (/<\|s\d+\|>/.test(line)) { leaked += 1; continue; }
        conversations += 1;
        fileChars += line.length;
        await emit(line);
      }
    }
    if (rest) {
      if (/<\|s\d+\|>/.test(rest)) leaked += 1;
      else { conversations += 1; fileChars += rest.length; await emit(rest); }
    }

    if (leaked > 0) {
      throw new Error(`${file} に話者トークンが ${leaked} 行ある。作り手のスクリプトを直す`);
    }

    perFile.push({ file, conversations, chars: fileChars });
    externalConversations += conversations;
    externalChars += fileChars;
  }

  // 目標比率 p のとき evex 側に要る字数は  外部 × p / (1 - p)
  const wantChars = externalChars * BASE_SHARE / (1 - BASE_SHARE);
  let evexConversations = 0;
  let evexChars = 0;
  for (let i = 0; evexChars < wantChars && evexPool.length; i += 1) {
    const line = evexPool[i % evexPool.length];
    evexConversations += 1;
    evexChars += line.length;
    await emit(line);
  }

  await new Promise((resolve) => sink.end(resolve));

  pretrainStats = {
    external_files: perFile,
    external_conversations: externalConversations,
    external_chars: externalChars,
    base_share_target: BASE_SHARE,
    base_conversations_train: evexConversations,
    base_chars: evexChars,
    base_pool_conversations: evexPool.length,
    base_pool_chars: poolChars,
    base_passes: Number((evexChars / poolChars).toFixed(2)),
    pretrain_conversations: externalConversations + evexConversations,
    pretrain_chars: externalChars + evexChars
  };
}

// --- 段3 (evex度の仕上げ) ---
//
// **リアクションの付いた発言の切り出しだけ**を流す。量が小さい (見込み 2.4M 字)
// ので過学習しやすい。lr を落として 1〜2 epoch にし、逐語コピーで見る。
await writeFile(path.join(dst, 'reacted.txt'), `${reacted.join('\n')}\n`);

// **件数だけの表。**話者の学習率補正 (train.py --speaker-lr-cap) が要るのは
// 件数だけなので、身元を含まないこちらを HF のデータセットに上げる。
// speakers.json をジョブに渡すと userId と表示名が外に出る
await writeFile(path.join(dst, 'speaker-counts.json'), JSON.stringify(
  named.map((a, rank) => ({ token: `<|s${rank}|>`, rank, count: a.count })), null, 1
));

// **userId と表示名が入っている。HF にはこのファイルを上げない。**
// 公開するのは rank と件数だけ (evex-1 / evex-2 と同じ扱い)
await writeFile(path.join(dst, 'speakers.json'), JSON.stringify(
  named.map((a, rank) => ({
    token: `<|s${rank}|>`, rank, userId: a.id, idx: a.idx, name: a.name, count: a.count
  })), null, 1
));

// --- 統計 ---

const chars = (list) => list.reduce((sum, c) => sum + c.text.length, 0);
const trainChars = chars(train);
const fmt = (n) => n.toLocaleString();

// リアクションの付いた人間の発言。切り出しの分母
let reactedMessages = 0;
for (const rows of byChannel.values()) {
  for (const row of rows) if ((row.reactions ?? 0) >= EXCERPT.reactedMin) reactedMessages += 1;
}

// 固有トークンを持つチャンネルが発言全体のどれだけを覆うか。ft 系は上位16chで 97%
const channelTotal = channels.reduce((sum, c) => sum + c.count, 0);
const channelCoverage = channels
  .filter((c) => channelRank.has(c.idx))
  .reduce((sum, c) => sum + c.count, 0) / channelTotal;

// 固有トークンで喋る発言の割合。ft 系は 96.6%
const namedMessages = named.reduce((sum, a) => sum + a.count, 0);
const humanMessages = authors.filter((a) => !a.bot).reduce((sum, a) => sum + a.count, 0);
const coverage = namedMessages / humanMessages;

// `<|re|>` の後ろに相手が入っている件数
let replyWithTarget = 0;
let replyTotal = 0;
for (const conv of base) {
  for (const turn of conv.turns) {
    if (turn.reply || turn.replyTo) replyTotal += 1;
    if (turn.replyTo) replyWithTarget += 1;
  }
}

const stats = {
  read, bots,
  named_speakers: named.length,
  named_min_messages: NAMED_MIN_MESSAGES,
  speaker_coverage: Number(coverage.toFixed(4)),
  chunk: CHUNK,
  tilings: TILINGS,
  val_days: VAL_DAYS,
  base_conversations: base.length,
  tiled_conversations: tiledCount,
  tiled_chars: tiledChars,
  duplicate_windows: duplicates,
  chain_windows: chainWindows,
  chain_candidates: chainCandidates,
  named_channels: NAMED_CHANNELS,
  channel_coverage: Number(channelCoverage.toFixed(4)),
  qa_excerpts: qaExcerpts.length,
  long_excerpts: longExcerpts.length,
  reacted_excerpts: reactedExcerpts.length,
  reacted_messages: reactedMessages,
  qa_rounds: QA_ROUNDS,
  long_rounds: LONG_ROUNDS,
  reacted_rounds: REACTED_ROUNDS,
  qa_chars: qaChars,
  long_chars: longChars,
  reacted_chars: reactedChars,
  reacted_conversations: reacted.length,
  // train に混ぜたぶん (周回込み) とは別。段3 のファイルそのものの大きさ
  reacted_file_chars: reacted.reduce((sum, t) => sum + t.length, 0),
  qa_min_answer: EXCERPT.qaMinAnswer,
  qa_context: EXCERPT.qaContext,
  long_min: EXCERPT.longMin,
  reply_total: replyTotal,
  reply_with_target: replyWithTarget,
  train: train.length,
  val: val.length,
  val_leaked_to_train: valLeaked,
  val_duplicated: valDuplicated,
  ...(pretrainStats ?? {}),
  train_chars: trainChars,
  val_chars: chars(val)
};

await writeFile(path.join(dst, 'stats.json'), JSON.stringify(stats, null, 1));

console.log(`読んだ行         ${fmt(read)} (bot を除外 ${fmt(bots)})`);
console.log(`話者トークン     ${named.length} 人 (${NAMED_MIN_MESSAGES} 件以上 / `
  + `発言の ${(coverage * 100).toFixed(1)}% を被覆) + 役 ${ROLE_TOKENS.length} + 溢れ 1`);
console.log(`返信             ${fmt(replyTotal)} 件 / うち相手が分かるもの ${fmt(replyWithTarget)}`);
console.log(`会話 (素の切り方) ${fmt(base.length)}  train ${fmt(trainBase.length)} / val ${fmt(val.length)} `
  + `(train と同じ ${valLeaked} 件と val 内の重複 ${valDuplicated} 件を外した)`);
console.log(`窓の切り方       ${TILINGS.length} 通り (${TILINGS.map((t) => `${t.gapMs / 60000}分/${t.maxChars}字`).join(' ')}) `
  + `→ ${fmt(tiledCount)} 会話 (${(tiledCount / trainBase.length).toFixed(2)} 倍 / `
  + `同じ本文 ${fmt(duplicates)} 件は落とした)`);
console.log(`噛み合った箇所   ${fmt(qaExcerpts.length)} を ×${QA_ROUNDS} `
  + `(応答は ${EXCERPT.qaMinAnswer} 字以上 / ${fmt(qaChars)} 字 = train の `
  + `${(qaChars / trainChars * 100).toFixed(1)}% / 目標 ${(QA_SHARE * 100).toFixed(1)}%)`);
console.log(`長い発言         ${fmt(longExcerpts.length)} を ×${LONG_ROUNDS} `
  + `(${EXCERPT.longMin} 字以上 / ${fmt(longChars)} 字 = train の `
  + `${(longChars / trainChars * 100).toFixed(1)}% / 目標 ${(LONG_SHARE * 100).toFixed(1)}% / `
  + `${EXCERPT.longAnonEvery} 本に 1 本だけ匿名化)`);
console.log(`リアクション付き ${fmt(reactedExcerpts.length)} を ×${REACTED_ROUNDS} `
  + `(${EXCERPT.reactedMin} 個以上 / 発言 ${fmt(reactedMessages)} 件 / ${fmt(reactedChars)} 字 = train の `
  + `${(reactedChars / trainChars * 100).toFixed(1)}% / 目標 ${(REACTED_SHARE * 100).toFixed(1)}%)`);
if (PER_SPEAKER > 0) {
  console.log(`話者ごとの切り出し ${fmt(speakerStats.emitted)} 本 `
    + `(${speakerStats.speakers} 人 / 元 ${fmt(speakerStats.unique)} 本を 1 人 ${PER_SPEAKER} 本まで `
    + `${SPEAKER_MAX_REPEAT} 倍を上限に底上げ / ${fmt(speakerStats.chars)} 字 = train の `
    + `${(speakerStats.chars / trainChars * 100).toFixed(1)}% / 匿名化しない)`);
}
console.log(`返信の鎖         ${fmt(chainWindows)} 窓 (木 ${fmt(chainCandidates)} 本 / `
  + `${REPLY_MIN_MESSAGES} 発言以上 / 親は直近の発言で近似)`);
console.log(`チャンネル       ${NAMED_CHANNELS} 個に固有トークン `
  + `(発言の ${(channelCoverage * 100).toFixed(1)}% を被覆) + 溢れ ${CHANNEL_OVERFLOW}`);
console.log(`文字数           train ${fmt(trainChars)} / val ${fmt(chars(val))}`);
console.log(`1 会話あたり     ${Math.round(trainChars / train.length)} 字`);
if (pretrainStats) {
  const p = pretrainStats;
  console.log(`段1 (事前学習)   ${fmt(p.pretrain_conversations)} 会話 / ${fmt(p.pretrain_chars)} 字`);
  for (const f of p.external_files) {
    console.log(`  ${f.file.padEnd(24)} ${fmt(f.conversations).padStart(9)} 会話 / `
      + `${fmt(f.chars).padStart(11)} 字 (${(f.chars / p.pretrain_chars * 100).toFixed(0)}%)`);
  }
  console.log(`  うち evex      ${fmt(p.base_conversations_train)} 会話 / ${fmt(p.base_chars)} 字 `
    + `(${(p.base_chars / p.pretrain_chars * 100).toFixed(1)}% / 目標 ${(BASE_SHARE * 100).toFixed(0)}% / `
    + `窓の水増し ${fmt(p.base_pool_conversations)} 本を ${p.base_passes} 周。切り出しは入れない)`);
  console.log(`  話者トークンの混入 0 (確認済み)`);
}
console.log(`段2 (仕上げ)     ${fmt(train.length)} 会話 / ${fmt(trainChars)} 字 (evex だけ)`);
console.log(`段3 (evex度)     ${fmt(reacted.length)} 会話 / `
  + `${fmt(reacted.reduce((sum, t) => sum + t.length, 0))} 字 (リアクション付きだけ)`);

console.log(`\n出力 ${dst}/ (train.txt / base.txt / val.txt / reacted.txt`
  + `${pretrainStats ? ' / pretrain.txt' : ''} / speakers.json / stats.json)`);
console.log('speakers.json には userId と表示名が入っている。**HF には上げない**');
