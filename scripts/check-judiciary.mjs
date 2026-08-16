import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const mainPath = `/tmp/sakana-judiciary-${process.pid}.sqlite`;
const archivePath = `/tmp/sakana-judiciary-archive-${process.pid}.sqlite`;
for (const path of [mainPath, archivePath]) rmSync(path, { force: true });
process.env.DATABASE_PATH = mainPath;
process.env.ARCHIVE_DB_PATH = archivePath;
process.env.GOVERNANCE_API_KEY = 'check';

const { loadBootstrapDocuments } = await import('../src/governance/config.js');
const db = await import('../src/governance/db.js');
const rules = await import('../src/governance/rules.js');
const restrictions = await import('../src/governance/restrictions.js');
const {
  fileCriminalCase, requestTrial, withdrawContest, processGovernanceOutbox
} = await import('../src/governance/service.js');

const { constitution, policy } = loadBootstrapDocuments({ serverName: 'Judiciary Test' });
const compiled = rules.compileConstitution({ content: constitution });

// --- 実行規則の安全弁 ------------------------------------------------------
assert.equal(compiled.rules.panels.police.seats, 1, '警察は速さのため1席');
assert.equal(compiled.rules.panels.court.seats, 3, '裁判所は独立3席');
assert.equal(compiled.rules.sanctions.detention.maximum, '24h');
assert.deepEqual(compiled.rules.sanctions.police.courtFirst, ['kick', 'ban'],
  '追放と参加禁止は警察が実行できない');
assert.equal(compiled.rules.workflows.criminalCase.initial, 'police_review');
assert.deepEqual(
  Object.keys(compiled.rules.workflows.criminalCase.states.contest_window.on).sort(),
  ['contested', 'expired'],
  '不服申立ての窓からは裁判所へ行くか確定するかしかない'
);

const punitive = structuredClone(compiled.rules);
punitive.sanctions.detention.maximum = '48h';
assert.throws(() => rules.validateGovernanceRules(punitive), /24時間を超えられません/);

// --- テスト用サーバー -------------------------------------------------------
const GUILD_ID = 'g-judiciary';
db.bootstrapGovernanceGuild({
  guildId: GUILD_ID,
  enactedBy: 'owner',
  trustedRoleId: 'trusted',
  enforcementMode: 'live',
  constitution,
  policy,
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
      { code: 'O2', title: '重大な荒らし', elements: ['会話を成立不能にしたこと'], sanctions: [{ type: 'ban' }] }
    ],
    sanctionDefinitions: []
  }
});

const posts = [];
const threads = new Map();
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
      : new Map())
  },
  channels: {
    cache: new Map(),
    fetch: async (id) => {
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
globalThis.fetch = async (_url, init) => {
  const payload = JSON.parse(init.body);
  const system = payload.messages[0].content;
  if (!system.includes('Decide only the charged offense')) throw new Error('unexpected call');
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
    sanction: charge
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

console.log('check-judiciary: ok');
