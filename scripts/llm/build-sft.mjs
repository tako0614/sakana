// 既存の大きいモデルに口調を移すためのコーパスを作る (evex-3)。
//
//   node scripts/llm/build-sft.mjs [入力 corpus/] [出力 sft/]
//
// build-corpus.mjs との違いは、出力が**素の日本語**だということ。
// あちらは自作 tokenizer 用に `<url>` `<file>` `<nl>` `<|a|>` を作るが、
// Qwen3-0.6B-Base は既に日本語を知っているので、独自の記号を渡すのは損になる:
//
//   - 新しいトークンを足すと、その埋め込みだけ未学習の状態から始まる
//   - `<nl>` は事前学習で一度も見ていない。素の改行なら 1 トークンで済む
//   - `A:` `B:` のような会話の書き方は、事前学習で大量に見ている形
//
// なので役は素の英字、改行は改行、URL は本物のまま (ただし origin だけ) にする。
//
// evex-1 の `<file>` 問題もここで消える。本文が空の 21,329 件は、あちらでは
// `<file>` 1 トークンの発言になり「発言の先頭で <file> が来る」確率を上げて
// 返答の 38% を「(画像)」だけにした。ここでは**落とす**。プレースホルダを
// 置かなければ、そもそも学習に入らない。列を足して生データを運び直す必要もない。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';

process.env.ARCHIVE_DB_PATH = path.join(os.tmpdir(), 'sakana-sft-scratch.sqlite');
const { splitIntoChunks } = await import('../../src/archive/chunks.js');
const { assignRoles } = await import('../../src/mimic/serialize.js');

const src = process.argv[2] ?? 'corpus';
const dst = process.argv[3] ?? 'sft';

// 役は素の英字。方針 (出現順 / 8人まで / あとは Z) は assignRoles に任せる。
// 定義を2箇所に持つとずれるので、ここでは形だけ差し替える。
// **名前が付かない人だけ**がこれを使う。
const SCHEME = { roles: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], overflow: 'Z' };

// 発言がこれ以上ある人は表示名をそのままラベルにする。
//
// 相対の役 (A/B/C) だけにしていた最初の版は、狙いどおり個人を漏らさなかった —
// 実測で役 A の中身は 1,062 人ぶんで、最多の人でも 10.4% (その人の全体シェア 9.4%
// とほぼ同じ)。つまり `A` は「このサーバーの平均的な人」であって誰でもない。
// おかげで「その人として喋る」が原理的に不可能だった。
//
// 名前をラベルにすると重みに個人の口調が入る。トークンの追加コストは実測 +1.32M
// (素の英字 1.76M → 3.07M) で全体の +17%。
// 閾値を 2000 件 (42人 / 被覆 83.4%) から 200 件 (147人 / 96.6%) に下げても
// 追加コストは +0.21M しか増えないので、下げた方が得。
const NAMED_MIN_MESSAGES = Number(process.env.LLM_NAMED_MIN ?? 200);

// ラベルの長さの上限。`vivacious_flamingo_38533` のような自動生成名が 24 字あり、
// 1 発言ごとに何トークンも食う。切っても本人の識別には足りる。
const LABEL_MAX = 12;

// 上位いくつのチャンネルに名前を与えるか。280 チャンネルのうち上位 16 で 97%。
// 話題の手がかりになるので入れるが、名前は書き出しに無いので番号のまま使う。
const NAMED_CHANNELS = 16;

// 会話の切り方。意味検索の既定 (15分 / 20件 / 1200字) をそのまま使っていたが、
// あれは「検索の単位」として決めた値で、学習の窓には短すぎた。
//
// 実測 (トークンは 1.62 字/tok 換算):
//   沈黙15分 上限1200   中位 262 tok / 8割位  350 / 1窓に 4.1 会話  ← 前の設定
//   沈黙60分 上限3600   中位 557 tok / 8割位 1003 / 1窓に 1.7 会話  ← これ
//   沈黙60分 上限8000   中位 201 tok / 8割位 1787
//   沈黙3時間 上限8000  中位 568 tok / 8割位 1960
//
// 上限を外しすぎると逆に悪くなる。賑やかな時間帯だけ巨大化して単発が短いまま
// 残るので、分布が歪んで中位が落ちる。上限 3600 が残っていると賑やかな部分が
// 約1000トークンに切り揃えられて均一になる。
//
// seq 1024 に対して 8割位が 1003 なので、ほとんどの会話が1窓に収まる。
// seq を 2048 に上げる手もあるが、vocab 151,936 の logits が倍になって
// T4 では OOM に戻る (batch 2 × 1024 で実際に落ちた)。
const CHUNK = {
  gapMs: Number(process.env.LLM_CHUNK_GAP_MS ?? 60 * 60 * 1000),
  maxMessages: Number(process.env.LLM_CHUNK_MAX_MESSAGES ?? 60),
  maxChars: Number(process.env.LLM_CHUNK_MAX_CHARS ?? 3600)
};

const VAL_DAYS = Number(process.env.LLM_VAL_DAYS ?? 14);

const authors = JSON.parse(await readFile(path.join(src, 'authors.json'), 'utf8'));
const channels = JSON.parse(await readFile(path.join(src, 'channels.json'), 'utf8'));

// Discord の snowflake → 書き出しの番号。本文中の `<@123>` をラベルに直すのに使う
const authorIdxById = new Map(authors.map((a) => [a.id, a.idx]));

/**
 * 表示名をラベルに使える形にする。
 *
 * `:` と改行は行の構造そのものなので必ず落とす (`名前: 本文` の形が壊れる)。
 * 空白は詰める — `it's o` のような名前で行頭が曖昧になるのを避けたい。
 */
function cleanName(name) {
  return String(name ?? '')
    .replace(/[:\n\r]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_MAX)
    .trim();
}

// idx → ラベル。発言数の多い順に決める。
//
// 表示名は重複する (実データで `.` `羽風` `だこ` `やがみ` が各2人)。そのまま使うと
// 別人の口調が1つのラベルに混ざるので、後から来た方に連番を付ける。
const labelByIdx = new Map();
const takenLabels = new Set();

for (const author of [...authors].sort((a, b) => b.count - a.count)) {
  if (author.bot || author.count < NAMED_MIN_MESSAGES) continue;

  const base = cleanName(author.name);
  if (!base) continue;                      // 名前が記号だけなら諦めて役に回す

  let label = base;
  for (let n = 2; takenLabels.has(label); n += 1) label = `${base}${n}`;

  takenLabels.add(label);
  labelByIdx.set(author.idx, label);
}

const speakerLabelOf = (idx) => labelByIdx.get(idx) ?? null;

// 件数の多い順に 16 個だけ名前を持つ。それ以外は #other に潰す
const ranked = [...channels].sort((a, b) => b.count - a.count);
const channelLabel = new Map(
  ranked.slice(0, NAMED_CHANNELS).map((c, rank) => [c.id, `#ch${rank}`])
);
const labelOf = (id) => channelLabel.get(id) ?? '#other';

/** URL は origin だけ残す。パスは 20 トークン食って何も教えない (CDN の署名付きが多い)。 */
function shorten(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Discord の記法を素の日本語に直す。
 *
 * メンションはラベルに直す。名前を持つ人は名前、持たない人は会話の中に居れば役、
 * 居なければ落とす — 20 桁の ID を残しても学ぶものが無い。
 * `@たこ` の形で残ると「誰に答えているか」が本文に入るので、evex-1 が捨てていた
 * 返信先の信号がここで手に入る。
 */
function plainText(content, roleOf) {
  let out = content;

  out = out.replace(/<@!?(\d+)>/g, (match, id) => {
    const idx = authorIdxById.get(id);
    const label = speakerLabelOf(idx) ?? roleOf(idx);
    return label ? `@${label}` : '';
  });
  out = out.replace(/<@&\d+>/g, '');                       // ロール
  out = out.replace(/<#(\d+)>/g, (match, id) => labelOf(id));
  out = out.replace(/<a?:([\w~]+):\d+>/g, ':$1:');          // カスタム絵文字
  out = out.replace(/https?:\/\/\S+/g, shorten);

  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- 会話を組む ---

const byChannel = new Map();
let read = 0;
let bots = 0;
let empty = 0;

// readline は使わない。U+2028 / U+2029 も行終端として扱うので、それを含む本文で
// JSON レコードが割れる (実データに 5 件あった)。
const raw = gunzipSync(await readFile(path.join(src, 'raw.jsonl.gz'))).toString('utf8');

/**
 * 本文が空の発言を添付・埋め込み・スタンプの中身で埋める。
 *
 * evex-1 はこれを渡されていなくて、空の発言を全部 `<file>` の1トークンにしていた。
 * 結果「発言の先頭で記号が来る」確率が上がり、返答の 38% が「(画像)」だけになった
 * (推論側でトークンを禁止して 12% に抑えたが、あれは症状の抑え込み)。
 *
 * extra は `IMG_2931.png` / `[埋め込み] タイトル — 説明` / `[スタンプ] name` の形。
 * 素のファイル名は何も教えないが、**その発言が存在すること自体**が会話の流れを
 * 教える (誰かが画像を貼って、他の人が反応する)。角括弧で囲って「喋った言葉では
 * ない」と分かる形にそろえる。
 */
function fromExtra(extra) {
  const text = String(extra ?? '').trim();
  if (!text) return '';
  return text.startsWith('[') ? text : `[添付] ${text}`;
}

for (const line of raw.split('\n')) {
  if (!line) continue;
  read += 1;

  // 列が 6 個の古い書き出しも読める。extra と reply_author は後から足した
  const [ch, author, createdAt, isBot, isReply, content, extra, replyAuthor] = JSON.parse(line);
  if (isBot) { bots += 1; continue; }

  const body = (content && content.trim()) ? content : fromExtra(extra);
  if (!body) { empty += 1; continue; }

  if (!byChannel.has(ch)) byChannel.set(ch, []);
  byChannel.get(ch).push({
    author,
    created_at: createdAt,
    reply: isReply,
    reply_author: replyAuthor ?? null,
    content: body,
    // splitIntoChunks が字数で切るのに使う。正規化で少し縮むが、
    // 縮む方向なので上限を割ることはない
    char_count: body.length
  });
}

const channelIdByIdx = new Map(channels.map((c) => [c.idx, c.id]));
const conversations = [];

for (const [chIdx, rows] of byChannel) {
  const label = labelOf(channelIdByIdx.get(chIdx));

  for (const chunk of splitIntoChunks(rows, CHUNK)) {
    // 名前を持たない人だけに A,B,C... を振る。名前持ちに役を配ると、
    // 同じ会話で「たこ」と「B」が同一人物という矛盾した形になる
    const unnamed = chunk.map((row) => row.author).filter((idx) => !labelByIdx.has(idx));
    const roles = assignRoles(unnamed, SCHEME);
    const roleOf = (idx) => (idx === undefined ? null : roles.get(idx) ?? null);

    const lines = [];
    for (const row of chunk) {
      let text = plainText(row.content, roleOf);
      if (!text) continue;                        // 正規化で空になった (メンションだけ等)

      // 誰への返信かを本文の先頭に残す。evex-1 は「返信かどうか」の真偽値しか
      // 持っていなくて相手を捨てていたが、賑やかなチャンネルでは噛み合いの信号そのもの。
      // 既に @ で始まっているならメンションで足りているので触らない。
      const target = row.reply_author != null && row.reply_author !== row.author
        ? (speakerLabelOf(row.reply_author) ?? roleOf(row.reply_author))
        : null;
      if (target && !text.startsWith('@')) text = `@${target} ${text}`;

      lines.push(`${speakerLabelOf(row.author) ?? roles.get(row.author)}: ${text}`);
    }

    // 1 発言だけの「会話」は交代を教えないので落とす
    if (lines.length < 2) continue;

    conversations.push({
      at: chunk[chunk.length - 1].created_at,
      text: `${label}\n${lines.join('\n')}`
    });
  }
}

conversations.sort((a, b) => a.at - b.at);

// val は「最後の N 日ぶんの会話」。ランダム分割にしない —
// 「草」「www」のような完全一致が 23% あるので、時間で切らないと val が嘘になる
const newest = conversations[conversations.length - 1]?.at ?? Date.now();
const cutoff = newest - VAL_DAYS * 86_400_000;

const train = conversations.filter((c) => c.at < cutoff);
const val = conversations.filter((c) => c.at >= cutoff);

await mkdir(dst, { recursive: true });

const jsonl = (list) => `${list.map((c) => JSON.stringify({ text: c.text })).join('\n')}\n`;
await writeFile(path.join(dst, 'train.jsonl'), jsonl(train));
await writeFile(path.join(dst, 'val.jsonl'), jsonl(val));

// bot 側がラベルを引けるようにする。これが無いと /mimic がどの文字列で
// 呼べばいいか分からない (学習していないラベルを渡すと、モデルは一度も見ていない
// 入力を受け取って静かに崩れる)。実 ID を含むので公開物には混ぜない。
const idById = new Map(authors.map((a) => [a.idx, a.id]));
const labels = [...labelByIdx.entries()]
  .map(([idx, label]) => ({
    label,
    userId: idById.get(idx),
    name: authors.find((a) => a.idx === idx)?.name ?? '',
    count: authors.find((a) => a.idx === idx)?.count ?? 0
  }))
  .sort((a, b) => b.count - a.count);

await writeFile(path.join(dst, 'labels.json'), `${JSON.stringify(labels, null, 1)}\n`);

const chars = (list) => list.reduce((sum, c) => sum + c.text.length, 0);
await writeFile(
  path.join(dst, 'stats.json'),
  `${JSON.stringify({
    read,
    bots,
    empty_dropped: empty,
    conversations: conversations.length,
    train: train.length,
    val: val.length,
    train_chars: chars(train),
    val_chars: chars(val),
    val_days: VAL_DAYS,
    named_channels: NAMED_CHANNELS,
    chunk: CHUNK,
    named_speakers: labelByIdx.size,
    named_min_messages: NAMED_MIN_MESSAGES
  }, null, 2)}\n`
);

const fmt = (n) => n.toLocaleString('en-US');
console.log(`読んだ           ${fmt(read)} (bot ${fmt(bots)} / 本文なし ${fmt(empty)} を除外)`);
console.log(`会話             ${fmt(conversations.length)}  train ${fmt(train.length)} / val ${fmt(val.length)}`);
console.log(`文字数           train ${fmt(chars(train))} / val ${fmt(chars(val))}`);
console.log(`1 会話あたり     ${Math.round(chars(train) / train.length)} 字`);
console.log(`名前ラベル       ${labelByIdx.size} 人 (${NAMED_MIN_MESSAGES} 件以上)`);
console.log(`\n--- 先頭の会話 ---\n${train[0]?.text.slice(0, 400)}`);
