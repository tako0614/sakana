// /memory コマンドの検証 (npm run check から呼ぶ)。
//   - status は管理者だけ。先に受け付けてから組み立て、読んだ割合・見込み・費用を出す
//   - pause で builder が区切りの境目で止まり、resume で外れる
//   - show / search / episode は誰でも開け、根拠の発言へのリンクが付く
//
// ARCHIVE_DB_PATH / MEMORY_DB_PATH を一時ファイルに向けて呼ぶこと。

import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

process.env.MEMORY_TREE_SYSTEMD_UNIT = '';
const { db: archive } = await import('../src/archive/db.js');
const { ensureModelBudget, reserveModelCall, finishModelCall } = await import('../src/ai/cost.js');
const store = await import('../src/memory/store.js');
const { runBuild, setPaused } = await import('../src/memory/build.js');
const { memoryCommand } = await import('../src/memory/command.js');

const GUILD = '910000000000000001';
const CHANNEL = '910000000000000010';
store.resetTree(GUILD);
store.savePublicChannels(GUILD, [CHANNEL]);
store.ensureSeeds(GUILD);
archive.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
archive.prepare("INSERT OR REPLACE INTO messages (message_id, guild_id, channel_id, author_id, author_name, content, created_at, char_count) VALUES ('1400000000000000001', ?, ?, 'u', 'たこ', '統治機能を作った', ?, 8)")
  .run(GUILD, CHANNEL, Date.now() - 3_600_000);
store.recordSegment(GUILD, { channelId: CHANNEL, fromId: '1', toId: '2', fromMs: 0, toMs: 1, messages: 400, chars: 9000 }, { status: 'done', now: Date.now() - 600_000 });
store.setState(`totals:${GUILD}`, { messages: 1000, channels: 1, at: Date.now() });
store.ensureNode(GUILD, 'people/たこ', { summary: 'sakana の作者' });
store.addPending(GUILD, 'people/たこ', ['sakana bot を作っている [e1]']);   // 知識が足されたページだけが記憶として出る
store.writePage(GUILD, 'people/たこ', { body: 'sakana bot を作っている [e1]' });
const episode = store.insertEpisode(GUILD, { title: '統治機能を作った', summary: 'たこが統治機能を作った。', channelId: CHANNEL,
  atMs: Date.now() - 3_600_000, endMs: Date.now() - 3_600_000, sources: ['1400000000000000001'], importance: 2 });
store.linkEpisodeNodes(GUILD, episode, ['people/たこ'], Date.now());
// 費用の台帳に記憶の呼び出しを1件
const reservation = reserveModelCall({ model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user', content: 'x' }], outputTokens: 10, guildId: GUILD, role: 'memory-segment' });
finishModelCall(reservation, { usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0033 } });

const interaction = ({ sub, admin = true, options = {} }) => {
  const calls = [];
  return {
    calls,
    guildId: GUILD,
    guild: { members: { fetch: async () => null } },
    user: { id: 'u1', username: 'tako' },
    member: { id: 'u1', permissions: { has: (flag) => admin && flag === PermissionFlagsBits.ManageGuild } },
    options: { getSubcommand: () => sub, getString: (name) => options[name] ?? null },
    reply: async (payload) => { calls.push(['reply', payload]); },
    deferReply: async (payload) => { calls.push(['deferReply', payload]); },
    editReply: async (payload) => { calls.push(['editReply', payload]); }
  };
};
const embedText = (payload) => {
  const embed = payload.embeds?.[0]?.toJSON?.() ?? payload.embeds?.[0];
  return [embed?.description ?? '', ...(embed?.fields ?? []).map((f) => `${f.name}: ${f.value}`)].join('\n');
};

// status は管理者だけ
const outsider = interaction({ sub: 'status', admin: false });
await memoryCommand.execute(outsider);
assert.deepEqual(outsider.calls.map((c) => c[0]), ['reply'], 'non-admins get a refusal without work');

const status = interaction({ sub: 'status' });
await memoryCommand.execute(status);
assert.deepEqual(status.calls.map((c) => c[0]), ['deferReply', 'editReply'], 'status must defer before reading the databases');
const shown = embedText(status.calls[1][1]);
assert.match(shown, /400 \/ 1,000 件 \(40\.0%\)/, 'progress against the counted total');
assert.match(shown, /あと約/, 'an ETA from the last hour');
assert.match(shown, /\$0\.003/, 'memory spending from the ledger');
assert.match(shown, /1 \/ 1 を最新まで読んだ|0 \/ 1 を最新まで読んだ/, 'channel progress');

// pause で builder が止まる
await memoryCommand.execute(interaction({ sub: 'pause' }));
let called = 0;
const stopped = await runBuild({ guildId: GUILD, call: async () => { called += 1; return { json: {} }; } });
assert.equal(stopped.stopped, 'paused', 'a paused builder must stop before calling the model');
assert.equal(called, 0);
const resume = interaction({ sub: 'resume' });
await memoryCommand.execute(resume);
assert.match(resume.calls[1][1], /再開しました/);
assert.equal(store.getState(`pause:${GUILD}`), null);
setPaused(GUILD, null);

// 追加したチャンネル: @everyone が見られないチャンネルとその下のスレッドを控えに入れる
const { readableChannels } = await import('../src/memory/snapshot.js');
const ROLE_GATED = '910000000000000020';
const THREAD = '910000000000000021';
const PRIVATE_THREAD = '910000000000000022';
const guild = { id: GUILD, channels: { cache: new Map([
  [THREAD, { id: THREAD, parentId: ROLE_GATED, isThread: () => true, type: 11 }],
  [PRIVATE_THREAD, { id: PRIVATE_THREAD, parentId: ROLE_GATED, isThread: () => true, type: 12 }]
]) }, roles: {}, members: {} };
const include = interaction({ sub: 'include', options: {} });
include.options.getChannel = () => ({ id: ROLE_GATED });
include.client = { guilds: { cache: new Map() } };
await memoryCommand.execute(include);
assert.match(include.calls[1][1], /記憶に入れます/);
assert.deepEqual(store.includedChannels(GUILD), [ROLE_GATED]);
const readable = readableChannels(guild, { threadsOf: () => ['910000000000000023'] });
assert.ok(readable.includes(ROLE_GATED) && readable.includes(THREAD) && readable.includes('910000000000000023'), 'included channels bring their public threads');
assert.ok(!readable.includes(PRIVATE_THREAD), 'private threads under an included channel stay out');
const excluded = interaction({ sub: 'exclude', options: {} });
excluded.options.getChannel = () => ({ id: ROLE_GATED });
excluded.client = include.client;
await memoryCommand.execute(excluded);
assert.match(excluded.calls[1][1], /外しました/);
assert.deepEqual(store.includedChannels(GUILD), []);

// 誰でも開ける。根拠の発言にリンクが付く
const show = interaction({ sub: 'show', admin: false, options: { path: 'people/たこ' } });
await memoryCommand.execute(show);
assert.match(embedText(show.calls[1][1]), /sakana bot を作っている/);
const ep = interaction({ sub: 'episode', admin: false, options: { id: `e${episode}` } });
await memoryCommand.execute(ep);
assert.match(embedText(ep.calls[1][1]), new RegExp(`\\[1\\]\\(https://discord\\.com/channels/${GUILD}/${CHANNEL}/1400000000000000001\\)`), 'episode sources must link to Discord');
const search = interaction({ sub: 'search', admin: false, options: { query: '統治機能' } });
await memoryCommand.execute(search);
assert.match(embedText(search.calls[1][1]), /統治機能を作った/);

store.resetTree(GUILD);
archive.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
console.log('memory command ok (status は管理者・先に受付・割合と見込みと費用 / pause で止まる / include・exclude / 誰でも開ける・根拠にリンク)');
