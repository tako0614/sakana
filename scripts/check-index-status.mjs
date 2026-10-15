// /index status の検証 (npm run check から呼ぶ)。
//
// 固定したいのは次の3つ。
//   - 返事が必ず届く: 重い SQL の前に deferReply し、最後は editReply で返す
//   - 件数の定義を変えない: 覆い索引にした chunkCoverage は旧クエリと同じ値を返す
//   - 全行を読まない: 計画が覆い索引だけで答えを出す (テーブルの行・BLOB を読む形に戻さない)
//
// ARCHIVE_DB_PATH を一時ファイルに向けて呼ぶこと。

import { PermissionFlagsBits } from 'discord.js';
import { db } from '../src/archive/db.js';
import { COVERAGE_SQL, chunkCoverage, hasChunkVectors } from '../src/archive/chunks.js';
import { archiveCommands } from '../src/archive/commands.js';

const fail = (message) => { throw new Error(message); };
const GUILD = 'check-status-guild';
const OTHER = 'check-status-other';
const MODEL = 7;
const OTHER_MODEL = 8;

db.exec("DELETE FROM message_chunks WHERE guild_id IN ('check-status-guild','check-status-other')");
db.prepare('DELETE FROM channels WHERE guild_id IN (?, ?)').run(GUILD, OTHER);
db.prepare('DELETE FROM guild_index_state WHERE guild_id IN (?, ?)').run(GUILD, OTHER);

const insertChunk = db.prepare(`
  INSERT INTO message_chunks (guild_id, channel_id, from_ms, to_ms, from_id, to_id, msg_count, text_len, built_at)
  VALUES (?, 'c', 0, 1, '1', '2', ?, ?, 0)
`);
const insertVector = db.prepare(
  'INSERT INTO chunk_vectors (chunk_id, model_id, scale, vec, created_at) VALUES (?, ?, 1, zeroblob(1536), 0)'
);

db.transaction(() => {
  // 本体: 発言2〜4件、うち 7 件に 1 件は text_len=0 (数えない)、半分が MODEL で埋まる
  for (let i = 0; i < 400; i += 1) {
    const empty = i % 7 === 0;
    const { lastInsertRowid } = insertChunk.run(GUILD, 2 + (i % 3), empty ? 0 : 50 + i);
    // chunk_id が主キーなので 1 まとまりに 1 ベクトル。別モデルで埋めたものも混ぜる
    if (i % 2 === 0) insertVector.run(lastInsertRowid, MODEL);
    else if (i % 5 === 0) insertVector.run(lastInsertRowid, OTHER_MODEL);
  }
  // 別サーバーの分は混ざってはいけない
  for (let i = 0; i < 50; i += 1) {
    const { lastInsertRowid } = insertChunk.run(OTHER, 9, 100);
    insertVector.run(lastInsertRowid, MODEL);
  }
})();

// 1. 旧クエリ (結合 + 行読み) と同じ値
const legacy = (guildId, modelId) => {
  const total = db.prepare('SELECT COUNT(*) AS count FROM message_chunks WHERE guild_id = ? AND text_len > 0').get(guildId).count;
  const done = db.prepare(`
    SELECT COUNT(*) AS count FROM message_chunks c
    JOIN chunk_vectors v ON v.chunk_id = c.chunk_id
    WHERE c.guild_id = ? AND v.model_id = ? AND c.text_len > 0
  `).get(guildId, modelId).count;
  const messages = db.prepare('SELECT COALESCE(SUM(msg_count), 0) AS count FROM message_chunks WHERE guild_id = ? AND text_len > 0').get(guildId).count;
  return { total, done, messages };
};

for (const [guildId, modelId] of [[GUILD, MODEL], [GUILD, OTHER_MODEL], [OTHER, MODEL], [GUILD, 999]]) {
  const want = legacy(guildId, modelId);
  const got = chunkCoverage(guildId, modelId);
  for (const key of ['total', 'done', 'messages']) {
    if (got[key] !== want[key]) fail(`chunkCoverage.${key} differs for ${guildId}/${modelId}: ${got[key]} != ${want[key]}`);
  }
}
if (chunkCoverage(GUILD, MODEL).done === 0) fail('fixture must have embedded chunks');
if (chunkCoverage('nobody', MODEL).ratio !== 0) fail('an empty guild must have ratio 0');

if (!hasChunkVectors(GUILD, MODEL)) fail('hasChunkVectors must find existing vectors');
if (hasChunkVectors(GUILD, 999)) fail('hasChunkVectors must be false for a model with no vectors');
if (hasChunkVectors('nobody', MODEL)) fail('hasChunkVectors must be per guild');

// 2. 計画が覆い索引だけ。SCAN や、行を引く SEARCH に戻っていないこと
const plan = (sql, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => row.detail).join(' | ');
const totalPlan = plan(COVERAGE_SQL.total, GUILD);
if (!/COVERING INDEX idx_chunk_cover/.test(totalPlan)) fail('total must be a covering-index count: ' + totalPlan);

for (const key of ['done', 'any']) {
  const donePlan = plan(COVERAGE_SQL[key], GUILD, MODEL);
  if (!/COVERING INDEX idx_chunk_cover/.test(donePlan)) fail(`${key} must scan the covering chunk index: ` + donePlan);
  if (!/COVERING INDEX idx_chunkvec_model/.test(donePlan)) fail(`${key} must probe the covering vector index: ` + donePlan);
  if (/SCAN/.test(donePlan)) fail(`${key} must not scan a table: ` + donePlan);
}

// 3. 返事が届く順序: 重い処理の前に defer、最後は editReply
const indexCommand = archiveCommands.find((command) => command.data?.name === 'index');
if (!indexCommand) fail('/index command must be registered');

const run = async (guildId) => {
  const calls = [];
  const interaction = {
    guildId,
    guild: { channels: { cache: { has: () => true } } },
    user: { id: 'u1' },
    member: { id: 'u1', permissions: { has: (flag) => flag === PermissionFlagsBits.ManageGuild } },
    options: { getSubcommand: () => 'status' },
    reply: async (payload) => { calls.push(['reply', payload]); },
    deferReply: async () => { calls.push(['deferReply']); },
    editReply: async (payload) => { calls.push(['editReply', payload]); }
  };
  await indexCommand.execute(interaction);
  return calls;
};

// 未取り込みのサーバー: 重い処理は無く、その場で ephemeral の返事
const empty = await run('check-status-empty');
if (empty.length !== 1 || empty[0][0] !== 'reply') fail('an unindexed guild must get a single immediate reply');

// 取り込み済み: defer → editReply。件数は channels の合計
db.prepare("INSERT INTO guild_index_state (guild_id, status) VALUES (?, 'idle')").run(GUILD);
const insertChannel = db.prepare(`
  INSERT INTO channels (channel_id, guild_id, name, message_count, complete) VALUES (?, ?, ?, ?, 1)
`);
insertChannel.run('check-status-ch1', GUILD, 'one', 1200);
insertChannel.run('check-status-ch2', GUILD, 'two', 34);

const calls = await run(GUILD);
const names = calls.map(([name]) => name);
if (names.join(',') !== 'deferReply,editReply') fail('status must defer then edit, got: ' + names.join(','));

const embed = calls[1][1].embeds?.[0]?.toJSON?.() ?? calls[1][1].embeds?.[0];
const field = embed?.fields?.find((entry) => entry.name.startsWith('メッセージ数'));
if (!field) fail('message count field missing');
if (!/1,234|1234/.test(field.value)) fail('count must be the sum of channel counts: ' + field.value);
if (!/概数/.test(field.name)) fail('the count must be labelled approximate');

db.prepare('DELETE FROM channels WHERE guild_id = ?').run(GUILD);
db.prepare('DELETE FROM guild_index_state WHERE guild_id = ?').run(GUILD);
db.exec("DELETE FROM message_chunks WHERE guild_id IN ('check-status-guild','check-status-other')");

console.log('index status ok');
