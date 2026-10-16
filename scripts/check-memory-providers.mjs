// 記憶の本の書き手が、壊れた出力を返す provider を外して取り直すことの検証 (npm run check から呼ぶ)。
//
// 2026-10-15、OpenRouter が glm-5.3-flash を回す先のうち OpenInference は3万トークン読ませても
// {"episodes":[],"facts":[]} だけを返し、Morph は半数が 16000 トークンまで暴走した。
// どちらも呼び出しとしては成功なので、空の区切りが「完了」として静かに積み上がっていた。
//   - 長い区切りの空の結果は読めていないとみなす
//   - 空を返した provider・途中で切れた provider は外してすぐ送り直す
//   - 外した provider は次の呼び出しでも OpenRouter の provider.ignore に入る
//
// ARCHIVE_DB_PATH と MEMORY_DB_PATH を一時ファイルに向けて呼ぶこと。

import assert from 'node:assert/strict';

process.env.OPENROUTER_API_KEY ||= 'check';
process.env.MEMORY_TREE_BUDGET_USD = '1';
process.env.MEMORY_TREE_MODELS = 'check/memory-model';
const { avoidProvider, avoidedProviders, checkSegmentOutput, openRouterCaller, treeConfig } = await import('../src/memory/build.js');

const sent = [];
const bodies = [];
// provider ごとの返事: 空の JSON・暴走 (length で切れる)・まともな結果
const replies = {
  Empty: { finish_reason: 'stop', content: '{"episodes":[],"facts":[]}' },
  Runaway: { finish_reason: 'length', content: '{"episodes":[{"title":"' + 'あ'.repeat(50) },
  Good: { finish_reason: 'stop', content: '{"episodes":[{"title":"t","summary":"s","lines":[1]}],"facts":[]}' }
};
let order = ['Empty', 'Runaway', 'Good'];
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

// --- 空・暴走の provider を外して、3回目でまともな結果を取る ---
const call = openRouterCaller({ guildId: 'check-guild' });
const result = await call({ kind: 'segment', system: 's', user: 'u', check: (json) => checkSegmentOutput(longPack, json) });
assert.equal(result.provider, 'Good');
assert.equal(result.json.episodes.length, 1);
assert.deepEqual(sent, [[], ['Empty'], ['Empty', 'Runaway']], 'each bad provider is ignored on the next try: ' + JSON.stringify(sent));
assert.deepEqual(avoidedProviders().sort(), ['Empty', 'Runaway'], 'bad providers stay avoided');
// builder は1時間ごとに起動し直すので DB に控える。期限が過ぎたら戻す
const { getState: savedState } = await import('../src/memory/store.js');
assert.deepEqual(Object.keys(savedState('bad-providers')).sort(), ['Empty', 'Runaway'], 'avoided providers survive a restart');
assert.deepEqual(avoidedProviders(Date.now() + 4 * 3_600_000), [], 'they come back after three hours');
avoidProvider('Empty'); avoidProvider('Runaway');

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
assert.deepEqual(sent, [['Empty', 'Runaway']], 'later calls keep ignoring them');

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
avoidProvider('Empty'); avoidProvider('Runaway');

// --- どこも空なら、2回取り直したあとで失敗として返す (完了にしない) ---
order = ['Empty', 'Empty2', 'Empty3', 'Empty4'];
replies.Empty2 = replies.Empty3 = replies.Empty4 = replies.Empty;
sent.length = 0;
await assert.rejects(call({ kind: 'segment', system: 's', user: 'u', check: (json) => checkSegmentOutput(longPack, json) }), /no usable episode/);
assert.equal(sent.length, 3, 'two swaps, then give up');

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

console.log('memory providers ok (単価の上限は予約と設定の低い方 / 空のまま完了した区切りを読み直しに回す / 外した provider は DB に控えて3時間 / 回す先が無くなったら忘れる / 長い区切りの空は失敗 / 空・暴走の provider を外して取り直す / 外したまま次も送る / 取り直しは2回まで)');
