// 取り込みが DB のロックや discord.js の不具合で死なないことの検証 (npm run check から呼ぶ)。
//
//   - 別の接続が書き込みロックを握っていても、取り込みの書き込みは待って通る (30秒まで)
//   - 費用の台帳 (cost.js) が同じ接続のロック待ちを短くしない
//   - 30秒待っても書けないときは間を空けてやり直す。待っても通らない失敗はやり直さない
//   - 1ページ (発言・区間・位置) は1トランザクションで書かれる
//   - channel がキャッシュに無い投票メッセージで discord.js が落ちない (postinstall の当て布)
//
// ARCHIVE_DB_PATH を一時ファイルに向けて呼ぶこと。

import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { Client, Poll } from 'discord.js';
import { BUSY_TIMEOUT_MS, db, getChannelState, isBusy, listSpans, retryBusy, savePage } from '../src/archive/db.js';
import { ensureModelBudget } from '../src/ai/cost.js';
import { patchPollSource, pollFile } from './patch-discord-poll.mjs';

const fail = (message) => { throw new Error(message); };

// ---- ロック待ちの長さ -------------------------------------------------------

ensureModelBudget({ id: 'check-locks', guildId: 'g', limitUsd: 1 });   // 台帳の初期化を走らせる
const timeout = db.pragma('busy_timeout', { simple: true });
if (timeout < BUSY_TIMEOUT_MS) fail(`archive busy_timeout was lowered to ${timeout}ms (cost.js must not shorten it)`);

// ---- 別の接続がロックを握っている間も書ける ----------------------------------

const CHANNEL = 'check-locks-channel';
db.prepare('DELETE FROM messages WHERE channel_id = ?').run(CHANNEL);
db.prepare('DELETE FROM channel_spans WHERE channel_id = ?').run(CHANNEL);
db.prepare('DELETE FROM channels WHERE channel_id = ?').run(CHANNEL);
db.prepare("INSERT INTO channels (channel_id, guild_id, name) VALUES (?, 'g', 'locks')").run(CHANNEL);

const holder = new Worker(`
  const { parentPort, workerData } = require('node:worker_threads');
  const Database = require(workerData.module);
  const other = new Database(workerData.path);
  other.exec('BEGIN IMMEDIATE');
  other.prepare("UPDATE channels SET name = 'held' WHERE channel_id = ?").run(workerData.channel);
  parentPort.postMessage('locked');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  other.exec('COMMIT');
  other.close();
  parentPort.postMessage('released');
`, { eval: true, workerData: { path: db.name, channel: CHANNEL, module: (await import('node:module')).createRequire(import.meta.url).resolve('better-sqlite3') } });
await new Promise((resolve) => holder.once('message', resolve));   // 'locked'

const record = (id, at) => ({
  message_id: id, guild_id: 'g', channel_id: CHANNEL, parent_id: null, author_id: 'a', author_name: 'a', is_bot: 0,
  content: `msg ${id}`, extra: '', created_at: at, edited_at: null, reply_to: null, attachment_count: 0,
  attachment_kinds: '', embed_count: 0, sticker_count: 0, link_count: 0, reaction_count: 0, char_count: 5, pinned: 0
});
const started = Date.now();
const ids = ['1400000000000000001', '1400000000000000002'];
savePage(CHANNEL, ids.map((id, i) => record(id, 1_700_000_000_000 + i)), [ids[0], ids[1]], { newest_id: ids[1] });
const waited = Date.now() - started;
await new Promise((resolve) => holder.once('message', resolve));   // 'released'
await holder.terminate();
if (waited < 800) fail(`the write should have waited for the other connection (${waited}ms)`);

// 1ページぶんがまとめて書かれている
const saved = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE channel_id = ?').get(CHANNEL).c;
if (saved !== 2) fail('page messages must be saved: ' + saved);
if (getChannelState(CHANNEL)?.newest_id !== ids[1]) fail('page state must be saved with the messages');
if (listSpans(CHANNEL).length !== 1) fail('page span must be saved with the messages');

// ---- やり直し ---------------------------------------------------------------

let calls = 0;
const flaky = await retryBusy(() => {
  calls += 1;
  if (calls < 3) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  return 'ok';
}, { delayMs: 1, label: 'check' });
if (flaky !== 'ok' || calls !== 3) fail('busy failures must be retried until they pass');

calls = 0;
try {
  await retryBusy(() => { calls += 1; throw new Error('Missing Access'); }, { delayMs: 1 });
  fail('non-busy errors must be thrown');
} catch (error) {
  if (calls !== 1 || error.message !== 'Missing Access') fail('non-busy errors must not be retried');
}

calls = 0;
try {
  await retryBusy(() => { calls += 1; throw Object.assign(new Error('x'), { code: 'SQLITE_BUSY_SNAPSHOT' }); }, { attempts: 3, delayMs: 1 });
  fail('retries must give up eventually');
} catch (error) {
  if (calls !== 3 || !isBusy(error)) fail('retryBusy must stop after the attempt limit');
}
if (!isBusy(new Error('database table is locked')) || isBusy(new Error('locked out'))) fail('isBusy must match SQLite lock errors only');

// ---- discord.js の投票 --------------------------------------------------------

const source = readFileSync(pollFile(), 'utf8');
if (patchPollSource(source).state !== 'already') fail('discord.js Poll must be patched (npm install runs scripts/patch-discord-poll.mjs)');
const client = new Client({ intents: [] });
const poll = new Poll(client, { question: { text: 'q' }, answers: [], expiry: null, allow_multiselect: false, layout_type: 1 },
  { id: '2', channelId: '1' }, null);
if (poll.channelId !== '1') fail('a poll without a cached channel must fall back to the message channel id');
const broken = 'this.channelId = data.channel_id ?? channel.id;';
if (patchPollSource(broken).state !== 'patched' || patchPollSource('something else').state !== 'unknown') fail('patcher must be idempotent and conservative');
await client.destroy();

db.prepare('DELETE FROM messages WHERE channel_id = ?').run(CHANNEL);
db.prepare('DELETE FROM channel_spans WHERE channel_id = ?').run(CHANNEL);
db.prepare('DELETE FROM channels WHERE channel_id = ?').run(CHANNEL);
console.log(`index resilience ok (ロック中も ${waited}ms 待って書けた / 台帳が待ち時間を下げない / やり直し / 1ページ1トランザクション / 投票の当て布)`);
