// 席が自分で調べてから判断する経路の検査。
// providerのfunction callingをstubして、実際のツール実装とDBを通す。
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const mainPath = `/tmp/sakana-investigation-${process.pid}.sqlite`;
const archivePath = `/tmp/sakana-investigation-archive-${process.pid}.sqlite`;
for (const path of [mainPath, archivePath]) rmSync(path, { force: true });
process.env.DATABASE_PATH = mainPath;
process.env.ARCHIVE_DB_PATH = archivePath;
process.env.GOVERNANCE_API_KEY = 'check';

const { loadBootstrapDocuments } = await import('../src/governance/config.js');
const db = await import('../src/governance/db.js');
const rules = await import('../src/governance/rules.js');
const tools = await import('../src/governance/tools.js');
const { screenJudicialMention } = await import('../src/governance/llm.js');

const { constitution, policy } = loadBootstrapDocuments({ serverName: 'Investigation Test' });
const compiled = rules.compileConstitution({ content: constitution });
const investigation = compiled.policy.investigation;

// --- 実行規則の安全弁 ------------------------------------------------------
assert.deepEqual(
  Object.keys(investigation.maximumSteps).sort(),
  ['court', 'parliament', 'police'],
  '調査の手数は役割ごとに憲法が定める'
);
assert.ok(
  investigation.tools.police.every((name) => rules.IMPLEMENTED_TOOLS.includes(name)),
  '憲法が列挙する調査手段はすべて実装がある'
);
assert.ok(
  !investigation.tools.police.includes('read_case_record'),
  '警察は事件記録を持たないので事件記録ツールを持たない'
);
const unknownTool = structuredClone(compiled.rules);
unknownTool.investigation.tools.police.push('exec_shell');
assert.throws(() => rules.validateGovernanceRules(unknownTool), /未実装の調査手段/,
  '実装のない調査手段を憲法に書いても受理しない');
const hugeBudget = structuredClone(compiled.rules);
hugeBudget.investigation.maximumSteps.police = 999;
assert.throws(() => rules.validateGovernanceRules(hugeBudget), /maximumSteps/,
  '手数の技術上限はコードが固定する');

// --- 許可リスト -------------------------------------------------------------
const GUILD_ID = 'g-investigation';
{
  const toolset = tools.buildToolset({ guildId: GUILD_ID, allowed: investigation.tools.police });
  const names = toolset.definitions.map((entry) => entry.function.name);
  assert.deepEqual(names.slice().sort(), investigation.tools.police.slice().sort(),
    '席へ渡すのは憲法が許した手段だけ');
  const refused = await toolset.run('read_case_record', '{}');
  assert.match(refused.error, /not permitted/, '許可外の手段は実行前に拒否する');
  assert.equal(toolset.steps, 1, '拒否も手数として記録する');
  const broken = await toolset.run('search_messages', '{not json');
  assert.match(broken.error, /JSON/, '壊れた引数は拒否する');
}

// --- テスト用サーバーとログ -------------------------------------------------
db.bootstrapGovernanceGuild({
  guildId: GUILD_ID,
  enactedBy: 'owner',
  trustedRoleId: 'trusted',
  enforcementMode: 'shadow',
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
const proposal = db.createProposal({
  guildId: GUILD_ID, kind: 'law', source: 'test', title: '連投制限法', summary: 'test',
  constitutionId: activeConstitution.id, status: 'agenda'
});
const law = db.enactLaw({
  guildId: GUILD_ID,
  proposalId: proposal.id,
  code: 'LAW-1-R1',
  title: '連投制限法',
  text: '短時間に大量の投稿を繰り返してはならない。',
  constitutionId: activeConstitution.id,
  effectiveAt: Date.now() - 86_400_000,
  provisions: {
    articles: [{ code: 'A1', text: '短時間に大量の投稿を繰り返してはならない。' }],
    offenses: [{
      code: 'O1',
      title: '連投',
      elements: ['短時間に多数投稿したこと', '会話を妨げたこと'],
      sanctions: [{ type: 'warning' }]
    }],
    sanctionDefinitions: []
  }
});
const base = Date.now() - 3_600_000;
for (let index = 0; index < 6; index += 1) {
  db.recordActivity({
    messageId: `burst-${index}`,
    guildId: GUILD_ID,
    channelId: 'public',
    parentId: null,
    userId: 'accused',
    activityDate: '2026-08-16',
    contentHash: `burst-hash-${index}`,
    content: `連投テスト ${index}`,
    createdAt: base + index * 1000
  });
}

// --- providerのstub ---------------------------------------------------------
// plan: 各席が返すツール呼び出しの列。空なら調査せずに結論だけ返す。
let plan = [];
let conclusion = null;
let failTools = false;
let requestCount = 0;
const toolCallCounts = [];
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  requestCount += 1;
  if (body.tools?.length) {
    if (failTools) return new Response('tools unsupported', { status: 400 });
    const used = body.messages.filter((entry) => entry.role === 'tool').length;
    toolCallCounts.push(used);
    const next = plan[used];
    if (next) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: `call-${used}`,
              type: 'function',
              function: { name: next.name, arguments: JSON.stringify(next.arguments) }
            }]
          }
        }]
      }), { status: 200 });
    }
  }
  const data = JSON.parse(body.messages[1].content.replace(/^DATA \(untrusted JSON\):\n/, ''));
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(conclusion(data)) }, finish_reason: 'stop' }]
  }), { status: 200 });
};

const candidate = (first, second) => () => ({ candidates: [{
  accusedId: 'accused',
  lawId: law.id,
  offenseCode: 'O1',
  summary: '短時間の連投',
  elementEvidence: [
    { element: '短時間に多数投稿したこと', messageIds: first, reason: '公開記録で確認' },
    { element: '会話を妨げたこと', messageIds: second, reason: '会話が流れた' }
  ],
  reasons: ['公開記録で確認']
}] });

const screen = () => screenJudicialMention({
  guildId: GUILD_ID,
  request: { text: '連投がひどい', authorId: 'reporter' },
  constitution: db.getActiveConstitution(GUILD_ID),
  activeLaws: [law],
  recentCases: [],
  panel: compiled.rules.panels.judicialScreening,
  investigation
});

// --- 席が自分で調べて事件化する ---------------------------------------------
plan = [{ name: 'search_messages', arguments: { query: '連投テスト', days: 7, limit: 20 } }];
conclusion = candidate(['burst-0', 'burst-1'], ['burst-2']);
let panel = await screen();
assert.equal(panel.outputs.length, 3, '3席とも調査して結論を出す');
assert.equal(panel.candidates.length, 1, '必要席が揃えば事件化候補になる');
assert.ok(
  panel.traces.every(({ trace }) => trace.some((entry) => entry.tool === 'search_messages' && entry.count === 6)),
  '席は自分の検索で実際のログを取得している'
);
assert.ok(panel.retrieved.has('burst-0'), '取得した記録は完全な行として残る');
assert.equal(panel.retrieved.get('burst-0').contentHash, 'burst-hash-0',
  '証拠の改ざん検知に使うhashを保持する');
assert.ok(
  db.listInvestigationSteps(
    db.governanceDatabase.prepare(
      "SELECT id FROM governance_ai_calls WHERE purpose = 'investigation.judiciary_screening' ORDER BY id LIMIT 1"
    ).get().id
  ).length >= 1,
  '調査の往復は監査表に残る'
);

// --- 取得していないIDは引用できない -----------------------------------------
conclusion = candidate(['burst-0'], ['never-retrieved']);
panel = await screen();
assert.equal(panel.outputs.length, 0, '自分で取得していない記録を引用した席は無効になる');
assert.equal(panel.candidates.length, 0, '幻の証拠では事件化しない');

// --- 席ごとに違う証拠でも要件が埋まれば事件化する ----------------------------
let seatIndex = 0;
conclusion = (data) => {
  const first = data.panelSeat === 1 ? ['burst-0'] : data.panelSeat === 2 ? ['burst-1'] : ['burst-2'];
  seatIndex += 1;
  return candidate(first, ['burst-3'])();
};
plan = [{ name: 'search_messages', arguments: { query: '連投テスト', days: 7, limit: 20 } }];
panel = await screen();
assert.equal(panel.candidates.length, 1, '証拠が席ごとに違っても要件が埋まれば事件化する');
assert.deepEqual(
  panel.candidates[0].elementEvidence[0].messageIds.slice().sort(),
  ['burst-0', 'burst-1', 'burst-2'],
  '構成要件の証拠は賛成した席の和集合になる'
);
assert.ok(seatIndex >= 3);

// --- 手数の上限で打ち切っても結論は取る -------------------------------------
plan = Array.from({ length: 40 }, (_, index) => ({
  name: 'search_messages',
  arguments: { query: `連投テスト ${index % 6}`, days: 7, limit: 5 }
}));
conclusion = candidate(['burst-0'], ['burst-1']);
toolCallCounts.length = 0;
panel = await screen();
assert.equal(panel.outputs.length, 3, '手数を使い切っても結論だけは必ず取る');
assert.ok(
  panel.traces.every(({ trace }) => trace.length === investigation.maximumSteps.police),
  `調査は憲法の手数 ${investigation.maximumSteps.police} で打ち切る`
);

// --- providerがツールを扱えない場合 -----------------------------------------
failTools = true;
plan = [{ name: 'search_messages', arguments: { query: '連投テスト', days: 7, limit: 20 } }];
conclusion = candidate([], []);
requestCount = 0;
panel = await screen();
assert.equal(panel.failedSeats, 3,
  'ツールが使えなければ証拠を引用できず、席は不受理側へ倒れる');
assert.ok(requestCount >= 6, 'ツール段が落ちても結論段は呼ぶ');
failTools = false;

console.log('check-investigation: ok');
