// 経過表示 (`-# thinking ...`) の後片付け。
//
// stop() で消す前提の作りなので、実行中にプロセスが落ちるとチャンネルに残り続ける。
// format.js 側は残骸を前提に prefix で弾いているが、人の目には出たままになる。
//
// 出したものを DB に控えておいて、次の起動でまとめて消す。happy path では
// stop() が即座に行を落とすので、この表はほぼ常に空。
// agent_replies (ratelimit.js) と同じ考え方。

import { db } from '../db.js';
import { isAllowedGuild } from '../guilds.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_indicators (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const insertStmt = db.prepare(
  'INSERT OR REPLACE INTO agent_indicators (message_id, channel_id, created_at) VALUES (?, ?, ?)'
);
const deleteStmt = db.prepare('DELETE FROM agent_indicators WHERE message_id = ?');
const listStmt = db.prepare('SELECT message_id, channel_id FROM agent_indicators');

export function rememberIndicator(messageId, channelId) {
  if (!messageId || !channelId) return;

  try {
    insertStmt.run(String(messageId), String(channelId), Date.now());
  } catch (error) {
    // 控えられなくても経過表示自体は出ている。掃除が効かなくなるだけ。
    console.error('Failed to remember a thinking indicator:', error);
  }
}

export function forgetIndicator(messageId) {
  if (!messageId) return;

  try {
    deleteStmt.run(String(messageId));
  } catch (error) {
    console.error('Failed to forget a thinking indicator:', error);
  }
}

/** 前回の実行が消し損ねた経過表示を消す。起動時に1回だけ呼ぶ。 */
export async function sweepStaleIndicators(client) {
  let rows;
  try {
    rows = listStmt.all();
  } catch (error) {
    console.error('Failed to list leftover thinking indicators:', error);
    return;
  }

  if (rows.length === 0) return;

  for (const row of rows) {
    // 消せても消せなくても行は落とす。残すと起動のたびに fetch を撃ち続ける。
    forgetIndicator(row.message_id);

    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    if (!isAllowedGuild(channel.guildId)) continue;

    await channel.messages.delete(row.message_id).catch(() => {});
  }

  console.log(`Cleaned up ${rows.length} leftover thinking indicator(s).`);
}
