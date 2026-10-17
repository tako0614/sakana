// 記憶 (ページと出来事) の意味ベクトルと、それを使う想起の検証 (npm run check から tsx で呼ぶ)。
//   - 変わったものだけ振り直す / 消えたものは消す / 同じ内容は2度振らない
//   - 近い順に引ける / 除外が効く / 間に合わなければ null (遅くしない)
//   - 呼ばれたときの想起は、名前の照合に意味の近い記憶を足す (重複しない)。失敗しても名前の想起は返る
//   - 考えている途中の想起は、まだ出していない記憶だけを足す
//   - memory ツールの query は、言葉が一致しなくても近い話に届く
//
// 埋め込みは偽物 (字の2連を次元にハッシュした袋)。Python のモデルは起こさない。
// ARCHIVE_DB_PATH / MEMORY_DB_PATH を一時ファイルに向けて呼ぶこと。

import assert from 'node:assert/strict';

process.env.MEMORY_RECALL_FLOOR = '0.05';
process.env.MEMORY_RECALL_GAP = '0.5';
const store = await import('../src/memory/store.js');
const vectors = await import('../src/memory/vectors.js');
const { recallFor, recallWithMeaning, meaningReader } = await import('../src/memory/recall.js');
const { runMemoryToolWithMeaning } = await import('../src/memory/tool.js');

const DIM = 256;
const fakeVector = (text) => {
  const vector = new Float32Array(DIM);
  const flat = text.replace(/\s+/g, '');
  for (let index = 0; index + 1 < flat.length; index += 1) {
    let hash = 7;
    for (const code of flat.slice(index, index + 2)) hash = (hash * 131 + code.codePointAt(0)) % 100003;
    vector[hash % DIM] += 1;
  }
  return vector;
};
let embedCalls = 0;
let embeddedTexts = 0;
const fakeEmbed = async (texts) => {
  embedCalls += 1;
  embeddedTexts += texts.length;
  return { dim: DIM, vectors: texts.map((text) => Buffer.from(fakeVector(text).buffer).toString('base64')) };
};
vectors.setEmbedder(fakeEmbed);

const GUILD = '920000000000000001';
const CHANNEL = '920000000000000010';
store.resetTree(GUILD);
store.ensureSeeds(GUILD);
const at = Date.now() - 86_400_000;
const page = (path, summary, body) => { store.ensureNode(GUILD, path, { summary }); store.writePage(GUILD, path, { summary, body }); };
page('people/たこ', 'sakana の作者', '「レビュー無しでマージするのはやめよう」と言ったのに、自分のPRはレビューを飛ばして通した [e1]');
page('topics/ダブスタ', '言うことと自分のやることが食い違うこと', '主張と行動が合わない場面。レビューは大事と言いながら自分は飛ばす、など [e1]');
page('people/さば', 'Rust が好きな開発者', 'Rust 最高と言いながら Go も書く。昼はカップ麺 [e2]');
const episode = (title, summary, kind) => store.insertEpisode(GUILD, { kind, title, summary, channelId: CHANNEL, atMs: at, endMs: at, sources: ['1'], importance: 2 });
const e1 = episode('レビュー飛ばしの自己矛盾', 'たこがレビュー無しのマージを批判したのに、自分のPRはレビューを飛ばして通した', '事件');
const e2 = episode('Rust と Go の論争', 'さばが Rust 最高と言ったあとに Go も書くと認めた', 'レスバ');
const e3 = episode('昼食はカップ麺', 'さばは昼にいつもカップ麺を食べている', '近況');
store.linkEpisodeNodes(GUILD, e1, ['people/たこ', 'topics/ダブスタ'], at);

// ---- 振る -------------------------------------------------------------------
assert.equal(vectors.hasVectors(GUILD), false, 'nothing is embedded before the first sync');
const first = await vectors.syncMemoryVectors(GUILD, { sleepMs: 0, batchSize: 4 });
const live = store.memoryDb().prepare('SELECT (SELECT COUNT(*) FROM nodes WHERE guild_id = ? AND (summary <> \'\' OR body <> \'\')) + (SELECT COUNT(*) FROM episodes WHERE guild_id = ?) AS n').get(GUILD, GUILD).n;
assert.equal(first.embedded, live, 'every page with content and every episode is embedded');
assert.equal(first.remaining, 0);
assert.equal(vectors.hasVectors(GUILD), true);

embeddedTexts = 0;
const again = await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 });
assert.deepEqual([again.embedded, again.removed, embeddedTexts], [0, 0, 0], 'unchanged content is not embedded twice');

store.writePage(GUILD, 'people/さば', { summary: 'Rust が好きで、昼はカップ麺の開発者', body: 'Rust 最高と言いながら Go も書く [e2]' });
const changed = await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 });
assert.deepEqual([changed.embedded, changed.removed], [1, 0], 'only the rewritten page is embedded again');

store.memoryDb().prepare('DELETE FROM episodes WHERE id = ?').run(e3);
const removed = await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 });
assert.deepEqual([removed.embedded, removed.removed], [0, 1], 'a vanished episode loses its vector');

// 途中で止まっても、次の回が続きから進める
store.memoryDb().prepare('DELETE FROM memory_vectors WHERE guild_id = ? AND kind = ?').run(GUILD, 'episode');
const resumed = await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 });
assert.equal(resumed.embedded, 2, 'missing vectors are filled in on the next run');
// 別のモデルで振られたものは使わず、振り直す
store.memoryDb().prepare("UPDATE memory_vectors SET model = 'other-model' WHERE guild_id = ?").run(GUILD);
assert.equal(vectors.hasVectors(GUILD), false, 'vectors of another model are not used');
assert.equal((await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 })).embedded, live - 1, 'and are embedded again');
// 壊れたベクトル (次元が足りない・NaN) は保存しない
vectors.setEmbedder(async (texts) => ({ dim: DIM, vectors: texts.map(() => Buffer.from('xx').toString('base64')) }));
store.writePage(GUILD, 'people/さば', { summary: '更新', body: '別の内容' });
const broken = await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 });
assert.deepEqual([broken.embedded, broken.remaining], [0, 1], 'a broken vector is not stored and stays pending');
vectors.setEmbedder(fakeEmbed);
assert.equal((await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 })).embedded, 1);

// ---- 引く -------------------------------------------------------------------
const query = await vectors.embedQuery('自分のPRはレビューを飛ばしていた');
assert.ok(query instanceof Float32Array && query.length === DIM);
const episodes = vectors.nearest(GUILD, 'episode', query, { limit: 3 });
assert.equal(episodes[0].id, e1, 'the episode about skipping the review is the nearest');
assert.ok(episodes[0].score > (episodes[1]?.score ?? 0));
const skip = vectors.nearest(GUILD, 'episode', query, { limit: 3, exclude: new Set([e1]) });
assert.ok(!skip.some((hit) => hit.id === e1), 'excluded ids are skipped');

const meaning = await vectors.meaningOf(GUILD, '自分のPRはレビューを飛ばしていた');
assert.ok(meaning.nodes.some((node) => node.path === 'topics/ダブスタ' || node.path === 'people/たこ'));
assert.ok(meaning.episodes.some((entry) => entry.id === e1));
assert.ok(!meaning.nodes.some((node) => node.path === ''), 'the root is never recalled');
const notAgain = await vectors.meaningOf(GUILD, '自分のPRはレビューを飛ばしていた', { excludePaths: new Set(['topics/ダブスタ', 'people/たこ']), excludeEpisodes: new Set([e1]) });
assert.ok(!notAgain?.nodes.some((node) => ['topics/ダブスタ', 'people/たこ'].includes(node.path)), 'pages already shown are not returned');

// 間に合わなければ null (遅くしない)
vectors.setEmbedder(() => new Promise(() => {}));
const started = Date.now();
assert.equal(await vectors.embedQuery('待たされる質問', { timeoutMs: 60 }), null);
assert.ok(Date.now() - started < 1000, 'gives up at the time limit');
assert.equal(await vectors.meaningOf(GUILD, '待たされる質問', { timeoutMs: 60 }), null);
vectors.setEmbedder(async () => { throw new Error('worker down'); });
assert.equal(await vectors.embedQuery('壊れたワーカー'), null, 'a failing worker is the same as no meaning');
vectors.setEmbedder(fakeEmbed);

// ---- 呼ばれたときの想起 --------------------------------------------------------
const request = 'たこって自分のPRはレビューを飛ばしてたよね';
const named = recallFor(GUILD, { request });
assert.match(named, /\[\[people\/たこ\]\]/, 'the name matches the page');
const both = await recallWithMeaning(GUILD, { request });
assert.match(both.text, /意味が近い記憶/);
assert.match(both.text, /\[\[topics\/ダブスタ\]\]/, 'a page whose name is not in the sentence is recalled by meaning');
assert.equal(both.text.match(/\[\[people\/たこ\]\]/g).length, 1, 'a page found by name is not listed again');
assert.ok(both.paths.has('topics/ダブスタ') && both.paths.has('people/たこ'));
vectors.setEmbedder(async () => { throw new Error('worker down'); });
const fallback = await recallWithMeaning(GUILD, { request });
assert.equal(fallback.text, named, 'without meaning the name-based recall comes back unchanged');
vectors.setEmbedder(fakeEmbed);
assert.equal((await recallWithMeaning('920000000000000999', { request })).text, '', 'a server without memory recalls nothing');

// ---- 考えている途中の想起 ------------------------------------------------------
const read = meaningReader(GUILD, { request: 'さばって何者？', shown: undefined });
assert.equal(await read({ observations: [] }), null, 'the first round is covered by the start-of-run recall');
const noticed = await read({ observations: ['tool:search: さば: Rust 最高と言いながら Go も書く。昼はカップ麺'] });
assert.ok(noticed?.text.includes('調べている内容に近い記憶'), 'what is being looked at brings related memory');
assert.match(noticed.text, /people\/さば|Rust と Go/);
const repeated = await read({ observations: ['tool:search: さば: Rust 最高と言いながら Go も書く。昼はカップ麺'] });
assert.ok(!repeated || !/people\/さば/.test(repeated.text), 'what was already shown is not shown again');
vectors.setEmbedder(async () => { throw new Error('worker down'); });
assert.equal(await meaningReader(GUILD, { request: 'x' })({ observations: ['tool:search: レビュー'] }), null, 'a failing worker adds nothing');
vectors.setEmbedder(fakeEmbed);

// ---- memory ツール -------------------------------------------------------------
const ctx = { guildId: GUILD };
const byWords = await runMemoryToolWithMeaning(ctx, { query: 'レビュー' });
assert.match(byWords, /ページ:|出来事:/, 'the word search results stay');
assert.match(byWords, /意味が近い記憶|ダブスタ/);
const byMeaning = await runMemoryToolWithMeaning(ctx, { query: 'PRの確認を省略して自分だけ通す' });
assert.ok(!byMeaning.startsWith('記憶に「'), 'meaning answers when the words match nothing');
assert.match(byMeaning, /意味が近い記憶/);
assert.equal(await runMemoryToolWithMeaning(ctx, { path: 'people/たこ' }), (await import('../src/memory/tool.js')).runMemoryTool(ctx, { path: 'people/たこ' }), 'opening a page is unchanged');
vectors.setEmbedder(async () => { throw new Error('worker down'); });
assert.equal(await runMemoryToolWithMeaning(ctx, { query: 'レビュー' }), (await import('../src/memory/tool.js')).runMemoryTool(ctx, { query: 'レビュー' }), 'a failing worker returns the plain result');

console.log('memory vectors ok (差分だけ振る / 消えたら消す / 別モデルは使わない / 近い順 / 間に合わなければ null / 想起は名前 + 意味で重複しない / 考え中は未出のものだけ / memory ツール)');
