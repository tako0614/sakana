import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(),'sakana-dream-memory-'));
Object.assign(process.env, { ARCHIVE_DB_PATH: join(dir,'archive.sqlite'), DATABASE_PATH: join(dir,'main.sqlite'),
  AGENT_RUNTIME_PATH: join(dir,'runs.sqlite'), ATOM_MEMORY_PATH: join(dir,'atoms.sqlite'),
  MEMORY_EMBEDDINGS: '0', MEMORY_DREAMING_ENABLED: '1', MEMORY_DREAMING_GUILDS: '1255359848644608035' });
const { db, saveMessage } = await import('../src/archive/db.js');
const { toRecord } = await import('../src/archive/indexer.js');
const { archiveEnvelope } = await import('../src/conversation/message.js');
const { fromArchiveRow, formatMessages, RefTable } = await import('../src/agent/format.js');
const { embeddingText } = await import('../src/conversation/embedding.js');
const { admissionFor, selectAdmissionBatch, applyAdmissionDecisions, selectContextMessages } = await import('../src/conversation/admission.js');
const { conversationMemory, conversationSourceHash, conversationSourcesReady, conversationWriterSession,
  syncConversationMemory, drainConversationWriterIndex } = await import('../src/conversation/memory.js');
const guildId = '1255359848644608035';
const row = id => db.prepare('SELECT * FROM messages WHERE message_id=?').get(id);
const add = (id, channelId, content, options={}) => {
  const message = { id, guildId, channelId, content, createdTimestamp: 1700000000000+Number(id),
    author: { id: options.bot ? 'notifier' : 'person', username: 'participant', bot: Boolean(options.bot) },
    attachments: new Map(), embeds: options.embeds ?? [], ...options };
  saveMessage(toRecord(message)); return row(id);
};
const decide = (state) => {
  const batch = selectAdmissionBatch({guildId});
  applyAdmissionDecisions(batch,batch.targets.map(t=>({messageId:t.messageId,state,reason:'test decision'})));
};
try {
  add('101','public-a','PUBLIC_ALPHA');
  add('102','public-b','PUBLIC_BETA');
  add('103','private-b','PRIVATE_SECRET');
  add('104','public-a','',{bot:true,embeds:[{title:'Deploy',fields:[{name:'result',value:'EMBED_FIELD_PROOF'}]}]});
  assert.match(archiveEnvelope(row('104')).supplemental.text,/EMBED_FIELD_PROOF/);
  assert.match(fromArchiveRow(row('104')).extra,/EMBED_FIELD_PROOF/);
  const envelope = archiveEnvelope(row('104'));
  assert.match(embeddingText(JSON.stringify({complete:true,document:JSON.stringify(envelope)})),/EMBED_FIELD_PROOF/);
  const pendingHash = conversationSourceHash(row('104'));
  assert.equal(admissionFor(row('104')).state,'pending');
  decide('retain');
  const admittedHash = conversationSourceHash(row('104'));
  assert.equal(pendingHash,admittedHash,'admission completion cannot invalidate its own source observations');
  assert.equal(conversationSourcesReady([{messageId:'104',hash:admittedHash}]),false);
  assert.ok(db.prepare('SELECT 1 FROM memory_projection_priority WHERE message_id=?').get('104'));
  await syncConversationMemory({limit:100});
  assert.equal(conversationSourcesReady([{messageId:'104',hash:admittedHash}]),true);

  const everyone = { id:'everyone' }, member = {id:'reader'}, bot = {id:'bot'};
  let revoked = false;
  const guild = {id:guildId,roles:{everyone},members:{me:bot},channels:{cache:new Map()}};
  const channel = (id,shared) => ({id,guildId,guild,type:0,isTextBased:()=>true,
    permissionsFor:who=>({has:()=>who===everyone ? shared : !(revoked && id==='public-b')})});
  for (const [id,shared] of [['public-a',true],['public-b',true],['private-b',false]]) guild.channels.cache.set(id,channel(id,shared));
  const memory=conversationMemory({guildId,channel:guild.channels.cache.get('public-a'),member});
  try {
    const found=await memory.read({context:'PUBLIC_BETA PRIVATE_SECRET EMBED_FIELD_PROOF'});
    assert.match(found.text,/PUBLIC_BETA/,'public-channel memory is shared in Evex');
    assert.match(found.text,/EMBED_FIELD_PROOF/,'embed-only source is model-visible');
    assert.doesNotMatch(found.text,/PRIVATE_SECRET/,'other private channel is excluded');
    revoked=true;
    await assert.rejects(memory.assertCurrent(),/permission changed/);
  } finally {memory.close();}

  const session=conversationWriterSession({guildId,channelId:'public-a'});
  const sources=[{messageId:'104',hash:admittedHash}];
  session.prepare('empty-organization',{guildId,channelId:'public-a',sources});
  session.storage.metaSet('sakana:writer-batch:empty-organization',{
    ...session.checkpoint('empty-organization'),committed:true});
  session.requestIndex('empty-organization');
  assert.equal(session.indexReady('empty-organization'),false,'organization alone is not an index acknowledgement');
  await drainConversationWriterIndex({guildIds:[guildId]});
  assert.equal(session.indexReady('empty-organization'),true);
  session.close();

  db.prepare('UPDATE messages SET extra=? WHERE message_id=?').run('EMBED_EDITED','104');
  assert.match(db.prepare('SELECT extra FROM message_versions WHERE message_id=? ORDER BY id DESC LIMIT 1').get('104').extra,/EMBED_FIELD_PROOF/);
  assert.ok(db.prepare('SELECT 1 FROM memory_writer_pending WHERE message_id=?').get('104'));
  decide('suppress');
  assert.notEqual(conversationSourceHash(row('104')),admittedHash);
  assert.equal(conversationSourcesReady(sources),false);
  const hidden=conversationMemory({guildId,channel:guild.channels.cache.get('public-a'),member});
  try {assert.doesNotMatch((await hidden.read({context:'EMBED_FIELD_PROOF'})).text,/EMBED_FIELD_PROOF/,
    'suppression gates a previously projected Atom before purge');} finally {hidden.close();}
  await syncConversationMemory({limit:100});
  assert.equal(db.prepare('SELECT deleted FROM messages WHERE message_id=?').get('104').deleted,0,'raw audit is retained');

  const a=add('201','public-a','FIRST_BURST_PART'),b=add('202','public-a','SECOND_BURST_PART');
  const units=selectContextMessages([a,b],{guildId,channelId:'public-a'});
  const refs=new RefTable();
  const text=formatMessages(units.map(u=>({...u.messages[0],contextMessages:u.messages})),{refs});
  assert.match(text,/FIRST_BURST_PART/);assert.match(text,/SECOND_BURST_PART/);
  assert.equal(refs.byMessageId.get('202').messageId,'202','each part keeps a citation identity');
  assert.match(text,/consecutive_same_author/);
  console.log('dream memory: supplementary sources, selection invalidation, priority projection, public scope, index barrier and burst citations passed');
} finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
