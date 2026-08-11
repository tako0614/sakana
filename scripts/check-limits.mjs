// 使用量の上限の検証 (npm run check から呼ぶ)。
//
// 「ドルで決めてトークンで数える」の変換と、管理者の素通り、個別付与、移動窓を固定する。
// 一時的な行を書くので、最後に必ず消す。

import { db } from '../src/db.js';
import {
  dailyUsdFor,
  finalizeCall,
  grantDailyUsd,
  remainingFor,
  reserveCall,
  tokensToUsd,
  usdToTokens,
  weighTokens
} from '../src/agent/ratelimit.js';

const USERS = ['check-normal', 'check-admin', 'check-granted'];
const cleanup = () => {
  const marks = USERS.map(() => '?').join(', ');
  db.prepare(`DELETE FROM agent_tool_calls WHERE call_id IN (SELECT id FROM agent_calls WHERE user_id IN (${marks}))`).run(...USERS);
  db.prepare(`DELETE FROM agent_calls WHERE user_id IN (${marks})`).run(...USERS);
  for (const id of USERS) grantDailyUsd(id, null, 'check');
};

const assert = (ok, message) => { if (!ok) throw new Error(message); };

cleanup();

try {
  // --- 変換の往復 ---
  const round = tokensToUsd(usdToTokens(0.5));
  assert(Math.abs(round - 0.5) < 1e-9, `usd roundtrip broken: ${round}`);

  // --- 1回のコスト (重み 1 / 0.2 / 2.0) ---
  const heavy = { prompt_tokens: 100_000, prompt_cache_hit_tokens: 80_000, completion_tokens: 20_000 };
  const tokens = weighTokens(heavy);
  assert(tokens === 76_000, `weighted tokens should be 76000, got ${tokens}`);
  const usd = tokensToUsd(tokens);
  assert(Math.abs(usd - 0.01064) < 1e-9, `heavy request should cost $0.01064, got ${usd}`);

  // --- 移動窓: 25時間前の記録は数えない ---
  // 全体カウンタが空のうちに測る。あとの volume テストで全体が埋まると、
  // remainingFor が全体側で 0 を返してこの判定ができなくなる。
  const old = reserveCall({ guildId: 'g', channelId: 'c', userId: 'check-granted' });
  finalizeCall(old.id, { status: 'ok', rounds: 9, usage: heavy });
  assert(remainingFor('check-granted') < usdToTokens(0.25), 'a fresh call must consume the window');
  db.prepare('UPDATE agent_calls SET created_at = ? WHERE id = ?')
    .run(Date.now() - 25 * 3_600_000, old.id);
  const left = remainingFor('check-granted');
  assert(Math.abs(left - usdToTokens(0.25)) < 1, `a 25h-old call must age out of the window (left ${left})`);

  // --- 一般ユーザーは既定の上限で止まる ---
  let count = 0;
  for (;;) {
    const r = reserveCall({ guildId: 'g', channelId: 'c', userId: 'check-normal' });
    if (!r.ok) {
      assert(r.scope === 'user', `should stop on the user limit, got ${r.scope}`);
      assert(typeof r.usedUsd === 'number' && typeof r.limitUsd === 'number', 'the refusal must carry USD');
      break;
    }
    finalizeCall(r.id, { status: 'ok', rounds: 9, usage: heavy });
    count += 1;
    assert(count <= 200, 'the user limit never triggered');
  }
  // 既定 $0.25 / 1回 $0.01064 なら 24 回で超える
  assert(count >= 18 && count <= 28, `expected ~23 heavy requests before the wall, got ${count}`);

  // --- 管理者は素通り ---
  // 管理者は判定を通らないが、使用量は記録される (請求と乖離させないため)。
  // なので全体カウンタは既に上限を超えている。それでも通ることを見る。
  assert(remainingFor('check-admin', true) === Infinity, 'an admin must have no remaining cap');
  for (let i = 0; i < 40; i += 1) {
    const r = reserveCall({ guildId: 'g', channelId: 'c', userId: 'check-admin', admin: true });
    assert(r.ok, `an admin must never be refused (refused at ${i})`);
    finalizeCall(r.id, { status: 'ok', rounds: 9, usage: heavy });
  }

  // --- 個別付与 ---
  assert(dailyUsdFor('check-granted') === 0.25, 'the default daily cap should apply before a grant');
  grantDailyUsd('check-granted', 1.5, 'check');
  assert(dailyUsdFor('check-granted') === 1.5, 'a grant must raise that person only');
  assert(dailyUsdFor('check-normal') === 0.25, 'a grant must not leak to others');
  grantDailyUsd('check-granted', null, 'check');
  assert(dailyUsdFor('check-granted') === 0.25, 'revoking must fall back to the default');

  console.log(`limits ok (heavy request = $${usd.toFixed(5)}, wall after ${count} of them)`);
} finally {
  cleanup();
}
