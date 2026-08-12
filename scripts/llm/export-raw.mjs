// archive.sqlite から学習用の生データを書き出す (サーバ側で1回だけ動かす)。
//
// 目的は「1回だけ運んで、あとはローカルで何度でも作り直せるようにする」こと。
// 正規化や会話の切り方はこれから何度も変えるので、そのたびに稼働中のサーバへ
// 取りに行くのは筋が悪い。ここでは加工せず、必要な列だけを詰めて出す。
//
//   node scripts/llm/export-raw.mjs [出力ディレクトリ]
//
// 出力:
//   raw.jsonl.gz   1行1メッセージ。
//                  [ch, author, created_at, is_bot, is_reply, content, extra, reply_author]
//                  キー名を省いて配列にしてある (94万行あるとキー名だけで数十MB になる)
//   authors.json   author の番号 → id / 表示名 / 件数 / 文字数 / bot 判定
//   channels.json  channel の番号 → id / 件数
//
// archive.sqlite は読み取り専用で開く。bot が WAL で書き込み中なので触らない。
//
// **出力先を既存の corpus/ にしないこと。** あそこには evex-1 の tok.model と対の
// speakers.json (話者トークン → userId) が入っている。authors.json を作り直すと
// 番号の振り直しで対応がずれて、載っているモデルが孤児になる (一度やった)。
// 新しい世代は別のディレクトリに出す。
//
// --- 列を2つ足した理由 ---
//
// extra: 本文が空の発言が 21,349 件 (人間の 3.6%) あり、そのうち 83% には
// 添付名・埋め込みタイトル・スタンプ名が入っている。これを渡していなかったので
// evex-1 は全部 `<file>` の1トークンにするしかなく、「発言の先頭で記号が来る」
// 確率が上がって返答の 38% が「(画像)」だけになった。推論側でトークンを禁止して
// 12% に抑えたが、あれは症状の抑え込み。evex-2 の epoch 3 のサンプルでも
// 記号の羅列がまだ大量に出ている。
//
// reply_author: reply_to は「返信かどうか」の真偽値にしか使っていなくて、
// **誰への返信かを捨てていた**。賑やかなチャンネルでは噛み合いの信号そのもの。
// message_id をそのまま出すと 19 桁 × 94万行になるので、ここで自己結合して
// 相手の author 番号に解決してから出す。

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
// 返信先は自己結合で相手の author に解決する。message_id をそのまま出すと
// 19 桁 × 94万行になるうえ、読む側で引き直す表が必要になる。
// p は主キー参照なので、94万行でも結合は効く。
const rows = db.prepare(`
  SELECT m.channel_id, m.author_id, m.author_name, m.is_bot, m.content, m.extra,
         m.created_at, m.reply_to,
         p.author_id AS reply_author_id, p.author_name AS reply_author_name,
         p.is_bot AS reply_is_bot
  FROM messages m
  LEFT JOIN messages p ON p.message_id = m.reply_to
  ORDER BY m.channel_id, m.created_at, m.message_id
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

    // 返信先の相手。番号を振るときに名前と bot 判定も渡す — 渡さないと、
    // 本人の行より先に返信先として現れた人の entry が名前なしで作られる
    const replyAuthor = row.reply_author_id
      ? indexOf(authors, row.reply_author_id, {
        id: row.reply_author_id,
        name: row.reply_author_name,
        bot: row.reply_is_bot
      })
      : null;

    emitted += 1;
    yield `${JSON.stringify([
      ch,
      author,
      row.created_at,
      row.is_bot ? 1 : 0,
      row.reply_to ? 1 : 0,
      content,
      row.extra ?? '',
      replyAuthor
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
