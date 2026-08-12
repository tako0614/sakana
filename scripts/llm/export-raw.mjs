// archive.sqlite から学習用の生データを書き出す (サーバ側で1回だけ動かす)。
//
// 目的は「1回だけ運んで、あとはローカルで何度でも作り直せるようにする」こと。
// 正規化や会話の切り方はこれから何度も変えるので、そのたびに稼働中のサーバへ
// 取りに行くのは筋が悪い。ここでは加工せず、必要な列だけを詰めて出す。
//
//   node scripts/llm/export-raw.mjs [出力ディレクトリ]
//
// 出力:
//   raw.jsonl.gz   1行1メッセージ。[ch, author, created_at, is_bot, is_reply, content]
//                  キー名を省いて配列にしてある (94万行あるとキー名だけで数十MB になる)
//   authors.json   author の番号 → id / 表示名 / 件数 / 文字数 / bot 判定
//   channels.json  channel の番号 → id / 件数
//
// archive.sqlite は読み取り専用で開く。bot が WAL で書き込み中なので触らない。

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import Database from 'better-sqlite3';

const dbPath = process.env.ARCHIVE_DB_PATH ?? 'archive.sqlite';
const outDir = process.argv[2] ?? 'corpus';

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// 会話として並べ直すので、チャンネルごとに時系列で読む。
// deleted は残す (消された発言も当時の会話の一部) が、印は付けない。
const rows = db.prepare(`
  SELECT channel_id, author_id, author_name, is_bot, content, created_at, reply_to
  FROM messages
  ORDER BY channel_id, created_at, message_id
`);

const channels = new Map();
const authors = new Map();

function indexOf(map, key, seed) {
  const found = map.get(key);
  if (found) return found.idx;

  const entry = { idx: map.size, ...seed, count: 0, chars: 0 };
  map.set(key, entry);
  return entry.idx;
}

let total = 0;
let emitted = 0;

// 1行ずつ流す。94万行を配列に溜めると数百MB になるので iterate で回す。
async function* lines() {
  for (const row of rows.iterate()) {
    total += 1;

    const ch = indexOf(channels, row.channel_id, { id: row.channel_id });
    const author = indexOf(authors, row.author_id, {
      id: row.author_id,
      name: row.author_name,
      bot: row.is_bot
    });

    const chEntry = channels.get(row.channel_id);
    const authorEntry = authors.get(row.author_id);
    const content = row.content ?? '';

    chEntry.count += 1;
    authorEntry.count += 1;
    authorEntry.chars += content.length;

    // 表示名は変わるので、最後に見たものを残す (検索や話者一覧の見た目用)
    if (row.author_name) authorEntry.name = row.author_name;
    // bot 判定が途中で変わっている行があるかもしれないので、一度でも立ったら記録
    if (row.is_bot) authorEntry.bot = 1;

    emitted += 1;
    yield `${JSON.stringify([
      ch,
      author,
      row.created_at,
      row.is_bot ? 1 : 0,
      row.reply_to ? 1 : 0,
      content
    ])}\n`;
  }
}

await mkdir(outDir, { recursive: true });

await pipeline(
  Readable.from(lines()),
  createGzip({ level: 9 }),
  createWriteStream(path.join(outDir, 'raw.jsonl.gz'))
);

const byIdx = (map) => [...map.values()].sort((a, b) => a.idx - b.idx);

await writeFile(
  path.join(outDir, 'authors.json'),
  JSON.stringify(byIdx(authors), null, 0)
);
await writeFile(
  path.join(outDir, 'channels.json'),
  JSON.stringify(byIdx(channels), null, 0)
);

console.log(`rows ${total} / emitted ${emitted}`);
console.log(`authors ${authors.size} / channels ${channels.size}`);
console.log(`-> ${path.join(outDir, 'raw.jsonl.gz')}`);
