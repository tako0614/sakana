process.env.MEMORY_EMBEDDINGS = '0';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = mkdtempSync(join(tmpdir(), 'sakana-writer-'));
process.env.ARCHIVE_DB_PATH = join(directory, 'archive.sqlite');
process.env.ATOM_MEMORY_PATH = join(directory, 'atoms.sqlite');
process.env.AGENT_RUNTIME_PATH = join(directory, 'runs.sqlite');
process.env.MEMORY_WRITER_QUIET_MS = '1';
const { db, saveMessage, markMessageDeleted } = await import('../src/archive/db.js');
const { toRecord } = await import('../src/archive/indexer.js');
const { conversationMemory, syncConversationMemory } = await import('../src/conversation/memory.js');
const { runConversationWriter, writerStatus, validateWriterPlan } = await import('../src/conversation/writer.js');
const { SqliteStorage } = await import('../subprojects/atom-memory/dist/adapters/sqlite.js');
const { MemoryHost } = await import('../subprojects/atom-memory/dist/index.js');
const message = (id, content, extra = {}) => ({ id, content, guildId: 'g', channelId: 'c',
  author: { id: 'alice', username: 'alice' }, attachments: new Map(),
  createdTimestamp: 1700000000000, reactions: { cache: new Map() }, ...extra });
const channel = { id: 'c', guild: { id: 'g', members: { me: { id: 'bot' } } }, permissionsFor: () => ({ has: () => true }) };
const reader = () => conversationMemory({ guildId: 'g', channel, member: { id: 'viewer' }, query: 'golden_semantic' });
let calls = 0;
const plan = { atoms: [
  { id: 'a1', kind: 'statement', text: 'golden_semantic: Alice proposed allowing a bot to ban.', sources: ['proposal'], links: [] },
  { id: 'a2', kind: 'statement', text: 'golden_semantic: Bob rejected automated bans; administrators must act manually.', sources: ['correction'], links: [] },
  { id: 'a3', kind: 'collection', text: 'golden_semantic: discussion about who executes bans.', sources: ['proposal', 'correction'], links: [] },
  { id: 'a4', kind: 'relation', text: 'golden_semantic: Bob opposed the proposal in this discussion.', sources: ['correction'],
    links: [{ role: 'group', target: 'a3', required: false }, { role: 'proposal', target: 'a1', required: false },
      { role: 'opposition', target: 'a2', required: true }] }
] };
const request = async ({ messages }) => {
  calls++;
  const input = JSON.parse(messages[1].content);
  assert.ok(input.messages.every((row) => row.location.guildId === 'g' && row.location.channelId === 'c'));
  assert.equal(input.messages.find((row) => row.id === 'correction').reference.messageId, 'proposal');
  return { choices: [{ message: { content: JSON.stringify(plan) } }], usage: { prompt_tokens: 100, completion_tokens: 80 } };
};
try {
  saveMessage(toRecord(message('proposal', 'Botがbanを実行するようにしたい。')));
  saveMessage(toRecord(message('correction', '反対。banは管理者が手動でやる。', {
    author: { id: 'bob', username: 'bob' }, createdTimestamp: 1700000001000,
    reference: { messageId: 'proposal', channelId: 'c' }
  })));
  saveMessage(toRecord(message('secret', 'OTHER_GUILD_SECRET', { guildId: 'other', channelId: 'other' })));
  assert.throws(() => validateWriterPlan({ atoms: [{ ...plan.atoms[0], sources: ['secret'] }] }, new Set(['proposal'])), /unobserved/);
  assert.throws(() => validateWriterPlan({ atoms: [{ ...plan.atoms[0], links: [{ role: 'x', target: 'unissued', required: false }] }] }, new Set(['proposal'])), /unissued/);

  // Provider outage does not turn raw ingestion into completed AI understanding.
  await assert.rejects(runConversationWriter({ guildIds: ['g'], now: Date.now() + 100,
    request: async () => { throw new Error('HTTP 503'); } }), /503/);
  assert.equal(writerStatus(['g']).pending, 2);
  assert.equal(writerStatus(['g']).batches, 0);

  // Atom commit succeeds but its durability barrier fails. Retry in another
  // process must acknowledge the same generation without paying for another call.
  const flush = SqliteStorage.prototype.flush;
  let flushes = 0;
  SqliteStorage.prototype.flush = function () {
    if (++flushes === 2) throw new Error('writer durable barrier failed');
    return flush.call(this);
  };
  try {
    await assert.rejects(runConversationWriter({ guildIds: ['g'], now: Date.now() + 100000, request }), /durable barrier/);
    assert.equal(writerStatus(['g']).pending, 2);
  } finally { SqliteStorage.prototype.flush = flush; }
  const restart = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const {runConversationWriter}=await import('./src/conversation/writer.js');
    const r=await runConversationWriter({guildIds:['g'],now:Date.now()+1000000,
      request:async()=>{throw Error('must not repeat completed AI extraction')}});
    console.log(JSON.stringify(r));
  `], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  assert.equal(restart.status, 0, restart.stderr);
  assert.equal(calls, 1);
  assert.equal(writerStatus(['g']).pending, 0);
  assert.equal(writerStatus(['g']).atoms, 4);
  assert.equal(writerStatus(['other']).pending, 1);

  const before = reader();
  const recalled = await before.read();
  const packed = JSON.parse(recalled.text);
  assert.ok(packed.memory.some((atom) => atom.provenance.origin === 'organization'));
  assert.match(recalled.text, /administrators must act manually/);
  assert.doesNotMatch(recalled.text, /OTHER_GUILD_SECRET/);
  assert.ok(packed.memory.some((atom) => atom.links.some((link) => link.role === 'opposition')));
  const budgeted = conversationMemory({ guildId: 'g', channel, member: { id: 'viewer' }, query: 'golden_semantic',
    onObservation: () => true, onInterpretation: () => false });
  assert.ok(JSON.parse((await budgeted.read()).text).memory.every((atom) => atom.provenance.origin === 'source'),
    'generated descriptions consume the institution output budget too');
  budgeted.close();
  // Regeneration is queued for ALL inputs that shared the changed context.
  markMessageDeleted('correction');
  assert.equal(writerStatus(['g']).pending, 2);
  await assert.rejects(before.assertCurrent(), /changed|STALE|REVOKED/);
  before.close();
  const stale = reader();
  assert.doesNotMatch((await stale.read()).text, /administrators must act manually/);
  stale.close();
  await syncConversationMemory();
  const after = reader();
  assert.doesNotMatch((await after.read()).text, /administrators must act manually/);
  after.close();
  await assert.rejects(runConversationWriter({ guildIds: ['g'], now: Date.now() + 1000000,
    request: async () => {
      saveMessage(toRecord(message('proposal', 'The proposal was withdrawn.')));
      return { choices: [{ message: { content: JSON.stringify({ atoms: [plan.atoms[0]] }) } }] };
    } }), /source changed/, 'an edit during model inference must reject the stale write plan');
  assert.equal(writerStatus(['g']).pending, 2);
  // Several attachment-only messages produce a truthy newline-only string.
  // Existing organization must not turn that into an invalid recall request.
  for (let i = 0; i < 6; i++) saveMessage(toRecord(message(`empty-${i}`, '', {
    createdTimestamp: 1700001000000 + i * 1000
  })));
  let emptyBatchCalls = 0;
  await runConversationWriter({ guildIds: ['g'], now: Date.now() + 1000000,
    request: async () => {
      emptyBatchCalls++;
      return { choices: [{ message: { content: '{"atoms":[]}' } }] };
    } });
  assert.equal(emptyBatchCalls, 1, 'attachment-only batches still reach the AI');
  saveMessage(toRecord(message('budget-source', '原資料からこの提案を整理する。', { createdTimestamp: 1700004000000 })));
  const connect = MemoryHost.prototype.connect;
  MemoryHost.prototype.connect = function (...args) {
    const client = connect.apply(this, args);
    client.read = async () => { throw Object.assign(new Error('BUDGET_EXHAUSTED'), { code: 'BUDGET_EXHAUSTED' }); };
    return client;
  };
  try {
    const organized = await runConversationWriter({ guildIds: ['g'], now: Date.now() + 1000000,
      request: async ({ messages }) => {
        assert.ok(messages.some(message => message.content?.includes('retrieval_budget')),
          'the model must see that recall was incomplete, not that prior memory was absent');
        return { choices: [{ message: { content: JSON.stringify({ atoms: [{ id: 'a1', kind: 'statement',
          text: 'Aliceは原資料から提案を整理するよう求めた。', sources: ['budget-source'], links: [] }] }) } }] };
      } });
    assert.equal(organized.batchAtoms, 1, 'optional recall budget must not permanently strand a source batch');
  } finally { MemoryHost.prototype.connect = connect; }
  saveMessage(toRecord(message('rev-source', 'revision-topic: 管理者の役割を整理する。', {
    channelId: 'revision-channel', createdTimestamp: 1700007000000
  })));
  await runConversationWriter({ guildIds: ['g'], now: Date.now() + 1000000,
    request: async () => ({ choices: [{ message: { content: JSON.stringify({ atoms: [{ id: 'a1', kind: 'collection',
      text: 'revision-topic: 管理者の役割の整理。', sources: ['rev-source'], links: [] }] }) } }] }) });
  const verify = new SqliteStorage(process.env.ATOM_MEMORY_PATH);
  const group = () => verify.scan({ policies: ['discord:g:revision-channel'], limit: 100 }, verify.watermark())
    .find(row => row.provenance.producerId === 'discord-memory-writer');
  const previousGroup = group();
  saveMessage(toRecord(message('rev-update', 'revision-topic: banは手動執行という条件も明記する。', {
    channelId: 'revision-channel', createdTimestamp: 1700007001000
  })));
  await runConversationWriter({ guildIds: ['g'], now: Date.now() + 1000000,
    request: async ({ messages }) => {
      const block = messages.findLast(row => row.content?.startsWith('REFERENCE MEMORY'));
      const existing = JSON.parse(block.content.slice(block.content.indexOf('\n') + 1)).existing;
      const selected = existing.find(row => JSON.parse(row.text).kind === 'collection');
      assert.ok(selected, 'Writer must receive the existing arrangement as an issued reference');
      return { choices: [{ message: { content: JSON.stringify({ atoms: [{ id: 'a1', kind: 'collection', revise: selected.ref,
        text: 'revision-topic: 管理者がbanを手動執行する役割の整理。', sources: ['rev-source', 'rev-update'], links: [] }] }) } }] };
    } });
  assert.equal(group().atomId, previousGroup.atomId, 'reorganization revises the same Atom identity');
  assert.notEqual(group().revisionId, previousGroup.revisionId);
  verify.close();
  console.log('memory writer: grounded Atom relations, isolation, durable retry and deletion invalidation passed');
} finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
