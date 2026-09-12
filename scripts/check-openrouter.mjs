import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'sakana-openrouter-'));
process.env.ARCHIVE_DB_PATH=join(dir,'archive.sqlite');
process.env.AGENT_RUNTIME_PATH=join(dir,'runs.sqlite');
process.env.OPENROUTER_API_KEY='test-key';
process.env.MEMORY_WRITER_DAILY_USD='1';
const {db}=await import('../src/archive/db.js');
const previousDay=Date.now()-2*86400000;
db.exec(`CREATE TABLE memory_writer_calls (id TEXT PRIMARY KEY,started_at INTEGER,model TEXT,status TEXT,reserved_usd REAL,rates TEXT,usage TEXT,estimated_usd REAL)`);
db.prepare('INSERT INTO memory_writer_calls VALUES(?,?,?,?,?,?,?,?)').run('legacy',previousDay,'deepseek-flash','reported',0.2,'{}','{}',0.1);
const {requestModel,providerConfig}=await import('../src/ai/provider.js');
const {modelCostReport}=await import('../src/ai/cost.js');
const {runAgent}=await import('../src/ai/runtime.js');
const original=globalThis.fetch;
const requests=[];
let mode='tools', effects=0;
globalThis.fetch=async (url,init)=>{
  if(url.endsWith('/endpoints')) return {ok:true,json:async()=>({data:{endpoints:[{pricing:{prompt:'0.00000004',completion:'0.00000008',input_cache_read:'0.000000008'}}]}})};
  assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
  const body=JSON.parse(init.body);requests.push(body);
  assert.equal(body.provider.sort,'price');assert.equal(body.provider.require_parameters,true);
  assert.equal(body.thinking,undefined);assert.equal(body.reasoning_effort,undefined);
  if(mode==='outage')return {ok:false,status:503};
  const done=body.messages.some(m=>m.role==='tool');
  return {ok:true,json:async()=>({id:'generation-'+requests.length,provider:'cheap-fixture',model:body.model,
    usage:{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:70},cost:0.00001},
    choices:[{message:mode==='invalid'?{content:'invalid JSON'}:mode==='empty'?{}:done||mode==='answer'?{content:'finished'}:
      {content:'',reasoning_details:[{type:'reasoning.text',text:'protocol continuation'}],tool_calls:[{id:'one',type:'function',function:{name:'read',arguments:'{}'}}]}}]})};
};
try{
  const migrated=modelCostReport({now:previousDay});
  assert.equal(migrated.reportedUsd,0);assert.equal(migrated.estimatedUsd,0.1);
  assert.equal(modelCostReport({now:previousDay,guildIds:[]}).calls,0);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='memory_writer_calls'").get(),undefined);
  const result=await runAgent({guildId:'g',runId:'protocol',system:'s',userContent:'u',maximumSteps:3,
    request:input=>requestModel({...input,model:providerConfig.model,maxOutputTokens:100,role:'chat'}),
    toolset:{readOnly:true,definitions:[{type:'function',function:{name:'read',parameters:{type:'object'}}}],call:async()=>{effects++;return 'evidence';}}});
  assert.equal(result.text,'finished');assert.equal(effects,1);
  assert.equal(result.usage.prompt_cache_hit_tokens,140);
  assert.deepEqual(requests[1].messages.find(m=>m.role==='assistant').reasoning_details,[{type:'reasoning.text',text:'protocol continuation'}]);
  mode='answer';
  await requestModel({model:providerConfig.writerModel,messages:[{role:'user',content:'write'}],maxOutputTokens:100,guildId:'g',role:'writer',jsonOnly:true,reasoning:{enabled:false}});
  const last=requests.at(-1);
  assert.deepEqual(last.provider.max_price,{prompt:0.04,completion:0.08,request:0});
  assert.equal(last.response_format.type,'json_object');
  assert.equal(modelCostReport({guildId:'g'}).calls,3);
  assert.equal(modelCostReport({guildId:'other'}).calls,0);
  const before=requests.length;process.env.MEMORY_WRITER_DAILY_USD='0';
  await assert.rejects(requestModel({messages:[],maxOutputTokens:100,model:providerConfig.writerModel,role:'writer'}),/budget reached/);
  assert.equal(requests.length,before,'zero budget stops before a paid request');
  process.env.MEMORY_WRITER_DAILY_USD='1';mode='outage';
  await assert.rejects(requestModel({messages:[],maxOutputTokens:100,model:providerConfig.writerModel,role:'writer'}),/503/);
  const report=modelCostReport({role:'writer'});
  assert.equal(report.unconfirmedCalls,1);assert.ok(report.unconfirmedReservedUsd>0);
  mode='answer';
  const shared={guildId:'g',runId:'model-change',system:'s',userContent:'u',reuseCompleted:true,modelIdentity:'old',request:input=>requestModel({...input,maxOutputTokens:100})};
  await runAgent(shared);
  await assert.rejects(runAgent({...shared,modelIdentity:'new'}),/checkpoint input mismatch/);
  console.log('OpenRouter: shared routing, protocol continuation, usage, scoped accounting and preflight cap passed');
}finally{globalThis.fetch=original;db.close();rmSync(dir,{recursive:true,force:true});}
