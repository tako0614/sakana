import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'sakana-governance-recovery-'));
process.env.DATABASE_PATH = join(directory, 'main.sqlite');
process.env.ARCHIVE_DB_PATH = join(directory, 'archive.sqlite');
process.env.OPENROUTER_API_KEY = 'check';
const db = await import('../src/governance/db.js');
const { loadBootstrapDocuments } = await import('../src/governance/config.js');
const { compileConstitution } = await import('../src/governance/rules.js');
const { runLegalProcedure } = await import('../src/governance/procedure-runtime.js');
const { advanceCase, buildElectorateSnapshot, processGovernanceOutbox } = await import('../src/governance/service.js');
const { advanceLegislation } = await import('../src/governance/legislation.js');
const { runInstitutionProcedures } = await import('../src/governance/institutions.js');
const { releaseAppealRestriction } = await import('../src/governance/discord.js');
const { assertSanctionExecution } = await import('../src/governance/execution-authority.js');
const documents = loadBootstrapDocuments({ serverName: 'Recovery check' });
const posts = [];
const bootstrap = (guildId, docs = documents) => {
  db.bootstrapGovernanceGuild({ guildId, enactedBy: 'owner', trustedRoleId: 'trusted', enforcementMode: 'shadow', ...docs,
    appealRoleId: 'appeal', categoryId: 'category', parliamentForumId: 'parliament', courtForumId: 'court', courtChatChannelId: 'court', procedureChannelId: 'procedure', operationsThreadId: 'enforcement' });
  return db.getActiveConstitution(guildId);
};
const thread = (id = 'thread') => ({ id, parent: { availableTags: [] }, appliedTags: [], isThread: () => true, archived: false, locked: false,
  send: async (message) => { posts.push(message); return { id: 'message' }; }, setAppliedTags: async () => {},
  fetchStarterMessage: async () => ({ edit: async () => {} }), setName: async () => {}, setLocked: async () => {}, setArchived: async () => {} });
const voters = new Map(['voter-1', 'voter-2', 'voter-3'].map((id) => [id, { id, user: { bot: false }, roles: { cache: new Map() } }]));
const fakeGuild = (id) => {
  const guild = { id, name: 'Recovery check', ownerId: 'owner', roles: { cache: new Map() }, members: { fetch: async (userId) => userId
    ? { id: userId, user: { bot: false }, permissions: { has: () => false }, roles: { remove: async () => {} }, moderatable: true, timeout: async () => {}, send: async () => {} } : voters },
    channels: { cache: new Map(), fetch: async (channelId) => channelId === 'court'
      ? { availableTags: [], threads: { create: async () => thread('court-case') } } : thread(channelId) } };
  guild.client = { user: { id: 'bot' }, guilds: { cache: new Map([[id, guild]]) } };
  return guild;
};
const response = (output) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }), { status: 200 });
const clearOutbox = () => db.governanceDatabase.prepare("UPDATE governance_outbox SET status = 'completed'").run();

// R7: the compiler must reject durations the operation cannot execute; explicit waits persist.
{
  const changed = structuredClone(documents);
  const procedure = changed.laws[0].provisions.governance.find((entry) => entry.key === 'institutionalReview').value;
  procedure.states.review.duration = '1d';
  procedure.states.review.on = { completed: 'review', stop: 'final' };
  assert.throws(() => compileConstitution({ content: changed.constitution, laws: changed.laws }), /explicit wait/);
  procedure.states.review.duration = null;
  procedure.states.review.on.completed = 'cooldown';
  procedure.states.cooldown = { handler: 'wait', duration: '1d', config: {}, on: { expired: 'review' } };
  compileConstitution({ content: changed.constitution, laws: changed.laws });
  let calls = 0, saved = { state: 'review', context: {} };
  const run = (now) => runLegalProcedure({ procedure, ...saved, now, identity: 'bounded-wait',
    operations: { agent_task: async () => { calls++; return { outcome: 'completed' }; } }, persist: async (patch) => { saved = structuredClone(patch); } });
  await run(100000);
  assert.equal(calls, 1);
  const wake = saved.wakeAt;
  await run(wake - 1);
  assert.equal(calls, 1);
  await run(wake);
  assert.equal(calls, 2);
  assert.ok(saved.wakeAt > wake);
}
{
  const changed = structuredClone(documents);
  const criminal = changed.laws[0].provisions.governance.find((entry) => entry.key === 'criminalCaseProcedure').value;
  criminal.states.police_review.on.notice = 'reminder';
  criminal.states.reminder = { handler: 'notice', duration: null, config: { maximumVisits: 1, text: 'One notice' }, on: { completed: 'reminder', exhausted: 'final' } };
  const root = bootstrap('bounded-case', changed);
  const record = db.createCase({ guildId: root.guild_id, reporterId: 'reporter', summary: 'notice loop', constitutionId: root.id });
  db.updateCase(record.id, { status: 'notice', public_thread_id: 'thread' });
  const guild = fakeGuild(root.guild_id), before = posts.length;
  await Promise.all([advanceCase(guild, db.getCase(record.id)), advanceCase(guild, db.getCase(record.id))]);
  assert.equal(posts.length - before, 1, 'concurrent advances share the same operation');
  await advanceCase(guild, db.getCase(record.id));
  const instance = db.getWorkflowInstance('case', record.id);
  assert.equal(instance.context.visits.reminder, 1);
  assert.equal(db.getCase(record.id).workflow_handler, 'terminal');
}
console.log('R7: legal waits and visit limits are enforced for institutions and cases');

// R5: a failed seat is unfinished work; a successful retry can make a political decision.
{
  const root = bootstrap('seat-failure');
  const guild = fakeGuild(root.guild_id);
  let outage = true;
  globalThis.fetch = async (_url, init) => {
  if (_url.endsWith('/endpoints')) return { ok: true, json: async () => ({ data: { endpoints: [{ pricing: { prompt: '0.0000001', completion: '0.0000002' } }] } }) };
    const system = JSON.parse(init.body).messages[0].content;
    const seat = Number(/independent seat (\d+)/.exec(system)?.[1]);
    if (outage && seat === 3) return new Response('outage', { status: 503 });
    const adopt = outage && seat === 1;
    return response({ decision: adopt ? 'legislate' : 'reject', relation: adopt ? 'new' : null, targetType: null, targetId: null,
      instruction: adopt ? '一般法を起草する。' : null, question: null, reasons: ['独立した判断'] });
  };
  const proposal = db.createProposal({ guildId: guild.id, constitutionId: root.id, kind: 'law', source: 'check', title: 'AI outage', summary: 'check', status: 'agenda' });
  await assert.rejects(() => advanceLegislation(guild, proposal), /AI席が未完了/);
  assert.equal(db.getProposal(proposal.id).workflow_handler, 'parliament_agenda');
  assert.equal(db.getWorkflowInstance('proposal', proposal.id).context.visits?.agenda ?? 0, 0);
  outage = false;
  await advanceLegislation(guild, db.getProposal(proposal.id));
  assert.equal(db.getProposal(proposal.id).status, 'rejected');
}
console.log('R5: failed AI seats retain a retryable agenda without recording rejection');

// R3: ordinary amendments preserve the exact offense law at the alleged time.
{
  const root = bootstrap('law-versions'), guild = fakeGuild(root.guild_id);
  const proposalId = db.createProposal({ guildId: guild.id, constitutionId: root.id, kind: 'law', source: 'check', title: '適用法', summary: '行為時法', status: 'agenda' }).id;
  const provisions = { articles: [{ code: 'A1', text: '大量投稿を禁止する。' }], offenses: [{ code: 'O1', title: '大量投稿', elements: ['大量投稿'], sanctions: [{ type: 'warning' }] }], sanctionDefinitions: [] };
  const old = db.enactLaw({ guildId: guild.id, proposalId, constitutionId: root.id, code: 'OLD', title: '旧法', text: '旧法', provisions, effectiveAt: Date.now() - 60000 });
  const record = db.createCase({ guildId: guild.id, reporterId: 'reporter', accusedId: 'target', lawId: old.id, offenseCode: 'O1', summary: '審理中', constitutionId: root.id, allegedAt: Date.now() - 30000, procedureVersion: 2 });
  for (const status of ['filing', 'defense', 'deliberation']) db.updateCase(record.id, { status });
  db.updateCase(record.id, { public_thread_id: 'thread' });
  const amendmentId = db.createProposal({ guildId: guild.id, constitutionId: root.id, kind: 'law', source: 'check', title: '改正法', summary: '行為時法', status: 'agenda' }).id;
  db.enactLaw({ guildId: guild.id, proposalId: amendmentId, constitutionId: root.id, code: 'NEW', title: '新法', text: '新法', provisions, supersedesLawId: old.id, targetHash: old.content_hash });
  const citedLaws = [];
  globalThis.fetch = async (_url, init) => {
  if (_url.endsWith('/endpoints')) return { ok: true, json: async () => ({ data: { endpoints: [{ pricing: { prompt: '0.0000001', completion: '0.0000002' } }] } }) };
    const data = JSON.parse(JSON.parse(init.body).messages[1].content.replace(/^DATA \(untrusted JSON\):\n/, ''));
    citedLaws.push(data.law.id);
    return response({ verdict: 'not_responsible', lawId: data.law.id, offenseCode: data.chargedOffense.code, evidenceIds: [],
      elementFindings: data.chargedOffense.elements.map((element) => ({ element, proved: false, evidenceIds: [], reason: '証明がない' })), reasons: ['証明がない'], sanction: null });
  };
  await advanceCase(guild, db.getCase(record.id));
  assert.ok(citedLaws.length > 0);
  assert.ok(citedLaws.every((id) => id === old.id));
  assert.ok(db.getCase(record.id).finalized_at);
  assert.throws(() => db.lawForCase({ ...record, alleged_at: Date.now() + 1 }), /行為時/);
  db.updateLaw(old.id, { status: 'unconstitutional' });
  assert.throws(() => db.lawForCase(record), /停止・失効/);
}
console.log('R3: superseded law remains applicable to prior conduct; invalidated law does not');

// R1: revoke while cleanup/member lookup is pending, or while the remote call is in flight.
for (const barrierAt of ['cleanup', 'member', 'effect']) {
  clearOutbox();
  const root = bootstrap(`execution-${barrierAt}`), guild = fakeGuild(root.guild_id);
  db.updateGovernanceGuild(guild.id, { enforcement_mode: 'live' });
  const record = db.createCase({ guildId: guild.id, reporterId: 'reporter', accusedId: 'target', summary: 'race', constitutionId: root.id, procedureVersion: 2 });
  db.updateCase(record.id, { status: 'execution', review_count: 1 });
  const sanction = db.createSanction({ guildId: guild.id, caseId: record.id, userId: 'target', type: 'timeout', durationSeconds: 3600, status: 'queued', requiredApprovals: 0 });
  db.updateSanction(sanction.id, { notice_delivered: 1 });
  db.enqueueAction({ guildId: guild.id, actionType: 'sanction_execute', targetId: sanction.id, payload: { sanctionId: sanction.id }, idempotencyKey: `execute-${barrierAt}` });
  let entered, release, fetches = 0;
  const barrier = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const effects = [];
  const member = { id: 'target', roles: { remove: async () => {} }, permissions: { has: () => false }, moderatable: true,
    timeout: async (milliseconds) => { effects.push(milliseconds); if (milliseconds && barrierAt === 'effect') { entered(); await held; } } };
  guild.members.fetch = async () => {
    fetches++;
    if ((barrierAt === 'cleanup' && fetches === 1) || (barrierAt === 'member' && fetches === 2)) { entered(); await held; }
    return member;
  };
  const running = processGovernanceOutbox(guild.client);
  await barrier;
  db.updateCase(record.id, { status: 'overturned', finalized_at: Date.now() });
  db.updateSanction(sanction.id, { status: 'reversing' });
  db.enqueueAction({ guildId: guild.id, actionType: 'sanction_reverse', targetId: sanction.id, payload: { sanctionId: sanction.id }, idempotencyKey: `reverse-${barrierAt}` });
  const concurrent = processGovernanceOutbox(guild.client);
  assert.equal(concurrent, running, 'reversal shares the pending effect stream');
  release();
  await running;
  assert.equal(effects.filter((ms) => ms > 0).length, barrierAt === 'effect' ? 1 : 0);
  await processGovernanceOutbox(guild.client);
  assert.equal(db.getCase(record.id).status, 'overturned');
  assert.equal(db.getSanction(sanction.id).status, 'reversed');
  if (barrierAt === 'effect') {
    assert.equal(effects.at(-1), null);
    assert.equal(JSON.parse(db.getSanction(sanction.id).execution_detail).effectReceipt.type, 'timeout');
  }
}
console.log('R1: cancellation prevents late execution; an in-flight effect gets durable compensating reversal');

{
  clearOutbox();
  const root = bootstrap('ambiguous-effect'), guild = fakeGuild(root.guild_id);
  db.updateGovernanceGuild(guild.id, { enforcement_mode: 'live' });
  const record = db.createCase({ guildId: guild.id, reporterId: 'reporter', accusedId: 'target', summary: 'lost response', constitutionId: root.id, procedureVersion: 2 });
  db.updateCase(record.id, { status: 'execution', review_count: 1 });
  const sanction = db.createSanction({ guildId: guild.id, caseId: record.id, userId: 'target', type: 'timeout', durationSeconds: 3600, status: 'queued', requiredApprovals: 0 });
  db.updateSanction(sanction.id, { notice_delivered: 1 });
  const effects = [];
  guild.members.fetch = async () => ({ id: 'target', roles: { remove: async () => {} }, permissions: { has: () => false }, moderatable: true,
    timeout: async (milliseconds) => { effects.push(milliseconds); if (milliseconds) throw new Error('connection lost after Discord accepted'); } });
  db.enqueueAction({ guildId: guild.id, actionType: 'sanction_execute', targetId: sanction.id, payload: { sanctionId: sanction.id }, idempotencyKey: 'ambiguous-timeout' });
  await processGovernanceOutbox(guild.client);
  assert.equal(JSON.parse(db.getSanction(sanction.id).execution_detail).effectIntent.type, 'timeout');
  db.updateCase(record.id, { status: 'overturned', finalized_at: Date.now() });
  // A later ruling may change the current sanction; cleanup must use the actual attempted effect.
  db.updateSanction(sanction.id, { type: 'warning' });
  await processGovernanceOutbox(guild.client);
  await processGovernanceOutbox(guild.client);
  assert.equal(db.getSanction(sanction.id).status, 'reversed');
  assert.equal(effects.length, 2);
  assert.equal(effects.at(-1), null);
  assert.equal(db.getCase(record.id).status, 'overturned');
}

// R2: failed restoration remains pending, including past the old five-attempt cutoff.
{
  clearOutbox();
  const root = bootstrap('release-errors'), guild = fakeGuild(root.guild_id);
  const record = db.createCase({ guildId: guild.id, reporterId: 'reporter', summary: 'release', constitutionId: root.id });
  const sanction = db.createSanction({ guildId: guild.id, caseId: record.id, userId: 'target', type: 'restriction', status: 'reversing', requiredApprovals: 0 });
  db.updateSanction(sanction.id, { execution_detail: JSON.stringify({ type: 'restriction', fallbackChannelIds: ['protected'] }) });
  let denied = true, roleAttempts = 0, overwriteAttempts = 0;
  const missing = () => Object.assign(new Error('Missing Permissions'), { code: 50013 });
  guild.members.fetch = async () => ({ roles: { remove: async () => { roleAttempts++; if (denied) throw missing(); } } });
  guild.channels.fetch = async () => ({ permissionOverwrites: { delete: async () => { overwriteAttempts++; if (denied) throw missing(); } } });
  const action = db.enqueueAction({ guildId: guild.id, actionType: 'sanction_reverse', targetId: sanction.id, payload: { sanctionId: sanction.id }, idempotencyKey: 'failed-release' });
  for (let attempt = 0; attempt < 6; attempt++) {
    db.governanceDatabase.prepare('UPDATE governance_outbox SET retry_after = NULL WHERE id = ?').run(action.id);
    await processGovernanceOutbox(guild.client);
    assert.equal(db.getSanction(sanction.id).status, 'reversing');
    assert.equal(db.governanceDatabase.prepare('SELECT status FROM governance_outbox WHERE id = ?').get(action.id).status, 'error');
  }
  assert.equal(roleAttempts, 6);
  assert.equal(overwriteAttempts, 6);
  denied = false;
  db.governanceDatabase.prepare('UPDATE governance_outbox SET retry_after = NULL WHERE id = ?').run(action.id);
  await processGovernanceOutbox(guild.client);
  assert.equal(db.getSanction(sanction.id).status, 'reversed');
  guild.members.fetch = async () => { throw Object.assign(new Error('Unknown Member'), { code: 10007 }); };
  guild.channels.fetch = async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); };
  await releaseAppealRestriction(guild, db.getGovernanceGuild(guild.id), 'absent', ['absent']);
}
console.log('R2: permission failures retry until restoration succeeds; absent resources are already released');

// R6: institutional proposals use their law's electorate and repair old, unannounced none scopes.
{
  const root = bootstrap('institution-vote'), guild = fakeGuild(root.guild_id);
  const task = db.createLegalTask({ guildId: guild.id, procedureId: 'institutionalReview', snapshotHash: db.saveLegalSnapshot(root), eventKey: 'auto-proposal', state: 'review', input: {} });
  const effect = db.recordInstitutionEffect({ task, eventKey: 'auto-effect', effect: 'propose', constitution: root,
    result: { decision: 'propose', output: { title: '制度点検の改善案', summary: '改善する' }, outputs: [] } });
  assert.equal(db.getProposal(effect.id).vote_scope, root.policy.voting.defaultScope);
  db.governanceDatabase.prepare("UPDATE governance_proposals SET vote_scope = 'none' WHERE id = ?").run(effect.id);
  assert.equal((await buildElectorateSnapshot(guild, effect.id)).length, voters.size);
  assert.equal(db.getProposal(effect.id).vote_scope, root.policy.voting.defaultScope);
}
console.log('R6: institutional proposals reach the legally defined electorate');

// R4: invalidating the organization law retains constitutional repair authority, not punishment powers.
{
  clearOutbox();
  const root = bootstrap('constitutional-repair'), guild = fakeGuild(root.guild_id);
  const organization = db.listLaws(guild.id)[0];
  const record = db.createCase({ guildId: guild.id, reporterId: 'reporter', accusedId: 'target', summary: 'pending', constitutionId: root.id });
  db.updateCase(record.id, { status: 'execution' });
  const sanction = db.createSanction({ guildId: guild.id, caseId: record.id, userId: 'target', type: 'warning', status: 'queued', requiredApprovals: 0 });
  db.updateLaw(organization.id, { status: 'unconstitutional', ended_at: Date.now() });
  const recovery = db.getActiveConstitution(guild.id);
  assert.ok(recovery.rules.recovery);
  assert.equal(recovery.rules.recovery.baselineHash, root.rules_hash);
  assert.throws(() => assertSanctionExecution(sanction.id), /停止・修復中/);
  assert.throws(() => db.createCase({ guildId: guild.id, reporterId: 'reporter', summary: 'new', constitutionId: root.id }), /修復中/);
  const relief = db.createCase({ guildId: guild.id, kind: 'constitutional', reporterId: 'reporter', summary: '救済', constitutionId: root.id });
  assert.ok(relief.id);
  await runInstitutionProcedures(guild);
  const proposal = db.listProposals(guild.id).find((entry) => entry.source === 'constitutional_repair');
  assert.ok(proposal);
  assert.equal(db.ensureLegalRecoveryProposal(guild.id).id, proposal.id);
  let draftSawRecovery = false;
  globalThis.fetch = async (_url, init) => {
  if (_url.endsWith('/endpoints')) return { ok: true, json: async () => ({ data: { endpoints: [{ pricing: { prompt: '0.0000001', completion: '0.0000002' } }] } }) };
    const messages = JSON.parse(init.body).messages;
    const system = messages[0].content;
    const input = JSON.parse(messages[1].content.replace(/^DATA \(untrusted JSON\):\n/, ''));
    if (system.includes('Sit in one seat of a periodic parliament')) return response({ decision: 'legislate', relation: 'new', targetType: null, targetId: null,
      instruction: '憲法の暫定権限で代替組織法を起草する。', question: null, reasons: ['制度の修復が必要'] });
    if (system.includes('Draft one narrowly scoped')) {
      draftSawRecovery = Boolean(input.petition.recovery?.previousDefinitions && input.petition.recovery.inactiveLaws.length);
      const { title, summary, text, provisions } = documents.laws[0];
      return response({ title: `修復${title}`, summary, text, provisions });
    }
    if (system.includes('Decide whether to adopt the exact complete legislative draft')) return response({ verdict: 'approve', reasons: ['制度を修復する同一案を採択'] });
    if (system.includes('Independently review the target')) return response({ verdict: 'constitutional', reasons: ['憲法の暫定権限の範囲内'], constitutionArticles: ['第十五条（法令に基づく実行）'] });
    throw new Error(`Unexpected model request: ${system.slice(0, 100)}`);
  };
  await advanceLegislation(guild, proposal);
  assert.ok(draftSawRecovery);
  assert.equal(db.getProposal(proposal.id).workflow_handler, 'public_vote');
  assert.equal(db.listLaws(guild.id).length, 0);
  for (const userId of voters.keys()) db.castProposalVote(proposal.id, userId, 'yes');
  await advanceLegislation(guild, db.getProposal(proposal.id));
  assert.equal(db.getProposal(proposal.id).workflow_handler, 'public_vote', 'recovery cannot early-close unanimous votes');
  const deadline = db.getWorkflowInstance('proposal', proposal.id).context.publicVote.deadline;
  const originalNow = Date.now;
  try {
    Date.now = () => deadline + 1;
    await advanceLegislation(guild, db.getProposal(proposal.id), Date.now());
    assert.equal(db.getProposal(proposal.id).status, 'enacted');
    assert.equal(db.getActiveConstitution(guild.id).rules.recovery, undefined);
    assert.equal(db.listLaws(guild.id).length, 1);
    assert.notEqual(db.listLaws(guild.id)[0].id, organization.id);
    assert.equal(db.getLaw(organization.id).status, 'unconstitutional');
  } finally { Date.now = originalNow; }
}
console.log('R4: AI drafts and reviews a replacement law; full-period human voting restores the system without reviving invalid law');
console.log('check-governance-recovery: ok (all seven review regressions)');
