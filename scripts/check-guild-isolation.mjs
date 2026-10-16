import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'sakana-guild-isolation-'));
process.env.DATABASE_PATH = join(directory, 'main.sqlite');
process.env.ARCHIVE_DB_PATH = join(directory, 'archive.sqlite');
process.env.AGENT_RUNTIME_PATH = join(directory, 'runs.sqlite');
// 記憶の本の DB と本物のブラウザには触れない (tools.js を読み込むだけで開かれる)
process.env.MEMORY_DB_PATH ??= join(directory, 'memory.sqlite');
process.env.AGENT_BROWSER = '0';
const { db, saveMessage, upsertChannel } = await import('../src/archive/db.js');
const { toRecord } = await import('../src/archive/indexer.js');
const { buildToolset, runRead, runSearch } = await import('../src/agent/tools.js');
const { ChannelType, PermissionFlagsBits } = await import('discord.js');
const { runInfo } = await import('../src/agent/info.js');
const { RefTable } = await import('../src/agent/format.js');
const { exampleTurns } = await import('../src/mimic/speakers.js');
const { engineFor, setEngine, DEFAULT_ENGINE } = await import('../src/mimic/prefs.js');
const { personaFor, setPersona, personaCounts } = await import('../src/mimic/persona.js');
const { runAgent } = await import('../src/ai/runtime.js');
const { hasVisibilityClient, publicChannels, setVisibilityClient } = await import('../src/archive/visibility.js');
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
const message = (id, guildId, channelId, content, extra = {}) => ({
  id, guildId, channelId, content, author: { id: 'shared-user', username: 'shared-user' },
  createdTimestamp: 1700000000000, attachments: new Map(), ...extra
});
try {
  for (const msg of [
    message('100000000000000001', 'guild-a', 'public-a', 'LOCAL_PUBLIC_SENTINEL'),
    message('100000000000000002', 'guild-b', 'public-b', 'FOREIGN_SENTINEL'),
    message('100000000000000003', 'guild-a', 'private-a', 'PRIVATE_SENTINEL')
  ]) saveMessage(toRecord(msg));
  db.prepare('INSERT INTO message_reactions VALUES (?, ?, ?)').run('100000000000000002', 'FOREIGN_EMOJI', 9);
  const ctx = { guild: { id: 'guild-a', channels: { cache: new Map() } },
    channel: { id: 'public-a' }, channelScope: { mode: 'all', ids: [] }, refs: new RefTable() };
  await check('reply traversal stays in its guild even with all-channel scope', async () => {
    const output = await runRead(ctx, { direction: 'replies', at: '100000000000000002' });
    assert.doesNotMatch(output, /FOREIGN_SENTINEL/);
  });
  await check('reaction lookup verifies archived guild, not a caller-supplied reference', async () => {
    ctx.refs.add({ messageId: '100000000000000002', channelId: 'public-a', guildId: 'guild-a' });
    const output = await runInfo(ctx, { action: 'reactions', at: '1' });
    assert.doesNotMatch(output, /FOREIGN_EMOJI/);
  });
  await check('mimic examples require guild and readable channels', () => {
    const output = exampleTurns('shared-user', { guildId: 'guild-a', channelScope: { mode: 'include', ids: ['public-a'] } });
    assert.match(JSON.stringify(output), /LOCAL_PUBLIC_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(output), /FOREIGN_SENTINEL|PRIVATE_SENTINEL/);
    assert.deepEqual(exampleTurns('shared-user'), [], 'no unscoped history retrieval');
  });
  await check('model and persona preferences stay in one guild', () => {
    setEngine('shared-user', 'evex', 'guild-a');
    setPersona('shared-user', 'target-a', 'guild-a');
    assert.equal(engineFor('shared-user', 'guild-b'), DEFAULT_ENGINE);
    assert.equal(personaFor('shared-user', 'guild-b'), null);
    assert.deepEqual(personaCounts('guild-b'), []);
    assert.equal(setEngine('another-user', 'evex', 'guild-b'), true, 'model availability is not restricted by guild');
    assert.equal(engineFor('another-user', 'guild-b'), 'evex');
  });
  await check('same run ID cannot resume another guild checkpoint', async () => {
    const options = { guildId: 'guild-a', runId: 'same-local-id', system: 's', userContent: 'u',
      toolset: { definitions: [{ type: 'function', function: { name: 'read' } }], readOnly: true,
        call: async () => 'GUILD_A_INVESTIGATION' } };
    let requests = 0;
    await assert.rejects(runAgent({ ...options, request: async () => {
      if (requests++) throw new Error('offline');
      return { choices: [{ message: { tool_calls: [{ id: 'read', function: { name: 'read', arguments: '{}' } }] } }] };
    } }), /offline/);
    await runAgent({ ...options, guildId: 'guild-b', request: async ({ messages }) => {
      assert.doesNotMatch(JSON.stringify(messages), /GUILD_A_INVESTIGATION/);
      return { choices: [{ message: { content: 'B answer' } }] };
    } });
  });
  await check('public channels are limited to one guild and to what @everyone and the bot can read', () => {
    const everyone = { id: 'guild-a' }, bot = { id: 'bot' };
    const readable = { 'public-a': [everyone, bot], 'private-a': [bot], 'hidden-a': [everyone] };
    const channel = (id, type = 0) => ({ id, type, isTextBased: () => true,
      permissionsFor: (who) => ({ has: () => (readable[id] ?? []).includes(who) }) });
    const guild = { id: 'guild-a', roles: { everyone }, members: { me: bot },
      channels: { cache: new Map(['public-a', 'private-a', 'hidden-a'].map((id) => [id, channel(id)])) } };
    // Archived threads are rarely cached; their parent's visibility decides.
    for (const [channelId, guildId, parentId, isPrivate] of [
      ['archived-public-thread', 'guild-a', 'public-a', 0], ['archived-private-thread', 'guild-a', 'public-a', 1],
      ['archived-hidden-thread', 'guild-a', 'private-a', 0], ['foreign-thread', 'guild-b', 'public-a', 0]
    ]) upsertChannel({ channel_id: channelId, guild_id: guildId, parent_id: parentId, name: channelId, type: 11,
      is_thread: 1, is_private: isPrivate });
    assert.deepEqual(publicChannels('guild-a', guild).sort(), ['archived-public-thread', 'public-a']);
    assert.equal(hasVisibilityClient(), false);
    assert.deepEqual(publicChannels('guild-a'), [], 'no client and no supplied guild means nothing is known to be public');
    setVisibilityClient({ guilds: { cache: new Map([['guild-a', guild]]) } });
    try {
      assert.equal(hasVisibilityClient(), true);
      assert.deepEqual(publicChannels('guild-a').sort(), ['archived-public-thread', 'public-a']);
      assert.deepEqual(publicChannels('guild-b'), [], 'an uncached guild has no public channels');
    } finally { setVisibilityClient(null); }
  });

  // ---- ツール経由の読み取りが、呼んだ人に見えるチャンネルの中に留まること ----
  // 見えるかどうかは archive/permissions.js の canRead が決める。ここは偽物のチャンネルを
  // 渡して、tools.js がその判定を取りこぼさず通ることだけを見る。
  // readable でも ManageThreads は持たない人。非公開スレッドは参加者でなければ見えない。
  const fakeChannel = (id, readable, type = ChannelType.GuildText, extra = {}) => ({
    id, name: id, guildId: 'guild-a', type, rawPosition: 0,
    permissionsFor: () => ({ has: (flag) => readable && flag !== PermissionFlagsBits.ManageThreads }),
    ...extra
  });
  const publicChannel = fakeChannel('public-a', true);
  const privateChannel = fakeChannel('private-a', false);
  const toolCtx = (channels, extra = {}) => ({
    guild: { id: 'guild-a', channels: { cache: new Map(channels.map((channel) => [channel.id, channel])), fetch: async () => null },
      members: { cache: new Map() } },
    member: { id: 'viewer' }, channel: publicChannel, channelScope: { mode: 'all', ids: [] }, refs: new RefTable(),
    client: { user: { id: 'bot' } }, ...extra
  });

  await check('tool names are looked up as data, never as object properties', async () => {
    const toolset = await buildToolset(toolCtx([publicChannel]));
    assert.deepEqual(toolset.definitions.map((definition) => definition.function.name), ['search', 'read', 'channels', 'info']);
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
      assert.match(await toolset.call(name, {}), /そのツールはありません/, name);
    }
    assert.match(await toolset.call('channels', {}), /#public-a/, 'a real tool still resolves');
    assert.match(await toolset.call('channels', 'not-an-object'), /#public-a/, 'non-object arguments are treated as empty');
  });

  await check('discord search says nothing about hits in channels the caller cannot read', async () => {
    const hit = (id, channelId, content) => [{ id, channel_id: channelId, hit: true, content,
      timestamp: '2024-01-01T00:00:00.000Z', author: { id: 'author-1', username: 'someone' } }];
    const visible = hit('200000000000000001', 'public-a', 'VISIBLE_HIT');
    const hidden = hit('200000000000000002', 'private-a', 'HIDDEN_HIT');
    const run = (groups, limit) => runSearch(
      toolCtx([publicChannel, privateChannel], { client: { user: { id: 'bot' }, rest: { get: async () => ({ messages: groups }) } } }),
      { query: 'sentinel', limit }, { archiveAvailable: false, semanticAvailable: false });
    const mixed = await run([visible, hidden], 2);
    assert.match(mixed, /VISIBLE_HIT/);
    assert.doesNotMatch(mixed, /HIDDEN_HIT|読めない|除外|除いた/);
    // 1件は隠れているので「limit ぶん埋まった」とも言わない。隠れた側の有無で出力が変わらないこと
    assert.equal(mixed, await run([visible], 2), 'a hidden hit must not change the output at all');
    assert.equal(await run([hidden], 2), await run([], 2), 'only hidden hits looks exactly like no hits');
    assert.match(await run([], 2), /該当するメッセージはありませんでした/);
  });

  await check('active forum posts the caller cannot read are not listed', async () => {
    const thread = (id, type, members) => fakeChannel(id, true, type, {
      name: id, ownerId: 'owner', messageCount: 3, createdTimestamp: 1, members: { cache: new Map(members) } });
    const open = thread('OPEN_POST', ChannelType.PublicThread, []);
    const secret = thread('SECRET_POST', ChannelType.PrivateThread, []);
    const joined = thread('JOINED_POST', ChannelType.PrivateThread, [['viewer', {}]]);
    const forum = fakeChannel('forum-a', true, ChannelType.GuildForum, {
      threads: { fetchActive: async () => ({ threads: new Map([open, secret, joined].map((entry) => [entry.id, entry])) }) } });
    const output = await runRead(toolCtx([forum]), { channel: 'forum-a' });
    assert.match(output, /OPEN_POST/);
    assert.match(output, /JOINED_POST/, 'a private thread the caller is in stays visible');
    assert.doesNotMatch(output, /SECRET_POST/);
  });

  await check('a start point that is not a message ID is refused before any fetch', async () => {
    let fetches = 0;
    const text = fakeChannel('text-a', true, ChannelType.GuildText, {
      messages: { fetch: async () => { fetches += 1; return new Map(); } } });
    const ctx2 = toolCtx([text]);
    ctx2.refs.add({ messageId: 'not-a-snowflake', channelId: 'somewhere-else' });
    const output = await runRead(ctx2, { channel: 'text-a', at: '1' });
    assert.match(output, /メッセージ ID の形ではない/);
    assert.doesNotMatch(output, /BigInt|SyntaxError/);
    assert.equal(fetches, 0);
    for (const direction of ['before', 'after']) {
      assert.match(await runRead(ctx2, { channel: 'text-a', at: '1', direction }), /メッセージ ID の形ではない/);
    }
    assert.equal(fetches, 0);
  });

  await check('model-supplied lists and strings are cut down before they are used', async () => {
    const seen = [];
    const text = fakeChannel('text-a', true, ChannelType.GuildText, { messages: { fetch: async () => new Map() } });
    const ctx3 = toolCtx([text], { client: { user: { id: 'bot' }, rest: { get: async (_path, options) => {
      seen.push(options.query); return { messages: [] };
    } } } });
    await runSearch(ctx3, { query: 'a'.repeat(50_000), offset: 1e12 }, { archiveAvailable: false, semanticAvailable: false });
    assert.ok(seen[0].get('content').length <= 500, 'query is capped');
    assert.ok(Number(seen[0].get('offset')) <= 10_000, 'offset is capped');
    // 1000 個のチャンネル指定でも、読むのは5つまで。超えたことは言う
    const many = await runRead(ctx3, { channel: Array(1000).fill('text-a').join(',') });
    assert.match(many, /一度に読めるのは 5 チャンネルまで/);
    assert.equal((many.match(/--- #text-a/g) ?? []).length, 5);
    await assert.rejects(runRead(ctx3, { channel: 'x'.repeat(50_000) }), /見つかりませんでした/);
  });

  assert.deepEqual(failures, [], 'server information isolation regressions');
  console.log('check-guild-isolation: ok');
} finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
