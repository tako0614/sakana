import assert from 'node:assert/strict';

const {
  escapeHtml, formatDate, instrumentPath, matchesQuery, outlineBlocks,
  renderConstitution, renderLaw, renderList, renderMessage, sortInstruments, splitConstitution
} = await import('../worker/src/render.js');
const { validateInstrument } = await import('../worker/src/index.js');

const provisions = {
  articles: [
    { code: 'A1', text: '公開チャンネルで同じ文面を連続して投稿してはならない。' },
    { code: 'A2', text: '前条の適用は投稿の間隔が60秒未満の場合に限る。' }
  ],
  offenses: [{
    code: 'O1',
    title: '連続投稿',
    elements: ['短時間に同じ文面を投稿したこと'],
    sanctions: [{ type: 'timeout', maximumSeconds: 600 }],
    interimProtection: null,
    automaticTrigger: null
  }],
  sanctionDefinitions: [{
    code: 'R1', title: '発言速度制限', maximumDurationSeconds: 600,
    rules: [{ primitive: 'messages_per_window', maximum: 3, windowSeconds: 60 }]
  }]
};
const lawV2 = {
  type: 'law', instrument_id: '12', root_id: '11', code: 'LAW-2-R1', title: '連続投稿規制法',
  version: 2, status: 'active', publication_status: '現行法',
  text: '連続投稿を制限する。\n適用範囲を狭くした。',
  provisions_json: JSON.stringify(provisions), content_hash: 'hash-v2',
  effective_at: 1_700_100_000_000, ended_at: null, updated_at: 1_700_100_000_000
};
const lawV1 = {
  ...lawV2, instrument_id: '11', code: 'LAW-1-R1', version: 1, status: 'superseded',
  publication_status: '旧法', text: '連続投稿を制限する。', content_hash: 'hash-v1',
  effective_at: 1_700_000_000_000, ended_at: 1_700_100_000_000
};
const constitution = {
  type: 'constitution', instrument_id: '3', root_id: 'constitution', code: 'CONSTITUTION-V2',
  title: '憲法 v2', version: 2, status: 'active', publication_status: '現行憲法',
  text: '# Test憲法\n\n## 第一条（主権）\n\n1. 主権は構成員に属する。\n\n```governance-rules\n{"$schema":"sakana.governance-rules/v1"}\n```\n',
  provisions_json: null, content_hash: 'hash-c2',
  effective_at: 1_700_200_000_000, ended_at: null, updated_at: 1_700_200_000_000
};

// --- 表示の素材 -------------------------------------------------------------
assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
assert.equal(formatDate(1_700_000_000_000), '2023年11月15日', 'JSTの和暦風の日付で表示する');
assert.equal(formatDate(null), '-');
assert.equal(instrumentPath(lawV2), '/law/12');
assert.equal(instrumentPath(constitution), '/constitution/3');
assert.equal(instrumentPath({ ...lawV2, instrument_id: 'a/b' }), '/law/a%2Fb', '経路に使うIDはescapeする');

assert.deepEqual(
  sortInstruments([lawV1, constitution, lawV2]).map((row) => row.instrument_id),
  ['3', '12', '11'],
  '現行を先に、同じ状態なら新しい順に並べる'
);

assert.equal(matchesQuery(lawV2, ''), true);
assert.equal(matchesQuery(lawV2, '適用範囲'), true, '本文で探せる');
assert.equal(matchesQuery(lawV2, '連続投稿規制'), true, '題名で探せる');
assert.equal(matchesQuery(lawV2, '60秒未満'), true, '条文で探せる');
assert.equal(matchesQuery(lawV2, 'リンク'), false);

const split = splitConstitution(constitution.text);
assert.equal(split.prose.includes('```governance-rules'), false, '条文と実行規則を分ける');
assert.match(split.prose, /^# Test憲法/);
assert.match(split.rules, /sakana\.governance-rules\/v1/);
assert.deepEqual(splitConstitution('本文だけ'), { prose: '本文だけ', rules: null });
assert.deepEqual(outlineBlocks('# 見出し\n\n本文1\n本文2\n\n## 小見出し'), [
  { kind: 'heading', level: 1, text: '見出し' },
  { kind: 'paragraph', text: '本文1\n本文2' },
  { kind: 'heading', level: 2, text: '小見出し' }
]);

// --- 一覧 -------------------------------------------------------------------
const list = renderList({ guildId: '123', rows: [lawV2, constitution], query: '', history: false });
assert.match(list, /<title>法令集<\/title>/);
assert.match(list, /<a href="\/law\/12\?guild=123">連続投稿規制法<\/a>/, '一覧から詳細へ行ける');
assert.match(list, /<table class="laws">/, '一覧は表で並べる');
assert.match(list, /name="q"/, '検索はJS無しのGETフォームで動く');
assert.match(list, /法令名・本文・条文を検索/);
assert.match(list, /<a href="\/constitution\/3\?guild=123">/);
assert.match(list, /badge-ok">現行法/);
assert.match(list, /2件/);
assert.doesNotMatch(list, /連続投稿を制限する。\n適用範囲/, '一覧に全文は出さない');

const empty = renderList({ guildId: '123', rows: [], query: 'リンク', history: false });
assert.match(empty, /「リンク」に一致する法令はありません/);
assert.match(renderList({ guildId: '123', rows: [], query: '', history: false }), /まだ公開された法令はありません/);
assert.match(
  renderList({ guildId: '123', rows: [lawV2], query: '<img src=x onerror=alert(1)>', history: true }),
  /&lt;img src=x onerror=alert\(1\)&gt;/,
  '検索語もそのまま埋め込まない'
);

// --- 法令の詳細 -------------------------------------------------------------
const detail = renderLaw({ guildId: '123', row: lawV2, versions: [lawV1, lawV2] });
assert.match(detail, /<h1>連続投稿規制法/, '開いている法令をヘッダにも出す');
assert.match(detail, /class="law-title">連続投稿規制法<\/h2>/);
assert.match(detail, /<h2 class="section" id="articles">条文<\/h2>/);
assert.match(detail, /id="a-A1"/, '条文にアンカーを振る');
assert.match(detail, /href="#a-A2"/, '目次から条文へ飛べる');
assert.match(detail, /違反と処分<\/h2>/);
assert.match(detail, /発言停止　上限 10分/, '処分の上限を人が読める形にする');
assert.match(detail, /機能制限の定義<\/h2>/);
assert.match(detail, /<h2>沿革<\/h2>/, '沿革のパネルを出す');
assert.match(detail, /href="\/law\/11\?guild=123">第1版/, '沿革から旧版へ行ける');
assert.match(detail, /本文hash: hash-v2/);
assert.doesNotMatch(detail, /現行版を見る/, '現行版に旧版の案内は出さない');

const oldDetail = renderLaw({ guildId: '123', row: lawV1, versions: [lawV1, lawV2] });
assert.match(oldDetail, /これは過去の版です。<a href="\/law\/12\?guild=123">現行版（第2版）を見る/);

const bare = renderLaw({ guildId: '123', row: { ...lawV2, provisions_json: null }, versions: [] });
assert.doesNotMatch(bare, /id="articles">条文/, '執行定義が無い法令でも本文だけで表示する');
assert.doesNotMatch(bare, /<h2>沿革<\/h2>/, '版が1つも無ければ沿革のパネルを出さない');
assert.match(
  renderLaw({ guildId: '123', row: { ...lawV2, text: '<script>x</script>' }, versions: [] }),
  /&lt;script&gt;x&lt;\/script&gt;/,
  '法令本文をHTMLとして解釈しない'
);
assert.doesNotMatch(
  renderLaw({ guildId: '123', row: { ...lawV2, provisions_json: '{壊れたJSON' }, versions: [] }),
  /id="articles">条文/,
  '壊れた執行定義でも画面を落とさない'
);
assert.match(
  renderLaw({ guildId: '123', row: lawV1, versions: [lawV1] }),
  /この法令は旧法です。執行されません/,
  '現行でない法令はその旨を出す'
);

// --- 憲法 -------------------------------------------------------------------
const constitutionPage = renderConstitution({ guildId: '123', row: constitution, versions: [constitution] });
assert.match(constitutionPage, /第一条（主権）/);
assert.match(constitutionPage, /実行規則<\/h2>/);
assert.match(constitutionPage, /<details class="rules">/, '実行規則は畳んで置く');
assert.doesNotMatch(constitutionPage, /```governance-rules/, '条文側にfenceを残さない');

assert.match(renderMessage({ guildId: '123', title: 'x', message: '公開されていません。' }), /公開されていません。/);

// --- 押し込みの受け口 -------------------------------------------------------
const payload = {
  guildId: '123', type: 'law', instrumentId: '12', rootId: '11', code: 'LAW-2-R1',
  title: '連続投稿規制法', version: 2, status: 'active', publicationStatus: '現行法',
  text: '本文', provisions, contentHash: 'hash-v2', effectiveAt: 1, endedAt: null
};
assert.equal(validateInstrument(payload).rootId, '11');
const { rootId: _dropped, ...withoutRoot } = payload;
assert.equal(validateInstrument(withoutRoot).rootId, '12',
  'rootIdを送らない旧botの押し込みは、その版を系列の起点として扱う');
assert.throws(() => validateInstrument({ ...payload, extra: 1 }), /未対応の項目があります/);
assert.throws(() => validateInstrument({ ...payload, type: 'memo' }), /type が不正です/);

console.log('check-lawsite: ok');
