// 返らなかった呼び出しの予約を OpenRouter の実額で精算することの検証 (npm run check から呼ぶ)。
//
// 2026-10-15、builder を止めて入れ直すたびに走っていた呼び出しが予約のまま残り、
// 実費 $0.46 に対して $4.40 を押さえ続けて $10 の上限で止まった。
//   - 今月の OpenRouter の請求額と台帳の確定額の差を、古い未確定の呼び出しに予約の大きさで按分する
//   - 予約より大きくはしない / 差が予約以上なら何もしない
//   - 走っているかもしれない新しい呼び出しは精算しない
//   - 予約のせいで止まっていた予算は再開する。手で止めた予算はそのまま
//
// ARCHIVE_DB_PATH を一時ファイルに向けて呼ぶこと。

import assert from 'node:assert/strict';

const { db } = await import('../src/archive/db.js');
const { ensureModelBudget, finishModelCall, modelBudgetStatus, reserveModelCall, saveModelRates, setModelBudgetPaused, settleUnknownCalls } =
  await import('../src/ai/cost.js');

const now = Date.now();
const HOUR = 3_600_000;
saveModelRates('check/settle-model', { input: 1, output: 2, cached: 1 });
const reserve = (budgetId, at) => reserveModelCall({ model: 'check/settle-model', messages: [{ role: 'user', content: 'x'.repeat(100) }],
  tools: null, outputTokens: 100_000, guildId: 'g', role: 'memory-segment', budgetId }, at);

// 上限 1 ドル。予約 1件 ≈ $0.2 (出力の上限ぶん)。実費 $0.01 で確定したもの1件、止めて残った4件
ensureModelBudget({ id: 'settle-a', guildId: 'g', limitUsd: 1 });
const done = reserve('settle-a', now - 3 * HOUR);
finishModelCall(done, { id: 'gen-1', provider: 'P', usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.01 } });
const stale = [1, 2, 3, 4].map(() => reserve('settle-a', now - 2 * HOUR));
let refused = null;
try { reserve('settle-a', now); } catch (error) { refused = error.code; }
assert.equal(refused, 'MODEL_BUDGET_EXHAUSTED', 'held reservations fill the budget');
const before = modelBudgetStatus('settle-a');
assert.ok(before.paused && before.reservedUsd > 0.7, JSON.stringify(before));

// 新しい呼び出し (別の予算、まだ走っている)
ensureModelBudget({ id: 'settle-b', guildId: 'g', limitUsd: 5 });
const running = reserve('settle-b', now - 60_000);

// OpenRouter は今月 $0.05 と言う: 確定 $0.01 との差 $0.04 が古い4件の実費の上限
const result = settleUnknownCalls({ monthUsageUsd: 0.05, now });
assert.equal(result.settled, 4, JSON.stringify(result));
assert.ok(Math.abs(result.gapUsd - 0.04) < 1e-9);
const after = modelBudgetStatus('settle-a');
assert.ok(Math.abs(after.estimatedUsd - 0.04) < 1e-9, `the gap becomes the estimate: ${after.estimatedUsd}`);
assert.ok(after.reservedUsd < 1e-9, `nothing stays held: ${after.reservedUsd}`);
assert.equal(after.unknownCalls, 0);
assert.equal(after.paused, false, 'a budget stopped only by held reservations resumes');
for (const call of stale) {
  const row = db.prepare('SELECT status, estimated_usd, reserved_usd FROM ai_model_calls WHERE id = ?').get(call.id);
  assert.equal(row.status, 'estimated');
  assert.ok(row.estimated_usd <= row.reserved_usd && Math.abs(row.estimated_usd - 0.01) < 1e-9, JSON.stringify(row));
}
assert.equal(db.prepare('SELECT status FROM ai_model_calls WHERE id = ?').get(running.id).status, 'pending', 'a call that may still be running stays held');
assert.ok(reserve('settle-a', now), 'the budget can be used again');

// 差が予約以上 (OpenRouter の方が多く数えている) なら何もしない
const leftover = reserve('settle-a', now - 2 * HOUR);
const held = modelBudgetStatus('settle-a').reservedUsd;
assert.equal(settleUnknownCalls({ monthUsageUsd: 100, now }).settled, 0, 'never raise an estimate above its reservation');
assert.ok(Math.abs(modelBudgetStatus('settle-a').reservedUsd - held) < 1e-9);
assert.equal(db.prepare('SELECT status FROM ai_model_calls WHERE id = ?').get(leftover.id).status, 'pending');

// 手で止めた予算は精算しても止めたまま
setModelBudgetPaused('settle-a', true);
settleUnknownCalls({ monthUsageUsd: 0.06, now });
assert.equal(modelBudgetStatus('settle-a').paused, true, 'a manual pause is kept');
assert.throws(() => settleUnknownCalls({ monthUsageUsd: -1, now }), /nonnegative/);

console.log('budget settle ok (OpenRouter の今月の額との差を古い未確定の呼び出しに按分 / 予約を超えない / 走っている呼び出しは残す / 予約で止まった予算は再開・手で止めたものはそのまま)');
