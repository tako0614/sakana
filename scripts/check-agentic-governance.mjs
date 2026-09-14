import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'sakana-agentic-governance-'));
process.env.DATABASE_PATH = `${directory}/main.sqlite`;
process.env.ARCHIVE_DB_PATH = `${directory}/archive.sqlite`;
process.env.OPENROUTER_API_KEY = 'review-fixture';
const base = new URL('../', import.meta.url).href;
const db = await import(base + 'src/governance/db.js');
const { loadBootstrapDocuments } = await import(base + 'src/governance/config.js');
const { runJudicialPanel, runConstitutionalPanel } = await import(base + 'src/governance/llm.js');
const { buildToolset } = await import(base + 'src/governance/tools.js');
const gid = 'agentic-review';
const docs = loadBootstrapDocuments({ serverName: 'Agentic review' });
db.bootstrapGovernanceGuild({ guildId: gid, enactedBy: 'owner', trustedRoleId: 'trusted', enforcementMode: 'shadow', ...docs,
 appealRoleId: 'appeal', categoryId: 'category', parliamentForumId: 'parliament', courtForumId: 'court', courtChatChannelId: 'court', procedureChannelId: 'procedure' });
const root = db.getActiveConstitution(gid);
const proposal = db.createProposal({ guildId: gid, constitutionId: root.id, kind: 'law', source: 'review', title: 'Long law', summary: 'review', status: 'agenda' });
const law = db.enactLaw({ guildId: gid, proposalId: proposal.id, constitutionId: root.id, code: 'LONG', title: 'Long law',
 text: '第一条 本法の規定。'.repeat(350) + '末尾の適用除外TAIL_EXCEPTION',
 provisions: { articles: [{ code: 'A1', text: '大量投稿を禁止する。' }], offenses: [{ code: 'O1', title: '大量投稿', elements: ['大量投稿'], sanctions: [{ type: 'warning' }] }], sanctionDefinitions: [] }, effectiveAt: Date.now() - 60000 });
const record = db.createCase({ guildId: gid, reporterId: 'reporter', accusedId: 'target', lawId: law.id, offenseCode: 'O1', summary: 'review', constitutionId: root.id, allegedAt: Date.now() - 30000, procedureVersion: 2 });
db.addCaseEvidence({ caseId: record.id, submittedBy: 'reporter', messageId: '123', channelId: 'public', authorId: 'target', content: '大量投稿', contentHash: 'fixture', occurredAt: record.alleged_at });
const evidence = db.listCaseEvidence(record.id);
const output = { verdict: 'responsible', lawId: law.id, offenseCode: 'O1', evidenceIds: [evidence[0].id], elementFindings: [{ element: '大量投稿', proved: true, evidenceIds: [evidence[0].id], reason: '記録を確認' }], reasons: ['記録を確認'], sanction: { type: 'warning' }, newRecordIds: [] };
const response = (value) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }), { status: 200 });
const run = () => runJudicialPanel({ guildId: gid, caseRecord: db.getCase(record.id), law, offense: law.provisions.offenses[0], evidence, submissions: [], policy: db.constitutionForSubject('case', record).policy, phase: 'police' });
let calls = [];
globalThis.fetch = async (_url, init) => {
  if (_url.endsWith('/endpoints')) return { ok: true, json: async () => ({ data: { endpoints: [{ pricing: { prompt: '0.0000001', completion: '0.0000002' } }] } }) };
 const body = JSON.parse(init.body); calls.push(body);
 return body.tools?.length ? new Response('outage', { status: 503 }) : response(output);
};
await assert.rejects(run(), /席|HTTP|failed/);
assert.equal(calls.length, 1, 'investigative failure never requests a verdict');
console.log('A1: investigative failure remains a retryable execution failure');

calls = [];
let traceRowsDuringInvestigation = null;
globalThis.fetch = async (_url, init) => {
  if (_url.endsWith('/endpoints')) return { ok: true, json: async () => ({ data: { endpoints: [{ pricing: { prompt: '0.0000001', completion: '0.0000002' } }] } }) };
 const body = JSON.parse(init.body); calls.push(body);
 if (body.tools?.length && !body.messages.some((message) => message.role === 'tool')) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'read-law', type: 'function', function: { name: 'read_law', arguments: JSON.stringify({ code: 'LONG' }) } }] } }] }), { status: 200 });
 if (body.tools?.length) {
  traceRowsDuringInvestigation = db.governanceDatabase.prepare('SELECT COUNT(*) AS count FROM governance_investigation_steps').get().count;
  return response(output);
 }
 return response(output);
};
await run();
const toolText = calls.flatMap((call) => call.messages).find((message) => message.role === 'tool').content;
assert.doesNotThrow(() => JSON.parse(toolText));
assert.ok(JSON.parse(toolText).page?.nextOffset > 0, 'long documents have explicit continuation');
assert.ok(traceRowsDuringInvestigation > 0, 'audit is durable before the next model request');
const lawTools = buildToolset({ guildId: gid, allowed: ['read_law'], maximumOutputBytes: 128 * 1024 });
let offset = 0, assembled = '';
do {
  const page = await lawTools.run('read_law', { code: 'LONG', offset });
  assert.ok(page.page);
  assembled += page.page.content;
  offset = page.page.nextOffset;
} while (offset !== null);
assert.match(JSON.parse(assembled).text, /TAIL_EXCEPTION/);
console.log('A2/A3: complete paged laws and immediate durable observations');

calls = [];
globalThis.fetch = async (_url, init) => {
  if (_url.endsWith('/endpoints')) return { ok: true, json: async () => ({ data: { endpoints: [{ pricing: { prompt: '0.0000001', completion: '0.0000002' } }] } }) }; calls.push(JSON.parse(init.body)); return response({ verdict: 'constitutional', reasons: ['供給された対象を確認'], constitutionArticles: ['第三条（言論の自由）'] }); };
const constitutional = await runConstitutionalPanel({ guildId: gid, targetType: 'law', targetId: law.id, phase: 'pre', constitution: root, target: law });
assert.equal(constitutional.outputs.length, 3);
assert.ok(calls.some((call) => call.tools?.some((tool) => tool.function.name === 'read_constitution')));
console.log('A4: constitutional review uses the shared agent loop and enacted investigative capabilities');

const content = '前半の説明。'.repeat(100) + '末尾の反証TAIL_CONTEXT';
db.recordActivity({ messageId: '456', guildId: gid, channelId: 'public', parentId: null, userId: 'target', activityDate: '2026-09-10', contentHash: 'full-message', content, createdAt: Date.now() });
const toolset = buildToolset({ guildId: gid, caseId: record.id, constitution: root, allowed: ['read_context', 'read_constitution'] });
const context = await toolset.run('read_context', { messageId: '456', before: 0, after: 0 });
assert.match(context[0].content, /TAIL_CONTEXT/);
assert.equal(toolset.retrieved.get('456').content, context[0].content);
console.log('A5: observed content equals the record admitted to the citation ledger');

db.enactConstitution({ guildId: gid, content: docs.constitution.replace('## 第三条（言論の自由）', '## 第三条（改正後の言論の自由）'), enactedBy: 'review-fixture' });
const pinned = db.constitutionForSubject('case', record);
const readRoot = await toolset.run('read_constitution', {});
assert.equal(pinned.version, 1);
assert.equal(readRoot.version, 1);
console.log('A6: investigation reads the case-pinned constitution after amendment');
const { revalidateInvestigationEvidence } = await import(base + 'src/governance/intake.js');
const fetched = { id: '789', guildId: gid, channelId: 'public', author: { id: 'target', bot: false },
  content: 'reply evidence', reference: { messageId: 'earlier', channelId: 'public' },
  attachments: new Map(), createdTimestamp: Date.now() };
const publicChannel = { isTextBased: () => true, permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => fetched } };
const sourceGuild = { channels: { fetch: async () => publicChannel }, roles: { everyone: { id: 'everyone' } } };
const acquired = await revalidateInvestigationEvidence({ guild: sourceGuild }, [{ messageId: '789', channelId: 'public', authorId: 'target' }]);
assert.equal(acquired[0].conversation.reference.messageId, 'earlier');
const snapshotId = db.addCaseEvidence({ caseId: record.id, submittedBy: 'reporter', ...acquired[0] });
const persisted = db.listCaseEvidence(record.id).find((entry) => entry.id === snapshotId);
assert.equal(JSON.parse(persisted.conversation_json).reference.kind, 'reply');
publicChannel.messages.fetch = async () => { throw new Error('Discord HTTP 503'); };
await assert.rejects(revalidateInvestigationEvidence({ guild: sourceGuild }, [{ messageId: '789', channelId: 'public', authorId: 'target' }]), /HTTP 503/);
db.governanceDatabase.close();
rmSync(directory, { recursive: true, force: true });
console.log('check-agentic-governance: ok');
