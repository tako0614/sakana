// 空振りの繰り返しへの助言と、「事実を聞かれたら1回調べさせる」の検証 (npm run check から tsx で呼ぶ)。
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'sakana-coach-'));
process.env.DATABASE_PATH = join(directory, 'main.sqlite');
process.env.ARCHIVE_DB_PATH = join(directory, 'archive.sqlite');
process.env.AGENT_RUNTIME_PATH = join(directory, 'runs.sqlite');
process.env.OPENROUTER_API_KEY = 'check';
const { createCoach, isEmptyResult } = await import('../src/agent/coach.ts');
const { lookupAdvised, lookupGuard, countsAsLookup, LOOKUP_HINT } = await import('../src/agent/lookup.ts');
const { runAgent } = await import('../src/ai/runtime.ts');

// ---- coach: 空振りの連続と同じ呼び出しの繰り返し ----------------------------------
for (const empty of ['該当するメッセージはありませんでした (archive)。取り込みの穴かもしれない。', 'クエリが不正です: x', 'ツールの実行に失敗しました: y',
  'action を指定してください。', '記憶に「あ」は見つかりませんでした。原文は search で探せます。', 'ページ people/x はありません。']) {
  assert.ok(isEmptyResult(empty), empty);
}
for (const ok of ['3 件ヒット (1 人 / 1 チャンネル)', 'ページ: - [[people/たこ]]', '意味が近い記憶']) assert.ok(!isEmptyResult(ok), ok);

const coach = createCoach();
const none = '該当するメッセージはありませんでした (archive)。';
assert.equal(coach('search', { query: 'a' }, none), none, 'the first miss gets no advice');
const second = coach('search', { query: 'b' }, none);
assert.match(second, /空振りが続いている/, 'two misses in a row bring the advice');
assert.match(second, /memory \/ browser/);
assert.equal(coach('search', { query: 'c' }, '2 件ヒット'), '2 件ヒット', 'a hit clears the streak');
assert.equal(coach('search', { query: 'd' }, none), none, 'and the next miss is a first miss again');
// 同じ引数の繰り返し (キーの順が違っても同じ)
assert.match(coach('search', { query: 'x', author: 'y' }, '1 件ヒット'), /^1 件ヒット$/);
assert.match(coach('search', { author: 'y', query: 'x' }, '1 件ヒット'), /同じ呼び出しを前にもしている/);
assert.equal(coach('read', { at: 1 }, 'ok'), 'ok', 'another tool is not a repeat');

// ---- lookup: 事実を聞いているか ---------------------------------------------------
for (const asking of ['Rayの弱み掘り返して', 'えだまめの黒歴史ある？', 'Amex2190について教えて', 'さかなのやらかしエピ教えて', 'たこって誰？', '<@123> 恋人疑惑のある人探して', 'えだまめっていつ参加した', '昔の話して']) {
  assert.ok(lookupAdvised(asking), asking);
}
for (const chat of ['なんか面白いことないの', 'ころすよ', 'どっちのがいい？', 'おはよう', 'うける', 'はい']) {
  assert.ok(!lookupAdvised(chat), chat);
}
assert.ok(!lookupAdvised('たこ元気かな', { known: true }), 'a known name alone is not a question');
assert.ok(lookupAdvised('たこってダブスタじゃない？', { known: true }), 'a known name in a question is');
assert.ok(!lookupAdvised('たこってダブスタじゃない？', { known: false }));
assert.ok(!lookupAdvised('<@123>', {}), 'a bare mention is not a question');

// ---- runtime に通すと、最初の答えを1回だけやり直させる ------------------------------
async function run({ request, known = false, toolFirst = false }) {
  let used = false;
  const requests = [];
  const guard = lookupGuard({ request, known, usedTool: () => used });
  const result = await runAgent({
    guildId: 'g', runId: `coach-${Math.random()}`, system: 's', userContent: request, validate: guard,
    onToolCall: () => { used = true; },
    toolset: { readOnly: true, definitions: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }], call: async () => '結果' },
    request: async ({ messages }) => {
      requests.push(messages.map((m) => `${m.role}:${String(m.content ?? '').slice(0, 30)}`));
      const retried = messages.some((m) => m.role === 'user' && String(m.content).startsWith('RETRY:'));
      if (toolFirst && requests.length === 1) return { choices: [{ message: { content: '', tool_calls: [{ id: 't1', function: { name: 'search', arguments: '{}' } }] } }] };
      if (retried && !messages.some((m) => m.role === 'tool')) return { choices: [{ message: { content: '', tool_calls: [{ id: 't2', function: { name: 'search', arguments: '{}' } }] } }] };
      return { choices: [{ message: { content: `答え${requests.length}` } }] };
    }
  });
  return { result, requests };
}
const factual = await run({ request: 'さかなのやらかしエピ教えて' });
assert.equal(factual.requests.length, 3, 'answer without tools → one retry → tool call → final answer');
assert.ok(factual.requests[1].some((line) => line.startsWith('user:RETRY: 事実が絡む話')), 'the hint is handed to the model');
assert.equal(factual.result.text, '答え3');
const chatty = await run({ request: 'なんか面白いことないの' });
assert.equal(chatty.requests.length, 1, 'banter is answered at once');
assert.equal(chatty.result.text, '答え1');
const checked = await run({ request: 'さかなのやらかしエピ教えて', toolFirst: true });
assert.equal(checked.requests.length, 2, 'a run that already used a tool is not asked again');
// 2回目は何を答えてもよい (やり直しは1回だけ)
let answers = 0;
const guard = lookupGuard({ request: 'Aについて教えて', known: false, usedTool: () => false });
assert.throws(() => guard({ content: 'x' }), (error) => error.governanceRetryHint === LOOKUP_HINT);
assert.equal(guard({ content: 'y' }), 'y');
answers += 1;

// memory_focus は思い出したいことを伝えるだけで、何も取ってこない。呼んだだけで「調べた」扱いにしない
for (const name of ['search', 'read', 'memory', 'channels', 'info', 'browser', 'governance']) assert.ok(countsAsLookup(name), `${name} looks something up`);
assert.ok(!countsAsLookup('memory_focus'), 'memory_focus alone is not a lookup');

console.log('coach ok (空振りの連続と同じ呼び出しに助言 / 事実を聞かれて調べていなければ1回だけやり直し / 雑談は止めない)');
