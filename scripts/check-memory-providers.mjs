// 記憶の書き手が、壊れた出力を返す provider を外して取り直すことの検証 (npm run check から呼ぶ)。
//
// 2026-10-15、OpenRouter が glm-5.3-flash を回す先のうち OpenInference は3万トークン読ませても
// {"episodes":[],"facts":[]} だけを返し、Morph は半数が 16000 トークンまで暴走した。
// どちらも呼び出しとしては成功なので、空の区切りが「完了」として静かに積み上がっていた。
//   - 長い区切りの空の結果は読めていないとみなす
//   - 空・途中で切れた出力はすぐ送り直す (2回まで)
//   - 外すのは壊れている割合が高い provider だけ (直近1時間に3回以上、4回に1回以上)。
//     2026-10-16、1回の暴走で外していたら、いちばん安くまともな StreamLake まで外れて読み込みが止まりかけた
//   - 外した provider は次の呼び出しでも OpenRouter の provider.ignore に入る
//
// ARCHIVE_DB_PATH と MEMORY_DB_PATH を一時ファイルに向けて呼ぶこと。

import assert from 'node:assert/strict';

process.env.OPENROUTER_API_KEY ||= 'check';
process.env.MEMORY_TREE_BUDGET_USD = '1';
process.env.MEMORY_TREE_MODELS = 'check/memory-model';
const { avoidProvider, avoidedProviders, budgetIdFor, checkSegmentOutput, forgetProviderRecord, openRouterCaller, treeConfig } = await import('../src/memory/build.js');

// --- 予算は月 (UTC) ごとの枠。読み終えた後も新着を読み続けるので、通算だといずれ止まる ---
assert.equal(budgetIdFor('g', Date.UTC(2026, 9, 31, 23)), 'memory-tree:g:2026-10:1');
assert.equal(budgetIdFor('g', Date.UTC(2026, 10, 1)), 'memory-tree:g:2026-11:1', 'a new month starts a new budget');

const sent = [];
const bodies = [];
// provider ごとの返事: 空の JSON・暴走 (length で切れる)・まともな結果・5回に1回だけ暴走する
const good = { finish_reason: 'stop', content: '{"episodes":[{"title":"t","summary":"s","lines":[1]}],"facts":[]}' };
const runaway = { finish_reason: 'length', content: '{"episodes":[{"title":"' + 'あ'.repeat(50) };
let flakyCalls = 0;
const replies = {
  Empty: { finish_reason: 'stop', content: '{"episodes":[],"facts":[]}' },
  Runaway: runaway,
  Good: good,
  get Flaky() { flakyCalls += 1; return flakyCalls % 5 === 0 ? runaway : good; }
};
let order = ['Empty', 'Good'];
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/endpoints')) {
    return { ok: true, json: async () => ({ data: { endpoints: [{ provider_name: 'Good', pricing: { prompt: '0.0000001', completion: '0.0000003' } }] } }) };
  }
  const body = JSON.parse(init.body);
  sent.push(body.provider?.ignore ?? []);
  bodies.push(body);
  // OpenRouter は ignore に無い先のうち安い順に回す。ここでは order の先頭から
  const provider = order.find((name) => !(body.provider?.ignore ?? []).includes(name));
  const reply = replies[provider];
  return { ok: true, json: async () => ({
    id: `gen-${sent.length}`, model: body.model, provider,
    choices: [{ finish_reason: reply.finish_reason, message: { role: 'assistant', content: reply.content } }],
    usage: { prompt_tokens: 1000, completion_tokens: 20, cost: 0.0001 }
  }) };
};

// --- 長い区切りの空の結果は読めていない。短い区切りなら空でもよい ---
const longPack = { text: 'x'.repeat(treeConfig.emptyChars), lineMap: new Map([[1, { ids: ['1'] }], [2, { ids: ['2'] }]]) };
const usable = { title: 't', summary: 's', lines: [2] };
assert.throws(() => checkSegmentOutput(longPack, { episodes: [], facts: [] }), /no usable episode/, 'an empty result for a long segment is a failure');
assert.doesNotThrow(() => checkSegmentOutput({ text: 'x'.repeat(100), lineMap: new Map() }, { episodes: [], facts: [] }), 'a short segment may be empty');
// 実在しない行の出来事1件だけ (Morph がそうした) も、知識は全部捨てられるので読めていない
assert.throws(() => checkSegmentOutput(longPack, { episodes: [{ title: 't', summary: 's', lines: [999] }], facts: [{ path: 'people/a', text: 'b', episode: 0 }] }), /no usable episode/);
assert.throws(() => checkSegmentOutput(longPack, { episodes: [{ title: '', summary: 's', lines: [1] }] }), /no usable episode/, 'an untitled episode is dropped too');
assert.doesNotThrow(() => checkSegmentOutput(longPack, { episodes: [{ title: 't', summary: 's', lines: [999] }, usable] }));

// --- 空を返し続ける provider は3回で外れ、次の呼び出しから別の provider へ ---
const call = openRouterCaller({ guildId: 'check-guild' });
await assert.rejects(call({ kind: 'segment', system: 's', user: 'u', check: (json) => checkSegmentOutput(longPack, json) }), /no usable episode/,
  'three empty answers in a row fail the call (two resends)');
assert.deepEqual(sent, [[], [], []], 'one empty answer does not exclude a provider: ' + JSON.stringify(sent));
assert.deepEqual(avoidedProviders(), ['Empty'], 'a provider that keeps answering empty is avoided');
const result = await call({ kind: 'segment', system: 's', user: 'u', check: (json) => checkSegmentOutput(longPack, json) });
assert.equal(result.provider, 'Good');
assert.equal(result.json.episodes.length, 1);
// builder は起動し直すので DB に控える。1時間で戻す
const { getState: savedState } = await import('../src/memory/store.js');
assert.deepEqual(Object.keys(savedState('bad-providers')), ['Empty'], 'avoided providers survive a restart');
assert.deepEqual(avoidedProviders(Date.now() + 2 * 3_600_000), [], 'they come back after an hour');
avoidProvider('Empty');

// --- ときどき暴走するだけの provider は外さない (送り直せば読める) ---
forgetProviderRecord();
order = ['Flaky', 'Good'];
sent.length = 0;
for (let i = 0; i < 12; i += 1) {
  const answer = await call({ kind: 'segment', system: 's', user: 'u', check: (json) => checkSegmentOutput(longPack, json) });
  assert.equal(answer.provider, 'Flaky', 'a resend on the same provider works');
}
assert.ok(!avoidedProviders().includes('Flaky'), 'one runaway in five is not a reason to drop the cheapest provider');
assert.equal(sent.length, 12 + Math.floor(flakyCalls / 5), 'each runaway costs one resend');
order = ['Empty', 'Good'];

// --- 単価の上限: 予約の値段と、出力の高い provider を避ける上限の低い方を送る ---
assert.deepEqual(bodies[0].provider.max_price, { prompt: 0.1, completion: 0.3, request: 0 }, 'only the reserved price caps by default');
treeConfig.maxPrice = { prompt: 0.05, completion: 0.2 };
bodies.length = 0;
await call({ kind: 'segment', system: 's', user: 'u', check: (json) => checkSegmentOutput(longPack, json) });
assert.deepEqual(bodies[0].provider.max_price, { prompt: 0.05, completion: 0.2, request: 0 }, 'the tighter cap wins: ' + JSON.stringify(bodies[0].provider));
treeConfig.maxPrice = { prompt: 1, completion: 1 };
bodies.length = 0;
await call({ kind: 'segment', system: 's', user: 'u', check: (json) => checkSegmentOutput(longPack, json) });
assert.deepEqual(bodies[0].provider.max_price, { prompt: 0.1, completion: 0.3, request: 0 }, 'a looser cap never raises the reserved price');
treeConfig.maxPrice = null;

// --- 次の呼び出しも最初から外したまま送る ---
sent.length = 0;
await call({ kind: 'segment', system: 's', user: 'u', check: (json) => checkSegmentOutput(longPack, json) });
assert.deepEqual(sent, [['Empty']], 'later calls keep ignoring it');

// --- 外しすぎて回す先が無い (404) なら、外したものを忘れて送り直す ---
const realFetch = globalThis.fetch;
let noEndpoint = true;
sent.length = 0;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('/endpoints') && JSON.parse(init.body).provider?.ignore?.length && noEndpoint) {
    sent.push('404');
    return { ok: false, status: 404, headers: new Map(), json: async () => ({ error: { code: 404, message: 'No endpoints found' } }) };
  }
  return realFetch(url, init);
};
order = ['Good'];
const recovered = await call({ kind: 'segment', system: 's', user: 'u', check: (json) => checkSegmentOutput(longPack, json) });
assert.equal(recovered.provider, 'Good');
assert.deepEqual(sent, ['404', []], 'a 404 from ignoring too much clears the list and resends: ' + JSON.stringify(sent));
assert.deepEqual(avoidedProviders(), []);
globalThis.fetch = realFetch;
avoidProvider('Empty');

// --- どこも空なら、2回取り直したあとで失敗として返す (完了にしない) ---
order = ['Empty', 'Empty2'];
replies.Empty2 = replies.Empty;
sent.length = 0;
await assert.rejects(call({ kind: 'segment', system: 's', user: 'u', check: (json) => checkSegmentOutput(longPack, json) }), /no usable episode/);
assert.equal(sent.length, 3, 'two resends, then give up');

// --- 空のまま「完了」になった長い区切りを読み直しに回す ---
const { getState, insertEpisode, memoryDb, recordSegment, reopenEmptySegments, setState } = await import('../src/memory/store.js');
const G = 'check-reopen';
const seg = (fromId, fromMs, chars) => ({ channelId: 'c1', fromId, toId: `${fromId}9`, fromMs, toMs: fromMs + 1000, messages: 50, chars });
recordSegment(G, seg('100', 10_000, 9000), { status: 'done' });   // 出来事あり
recordSegment(G, seg('200', 20_000, 9000), { status: 'done' });   // 空 → 読み直す
recordSegment(G, seg('300', 30_000, 500), { status: 'done' });    // 短いので空でもよい
insertEpisode(G, { title: 't', summary: 's', channelId: 'c1', atMs: 10_200, endMs: 10_800, sources: ['101'], importance: 2 });
setState(`retry:${G}:c1:200`, { count: 3 });
assert.deepEqual(reopenEmptySegments(G, { minChars: 4000 }).map((row) => row.from_id), ['200'], 'only the long empty segment');
assert.equal(memoryDb().prepare("SELECT status FROM segments WHERE guild_id = ? AND from_id = '200'").get(G).status, 'done', 'a dry run changes nothing');
reopenEmptySegments(G, { minChars: 4000, apply: true });
assert.equal(memoryDb().prepare("SELECT status FROM segments WHERE guild_id = ? AND from_id = '200'").get(G).status, 'failed');
assert.equal(getState(`retry:${G}:c1:200`), null, 'the retry counter starts over');
assert.equal(reopenEmptySegments(G, { minChars: 4000 }).length, 0);

console.log('memory providers ok (予算は月ごと / 単価の上限は予約と設定の低い方 / 空のまま完了した区切りを読み直しに回す / 長い区切りの空は失敗 / 壊れ続ける provider だけ外す・時々の暴走では外さない / 外した provider は DB に控えて1時間 / 外したまま次も送る / 回す先が無くなったら忘れる / 取り直しは2回まで)');
