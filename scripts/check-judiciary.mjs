import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const mainPath = `${tmpdir()}/sakana-judiciary-${process.pid}.sqlite`;
const archivePath = `${tmpdir()}/sakana-judiciary-archive-${process.pid}.sqlite`;
for (const path of [mainPath, archivePath]) rmSync(path, { force: true });
process.env.DATABASE_PATH = mainPath;
process.env.ARCHIVE_DB_PATH = archivePath;
process.env.OPENROUTER_API_KEY = 'check';

const { loadBootstrapDocuments } = await import('../src/governance/config.js');
const db = await import('../src/governance/db.js');
const rules = await import('../src/governance/rules.js');
const { normalizeActivityContent, sha256 } = await import('../src/governance/policy.js');
const restrictions = await import('../src/governance/restrictions.js');
const {
  advanceCase, approveCase, fileCriminalCase, requestTrial, withdrawContest, processGovernanceOutbox
} = await import('../src/governance/service.js');

const { constitution, policy, laws } = loadBootstrapDocuments({ serverName: 'Judiciary Test' });
const compiled = rules.compileConstitution({ content: constitution, laws });

// --- 実行規則の安全弁 ------------------------------------------------------
assert.equal(compiled.rules.panels.police.seats, 1, '警察は速さのため1席');
assert.equal(compiled.rules.panels.court.seats, 3, '裁判所は独立3席');
assert.equal(compiled.rules.sanctions.detention.maximum, '24h');
assert.deepEqual(compiled.rules.sanctions.police.courtFirst, ['kick', 'ban'],
  '追放と参加禁止は警察が実行できない');
assert.equal(compiled.rules.workflows.criminalCase.initial, 'police_review');
assert.deepEqual(
  Object.keys(compiled.rules.workflows.criminalCase.states.contest_window.on).sort(),
  ['filing', 'final'],
  '不服申立ての窓からは裁判所へ行くか確定するかしかない'
);

const punitive = structuredClone(compiled.rules);
punitive.sanctions.detention.maximum = '48h';
const invalidLaws = structuredClone(laws);
invalidLaws[0].provisions.governance.find((entry) => entry.kind === 'regulation' && entry.key === 'sanctions').value.detention.maximum = '48h';
assert.throws(() => rules.compileConstitution({ content: constitution, laws: invalidLaws }), /24時間を超えられません/);

// --- テスト用サーバー -------------------------------------------------------
const GUILD_ID = 'g-judiciary';
db.bootstrapGovernanceGuild({
  guildId: GUILD_ID,
  enactedBy: 'owner',
  trustedRoleId: 'trusted',
  enforcementMode: 'live',
  constitution,
  policy,
  laws,
  appealRoleId: 'appeal-role',
  judiciaryRoleId: 'report-role',
  categoryId: 'category',
  parliamentForumId: 'parliament',
  courtForumId: 'court',
  courtChatChannelId: 'court',
  procedureChannelId: 'procedure'
});
const activeConstitution = db.getActiveConstitution(GUILD_ID);
const lawProposal = db.createProposal({
  guildId: GUILD_ID, kind: 'law', source: 'test', title: '連投制限法', summary: 'test',
  constitutionId: activeConstitution.id, status: 'agenda'
});
const law = db.enactLaw({
  guildId: GUILD_ID,
  proposalId: lawProposal.id,
  code: 'LAW-1-R1',
  title: '連投制限法',
  text: '短時間に大量の投稿を繰り返してはならない。',
  constitutionId: activeConstitution.id,
  effectiveAt: Date.now() - 60_000,
  provisions: {
    articles: [{ code: 'A1', text: '短時間に大量の投稿を繰り返してはならない。' }],
    offenses: [
      { code: 'O1', title: '連投', elements: ['短時間に多数投稿したこと'], sanctions: [{ type: 'warning' }] },
      { code: 'O2', title: '重大な荒らし', elements: ['会話を成立不能にしたこと'], sanctions: [{ type: 'ban' }] },
      { code: 'O3', title: '会話妨害', elements: ['会話を止めたこと'], sanctions: [{ type: 'timeout', maximumSeconds: 3600 }] }
    ],
    sanctionDefinitions: []
  }
});

const posts = [];
const threads = new Map();
const publicMessages = new Map();
const publicChannel = {
  id: 'public', name: 'public', type: 0,
  isTextBased: () => true, isThread: () => false,
  permissionsFor: () => ({ has: () => true }),
  messages: { fetch: async (id) => publicMessages.get(id) ?? null }
};
function fakeThread(id) {
  const thread = {
    id, isThread: () => true, locked: false, archived: false, appliedTags: [],
    parent: { availableTags: [] },
    fetchStarterMessage: async () => ({ edit: async () => {} }),
    send: async (payload) => { posts.push({ id, ...payload }); return { id: `${id}-m` }; },
    setAppliedTags: async () => {}, setLocked: async () => { thread.locked = true; },
    setArchived: async (v) => { thread.archived = v; }, setName: async () => {}
  };
  threads.set(id, thread);
  return thread;
}
const procedureThread = fakeThread('enforcement');
const guild = {
  id: GUILD_ID,
  name: 'Judiciary Test',
  client: { user: { id: 'bot' }, guilds: { cache: new Map(), fetch: async () => guild } },
  roles: { cache: new Map(), everyone: { id: GUILD_ID } },
  members: {
    me: { id: 'bot' },
    fetch: async (id) => (typeof id === 'string'
      ? {
        id,
        user: { bot: false },
        roles: { cache: new Map(), remove: async () => {}, add: async () => {} },
        permissions: { has: () => false },
        send: async () => {},
        timeout: async () => {},
        moderatable: true,
        kickable: true,
        bannable: true
      }
      : new Map(['reviewer-1','reviewer-2'].map((id)=>[id,{id,user:{bot:false},roles:{cache:new Map([['trusted',true]])}}])))
  },
  channels: {
    cache: new Map(),
    fetch: async (id) => {
      if (id === 'public') return publicChannel;
      if (id === 'procedure') {
        return {
          id, isTextBased: () => true,
          messages: { fetch: async () => ({ id: 'procedure-msg' }) },
          threads: { create: async () => procedureThread }
        };
      }
      if (id === 'court') {
        return { id, threads: { create: async () => fakeThread(`court-${threads.size}`) }, availableTags: [] };
      }
      return threads.get(id) ?? null;
    }
  }
};
db.updateGovernanceGuild(GUILD_ID, { procedure_message_id: 'procedure-msg' });

// 席は供給された証拠IDだけを引用できるので、stubも実データから組み立てる。
let charge = null;
// 席が調査で見つけたことにする追加記録。null なら何も足さない。
let discoverPlan = null;
globalThis.fetch = async (_url, init) => {
  const payload = JSON.parse(init.body);
  const system = payload.messages[0].content;
  if (!system.includes('Decide only the charged offense')) throw new Error('unexpected call');
  const alreadyInvestigated = payload.messages.some((entry) => entry.role === 'tool');
  if (discoverPlan && payload.tools?.length && !alreadyInvestigated) {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'search_messages',
              arguments: JSON.stringify({ query: discoverPlan.query, days: 30, limit: 20 })
            }
          }]
        }
      }]
    }), { status: 200 });
  }
  const data = JSON.parse(payload.messages[1].content.replace(/^DATA \(untrusted JSON\):\n/, ''));
  const evidenceIds = data.evidence.map((entry) => entry.id);
  const output = {
    verdict: 'responsible',
    lawId: data.law.id,
    offenseCode: data.chargedOffense.code,
    evidenceIds,
    elementFindings: data.chargedOffense.elements.map((element) => ({
      element, proved: true, evidenceIds, reason: '公開記録で確認'
    })),
    reasons: ['公開記録で確認'],
    sanction: charge,
    ...(discoverPlan ? { newRecordIds: discoverPlan.ids } : {})
  };
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }]
  }), { status: 200 });
};
const evidence = {
  messageId: '1', channelId: 'public', authorId: 'accused',
  content: '連投1', occurredAt: Date.now() - 30_000
};

// --- 警察の即時処分は裁判所へ行かない --------------------------------------
charge = { type: 'warning' };
let warned = await fileCriminalCase(guild, { id: 'reporter' }, {
  accused: { id: 'accused' }, lawId: law.id, offenseCode: 'O1',
  summary: '短時間の連投', evidences: [evidence], attemptReserved: true
});
warned = db.getCase(warned.id);
assert.equal(warned.public_thread_id, null, '警察止まりの事件は裁判所にスレを作らない');
await processGovernanceOutbox(guild.client);
assert.ok(posts.some((p) => p.id === "enforcement" && /即時処分/.test(p.content ?? '')),
  '警察の処分は手続の執行記録へ公開する');
assert.ok(posts.some((p) => p.id === 'enforcement' && p.components?.length),
  '執行記録から直接争えるボタンを出す');

// --- 争われて初めて裁判所が開く --------------------------------------------
const warnSanction = db.getCaseSanction(warned.id);
assert.equal(warnSanction.status, 'reviewable');
let contested = await requestTrial(guild, { id: 'accused' }, warnSanction.id);
assert.ok(contested.public_thread_id, '不服申立てで初めて裁判所に事件記録ができる');
assert.equal(contested.status, 'defense');

// --- 取り下げると処分が確定する --------------------------------------------
await withdrawContest(guild, { id: 'accused' }, contested.id);
contested = db.getCase(contested.id);
assert.equal(contested.status, 'final', '取り下げでその場で確定する');
assert.ok(db.listAudit(GUILD_ID, 50).some((row) => row.action === 'contest.withdrawn'),
  '取り下げを監査記録へ残す');

// --- ban は警察が打てず、拘留して裁判所へ送る ------------------------------
charge = { type: 'ban' };
let serious = await fileCriminalCase(guild, { id: 'reporter' }, {
  accused: { id: 'accused2' }, lawId: law.id, offenseCode: 'O2',
  summary: '会話を成立不能にした', evidences: [{ ...evidence, messageId: '2', authorId: 'accused2' }],
  attemptReserved: true
});
serious = db.getCase(serious.id);
assert.equal(serious.status, 'defense', 'banは警察が実行せず裁判所へ送る');
assert.ok(serious.public_thread_id, '送検した事件は裁判所に記録を持つ');
const detention = db.getCaseDetention(serious.id);
assert.ok(detention, '送検した事件では審理の間だけ拘留する');
assert.equal(detention.status, 'active');
assert.ok(detention.duration_seconds <= compiled.policy.judiciary.policeProcedure.detentionMaximumSeconds,
  '拘留は憲法の上限を超えない');
assert.equal(db.getCaseSanction(serious.id).status, 'proposed', 'banは執行待ちにしない');

// --- 拘留中も自分の事件では発言できる --------------------------------------
assert.equal(restrictions.isDetained(GUILD_ID, 'accused2'), true);
let deleted = false;
const outside = {
  id: 'm-outside', guildId: GUILD_ID, author: { id: 'accused2', bot: false, send: async () => {} },
  channelId: 'public', channel: { id: 'public', isThread: () => false },
  delete: async () => { deleted = true; }
};
assert.equal(await restrictions.enforceMessageRestrictions(outside), true);
assert.equal(deleted, true, '拘留中の外部の発言は削除する');
const inside = {
  id: 'm-inside', guildId: GUILD_ID, author: { id: 'accused2', bot: false, send: async () => {} },
  channelId: serious.public_thread_id,
  channel: { id: serious.public_thread_id, isThread: () => true },
  delete: async () => { throw new Error('must not delete'); }
};
assert.equal(await restrictions.enforceMessageRestrictions(inside), false,
  '拘留中も自分の事件記録では反論できる');

// --- 期間つき処分もschemaを通る ---------------------------------------------
// exactKeys の任意キーが効いていないと、durationSeconds を持つ処分が
// すべて「不受理」に落ちる。
charge = { type: 'timeout', durationSeconds: 600 };
let timed = await fileCriminalCase(guild, { id: 'reporter' }, {
  accused: { id: 'accused3' }, lawId: law.id, offenseCode: 'O3',
  summary: '連投で会話を止めた', evidences: [{ ...evidence, messageId: '3', authorId: 'accused3' }],
  attemptReserved: true
});
timed = db.getCase(timed.id);
assert.equal(db.getCaseSanction(timed.id)?.type, 'timeout', '期間つき処分もそのまま受理される');
assert.equal(db.getCaseSanction(timed.id)?.duration_seconds, 600);

// --- 裁判所が見つけた不利な記録は答弁をやり直す ------------------------------
// 憲法第六条6。追加した記録はその場で認定に使わず、示してから期間を開き直す。
charge = { type: 'ban' };
const maximumRedefense = compiled.policy.investigation.maximumRedefense;
assert.equal(maximumRedefense, 1);
for (const [index, content] of ['連投A', '連投B'].entries()) {
  const createdAt = Date.now() - 120_000 + index;
  publicMessages.set(`found-${index}`, {
    id: `found-${index}`, guildId: GUILD_ID, channelId: 'public',
    channel: publicChannel, author: { id: 'accused2', bot: false },
    content, createdTimestamp: createdAt, attachments: new Map()
  });
  db.recordActivity({
    messageId: `found-${index}`,
    guildId: GUILD_ID,
    channelId: 'public',
    parentId: null,
    userId: 'accused2',
    activityDate: '2026-08-16',
    contentHash: sha256(normalizeActivityContent(content)),
    content,
    createdAt
  });
}
const evidenceBefore = db.listCaseEvidence(serious.id).length;
discoverPlan = { query: '連投', ids: ['found-0'] };
db.updateCase(serious.id, { status: 'deliberation' });
await advanceCase(guild, db.getCase(serious.id));
let reopened = db.getCase(serious.id);
assert.equal(reopened.status, 'defense', '不利な記録を足したら答弁期間をやり直す');
assert.equal(reopened.redefense_count, 1, 'やり直した回数を数える');
assert.equal(db.listCaseEvidence(serious.id).length, evidenceBefore + 1,
  '見つけた記録は事件記録へ加えて本人に示す');
assert.ok(posts.some((p) => /反論の機会をやり直します/.test(p.content ?? '')),
  'やり直しの理由を事件記録へ公開する');
assert.ok(db.listAudit(GUILD_ID, 50).some((row) => row.action === 'case.evidence_discovered'),
  '証拠の追加を監査記録へ残す');

// 上限に達したら、席は追加候補を出せず既存の記録だけで判断する。
discoverPlan = { query: '連投', ids: ['found-1'] };
const evidenceAtLimit = db.listCaseEvidence(serious.id).length;
db.updateCase(serious.id, { status: 'deliberation' });
await assert.rejects(() => advanceCase(guild, db.getCase(serious.id)), /AI席がそろいません/);
assert.equal(db.getCase(serious.id).status, 'deliberation', '不正な席の出力を有罪・無罪に読み替えない');
const decided = db.getCase(serious.id);
assert.equal(decided.redefense_count, 1, 'やり直しは憲法の上限を超えない');
assert.equal(db.listCaseEvidence(serious.id).length, evidenceAtLimit,
  '上限後は見つけた記録を採らない');
assert.notEqual(decided.status, 'defense', '上限後は示された証拠だけで判断へ進む');
discoverPlan = null;

// Human execution approval is part of the law-defined procedure.
charge = {type:'ban'};
await advanceCase(guild, db.getCase(serious.id));
let sanction = db.getCaseSanction(serious.id);
if (db.getCase(serious.id).workflow_handler === 'appeal_window') {
  db.updateSanction(sanction.id,{appeal_deadline:Date.now()-1});
  await advanceCase(guild,db.getCase(serious.id));
}
assert.equal(db.getCase(serious.id).workflow_handler,'human_approval');
assert.equal(db.getCaseSanction(serious.id).required_approvals,2);
assert.throws(()=>db.setCaseApproval(serious.id,'reporter','approve'),/資格/,'当事者は承認者になれない');
const reviewInteraction=(id)=>({guild,guildId:GUILD_ID,user:{id},member:{id,user:{bot:false},roles:{cache:new Map([['trusted',true]])}}});
await approveCase(reviewInteraction('reviewer-1'),serious.id,'approve');
assert.equal(db.getCase(serious.id).workflow_handler,'human_approval','1人では執行しない');
await approveCase(reviewInteraction('reviewer-2'),serious.id,'reject');
assert.equal(db.getCaseSanction(serious.id).status,'unavailable','法定の拒否票で執行を取りやめる');
assert.equal(db.getCase(serious.id).workflow_handler,'terminal');
assert.throws(()=>db.setCaseApproval(serious.id,'reviewer-2','approve'),/期限/,'終了後に承認へ変えて執行できない');
// Enacted law changes actual judicial seats, defense duration and state names.
const organization = db.listLaws(GUILD_ID).find((entry) => entry.code === 'GOVERNANCE-ORGANIZATION');
const revised = structuredClone(organization.provisions);
const courtDefinition = revised.governance.find((entry) => entry.kind === 'institution' && entry.key === 'courtInstitution');
courtDefinition.value.seats = 5;
courtDefinition.value.required.responsible = 3;
const caseProcedure = revised.governance.find((entry) => entry.key === 'criminalCaseProcedure').value;
caseProcedure.states.answer = {...caseProcedure.states.defense, duration:'2h'};
delete caseProcedure.states.defense;
for (const state of Object.values(caseProcedure.states)) {
  for (const [outcome,target] of Object.entries(state.on)) if (target === 'defense') state.on[outcome] = 'answer';
}
const changedLawProposal = db.createProposal({guildId:GUILD_ID,constitutionId:activeConstitution.id,source:'test',title:'裁判所の構成変更',summary:'test',status:'agenda'});
db.enactLaw({guildId:GUILD_ID,proposalId:changedLawProposal.id,constitutionId:activeConstitution.id,code:'ORGANIZATION-2',
  title:organization.title,text:organization.text,provisions:revised,supersedesLawId:organization.id,targetHash:organization.content_hash});
assert.equal(db.constitutionForSubject('case',db.getCase(serious.id)).rules.panels.court.seats,3,'旧事件の席数は改正後も固定');
db.updateGovernanceGuild(GUILD_ID,{enforcement_mode:'shadow'});
async function readyApproval(accused) {
  const record = await fileCriminalCase(guild,{id:'reporter'},{accused:{id:accused},lawId:law.id,offenseCode:'O2',summary:accused,
    evidences:[{...evidence,messageId:accused,authorId:accused}],attemptReserved:true});
  assert.equal(db.getWorkflowInstance('case',record.id).current_state,'answer');
  assert.ok(record.defense_until-Date.now()<=2*3600000 && record.defense_until-Date.now()>2*3600000-10000,'法律の答弁期間を使う');
  db.updateCase(record.id,{status:'deliberation'});
  await advanceCase(guild,db.getCase(record.id));
  assert.equal(db.listCaseDecisions(record.id,'trial').length,5,'改正法の5席で実際に審理する');
  const sanction = db.getCaseSanction(record.id);
  if (db.getCase(record.id).workflow_handler === 'appeal_window') {
    db.updateSanction(sanction.id,{appeal_deadline:Date.now()-1});
    await advanceCase(guild,db.getCase(record.id));
  }
  assert.equal(db.getCase(record.id).workflow_handler,'human_approval');
  return db.getCase(record.id);
}
const approvedCase = await readyApproval('approved-person');
await approveCase(reviewInteraction('reviewer-1'),approvedCase.id,'approve');
await approveCase(reviewInteraction('reviewer-2'),approvedCase.id,'approve');
assert.equal(db.getCase(approvedCase.id).workflow_handler,'sanction_execution');
await processGovernanceOutbox(guild.client);
assert.equal(db.getCaseSanction(approvedCase.id).status,'simulated','必要な人間の承認を得た後にだけ執行する');
const expiredCase = await readyApproval('expired-person');
const approvalDeadline=db.getWorkflowInstance('case',expiredCase.id).context.approval.deadline;
await advanceCase(guild,expiredCase,approvalDeadline+1);
assert.equal(db.getCaseSanction(expiredCase.id).status,'unavailable','承認なしの期限満了では執行しない');
assert.equal(db.getCase(expiredCase.id).workflow_handler,'terminal');
// Approval and veto powers can belong to separate, law-selected humans.
const { validateHumanAuthority, selectHumanMembers } = await import('../src/governance/human-authority.js');
assert.throws(() => validateHumanAuthority({scope:'designated'}), /指定/);
assert.throws(() => validateHumanAuthority({scope:'administrators',users:['11111111111111111']}), /Discord ID/);
const humanMembers = new Map([
  ['admin-one',{id:'admin-one',user:{bot:false},roles:{cache:new Map()},permissions:{has:()=>true}}],
  ['admin-two',{id:'admin-two',user:{bot:false},roles:{cache:new Map()},permissions:{has:()=>true}}],
  ['11111111111111111',{id:'11111111111111111',user:{bot:false},roles:{cache:new Map()},permissions:{has:()=>false}}],
  ['22222222222222222',{id:'22222222222222222',user:{bot:false},roles:{cache:new Map([['33333333333333333',true]])},permissions:{has:()=>false}}],
  ['bot-admin',{id:'bot-admin',user:{bot:true},roles:{cache:new Map()},permissions:{has:()=>true}}]
]);
assert.deepEqual(selectHumanMembers(humanMembers,{scope:'operators'},{guild,operators:['admin-one']}),['admin-one']);
const originalFetch = guild.members.fetch;
guild.members.fetch = async (id) => typeof id === 'string' ? originalFetch(id) : humanMembers;
const priorOrganization = db.listLaws(GUILD_ID).find((entry)=>entry.code==='ORGANIZATION-2');
const humanLaw = structuredClone(priorOrganization.provisions);
const humanProcedure = humanLaw.governance.find((entry)=>entry.key==='criminalCaseProcedure').value;
Object.assign(humanProcedure.states.approval.config,{scope:'administrators',rejectVotes:0,
  veto:{scope:'designated',users:['11111111111111111'],roles:['33333333333333333'],required:2}});
const humanProposal = db.createProposal({guildId:GUILD_ID,constitutionId:activeConstitution.id,source:'test',title:'人間の権限',summary:'test',status:'agenda'});
db.enactLaw({guildId:GUILD_ID,proposalId:humanProposal.id,constitutionId:activeConstitution.id,code:'ORGANIZATION-3',
 title:priorOrganization.title,text:priorOrganization.text,provisions:humanLaw,supersedesLawId:priorOrganization.id,targetHash:priorOrganization.content_hash});
const vetoCase=await readyApproval('veto-person');
let humanPeriod=db.getWorkflowInstance('case',vetoCase.id).context.approval;
assert.deepEqual(humanPeriod.members,['admin-one','admin-two']);
assert.deepEqual(humanPeriod.veto.members,['11111111111111111','22222222222222222']);
assert.throws(()=>db.setCaseApproval(vetoCase.id,'11111111111111111','approve'),/資格/,'拒否権だけの人は承認者にならない');
assert.throws(()=>db.castHumanVeto('case',vetoCase.id,'admin-one'),/資格/,'管理者でも拒否権の指定がなければ行使できない');
await approveCase(reviewInteraction('admin-one'),vetoCase.id,'approve');
await approveCase(reviewInteraction('admin-two'),vetoCase.id,'approve');
assert.equal(db.getCase(vetoCase.id).workflow_handler,'human_approval','承認が集まっても拒否期間を飛ばさない');
humanMembers.get('22222222222222222').roles.cache.clear();
assert.equal(db.castHumanVeto('case',vetoCase.id,'11111111111111111').count,1);
assert.equal(db.castHumanVeto('case',vetoCase.id,'11111111111111111').count,1,'同じ人の拒否を二重計上しない');
const { exerciseHumanVeto } = await import('../src/governance/service.js');
await exerciseHumanVeto(reviewInteraction('22222222222222222'),'case',vetoCase.id);
assert.equal(db.getCaseSanction(vetoCase.id).status,'unavailable','開始時に保存した拒否権の必要人数で執行を止める');
assert.throws(()=>db.castHumanVeto('case',vetoCase.id,'11111111111111111'),/期間/);
const afterVetoWindow=await readyApproval('veto-window-person');
await approveCase(reviewInteraction('admin-one'),afterVetoWindow.id,'approve');
await approveCase(reviewInteraction('admin-two'),afterVetoWindow.id,'approve');
humanPeriod=db.getWorkflowInstance('case',afterVetoWindow.id).context.approval;
const realNow=Date.now;
Date.now=()=>humanPeriod.deadline+1;
try {
  await advanceCase(guild,db.getCase(afterVetoWindow.id));
  await processGovernanceOutbox(guild.client);
  assert.equal(db.getCaseSanction(afterVetoWindow.id).status,'simulated','拒否期間満了後、承認がそろった処分を執行する');
} finally { Date.now=realNow; }
// Zero required approvals must not remove an independently granted veto.
const vetoOrganization=db.listLaws(GUILD_ID).find((entry)=>entry.code==='ORGANIZATION-3');
const vetoOnlyLaw=structuredClone(vetoOrganization.provisions);
vetoOnlyLaw.governance.find((entry)=>entry.key==='sanctions').value.approvals.ban=0;
const vetoOnlyProposal=db.createProposal({guildId:GUILD_ID,constitutionId:activeConstitution.id,source:'test',title:'拒否期間を残した承認免除',summary:'test',status:'agenda'});
db.enactLaw({guildId:GUILD_ID,proposalId:vetoOnlyProposal.id,constitutionId:activeConstitution.id,code:'ORGANIZATION-4',
  title:vetoOrganization.title,text:vetoOrganization.text,provisions:vetoOnlyLaw,supersedesLawId:vetoOrganization.id,targetHash:vetoOrganization.content_hash});
const vetoOnlyCase=await readyApproval('veto-only-person');
await advanceCase(guild,db.getCase(vetoOnlyCase.id));
assert.equal(db.getCaseSanction(vetoOnlyCase.id).required_approvals,0);
assert.equal(db.getCase(vetoOnlyCase.id).workflow_handler,'human_approval','承認人数0でも独立した拒否期間を確保する');
assert.equal(db.legalApprovalResult(vetoOnlyCase.id).passed,false);
assert.throws(()=>validateHumanAuthority({scope:'administrators',required:0},{veto:true}),/必要人数/);
console.log('check-judiciary: ok (law-selected human approval and veto)');
