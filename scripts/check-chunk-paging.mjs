// ページ境界の持ち越しを検証する (npm run check から呼ぶ)。
//
// 1チャンネルを丸ごとメモリに載せないためにページングしているので、ページの
// 境目でまとまりが切れないよう最後の組を次のページへ持ち越している。ここは
// 取りこぼしと重複がいちばん出やすいので、「小さいページで作った結果」が
// 「一度に作った結果」と完全に一致することを固定する。

import { db, msToSnowflake } from '../src/archive/db.js';
import { buildGuildChunks, clearGuildChunks } from '../src/archive/chunks.js';
import { embedConfig } from '../src/embed/config.js';

const GUILD = 'check-paging';
const CHANNEL = 'check-channel';
const T0 = Date.parse('2024-01-01T00:00:00Z');
const COUNT = 60;

const insert = db.prepare(`
  INSERT OR REPLACE INTO messages
    (message_id, guild_id, channel_id, author_id, author_name, is_bot, content, extra,
     created_at, char_count, deleted)
  VALUES (@message_id, @guild_id, @channel_id, @author_id, @author_name, 0, @content, '',
     @created_at, @char_count, 0)
`);

function seed() {
  db.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
  clearGuildChunks(GUILD);

  let at = T0;
  for (let i = 0; i < COUNT; i += 1) {
    // 7件ごとに無言を挟んで会話を切る。同一ミリ秒も混ぜて行値カーソルを試す。
    if (i > 0 && i % 7 === 0) at += 20 * 60_000;
    else if (i % 5 !== 0) at += 30_000;

    const content = `発言${i} これは会話の一部で十分な長さがある本文です`;
    insert.run({
      message_id: `${msToSnowflake(at)}${String(i).padStart(3, '0')}`,
      guild_id: GUILD,
      channel_id: CHANNEL,
      author_id: `u${i % 3}`,
      author_name: ['たこ', 'さば', 'りん'][i % 3],
      content,
      created_at: at,
      char_count: Array.from(content).length
    });
  }
}

const snapshot = () => db
  .prepare('SELECT from_ms, to_ms, msg_count, text_len FROM message_chunks WHERE guild_id = ? ORDER BY from_ms')
  .all(GUILD);

async function build(page) {
  clearGuildChunks(GUILD);
  embedConfig.chunkPage = page;
  await buildGuildChunks(GUILD);
  return snapshot();
}

seed();

const once = await build(10_000);
const covered = once.reduce((sum, row) => sum + row.msg_count, 0);

if (covered !== COUNT) {
  throw new Error(`every message must land in a chunk: ${covered} / ${COUNT}`);
}

for (const page of [1, 3, 7, 13]) {
  const paged = await build(page);
  if (JSON.stringify(paged) !== JSON.stringify(once)) {
    throw new Error(
      `paging changed the chunks at page=${page}: `
      + `${JSON.stringify(paged.map((c) => c.msg_count))} vs ${JSON.stringify(once.map((c) => c.msg_count))}`
    );
  }
}

db.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
clearGuildChunks(GUILD);

console.log(`chunk paging ok (${COUNT} messages -> ${once.length} chunks, identical at page 1/3/7/13)`);
