import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const mainPath = `${tmpdir()}/sakana-autonomous-${process.pid}.sqlite`;
const archivePath = `${tmpdir()}/sakana-autonomous-archive-${process.pid}.sqlite`;
for (const path of [mainPath, archivePath]) rmSync(path, { force: true });
process.env.DATABASE_PATH = mainPath;
process.env.ARCHIVE_DB_PATH = archivePath;
process.env.OPENROUTER_API_KEY = 'check';
process.env.GOVERNANCE_MAX_CONCURRENT = '3';
process.env.GOVERNANCE_LAW_API_URL = 'https://laws.example.test';
process.env.GOVERNANCE_LAW_API_TOKEN = 'check-token';
process.env.GOVERNANCE_LAW_SITE_URL = 'https://laws.example.test';

const { loadBootstrapDocuments } = await import('../src/governance/config.js');
const db = await import('../src/governance/db.js');
const rules = await import('../src/governance/rules.js');
const { runParliamentSession } = await import('../src/governance/parliament.js');
const { advanceProposal, castAndPublishVote, processGovernanceOutbox } = await import('../src/governance/service.js');

const { constitution, policy, laws: foundingLaws } = loadBootstrapDocuments({ serverName: 'Parliament Test' });
const compiled = rules.compileConstitution({ content: constitution, laws: foundingLaws });
// --- テスト用サーバー -------------------------------------------------------
const GUILD_ID = 'g-parliament';
db.bootstrapGovernanceGuild({
  guildId: GUILD_ID,
  enactedBy: 'owner',
  trustedRoleId: '',
  enforcementMode: 'shadow',
  constitution,
  policy,
  laws: foundingLaws,
  appealRoleId: 'appeal-role',
  judiciaryRoleId: 'judiciary-role',
  categoryId: 'category',
  parliamentForumId: 'parliament-forum',
  courtForumId: 'court-forum',
  courtChatChannelId: 'court-forum',
  procedureChannelId: 'procedure'
});

const posts = [];
const threads = new Map();

function fakeThread(id, name, starterAuthor = { id: 'member-1', bot: false }) {
  const thread = {
    id,
    name,
    parentId: 'parliament-forum',
    locked: false,
    archived: false,
    createdTimestamp: Date.now(),
    appliedTags: [],
    isThread: () => true,
    fetchStarterMessage: async () => ({
      id: `${id}-starter`,
      content: `${name}をどうにかしてほしい。`,
      author: starterAuthor,
      edit: async () => {}
    }),
    send: async (payload) => {
      posts.push({ threadId: id, ...payload });
      return { id: `${id}-msg-${posts.length}` };
    },
    setAppliedTags: async (tags) => { thread.appliedTags = tags; },
    setLocked: async () => { thread.locked = true; },
    setArchived: async (value) => { thread.archived = value; },
    setName: async (value) => { thread.name = value; }
  };
  threads.set(id, thread);
  return thread;
}

const memberThread = fakeThread('thread-spam', '短時間の連投を止めたい');

const guild = {
  id: GUILD_ID,
  name: 'Parliament Test',
  client: { user: { id: 'bot' } },
  roles: { cache: new Map(), everyone: null },
  members: {
    fetch: async () => new Map([
      ['voter-1', { id: 'voter-1', user: { bot: false }, roles: { cache: new Map() } }],
      ['voter-2', { id: 'voter-2', user: { bot: false }, roles: { cache: new Map() } }]
    ])
  },
  channels: {
    cache: new Map(),
    fetch: async (id) => {
      if (id === 'parliament-forum') {
        return {
          id,
          threads: {
            fetchActive: async () => ({ threads: new Map([...threads].filter(([, thread]) => !thread.archived)) }),
            create: async ({ name, message }) => {
              const created = fakeThread(`thread-ai-${threads.size}`, name, { id: 'bot', bot: true });
              posts.push({ threadId: created.id, starter: true, content: message?.content ?? '' });
              return created;
            }
          },
          availableTags: [
            { id: 'tag-agenda', name: '議題' },
            { id: 'tag-discuss', name: '議論中' },
            { id: 'tag-voting', name: '投票中' },
            { id: 'tag-enacted', name: '成立' },
            { id: 'tag-rejected', name: '不成立' }
          ]
        };
      }
      if (id === 'procedure') {
        return {
          id,
          isTextBased: () => true,
          messages: { fetch: async () => ({ id: 'procedure-msg' }) },
          threads: {
            create: async ({ name }) => {
              const created = fakeThread('minutes', name, { id: 'bot', bot: true });
              return created;
            }
          }
        };
      }
      return threads.get(id) ?? null;
    }
  }
};

let draftCount = 0;
let reviewCount = 0;
let adoptionCount = 0;
let repairNeeded = true;
let alwaysReject = false;
let reviewOutage = false;
const draftInputs = [];
const base = {
  title: '連投制限法', summary: '会話を成立不能にする大量投稿を制限する。',
  text: '第一条 会話を成立不能にする大量投稿を禁止する。',
  provisions: { articles: [{ code: 'A1', text: '会話を成立不能にする大量投稿を禁止する。' }],
    offenses: [{ code: 'O1', title: '大量投稿', elements: ['会話の継続を妨げる大量投稿をしたこと'], sanctions: [{ type: 'warning' }] }], sanctionDefinitions: [] }
};
globalThis.fetch = async (url, init) => {
  if (url.endsWith('/endpoints')) return { ok: true, json: async () => ({ data: { endpoints: [{ pricing: { prompt: '0.0000001', completion: '0.0000002' } }] } }) };
  if (String(url).startsWith('https://laws.example.test')) return new Response(JSON.stringify({ok:true}), {status:200});
  const body = JSON.parse(init.body);
  const system = body.messages[0].content;
  const input = JSON.parse(body.messages[1].content.split('\n').slice(1).join('\n'));
  let output;
  if (system.includes('Sit in one seat of a periodic parliament')) output = {decision:'legislate',relation:'new',targetType:null,targetId:null,instruction:'具体的な会話妨害だけを対象に一般的な法律を起草する。',question:null,reasons:['必要性がある。']};
  else if (system.includes('Draft one narrowly scoped')) {
    draftCount++;
    draftInputs.push(input.petition);
    output = structuredClone(base);
    if (input.petition.previousDraft && !alwaysReject) {
      output.text += '\n第二条 批判および反論はそれだけでは禁止しない。';
      output.provisions.articles.push({code:'A2',text:'批判および反論はそれだけでは禁止しない。'});
    }
  } else if (system.includes('Decide whether to adopt the exact complete legislative draft')) {
    adoptionCount++;
    output = {verdict:'approve',reasons:['この条文と実行定義を採択する。']};
  } else if (system.includes('Independently review the target')) {
    if (reviewOutage) return new Response('outage',{status:503});
    if (body.response_format?.type === 'json_object') reviewCount++;
    const passed = !alwaysReject && (!repairNeeded || input.target.text.includes('第二条'));
    output = {verdict:passed?'constitutional':'unconstitutional', reasons:[passed?'適合する。':'批判や反論への適用を除外すること。'],constitutionArticles:['第三条（言論の自由）']};
  } else if (system.includes('Perform the supplied institution')) output = {decision:'record',title:'点検結果',summary:'現行法の点検を完了した。',reasons:['記録と法令を確認した。']};
  else throw new Error(`Unexpected LLM request: ${system.slice(-160)}`);
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}]}),{status:200});
};
db.updateGovernanceGuild(GUILD_ID, { procedure_message_id: 'procedure-msg' });
const first = await runParliamentSession(guild, db.getGovernanceGuild(GUILD_ID), Date.now(), {manual:true});
const law = db.getProposalByForumThread(memberThread.id);
assert.equal(first.outcomes.find((entry)=>entry.proposalId===law.id)?.decision,'pending');
assert.equal(law.workflow_handler,'public_vote','AIが修正を完了し人間の投票を待つ');
assert.equal(db.listLaws(GUILD_ID).length,1,'投票前には成立させない');
db.castProposalVote(law.id,'voter-1','yes');
db.castProposalVote(law.id,'voter-2','yes');
await advanceProposal(guild,db.getProposal(law.id),Date.now());
assert.equal(db.getProposal(law.id).status,'enacted');
assert.equal(draftCount,2,'憲法審査の指摘でAIが修正する');
assert.equal(adoptionCount,6,'変更後の同じ条文へ採択を取り直す');
assert.equal(reviewCount,6);
assert.ok(draftInputs[1].review.outputs.some((x)=>x.reasons.includes('批判や反論への適用を除外すること。')));
assert.equal(db.proposalElectorate(law.id).length,2);
assert.equal(db.listProposalVotes(law.id).length,2);
assert.equal(db.listLaws(GUILD_ID).length,2);
const count = db.listLaws(GUILD_ID).length;
const { advanceLegislation } = await import('../src/governance/legislation.js');
await advanceLegislation(guild,db.getProposal(law.id));
assert.equal(db.listLaws(GUILD_ID).length,count,'完了済み手続の再実行で二重成立しない');

const rejecting = fakeThread('rejecting','合憲化できない議題');
alwaysReject = true;
const before = draftCount;
await runParliamentSession(guild,db.getGovernanceGuild(GUILD_ID),Date.now(),{manual:true});
const rejected = db.getProposalByForumThread(rejecting.id);
assert.equal(rejected.status,'rejected');
assert.equal(draftCount-before,3,'法律のmaximumVisitsで修正を打ち切る');
assert.equal(db.listLaws(GUILD_ID).length,count);
assert.ok(!posts.some((post)=>String(post.content).includes('意見を聞かせてください')));

const failing = fakeThread('failing','審査席の障害');
alwaysReject = false; repairNeeded = false; reviewOutage = true;
await runParliamentSession(guild,db.getGovernanceGuild(GUILD_ID),Date.now(),{manual:true});
const failed = db.getProposalByForumThread(failing.id);
assert.equal(failed.status,'review','通信障害を否決せず審査段階を保存する');
assert.ok(failed.retry_after>Date.now());
reviewOutage = false;
await advanceLegislation(guild,failed);
assert.equal(db.getProposal(failed.id).workflow_handler,'public_vote','保存した審査を再開し投票へ進む');


// A negative human vote ends the proposal; it is never converted into AI consent.
db.castProposalVote(failed.id, 'voter-1', 'no');
db.castProposalVote(failed.id, 'voter-2', 'no');
await advanceProposal(guild, db.getProposal(failed.id), Date.now());
assert.equal(db.getProposal(failed.id).status, 'rejected');

// Ordinary law may omit its vote, while constitutional amendment minima remain authoritative.
const autonomousLaws = structuredClone(foundingLaws);
const declarations = autonomousLaws[0].provisions.governance;
const ordinary = declarations.find((entry) => entry.key === 'lawProcedure').value;
ordinary.states.review.on.constitutional = 'enact';
delete ordinary.states.vote;
const newInstitution = { name: '制度点検局', mandate: '現行制度の改善点を調査して記録する。', seats: 1, required: { record: 1, propose: 1 }, tools: ['read_constitution'] };
declarations.push({kind:'institution',key:'policyInspector',article:'A5',value:newInstitution});
declarations.push({kind:'procedure',key:'policyInspection',article:'A5',value:{
  name:'制度点検手続',mandate:'法律の成立を受け、制度の点検結果を記録する。',initial:'inspect',config:{},trigger:{event:'law_enacted'},states:{
    inspect:{handler:'agent_task',duration:null,config:{institution:'policyInspector',effect:'record'},on:{completed:'notify'}},
    notify:{handler:'notice',duration:null,config:{text:'制度点検が完了しました。'},on:{completed:'finished'}},
    finished:{handler:'terminal',duration:null,config:{},on:{}}
  }
}});
assert.doesNotThrow(() => rules.compileConstitution({ content: constitution, laws: autonomousLaws }));
const illegal = structuredClone(autonomousLaws);
const amendment = illegal[0].provisions.governance.find((entry) => entry.key === 'constitutionalAmendmentProcedure').value;
amendment.states.review.on.constitutional = 'enact'; delete amendment.states.vote;
assert.throws(() => rules.compileConstitution({content:constitution,laws:illegal}), /requires public amendment voting/);
const staleThread = fakeThread('stale-vote', '制度改正と同時に進む法案');
await runParliamentSession(guild, db.getGovernanceGuild(GUILD_ID), Date.now(), {manual:true});
const staleProposal = db.getProposalByForumThread(staleThread.id);
assert.equal(staleProposal.workflow_handler, 'public_vote');
const oldOrganization = db.listLaws(GUILD_ID).find((entry) => entry.code === 'GOVERNANCE-ORGANIZATION');
const revision = db.createProposal({guildId:GUILD_ID,constitutionId:db.getActiveConstitution(GUILD_ID).id,source:'test',title:'組織法改正',summary:'test',status:'agenda'});
db.enactLaw({guildId:GUILD_ID,proposalId:revision.id,constitutionId:revision.constitution_id,
  code:'ORGANIZATION-2',title:autonomousLaws[0].title,text:autonomousLaws[0].text,provisions:declarations.length && autonomousLaws[0].provisions,
  supersedesLawId:oldOrganization.id,targetHash:oldOrganization.content_hash});
db.updateProposal(revision.id,{status:'enacted'});
const optional = fakeThread('optional-vote','AIへの委任が定められた通常法');
await runParliamentSession(guild,db.getGovernanceGuild(GUILD_ID),Date.now(),{manual:true});
const optionalProposal=db.getProposalByForumThread(optional.id);
assert.equal(optionalProposal.status,'enacted','法令が投票を省略した通常法はAIの職務だけで成立する');
assert.equal(db.listProposalVotes(optionalProposal.id).length,0);
db.castProposalVote(staleProposal.id, 'voter-1', 'yes');
db.castProposalVote(staleProposal.id, 'voter-2', 'yes');
await advanceProposal(guild, db.getProposal(staleProposal.id), Date.now());
assert.equal(db.getProposal(staleProposal.id).status, 'enacted', '旧根拠で成立させず、新法令で自ら再検討して進める');
assert.ok(db.listWorkflowEvents(db.getWorkflowInstance('proposal', staleProposal.id).id).some((entry) => entry.event_type === 'legal.rebased' && entry.payload.votes.length === 2), '以前の票を履歴に保持し新本文へ流用しない');
const {runInstitutionProcedures}=await import('../src/governance/institutions.js');
await runInstitutionProcedures(guild);
assert.ok(db.listLegalTasks(GUILD_ID,{pending:false,now:Date.now()}).some((entry)=>entry.procedure_id==='policyInspection' && entry.status==='completed'));
assert.ok(db.listAudit(GUILD_ID,100).some((entry)=>entry.action==='legislation.enacted'));
// A separate veto holder can stop a law despite unanimous public yes votes.
const currentOrganization=db.listLaws(GUILD_ID).find((entry)=>entry.code==='ORGANIZATION-2');
const vetoDefinitions=structuredClone(currentOrganization.provisions);
const vetoProcedure=vetoDefinitions.governance.find((entry)=>entry.key==='lawProcedure').value;
vetoProcedure.states.vote=structuredClone(foundingLaws[0].provisions.governance.find((entry)=>entry.key==='lawProcedure').value.states.vote);
vetoProcedure.states.review.on.constitutional='vote';
vetoDefinitions.governance.find((entry)=>entry.key==='votes').value.law.humanVeto={scope:'administrators',required:1};
const vetoLawProposal=db.createProposal({guildId:GUILD_ID,constitutionId:revision.constitution_id,source:'test',title:'拒否権を設置',summary:'test',status:'agenda'});
db.enactLaw({guildId:GUILD_ID,proposalId:vetoLawProposal.id,constitutionId:revision.constitution_id,code:'ORGANIZATION-3',
 title:currentOrganization.title,text:currentOrganization.text,provisions:vetoDefinitions,supersedesLawId:currentOrganization.id,targetHash:currentOrganization.content_hash});
db.updateProposal(vetoLawProposal.id,{status:'enacted'});
const realMembers=await guild.members.fetch();
realMembers.get('voter-2').permissions={has:()=>true};
guild.members.fetch=async()=>realMembers;
const vetoThread=fakeThread('law-with-veto','人間の拒否権が適用される法案');
await runParliamentSession(guild,db.getGovernanceGuild(GUILD_ID),Date.now(),{manual:true});
const vetoProposal=db.getProposalByForumThread(vetoThread.id);
assert.equal(vetoProposal.workflow_handler,'public_vote');
assert.deepEqual(db.getWorkflowInstance('proposal',vetoProposal.id).context.publicVote.veto.members,['voter-2']);
db.castProposalVote(vetoProposal.id,'voter-1','yes');
db.castProposalVote(vetoProposal.id,'voter-2','yes');
await advanceProposal(guild,db.getProposal(vetoProposal.id));
assert.equal(db.getProposal(vetoProposal.id).workflow_handler,'public_vote','全員賛成でも拒否期間を短縮しない');
assert.throws(()=>db.castHumanVeto('proposal',vetoProposal.id,'voter-1'),/資格/);
realMembers.get('voter-2').permissions={has:()=>false};
const {exerciseHumanVeto}=await import('../src/governance/service.js');
await assert.rejects(()=>exerciseHumanVeto({guildId:'other',guild,user:{id:'voter-2'}},'proposal',vetoProposal.id),/導入|初期化|サーバー/);
await exerciseHumanVeto({guildId:GUILD_ID,guild,user:{id:'voter-2'}},'proposal',vetoProposal.id);
assert.equal(db.getProposal(vetoProposal.id).status,'rejected','開始時に指定された管理者の拒否権で否決する');
assert.equal(db.proposalVoteSummary(vetoProposal.id).vetoCount,1);
assert.throws(()=>db.castHumanVeto('proposal',vetoProposal.id,'voter-2'),/期間/);
console.log('check-autonomous-governance: ok (public votes and independent human veto)');
