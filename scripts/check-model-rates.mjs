// OpenRouter の価格情報の読み取りの検証 (npm run check から呼ぶ)。
//
// 2026-10-15、提供元の1つ (Alibaba) が時間帯ごとの価格 `overrides` (配列) を返し始め、
// 「数値でない値段がある」としてモデルごと拒否していた (会話 AI が全部止まる)。
//   - overrides 付きの価格を受け入れ、時間帯の中でいちばん高い値段を上限にする
//   - overrides の形が崩れているものは拒否する
//   - :free は overrides を含めてすべて 0 円でなければ拒否する (discount は値段ではない)
//
// ARCHIVE_DB_PATH を一時ファイルに向けて呼ぶこと。

import assert from 'node:assert/strict';

process.env.OPENROUTER_API_KEY ||= 'check';
const { refreshModelRates } = await import('../src/ai/provider.js');

let endpoints = [];
globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { endpoints } }) });

endpoints = [
  { provider_name: 'Plain', pricing: { prompt: '0.000000091', completion: '0.000000182', input_cache_read: '0.000000018', discount: 0 } },
  { provider_name: 'Alibaba', pricing: { prompt: '0.0000001', completion: '0.0000003', input_cache_read: '0.00000001', discount: 0,
    overrides: [
      { utc_start: 0, utc_end: 1400, prompt: '0.000000374', completion: '0.000001122', input_cache_read: '0.0000000374' },
      { utc_start: 1400, utc_end: 0, prompt: '0.000000187', completion: '0.000000561' }
    ] } }
];
const rates = await refreshModelRates('check/overrides-model');
assert.equal(rates.verifiedRoute, 'paid');
assert.ok(Math.abs(rates.input - 0.374) < 1e-9, 'input bound must include the most expensive time window: ' + rates.input);
assert.ok(Math.abs(rates.output - 1.122) < 1e-9, 'output bound must include the most expensive time window: ' + rates.output);
assert.ok(Math.abs(rates.cached - 0.0374) < 1e-9, 'cached bound must include override cache prices: ' + rates.cached);

endpoints = [{ pricing: { prompt: '0.0000001', completion: '0.0000003', overrides: 'nightly' } }];
await assert.rejects(refreshModelRates('check/bad-overrides'), /overrides/, 'malformed overrides must be refused');

endpoints = [{ pricing: { prompt: '0.0000001', completion: '0.0000003', overrides: [{ prompt: '-1' }] } }];
await assert.rejects(refreshModelRates('check/negative-override'), /invalid endpoint pricing/, 'negative override prices must be refused');

endpoints = [{ pricing: { prompt: '0', completion: '0', discount: 0.5, overrides: [{ utc_start: 0, utc_end: 600, prompt: '0', completion: '0' }] } }];
assert.equal((await refreshModelRates('check/free-model:free')).verifiedRoute, 'free', 'zero-priced overrides keep a free route free');

endpoints = [{ pricing: { prompt: '0', completion: '0', overrides: [{ utc_start: 0, utc_end: 600, prompt: '0.0000001', completion: '0' }] } }];
await assert.rejects(refreshModelRates('check/paid-window:free'), /nonzero/, 'a :free route with a paid time window must be refused');

console.log('model rates ok (時間帯の価格 overrides を受け入れて最も高い値段を上限に / 崩れた形は拒否 / :free は全時間帯 0 円)');
