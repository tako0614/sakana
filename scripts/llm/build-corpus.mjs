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
const { splitIntoChunks } = await import('../../src/embed/../archive/chunks.js');

const dir = process.argv[2] ?? 'corpus';

// 話者に固有トークンを与える人数。上位 12 人で 55%、この辺で頭打ちになる。
// 残りは <|other|> にまとめる (2,647 人ぶんの語彙を持つ意味がない)。
const SPEAKER_SLOTS = Number(process.env.LLM_SPEAKER_SLOTS ?? 48);
// val は「最後の N 日ぶんの会話」。ランダム分割にしない —
// 「草」「www」のような完全一致が 23% あるので、時間で切らないと val が嘘になる。
const VAL_DAYS = Number(process.env.LLM_VAL_DAYS ?? 14);

// --- 正規化 ---
//
// 消すもの: そのまま入れると語彙を食うだけで、文体に寄与しないもの。
// 残すもの: 絵文字・草・www・顔文字・伸ばし棒。文体そのもの。

const RULES = [
  // URL は真っ先に。中に記号が多くて後続の規則を巻き込む
  [/https?:\/\/\S+/g, '<url>'],
  [/<a?:([a-zA-Z0-9_]{2,32}):\d{15,25}>/g, ':$1:'], // カスタム絵文字は名前を残す (:kusa: は文化)
  [/<@[!&]?\d{15,25}>/g, '<mention>'],
  [/<#\d{15,25}>/g, '<channel>'],
  [/<t:\d+(?::[tTdDfFR])?>/g, '<time>'],
  [/@everyone|@here/g, '<mention>']
];

function normalize(text) {
  let out = String(text ?? '');

  // コードブロックは中身を残して囲みだけ差し替える。``` のままだと
  // 言語名や改行と混ざって語彙が散る
  out = out.replace(/```[a-zA-Z0-9+#-]*\n?([\s\S]*?)```/g, (_, body) => `<code>${body}</code>`);

  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);

  // 会話 1 件を 1 行に収める。改行は消さずにトークンにする
  // (sentencepiece は行単位で読むし、学習側のデータローダも行で切りたい)
  //
  // U+2028 / U+2029 も潰す。JSON.stringify はこの2つを素通しするのに
  // Node の readline は行終端として扱うので、残すと下流で行が割れる
  // (実データに 5 件あって、書き出しの JSON が途中で切れた)。
  return out.replace(/\r\n|[\n\r\u2028\u2029]/g, '<nl>').trim();
}

// --- 話者 ---

const authors = JSON.parse(await readFile(path.join(dir, 'authors.json'), 'utf8'));
const humans = authors.filter((a) => !a.bot).sort((a, b) => b.count - a.count);
const slots = new Map();

for (const [rank, author] of humans.slice(0, SPEAKER_SLOTS).entries()) {
  slots.set(author.idx, `<|s${rank}|>`);
}

const speakerToken = (idx) => slots.get(idx) ?? '<|other|>';

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

  const text = normalize(content) || '<file>'; // 本文が空なのは添付かスタンプ。turn は残す

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
    const parts = ['<|conv|>'];

    for (const row of chunk) {
      parts.push(speakerToken(row.author));
      if (row.reply) parts.push('<|re|>');
      parts.push(row.content);
    }

    parts.push('<|end|>');
    conversations.push({ at: chunk[chunk.length - 1].created_at, text: parts.join('') });
  }
}

conversations.sort((a, b) => a.at - b.at);

const newest = conversations[conversations.length - 1]?.at ?? Date.now();
const cutoff = newest - VAL_DAYS * 86_400_000;

const train = conversations.filter((c) => c.at < cutoff);
const val = conversations.filter((c) => c.at >= cutoff);

await writeFile(path.join(dir, 'train.txt'), `${train.map((c) => c.text).join('\n')}\n`);
await writeFile(path.join(dir, 'val.txt'), `${val.map((c) => c.text).join('\n')}\n`);
await writeFile(
  path.join(dir, 'speakers.json'),
  JSON.stringify(
    humans.slice(0, SPEAKER_SLOTS).map((a, rank) => ({
      token: `<|s${rank}|>`, idx: a.idx, name: a.name, count: a.count
    })),
    null,
    2
  )
);

// --- 統計 ---

const chars = (list) => list.reduce((sum, c) => sum + c.text.length, 0);
const covered = humans.slice(0, SPEAKER_SLOTS).reduce((sum, a) => sum + a.count, 0);
const allHuman = humans.reduce((sum, a) => sum + a.count, 0);
const pct = (a, b) => `${((a / b) * 100).toFixed(1)}%`;

console.log(`読んだ行            ${read} (bot を除外 ${bots})`);
console.log(`会話                ${conversations.length}`);
console.log(`  train             ${train.length} 会話 / ${chars(train).toLocaleString()} 文字`);
console.log(`  val               ${val.length} 会話 / ${chars(val).toLocaleString()} 文字 (最後の ${VAL_DAYS} 日)`);
console.log(`話者トークン        ${slots.size} 人で人間の発言の ${pct(covered, allHuman)} を被覆`);
console.log(`1会話あたり         ${Math.round(chars(conversations) / conversations.length)} 文字`);
