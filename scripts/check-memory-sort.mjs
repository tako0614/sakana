// 統合待ちが溜まりすぎたページの仕分けと、新しいページの最初の本文の検証 (npm run check から呼ぶ)。
//
// 2026-10-16、人のページ (あかり 8万字・たこ 5万字) の統合待ちを本文3000字へ書き直させると、
// モデルは千字ほどに縮めて「削りすぎ」で却下され続けた。小さい新ページ 1,090 件は書き直しの
// 境目 (1200字) に届かず、読み終えるまで「まとめ中」のままだった。
//   - 溜まりすぎたページは、統合待ちを番号で子ページへ仕分ける (書き直さないので1行も落ちない)
//   - 子へ回した行が引く出来事は子にも結ぶ / main は親の末尾へ戻す
//   - 仕分けになっていない出力 (子へ4割未満) は却下し、3回失敗したら普通の統合へ戻す
//   - 本文の無い新しいページは、空いた統合の枠で10件ずつ最初の本文を書く
//   - 人のページの子 (Linux・環境 など) は想起の照合に入れない
//
// ARCHIVE_DB_PATH と MEMORY_DB_PATH を一時ファイルに向けて呼ぶこと。

import assert from 'node:assert/strict';

const { applySortResult, runBuild, treeConfig } = await import('../src/memory/build.js');
const st = await import('../src/memory/store.js');
const { matchPages, forgetNames } = await import('../src/memory/recall.js');

const G = 'check-sort';
st.resetTree(G);
st.savePublicChannels(G, ['900000000000000077']);
st.ensureSeeds(G);
const now = Date.now();

// 出来事を4つ。統合待ちの行はこれを引く
const episodes = [0, 1, 2, 3].map((i) => st.insertEpisode(G, { title: `出来事${i}`, summary: 's', channelId: 'c', atMs: now - i * 1000,
  endMs: now, sources: [`${i}`], importance: 2 }));
const filler = 'について長めに語った。'.repeat(15);
const lines = Array.from({ length: 40 }, (_, i) => `${i < 20 ? '技術' : i < 36 ? '関係' : '核'}の話 ${i + 1} ${filler} [e${episodes[i % 4]}]`);
st.ensureNode(G, 'people/あかり', { summary: '猫語の bot 開発者' });
st.writePage(G, 'people/あかり', { summary: '猫語の bot 開発者', body: 'あかりは猫語で話す bot 開発者 [e1]', aliases: [] });
st.addPending(G, 'people/あかり', lines, { firstAt: now - 5000, lastAt: now });
assert.ok(st.getNode(G, 'people/あかり').pending.length >= treeConfig.sortChars, 'the page must be over the sort threshold');

// 本文の無い新しいページ 12 件 (知識1行ずつ)
for (let i = 0; i < 12; i += 1) {
  st.ensureNode(G, `topics/話題${i}`);
  st.addPending(G, `topics/話題${i}`, [`話題${i}の知識 [e${episodes[0]}]`], { firstAt: now, lastAt: now });
}

const calls = [];
let sortMode = 'ok';
const fake = async ({ kind, user }) => {
  calls.push({ kind, user });
  if (kind === 'sort') {
    const count = [...user.matchAll(/^(\d+)\| /gm)].length;
    if (sortMode === 'lazy') return { model: 'fake', json: { children: [{ name: '雑多', lines: [1] }], main: [] } };
    const range = (a, b) => Array.from({ length: Math.max(0, Math.min(b, count) - a + 1) }, (_, i) => a + i);
    return { model: 'fake', json: {
      children: [
        { name: '技術・言語観', summary: '言語やツールの好み', lines: range(1, 20) },
        { name: 'あかり', summary: 'ページ自身の名前は子にしない', lines: [21] },
        { name: '人間関係', summary: '誰とどう関わるか', lines: [...range(21, 36), 999, 2] }   // 範囲外・重複は捨てる
      ],
      main: range(37, count)
    } };
  }
  if (kind === 'integrate') {
    // 「新しい知識:」から次のページの見出しまで (m フラグの $ は行末に当たるので使わない)
    const pages = [...user.matchAll(/^### (.+)\n[\s\S]*?新しい知識:\n([\s\S]*?)(?=\n\n### |\n\n各ページ|(?![\s\S]))/gm)].map((m) => ({
      path: m[1], summary: `${m[1]} の説明`,
      body: `${st.getNode(G, m[1])?.body ?? ''}\n${m[2]}`.trim()
    }));
    return { model: 'fake', json: { pages } };
  }
  if (kind === 'root') return { model: 'fake', json: { body: '- 検査用の根' } };
  throw new Error('unexpected ' + kind);
};

Object.assign(treeConfig, { minChars: 0, idleMs: 0, concurrency: 4 });
const stats = await runBuild({ guildId: G, call: fake });
assert.equal(stats.stopped, 'done', JSON.stringify(stats));

// --- 仕分け: 番号つきの行を渡し、子ページへ回す ---
const sortCalls = calls.filter((c) => c.kind === 'sort');
assert.equal(sortCalls.length, 1, 'one sort for one oversized page');
assert.match(sortCalls[0].user, /^1\| 技術の話 1 /m, 'lines are numbered for the sorter');
assert.equal(stats.sorted, 1);
const tech = st.getNode(G, 'people/あかり/技術・言語観');
const people = st.getNode(G, 'people/あかり/人間関係');
assert.ok(tech && people, 'children are created');
assert.ok(!st.getNode(G, 'people/あかり/あかり'), 'a child named after the page itself is ignored');
const textOf = (node) => `${node.body}\n${node.pending}`;
for (let i = 0; i < 20; i += 1) assert.ok(textOf(tech).includes(`技術の話 ${i + 1} `), `tech line ${i + 1} must move to the child`);
for (let i = 20; i < 36; i += 1) assert.ok(textOf(people).includes(`関係の話 ${i + 1} `), `relation line ${i + 1} must move`);
// 1行も落ちない (どこか1か所にだけある)
const parent = st.getNode(G, 'people/あかり');
for (const line of lines) {
  const key = line.slice(0, line.indexOf(' ', 5));
  const places = [parent, tech, people].filter((node) => textOf(node).includes(`${key} `)).length;
  assert.equal(places, 1, `${key} must live in exactly one page`);
}
for (let i = 36; i < 40; i += 1) assert.ok(textOf(parent).includes(`核の話 ${i + 1} `), 'main lines stay with the parent');
assert.ok(parent.body.includes('核の話 37'), 'the parent is integrated with its main lines afterwards');
// 子ページからも出来事をたどれる
assert.ok(st.episodesFor(G, 'people/あかり/技術・言語観', 10).length >= 1, 'episodes cited by moved lines link to the child');
// 子は普通に統合される (読み終えた後の掃除で)
assert.ok(tech.body.includes('技術の話 1 ') && !tech.pending, 'the child is integrated');

// --- 新しいページは10件ずつ最初の本文を書く ---
const topicCalls = calls.filter((c) => c.kind === 'integrate' && c.user.includes('### topics/話題'));
assert.ok(topicCalls.length <= 2, `12 new pages need at most 2 calls, got ${topicCalls.length}`);
for (let i = 0; i < 12; i += 1) assert.ok(st.getNode(G, `topics/話題${i}`).body.includes(`話題${i}の知識`), `new page ${i} gets a body`);
// 統合の目安の字数を渡す
assert.match(calls.find((c) => c.kind === 'integrate').user, /捨てるのは重複だけ\)|字以内に要約する\)/, 'the integrator is told the size and where the rest goes');
assert.doesNotMatch(calls.find((c) => c.kind === 'integrate').user, /字以上残す/, 'no lower bound (it made bodies too long)');

// --- 人のページの子は想起の照合に入れない ---
forgetNames(G);
assert.ok(!matchPages(G, '技術・言語観と人間関係の話').some((m) => m.path.startsWith('people/あかり/')), 'facets of a person are not recall names');
assert.ok(matchPages(G, 'あかりの話').some((m) => m.path === 'people/あかり'), 'the person still is');

// --- 仕分けになっていない出力は却下し、渡した部分が変わっていたら入れない ---
assert.throws(() => applySortResult(G, { path: 'people/あかり', consumed: '- a\n- b\n- c\n' }, { children: [{ name: 'x', lines: [1] }] }),
  /moved too little/);
st.addPending(G, 'people/あかり', ['新しい行1', '新しい行2'], { firstAt: now, lastAt: now });
assert.throws(() => applySortResult(G, { path: 'people/あかり', consumed: '- 別の行\n- 別の行2\n' },
  { children: [{ name: 'x', lines: [1] }, { name: 'y', lines: [2] }] }), /pending changed/);

// --- 名前を変えただけの仕分け (1つの子へ9割以上) と、兄弟の名前の子は受け取らない ---
// 本番で people/あかり/Linux・環境 を兄弟と同じ「技術・言語観」1つへ丸ごと移した
const many = Array.from({ length: 10 }, (_, i) => `- 環境の話 ${i + 1} [e${episodes[0]}]`).join('\n') + '\n';
st.ensureNode(G, 'people/あかり/環境');
st.addPending(G, 'people/あかり/環境', many.trim().split('\n'), { firstAt: now, lastAt: now });
const job = { path: 'people/あかり/環境', consumed: st.getNode(G, 'people/あかり/環境').pending };
assert.throws(() => applySortResult(G, job, { children: [{ name: 'ぜんぶ', lines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }] }), /did not split/);
assert.throws(() => applySortResult(G, job, { children: [{ name: '技術・言語観', lines: [1, 2, 3, 4, 5, 6] }, { name: '機材', lines: [7, 8, 9, 10] }] }),
  /moved too little|did not split/, 'a child named like a sibling is dropped, and what is left is not a sort');
const ok = applySortResult(G, job, { children: [{ name: 'ディストロ', lines: [1, 2, 3, 4, 5] }, { name: '機材', lines: [6, 7, 8, 9] }] });
assert.deepEqual(ok.children.sort(), ['ディストロ', '機材'].sort());
assert.equal(ok.kept, 1);
const sortPromptText = (await import('../src/memory/build.js')).sortPrompt(G, { path: 'people/あかり/環境', consumed: '- x\n' });
assert.match(sortPromptText, /親のページ: people\/あかり/);
assert.match(sortPromptText, /兄弟のページ \(この名前は使わない\): .*技術・言語観/, 'a deep page sees its siblings');

// --- 仕分けに3回失敗したら普通の統合へ戻す ---
st.ensureNode(G, 'people/たこ');
st.addPending(G, 'people/たこ', Array.from({ length: 40 }, (_, i) => `たこの話 ${i + 1} ${filler} [e${episodes[1]}]`), { firstAt: now, lastAt: now });
sortMode = 'lazy';
for (let i = 0; i < 3; i += 1) await runBuild({ guildId: G, call: fake });
assert.equal(st.getState(`sort-fail:${G}:people/たこ`)?.count, 3, 'three failed sorts are counted');
calls.length = 0;
await runBuild({ guildId: G, call: fake });
assert.ok(calls.some((c) => c.kind === 'integrate' && c.user.includes('### people/たこ')), 'after three failed sorts the page is integrated normally');
assert.ok(!calls.some((c) => c.kind === 'sort' && c.user.includes('people/たこ')));

st.resetTree(G);
console.log('memory sort ok (溜まりすぎたページは番号で子へ仕分け・1行も落ちない / 子にも出来事を結ぶ / main は親へ / 仕分けにならない出力は却下・3回で普通の統合 / 新ページは10件ずつ本文 / 人の子は想起に入れない)');
