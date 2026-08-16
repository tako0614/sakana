import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const mainPath = `/tmp/sakana-parliament-${process.pid}.sqlite`;
const archivePath = `/tmp/sakana-parliament-archive-${process.pid}.sqlite`;
for (const path of [mainPath, archivePath]) rmSync(path, { force: true });
process.env.DATABASE_PATH = mainPath;
process.env.ARCHIVE_DB_PATH = archivePath;
process.env.GOVERNANCE_API_KEY = 'check';
process.env.GOVERNANCE_MAX_CONCURRENT = '3';
process.env.GOVERNANCE_LAW_API_URL = 'https://laws.example.test';
process.env.GOVERNANCE_LAW_API_TOKEN = 'check-token';
process.env.GOVERNANCE_LAW_SITE_URL = 'https://laws.example.test';

const { loadBootstrapDocuments } = await import('../src/governance/config.js');
const db = await import('../src/governance/db.js');
const rules = await import('../src/governance/rules.js');
const { runParliamentSession } = await import('../src/governance/parliament.js');
const { advanceProposal, castAndPublishVote, processGovernanceOutbox } = await import('../src/governance/service.js');

const { constitution, policy } = loadBootstrapDocuments({ serverName: 'Parliament Test' });
const compiled = rules.compileConstitution({ content: constitution });
assert.equal(compiled.rules.workflows.law.initial, 'agenda');
assert.equal(compiled.rules.workflows.law.states.agenda.handler, 'parliament_agenda');
assert.equal(compiled.rules.workflows.law.states.agenda.on.deferred, 'agenda');
assert.equal(compiled.rules.parliament.maximumDeferrals, 3);
assert.equal(compiled.rules.parliament.sessionInterval, '72h');
assert.deepEqual(compiled.rules.workflows.law.config, {},
  '国会の量的な値はworkflowではなくparliamentセクションが持つ');

// --- 実行規則の安全弁 ------------------------------------------------------
const injected = structuredClone(compiled.rules);
injected.workflows.law.states.agenda.handler = 'eval_user_text';
assert.throws(() => rules.validateGovernanceRules(injected), /未対応のworkflow handler/);

const skipVote = structuredClone(compiled.rules);
skipVote.workflows.law.states.agenda.on.adopted = 'enacted';
assert.throws(() => rules.validateGovernanceRules(skipVote), /public_vote へ進む必要があります|到達不能状態/,
  '国会は投票を飛ばして成立させられない');

const extraOutcome = structuredClone(compiled.rules);
extraOutcome.workflows.law.states.agenda.on.enact = 'enacted';
assert.throws(() => rules.validateGovernanceRules(extraOutcome), /未対応の項目があります/,
  '議題から任意の遷移を足せない');

const looseDeferral = structuredClone(compiled.rules);
looseDeferral.workflows.law.states.agenda.on.deferred = 'voting';
assert.throws(() => rules.validateGovernanceRules(looseDeferral), /継続審議は同じ議題へ戻る/);

// --- テスト用サーバー -------------------------------------------------------
const GUILD_ID = 'g-parliament';
db.bootstrapGovernanceGuild({
  guildId: GUILD_ID,
  enactedBy: 'owner',
  trustedRoleId: '',
  enforcementMode: 'shadow',
  constitution,
  policy,
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
      return threads.get(id) ?? null;
    }
  }
};

// --- AIの応答をHTTP層で差し替える -------------------------------------------
let mode = 'defer';
const drafted = {
  title: '連投制限法',
  summary: '短時間の大量投稿を制限する。',
  text: '第一条 短時間に大量の投稿を繰り返してはならない。',
  provisions: {
    articles: [{ code: 'A1', text: '短時間に大量の投稿を繰り返してはならない。' }],
    offenses: [{
      code: 'O1',
      title: '連投',
      elements: ['60秒以内に10件以上投稿したこと'],
      sanctions: [{ type: 'warning' }]
    }],
    sanctionDefinitions: []
  }
};

let constitutionalVerdict = 'constitutional';
const lawPushes = [];

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.startsWith('https://laws.example.test')) {
    lawPushes.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  const payload = JSON.parse(init.body);
  const system = payload.messages[0].content;
  let output;
  if (system.includes('Sit in one seat of a periodic parliament')) {
    output = mode === 'legislate'
      ? {
        decision: 'legislate',
        relation: 'new',
        targetType: null,
        targetId: null,
        instruction: '短時間の連投を制限する一般的な規則を作る。',
        question: null,
        reasons: ['討論で必要性が確認できた。']
      }
      : mode === 'reject'
        ? {
          decision: 'reject',
          relation: null,
          targetType: null,
          targetId: null,
          instruction: null,
          question: null,
          reasons: ['現行法ですでに扱える。']
        }
        : {
          // 継続審議でも条文の方向まで出す。人間は白紙ではなくたたき台を直す。
          decision: 'defer',
          relation: 'new',
          targetType: null,
          targetId: null,
          instruction: '短時間の連投に一般的な上限を定める。',
          question: null,
          reasons: ['判断材料が足りない。']
        };
    if (mode === 'defer') output.question = '何件までなら許容できますか。';
  } else if (system.includes('Draft one narrowly scoped, general, prospective law')) {
    output = drafted;
  } else if (system.includes('Independently review the target against the supplied constitution')) {
    output = {
      verdict: constitutionalVerdict,
      reasons: ['公共の福祉の範囲に収まる。'],
      constitutionArticles: ['第四条（公共の福祉）']
    };
  } else {
    throw new Error(`unexpected governance call: ${system.slice(0, 80)}`);
  }
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }]
  }), { status: 200 });
};

const agendaState = compiled.rules.workflows.law.initial;

// --- 1回目: 継続審議 --------------------------------------------------------
let governance = db.getGovernanceGuild(GUILD_ID);
let session = await runParliamentSession(guild, governance, Date.now(), { manual: true });
assert.equal(session.agendaCount, 1, '人間が立てたスレを議題として取り込む');
assert.equal(session.outcomes[0].decision, 'defer');
let proposal = db.getProposalByForumThread(memberThread.id);
assert.ok(proposal, '提案スレにproposal行が紐づく');
assert.equal(proposal.status, agendaState, '継続審議では議題のまま');
assert.equal(proposal.deferrals, 1);
assert.equal(proposal.proposer_id, 'member-1');
assert.ok(posts.some((post) => String(post.content).includes('継続審議 (1回目)')));
assert.ok(posts.some((post) => String(post.content).includes('何件までなら許容できますか')),
  '次の国会まで何を聞きたいかを公開する');
assert.ok(posts.some((post) => (post.files ?? []).some((file) => file.name === 'たたき台-法律案.md')),
  '継続審議でも条文のたたき台を出す');
assert.ok(db.getProposal(db.getProposalByForumThread(memberThread.id).id).body,
  'たたき台は提案に保存して次の国会が読み直せるようにする');
assert.ok(db.getGovernanceGuild(GUILD_ID).last_session_at, '開会時刻を記録する');

// --- 周期を待たない開会は起きない -------------------------------------------
governance = db.getGovernanceGuild(GUILD_ID);
assert.equal(await runParliamentSession(guild, governance, Date.now()), null,
  '間隔を満たさない自動開会は何もしない');

// --- 継続審議の上限 ---------------------------------------------------------
const maximumDeferrals = compiled.rules.parliament.maximumDeferrals;
assert.equal(maximumDeferrals, 3);
db.updateProposal(proposal.id, { deferrals: maximumDeferrals });
mode = 'defer';
session = await runParliamentSession(guild, db.getGovernanceGuild(GUILD_ID), Date.now(), { manual: true });
proposal = db.getProposal(proposal.id);
assert.equal(session.outcomes[0].decision, 'error',
  '上限に達した議題でdeferを返した席は無効票になる');
assert.equal(proposal.status, agendaState, '有効な席が必要数そろわないうちは結論を出さない');
assert.equal(proposal.deferrals, maximumDeferrals, '無効票では継続審議の回数も増やさない');

mode = 'reject';
db.updateProposal(proposal.id, { retry_after: null });
session = await runParliamentSession(guild, db.getGovernanceGuild(GUILD_ID), Date.now(), { manual: true });
proposal = db.getProposal(proposal.id);
assert.equal(session.outcomes[0].decision, 'reject', '上限に達した議題は立法か不採択に収束する');
assert.equal(proposal.status, 'rejected');
assert.equal(threads.get(memberThread.id).archived, true, '結論が出たスレはアーカイブする');
assert.equal(threads.get(memberThread.id).locked, true);

// --- 立法 → 投票 → 成立 ----------------------------------------------------
const secondThread = fakeThread('thread-links', 'リンク荒らしを止めたい');
mode = 'legislate';
session = await runParliamentSession(guild, db.getGovernanceGuild(GUILD_ID), Date.now(), { manual: true });
let bill = db.getProposalByForumThread(secondThread.id);
assert.equal(session.outcomes.find((entry) => entry.proposalId === bill.id).decision, 'legislate');
bill = db.getProposal(bill.id);
assert.equal(bill.status, 'voting', '立法を選んだ議題は投票へ進む');
assert.equal(bill.title, drafted.title);
assert.ok(bill.body?.provisions?.offenses?.length === 1);
assert.equal(db.proposalElectorate(bill.id).length, 2, '受付時に有権者を固定する');
assert.ok(posts.some((post) => String(post.content).includes('投票を開始しました')));

for (const userId of ['voter-1', 'voter-2']) {
  await castAndPublishVote({
    guildId: GUILD_ID,
    guild,
    user: { id: userId },
    member: { id: userId }
  }, bill.id, 'yes');
}
bill = db.getProposal(bill.id);
await advanceProposal(guild, bill, Date.now());
bill = db.getProposal(bill.id);
assert.equal(bill.status, 'enacted', '全員投票で締切前に開票して成立する');
const laws = db.listLaws(GUILD_ID);
assert.equal(laws.length, 1);
assert.equal(laws[0].title, drafted.title);
assert.equal(threads.get(secondThread.id).archived, true);

// --- 法令サイトへの押し込み -------------------------------------------------
await processGovernanceOutbox({ guilds: { cache: new Map(), fetch: async () => guild } });
assert.ok(lawPushes.some((entry) => entry.type === 'law' && entry.title === drafted.title),
  '成立した法律をWorkerへ押し込む');
assert.ok(lawPushes.some((entry) => entry.type === 'constitution'), '憲法も公開正本へ載せる');
const pushCount = lawPushes.length;
const { syncLawSite } = await import('../src/governance/lawsite.js');
syncLawSite(guild);
await processGovernanceOutbox({ guilds: { cache: new Map(), fetch: async () => guild } });
assert.equal(lawPushes.length, pushCount, '内容が変わらなければ再送しない');

// --- AI席が落ちた回は継続審議の回数を消費しない -----------------------------
const outageThread = fakeThread('thread-outage', 'AI席が落ちた回の議題');
const workingFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://laws.example.test')) return workingFetch(url, init);
  return new Response('upstream down', { status: 503 });
};
session = await runParliamentSession(guild, db.getGovernanceGuild(GUILD_ID), Date.now(), { manual: true });
globalThis.fetch = workingFetch;
const outage = db.getProposalByForumThread(outageThread.id);
assert.equal(session.outcomes.find((entry) => entry.proposalId === outage.id).decision, 'error');
assert.equal(outage.deferrals, 0, 'AI席が落ちた回は継続審議の回数を消費しない');
assert.equal(outage.status, agendaState);
assert.ok(outage.retry_after > Date.now(), '失敗した議題は次の国会まで待つ');

// --- 憲法適合を確認できない草案は投票へ進めない -----------------------------
const thirdThread = fakeThread('thread-speech', '批判を禁止したい');
constitutionalVerdict = 'unconstitutional';
mode = 'legislate';
session = await runParliamentSession(guild, db.getGovernanceGuild(GUILD_ID), Date.now(), { manual: true });
const blocked = db.getProposalByForumThread(thirdThread.id);
assert.equal(blocked.status, agendaState, '違憲の疑いがある草案は投票にかけない');
assert.equal(blocked.deferrals, 1, '継続審議として次の国会へ送る');
assert.ok(posts.some((post) => String(post.content).includes('憲法適合を確認できませんでした')));

// --- 旧憲法のまま新コードが起動した場合 --------------------------------------
const legacyRules = structuredClone(compiled.rules);
delete legacyRules.panels.parliament;
db.governanceDatabase.prepare('UPDATE governance_constitutions SET rules_json = ? WHERE guild_id = ?')
  .run(JSON.stringify(legacyRules), GUILD_ID);
await assert.rejects(
  runParliamentSession(guild, db.getGovernanceGuild(GUILD_ID), Date.now(), { manual: true }),
  /統治DBを作り直して/,
  '旧手続のままの憲法では議題を作らずに止まる'
);

console.log('check-parliament: ok');
