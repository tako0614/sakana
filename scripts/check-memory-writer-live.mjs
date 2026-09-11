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
const { saveMessage } = await import('../src/archive/db.js');
const { toRecord } = await import('../src/archive/indexer.js');
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
const channel = { id: 'fixture', guild: { id: 'fixture', members: { me: { id: 'bot' } } }, permissionsFor: () => ({ has: () => true }) };
const memory = conversationMemory({ guildId: 'fixture', channel, member: { id: 'viewer' }, query: 'ban kick 管理者 条件 正式 投票' });
const result = await memory.read();
const pack = JSON.parse(result.text);
const atoms = pack.memory.filter((atom) => atom.provenance.origin !== 'source').map((atom) => ({
  ...JSON.parse(atom.text), origin: atom.provenance.origin, roles: atom.links.map((link) => link.role), sourceCount: atom.sources.length
}));
assert.ok(atoms.length, 'Generated memory must be recalled by the shared agent integration');
const report = { directory, status, recalled: atoms };
writeFileSync(join(directory, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
memory.close();
