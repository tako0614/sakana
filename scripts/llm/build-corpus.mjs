// 生の書き出し (export-raw.mjs) から学習用のテキストを作る。ローカルで何度でも回す。
//
//   node scripts/llm/build-corpus.mjs [入出力ディレクトリ]
//
// 出力:
//   train.txt / val.txt   1行1会話。sentencepiece と学習の両方がこれを読む
//   speakers.json         話者トークンの割り当て
//
// 会話の切り方は意味検索と同じ `splitIntoChunks` を使う (無言 15 分 / 20 件 / 1200 字)。
// 定義を2箇所に持つと必ずずれるので、ここでは実装せず import する。
// ただしあのモジュールは読み込み時に archive.sqlite を開くので、
// 触られても困らないスクラッチのパスを向けてから import する。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';

process.env.ARCHIVE_DB_PATH = path.join(os.tmpdir(), 'sakana-corpus-scratch.sqlite');
const { splitIntoChunks } = await import('../../src/archive/chunks.js');
const { assignRoles, buildPrompt, messageText } = await import('../../src/mimic/serialize.js');

const dir = process.argv[2] ?? 'corpus';

// 話者は会話ごとに出現順で振る (src/mimic/serialize.js の assignRoles)。
// evex-1 は上位48人に固有トークンを与えていたが、それは実在の人物に紐づくので
// speakers.json / 順位 / Discord ID の対応表がぶら下がっていた。相対にすれば
// 身元は消え、会話の交代だけが残る。
// 実測: 1会話の異なる話者は 8 人までで 99.1%、37% は 1 人だけ。
// val は「最後の N 日ぶんの会話」。ランダム分割にしない —
// 「草」「www」のような完全一致が 23% あるので、時間で切らないと val が嘘になる。
const VAL_DAYS = Number(process.env.LLM_VAL_DAYS ?? 14);

// 正規化と直列化は src/mimic/serialize.js に置いてある。
// 学習データと推論のプロンプトが同じ形でないと、モデルは「一度も見ていない形」を
// 受け取ることになる (しかも例外は出ないので静かに崩れるだけ)。

// --- 会話を組む ---

const byChannel = new Map();
let read = 0;
let bots = 0;

// readline は使わない。U+2028 / U+2029 も行終端として扱うので、
// それを含む本文で JSON レコードが割れる (実データに 5 件あった)。
// 60MB 程度なので素直に全部読んで \n だけで切る。
const raw = gunzipSync(await readFile(path.join(dir, 'raw.jsonl.gz'))).toString('utf8');

for (const line of raw.split('\n')) {
  if (!line) continue;
  read += 1;

  const [ch, author, createdAt, isBot, isReply, content] = JSON.parse(line);
  if (isBot) { bots += 1; continue; }

  const text = messageText(content);

  if (!byChannel.has(ch)) byChannel.set(ch, []);
  byChannel.get(ch).push({
    author,
    created_at: createdAt,
    reply: isReply,
    content: text,
    char_count: text.length
  });
}

// --- 直列化 ---

const conversations = [];

for (const rows of byChannel.values()) {
  for (const chunk of splitIntoChunks(rows)) {
    // この会話に出てくる人だけに a,b,c... を振る。別の会話では別人になる
    const roles = assignRoles(chunk.map((row) => row.author));
    const turns = chunk.map((row) => ({
      token: roles.get(row.author), reply: row.reply, content: row.content
    }));
    conversations.push({
      at: chunk[chunk.length - 1].created_at,
      text: `${buildPrompt(turns)}<|end|>`
    });
  }
}

conversations.sort((a, b) => a.at - b.at);

const newest = conversations[conversations.length - 1]?.at ?? Date.now();
const cutoff = newest - VAL_DAYS * 86_400_000;

const train = conversations.filter((c) => c.at < cutoff);
const val = conversations.filter((c) => c.at >= cutoff);

await writeFile(path.join(dir, 'train.txt'), `${train.map((c) => c.text).join('\n')}\n`);
await writeFile(path.join(dir, 'val.txt'), `${val.map((c) => c.text).join('\n')}\n`);
// --- 統計 ---

const chars = (list) => list.reduce((sum, c) => sum + c.text.length, 0);

console.log(`読んだ行            ${read} (bot を除外 ${bots})`);
console.log(`会話                ${conversations.length}`);
console.log(`  train             ${train.length} 会話 / ${chars(train).toLocaleString()} 文字`);
console.log(`  val               ${val.length} 会話 / ${chars(val).toLocaleString()} 文字 (最後の ${VAL_DAYS} 日)`);
console.log(`1会話あたり         ${Math.round(chars(conversations) / conversations.length)} 文字`);
