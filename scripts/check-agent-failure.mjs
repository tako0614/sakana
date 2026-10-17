// エージェントが落ちたときに聞いた人へ見せる理由の検証 (npm run check から tsx で呼ぶ)。
import assert from 'node:assert/strict';
import { failureNotice, failureReason } from '../src/agent/failure.ts';

const HEAD = 'エージェントの実行に失敗しました';
const provider = (status, extra = {}) => Object.assign(new Error(`OpenRouter HTTP ${status}`), { status, ...extra });

// 混んでいる・障害・通信は、番号と理由を出して、待てば通ると伝える
const busy = failureNotice(HEAD, provider(429, { detail: 'Provider returned error | provider=Novita | raw=secret-ish' }));
assert.match(busy, /\(429: AI が混み合っていて断られました\)/);
assert.match(busy, /しばらくしてからもう一度/);
assert.ok(!/Novita|raw=|OpenRouter/.test(busy), 'provider 名と本文はチャンネルに出さない');
assert.match(failureNotice(HEAD, provider(503)), /503: AI 側の障害/);
assert.match(failureNotice(HEAD, provider(0)), /通信エラー/);
assert.match(failureNotice(HEAD, provider(404)), /404: AI がこの依頼を受け付けませんでした/);

// 待っても直らないものは、運営に伝える案内にする
for (const status of [401, 402, 403]) {
  const text = failureNotice(HEAD, provider(status));
  assert.match(text, new RegExp(`${status}:`));
  assert.match(text, /管理者に伝えてください/);
  assert.ok(!/しばらくして/.test(text));
}
assert.match(failureNotice(HEAD, Object.assign(new Error('x'), { code: 'MODEL_BUDGET_EXHAUSTED' })), /予算の上限.*管理者/);
assert.match(failureNotice(HEAD, Object.assign(new Error('x'), { code: 'AGENT_REQUEST_LIMIT' })), /回数の上限/);

// 時間切れ・途中で切れた出力
assert.match(failureNotice(HEAD, Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), /時間切れ/);
assert.match(failureNotice(HEAD, new Error('AI request deadline exceeded')), /時間切れ/);
assert.match(failureNotice(HEAD, new Error('AI output was truncated')), /途中で切れ/);

// 分からない失敗は従来どおり。例外の文面 (内部の情報を含みうる) は出さない
const unknown = failureNotice(HEAD, new Error('SQLITE_BUSY: database is locked'));
assert.equal(unknown, `${HEAD}。しばらくしてからもう一度試してください。`);
assert.equal(failureReason('not an error'), null);
assert.equal(failureReason(null), null);

// bot 自身の定型文として見分けられる (次の実行の背景に混ぜない) ように、先頭は変えない
assert.ok(busy.startsWith(HEAD));

console.log('agent failure notice ok (429 / 5xx / 通信 / 401・402 は管理者へ / 時間切れ / 不明は従来どおり)');
