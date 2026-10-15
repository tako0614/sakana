import { tmpdir } from 'node:os';
// 使用量の上限の検証 (npm run check から呼ぶ)。
//
// 実際の請求額 (OpenRouter の usage.cost) で数えることと、実費の無い古い記録の見積もり、
// 管理者の素通り、個別付与、移動窓を固定する。
// 一時DBだけに書く。本番設定や既存利用履歴には触れない。

import { rmSync } from 'node:fs';

const checkDatabasePath = `${tmpdir()}/sakana-limits-check-${process.pid}.sqlite`;
process.env.DATABASE_PATH = checkDatabasePath;
for (const suffix of ['', '-wal', '-shm']) rmSync(`${checkDatabasePath}${suffix}`, { force: true });
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${checkDatabasePath}${suffix}`, { force: true });
});

const { db } = await import('../src/db.js');
const {
  costOf,
  dailyUsdFor,
  finalizeCall,
  getTunable,
  getUsage,
  grantDailyUsd,
  remainingFor,
  reserveCall,
  resetUsage,
  usdToBudget,
  weighCost
} = await import('../src/agent/ratelimit.js');

const USERS = ['check-normal', 'check-admin', 'check-granted'];
const cleanup = () => {
  const marks = USERS.map(() => '?').join(', ');
  db.prepare(`DELETE FROM agent_tool_calls WHERE call_id IN (SELECT id FROM agent_calls WHERE user_id IN (${marks}))`).run(...USERS);
  db.prepare(`DELETE FROM agent_calls WHERE user_id IN (${marks})`).run(...USERS);
  for (const id of USERS) grantDailyUsd(id, null, 'check');
};

const assert = (ok, message) => { if (!ok) throw new Error(message); };

cleanup();

// 既定の上限は絞ることがあるので数字を直書きしない。設定から読む
// (直書きしていたせいで $0.25 -> $0.05 に絞ったときにここが落ちた)。
// cleanup の後で読む。前回の付与が残っていると既定ではない値を拾う。
const DEFAULT_DAILY = dailyUsdFor('check-normal');

try {
  // --- 実費で数える。予算の単位はマイクロドル ---
  assert(usdToBudget(0.02) === 20_000, 'budget is in micro-dollars');
  const heavy = { prompt_tokens: 100_000, prompt_cache_hit_tokens: 80_000, completion_tokens: 20_000, cost: 0.004 };
  const usd = costOf(heavy);
  assert(usd === 0.004, `the real cost must be used when OpenRouter returns it, got ${usd}`);
  assert(weighCost(heavy) === 4000, 'weigh returns micro-dollars');
  // 有料モデルでトークンを使ったのに 0 なら、返ってこなかったとみなして見積もる (素通しさせない)
  assert(Math.abs(costOf({ ...heavy, cost: 0 }) - 0.01064) < 1e-9, 'a zero cost with tokens must be estimated');
  assert(costOf({ prompt_tokens: 0, completion_tokens: 0, cost: 0 }) === 0, 'no work costs nothing');

  // --- 実費が返らなかったときだけ、固定の単価と重み (1 / 0.2 / 2.0) で見積もる ---
  const legacy = { prompt_tokens: 100_000, prompt_cache_hit_tokens: 80_000, completion_tokens: 20_000 };
  assert(Math.abs(costOf(legacy) - 0.01064) < 1e-9, `legacy estimate should be $0.01064, got ${costOf(legacy)}`);
  {
    const r = reserveCall({ guildId: 'g', channelId: 'c', userId: 'check-granted' });
    finalizeCall(r.id, { status: 'ok', rounds: 1, usage: legacy });
    assert(db.prepare('SELECT cost_usd FROM agent_calls WHERE id = ?').get(r.id).cost_usd === null, 'unknown cost is stored as NULL');
    const spent = getUsage('check-granted').userUsd;
    assert(Math.abs(spent - 0.01064) < 1e-9, `a row without cost must be estimated in the window (${spent})`);
    db.prepare('DELETE FROM agent_calls WHERE id = ?').run(r.id);
  }

  // --- 移動窓: 25時間前の記録は数えない ---
  // 全体カウンタが空のうちに測る。あとの volume テストで全体が埋まると、
  // remainingFor が全体側で 0 を返してこの判定ができなくなる。
  const old = reserveCall({ guildId: 'g', channelId: 'c', userId: 'check-granted' });
  finalizeCall(old.id, { status: 'ok', rounds: 9, usage: heavy });
  assert(remainingFor('check-granted') < usdToBudget(DEFAULT_DAILY), 'a fresh call must consume the window');
  assert(db.prepare('SELECT cost_usd FROM agent_calls WHERE id = ?').get(old.id).cost_usd === 0.004, 'the real cost is stored');
  db.prepare('UPDATE agent_calls SET created_at = ? WHERE id = ?')
    .run(Date.now() - 25 * 3_600_000, old.id);
  const left = remainingFor('check-granted');
  assert(Math.abs(left - usdToBudget(DEFAULT_DAILY)) < 1, `a 25h-old call must age out of the window (left ${left})`);

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
  // 何回もつかも直書きしない。既定の上限 ÷ 1回のコストから出す。
  // (壁の手前で止まるので ±1 は許す)
  const expected = Math.floor(DEFAULT_DAILY / usd);
  assert(
    count >= expected - 1 && count <= expected + 1,
    `expected ~${expected} heavy requests before the wall, got ${count}`
  );

  // --- 管理者は素通りし、全体カウンタにも乗らない ---
  // 乗せてしまうと、運営が使うほど他の人が「サーバー全体の上限」で止まる。
  // 記録 (agent_calls の行) は残るので、実支出は getUsage の billed 側で見える。
  assert(remainingFor('check-admin', true) === Infinity, 'an admin must have no remaining cap');

  const globalBefore = getUsage('check-admin').globalUsd;
  for (let i = 0; i < 40; i += 1) {
    const r = reserveCall({ guildId: 'g', channelId: 'c', userId: 'check-admin', admin: true });
    assert(r.ok, `an admin must never be refused (refused at ${i})`);
    finalizeCall(r.id, { status: 'ok', rounds: 9, usage: heavy });
  }

  const after = getUsage('check-admin');
  assert(
    Math.abs(after.globalUsd - globalBefore) < 1e-9,
    `admin usage must not move the shared counter (${globalBefore} -> ${after.globalUsd})`
  );
  // ただし支出には乗る (40回ぶん)
  assert(
    after.globalBilledUsd > after.globalUsd + 40 * usd - 1e-6,
    `admin usage must still show up as spend (${after.globalBilledUsd})`
  );
  assert(after.userBilledUsd > 40 * usd - 1e-6, 'the admin must see their own spend');

  // --- 同時実行だけは管理者にも効く ---
  //
  // これは費用の壁ではなくメモリの番人 (1実行ごとに Chrome の隔離タブを開く)。
  // 素通りさせると管理者の並列実行だけでメモリを食い潰し、そのぶん一般ユーザーが
  // busy で締め出される。ドルの上限は今まで通り素通りすること。
  {
    const held = [];
    for (;;) {
      const r = reserveCall({ guildId: 'g', channelId: 'c', userId: 'check-admin', admin: true });
      if (!r.ok) {
        assert(r.scope === 'busy', `同時実行で止まるはず: ${r.scope}`);
        break;
      }
      held.push(r.id);
      assert(held.length <= 64, '管理者が同時実行の壁に当たらない');
    }
    assert(held.length === getTunable('max_concurrent'), `枠のぶんだけ通す: ${held.length}`);

    // 枠を返せばまた通る (running が戻ること)
    for (const id of held) finalizeCall(id, { status: 'ok', rounds: 1, usage: {} });
    const again = reserveCall({ guildId: 'g', channelId: 'c', userId: 'check-admin', admin: true });
    assert(again.ok, '枠を返したら通るはず');
    finalizeCall(again.id, { status: 'ok', rounds: 1, usage: {} });
  }

  // --- リセット: 行は残したまま窓を空ける ---
  const beforeReset = getUsage('check-normal');
  assert(beforeReset.userUsd > 0, 'the normal user should have usage before the reset');
  resetUsage('check-normal');
  const afterReset = getUsage('check-normal');
  assert(afterReset.userUsd === 0, `reset must clear the window (${afterReset.userUsd})`);
  assert(
    Math.abs(afterReset.userBilledUsd - beforeReset.userBilledUsd) < 1e-9,
    'reset must not erase the spend record'
  );
  assert(
    reserveCall({ guildId: 'g', channelId: 'c', userId: 'check-normal' }).ok,
    'the user must be able to run again after a reset'
  );

  // --- 個別付与 ---
  assert(dailyUsdFor('check-granted') === DEFAULT_DAILY, 'the default daily cap should apply before a grant');
  grantDailyUsd('check-granted', 1.5, 'check');
  assert(dailyUsdFor('check-granted') === 1.5, 'a grant must raise that person only');
  assert(dailyUsdFor('check-normal') === DEFAULT_DAILY, 'a grant must not leak to others');
  grantDailyUsd('check-granted', null, 'check');
  assert(dailyUsdFor('check-granted') === DEFAULT_DAILY, 'revoking must fall back to the default');

  console.log(`limits ok (実費で数える / 実費の無い古い記録は見積もる / heavy request = $${usd.toFixed(4)}, wall after ${count} of them)`);
} finally {
  cleanup();
}
