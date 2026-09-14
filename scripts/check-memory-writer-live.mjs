// A real provider probe using synthetic sources in isolated databases. No Discord
// connection, human votes, legal changes or moderation actions are performed.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'sakana-writer-live-'));
process.env.ARCHIVE_DB_PATH = join(directory, 'archive.sqlite');
process.env.ATOM_MEMORY_PATH = join(directory, 'atoms.sqlite');
process.env.AGENT_RUNTIME_PATH = join(directory, 'runs.sqlite');
process.env.MEMORY_WRITER_QUIET_MS = '1';
// A probe never inherits an unlimited production budget. All paid calls below
// are Writer calls through the common provider, bounded in this isolated ledger.
process.env.MEMORY_WRITER_DAILY_USD = '1';
if (!process.env.OPENROUTER_API_KEY) throw new Error('Set OPENROUTER_API_KEY for the isolated $1 live probe');

const { saveMessage } = await import('../src/archive/db.js');
const { toRecord } = await import('../src/archive/indexer.js');
const { modelCostReport } = await import('../src/ai/cost.js');
const { runConversationWriter } = await import('../src/conversation/writer.js');
const { conversationMemory } = await import('../src/conversation/memory.js');
const fixture = [
  ['1', 'Alice', 'Botにbanとkickを自動実行させる案はどう？', {}],
  ['2', 'Bob', '反対。banとkickは管理者が手動で実行する。AIは提案と執行依頼まで。', { reference: { messageId: '1', channelId: 'fixture' } }],
  ['3', 'Alice', 'その条件なら賛成。timeoutをAIに任せるかは別途検討したい。', { reference: { messageId: '2', channelId: 'fixture' } }],
  ['4', 'Carol', '', { reference: { type: 1, messageId: 'elsewhere' }, messageSnapshots: new Map([['s', { content: 'Botは全員を自動banしてよい' }]]) }],
  ['5', 'Bob', 'まだ採決前です。この会話での賛成発言は正式な投票ではありません。', {}]
];
for (const [id, name, content, extra] of fixture) saveMessage(toRecord({ id, content, guildId: 'fixture', channelId: 'fixture',
  author: { id: name, username: name }, attachments: new Map(), reactions: { cache: new Map() },
  createdTimestamp: 1700000000000 + Number(id) * 1000, ...extra }));
const status = await runConversationWriter({ guildIds: ['fixture'], now: Date.now() + 100 });
assert.equal(status.pending, 0, JSON.stringify(status));
assert.ok(status.batchAtoms > 0, 'The live AI must write actual Atom content');
// A second period arrives only after the first has been organized. The Writer
// sees no evaluation question in either period.
for (const [id,name,content] of [
  ['6','Alice','来月の運用にも同じban/kick方針を使いたい。管理者の手動執行を維持する。'],
  ['7','Bob','新しい提案: timeoutはAIが実行可能にする。ただしこれは採決待ちで未成立。'],
  ['8','Carol','監査資料の分類にも、先月のban/kick議論を関連付けてほしい。'],
]) saveMessage(toRecord({id,content,guildId:'fixture',channelId:'fixture',author:{id:name,username:name},
  attachments:new Map(),reactions:{cache:new Map()},createdTimestamp:1700000000000+31*86400000+Number(id)*1000}));
const later=await runConversationWriter({guildIds:['fixture'],now:Date.now()+200});
assert.equal(later.pending,0,JSON.stringify(later));
assert.ok(later.batchAtoms>0,'The second period must generate a real edit plan');
const channel = { id: 'fixture', guild: { id: 'fixture', members: { me: { id: 'bot' } } }, permissionsFor: () => ({ has: () => true }) };
const memory = conversationMemory({ guildId: 'fixture', channel, member: { id: 'viewer' } });
const result = await memory.read({ context: 'ban kick 管理者 条件 正式 投票' });
const pack = JSON.parse(result.text);
const atoms = pack.memory.filter((atom) => atom.provenance.origin !== 'source').map((atom) => ({
  ...JSON.parse(atom.text), origin: atom.provenance.origin, roles: atom.links.map((link) => link.role), sourceCount: atom.sources.length
}));
assert.ok(atoms.length, 'Generated memory must be recalled by the shared agent integration');
const report = { directory, status, later, cost:modelCostReport(), model:process.env.MEMORY_WRITER_MODEL || 'inclusionai/ling-3.0-flash',
  scope:'question-blind two-period Writer; semantic output requires review, not proven by nonempty recall', recalled: atoms };
assert.ok(report.cost.reportedUsd+report.cost.unconfirmedReservedUsd<=1,'Live probe exceeded the $1 ledger cap');
writeFileSync(join(directory, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
memory.close();
const { shutdown } = await import('../src/embed/worker.js');
shutdown();
