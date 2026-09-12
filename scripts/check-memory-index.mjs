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
const { runAgent } = await import('../src/ai/runtime.js');
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
    request: async ({tools}) => {
      if (!round++) {
        assert.ok(tools.some(tool => tool.function.name === 'memory_focus'));
        return { choices: [{ message: { tool_calls: [{ id: 'focus', type: 'function', function: { name: 'memory_focus',
          arguments: JSON.stringify({ context: '条件を確認する', thought: '例外の資料が必要' }) } }] } }] };
      }
      return { choices: [{ message: { content: 'answer', reasoning_content: 'private provider thought' } }] };
    } });
  assert.equal(result.text, 'answer');
  assert.equal(observed[1].thought, '例外の資料が必要');
  assert.equal(observed[1].context, '条件を確認する');
  assert.ok(!JSON.stringify(observed).includes('private provider thought'));
  assert.ok(!JSON.stringify(observed).includes('REFERENCE MEMORY'), 'automatic memory must not feed itself');

  const saturday = Date.UTC(2026,8,12,2), monday = Date.UTC(2026,8,14,2);
  assert.equal(memoryRates('deepseek-flash',saturday).input,0.15);
  assert.equal(memoryRates('deepseek-v4-flash',monday).input,0.3);
  assert.equal(usageCost({prompt_tokens:1e6,completion_tokens:1e6,prompt_cache_hit_tokens:1e6},memoryRates('deepseek-flash',saturday)),0.603);
  assert.equal(usageCost({prompt_tokens:10,completion_tokens:2,prompt_cache_hit_tokens:NaN},memoryRates('deepseek-flash',saturday)),null);
  db.prepare('INSERT INTO memory_writer_runs VALUES (?,?,?,?,?,?,?,?)').run('foreign','foreign','channel','deepseek-flash',20,10,Date.now(),JSON.stringify({prompt_tokens:1000,completion_tokens:200}));
  assert.equal(estimateMemoryBackfill('deepseek-flash',100,['g']).available,false,'guild estimates do not read a different guild sample');
  assert.equal(estimateMemoryBackfill('deepseek-flash',100,['foreign']).sample.messages,20);
  const request = {model:'deepseek-flash',messages:[{role:'user',content:'small sample'}],outputTokens:100};
  process.env.MEMORY_WRITER_DAILY_USD = '0';
  assert.throws(() => reserveMemoryCall(request,saturday), /daily budget reached/);
  process.env.MEMORY_WRITER_DAILY_USD = '1';
  const reservation = reserveMemoryCall(request,saturday);
  assert.equal(memoryCostReport(saturday).unconfirmedCalls,1);
  finishMemoryCall(reservation,{prompt_tokens:1000,completion_tokens:100});
  assert.equal(memoryCostReport(saturday).unconfirmedCalls,0);
  assert.equal(memoryCostReport(saturday).calls,1);
  const unknown = reserveMemoryCall(request,saturday); finishMemoryCall(unknown);
  const report = memoryCostReport(saturday);
  assert.equal(report.unconfirmedCalls,1);
  assert.ok(report.unconfirmedReservedUsd>0,'an interrupted paid call must not be counted as free');
  console.log('memory vectors, explicit retrieval focus, token rates and durable cost reservations passed');
} finally { db.close(); rmSync(directory,{recursive:true,force:true}); }
