import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(),'sakana-openrouter-embeddings-'));
process.env.ARCHIVE_DB_PATH = join(directory,'archive.sqlite');
process.env.OPENROUTER_API_KEY = 'test-key';

const { db } = await import('../src/archive/db.js');
const cost = await import('../src/ai/cost.js');
const { providerConfig } = await import('../src/ai/provider.js');
const { requestEmbeddings } = await import('../src/ai/embeddings.js');

const model = 'qwen/qwen3-embedding-8b';
const dimensions = 4096;
const originalFetch = globalThis.fetch;
const originalBaseUrl = providerConfig.baseUrl;
providerConfig.baseUrl = 'https://openrouter.test/api/v1';

const paidEndpoints = [
  { provider_name:'Nebius',pricing:{ prompt:'0.00000001',completion:'0' } },
  { provider_name:'DeepInfra',pricing:{ prompt:'0.00000001',completion:'0' } },
  { provider_name:'SiliconFlow',pricing:{ prompt:'0.00000004',completion:'0' } }
];

function response(data, status = 200) {
  return { ok:status >= 200 && status < 300,status,headers:{ get:() => null },json:async () => data };
}

function vector(marker = 0, length = dimensions) {
  const value = new Array(length).fill(0);
  if (length) value[0] = marker;
  return value;
}

function validData(count = 1, options = {}) {
  const order = options.order ?? Array.from({ length:count },(_,index) => index);
  return {
    data:order.map(index => ({ index,object:'embedding',embedding:vector(index+1) })),
    ...(options.model === false ? {} : { model:options.model ?? model }),
    object:'list',usage:options.usage ?? { prompt_tokens:count,total_tokens:count }
  };
}

try {
  // The live endpoint prices are fixtures here: request code must refresh them,
  // reserve conservatively, and send the maximum as a router-side price bound.
  cost.ensureModelBudget({ id:'ordered',guildId:'g',limitUsd:30 });
  const events = [];
  const signal = new AbortController().signal;
  let sentBody;
  globalThis.fetch = async (url, init) => {
    assert.ok(init.signal instanceof AbortSignal,'pricing and POST requests are timeout bounded');
    if (url.endsWith('/endpoints')) {
      events.push('pricing');
      return response({ data:{ id:model,endpoints:paidEndpoints } });
    }
    events.push('post');
    assert.equal(url,'https://openrouter.test/api/v1/embeddings');
    assert.notEqual(init.signal,signal,'caller abort and the 120-second timeout are composed');
    sentBody = JSON.parse(init.body);
    return response(validData(2,{ order:[1,0],usage:{ prompt_tokens:4,total_tokens:4,cost:0.000001 } }));
  };
  const ordered = await requestEmbeddings({ input:['first document','second document'],guildId:'g',
    budgetId:'ordered',runId:'embedding-run',signal,beforeSend:() => { events.push('beforeSend'); } });
  assert.deepEqual(events,['pricing','beforeSend','post']);
  assert.deepEqual(sentBody,{
    model,input:['first document','second document'],dimensions,encoding_format:'float',
    provider:{ sort:'price',allow_fallbacks:true,
      max_price:{ prompt:0.04,completion:0,request:0 } }
  });
  assert.equal(sentBody.models,undefined,'embedding transport never sends model fallbacks');
  assert.equal(ordered.model,model);
  assert.deepEqual(ordered.usage,{ prompt_tokens:4,total_tokens:4,cost:0.000001 });
  assert.deepEqual(ordered.vectors.map(value => value[0]),[1,2],
    'indexed provider output is restored to input order');
  assert.ok(ordered.vectors.every(value => value.length === dimensions));
  const orderedCall = db.prepare(`SELECT guild_id,role,run_id,model,status
    FROM ai_model_calls WHERE budget_id='ordered'`).get();
  assert.deepEqual(orderedCall,{ guild_id:'g',role:'embedding',run_id:'embedding-run',model,status:'reported' });
  assert.equal(cost.modelBudgetStatus('ordered').spentUsd,0.000001);

  // Usage without an authoritative bill remains reserved even when vectors are
  // valid. A later budget admission cannot treat token counts as actual cost.
  cost.ensureModelBudget({ id:'usage-without-cost',guildId:'g',limitUsd:30 });
  globalThis.fetch = async (_url, init) => {
    assert.ok(init.signal instanceof AbortSignal,'a standalone request receives the default timeout');
    return response(validData(1));
  };
  const withoutCost = await requestEmbeddings({ input:['bill is absent'],guildId:'g',
    budgetId:'usage-without-cost' });
  assert.equal(withoutCost.vectors[0].length,dimensions);
  const withoutCostStatus = cost.modelBudgetStatus('usage-without-cost');
  assert.equal(withoutCostStatus.unknownCalls,1);
  assert.ok(withoutCostStatus.reservedUsd > 0);

  // A paid success with malformed vectors still records a reported bill.
  cost.ensureModelBudget({ id:'bad-dimension',guildId:'g',limitUsd:30 });
  globalThis.fetch = async () => response({ ...validData(1,{ usage:{ cost:0.002 } }),
    data:[{ index:0,embedding:vector(1,dimensions-1) }] });
  await assert.rejects(requestEmbeddings({ input:['wrong dimension'],guildId:'g',budgetId:'bad-dimension' }),
    error => error.code === 'EMBEDDING_RESPONSE_INVALID');
  const badDimension = cost.modelBudgetStatus('bad-dimension');
  assert.equal(badDimension.spentUsd,0.002);
  assert.equal(badDimension.unknownCalls,0);

  const indexCases = [
    { id:'duplicate-index',data:[{ index:0,embedding:vector(1) },{ index:0,embedding:vector(2) }] },
    { id:'range-index',data:[{ index:0,embedding:vector(1) },{ index:2,embedding:vector(2) }] },
    { id:'missing-index',data:[{ index:0,embedding:vector(1) }] }
  ];
  for (const fixture of indexCases) {
    cost.ensureModelBudget({ id:fixture.id,guildId:'g',limitUsd:30 });
    globalThis.fetch = async () => response({ data:fixture.data,model,usage:{ prompt_tokens:2,total_tokens:2 } });
    await assert.rejects(requestEmbeddings({ input:['one','two'],guildId:'g',budgetId:fixture.id }),
      error => error.code === 'EMBEDDING_RESPONSE_INVALID');
    assert.equal(cost.modelBudgetStatus(fixture.id).unknownCalls,1,
      'malformed output with no bill keeps its reservation');
  }

  cost.ensureModelBudget({ id:'model-mismatch',guildId:'g',limitUsd:30 });
  globalThis.fetch = async () => response(validData(1,{ model:'other/embedding-model',usage:{ cost:0.003 } }));
  await assert.rejects(requestEmbeddings({ input:['exact model'],guildId:'g',budgetId:'model-mismatch' }),
    error => error.code === 'EMBEDDING_RESPONSE_INVALID' && error.expectedModel === model);
  assert.equal(cost.modelBudgetStatus('model-mismatch').spentUsd,0.003);

  cost.ensureModelBudget({ id:'model-omitted',guildId:'g',limitUsd:30 });
  globalThis.fetch = async () => response(validData(1,{ model:false }));
  await assert.rejects(requestEmbeddings({ input:['model identity required'],guildId:'g',budgetId:'model-omitted' }),
    error => error.code === 'EMBEDDING_RESPONSE_INVALID' && error.expectedModel === model
      && error.responseModel === undefined);
  assert.equal(cost.modelBudgetStatus('model-omitted').unknownCalls,1);

  // A known request rejection releases the reservation; an ambiguous transport
  // failure does not. There is no internal retry in either case.
  cost.ensureModelBudget({ id:'known-rejection',guildId:'g',limitUsd:30 });
  let rejectedPosts = 0;
  globalThis.fetch = async () => { rejectedPosts += 1; return response({ error:{ code:400 } },400); };
  await assert.rejects(requestEmbeddings({ input:['rejected'],guildId:'g',budgetId:'known-rejection' }),
    error => error.status === 400);
  assert.equal(rejectedPosts,1);
  assert.deepEqual({ unknown:cost.modelBudgetStatus('known-rejection').unknownCalls,
    reserved:cost.modelBudgetStatus('known-rejection').reservedUsd },{ unknown:0,reserved:0 });

  cost.ensureModelBudget({ id:'transport-unknown',guildId:'g',limitUsd:30 });
  let transportPosts = 0;
  globalThis.fetch = async () => { transportPosts += 1; throw new TypeError('connection lost'); };
  await assert.rejects(requestEmbeddings({ input:['ambiguous'],guildId:'g',budgetId:'transport-unknown' }),
    error => error.status === 0 && error.retryable);
  assert.equal(transportPosts,1);
  assert.equal(cost.modelBudgetStatus('transport-unknown').unknownCalls,1);
  assert.ok(cost.modelBudgetStatus('transport-unknown').reservedUsd > 0);

  // Abort, zero cap, and guild mismatch all stop before the paid POST. A
  // beforeSend cancellation occurs after pricing/reservation but settles zero.
  cost.ensureModelBudget({ id:'already-aborted',guildId:'g',limitUsd:30 });
  const aborted = new AbortController();
  aborted.abort(new DOMException('cancelled','AbortError'));
  let guardedPosts = 0;
  globalThis.fetch = async () => { guardedPosts += 1; return response(validData(1)); };
  await assert.rejects(requestEmbeddings({ input:['cancelled'],guildId:'g',budgetId:'already-aborted',
    signal:aborted.signal }),error => error.name === 'AbortError');
  assert.equal(guardedPosts,0);
  assert.equal(cost.modelBudgetStatus('already-aborted').calls,0);

  cost.ensureModelBudget({ id:'before-send-abort',guildId:'g',limitUsd:30 });
  const lateAbort = new AbortController();
  await assert.rejects(requestEmbeddings({ input:['cancel before post'],guildId:'g',
    budgetId:'before-send-abort',signal:lateAbort.signal,beforeSend:() => lateAbort.abort() }),
  error => error.name === 'AbortError');
  assert.equal(guardedPosts,0);
  const beforeSendAbort = cost.modelBudgetStatus('before-send-abort');
  assert.equal(beforeSendAbort.calls,1);
  assert.equal(beforeSendAbort.unknownCalls,0);
  assert.equal(beforeSendAbort.reservedUsd,0);

  cost.ensureModelBudget({ id:'zero-cap',guildId:'g',limitUsd:0 });
  let zeroBeforeSend = 0;
  await assert.rejects(requestEmbeddings({ input:['must not send'],guildId:'g',budgetId:'zero-cap',
    beforeSend:() => { zeroBeforeSend += 1; } }),error => error.code === 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(guardedPosts,0);
  assert.equal(zeroBeforeSend,0);
  assert.equal(cost.modelBudgetStatus('zero-cap').calls,0);

  cost.ensureModelBudget({ id:'guild-bound',guildId:'g',limitUsd:30 });
  await assert.rejects(requestEmbeddings({ input:['wrong guild'],guildId:'other',budgetId:'guild-bound' }),
    error => error.code === 'MODEL_BUDGET_CONFLICT');
  assert.equal(guardedPosts,0);
  assert.equal(cost.modelBudgetStatus('guild-bound').calls,0);

  console.log('openrouter embeddings: exact wire format, ordering, validation, abort and conservative accounting passed');
} finally {
  globalThis.fetch = originalFetch;
  providerConfig.baseUrl = originalBaseUrl;
  db.close();
  rmSync(directory,{ recursive:true,force:true });
}
