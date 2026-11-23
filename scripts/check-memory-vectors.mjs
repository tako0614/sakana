// 記憶 (ページ・出来事・ページの中の1つの知識) の意味ベクトルと、それを使う想起の検証 (npm run check から tsx で呼ぶ)。
//   - 変わったものだけ振り直す / 消えたものは消す / 同じ内容は2度振らない
//   - 本文を 1 行 = 1 つの知識に割る (見出しの引き継ぎ・長い行・出典番号) / 書き直しても同じ文は引き継ぐ / 節だけ開ける
//   - 近い順に引ける / 除外が効く / 間に合わなければ null (遅くしない)
//   - 呼ばれたときの想起は、名前の照合に意味の近い記憶を足す (重複しない)。失敗しても名前の想起は返る
//   - 考えている途中の想起は、まだ出していない記憶だけを足す
//   - memory ツールの query は、言葉が一致しなくても近い話に届く
//
// 埋め込みは偽物 (字の2連を次元にハッシュした袋)。Python のモデルは起こさない。
// ARCHIVE_DB_PATH / MEMORY_DB_PATH を一時ファイルに向けて呼ぶこと。

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.MEMORY_RECALL_FLOOR = '0.05';
process.env.MEMORY_RECALL_GAP = '0.5';
process.env.MEMORY_AUTO_RECALL_FLOOR = '0.05';
process.env.MEMORY_CHUNK_FLOOR = '0.05';
process.env.MEMORY_CHUNK_GAP = '0.5';
process.env.MEMORY_CHUNK_CHARS = '0';   // 1 行ずつ。まとめる大きさは、あとで切り替えて試す
const store = await import('../src/memory/store.js');
const vectors = await import('../src/memory/vectors.js');
const recallLib = await import('../src/memory/recall.js');
const { memoryReader, meaningLines } = recallLib;
const { runMemoryToolWithMeaning, runMemoryTool } = await import('../src/memory/tool.js');
const chunkLib = await import('../src/memory/chunks.js');

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

// ---- 本文を 1 つの知識に割る ----------------------------------------------------
{
  const body = [
    'えだまめの開発持論。',
    '',
    '## 開発スタイル',
    '- TODO駆動開発 (TODO.mdにタスクリストを書く) を推奨 (2026-02-20) [e11]',
    '- 「テストしてても失敗する時はする」が持論。[[people/さば|さば]] も同意 [e12, e13]',
    '短い',
    '### ランタイム',
    '- bun 警戒 → Node.js 派に転換 (2026-10) [e14]',
    '## 道具',
    '1. エディタは cursor と windsurf の二刀流で、契約も迷っている [e15]'
  ].join('\n');
  const pieces = chunkLib.splitPieces(body);
  assert.deepEqual(pieces.map((piece) => piece.heading), ['', '開発スタイル', '開発スタイル', '開発スタイル › ランタイム', '道具'], 'headings carry down and nest; short lines are dropped');
  assert.equal(pieces[1].text, 'TODO駆動開発 (TODO.mdにタスクリストを書く) を推奨 (2026-02-20)', 'bullet marks and [e..] are removed');
  assert.deepEqual(pieces[1].cites, [11]);
  assert.deepEqual(pieces[2].cites, [12, 13], 'a group of citations is kept');
  assert.match(pieces[2].text, /さば も同意$/, '[[path|label]] becomes the label');
  assert.equal(pieces[4].text.startsWith('エディタは'), true, 'numbered items are stripped too');
  assert.equal(chunkLib.splitPieces('- **gitty**: API Client を公開 (2026-01) [e1]')[0].text, 'gitty: API Client を公開 (2026-01)', 'bold marks are dropped');
  assert.equal(chunkLib.splitPieces('- bigint の `2n ** 10000n` を即答した話 [e1]')[0].text.includes('2n ** 10000n'), true, 'a power operator in code is not a bold mark');

  const long = `${'あ'.repeat(180)}。${'い'.repeat(180)}。 [e1]`;
  const parts = chunkLib.splitPieces(`- ${long}`);
  assert.equal(parts.length, 2, 'a line over the limit is split at a sentence end');
  assert.ok(parts.every((piece) => piece.text.length <= 300), 'every piece fits the limit');
  assert.deepEqual(parts.map((piece) => piece.cites), [[], [1]], 'citations stay with the sentence they follow');

  // まとめる: 同じ節の隣り合う行を上限までひとつにする。節をまたがない。根拠は合わせる
  const packed = chunkLib.packPieces(pieces, 200);
  assert.deepEqual(packed.map((piece) => piece.heading), ['', '開発スタイル', '開発スタイル › ランタイム', '道具'], 'lines of one section are packed; a heading change starts a new piece');
  assert.equal(packed[1].text.split('\n').length, 2, 'two lines of the same section become one piece');
  assert.deepEqual(packed[1].cites, [11, 12, 13], 'citations are merged');
  assert.equal(chunkLib.packPieces(pieces, 50).length, pieces.length, 'a small limit leaves each line alone');
  assert.equal(chunkLib.bestLine('TODO駆動開発を推奨した\n昼はカップ麺を食べる', '昼ごはんはカップ麺'), '昼はカップ麺を食べる', 'the line that overlaps the question most');
  assert.equal(chunkLib.bestLine('一行だけ', 'なんでも'), '一行だけ');

  assert.equal(chunkLib.sectionOf(body, '開発スタイル').includes('TODO駆動開発'), true);
  assert.equal(chunkLib.sectionOf(body, '開発スタイル').includes('bun 警戒'), true, 'pointing at a parent heading includes its children');
  assert.equal(chunkLib.sectionOf(body, '開発スタイル').includes('エディタ'), false, 'a section ends at the next heading of the same level');
  assert.equal(chunkLib.sectionOf(body, 'ランタイム').trim().split('\n').length, 2, 'the last part of a nested heading works');
  assert.equal(chunkLib.sectionOf(body, '開発スタイル › ランタイム').includes('bun'), true, 'so does the whole path');
  assert.equal(chunkLib.sectionOf(body, 'そんな節はない'), null);
  assert.deepEqual(chunkLib.headingsOf(body), ['開発スタイル', '開発スタイル › ランタイム', '道具']);
  assert.match(chunkLib.chunkText('people/たこ', ['tako'], '立場', 'Rust 推し'), /^people\/たこ \(tako\)\n立場: Rust 推し$/, 'the page name leads the embedded text');
}

// ---- 振る -------------------------------------------------------------------
assert.equal(vectors.hasVectors(GUILD), false, 'nothing is embedded before the first sync');
const first = await vectors.syncMemoryVectors(GUILD, { sleepMs: 0, batchSize: 4 });
// 振る対象の数: 中身のあるページ + 出来事 + 断片 (本文の 1 行ずつ)
const liveCount = () => store.memoryDb().prepare('SELECT (SELECT COUNT(*) FROM nodes WHERE guild_id = ? AND (summary <> \'\' OR body <> \'\')) + (SELECT COUNT(*) FROM episodes WHERE guild_id = ?) + (SELECT COUNT(*) FROM memory_chunks WHERE guild_id = ?) AS n').get(GUILD, GUILD, GUILD).n;
const live = liveCount();
assert.equal(first.embedded, live, 'every page with content, every episode and every line of a page is embedded');
const chunkRows = store.memoryDb().prepare('SELECT path FROM memory_chunks WHERE guild_id = ?').all(GUILD);
assert.equal(chunkRows.length, 3, 'one line each from the three pages with a body');
assert.ok(!chunkRows.some((row) => row.path === ''), 'the root overview is not split into lines');
assert.equal(first.remaining, 0);
assert.equal(vectors.hasVectors(GUILD), true);

embeddedTexts = 0;
const again = await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 });
assert.deepEqual([again.embedded, again.removed, embeddedTexts], [0, 0, 0], 'unchanged content is not embedded twice');

store.writePage(GUILD, 'people/さば', { summary: 'Rust が好きで、昼はカップ麺の開発者', body: 'Rust 最高と言いながら Go も書く [e2]' });
const changed = await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 });
assert.deepEqual([changed.embedded, changed.removed], [2, 1], 'the rewritten page and its rewritten line are embedded again; the old line loses its vector');

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
assert.equal((await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 })).embedded, liveCount(), 'and are embedded again');
// 壊れたベクトル (次元が足りない・NaN) は保存しない
vectors.setEmbedder(async (texts) => ({ dim: DIM, vectors: texts.map(() => Buffer.from('xx').toString('base64')) }));
store.writePage(GUILD, 'people/さば', { summary: '更新', body: '別の内容' });
const broken = await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 });
assert.deepEqual([broken.embedded, broken.remaining], [0, 1], 'a broken vector is not stored and stays pending');
vectors.setEmbedder(fakeEmbed);
assert.equal((await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 })).embedded, 1);

// ---- 断片 (ページの中の1つの知識) ------------------------------------------------
page('projects/まぐろbot', 'ホームページ付きの bot', ['## 実装', '- Hono の素の client を魔改造して作った [e1]', '- セッション検証は guard 方式にする予定 [e2]', '## 運営', '- 荒らし対策でレート制限を入れた [e2]'].join('\n'));
const afterAdd = await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 });
assert.equal(afterAdd.embedded, 4, 'the new page and its three lines');
const lineRows = () => store.memoryDb().prepare("SELECT id, heading, text, cites FROM memory_chunks WHERE path = 'projects/まぐろbot' ORDER BY ord").all();
const before = lineRows();
assert.deepEqual(before.map((row) => row.heading), ['実装', '実装', '運営']);
assert.deepEqual(JSON.parse(before[0].cites), [1]);

// 書き直しても同じ文は引き継ぐ (id もベクトルも)。消えた文は消え、増えた文だけ振る
page('projects/まぐろbot', 'ホームページ付きの bot', ['## 実装', '- Hono の素の client を魔改造して作った [e1]', '- ログインは OAuth にする計画 [e1]', '## 運営', '- 荒らし対策でレート制限を入れた [e2]'].join('\n'));
const resync = chunkLib.syncChunks(GUILD);
assert.deepEqual(resync, { added: 1, removed: 1, kept: 2 + (await (async () => store.memoryDb().prepare("SELECT COUNT(*) n FROM memory_chunks WHERE path <> 'projects/まぐろbot'").get().n)()) });
const after = lineRows();
assert.equal(after[0].id, before[0].id, 'an unchanged line keeps its id');
assert.equal(after[2].id, before[2].id, 'even when it moves');
assert.ok(!after.some((row) => row.id === before[1].id), 'a line that disappeared is gone');
const rewrittenSync = await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 });
assert.deepEqual([rewrittenSync.embedded, rewrittenSync.removed], [2, 1], 'the page and the one new line are embedded; the vanished line loses its vector');

// まだ統合していない新しい知識 (pending) も断片になる。節は「新しい知識」
store.memoryDb().prepare("UPDATE nodes SET pending = ? WHERE guild_id = ? AND path = 'projects/まぐろbot'").run('- 2026-10 から管理画面も作り始めた [e3]\n', GUILD);
chunkLib.syncChunks(GUILD);
assert.ok(lineRows().some((row) => row.heading === '新しい知識' && /管理画面/.test(row.text)), 'unmerged knowledge is searchable before the builder merges it');
store.memoryDb().prepare("UPDATE nodes SET pending = '' WHERE guild_id = ? AND path = 'projects/まぐろbot'").run(GUILD);
chunkLib.syncChunks(GUILD);
await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 });
assert.ok(!lineRows().some((row) => row.heading === '新しい知識'), 'and goes away when merged');

// ---- 引く -------------------------------------------------------------------
const query = await vectors.embedQuery('自分のPRはレビューを飛ばしていた');
assert.ok(query instanceof Float32Array && query.length === DIM);
const episodes = vectors.nearest(GUILD, 'episode', query, { limit: 3 });
assert.equal(episodes[0].id, e1, 'the episode about skipping the review is the nearest');
assert.ok(episodes[0].score > (episodes[1]?.score ?? 0));
const skip = vectors.nearest(GUILD, 'episode', query, { limit: 3, exclude: new Set([e1]) });
assert.ok(!skip.some((hit) => hit.id === e1), 'excluded ids are skipped');

// Warm cache, stable tie ordering, requested-id order, and same-size/same-time
// updates from both this connection and a separate builder connection.
{
  const db = store.memoryDb();
  const originals = db.prepare('SELECT id, model, vec, updated_at FROM memory_vectors WHERE guild_id = ? AND kind = ? ORDER BY id').all(GUILD, 'episode');
  const dot = (blob) => {
    const values = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
    let score = 0;
    for (let i = 0; i < query.length; i += 1) score += values[i] * query[i];
    return score;
  };
  const ordered = () => db.prepare('SELECT id, vec FROM memory_vectors WHERE guild_id = ? AND kind = ? AND model = ?').all(GUILD, 'episode', originals[0].model);
  const expected = (limit, exclude = new Set()) => ordered().map((row, index) => ({ id: row.id, score: dot(row.vec), index }))
    .filter((hit) => !exclude.has(hit.id)).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(({ id, score }) => ({ id, score }));
  for (const limit of [0, 1, 2, 10]) {
    assert.deepEqual(vectors.nearest(GUILD, 'episode', query, { limit }), expected(limit), 'bounded top-k matches a full stable sort');
    assert.deepEqual(vectors.nearest(GUILD, 'episode', query, { limit, exclude: new Set([e1]) }), expected(limit, new Set([e1])), 'top-k applies exclusions before selection');
  }
  const put = db.prepare('UPDATE memory_vectors SET vec = ? WHERE guild_id = ? AND kind = ? AND id = ?');
  try {
    put.run(Buffer.from(query.buffer), GUILD, 'episode', e2);
    assert.deepEqual(vectors.nearest(GUILD, 'episode', query, { limit: 2 }), expected(2), 'local same-time replacement invalidates a warm matrix');
    assert.equal(vectors.nearest(GUILD, 'episode', query, { limit: originals.length }).find((hit) => hit.id === e2)?.score, dot(Buffer.from(query.buffer)));
    const external = new Database(process.env.MEMORY_DB_PATH);
    try {
      const opposite = Float32Array.from(query, (value) => -value);
      external.prepare('UPDATE memory_vectors SET vec = ? WHERE guild_id = ? AND kind = ? AND id = ?').run(Buffer.from(opposite.buffer), GUILD, 'episode', e2);
    } finally { external.close(); }
    assert.deepEqual(vectors.nearest(GUILD, 'episode', query, { limit: 2 }), expected(2), 'external same-time replacement invalidates a warm matrix');
    assert.equal(vectors.nearest(GUILD, 'episode', query, { limit: originals.length }).find((hit) => hit.id === e2)?.score, -dot(Buffer.from(query.buffer)));
    const tied = Buffer.from(query.buffer);
    put.run(tied, GUILD, 'episode', e1);
    put.run(tied, GUILD, 'episode', e2);
    assert.deepEqual(vectors.nearest(GUILD, 'episode', query, { limit: 1 }), expected(1), 'equal scores keep database row order');
  } finally {
    for (const row of originals) db.prepare('UPDATE memory_vectors SET vec = ?, updated_at = ? WHERE guild_id = ? AND kind = ? AND id = ?')
      .run(row.vec, row.updated_at, GUILD, 'episode', row.id);
  }
  const originalPrepare = db.prepare;
  let matrixLoads = 0;
  db.prepare = function (sql, ...args) {
    if (typeof sql === 'string' && sql.includes('SELECT id, vec FROM memory_vectors')) matrixLoads += 1;
    return originalPrepare.call(this, sql, ...args);
  };
  try {
    vectors.nearest(GUILD, 'episode', query);
    const warmLoads = matrixLoads;
    const external = new Database(process.env.MEMORY_DB_PATH);
    try {
      external.prepare('UPDATE nodes SET weight = weight + 1 WHERE guild_id = ? AND path = ?').run(GUILD, 'people/たこ');
    } finally { external.close(); }
    vectors.nearest(GUILD, 'episode', query);
    assert.equal(matrixLoads, warmLoads, 'an unrelated external commit does not reload vector BLOBs');

    const foreign = `${GUILD}-other`;
    db.prepare('INSERT INTO memory_vectors (guild_id, kind, id, model, text_hash, vec, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(foreign, 'episode', 999999, originals[0].model, 'test', originals[0].vec, 1);
    vectors.nearest(GUILD, 'episode', query);
    assert.equal(matrixLoads, warmLoads, 'a vector write for another guild does not reload this matrix');
    const previousForeignRevision = db.prepare('SELECT revision FROM memory_vector_revisions WHERE guild_id = ? AND kind = ?').get(foreign, 'episode').revision;
    const previousLocalRevision = db.prepare('SELECT revision FROM memory_vector_revisions WHERE guild_id = ? AND kind = ?').get(GUILD, 'episode').revision;
    db.prepare('UPDATE memory_vectors SET guild_id = ? WHERE guild_id = ? AND kind = ? AND id = ?').run(GUILD, foreign, 'episode', 999999);
    assert.ok(db.prepare('SELECT revision FROM memory_vector_revisions WHERE guild_id = ? AND kind = ?').get(foreign, 'episode').revision > previousForeignRevision, 'moving a row invalidates its old group');
    assert.ok(db.prepare('SELECT revision FROM memory_vector_revisions WHERE guild_id = ? AND kind = ?').get(GUILD, 'episode').revision > previousLocalRevision, 'moving a row invalidates its new group');
    assert.deepEqual(vectors.nearest(GUILD, 'episode', query, { limit: 3 }), expected(3), 'the moved row is visible in its new group');
    db.prepare('DELETE FROM memory_vectors WHERE guild_id = ? AND kind = ? AND id = ?').run(GUILD, 'episode', 999999);

    db.prepare('DELETE FROM memory_vector_revisions WHERE guild_id = ? AND kind = ?').run(GUILD, 'episode');
    vectors.nearest(GUILD, 'episode', query);
    const legacyLoads = matrixLoads;
    put.run(originals.find((row) => row.id === e2).vec, GUILD, 'episode', e2);
    vectors.nearest(GUILD, 'episode', query);
    assert.equal(matrixLoads, legacyLoads + 1, 'a write to legacy rows without a revision creates one and reloads the matrix');
  } finally { db.prepare = originalPrepare; }
}

const meaning = await vectors.meaningOf(GUILD, '自分のPRはレビューを飛ばしていた');
assert.ok(meaning.nodes.some((node) => node.path === 'topics/ダブスタ' || node.path === 'people/たこ'));
assert.ok(meaning.episodes.some((entry) => entry.id === e1));
assert.ok(!meaning.nodes.some((node) => node.path === ''), 'the root is never recalled');
const notAgain = await vectors.meaningOf(GUILD, '自分のPRはレビューを飛ばしていた', { excludePaths: new Set(['topics/ダブスタ', 'people/たこ']), excludeEpisodes: new Set([e1]) });
assert.ok(!notAgain?.nodes.some((node) => ['topics/ダブスタ', 'people/たこ'].includes(node.path)), 'pages already shown are not returned');

// 断片: 本文の中の具体的な話に届く。ページと節と根拠の出来事が付く
{
  const chunkQuery = await vectors.embedQuery('Hono の client を魔改造した話');
  const top = vectors.nearest(GUILD, 'chunk', chunkQuery, { limit: 3 });
  const row = store.memoryDb().prepare('SELECT path, text FROM memory_chunks WHERE id = ?').get(top[0].id);
  assert.equal(row.path, 'projects/まぐろbot');
  assert.match(row.text, /魔改造/, 'the line that says it is the nearest chunk');

  const found = await vectors.meaningOf(GUILD, 'Honoのclientを魔改造した話');
  const chunk = found.chunks.find((entry) => /魔改造/.test(entry.text));
  assert.ok(chunk, 'the meaning search returns the line');
  assert.deepEqual([chunk.path, chunk.heading, chunk.episodeIds], ['projects/まぐろbot', '実装', [1]], 'page, section and the evidence episode come with it');
  const wide = await vectors.meaningOf(GUILD, 'まぐろbot の実装と運営', { chunkLimit: 5 });
  assert.ok(wide.chunks.filter((entry) => entry.path === 'projects/まぐろbot').length <= 2, 'at most two sections from one page');
  // 探すのは 1 行ずつだが、出すのは節ごと: 同じ節で当たった行は 1 件にまとめ、ほかの数を添える
  const sections = wide.chunks.filter((entry) => entry.path === 'projects/まぐろbot');
  assert.equal(new Set(sections.map((entry) => entry.heading)).size, sections.length, 'one entry per section');
  const impl = sections.find((entry) => entry.heading === '実装');
  assert.ok(impl && impl.more === 1, 'the other matching line of the same section is counted, not listed');
  assert.match(meaningLines(wide).find((text) => text.includes('§実装')), /\(同じ節にほか 1 件\)/, 'the recall line says so');
  const skipped = await vectors.meaningOf(GUILD, 'Honoのclientを魔改造した話', { excludeChunks: new Set([chunk.id]) });
  assert.ok(!skipped?.chunks.some((entry) => entry.id === chunk.id), 'a line already shown is not returned again');
  assert.equal((await vectors.meaningOf(GUILD, 'Honoのclientを魔改造した話', { chunkLimit: 0 }))?.chunks.length ?? 0, 0, 'chunkLimit 0 turns lines off');

  const lines = meaningLines(found);
  const line = lines.find((text) => /魔改造/.test(text));
  assert.match(line, /^ {2}\[\[projects\/まぐろbot\]\] §実装 — Hono の素の client を魔改造して作った e1$/, 'a line shows the page, the section, the head of the fact and its evidence');
  assert.ok(!lines.some((text) => text === '  [[projects/まぐろbot]]'), 'a page that has a line is not listed twice');
  assert.ok(line.length < 140, 'a recall line is a pointer, not the body');

  const recalled = await memoryReader(GUILD, { request: 'Honoのclientを魔改造した話' })({ observations: [] });
  assert.match(recalled?.text, /§実装 — Hono の素の client.*e1/, 'a guild with the legacy index can still recall evidence');

}

// memory ツール: 節だけ開ける / 見つからなければ節の一覧
{
  const ctx = { guildId: GUILD };
  const opened = runMemoryTool(ctx, { path: 'projects/まぐろbot', section: '実装' });
  assert.match(opened, /^# projects\/まぐろbot § 実装/);
  assert.match(opened, /魔改造/);
  assert.ok(!opened.includes('荒らし対策'), 'only the requested section');
  const missing = runMemoryTool(ctx, { path: 'projects/まぐろbot', section: 'ない節' });
  assert.match(missing, /節「ない節」はありません/);
  assert.match(missing, /節: 実装 \/ 運営/, 'the list of sections is offered');
  assert.match(runMemoryTool(ctx, { path: 'projects/まぐろbot' }), /荒らし対策/, 'without section the whole page opens');
  store.memoryDb().prepare("UPDATE nodes SET pending = ? WHERE guild_id = ? AND path = 'projects/まぐろbot'").run('- 2026-10 から管理画面も作り始めた [e3]\n', GUILD);
  assert.match(runMemoryTool(ctx, { path: 'projects/まぐろbot', section: '新しい知識' }), /管理画面/, 'the unmerged knowledge is a section too');
  store.memoryDb().prepare("UPDATE nodes SET pending = '' WHERE guild_id = ? AND path = 'projects/まぐろbot'").run(GUILD);
  const searched = await runMemoryToolWithMeaning(ctx, { query: 'Hono の client を魔改造した話' });
  assert.match(searched, /§実装 — Hono の素の client/, 'a search by meaning shows the matching line');
}

// 断片の大きさを変える (MEMORY_CHUNK_CHARS): 同じ節の隣り合う行をまとめる。変えると作り直し、振り直す
{
  process.env.MEMORY_CHUNK_CHARS = '300';
  const packedSync = chunkLib.syncChunks(GUILD);
  assert.ok(packedSync.added > 0 && packedSync.removed > 0, 'changing the size rebuilds the chunks');
  const packedRows = lineRows();
  assert.equal(packedRows.length, 2, 'the two lines of 実装 become one piece; 運営 stays');
  assert.equal(packedRows[0].text.split('\n').length, 2);
  assert.deepEqual(JSON.parse(packedRows[0].cites), [1]);
  await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 });
  const found = await vectors.meaningOf(GUILD, 'ログインを OAuth にする計画はどうなった');
  const chunk = found.chunks.find((entry) => entry.path === 'projects/まぐろbot' && entry.heading === '実装');
  assert.ok(chunk, 'the packed piece is found');
  assert.match(chunk.text, /魔改造[\s\S]*OAuth/, 'the piece holds both lines');
  assert.equal(chunk.line, 'ログインは OAuth にする計画', 'the line that matched is the one shown');
  assert.match(meaningLines(found).find((text) => text.includes('§実装')), /§実装 — ログインは OAuth にする計画 e1$/, 'the recall line shows the matching line, not the first');
  process.env.MEMORY_CHUNK_CHARS = '0';
  chunkLib.syncChunks(GUILD);
  await vectors.syncMemoryVectors(GUILD, { sleepMs: 0 });
  assert.equal(lineRows().length, 3, 'and back to one line each');
}

// 間に合わなければ null (遅くしない)
vectors.setEmbedder(() => new Promise(() => {}));
const started = Date.now();
assert.equal(await vectors.embedQuery('待たされる質問', { timeoutMs: 60 }), null);
assert.ok(Date.now() - started < 1000, 'gives up at the time limit');
assert.equal(await vectors.meaningOf(GUILD, '待たされる質問', { timeoutMs: 60 }), null);
vectors.setEmbedder(async () => { throw new Error('worker down'); });
assert.equal(await vectors.embedQuery('壊れたワーカー'), null, 'a failing worker is the same as no meaning');
vectors.setEmbedder(fakeEmbed);

// Automatic recall keeps the semantic floor for unanchored facts. Exact words
// from the request/reply may admit one close miss, and independent sources fill
// the limited slots before repeat claims from the same episode.
{
  const db = store.memoryDb();
  (await import('../src/memory/v2/schema.js')).ensureV2Schema(db);
  const model = (await import('../src/embed/config.js')).embedConfig.memory.modelName;
  const guild = '920000000000000099';
  const sourceA = store.insertEpisode(guild, { kind: '事実', title: '赤い月', summary: '赤い月の記録', channelId: CHANNEL, atMs: at, endMs: at, sources: ['21'], importance: 2 });
  const sourceB = store.insertEpisode(guild, { kind: '事実', title: '青い星', summary: '青い星の記録', channelId: CHANNEL, atMs: at, endMs: at, sources: ['22'], importance: 2 });
  const sourceC = store.insertEpisode(guild, { kind: '事実', title: '緑の雲', summary: '緑の雲の記録', channelId: CHANNEL, atMs: at, endMs: at, sources: ['23'], importance: 2 });
  const sourceD = store.insertEpisode(guild, { kind: '事実', title: '別の話', summary: '別の話の記録', channelId: CHANNEL, atMs: at, endMs: at, sources: ['24'], importance: 2 });
  const sourceE = store.insertEpisode(guild, { kind: '事実', title: 'もう一つの話', summary: 'もう一つの話の記録', channelId: CHANNEL, atMs: at, endMs: at, sources: ['25'], importance: 2 });
  const claim = (ord, text, episodeId, aboutKey = 'person-2') => Number(db.prepare(`
    INSERT INTO v2_claims (guild_id, section_id, ord, about_kind, about_key, text, type, as_of, episode_id)
    VALUES (?, 1, ?, 'person', ?, ?, 'fact', ?, ?)
  `).run(guild, ord, aboutKey, text, at, episodeId).lastInsertRowid);
  const exact = claim(1, '赤い月は三日間見えた', sourceA, 'person-1');
  const repeat = claim(2, '三日間の観測を続けた', sourceA);
  const independent = claim(3, '青い星を観測した', sourceB);
  const third = claim(4, '緑の雲を観測した', sourceC);
  const unrelated = claim(5, '別の季節の話', sourceD);
  const tooLow = claim(6, '赤い月は遠くにも見えた', sourceE);
  const put = db.prepare(`INSERT INTO memory_vectors (guild_id, kind, id, model, text_hash, vec, updated_at) VALUES (?, ?, ?, ?, 'test', ?, ?)`);
  const add = (kind, id, score) => {
    const vector = new Float32Array([score, Math.sqrt(1 - score * score)]);
    put.run(guild, kind, id, model, Buffer.from(vector.buffer), Date.now());
  };
  for (const [id, score] of [[exact, 0.845], [repeat, 0.87], [independent, 0.868], [third, 0.865], [unrelated, 0.82], [tooLow, 0.825]]) add('claim', id, score);
  for (const [id, score] of [[sourceA, 0.9], [sourceB, 0.898], [sourceC, 0.897], [sourceD, 0.895], [sourceE, 0.89]]) add('episode', id, score);
  vectors.setEmbedder(async (texts) => ({ dim: 2, vectors: texts.map(() => Buffer.from(new Float32Array([1, 0]).buffer).toString('base64')) }));
  const traces = [];
  const options = { nodeLimit: 0, episodeLimit: 2, chunkLimit: 3, minScore: 0.86, autoRecall: { anchorText: '「赤い月」を覚えている？' }, onTrace: (trace) => traces.push(trace) };
  const found = await vectors.meaningOf(guild, '観測した話', options);
  assert.deepEqual(found.chunks.map((entry) => entry.id), [exact, independent, third], 'a quoted exact fact near the floor joins independent sources before a repeated source');
  assert.deepEqual(found.episodes.map((entry) => entry.id), [sourceD, sourceE], 'episode slots refill with evidence not already represented by claims');
  assert.deepEqual([traces[0].status, traces[0].candidateCounts.claim, traces[0].selectedCounts.claim], ['matched', 6, 3]);
  assert.ok(!found.chunks.some((entry) => entry.id === tooLow), 'exact words cannot admit a claim more than 0.02 below the floor');
  assert.equal(/赤い月|920000000000000099|person-1/.test(JSON.stringify(traces[0])), false, 'trace has counts and timing, no content or IDs');
  const unanchored = await vectors.meaningOf(guild, '観測した話', { ...options, autoRecall: { anchorText: '' } });
  assert.ok(!unanchored?.chunks.some((entry) => entry.id === exact), 'the same close miss does not pass without anchor evidence');
  const mentioned = await vectors.meaningOf(guild, '観測した話', { ...options, autoRecall: { anchorText: '', mentionedUserIds: ['person-1'] } });
  assert.ok(mentioned?.chunks.some((entry) => entry.id === exact), 'a supplied exact person ID can admit a nearby fact');
  const episodeAnchor = await vectors.meaningOf(guild, '観測した話', { ...options, chunkLimit: 0, minScore: 0.9, autoRecall: { anchorText: '「もう一つの話」' } });
  assert.ok(episodeAnchor?.episodes.some((entry) => entry.id === sourceE), 'episode title evidence admits a close miss');
  const episodeNoAnchor = await vectors.meaningOf(guild, '観測した話', { ...options, chunkLimit: 0, minScore: 0.9, autoRecall: { anchorText: '' } });
  assert.ok(!episodeNoAnchor?.episodes.some((entry) => entry.id === sourceE), 'the episode keeps its floor without an anchor');
  const japaneseMonth = await vectors.meaningOf(guild, '観測した話', { ...options, chunkLimit: 0, minScore: 0.9, autoRecall: { anchorText: `「もう一つの話」 ${new Date(at + 9 * 3_600_000).toISOString().slice(0, 7).replace('-', '年').replace(/(\d{2})$/, '$1月')}` } });
  assert.ok(japaneseMonth?.episodes.some((entry) => entry.id === sourceE), 'Japanese year-month anchors are accepted');
  await vectors.meaningOf(guild, '観測した話', { ...options, minScore: 0.99 });
  assert.equal(traces.at(-1).status, 'below_cutoff');
  await vectors.meaningOf(guild, '観測した話', { ...options, excludeEpisodes: new Set([sourceA, sourceB, sourceC, sourceD, sourceE]), excludeChunks: new Set([exact, repeat, independent, third, unrelated, tooLow]) });
  assert.equal(traces.at(-1).status, 'no_candidates');
  await vectors.meaningOf('920000000000000098', '観測した話', options);
  assert.equal(traces.at(-1).status, 'no_vectors');
  const entityId = Number(db.prepare("INSERT INTO v2_entities (guild_id, kind, key, name) VALUES (?, 'person', 'person-3', '観測者')").run(guild).lastInsertRowid);
  const duplicate = (ord, modality, hedged) => Number(db.prepare(`
    INSERT INTO v2_claims (guild_id, section_id, ord, about_kind, about_key, text, type, modality, hedged, as_of, episode_id, entity_id)
    VALUES (?, 1, ?, 'person', 'person-3', '同じ観測結果', 'fact', ?, ?, ?, ?, ?)
  `).run(guild, ord, modality, hedged, at, sourceD, entityId).lastInsertRowid);
  const plain = duplicate(7, 'plain', 0);
  const selfReport = duplicate(8, 'self_report', 0);
  const joke = duplicate(9, 'joke', 0);
  const hedged = duplicate(10, 'plain', 1);
  for (const [id, score] of [[plain, 0.89], [selfReport, 0.88], [joke, 0.87], [hedged, 0.865]]) add('claim', id, score);
  const originalClaims = new Set([exact, repeat, independent, third, unrelated, tooLow]);
  const distinct = await vectors.meaningOf(guild, '観測した話', { ...options, episodeLimit: 0, excludeChunks: originalClaims, autoRecall: { anchorText: '' } });
  assert.deepEqual(distinct?.chunks.map((entry) => entry.id), [selfReport, joke], 'self-report wins its plain duplicate; a joke remains distinct');
  const distinctHedge = await vectors.meaningOf(guild, '観測した話', { ...options, episodeLimit: 0, excludeChunks: new Set([...originalClaims, plain, selfReport]), autoRecall: { anchorText: '' } });
  assert.deepEqual(distinctHedge?.chunks.map((entry) => entry.id), [joke, hedged], 'hedged and joke claims remain distinct');
  vectors.setEmbedder(() => new Promise(() => {}));
  await vectors.meaningOf(guild, '観測した話', { ...options, timeoutMs: 20 });
  assert.equal(traces.at(-1).status, 'cold_or_timeout');
  vectors.setEmbedder(async () => { throw new Error('worker down'); });
  await vectors.meaningOf(guild, '観測した話', options);
  assert.equal(traces.at(-1).status, 'embed_failure');
  vectors.setEmbedder(fakeEmbed);
}

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

console.log('memory vectors ok (差分だけ振る / 消えたら消す / 別モデルは使わない / 近い順 / 間に合わなければ null / 旧索引からも自動想起できる / memory ツール / 本文を1行ずつに割る・書き直しても引き継ぐ・節だけ開く)');
