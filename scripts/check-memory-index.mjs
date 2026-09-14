import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'sakana-memory-index-'));
process.env.ARCHIVE_DB_PATH = join(directory, 'archive.sqlite');
process.env.AGENT_RUNTIME_PATH = join(directory, 'runs.sqlite');
process.env.MEMORY_EMBEDDING_DIMENSIONS = '2';
const { db } = await import('../src/archive/db.js');
const { conversationEmbedding, embeddingText } = await import('../src/conversation/embedding.js');
const { attachMemoryDelivery, runAgent } = await import('../src/ai/runtime.js');
const { reserveMemoryCall, finishMemoryCall, memoryCostReport, memoryRates, usageCost, estimateMemoryBackfill } = await import('../src/conversation/cost.js');
try {
  const calls = [];
  const vector = Buffer.alloc(8); vector.writeFloatLE(1,0);
  const embedding = conversationEmbedding({ request: async (texts, options) => {
    calls.push({texts,options}); return { dim: 2, vectors: texts.map(() => vector.toString('base64')) };
  } });
  const signal = new AbortController().signal;
  assert.deepEqual(await embedding.embed(['context'],signal,'query'), [[1,0]]);
  await embedding.embed(['source'],signal,'document');
  assert.deepEqual(calls.map(call => call.options.kind), ['query','passage']);
  assert.equal(embeddingText('{"schema":"discord.memory.v1","batchId":"large opaque hash","text":"条件を保った説明"}'), '条件を保った説明');
  const bad = conversationEmbedding({ request: async () => ({ dim: 3, vectors: [vector.toString('base64')] }) });
  await assert.rejects(bad.embed(['source'],signal), /model space mismatch/);
  const observed = [];
  let round = 0;
  const result = await runAgent({ guildId: 'g', system: 'test', userContent: 'question', runId: 'focus-test', maximumSteps: 2,
    memory: { read: async state => { observed.push(state); return { text: 'bounded memory' }; } },
    toolset: { readOnly: true, definitions: [{ type: 'function', function: { name: 'memory_search', parameters: { type: 'object' } } }],
      call: async () => ({ observed: 'search result' }) },
    request: async ({tools}) => {
      if (round++ === 0) {
        assert.ok(tools.some(tool => tool.function.name === 'memory_focus'));
        return { choices: [{ message: { tool_calls: [{ id: 'focus', type: 'function', function: { name: 'memory_focus',
          arguments: JSON.stringify({ context: '条件を確認する', thought: '例外の資料が必要' }) } }] } }] };
      }
      if (round === 2) return { choices: [{ message: { tool_calls: [{ id: 'search', type: 'function', function: { name: 'memory_search', arguments: '{}' } }] } }] };
      return { choices: [{ message: { content: 'answer', reasoning_content: 'private provider thought' } }] };
    } });
  assert.equal(result.text, 'answer');
  assert.match(observed[0].context, /user: question/);
  assert.equal(observed[0].thought, undefined);
  assert.match(observed[1].context, /user: question/);
  assert.match(observed[1].context, /assistant \[tools: memory_focus\]/);
  assert.match(observed[1].thought, /memory_focus\.context: 条件を確認する/);
  assert.match(observed[1].thought, /memory_focus\.thought: 例外の資料が必要/);
  assert.deepEqual(observed[1].observations, [], 'memory_focus output is a control result, not retrieval evidence');
  assert.match(observed[2].context, /assistant \[tools: memory_search\]/);
  assert.equal(observed[2].thought, undefined, 'focus applies to one provider request only');
  assert.deepEqual(observed[2].observations, ['tool:memory_search: {"observed":"search result"}']);
  assert.ok(!JSON.stringify(observed).includes('private provider thought'));
  assert.ok(!JSON.stringify(observed).includes('REFERENCE MEMORY'), 'automatic memory must not feed itself');

  // A transport failure keeps the one-shot focus in the durable checkpoint,
  // while a successful response consumes it before the next request.
  const retryReads = [];
  let retryRequests = 0;
  const retryMemory = () => ({
    read: async state => { retryReads.push(state); return { text: 'retry memory' }; },
    assertCurrent: async () => {}, recordUse: () => {}
  });
  const retryOptions = { guildId: 'g', runId: 'focus-transport-retry', system: 's', userContent: 'live question',
    reuseCompleted: true, memory: retryMemory(), request: async () => {
      if (retryRequests++ === 0) return { choices: [{ message: { tool_calls: [{ id: 'focus-retry',
        function: { name: 'memory_focus', arguments: '{"context":"retry context","thought":"retry thought"}' } }] } }] };
      throw new Error('provider transport failed');
    } };
  await assert.rejects(runAgent(retryOptions), /provider transport failed/);
  assert.match(retryReads.at(-1).thought, /retry thought/);
  const retryReadCount = retryReads.length;
  const retried = await runAgent({ ...retryOptions, memory: retryMemory(), request: async () => ({ choices: [{ message: { content: 'retry answer' } }] }) });
  assert.equal(retried.text, 'retry answer');
  assert.equal(retryReads.length, retryReadCount + 1, 'a failed request reuses its focus once after restart');
  assert.match(retryReads.at(-1).thought, /retry thought/);
  const noExtraRead = retryReads.length;
  await runAgent({ ...retryOptions, memory: retryMemory(), request: async () => { throw new Error('completed run must not request'); } });
  assert.equal(retryReads.length, noExtraRead, 'successful response clears focus before completion');

  // A saved successful response also clears focus before a failed memory-use
  // acknowledgement. Resuming that response must not read memory again.
  let ackRequestCount = 0;
  const ackReads = [];
  let failAck = true;
  const ackMemory = () => ({
    read: async state => {
      ackReads.push(state);
      return state.thought ? attachMemoryDelivery({ text: 'focused memory' }, ['focused-ref']) : { text: 'no focus memory' };
    },
    assertCurrent: async () => {},
    recordUse: () => { if (failAck) { failAck = false; throw new Error('focus ack failed'); } }
  });
  const ackOptions = { guildId: 'g', runId: 'focus-ack-retry', system: 's', userContent: 'ack question',
    reuseCompleted: true, memory: ackMemory(), request: async () => {
      if (ackRequestCount++ === 0) return { choices: [{ message: { tool_calls: [{ id: 'focus-ack',
        function: { name: 'memory_focus', arguments: '{"context":"ack context","thought":"ack thought"}' } }] } }] };
      return { choices: [{ message: { content: 'ack answer' } }] };
    } };
  await assert.rejects(runAgent(ackOptions), /focus ack failed/);
  const ackReadsAfterFailure = ackReads.length;
  assert.match(ackReads.at(-1).thought, /ack thought/);
  const ackResult = await runAgent({ ...ackOptions, memory: ackMemory(), request: async () => { throw new Error('ack resume must not call provider'); } });
  assert.equal(ackResult.text, 'ack answer');
  assert.equal(ackReads.length, ackReadsAfterFailure, 'ack-only resume does not consume focus a second time');

  const { saveModelRates } = await import('../src/ai/cost.js');
  const saturday = Date.UTC(2026,8,12,2);
  saveModelRates('inclusionai/ling-3.0-flash',{input:0.021,cached:0.0042,output:0.063,request:0});
  assert.equal(memoryRates('inclusionai/ling-3.0-flash').input,0.021);
  assert.equal(usageCost({prompt_tokens:1e6,completion_tokens:1e6,prompt_tokens_details:{cached_tokens:1e6}},memoryRates('inclusionai/ling-3.0-flash')),0.0672);
  assert.equal(usageCost({prompt_tokens:10,completion_tokens:2,prompt_cache_hit_tokens:NaN},memoryRates('inclusionai/ling-3.0-flash')),null);
  assert.equal(usageCost({cost:0.123,prompt_tokens:1,completion_tokens:1},memoryRates('inclusionai/ling-3.0-flash')),0.123);
  db.prepare('INSERT INTO memory_writer_runs VALUES (?,?,?,?,?,?,?,?)').run('foreign','foreign','channel','inclusionai/ling-3.0-flash',20,10,Date.now(),JSON.stringify({prompt_tokens:1000,completion_tokens:200}));
  assert.equal(estimateMemoryBackfill('inclusionai/ling-3.0-flash',100,['g']).available,false,'guild estimates do not read a different guild sample');
  assert.equal(estimateMemoryBackfill('inclusionai/ling-3.0-flash',100,['foreign']).sample.messages,20);
  const request = {model:'inclusionai/ling-3.0-flash',messages:[{role:'user',content:'small sample'}],outputTokens:100};
  process.env.MEMORY_WRITER_DAILY_USD = '0';
  assert.throws(() => reserveMemoryCall(request,saturday), /daily budget reached/);
  process.env.MEMORY_WRITER_DAILY_USD = '1';
  const reservation = reserveMemoryCall(request,saturday);
  assert.equal(memoryCostReport(saturday).unconfirmedCalls,1);
  finishMemoryCall(reservation,{prompt_tokens:1000,completion_tokens:100,cost:0.00003});
  assert.equal(memoryCostReport(saturday).unconfirmedCalls,0);
  assert.equal(memoryCostReport(saturday).calls,1);
  const unknown = reserveMemoryCall(request,saturday); finishMemoryCall(unknown);
  const report = memoryCostReport(saturday);
  assert.equal(report.unconfirmedCalls,1);
  assert.ok(report.unconfirmedReservedUsd>0,'an interrupted paid call must not be counted as free');
  console.log('memory vectors, explicit retrieval focus, token rates and durable cost reservations passed');
} finally { db.close(); rmSync(directory,{recursive:true,force:true}); }
