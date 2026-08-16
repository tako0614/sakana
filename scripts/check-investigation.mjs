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
const hugeOutput = structuredClone(compiled.rules);
hugeOutput.investigation.maximumOutputKilobytes.court = 9999;
assert.throws(() => rules.validateGovernanceRules(hugeOutput), /maximumOutputKilobytes/,
  '1審議で受け取れる調査結果の総量にも技術上限がある');
assert.equal(investigation.publicRecord, 'none',
  '調査の箇条書きは既定で公開しない（理由文が語る）');

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

// --- 累計出力予算 -----------------------------------------------------------
// ツールループは毎リクエストで配列を丸ごと再送するので、総量を固定しないと
// 1件あたりの費用が青天井になる。
{
  const toolset = tools.buildToolset({
    guildId: GUILD_ID, allowed: investigation.tools.police, maximumOutputBytes: 300
  });
  const first = await toolset.run('search_messages', { query: '連投テスト', days: 7 });
  assert.equal(first.length, 6, '予算内では通常どおり返す');
  assert.ok(toolset.spentBytes > 300, '返した分だけ予算を消費する');
  const spent = await toolset.run('search_messages', { query: '連投テスト', days: 7 });
  assert.match(spent.error, /budget spent/, '予算を使い切ったらツールを閉じて結論へ行かせる');
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

// --- 実時間の上限 -----------------------------------------------------------
// 手数と総量だけでは審議時間が決まらない。1手が遅ければ席は何十分でも粘れる。
{
  assert.deepEqual(Object.keys(investigation.maximumMinutes).sort(), ['court', 'parliament', 'police'],
    '調査に費やせる時間も憲法が役割ごとに定める');
  const slow = structuredClone(compiled.rules);
  slow.investigation.maximumMinutes.parliament = 999;
  assert.throws(() => rules.validateGovernanceRules(slow), /maximumMinutes/,
    '審議時間の技術上限はコードが固定する');

  plan = Array.from({ length: 20 }, () => ({
    name: 'search_messages', arguments: { query: '連投テスト', days: 7 }
  }));
  conclusion = candidate(['burst-0'], ['burst-1']);
  const outer = globalThis.fetch;
  // 1手ごとに遅いproviderを模す。手数の上限より先に時間の上限が来る。
  // 憲法が許す最短の時間予算は1分。1手あたり9秒かかるproviderなら、20手を
  // 使い切るより先に時間で打ち切られる。
  globalThis.fetch = async (url, options) => {
    if (JSON.parse(options.body).tools?.length) await new Promise((r) => setTimeout(r, 9_000));
    return outer(url, options);
  };
  const started = Date.now();
  const timed = await screenJudicialMention({
    guildId: GUILD_ID,
    request: { text: '連投がひどい', authorId: 'reporter' },
    constitution: db.getActiveConstitution(GUILD_ID),
    activeLaws: [law],
    recentCases: [],
    panel: compiled.rules.panels.judicialScreening,
    investigation: { ...investigation, maximumMinutes: { ...investigation.maximumMinutes, police: 1 } , maximumSteps: { ...investigation.maximumSteps, police: 20 } }
  });
  globalThis.fetch = outer;
  assert.equal(timed.outputs.length, 3, '時間で打ち切っても結論だけは必ず取る');
  assert.ok(
    timed.traces.every(({ trace }) => trace.length < 20),
    '手数を使い切る前に時間で打ち切る'
  );
  const elapsed = Date.now() - started;
  console.log(`  [計測] 時間で打ち切るまで ${Math.round(elapsed / 1000)}秒 / 手数 ${timed.traces[0].trace.length}`);
  assert.ok(elapsed < 90_000, '上限を大きく超えて粘らない');
}

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

// --- 1席あたりの入力量 -------------------------------------------------------
// ツールループはmessages配列を毎回再送するので、DATAに憲法全文を積むと手数+1回ぶん
// 再送される。ここが膨らむと1件あたりの費用が二乗で効く。
{
  plan = Array.from({ length: 20 }, () => ({
    name: 'search_messages', arguments: { query: '連投テスト', days: 7, limit: 25 }
  }));
  conclusion = candidate(['burst-0'], ['burst-1']);
  let largestRequest = 0;
  let totalRequest = 0;
  const outer = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    largestRequest = Math.max(largestRequest, options.body.length);
    totalRequest += options.body.length;
    return outer(url, options);
  };
  await screen();
  globalThis.fetch = outer;
  const perSeat = Math.round(totalRequest / 3 / 1024);
  console.log(`  [計測] 最大リクエスト ${Math.round(largestRequest / 1024)}KB / 1席あたり合計 ${perSeat}KB / 3席 ~${Math.round(totalRequest / 3.5 / 1000)}k tokens`);
  // 守りたいのは総量の絶対値ではなく形。ツール結果を畳まないと1リクエストが
  // 手数に比例して膨らみ、費用が二乗で効く。畳めば最大リクエストは手数に
  // よらず頭打ちになる。
  assert.ok(largestRequest < 40 * 1024,
    `畳めていない。手数を増やすと1リクエストが膨らんでいる: ${Math.round(largestRequest / 1024)}KB`);
}

// --- 憲法はツールで読む（DATAへ毎回積まない） --------------------------------
{
  const toolset = tools.buildToolset({ guildId: GUILD_ID, allowed: investigation.tools.parliament });
  const index = await toolset.run('read_constitution', {});
  assert.ok(Array.isArray(index.headings) && index.headings.length > 10, '見出しの目次を返す');
  const article = await toolset.run('read_constitution', { heading: index.headings.find((h) => h.startsWith('第八条')) });
  assert.match(article.text, /立法/, '見出しを指定すればその条文だけ返す');
  const missing = await toolset.run('read_constitution', { heading: '第九十九条' });
  assert.match(missing.error, /unknown heading/, '存在しない見出しは拒否して目次を返す');
}

console.log('check-investigation: ok');
