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
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';

// 「どこを拾うか」は build-sft.mjs (Qwen 用) と同じ規則。条件を2箇所に持つとずれる
import { EXCERPT, longExcerptRanges, responseExcerptRanges } from './excerpts.mjs';

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
const QA_SHARE = Number(process.env.LLM_QA_SHARE ?? 0.123);
const LONG_SHARE = Number(process.env.LLM_LONG_SHARE ?? 0.256);

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
const MINUTE = 60_000;
const TILINGS = [
  { gapMs: 60 * MINUTE, maxMessages: 60, maxChars: 3600 },
  { gapMs: 30 * MINUTE, maxMessages: 60, maxChars: 2400 },
  { gapMs: 120 * MINUTE, maxMessages: 60, maxChars: 5400 }
].slice(0, Number(process.env.LLM_TILINGS ?? 3));

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
  const [ch, author, createdAt, isBot, isReply, content, , replyAuthor] = JSON.parse(line);
  if (isBot) { bots += 1; continue; }

  const text = messageText(content);

  if (!byChannel.has(ch)) byChannel.set(ch, []);
  byChannel.get(ch).push({
    author,
    created_at: createdAt,
    reply: isReply,
    reply_author: replyAuthor ?? null,
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
      // excerpts.mjs の判定に渡す形。宛先は別に持っているので raw と body は同じ
      key: self,
      raw: row.content,
      body: row.content,
      target
    };
  });
}

const wrap = (turns) => `${buildPrompt(turns)}<|end|>`;

// 基準の切り方。val と切り出しはここからしか作らない
const base = [];

for (const rows of byChannel.values()) {
  for (const chunk of splitIntoChunks(rows, CHUNK)) {
    if (chunk.length < 2) continue;              // 1 発言だけの「会話」は交代を教えない
    const turns = toTurns(chunk);
    base.push({ at: chunk[chunk.length - 1].created_at, turns, text: wrap(turns) });
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
  for (const rows of byChannel.values()) {
    for (const chunk of splitIntoChunks(rows, cfg)) {
      if (chunk.length < 2) continue;
      const at = chunk[chunk.length - 1].created_at;
      if (at >= cutoff) continue;                // val の期間には掛けない
      const turns = toTurns(chunk);
      push({ at, turns, text: wrap(turns) });
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

const slice = (turns, [from, to]) => turns.slice(from, to + 1);

const qaExcerpts = trainBase.flatMap((conv) =>
  responseExcerptRanges(conv.turns).map((range) => slice(conv.turns, range)));
const longExcerpts = trainBase.flatMap((conv) =>
  longExcerptRanges(conv.turns).map((range) => slice(conv.turns, range)));

const sizeOf = (list) => list.reduce((sum, turns) => sum + wrap(turns).length, 0);
const qaPerRound = sizeOf(qaExcerpts);
const longPerRound = sizeOf(longExcerpts);

/**
 * 目標の割合に一番近い周回数の組を選ぶ。
 *
 * 割合の分母は train 全体なので、噛み合いと長い発言は互いの周回数に依存する。
 * 候補が 1〜3 の 9 通りしかないので、素直に全部試して二乗誤差で選ぶ。
 */
function pickRounds() {
  let best = null;
  for (let nQa = 1; nQa <= 3; nQa += 1) {
    for (let nLong = 1; nLong <= 3; nLong += 1) {
      const total = tiledChars + nQa * qaPerRound + nLong * longPerRound;
      const error = ((nQa * qaPerRound / total) - QA_SHARE) ** 2
        + ((nLong * longPerRound / total) - LONG_SHARE) ** 2;
      if (!best || error < best.error) best = { nQa, nLong, error };
    }
  }
  return best;
}

const { nQa: QA_ROUNDS, nLong: LONG_ROUNDS } = pickRounds();

let qaChars = 0;
let longChars = 0;

// 噛み合いは 2 本に 1 本を匿名化。周ごとにずらすので、同じ切り出しの複製は
// 名前持ちと役が交互になる
for (let round = 0; round < QA_ROUNDS; round += 1) {
  qaExcerpts.forEach((turns, i) => {
    const used = (i + round) % EXCERPT.qaAnonEvery === 1 ? anonymise(turns) : turns;
    const text = wrap(used);
    qaChars += text.length;
    train.push({ at: cutoff - 1, turns: used, text });
  });
}

// 長い発言は 4 本に 1 本だけ (残りは名前持ちのまま = なりきりの材料)
for (let round = 0; round < LONG_ROUNDS; round += 1) {
  longExcerpts.forEach((turns, i) => {
    const used = (i + round) % EXCERPT.longAnonEvery === 0 ? anonymise(turns) : turns;
    const text = wrap(used);
    longChars += text.length;
    train.push({ at: cutoff - 1, turns: used, text });
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
  qa_excerpts: qaExcerpts.length,
  long_excerpts: longExcerpts.length,
  qa_rounds: QA_ROUNDS,
  long_rounds: LONG_ROUNDS,
  qa_chars: qaChars,
  long_chars: longChars,
  qa_min_answer: EXCERPT.qaMinAnswer,
  qa_context: EXCERPT.qaContext,
  long_min: EXCERPT.longMin,
  reply_total: replyTotal,
  reply_with_target: replyWithTarget,
  train: train.length,
  val: val.length,
  val_leaked_to_train: valLeaked,
  val_duplicated: valDuplicated,
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
console.log(`文字数           train ${fmt(trainChars)} / val ${fmt(chars(val))}`);
console.log(`1 会話あたり     ${Math.round(trainChars / train.length)} 字`);
console.log(`\n出力 ${dst}/ (train.txt / val.txt / speakers.json / stats.json)`);
console.log('speakers.json には userId と表示名が入っている。**HF には上げない**');
