// v2 の主張・出来事を使った会話の自動想起を、ローカルの偽ベクトルで検証する。

import assert from 'node:assert/strict';
import { memoryDb, resetTree } from '../src/memory/store.js';
import { ensureV2Schema } from '../src/memory/v2/schema.js';
import { claimEmbedText, allClaims } from '../src/memory/claims.js';
import { hasKind, meaningOf, setEmbedder, syncMemoryVectors } from '../src/memory/vectors.js';
import { memoryReader } from '../src/memory/recall.js';
import { runAgent, withRecallTarget } from '../src/ai/runtime.js';

const fail = (message) => { throw new Error(message); };
const equal = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
};
const GUILD = '920000000000000001';
const TAKO = '820000000000000001';
const SABA = '820000000000000002';
const T = Date.UTC(2025, 2, 14, 5, 0, 0);

// ---- 偽の埋め込み: 文字 3-gram を 64 次元に散らして正規化 (似た文は近い) ----
const fakeVector = (text) => {
  const v = new Float32Array(64);
  const chars = [...text.replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, '')];
  for (let i = 0; i + 3 <= chars.length; i += 1) {
    let h = 0;
    for (const c of chars.slice(i, i + 3).join('')) h = (h * 131 + c.codePointAt(0)) % 64;
    v[h] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
};
setEmbedder(async (texts) => ({
  dim: 64,
  vectors: texts.map((text) => Buffer.from(fakeVector(text).buffer).toString('base64'))
}));

// ---- 準備 ----
ensureV2Schema();
resetTree(GUILD);
const d = memoryDb();
for (const table of ['v2_claims', 'v2_entities', 'memory_vectors', 'episodes']) d.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(GUILD);
const entity = d.prepare("INSERT INTO v2_entities (guild_id, kind, key, name, category, path) VALUES (?, 'person', ?, ?, 'people', ?)");
const takoEntity = Number(entity.run(GUILD, TAKO, 'たこ', 'people/たこ').lastInsertRowid);
const sabaEntity = Number(entity.run(GUILD, SABA, 'さば', 'people/さば').lastInsertRowid);
const episode = d.prepare('INSERT INTO episodes (id, guild_id, kind, title, summary, channel_id, at_ms, end_ms, sources, importance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
episode.run(1, GUILD, 'レスバ', 'Rust と Go の言い合い', 'たこが Rust、さばが Go を推して 1 時間言い合った → 決着せず', 'c', T, T + 1000, '[]', 2, T);
episode.run(2, GUILD, '事件', 'テトリス杯の決勝', 'さばがテトリス杯で優勝し、賞品の nitro を受け取った', 'c', T + 86_400_000, T + 86_401_000, '[]', 3, T);
episode.run(3, GUILD, '記録', 'Rust 長い主張の根拠', '長い主張を記録した。原文は episode で確認できる。', 'c', T + 2 * 86_400_000, T + 2 * 86_400_000 + 1000, '[]', 2, T);
const claim = d.prepare(`
  INSERT INTO v2_claims (guild_id, section_id, episode_id, ord, about_kind, about_key, category, text, type, modality, as_of, verdict, hedged, entity_id)
  VALUES (?, 1, ?, ?, 'person', ?, 'people', ?, ?, ?, ?, ?, ?, ?)
`);
let ord = 0;
const add = (epId, who, entityId, text, type, modality, verdict = 'ok', hedged = 0) =>
  Number(claim.run(GUILD, epId, ord += 1, who, text, type, modality, T, verdict, hedged, entityId).lastInsertRowid);
const rust = add(1, TAKO, takoEntity, 'Rust 派で、型の堅さを気に入っている', 'stance', 'self_report');
const rustDup = add(1, TAKO, takoEntity, 'Rust 派で型の堅さを気に入っている', 'stance', 'plain');   // ほぼ同じ文
const rustSaba = add(1, SABA, sabaEntity, 'Rust 派で、型の堅さを気に入っている', 'stance', 'self_report');
const rustOpposite = add(1, SABA, sabaEntity, 'Rust 派で、型の堅さを気に入っていない', 'stance', 'self_report');
const longClaim = add(1, TAKO, takoEntity, `Rust 長文主張。${'説明を続ける'.repeat(80)}`, 'fact', 'plain');
const uncuttableClaim = add(3, TAKO, takoEntity, `Rust 長い主張${'説明を続ける'.repeat(80)}`, 'fact', 'plain');
const go = add(1, TAKO, takoEntity, 'Go の手軽さも認めている', 'stance', 'plain', 'ok', 1);
const goCertain = add(1, TAKO, takoEntity, 'Go の手軽さも認めている', 'stance', 'plain');
const negativeTen = add(1, TAKO, takoEntity, '数値は-10', 'fact', 'plain');
const positiveTen = add(1, TAKO, takoEntity, '数値は10', 'fact', 'plain');
const tetris = add(2, SABA, sabaEntity, 'テトリス杯で優勝した', 'fact', 'plain');
const nitro = add(2, SABA, sabaEntity, '賞品の nitro を受け取った', 'outcome', 'plain');
const onigiri = add(null, SABA, sabaEntity, 'おにぎりを 10 個食べたと言い張る', 'trait', 'joke');
const lie = add(1, TAKO, takoEntity, 'ウソの主張: 去年優勝した', 'fact', 'plain', 'wrong');

// ---- 索引 ----
equal(allClaims(GUILD).map((c) => c.id).includes(lie), false, 'wrong の主張は索引に入れない');
const text = claimEmbedText(allClaims(GUILD).find((c) => c.id === rust));
if (!text.startsWith('[たこ / 2025-03 / 立場') || !text.endsWith('Rust 派で、型の堅さを気に入っている')) fail(`埋め込む文は「[誰 / 時期 / 種類] 本文」: ${text}`);
if (!claimEmbedText(allClaims(GUILD).find((c) => c.id === onigiri)).includes('冗談')) fail('冗談は埋め込む文にも冗談と入る');
const synced = await syncMemoryVectors(GUILD, { sleepMs: 0 });
if (!hasKind(GUILD, 'claim')) fail('主張のベクトルが振られる');
if (synced.embedded < 16) fail(`主張 13 件 + 出来事 3 件が振られる: ${synced.embedded}`);

const unit = (dimension) => {
  const vector = new Float32Array(64);
  vector[dimension] = 1;
  return Buffer.from(vector.buffer);
};
const writeVector = d.prepare('UPDATE memory_vectors SET vec = ? WHERE guild_id = ? AND kind = ? AND id = ?');
const assign = (kind, ids, dimension) => ids.forEach((id) => writeVector.run(unit(dimension), GUILD, kind, id));
assign('claim', [rust, rustDup], 0);
assign('claim', [tetris, nitro], 1);
assign('claim', [onigiri], 2);
assign('claim', [longClaim, uncuttableClaim], 3);
assign('claim', [go, goCertain], 4);
assign('claim', [rustSaba, rustOpposite, negativeTen, positiveTen], 5);
assign('episode', [1], 0);
assign('episode', [2], 1);
assign('episode', [3], 3);
assert.equal(d.prepare("SELECT 1 FROM memory_vectors WHERE guild_id = ? AND kind = 'claim' AND id = ?").get(GUILD, lie), undefined);
assert.equal(hasKind(GUILD, 'chunk'), false, 'v2 indexes claims in place of page fragments');

const queries = [];
const selectQuery = (value) => {
  if (/手がかりなし/.test(value)) return 63;
  if (/テトリス/.test(value)) return 1;
  if (/おにぎり/.test(value)) return 2;
  if (/長い/.test(value)) return 3;
  if (/Go/.test(value)) return 4;
  if (/Rust/.test(value)) return 0;
  return 63;
};
setEmbedder(async (texts) => {
  queries.push([...texts]);
  return { dim: 64, vectors: texts.map((value) => unit(selectQuery(value)).toString('base64')) };
});
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('automatic recall must stay local'); };
try {
  const plain = { observations: [] };
  const read = memoryReader(GUILD, { request: 'たこは Rust をどう思ってる？' });
  const initial = await read(plain);
  assert.match(initial?.text, /本人申告.*Rust 派.*\[e1\]/);
  assert.equal((initial.text.match(/Rust 派/g) ?? []).length, 1, 'same sourced claim appears once');
  assert.equal(await read(plain), initial, 'identical input reuses one result');
  assert.equal(queries.length, 1);

  const focused = await read({ ...plain, thought: 'memory_focus.context: おにぎりの件' });
  assert.match(focused?.text, /冗談.*おにぎり.*\[\[people\/さば\]\]/);
  assert.deepEqual(queries.at(-1), ['たこは Rust をどう思ってる？ おにぎりの件'], 'focus adds a hint without replacing the current request');
  assert.equal(await read({ ...plain, thought: 'memory_focus.context: 手がかりなし' }), initial,
    'an unsuccessful refinement still delivers the relevant initial memory');
  assert.equal(await read(plain), initial, 'the focus only changes one request');

  assert.equal(await memoryReader(GUILD, { request: '今日の天気は？' })(plain), null, 'low-similarity candidates are not injected');
  assert.equal(await memoryReader(GUILD, { request: 'Rust', maxChars: 10 })(plain), null, 'budget lower than the heading means no work');
  const reply = await memoryReader(GUILD, { request: 'あの件は？', reply: `<@!${SABA}> のテトリス杯`, recent: ['周りでは Rust の話をしていた'] })(plain);
  assert.deepEqual(queries.at(-1), ['あの件は？ さば のテトリス杯']);
  assert.match(reply?.text, /テトリス.*\[e2\]/);

  const nearby = ['先ほどテトリス杯の結果が出た', '了解'];
  await memoryReader(GUILD, { request: 'VEXちゃん、あの件どうなった？', recent: nearby, callNames: ['vexちゃん'] })(plain);
  assert.deepEqual(queries.at(-1), ['VEXちゃん、あの件どうなった？ 先ほどテトリス杯の結果が出た']);
  await memoryReader(GUILD, { request: '今日の天気は？', recent: nearby })(plain);
  assert.deepEqual(queries.at(-1), ['今日の天気は？'], 'an independent question does not borrow the previous topic');
  await memoryReader(GUILD, { request: 'た'.repeat(249) + '？', reply: 'テトリス杯は先週に開催' })({ ...plain, reasoning: '新しく考えた補足' });
  assert.match(queries.at(-1)[0], /テトリス杯は先週に開催 新しく考えた補足$/, 'adding a hint preserves the direct reply even after a long request');

  const long = await memoryReader(GUILD, { request: '長いメモ', maxChars: 150 })(plain);
  assert.ok(long && long.text.length <= 150 && long.text.includes('[e1]'), 'the budget keeps complete source pointers');
  const fromTranscript = await memoryReader(GUILD, { request: 'その結果は？' })({
    observations: [`tool:read: 話者（この資料内）:\n${'話者の情報 '.repeat(28)}\n1) 18:30 u1:\n> テトリス杯で優勝した\n| 添付 未読`]
  });
  assert.deepEqual(queries.at(-1), ['その結果は？ テトリス杯で優勝した']);
  assert.match(fromTranscript?.text, /テトリス.*\[e2\]/);

  const structured = await memoryReader(GUILD, { request: 'その結果は？' })({
    observations: ['tool:read: 話者（この資料内）:\n1) 18:30 u1:\n> Rust 派である\n2) 18:31 u2:\n> テトリス杯で優勝した'],
    readTarget: 'テトリス杯で優勝した'
  });
  assert.deepEqual(queries.at(-1), ['その結果は？ テトリス杯で優勝した'], 'authorized target replaces the chronological neighbor');
  assert.match(structured?.text, /テトリス.*\[e2\]/);
  await memoryReader(GUILD, { request: 'その結果は？' })({
    observations: ['tool:read: 話者（この資料内）:\n1) 18:30 u1:\n> Rust 派である'], readTarget: null
  });
  assert.deepEqual(queries.at(-1), ['その結果は？'], 'a read without its actual target cannot borrow a neighbor');

  const count = queries.length;
  assert.equal(await memoryReader('no-vectors', { request: 'Rust' })(plain), null);
  assert.equal(await memoryReader(GUILD, { request: '' })(plain), null);
  assert.equal(queries.length, count, 'empty calls and guilds without indexed vectors skip embedding');

  let rounds = 0;
  const result = await runAgent({
    guildId: GUILD, system: 's', userContent: 'Rust の話', memory: { read: memoryReader(GUILD, { request: 'Rust の話' }) },
    toolset: { definitions: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }], call: () => '大会結果を確認' },
    request: ({ messages }) => {
      const memory = messages.find((m) => typeof m.content === 'string' && m.content.startsWith('REFERENCE MEMORY'));
      rounds += 1;
      if (rounds === 1) {
        assert.match(memory?.content, /Rust 派.*\[e1\]/, 'same reader runs before the first answer');
        return { choices: [{ message: { reasoning: '次にテトリス杯の話を確認', tool_calls: [{ id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] } }] };
      }
      assert.match(memory?.content, /テトリス.*\[e2\]/);
      assert.match(queries.at(-1)[0], /Rust の話.*テトリス杯.*大会結果を確認/);
      return { choices: [{ message: { content: '完了' } }] };
    }
  });
  assert.equal(result.text, '完了');
  assert.equal(rounds, 2);
  assert.equal(queries.length, count + 2, 'initial and reasoning rounds each embed one query');
  assert.equal(networkCalls, 0);

  const seenTargets = [];
  let readCalls = 0;
  let postReadAttempts = 0;
  const readOptions = {
    guildId: GUILD, runId: 'structured-recall-resume', system: 's', userContent: 'read a post',
    toolset: { readOnly: true, definitions: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      call: () => { readCalls += 1; return withRecallTarget('1) neighbor\n> Rust\n2) target\n> テトリス杯', 'テトリス杯'); } },
    memory: { read: (query) => { seenTargets.push(query.readTarget); return null; } },
    request: ({ messages }) => {
      if (!messages.some((message) => message.role === 'tool')) return { choices: [{ message: {
        tool_calls: [{ id: 'read-1', function: { name: 'read', arguments: '{}' } }] } }] };
      assert.equal(messages.find((message) => message.role === 'tool')?.content, '1) neighbor\n> Rust\n2) target\n> テトリス杯');
      assert.equal(JSON.stringify(messages).includes('recallTarget'), false, 'host hint stays out of provider messages');
      if (postReadAttempts++ === 0) throw new Error('retry after saved read');
      return { choices: [{ message: { content: 'done' } }] };
    }
  };
  await assert.rejects(runAgent(readOptions), /retry after saved read/);
  assert.equal((await runAgent(readOptions)).text, 'done');
  assert.equal(readCalls, 1, 'checkpoint resume does not repeat the read');
  assert.deepEqual(seenTargets, [undefined, 'テトリス杯', 'テトリス杯'], 'actual target survives a saved checkpoint');

  let failures = 0;
  setEmbedder(async () => { failures += 1; throw new Error('worker unavailable'); });
  const offline = memoryReader(GUILD, { request: 'Rust' });
  assert.equal(await offline(plain), null);
  assert.equal(await offline(plain), null);
  assert.equal(failures, 1, 'embedder failure adds no memory and does not retry the same query');

  let attempts = 0;
  const statuses = [];
  setEmbedder(async () => {
    attempts += 1;
    if (attempts === 1) return new Promise(() => {});
    return { dim: 64, vectors: [unit(0).toString('base64')] };
  });
  const warming = memoryReader(GUILD, { request: 'Rust', timeoutMs: 25, onTrace: (trace) => statuses.push(trace.status) });
  assert.equal(await warming(plain), null);
  const ready = await warming(plain);
  assert.match(ready?.text, /Rust 派/, 'a timing miss can recover on a later model round');
  assert.equal(await warming(plain), ready);
  assert.deepEqual(statuses, ['cold_or_timeout', 'matched']);
  assert.equal(attempts, 2);
} finally {
  globalThis.fetch = originalFetch;
}

assert.ok((await meaningOf(GUILD, '', { chunkLimit: 3 })) === null);
console.log('memory recall ok (初回・CoT・焦点・出典・低スコアの棄却・外部判定なし)');
