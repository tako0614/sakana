import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = mkdtempSync(join(tmpdir(), 'sakana-agents-'));
process.env.DATABASE_PATH = join(directory, 'main.sqlite');
process.env.ARCHIVE_DB_PATH = join(directory, 'archive.sqlite');
process.env.AGENT_RUNTIME_PATH = join(directory, 'runs.sqlite');
process.env.ATOM_MEMORY_PATH = join(directory, 'atoms.sqlite');
process.env.DEEPSEEK_API_KEY = 'check';
const { db, saveMessage, markMessageDeleted } = await import('../src/archive/db.js');
const { toRecord } = await import('../src/archive/indexer.js');
const { RefTable, formatMessages, fromDiscordMessage, fromArchiveRow } = await import('../src/agent/format.js');
const { fetchReplyChain } = await import('../src/agent/index.js');
const { conversationMemory, syncConversationMemory, memoryStatus } = await import('../src/conversation/memory.js');
const { runAgent } = await import('../src/ai/runtime.js');
const message = (id, text, extra = {}) => ({ id, guildId: 'g', channelId: 'c', content: text,
  author: { id: 'author', username: 'author' }, attachments: new Map(),
  createdTimestamp: 1700000000000, reactions: { cache: new Map() }, ...extra });
try {
  const parent = message('parent', 'original claim');
  const reply = message('reply', 'that is wrong', { reference: { messageId: 'parent', channelId: 'c' } });
  const refs = new RefTable();
  const rendered = formatMessages([fromDiscordMessage(reply), fromDiscordMessage(parent)], { refs });
  const rows = rendered.split('\n').map((line) => JSON.parse(line.replace(/^\d+\) /, '')));
  assert.equal(rows[0].reference.ref, 2, 'reply edges work even when parent sorts after child');
  assert.equal(rows[0].reference.kind, 'reply');
  assert.equal(rows[0].reference.authorId, 'author');
  const absent = JSON.parse(formatMessages([fromDiscordMessage(reply)]).trim());
  assert.equal(absent.reference.messageId, 'parent');
  assert.equal(absent.reference.availability, 'not_fetched');
  const forward = message('forward', '', { reference: { type: 1, messageId: 'elsewhere' },
    messageSnapshots: new Map([['elsewhere', { content: 'quoted secret claim' }]]) });
  const forwarded = fromDiscordMessage(forward);
  assert.equal(forwarded.structure.reference.kind, 'forward');
  assert.equal(forwarded.structure.forwarded[0].authorId, null);
  assert.equal((await fetchReplyChain(forward)).length, 0, 'forwarding is not replying');
  const record = toRecord(forward);
  assert.equal(record.content, '', 'do not attribute forwarded text to the sender');
  assert.equal(fromArchiveRow(record).structure.forwarded[0].content, 'quoted secret claim');
  const threadMessage = message('thread', 'thread body', { channel: { isThread: () => true, parentId: 'forum', name: 'topic', archived: true, locked: false } });
  assert.equal(fromDiscordMessage(threadMessage).structure.thread.parentChannelId, 'forum');

  for (const row of [parent, reply, forward, message('memory', 'golden_needlememory current source'),
    message('private', 'golden_needlememory PRIVATE', { channelId: 'private' }),
    message('other-guild', 'golden_needlememory OTHER GUILD', { guildId: 'other' })]) saveMessage(toRecord(row));
  assert.doesNotThrow(() => saveMessage(toRecord(parent)), 'reindexing an already queued message must be idempotent');
  const { SqliteStorage } = await import('../subprojects/atom-memory/dist/adapters/sqlite.js');
  const flush = SqliteStorage.prototype.flush;
  SqliteStorage.prototype.flush = () => { throw new Error('durability barrier failed'); };
  try {
    await assert.rejects(syncConversationMemory(), /durability barrier failed/);
    assert.equal(memoryStatus().pending, 6, 'failed durable flush must not acknowledge any source');
  } finally { SqliteStorage.prototype.flush = flush; }
  await syncConversationMemory();
  assert.equal(memoryStatus().pending, 0);
  let allowed = true;
  const channel = { id: 'c', guild: { id: 'g', members: { me: { id: 'bot' } } }, permissionsFor: () => ({ has: () => allowed }) };
  const memory = conversationMemory({ guildId: 'g', channel, member: { id: 'reader' }, query: 'golden_needlememory' });
  const recalled = await memory.read();
  assert.match(recalled.text, /current source/);
  assert.doesNotMatch(recalled.text, /PRIVATE|OTHER GUILD/);
  allowed = false;
  await assert.rejects(memory.assertCurrent(), /permission changed|ACCESS_DENIED/);
  memory.close(); allowed = true;
  const beforeEdit = conversationMemory({ guildId: 'g', channel, member: { id: 'reader' }, query: 'golden_needlememory' });
  await beforeEdit.read();
  saveMessage(toRecord(message('memory', 'golden_needlememory corrected source', { editedTimestamp: Date.now() })));
  await assert.rejects(beforeEdit.assertCurrent(), /changed|ACCESS_DENIED|STALE|REVOKED/);
  beforeEdit.close();
  const pendingEdit = conversationMemory({ guildId: 'g', channel, member: { id: 'reader' }, query: 'golden_needlememory' });
  assert.doesNotMatch((await pendingEdit.read()).text, /current source/, 'queued edits must hide old sources without blocking on ingestion');
  pendingEdit.close();
  await syncConversationMemory();
  const afterEdit = conversationMemory({ guildId: 'g', channel, member: { id: 'reader' }, query: 'golden_needlememory' });
  const corrected = await afterEdit.read();
  assert.match(corrected.text, /corrected source/);
  assert.doesNotMatch(corrected.text, /current source/);
  markMessageDeleted('memory');
  await assert.rejects(afterEdit.assertCurrent(), /changed|ACCESS_DENIED|STALE|REVOKED/);
  afterEdit.close();
  assert.equal(db.prepare('SELECT count(*) n FROM message_versions WHERE message_id = ?').get('memory').n, 2);
  const restart = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { syncConversationMemory, memoryStatus } = await import('./src/conversation/memory.js');
    await syncConversationMemory(); console.log(JSON.stringify(memoryStatus()));
  `], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  assert.equal(restart.status, 0, restart.stderr);
  assert.equal(JSON.parse(restart.stdout.trim()).pending, 0);

  let tools = 0;
  let requests = 0;
  const options = { guildId: 'g', runId: 'resume-investigation', system: 's', userContent: 'u', maximumSteps: 4,
    toolset: { readOnly: true, definitions: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      call: async () => { tools += 1; return { content: 'FULL evidence' }; } },
    request: async () => { requests += 1;
      if (requests === 1) return { choices: [{ message: { tool_calls: [{ id: 'read-1', function: { name: 'read', arguments: '{}' } }] } }] };
      throw new Error('HTTP 503');
    } };
  await assert.rejects(runAgent(options), /HTTP 503/);
  const result = await runAgent({ ...options, request: async ({ messages }) => {
    assert.ok(messages.some((entry) => entry.role === 'tool' && entry.content.includes('FULL evidence')));
    return { choices: [{ message: { content: 'resumed answer' } }] };
  } });
  assert.equal(tools, 1, 'checkpoint resumes after the committed tool, without repeating it');
  assert.equal(result.text, 'resumed answer');
  const independent = await runAgent({ ...options, request: async () => ({ choices: [{ message: { content: 'independent new decision' } }] }) });
  assert.equal(independent.text, 'independent new decision', 'a completed decision does not replace a new deliberation');
  assert.notEqual(independent.runId, result.runId);
  let effects = 0;
  const effectOptions = { ...options, runId: 'uncertain-effect', toolset: { ...options.toolset, readOnly: false,
    call: async () => { effects += 1; throw new Error('connection lost after action'); } },
    request: async () => ({ choices: [{ message: { tool_calls: [{ id: 'act', function: { name: 'read', arguments: '{}' } }] } }] }) };
  await assert.rejects(runAgent(effectOptions), /connection lost/);
  await assert.rejects(runAgent(effectOptions), /automatic replay is disabled/);
  assert.equal(effects, 1, 'an uncertain external effect cannot be replayed on resume');
  console.log('agent-runtime ok (Discord edges, source attribution, Atom persistence, ACL, edits, deletion, durable retry)');
} finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
