import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const mainPath = `/tmp/sakana-statutes-${process.pid}.sqlite`;
const archivePath = `/tmp/sakana-statutes-archive-${process.pid}.sqlite`;
for (const path of [mainPath, archivePath]) rmSync(path, { force: true });
process.env.DATABASE_PATH = mainPath;
process.env.ARCHIVE_DB_PATH = archivePath;
process.env.GOVERNANCE_API_KEY = 'check';

const { loadBootstrapDocuments } = await import('../src/governance/config.js');
const governanceDb = await import('../src/governance/db.js');
const { handleStatuteRequest, startStatuteServer } = await import('../src/governance/http.js');
const { apiTarget } = await import('../statutes/worker/index.js');
const {
  formatDate, lawPath, outlineBlocks, parseRoute, splitConstitutionContent, statusLabel
} = await import('../statutes/public/lib.js');

const { constitution, policy } = loadBootstrapDocuments({ serverName: 'Test Community' });
governanceDb.bootstrapGovernanceGuild({
  guildId: '100000000000000001',
  enactedBy: 'owner',
  trustedRoleId: 'trusted-role',
  appealRoleId: 'appeal-role',
  categoryId: 'category',
  parliamentForumId: 'parliament',
  courtForumId: 'court',
  courtChatChannelId: 'court-chat',
  statuteForumId: 'statutes',
  procedureChannelId: 'procedure',
  enforcementMode: 'shadow',
  constitution,
  policy
});
const guildId = '100000000000000001';
const constitutionId = governanceDb.getActiveConstitution(guildId).id;
const provisions = {
  articles: [{ code: 'A1', text: '公開チャンネルで同じ文面を連続して投稿してはならない。' }],
  offenses: [{
    code: 'O1', title: '連続投稿', elements: ['短時間に同じ文面を投稿したこと'],
    sanctions: [{ type: 'timeout', maximumSeconds: 600 }],
    interimProtection: null, automaticTrigger: null
  }],
  sanctionDefinitions: []
};
const first = governanceDb.enactLaw({
  guildId, proposalId: 1, code: 'LAW-1', title: '連続投稿規制法', text: '連続投稿を制限する。',
  provisions, constitutionId, effectiveAt: 1_700_000_000_000
});
const second = governanceDb.enactLaw({
  guildId, proposalId: 2, code: 'LAW-1', title: '連続投稿規制法', text: '連続投稿を制限する。適用範囲を狭くした。',
  provisions, constitutionId, effectiveAt: 1_700_100_000_000, supersedesLawId: first.id
});
governanceDb.enactLaw({
  guildId, proposalId: 3, code: 'LAW-2', title: '記録公開法', text: '統治の記録を公開する。',
  provisions: { articles: [{ code: 'B1', text: '公権力の行為を記録し公開する。' }], offenses: [], sanctionDefinitions: [] },
  constitutionId, effectiveAt: 1_700_200_000_000
});

const call = (path, query = '') => handleStatuteRequest({
  method: 'GET', path, query: new URLSearchParams(query)
});

assert.equal(call('/api/health').status, 200);
assert.equal(handleStatuteRequest({ method: 'POST', path: '/api/health' }).status, 405,
  '読み取り専用APIは書き込みmethodを受け付けない');
assert.deepEqual(call('/api/guilds').body.guilds, [{ guildId, laws: 2, constitutionVersion: 1 }]);
assert.equal(call('/api/guilds/999/laws').status, 404, '未登録のサーバーは引けない');

const activeList = call(`/api/guilds/${guildId}/laws`).body;
assert.equal(activeList.total, 2, '現行法だけを一覧に出す');
assert.deepEqual(activeList.laws.map((law) => law.title), ['記録公開法', '連続投稿規制法']);
assert.equal(activeList.laws.every((law) => law.status === 'active'), true);

const allList = call(`/api/guilds/${guildId}/laws`, 'status=all').body;
assert.equal(allList.total, 3, '旧版も status=all で読める');

assert.deepEqual(
  call(`/api/guilds/${guildId}/laws`, 'q=記録').body.laws.map((law) => law.title),
  ['記録公開法'],
  '題名で検索できる'
);
assert.deepEqual(
  call(`/api/guilds/${guildId}/laws`, 'q=適用範囲&status=all').body.laws.map((law) => law.version),
  [2],
  '本文で検索できる'
);
assert.deepEqual(
  call(`/api/guilds/${guildId}/laws`, 'q=公権力').body.laws.map((law) => law.title),
  ['記録公開法'],
  '条文で検索できる'
);
assert.equal(call(`/api/guilds/${guildId}/laws`, 'limit=1').body.laws.length, 1);

const detail = call(`/api/guilds/${guildId}/laws/${second.id}`).body;
assert.equal(detail.version, 2);
assert.equal(detail.currentVersion, 2);
assert.equal(detail.constitutionVersion, 1);
assert.deepEqual(detail.versions.map((version) => version.version), [1, 2], '沿革を版順で返す');
assert.equal(detail.provisions.articles[0].code, 'A1');
assert.ok(detail.contentHash);
assert.equal(JSON.stringify(detail).includes('proposal_id'), false, '案件の内部IDを外へ出さない');

const oldVersion = call(`/api/guilds/${guildId}/laws/${second.id}/versions/1`).body;
assert.equal(oldVersion.version, 1);
assert.equal(oldVersion.status, 'superseded');
assert.equal(call(`/api/guilds/${guildId}/laws/${second.id}/versions/9`).status, 404);
assert.equal(call(`/api/guilds/${guildId}/laws/9999`).status, 404);

const constitutionBody = call(`/api/guilds/${guildId}/constitution`).body;
assert.equal(constitutionBody.version, 1);
assert.match(constitutionBody.content, /^# Test Community憲法/);
assert.equal(call(`/api/guilds/${guildId}/constitutions`).body.constitutions.length, 1);
assert.equal(call(`/api/guilds/${guildId}/constitutions/1`).body.version, 1);
assert.equal(call(`/api/guilds/${guildId}/constitutions/2`).status, 404);

for (const path of [
  `/api/guilds/${guildId}/proposals`,
  `/api/guilds/${guildId}/cases`,
  `/api/guilds/${guildId}/votes`,
  '/api/activity'
]) {
  assert.equal(call(path).status, 404, `未成立の記録は公開しない: ${path}`);
}

assert.throws(() => startStatuteServer({ port: 0 }), /tokenなしで起動できません/,
  'tokenなしでは法令APIを開かない');
const server = startStatuteServer({ port: 0, token: 'secret-token' });
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const unauthorized = await fetch(`${base}/api/health`);
assert.equal(unauthorized.status, 401, 'tokenのない要求は拒否する');
const wrongToken = await fetch(`${base}/api/health`, { headers: { 'x-statute-token': 'secret-tokeX' } });
assert.equal(wrongToken.status, 401);
const authorized = await fetch(`${base}/api/guilds/${guildId}/laws`, {
  headers: { 'x-statute-token': 'secret-token' }
});
assert.equal(authorized.status, 200);
assert.equal(authorized.headers.get('content-type'), 'application/json; charset=utf-8');
assert.deepEqual((await authorized.json()).laws.map((law) => law.code), ['LAW-2', 'LAW-1']);
server.close();

const origin = 'https://statutes-origin.example.com';
assert.equal(apiTarget('/api/health', '', origin).toString(), `${origin}/api/health`);
assert.equal(
  apiTarget(`/api/guilds/${guildId}/laws`, '?q=記録&status=all&token=leak', origin).searchParams.get('token'),
  null,
  'Workerは許可した検索条件だけをoriginへ渡す'
);
assert.equal(
  apiTarget(`/api/guilds/${guildId}/laws`, '?q=記録', origin).searchParams.get('q'),
  '記録'
);
assert.equal(apiTarget('/api/guilds/abc/laws', '', origin), null, 'サーバーIDの形が違う経路は中継しない');
assert.equal(apiTarget(`/api/guilds/${guildId}/proposals`, '', origin), null,
  '成立した法令以外の経路はWorkerで止める');
assert.equal(apiTarget('/api/../secret', '', origin), null);

assert.deepEqual(parseRoute('#/'), { name: 'laws', params: {}, query: new URLSearchParams() });
assert.equal(parseRoute('#/law/12').params.lawId, '12');
assert.deepEqual(parseRoute('#/law/12/v/3').params, { lawId: '12', version: '3' });
assert.equal(parseRoute('#/law/12?art=A1').query.get('art'), 'A1');
assert.equal(parseRoute('#/constitution').name, 'constitution');
assert.equal(parseRoute('#/constitution/2').params.version, '2');
assert.equal(parseRoute('#/nope').name, 'notFound');
assert.equal(parseRoute('#/?q=記録').query.get('q'), '記録');

assert.equal(lawPath({ id: 4, version: 2, currentVersion: 2 }), '#/law/4');
assert.equal(lawPath({ id: 4, version: 1, currentVersion: 2 }), '#/law/4/v/1');
assert.equal(formatDate(1_700_000_000_000), '2023-11-15', 'JSTの日付で表示する');
assert.equal(formatDate(null), '-');
assert.equal(statusLabel('active'), '現行');
assert.equal(statusLabel('repealed'), '廃止');

const split = splitConstitutionContent(constitutionBody.content);
assert.equal(split.prose.includes('```governance-rules'), false, '条文と実行規則を分けて表示する');
assert.match(split.prose, /^# Test Community憲法/, '条文側は憲法本文をそのまま残す');
assert.match(split.rules, /"\$schema":"sakana.governance-rules\/v1"/);
assert.deepEqual(splitConstitutionContent('本文だけ'), { prose: '本文だけ', rules: null });

const blocks = outlineBlocks('# 見出し\n\n本文1\n本文2\n\n## 小見出し');
assert.deepEqual(blocks, [
  { kind: 'heading', level: 1, text: '見出し' },
  { kind: 'paragraph', text: '本文1\n本文2' },
  { kind: 'heading', level: 2, text: '小見出し' }
]);

for (const path of [mainPath, archivePath]) rmSync(path, { force: true });
console.log('statute site checks ok');
