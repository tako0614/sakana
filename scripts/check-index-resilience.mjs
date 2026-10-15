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

// ---- 途中で止まったチャンネルを起動時に取り直す ------------------------------
// #nsfw は /index build の途中でロックに当たり、最新の一部だけ取ったまま放置された。

process.env.ARCHIVE_FETCH_DELAY_MS = '0';
const { catchupAllGuilds, runIndexJob } = await import('../src/archive/indexer.js');
const { setGuildState, upsertChannel, updateChannelState, getGuildState } = await import('../src/archive/db.js');
const GUILD = 'check-resume-guild';
const STUCK = '1255767179022962749';
const history = Array.from({ length: 250 }, (_, i) => ({
  id: (1300000000000000000n + BigInt(i) * 1000n).toString(), guildId: GUILD, channelId: STUCK,
  content: `old ${i}`, author: { id: 'u', username: 'u' }, createdTimestamp: 1_700_000_000_000 + i * 1000, attachments: new Map()
}));
const page = (list) => new Map(list.map((message) => [message.id, message]));
let busyOnce = 0;
const stuck = {
  id: STUCK, name: 'nsfw', guildId: GUILD, type: 0, isThread: () => false, isTextBased: () => true,
  permissionsFor: () => ({ has: () => true }), appliedTags: [], topic: '',
  messages: {
    fetch: async ({ after, before, limit = 100 }) => {
      if (busyOnce-- === 1) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      if (after) return page(history.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit));
      const older = history.filter((m) => !before || BigInt(m.id) < BigInt(before));
      return page(older.slice(-limit).reverse());
    }
  }
};
const guild = { id: GUILD, name: 'resume', channels: { cache: new Map([[STUCK, stuck]]), fetch: async () => null }, members: { me: { id: 'bot' } } };
stuck.guild = guild;

db.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
setGuildState(GUILD, { status: 'idle', mode: 'full' });
upsertChannel({ channel_id: STUCK, guild_id: GUILD, parent_id: null, name: 'nsfw', type: 0, is_thread: 0, is_private: 0 });
// 最新の50件だけ取って、ロックで落ちた状態
const recent = history.slice(-50);
savePage(STUCK, recent.map((m) => ({ message_id: m.id, guild_id: GUILD, channel_id: STUCK, parent_id: null, author_id: 'u', author_name: 'u',
  is_bot: 0, content: m.content, extra: '', created_at: m.createdTimestamp, edited_at: null, reply_to: null, attachment_count: 0,
  attachment_kinds: '', embed_count: 0, sticker_count: 0, link_count: 0, reaction_count: 0, char_count: 5, pinned: 0 })),
  [recent[0].id, recent.at(-1).id], { oldest_id: recent[0].id, newest_id: recent.at(-1).id });
updateChannelState(STUCK, { last_error: 'database is locked', complete: 0 });

stuck.threads = { fetchActive: async () => ({ threads: new Map() }), fetchArchived: async () => ({ threads: new Map(), hasMore: false }) };
await catchupAllGuilds({ guilds: { cache: new Map([[GUILD, guild]]) } });
const resumed = getChannelState(STUCK);
const have = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE channel_id = ?').get(STUCK).c;
if (have !== 250) fail(`an unfinished channel must be backfilled on startup (have ${have}/250)`);
if (resumed.complete !== 1 || resumed.last_error) fail('a resumed channel must end complete without an error: ' + JSON.stringify(resumed));

// 再起動で打ち切られた /index build は、起動後にやり直して終わらせる
db.prepare('DELETE FROM messages WHERE channel_id = ?').run(STUCK);
db.prepare('DELETE FROM channel_spans WHERE channel_id = ?').run(STUCK);
updateChannelState(STUCK, { complete: 0, oldest_id: null, newest_id: null, last_error: null });
setGuildState(GUILD, { status: 'running', mode: 'full' });   // 前のプロセスのジョブの名残
await catchupAllGuilds({ guilds: { cache: new Map([[GUILD, guild]]) } });
const rerunHave = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE channel_id = ?').get(STUCK).c;
if (rerunHave !== 250) fail(`an interrupted /index build must be rerun on startup (have ${rerunHave}/250)`);
if (getGuildState(GUILD).status !== 'idle') fail('the rerun build must finish and leave the guild idle: ' + getGuildState(GUILD).status);

// やり直しの途中でまた再起動された (印はもう「中断」) ときも、やり直す
db.prepare('DELETE FROM messages WHERE channel_id = ?').run(STUCK);
db.prepare('DELETE FROM channel_spans WHERE channel_id = ?').run(STUCK);
updateChannelState(STUCK, { complete: 0, oldest_id: null, newest_id: null, last_error: null });
setGuildState(GUILD, { status: 'interrupted', mode: 'full' });
await catchupAllGuilds({ guilds: { cache: new Map([[GUILD, guild]]) } });
if (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE channel_id = ?').get(STUCK).c !== 250) fail('an interrupted rerun must run again after another restart');
if (getGuildState(GUILD).status !== 'idle') fail('the second rerun must finish');

// ジョブ中にロックで落ちても、待って続きから取り直す (ジョブのエラーにしない)
db.prepare('DELETE FROM messages WHERE channel_id = ?').run(STUCK);
db.prepare('DELETE FROM channel_spans WHERE channel_id = ?').run(STUCK);
updateChannelState(STUCK, { complete: 0, oldest_id: null, newest_id: null, last_error: null });
stuck.threads = { fetchActive: async () => ({ threads: new Map() }), fetchArchived: async () => ({ threads: new Map(), hasMore: false }) };
busyOnce = 1;
const job = await runIndexJob(guild, { mode: 'full' });
const after = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE channel_id = ?').get(STUCK).c;
if (job.errors.length || after !== 250) fail(`a locked page must be retried inside the job (errors ${JSON.stringify(job.errors)}, have ${after})`);
db.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
db.prepare('DELETE FROM channels WHERE guild_id = ?').run(GUILD);
db.prepare('DELETE FROM guild_index_state WHERE guild_id = ?').run(GUILD);

db.prepare('DELETE FROM messages WHERE channel_id = ?').run(CHANNEL);
db.prepare('DELETE FROM channel_spans WHERE channel_id = ?').run(CHANNEL);
db.prepare('DELETE FROM channels WHERE channel_id = ?').run(CHANNEL);
console.log(`index resilience ok (ロック中も ${waited}ms 待って書けた / 台帳が待ち時間を下げない / やり直し / 1ページ1トランザクション / 止まったチャンネルを起動時に取り直す / 中断された build をやり直す / ジョブ中のロックを続きから / 投票の当て布)`);
