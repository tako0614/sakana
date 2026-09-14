import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const mode = process.argv[2];

async function childMode() {
  process.env.ARCHIVE_DB_PATH = process.argv[3];
  const budgetId = process.argv[4];
  // archive/db.js refreshes several triggers during module initialization.
  // Serialize only that unrelated migration so the independent handles reach
  // the concurrent budget transaction instead of racing DROP/CREATE TRIGGER.
  const schemaLock = `${process.env.ARCHIVE_DB_PATH}.schema.lock`;
  let schemaHandle;
  while (schemaHandle === undefined) {
    try { schemaHandle = openSync(schemaLock,'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve,5));
    }
  }
  let db, cost;
  try {
    ({ db } = await import('../src/archive/db.js'));
    cost = await import('../src/ai/cost.js');
  } finally {
    closeSync(schemaHandle);
    rmSync(schemaLock,{ force:true });
  }
  try {
    if (mode === '--reserve-child') {
      const reservation = cost.reserveModelCall({ model:'test/concurrent',messages:[{ role:'user',content:'x' }],
        tools:null,outputTokens:0,guildId:'g',role:'dream',runId:process.pid.toString(),budgetId });
      process.stdout.write(JSON.stringify({ ok:true,id:reservation.id,budgetId:reservation.budgetId }));
    } else if (mode === '--status-child') {
      process.stdout.write(JSON.stringify(cost.modelBudgetStatus(budgetId)));
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok:false,code:error.code,message:error.message }));
  } finally { db.close(); }
}

function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,[fileURLToPath(import.meta.url),...args],{
      cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data',chunk => { stdout += chunk; });
    child.stderr.on('data',chunk => { stderr += chunk; });
    child.on('error',reject);
    child.on('close',code => {
      if (code !== 0) reject(new Error(`child exited ${code}: ${stderr}`));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`invalid child output: ${stdout}\n${stderr}`)); }
      }
    });
  });
}

function jsonResponse(data, status = 200, values = {}) {
  const headers = Object.fromEntries(Object.entries(values).map(([key,value]) => [key.toLowerCase(),String(value)]));
  return { ok:status >= 200 && status < 300,status,headers:{ get:name => headers[name.toLowerCase()] ?? null },
    json:async () => data };
}

const freeEndpoint = { pricing:{ prompt:'0',completion:'0',input_cache_read:'0',input_cache_write:'0',request:'0' },
  supported_parameters:['max_tokens','tools','tool_choice','response_format','reasoning','temperature'] };
const paidEndpoints = [
  { provider_name:'Novita',pricing:{ prompt:'0.0000001',completion:'0.0000002',input_cache_read:'0.00000002' },
    supported_parameters:['max_tokens','tools','tool_choice'] },
  { provider_name:'DeepInfra',pricing:{ prompt:'0.0000002',completion:'0.0000004',input_cache_read:'0.00000004' },
    supported_parameters:['max_tokens','tools','tool_choice','response_format'] }
];
const freeModel = 'inclusionai/ling-3.0-flash:free';
const paidModel = 'inclusionai/ling-3.0-flash';

async function main() {
  const directory = mkdtempSync(join(tmpdir(),'sakana-dream-cost-'));
  process.env.ARCHIVE_DB_PATH = join(directory,'archive.sqlite');
  process.env.AGENT_RUNTIME_PATH = join(directory,'runs.sqlite');
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.MEMORY_WRITER_DAILY_USD = '0';
  const { db } = await import('../src/archive/db.js');
  // Reproduce the pre-counter schema before cost.js initializes. Its one-time
  // migration must derive cumulative values from the immutable call ledger.
  db.exec(`CREATE TABLE ai_model_calls (
      id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,guild_id TEXT,role TEXT NOT NULL,run_id TEXT,
      model TEXT NOT NULL,provider TEXT,generation_id TEXT,status TEXT NOT NULL,
      reserved_usd REAL NOT NULL,rates TEXT NOT NULL,usage TEXT,reported_usd REAL,
      estimated_usd REAL,budget_id TEXT
    );
    CREATE TABLE ai_model_budgets (
      id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,limit_usd REAL NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,pause_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    );
    INSERT INTO ai_model_budgets VALUES('legacy-budget','g',10,0,NULL,1,1);
    INSERT INTO ai_model_calls VALUES
      ('legacy-reported',1,'g','dream',NULL,'legacy/model',NULL,NULL,'reported',0.5,'{}',NULL,0.2,NULL,'legacy-budget'),
      ('legacy-estimated',2,'g','dream',NULL,'legacy/model',NULL,NULL,'estimated',0.3,'{}',NULL,NULL,0.25,'legacy-budget'),
      ('legacy-unknown',3,'g','dream',NULL,'legacy/model',NULL,NULL,'unknown',0.4,'{}',NULL,NULL,NULL,'legacy-budget'),
      ('legacy-free',4,'g','dream',NULL,'legacy/model',NULL,NULL,'no_charge',0.1,'{}',NULL,0,NULL,'legacy-budget');`);
  const cost = await import('../src/ai/cost.js');
  const providerAbsent = await import('../src/ai/provider.js');
  const { attachMemoryDelivery, runAgent } = await import('../src/ai/runtime.js');
  const originalFetch = globalThis.fetch;
  const close = (left, right) => Math.abs(Number(left)-Number(right)) < 1e-12;
  const assertBudgetAudit = (id) => {
    const cached = db.prepare(`SELECT calls,reported_usd,estimated_usd,reserved_usd,unknown_calls
      FROM ai_model_budgets WHERE id=?`).get(id);
    const audit = db.prepare(`SELECT count(*) calls,coalesce(sum(reported_usd),0) reported_usd,
      coalesce(sum(estimated_usd),0) estimated_usd,
      coalesce(sum(CASE WHEN reported_usd IS NULL AND estimated_usd IS NULL
        THEN reserved_usd ELSE 0 END),0) reserved_usd,
      coalesce(sum(reported_usd IS NULL AND estimated_usd IS NULL),0) unknown_calls
      FROM ai_model_calls WHERE budget_id=?`).get(id);
    assert.equal(cached.calls,audit.calls,`${id} call counter drifted from ledger`);
    assert.equal(cached.unknown_calls,audit.unknown_calls,`${id} unknown counter drifted from ledger`);
    for (const field of ['reported_usd','estimated_usd','reserved_usd']) {
      assert.ok(close(cached[field],audit[field]),`${id} ${field} drifted from ledger`);
    }
  };
  try {
    const migrated = cost.modelBudgetStatus('legacy-budget');
    assert.equal(migrated.calls,4);
    assert.ok(close(migrated.reportedUsd,0.2));
    assert.ok(close(migrated.estimatedUsd,0.25));
    assert.ok(close(migrated.reservedUsd,0.4));
    assert.equal(migrated.unknownCalls,1);
    assert.equal(db.prepare('SELECT totals_version FROM ai_model_budgets WHERE id=?')
      .get('legacy-budget').totals_version,1);
    assertBudgetAudit('legacy-budget');

    assert.throws(() => cost.modelBudgetStatus('missing'), error => error.code === 'MODEL_BUDGET_NOT_FOUND');
    assert.equal(cost.ensureModelBudget({ id:'immutable',guildId:'g' }).limitUsd,30);
    assert.equal(cost.ensureModelBudget({ id:'immutable',guildId:'g',limitUsd:30 }).calls,0);
    assert.throws(() => cost.ensureModelBudget({ id:'immutable',guildId:'g',limitUsd:31 }),
      error => error.code === 'MODEL_BUDGET_CONFLICT');
    assert.equal(cost.setModelBudgetPaused('immutable',true).pauseReason,'manual');
    cost.saveModelRates('test/manual',{ input:0.1,output:0.1,cached:0.1,request:0 });
    assert.throws(() => cost.reserveModelCall({ model:'test/manual',messages:[],tools:null,outputTokens:1,
      guildId:'g',budgetId:'immutable' }),error => error.code === 'MODEL_BUDGET_PAUSED');
    assert.equal(cost.setModelBudgetPaused('immutable',false).paused,false);

    // A reservation may consume the exact remaining amount without pausing the
    // request that just acquired it; a final authority check can still run
    // immediately before send. Settlement applies the pause if cost remains.
    const exactMessages = [{ role:'user',content:'exact ceiling' }];
    const exactLimit = Math.ceil(((Buffer.byteLength(JSON.stringify({ messages:exactMessages,tools:null })) + 4096)
      * 0.1 / 1e6) * 1e12) / 1e12;
    cost.ensureModelBudget({ id:'exact-ceiling',guildId:'g',limitUsd:exactLimit });
    const exactReservation = cost.reserveModelCall({ model:'test/manual',messages:exactMessages,tools:null,
      outputTokens:0,guildId:'g',budgetId:'exact-ceiling' });
    const atCeiling = cost.modelBudgetStatus('exact-ceiling');
    assert.equal(atCeiling.remainingUsd,0);
    assert.equal(atCeiling.paused,false);
    cost.finishModelCall(exactReservation,null,{ noCharge:true,status:'cancelled' });
    assertBudgetAudit('exact-ceiling');

    // Missing paid pricing fails closed before reserving or sending anything.
    const providerMissing = await import(`../src/ai/provider.js?missing=${Date.now()}`);
    cost.ensureModelBudget({ id:'missing-price',guildId:'g',limitUsd:30 });
    let missingFetches = 0;
    globalThis.fetch = async () => { missingFetches += 1; return jsonResponse({ data:{ endpoints:[] } }); };
    await assert.rejects(providerMissing.requestModel({ model:'test/missing-price',messages:[],maxOutputTokens:20,
      guildId:'g',budgetId:'missing-price' }),error => error.code === 'MODEL_PRICE_UNAVAILABLE');
    assert.equal(missingFetches,1);
    assert.equal(cost.modelBudgetStatus('missing-price').calls,0);

    // The currently absent exact free route is skipped before a completion POST;
    // the explicit same-model paid route uses its verified maximum price.
    cost.ensureModelBudget({ id:'absent-free',guildId:'g',limitUsd:30 });
    const absentPosts = [], absentConsumes = [];
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/endpoints')) {
        if (decodeURIComponent(url).includes(`${freeModel}/endpoints`)) return jsonResponse({ data:{ endpoints:[] } });
        if (decodeURIComponent(url).includes(`${paidModel}/endpoints`)) return jsonResponse({ data:{ endpoints:paidEndpoints } });
      }
      const body = JSON.parse(init.body); absentPosts.push(body);
      return jsonResponse({ id:'paid-absent',provider:'DeepInfra',usage:{ prompt_tokens:5,completion_tokens:2,cost:0.01 },
        choices:[{ message:{ content:'paid answer' } }] });
    };
    const absent = await providerAbsent.requestModel({ model:freeModel,fallbackModels:[paidModel],messages:[{ role:'user',content:'u' }],
      maxOutputTokens:20,guildId:'g',role:'writer',budgetId:'absent-free',
      consumeRequest:({ model }) => { absentConsumes.push(model); } });
    assert.equal(absent.choices[0].message.content,'paid answer');
    assert.deepEqual(absentConsumes,[paidModel],'an absent free endpoint is not a completion attempt');
    assert.deepEqual(absentPosts.map(body => body.model),[paidModel]);
    assert.ok(Math.abs(absentPosts[0].provider.max_price.prompt-0.2) < 1e-12);
    assert.ok(Math.abs(absentPosts[0].provider.max_price.completion-0.4) < 1e-12);
    assert.equal(absentPosts[0].provider.max_price.request,0);
    assert.equal(cost.modelBudgetStatus('absent-free').spentUsd,0.01,
      'a job budget bypasses the writer daily cap and records actual cost');

    // Zero is trusted only after an exact :free route exposes all-zero endpoint pricing.
    const providerZero = await import(`../src/ai/provider.js?zero=${Date.now()}`);
    cost.ensureModelBudget({ id:'verified-free',guildId:'g',limitUsd:30 });
    const freeBodies = [];
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/endpoints')) return jsonResponse({ data:{ endpoints:[freeEndpoint] } });
      const body = JSON.parse(init.body); freeBodies.push(body);
      return jsonResponse({ id:'free-success',provider:'FreeFixture',choices:[{ message:{ content:'free answer' } }] });
    };
    await providerZero.requestModel({ model:freeModel,messages:[{ role:'user',content:'u' }],maxOutputTokens:20,
      guildId:'g',role:'dream',budgetId:'verified-free' });
    assert.deepEqual(freeBodies[0].provider.max_price,{ prompt:0,completion:0,request:0 });
    const freeStatus = cost.modelBudgetStatus('verified-free');
    assert.equal(freeStatus.committedUsd,0);
    assert.equal(freeStatus.unknownCalls,0,'verified free success is confirmed zero rather than an unknown reservation');
    await assert.rejects(providerZero.requestModel({ model:'openrouter/free',messages:[] }),
      error => error.code === 'MODEL_ROUTE_INVALID');

    // A real free completion 429 consumes one attempt, records confirmed zero,
    // caches Retry-After, and moves once to the paid Ling route.
    const providerLimited = await import(`../src/ai/provider.js?limited=${Date.now()}`);
    cost.ensureModelBudget({ id:'limited-free',guildId:'g',limitUsd:30 });
    const limitedPosts = [], limitedConsumes = [];
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/endpoints')) {
        if (decodeURIComponent(url).includes(`${freeModel}/endpoints`)) return jsonResponse({ data:{ endpoints:[freeEndpoint] } });
        return jsonResponse({ data:{ endpoints:paidEndpoints } });
      }
      const body = JSON.parse(init.body); limitedPosts.push(body.model);
      if (body.model === freeModel) return jsonResponse({ error:{ code:429 } },429,{ 'Retry-After':'120' });
      return jsonResponse({ id:`paid-${limitedPosts.length}`,provider:'DeepInfra',usage:{ cost:0.02,prompt_tokens:5,completion_tokens:2 },
        choices:[{ message:{ content:'fallback answer' } }] });
    };
    const limitedInput = { model:freeModel,fallbackModels:[paidModel],messages:[{ role:'user',content:'u' }],maxOutputTokens:20,
      guildId:'g',role:'dream',budgetId:'limited-free',consumeRequest:({ model }) => { limitedConsumes.push(model); } };
    await providerLimited.requestModel(limitedInput);
    await providerLimited.requestModel(limitedInput);
    assert.deepEqual(limitedPosts,[freeModel,paidModel,paidModel],
      'the cached free cooldown prevents another limited-route attempt');
    assert.deepEqual(limitedConsumes,limitedPosts);
    const limitedStatus = cost.modelBudgetStatus('limited-free');
    assert.equal(limitedStatus.calls,3);
    assert.equal(limitedStatus.unknownCalls,0,'429 is a known no-charge response');
    assert.equal(limitedStatus.spentUsd,0.04);

    // The alternative rate-limit reset header is parsed as an absolute retry time.
    const providerReset = await import(`../src/ai/provider.js?reset=${Date.now()}`);
    cost.ensureModelBudget({ id:'reset-header',guildId:'g',limitUsd:30 });
    const resetAt = Date.now()+120000;
    globalThis.fetch = async (url) => {
      if (url.endsWith('/endpoints')) return jsonResponse({ data:{ endpoints:[freeEndpoint] } });
      return jsonResponse({ error:{ code:429 } },429,{ 'X-RateLimit-Reset':String(Math.floor(resetAt/1000)) });
    };
    await assert.rejects(providerReset.requestModel({ model:'test/reset:free',messages:[],maxOutputTokens:20,
      guildId:'g',budgetId:'reset-header' }),error => error.status === 429 && error.retryAt >= resetAt-1000);
    assert.equal(cost.modelBudgetStatus('reset-header').unknownCalls,0);

    // Account/auth limits are terminal and never bypassed through a fallback.
    const providerAuth = await import(`../src/ai/provider.js?auth=${Date.now()}`);
    cost.ensureModelBudget({ id:'auth-stop',guildId:'g',limitUsd:30 });
    const authPosts = [];
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/endpoints')) return jsonResponse({ data:{ endpoints:paidEndpoints } });
      authPosts.push(JSON.parse(init.body).model);
      return jsonResponse({ error:{ code:402 } },402);
    };
    await assert.rejects(providerAuth.requestModel({ model:'test/account-limited',fallbackModels:[paidModel],messages:[],
      maxOutputTokens:20,guildId:'g',budgetId:'auth-stop',retries:3 }),
      error => error.status === 402 && error.retryable === false);
    assert.deepEqual(authPosts,['test/account-limited']);
    assert.equal(cost.modelBudgetStatus('auth-stop').unknownCalls,0);

    // A sent request whose response is lost remains conservatively reserved.
    const providerAmbiguous = await import(`../src/ai/provider.js?ambiguous=${Date.now()}`);
    cost.ensureModelBudget({ id:'ambiguous',guildId:'g',limitUsd:30 });
    globalThis.fetch = async (url) => {
      if (url.endsWith('/endpoints')) return jsonResponse({ data:{ endpoints:paidEndpoints } });
      throw new TypeError('connection lost after send');
    };
    await assert.rejects(providerAmbiguous.requestModel({ model:'test/ambiguous',messages:[],maxOutputTokens:20,
      guildId:'g',budgetId:'ambiguous' }),error => error.status === 0 && error.retryable);
    assert.equal(cost.modelBudgetStatus('ambiguous').unknownCalls,1);
    assert.ok(cost.modelBudgetStatus('ambiguous').reservedUsd > 0);
    assertBudgetAudit('ambiguous');

    // Two independent SQLite handles cannot both reserve beyond one total cap.
    cost.saveModelRates('test/concurrent',{ input:100,output:0,cached:100,request:0 });
    cost.ensureModelBudget({ id:'concurrent',guildId:'g',limitUsd:0.7 });
    const children = await Promise.all([
      runChild(['--reserve-child',process.env.ARCHIVE_DB_PATH,'concurrent']),
      runChild(['--reserve-child',process.env.ARCHIVE_DB_PATH,'concurrent'])
    ]);
    assert.equal(children.filter(result => result.ok).length,1);
    assert.deepEqual(children.filter(result => !result.ok).map(result => result.code),['MODEL_BUDGET_EXHAUSTED']);
    const concurrent = cost.modelBudgetStatus('concurrent');
    assert.equal(concurrent.calls,1);
    assert.equal(concurrent.paused,true);
    assert.equal(concurrent.pauseReason,'exhausted');
    assert.ok(concurrent.reservedUsd > 0 && concurrent.committedUsd === concurrent.reservedUsd);
    const restarted = await runChild(['--status-child',process.env.ARCHIVE_DB_PATH,'concurrent']);
    assert.deepEqual(restarted,concurrent,'budget totals and pause survive a fresh process');
    assertBudgetAudit('concurrent');

    // Reported cost and ambiguous reservations are both retained across dates.
    cost.saveModelRates('test/all-time',{ input:100,output:0,cached:100,request:0 });
    cost.ensureModelBudget({ id:'all-time',guildId:'g',limitUsd:0.7 });
    const oldReservation = cost.reserveModelCall({ model:'test/all-time',messages:[],tools:null,outputTokens:0,
      guildId:'g',budgetId:'all-time' },Date.UTC(2020,0,1));
    assert.throws(() => cost.reserveModelCall({ model:'test/all-time',messages:[],tools:null,outputTokens:0,
      guildId:'g',budgetId:'all-time' },Date.UTC(2030,0,1)),error => error.code === 'MODEL_BUDGET_EXHAUSTED');
    cost.finishModelCall(oldReservation,{ usage:{ cost:0.2,prompt_tokens:1,completion_tokens:0 } });
    cost.finishModelCall(oldReservation,{ usage:{ cost:0.6,prompt_tokens:1,completion_tokens:0 } });
    const allTime = cost.modelBudgetStatus('all-time');
    assert.equal(allTime.spentUsd,0.2);
    assert.equal(allTime.reservedUsd,0);
    assertBudgetAudit('all-time');

    // The durable runtime persists every wrapper-declared HTTP attempt and
    // replays a saved accepted response without consuming or charging another.
    let responseCalls = 0, failAck = true;
    const replayMemory = () => ({
      read:async () => attachMemoryDelivery({ text:'remembered evidence' },['atom:1']),
      assertCurrent:async () => {},
      recordUse:() => { if (failAck) { failAck = false; throw new Error('simulated use acknowledgement crash'); } }
    });
    const replayOptions = { guildId:'g',runId:'dream-replay',budgetId:'runtime-budget',maximumRequests:1,
      system:'s',userContent:'u',memory:replayMemory(),request:async ({ budgetId,consumeRequest }) => {
        assert.equal(budgetId,'runtime-budget');
        consumeRequest({ model:paidModel }); responseCalls += 1;
        return { usage:{ prompt_tokens:3,completion_tokens:1 },choices:[{ message:{ content:'saved answer' } }] };
      } };
    await assert.rejects(runAgent(replayOptions),/acknowledgement crash/);
    const replayed = await runAgent({ ...replayOptions,memory:replayMemory(),request:async () => {
      throw new Error('saved response must not call the provider');
    } });
    assert.equal(replayed.text,'saved answer');
    assert.equal(replayed.requests,1);
    assert.equal(replayed.invocation.rounds,0);
    assert.equal(responseCalls,1);

    // Validation retries share the same durable request ceiling, including a
    // later invocation; tool maximumSteps remains a separate limit.
    let validationPosts = 0;
    const validationOptions = { guildId:'g',runId:'dream-validation-ceiling',system:'s',userContent:'u',maximumRequests:2,
      maximumSteps:99,validate:() => { throw new Error('invalid response'); },request:async ({ consumeRequest }) => {
        consumeRequest({ model:paidModel }); validationPosts += 1;
        return { choices:[{ message:{ content:'invalid' } }] };
      } };
    await assert.rejects(runAgent(validationOptions),error => error.code === 'AGENT_REQUEST_LIMIT');
    assert.equal(validationPosts,2);
    await assert.rejects(runAgent(validationOptions),error => error.code === 'AGENT_REQUEST_LIMIT');
    assert.equal(validationPosts,2,'restart cannot reset the model request ceiling');

    let finalRequests = 0;
    const separate = await runAgent({ guildId:'g',runId:'separate-limits',system:'s',userContent:'u',
      maximumSteps:0,maximumRequests:1,request:async ({ consumeRequest }) => {
        consumeRequest({ model:paidModel }); finalRequests += 1;
        return { choices:[{ message:{ content:'final despite zero tools' } }] };
      } });
    assert.equal(separate.text,'final despite zero tools');
    assert.equal(finalRequests,1);

    console.log('dream cost/provider/runtime: lifetime cap, verified free fallback, cooldown, accounting and durable request ceiling passed');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(directory,{ recursive:true,force:true });
  }
}

if (mode === '--reserve-child' || mode === '--status-child') await childMode();
else await main();
