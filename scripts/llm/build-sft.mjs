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
const SCHEME = { roles: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], overflow: 'Z' };

// 上位いくつのチャンネルに名前を与えるか。280 チャンネルのうち上位 16 で 97%。
// 話題の手がかりになるので入れるが、名前は書き出しに無いので番号のまま使う。
const NAMED_CHANNELS = 16;

const VAL_DAYS = Number(process.env.LLM_VAL_DAYS ?? 14);

const authors = JSON.parse(await readFile(path.join(src, 'authors.json'), 'utf8'));
const channels = JSON.parse(await readFile(path.join(src, 'channels.json'), 'utf8'));

// Discord の snowflake → 書き出しの番号。本文中の `<@123>` を会話内の役に直すのに使う
const authorIdxById = new Map(authors.map((a) => [a.id, a.idx]));

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
 * メンションは**会話の中に居る人だけ**役に直す。外の人は落とす —
 * 20 桁の ID を残しても学ぶものが無いし、名前に直すと身元が戻ってくる。
 * 居る人を `@B` にできると「誰に答えているか」が本文に残るので、
 * evex-1 が捨てていた返信先の信号がここで手に入る。
 */
function plainText(content, roleOf) {
  let out = content;

  out = out.replace(/<@!?(\d+)>/g, (match, id) => {
    const role = roleOf(authorIdxById.get(id));
    return role ? `@${role}` : '';
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

for (const line of raw.split('\n')) {
  if (!line) continue;
  read += 1;

  const [ch, author, createdAt, isBot, isReply, content] = JSON.parse(line);
  if (isBot) { bots += 1; continue; }
  if (!content || !content.trim()) { empty += 1; continue; }

  if (!byChannel.has(ch)) byChannel.set(ch, []);
  byChannel.get(ch).push({
    author,
    created_at: createdAt,
    reply: isReply,
    content,
    // splitIntoChunks が 1200 字で切るのに使う。正規化で少し縮むが、
    // 縮む方向なので上限を割ることはない
    char_count: content.length
  });
}

const channelIdByIdx = new Map(channels.map((c) => [c.idx, c.id]));
const conversations = [];

for (const [chIdx, rows] of byChannel) {
  const label = labelOf(channelIdByIdx.get(chIdx));

  for (const chunk of splitIntoChunks(rows)) {
    // この会話に出てくる人だけに A,B,C... を振る。別の会話では別人になる
    const roles = assignRoles(chunk.map((row) => row.author), SCHEME);
    const roleOf = (idx) => (idx === undefined ? null : roles.get(idx));

    const lines = [];
    for (const row of chunk) {
      const text = plainText(row.content, roleOf);
      if (!text) continue;                        // 正規化で空になった (メンションだけ等)
      lines.push(`${roles.get(row.author)}: ${text}`);
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
    named_channels: NAMED_CHANNELS
  }, null, 2)}\n`
);

const fmt = (n) => n.toLocaleString('en-US');
console.log(`読んだ           ${fmt(read)} (bot ${fmt(bots)} / 本文なし ${fmt(empty)} を除外)`);
console.log(`会話             ${fmt(conversations.length)}  train ${fmt(train.length)} / val ${fmt(val.length)}`);
console.log(`文字数           train ${fmt(chars(train))} / val ${fmt(chars(val))}`);
console.log(`1 会話あたり     ${Math.round(chars(train) / train.length)} 字`);
console.log(`\n--- 先頭の会話 ---\n${train[0]?.text.slice(0, 400)}`);
