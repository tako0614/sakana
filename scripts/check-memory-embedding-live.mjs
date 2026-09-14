// Real local encoder, isolated synthetic sources, no remote LLM or Discord.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryHost, LocalAuthority, HybridCandidateProvider } from '../subprojects/atom-memory/dist/index.js';
import { SqliteStorage } from '../subprojects/atom-memory/dist/adapters/sqlite.js';
import { conversationEmbedding } from '../src/conversation/embedding.js';
import { shutdown } from '../src/embed/worker.js';
const directory = mkdtempSync(join(tmpdir(),'sakana-real-encoder-'));
const storage = new SqliteStorage(join(directory,'atoms.sqlite'));
try {
  const authority = new LocalAuthority();
  const auth = authority.issue({subject:'test',readPolicies:['g'],writePolicies:['g'],canIngestSource:true});
  const binding = {auth,writePolicy:'g',actor:{type:'input-adapter'}};
  const embedding = conversationEmbedding();
  await embedding.embed(['初期ロードの検査'], AbortSignal.timeout(300000), 'query');
  const host = new MemoryHost({authority,storage,embedding,candidateProvider:new HybridCandidateProvider()});
  const memory = host.connect(binding);
  const write = async (text,links={}) => (await memory.write({changes:[{id:'atom',op:'create',sources:[],content:{text,links}}]})).changes.atom;
  const source = await write('ユーザーの追放は管理者が手動で実行する。AIは処分を提案する。');
  const group = await write('コミュニティの権限と役割');
  const relation = await write('処分についての役割分担',{group:group.ref,member:source.ref});
  await write('水槽の魚に餌を与える。');
  for (let i=0;i<20;i++) if (!(await host.updateIndex(binding,{limit:16,deadline:new Date(Date.now()+120000).toISOString()})).pending) break;
  const result = await memory.read({context:'メンバーを退会させる権限は誰にある？',thought:'管理者とAIの役割を比較する'}, {depth:2,tokens:16000});
  assert.ok(result.items.some(item => item.text.includes('管理者が手動')));
  assert.ok(result.items.some(item => item.text.includes('役割分担')));
  assert.equal(result.diagnostics.index,'ready');
  const vectors = await embedding.embed(['同じ入力'],new AbortController().signal,'document');
  assert.equal(vectors[0].length,384);
  assert.ok(vectors[0].every(Number.isFinite));
  console.log(JSON.stringify({encoder:embedding.id,dimensions:vectors[0].length,recalled:result.items.length,index:result.diagnostics.index,approximate:result.diagnostics.approximate}));
} finally { storage.close(); shutdown(); rmSync(directory,{recursive:true,force:true}); }
