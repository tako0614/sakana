process.env.MEMORY_EMBEDDINGS = '0';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'sakana-guild-isolation-'));
process.env.DATABASE_PATH = join(directory, 'main.sqlite');
process.env.ARCHIVE_DB_PATH = join(directory, 'archive.sqlite');
process.env.AGENT_RUNTIME_PATH = join(directory, 'runs.sqlite');
process.env.ATOM_MEMORY_PATH = join(directory, 'atoms.sqlite');
const { db, saveMessage } = await import('../src/archive/db.js');
const { toRecord } = await import('../src/archive/indexer.js');
const { runRead } = await import('../src/agent/tools.js');
const { runInfo } = await import('../src/agent/info.js');
const { RefTable } = await import('../src/agent/format.js');
const { exampleTurns } = await import('../src/mimic/speakers.js');
const { engineFor, setEngine, DEFAULT_ENGINE } = await import('../src/mimic/prefs.js');
const { personaFor, setPersona, personaCounts } = await import('../src/mimic/persona.js');
const { runAgent } = await import('../src/ai/runtime.js');
const { conversationMemory, syncConversationMemory } = await import('../src/conversation/memory.js');
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
  await check('memory does not expose other guild or hidden-channel counts', async () => {
    await syncConversationMemory();
    const channel = { id: 'public-a', guildId: 'guild-a', guild: { id: 'guild-a', members: { me: { id: 'bot' } } },
      permissionsFor: () => ({ has: () => true }) };
    const memory = conversationMemory({ guildId: 'guild-a', channel, member: { id: 'reader' }, query: 'LOCAL_PUBLIC_SENTINEL' });
    try {
      const output = JSON.parse((await memory.read()).text);
      assert.equal(output.coverage.messages, 1);
    } finally { memory.close(); }
  });
  assert.deepEqual(failures, [], 'server information isolation regressions');
  console.log('check-guild-isolation: ok');
} finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
