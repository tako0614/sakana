import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChannelType,PermissionsBitField} from 'discord.js';
import Database from 'better-sqlite3';
import {spawnSync} from 'node:child_process';
const dir=mkdtempSync(join(tmpdir(),'sakana-archive-coverage-'));
process.env.ARCHIVE_DB_PATH=join(dir,'archive.sqlite');
process.env.ARCHIVE_FETCH_DELAY_MS='0';
// A database left by a release that still had Atom memory: the enumeration
// record lives in memory_projection_state and every message write fans out
// into queue tables through triggers.
const legacyCoverage=JSON.stringify({schema:1,guildId:'legacy-guild',mode:'full',complete:true,channelIds:['c']});
{
  const schema=spawnSync(process.execPath,['--input-type=module','-e',"await import('./src/archive/db.js')"],
    {cwd:process.cwd(),env:process.env,encoding:'utf8'});
  assert.equal(schema.status,0,schema.stderr);
  const legacy=new Database(process.env.ARCHIVE_DB_PATH);
  legacy.exec(`CREATE TABLE memory_pending (message_id TEXT PRIMARY KEY);
    CREATE TABLE memory_projection_priority (message_id TEXT PRIMARY KEY);
    CREATE TABLE memory_projection_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE memory_writer_pending (message_id TEXT PRIMARY KEY, guild_id TEXT, channel_id TEXT, created_at INTEGER, queued_at INTEGER);
    CREATE TABLE memory_writer_inputs (batch_id TEXT, message_id TEXT);
    CREATE TABLE memory_writer_runs (batch_id TEXT PRIMARY KEY);
    CREATE TABLE dream_admissions (message_id TEXT PRIMARY KEY);
    CREATE TABLE dream_channels (guild_id TEXT, channel_id TEXT);
    CREATE TABLE dream_jobs (guild_id TEXT);
    CREATE TABLE dream_message_generations (guild_id TEXT, message_id TEXT, generation INTEGER);
    CREATE INDEX idx_dream_messages_reply_target ON messages(reply_to, guild_id, channel_id, is_bot, deleted, message_id);
    CREATE TRIGGER messages_memory_ai AFTER INSERT ON messages BEGIN INSERT INTO memory_pending VALUES (new.message_id); END;
    CREATE TRIGGER messages_writer_insert AFTER INSERT ON messages BEGIN
      INSERT INTO memory_writer_pending VALUES (new.message_id, new.guild_id, new.channel_id, new.created_at, 0); END;
    CREATE TRIGGER dream_generation_insert AFTER INSERT ON messages BEGIN
      INSERT INTO dream_message_generations VALUES (new.guild_id, new.message_id, 0); END;
    INSERT INTO memory_projection_state VALUES ('seeded-v1','1'), ('archive-full-coverage:legacy-guild', '${legacyCoverage}');`);
  legacy.close();
}
const {db,saveMessage}=await import('../src/archive/db.js');
const {coverageReport,runIndexJob,toRecord}=await import('../src/archive/indexer.js');
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
  const leftovers=db.prepare(`SELECT type,name FROM sqlite_master WHERE name LIKE 'memory_%' OR name LIKE 'dream_%'
    OR name LIKE 'messages_memory_%' OR name LIKE 'messages_writer_%' OR name LIKE 'idx_dream_%'`).all();
  assert.deepEqual(leftovers,[],'retired memory triggers, indexes and queues are dropped on open');
  assert.equal(db.prepare("SELECT value FROM archive_state WHERE key='archive-full-coverage:legacy-guild'").get()?.value,
    legacyCoverage,'the full-history enumeration record survives the move');
  assert.equal(db.prepare("SELECT 1 FROM archive_state WHERE key='seeded-v1'").get(),undefined,'Atom work state is not carried over');
  saveMessage(toRecord({id:'900',guildId,channelId:'c',content:'after the move',author:{id:'a',username:'a'},
    createdTimestamp:1700000000000,attachments:new Map()}));
  assert.equal(db.prepare("SELECT content FROM messages WHERE message_id='900'").get().content,'after the move',
    'archiving works without the retired queue tables');
  db.prepare("DELETE FROM messages WHERE message_id='900'").run();
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
  console.log('archive coverage: Atom retirement migration, empty archive, complete enumeration, joined-private pagination and partial failure passed');
}finally{db.close();rmSync(dir,{recursive:true,force:true});}
