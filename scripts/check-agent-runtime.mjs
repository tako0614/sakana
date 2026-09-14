process.env.MEMORY_EMBEDDINGS = '0';
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
process.env.OPENROUTER_API_KEY = 'check';
const { db, saveMessage, markMessageDeleted } = await import('../src/archive/db.js');
const { toRecord } = await import('../src/archive/indexer.js');
const { RefTable, formatMessages, fromDiscordMessage, fromArchiveRow } = await import('../src/agent/format.js');
const { chatRunId, fetchReplyChain } = await import('../src/agent/index.js');
const { conversationMemory, syncConversationMemory, memoryStatus } = await import('../src/conversation/memory.js');
const { attachMemoryDelivery, runAgent } = await import('../src/ai/runtime.js');
const { db: mainDb } = await import('../src/db.js');
const { finalizeCall, releaseCall, reserveCall } = await import('../src/agent/ratelimit.js');
const message = (id, text, extra = {}) => ({ id, guildId: 'g', channelId: 'c', content: text,
  author: { id: 'author', username: 'author' }, attachments: new Map(),
  createdTimestamp: 1700000000000, reactions: { cache: new Map() }, ...extra });
try {
  const chatIdentity = { guildId: 'g', channelId: 'c', memberId: 'reader', messageId: 'input-1' };
  assert.equal(chatRunId(chatIdentity), chatRunId({ ...chatIdentity }), 'one Discord input has one durable chat run ID');
  for (const key of Object.keys(chatIdentity)) assert.notEqual(chatRunId(chatIdentity),
    chatRunId({ ...chatIdentity, [key]: `${chatIdentity[key]}-other` }), `${key} must isolate chat checkpoints`);
  assert.throws(() => chatRunId({ ...chatIdentity, messageId: '' }), /requires/);

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
  // Automatic recall is driven by the live context, not a constructor query.
  const memory = conversationMemory({ guildId: 'g', channel, member: { id: 'reader' } });
  const recalled = await memory.read({ context: 'golden_needlememory' });
  assert.match(recalled.text, /current source/);
  assert.doesNotMatch(recalled.text, /PRIVATE|OTHER GUILD/);
  allowed = false;
  await assert.rejects(memory.assertCurrent(), /permission changed|ACCESS_DENIED/);
  memory.close(); allowed = true;
  const beforeEdit = conversationMemory({ guildId: 'g', channel, member: { id: 'reader' } });
  await beforeEdit.read({ context: 'golden_needlememory' });
  saveMessage(toRecord(message('memory', 'golden_needlememory corrected source', { editedTimestamp: Date.now() })));
  await assert.rejects(beforeEdit.assertCurrent(), /changed|ACCESS_DENIED|STALE|REVOKED/);
  beforeEdit.close();
  const pendingEdit = conversationMemory({ guildId: 'g', channel, member: { id: 'reader' } });
  assert.doesNotMatch((await pendingEdit.read({ context: 'golden_needlememory' })).text, /current source/, 'queued edits must hide old sources without blocking on ingestion');
  pendingEdit.close();
  await syncConversationMemory();
  const afterEdit = conversationMemory({ guildId: 'g', channel, member: { id: 'reader' } });
  const corrected = await afterEdit.read({ context: 'golden_needlememory' });
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
  let staleSent = false;
  await assert.rejects(runAgent({ guildId: 'g', runId: 'stale-before-send', system: 's', userContent: 'u',
    memory: { read: async () => ({ text: 'REVOKED_SECRET' }),
      assertCurrent: async () => { throw new Error('memory revoked during recall'); } },
    toolset: { readOnly: true, definitions: [], call: async () => ({}) },
    request: async () => { staleSent = true; return { choices: [{ message: { content: 'bad' } }] }; }
  }), /revoked during recall/);
  assert.equal(staleSent, false, 'revoked recalled data must not reach the provider');
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

  // The provider response and exact delivered refs precede the durable use
  // notification. A notification failure therefore resumes the saved response
  // with the same event instead of buying or observing another model call.
  let ackRequests = 0, ackAttempts = 0, ackCurrentChecks = 0, failAck = true;
  const accounted = new Set();
  const accountingMemory = () => ({
    read: async () => attachMemoryDelivery({ text: 'remembered body' }, ['observed-memory-ref', 'observed-memory-ref'],
      { schema: 'test.current' }),
    async assertCurrent(delivery) {
      ackCurrentChecks += 1;
      if (delivery) assert.deepEqual(delivery.refs, ['observed-memory-ref']);
    },
    recordUse(refs, { eventId }) {
      ackAttempts += 1;
      for (const ref of refs) accounted.add(`${eventId}:${ref}`);
      if (failAck) { failAck = false; throw new Error('use notification interrupted after commit'); }
    }
  });
  const ackOptions = { guildId: 'g', runId: 'resume-memory-use-final', system: 's', userContent: 'u',
    reuseCompleted: true, memory: accountingMemory(), request: async ({ messages }) => {
      ackRequests += 1;
      assert.match(messages.findLast((entry) => entry.content?.startsWith('REFERENCE MEMORY'))?.content ?? '', /remembered body/);
      assert.doesNotMatch(JSON.stringify(messages), /observed-memory-ref|memoryDelivery/,
        'host usage metadata must not enter provider messages');
      return { choices: [{ message: { content: 'saved answer' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, prompt_cache_hit_tokens: 3 } };
    } };
  const firstAckUsage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 };
  const firstAckReservation = reserveCall({ guildId: 'g', channelId: 'c', userId: 'runtime-use-ledger', admin: true });
  assert.ok(firstAckReservation.ok);
  await assert.rejects(runAgent({ ...ackOptions, usage: firstAckUsage }), /use notification interrupted/);
  releaseCall(firstAckReservation.id, firstAckUsage);
  assert.deepEqual(firstAckUsage,
    { prompt_tokens: 12, completion_tokens: 4, prompt_cache_hit_tokens: 3, rounds: 1 },
    'the failed invocation exposes exactly the provider work it observed');
  const retryAckUsage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 };
  const retryAckReservation = reserveCall({ guildId: 'g', channelId: 'c', userId: 'runtime-use-ledger', admin: true });
  assert.ok(retryAckReservation.ok);
  const savedAnswer = await runAgent({ ...ackOptions, memory: accountingMemory(),
    usage: retryAckUsage,
    request: async () => { throw new Error('saved response must avoid another provider call'); } });
  finalizeCall(retryAckReservation.id, { status: 'ok', ...savedAnswer.invocation });
  assert.equal(savedAnswer.text, 'saved answer');
  assert.equal(savedAnswer.rounds, 1);
  assert.deepEqual(savedAnswer.usage,
    { prompt_tokens: 12, completion_tokens: 4, prompt_cache_hit_tokens: 3 },
    'the durable result retains cumulative usage');
  assert.deepEqual(savedAnswer.invocation,
    { rounds: 0, usage: { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 } },
    'an ack-only resume has no newly chargeable provider work');
  assert.deepEqual(retryAckUsage,
    { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, rounds: 0 });
  assert.deepEqual(mainDb.prepare(`SELECT status,rounds,prompt_tokens,completion_tokens,cached_tokens
    FROM agent_calls WHERE id IN (?,?) ORDER BY id`).all(firstAckReservation.id, retryAckReservation.id), [
    { status: 'error', rounds: 1, prompt_tokens: 12, completion_tokens: 4, cached_tokens: 3 },
    { status: 'ok', rounds: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 }
  ], 'the first attempt is charged once and its successful ack-only retry is zero');
  assert.equal(ackRequests, 1);
  assert.equal(ackAttempts, 2, 'the same durable notification is retried after an ambiguous acknowledgement');
  assert.equal(accounted.size, 1, 'same run/round/ref tuple is accounted once');
  assert.ok(ackCurrentChecks >= 3, 'saved delivery is rechecked under the resumed memory binding');

  let failedUseRecords = 0;
  await assert.rejects(runAgent({ guildId: 'g', runId: 'failed-memory-request', system: 's', userContent: 'u',
    memory: { read: async () => attachMemoryDelivery({ text: 'unused body' }, ['unused-ref']),
      assertCurrent: async () => {}, recordUse: () => { failedUseRecords += 1; } },
    request: async () => { throw new Error('provider unavailable'); } }), /provider unavailable/);
  assert.equal(failedUseRecords, 0, 'a failed provider request must not record memory use');

  const validationEvents = [];
  let validationRequests = 0;
  const validated = await runAgent({ guildId: 'g', runId: 'invalid-memory-answer', system: 's', userContent: 'u',
    memory: { read: async () => attachMemoryDelivery({ text: 'schema input memory' }, ['schema-ref']),
      assertCurrent: async () => {}, recordUse: (_refs, options) => validationEvents.push(options.eventId) },
    request: async () => ({ choices: [{ message: { content: ++validationRequests === 1 ? '{bad json' : '{"ok":true}' } }] }),
    validate: (providerMessage) => JSON.parse(providerMessage.content) });
  assert.deepEqual(validated.output, { ok: true });
  assert.equal(validationEvents.length, 2, 'an observed input counts even when final JSON validation rejects its answer');
  assert.match(validationEvents[0], /:model:0$/);
  assert.match(validationEvents[1], /:model:1$/);

  let toolAckRequests = 0, toolAckCalls = 0, failToolAck = true;
  const toolAccounted = new Set();
  const toolMemory = () => ({
    read: async () => attachMemoryDelivery({ text: 'automatic memory' }, ['automatic-ref']),
    assertCurrent: async () => {},
    recordUse(refs, { eventId }) {
      for (const ref of refs) toolAccounted.add(`${eventId}:${ref}`);
      if (failToolAck) { failToolAck = false; throw new Error('tool response notification interrupted'); }
    }
  });
  const toolAckOptions = { guildId: 'g', runId: 'resume-memory-use-tool', system: 's', userContent: 'u',
    memory: toolMemory(), toolset: { readOnly: true,
      definitions: [{ type: 'function', function: { name: 'memory_search', parameters: { type: 'object' } } }],
      call: async () => { toolAckCalls += 1;
        return attachMemoryDelivery({ entry: 'tool-delivered memory body' }, ['tool-memory-ref']); } },
    request: async ({ messages }) => {
      toolAckRequests += 1;
      assert.doesNotMatch(JSON.stringify(messages), /automatic-ref|tool-memory-ref|memoryDelivery/);
      if (toolAckRequests === 1) return { choices: [{ message: { tool_calls: [{ id: 'memory-1',
        function: { name: 'memory_search', arguments: '{}' } }] } }],
        usage: { prompt_tokens: 20, completion_tokens: 2, prompt_cache_hit_tokens: 5 } };
      assert.match(messages.find((entry) => entry.role === 'tool')?.content ?? '', /tool-delivered memory body/);
      return { choices: [{ message: { content: 'tool-assisted answer' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, prompt_cache_hit_tokens: 1 } };
    } };
  const firstToolUsage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 };
  await assert.rejects(runAgent({ ...toolAckOptions, usage: firstToolUsage }), /tool response notification interrupted/);
  assert.deepEqual(firstToolUsage,
    { prompt_tokens: 20, completion_tokens: 2, prompt_cache_hit_tokens: 5, rounds: 1 });
  const retryToolUsage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 };
  const toolAnswer = await runAgent({ ...toolAckOptions, memory: toolMemory(), usage: retryToolUsage });
  assert.equal(toolAnswer.text, 'tool-assisted answer');
  assert.deepEqual(toolAnswer.usage,
    { prompt_tokens: 27, completion_tokens: 5, prompt_cache_hit_tokens: 6 },
    'the durable tool result remains cumulative across both provider rounds');
  assert.deepEqual(toolAnswer.invocation,
    { rounds: 1, usage: { prompt_tokens: 7, completion_tokens: 3, prompt_cache_hit_tokens: 1 } },
    'the resumed invocation charges only its new post-tool model round');
  assert.deepEqual(retryToolUsage,
    { prompt_tokens: 7, completion_tokens: 3, prompt_cache_hit_tokens: 1, rounds: 1 });
  assert.equal(toolAckRequests, 2, 'a saved tool-call response resumes without repeating its provider round');
  assert.equal(toolAckCalls, 1);
  assert.equal(toolAccounted.size, 3,
    'automatic memory and the retained memory tool body are deduped per successful provider round');

  const generationInputs=[];
  let generationRequests=0;
  const generationOptions={guildId:'g',runId:'host-generation-input',system:'s',userContent:'current context',reuseCompleted:true,
    toolset:{readOnly:true,definitions:[{type:'function',function:{name:'lookup',parameters:{type:'object'}}}],
      call:async()=>({body:'observed source'}),
      observeModelInput:({messages,inherit})=>{
        const token=`host-input-${generationInputs.length}`;
        generationInputs.push({messages:structuredClone(messages),inherit,token});return token;
      }},
    memory:{read:async()=>({text:'current automatic recall'})},
    request:async({messages})=>{
      assert.deepEqual(generationInputs.at(-1).messages,messages,'host token covers the final provider payload');
      generationRequests++;
      return {choices:[{message:generationRequests===1?{tool_calls:[{id:'lookup',function:{name:'lookup',arguments:'{}'}}]}:{content:'finished'}}]};
    }};
  const generated=await runAgent(generationOptions);
  assert.equal(generated.inputToken,'host-input-1');
  assert.deepEqual(generationInputs[0].inherit,[]);
  assert.deepEqual(generationInputs[1].inherit,['host-input-0']);
  assert.match(JSON.stringify(generationInputs[1].messages),/observed source/);
  assert.match(JSON.stringify(generationInputs[1].messages),/current automatic recall/);
  const replayedGeneration=await runAgent(generationOptions);
  assert.equal(replayedGeneration.inputToken,generated.inputToken);
  assert.equal(generationInputs.length,2,'completed replay retains the actual generation token');
  assert.equal(generationRequests,2);

  let effects = 0;
  const effectOptions = { ...options, runId: 'uncertain-effect', toolset: { ...options.toolset, readOnly: false,
    call: async () => { effects += 1; throw new Error('connection lost after action'); } },
    request: async () => ({ choices: [{ message: { tool_calls: [{ id: 'act', function: { name: 'read', arguments: '{}' } }] } }] }) };
  await assert.rejects(runAgent(effectOptions), /connection lost/);
  await assert.rejects(runAgent(effectOptions), /automatic replay is disabled/);
  assert.equal(effects, 1, 'an uncertain external effect cannot be replayed on resume');
  console.log('agent-runtime ok (Discord edges, source attribution, Atom persistence, ACL, edits, deletion, durable response/use retry)');
} finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
