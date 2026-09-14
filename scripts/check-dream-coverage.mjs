import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChannelType,PermissionsBitField} from 'discord.js';
const dir=mkdtempSync(join(tmpdir(),'sakana-dream-coverage-'));
process.env.ARCHIVE_DB_PATH=join(dir,'archive.sqlite');
process.env.ARCHIVE_FETCH_DELAY_MS='0';
const {db}=await import('../src/archive/db.js');
const {coverageReport,runIndexJob}=await import('../src/archive/indexer.js');
const guildId='1255359848644608035',me={id:'bot'};
const guild={id:guildId,members:{me},channels:{cache:new Map()}};
const permission={has:flag=>flag!==PermissionsBitField.Flags.ManageThreads};
const base={guild,guildId,permissionsFor:()=>permission,messages:{fetch:async()=>new Map()},
  appliedTags:[],topic:'',isTextBased:()=>true};
const parent={...base,id:'1255359848644608040',name:'public',type:ChannelType.GuildText,isThread:()=>false};
const threads=['1255359848644608020','1255359848644608010'].map(id=>({...base,id,name:'joined',parentId:parent.id,
  type:ChannelType.PrivateThread,isThread:()=>true,members:{cache:new Map([['bot',me]])},
  archivedTimestamp:1700000000000,createdTimestamp:1600000000000}));
let joinedCalls=0,failed=false;
parent.threads={
  fetchActive:async()=>{if(failed)throw Object.assign(new Error('outage'),{status:503});return{threads:new Map()};},
  fetchArchived:async options=>{
    if(options.type==='public')return{threads:new Map(),hasMore:false};
    if(options.fetchAll)throw Object.assign(new Error('requires ManageThreads'),{status:403});
    if(joinedCalls++%2===0){assert.equal(options.before,undefined);return{threads:new Map([[threads[0].id,threads[0]]]),hasMore:true};}
    assert.equal(options.before,threads[0].id,'joined private pages use an ID cursor, not a timestamp');
    return{threads:new Map([[threads[1].id,threads[1]]]),hasMore:false};
  }
};
guild.channels.cache.set(parent.id,parent);
try{
  assert.equal(coverageReport(guildId).verifiedFull,false,'an empty DB is not full-history proof');
  const result=await runIndexJob(guild,{mode:'full'});
  assert.equal(result.errors.length,0);
  assert.equal(result.channelsTotal,3,'all joined-private pages are enumerated');
  let report=coverageReport(guildId);
  assert.equal(report.verifiedFull,true);
  assert.equal(report.verifiedChannelIds.length,3);
  failed=true;
  await runIndexJob(guild,{mode:'full'});
  report=coverageReport(guildId);
  assert.equal(report.verifiedFull,false,'a partial enumeration cannot reuse old success');
  assert.ok(report.enumeration.errors.some(e=>e.stage==='active_threads'));
  console.log('dream coverage: empty archive, complete enumeration, joined-private pagination and partial failure passed');
}finally{db.close();rmSync(dir,{recursive:true,force:true});}
