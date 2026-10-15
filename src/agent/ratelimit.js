// エージェントの使用量制限と記録。
//
// 勘定は実際の請求額 (OpenRouter が返す usage.cost、USD)。
//   - モデルを選べる (ling / glm / qwen) ので、固定の単価でトークンを換算すると
//     請求とずれる。1回ごとに返る実費を cost_usd に保存して、その合計で判定する
//   - 実費が無い古い記録 (2026-10-15 より前) だけ、従来どおりトークンを固定の単価と
//     重みで換算して数える (price_in / weight_* はそのための値)
//   - 実行中の予算の単位はマイクロドル (runtime の weigh / budget に渡す)
//
// 回数で数えないのは、軽い一言と全期間の調査が同じ「1回」になって費用と合わないから。
//
// 制限は「1人あたり」と「全体」の2段構えで、窓はどちらも直近24時間の移動窓。
// 暦の日で区切ると深夜0時のリセット待ちが生まれるし、1時間窓は1日に24回
// リセットされるので請求の長さを測っていない。
// プロセスを再起動しても効くようにカウントはメモリではなく SQLite に置く。
// 予約 (reserveCall) → 実行 → 確定 (finalizeCall) の順に使う。
//
// トークンは実行が終わるまで分からないので、上限は厳密には後追い。
// 超過は「同時実行数 × 1回ぶん」で有界なので、それで足りるとみなす。

import { db } from '../db.js';
import { agentConfig } from './config.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    channel_id TEXT,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    rounds INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_agent_calls_user_time ON agent_calls(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_calls_time ON agent_calls(created_at);

  -- 誰がどの URL を開かせたか。ブラウザを外向きに使わせている以上、
  -- 後から辿れないと事故の調査ができない。
  CREATE TABLE IF NOT EXISTS agent_tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_call ON agent_tool_calls(call_id);

  -- エージェントが出した「回答」のメッセージ ID。
  --
  -- これへのリプライだけを会話の続きとして扱う。メモリだけで持っていた頃は
  -- 再起動で消えるので「bot が書いたメッセージなら続き」と見なす保険を入れていたが、
  -- それだと経過表示・ウェルカム・断り文・エラー文へのリプライでも起動していた。
  CREATE TABLE IF NOT EXISTS agent_replies (
    message_id TEXT PRIMARY KEY,
    call_id    INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_replies_time ON agent_replies(created_at);

  -- 上限を実行中に変えられるようにする。env は既定値で、ここに入っていれば勝つ。
  CREATE TABLE IF NOT EXISTS agent_settings (
    key        TEXT PRIMARY KEY,
    value      REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );
`);

// 既存の DB には CREATE TABLE IF NOT EXISTS では列が増えないので、無いときだけ足す。
//
// counted = 0 は「請求の記録としては残すが、上限の判定では数えない」印。
// 使うのは2つ:
//   - 管理者 (と AGENT_EXEMPT_USERS) の実行。判定を素通りするだけでなく、
//     全体カウンタにも乗せない。乗せると運営が使うほど他の人が締め出される。
//   - /agentlimit reset。行を消さずに窓を空にする。
if (!db.pragma('table_info(agent_calls)').some((row) => row.name === 'counted')) {
  db.exec('ALTER TABLE agent_calls ADD COLUMN counted INTEGER NOT NULL DEFAULT 1');
}
// 実際の請求額。NULL は「分からない」(古い記録・usage.cost が返らなかった実行)
if (!db.pragma('table_info(agent_calls)').some((row) => row.name === 'cost_usd')) {
  db.exec('ALTER TABLE agent_calls ADD COLUMN cost_usd REAL');
}

// 起動した時点で走っている実行は無い。status='running' で残っているのは、
// 途中でプロセスが死んで finalizeCall / releaseCall に来られなかったぶん。
// 放っておくと「止まったまま」の行と本当に走っている行が見分けられなくなる。
// (トークンは 0 なので集計には影響しない。status を直すだけ。)
{
  const stale = db.prepare("UPDATE agent_calls SET status = 'interrupted' WHERE status = 'running'").run();
  if (stale.changes > 0) {
    console.warn(`Marked ${stale.changes} interrupted agent call(s) left over from a previous run.`);
  }
}

// 使った額 (USD) の合計。実費があればそれ、無い行だけトークンを換算して足す。
const WEIGHTED_SUM = `
  COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE (
    MAX(prompt_tokens - cached_tokens, 0) * @w_in
    + cached_tokens * @w_cached
    + completion_tokens * @w_out
  ) * @price_in / 1000000.0 END), 0) AS total
`;

const sumUserStmt = db.prepare(
  `SELECT ${WEIGHTED_SUM} FROM agent_calls WHERE user_id = @user_id AND created_at >= @since AND counted = 1`
);
const sumGlobalStmt = db.prepare(
  `SELECT ${WEIGHTED_SUM} FROM agent_calls WHERE created_at >= @since AND counted = 1`
);
// 実際に払うぶん。counted は上限の判定用の印なので、請求を見るときは無視する
// (管理者ぶんもリセットしたぶんも支出には乗っている)。
const sumUserBilledStmt = db.prepare(
  `SELECT ${WEIGHTED_SUM} FROM agent_calls WHERE user_id = @user_id AND created_at >= @since`
);
const sumBilledStmt = db.prepare(
  `SELECT ${WEIGHTED_SUM} FROM agent_calls WHERE created_at >= @since`
);
const oldestUserStmt = db.prepare(
  'SELECT MIN(created_at) AS at FROM agent_calls WHERE user_id = ? AND created_at >= ? AND counted = 1'
);
const oldestGlobalStmt = db.prepare(
  'SELECT MIN(created_at) AS at FROM agent_calls WHERE created_at >= ? AND counted = 1'
);
const insertStmt = db.prepare(
  'INSERT INTO agent_calls (guild_id, channel_id, user_id, created_at, counted) VALUES (?, ?, ?, ?, ?)'
);
const finalizeStmt = db.prepare(`
  UPDATE agent_calls
  SET status = @status,
      finished_at = @finished_at,
      rounds = @rounds,
      prompt_tokens = @prompt_tokens,
      completion_tokens = @completion_tokens,
      cached_tokens = @cached_tokens,
      cost_usd = @cost_usd
  WHERE id = @id
`);
const releaseStmt = db.prepare('DELETE FROM agent_calls WHERE id = ?');
const insertToolCallStmt = db.prepare(
  'INSERT INTO agent_tool_calls (call_id, name, detail, created_at) VALUES (?, ?, ?, ?)'
);
const getSettingStmt = db.prepare('SELECT value FROM agent_settings WHERE key = ?');
const setSettingStmt = db.prepare(`
  INSERT INTO agent_settings (key, value, updated_at, updated_by) VALUES (@key, @value, @at, @by)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
`);
const deleteSettingStmt = db.prepare('DELETE FROM agent_settings WHERE key = ?');

// 実行中の件数。同時実行数を抑えて、レート制限と課金の暴発を防ぐ。
let running = 0;

/** 実行中に変えられる設定。既定は env。金額は USD。 */
export const TUNABLES = {
  user_daily_usd: () => agentConfig.userDailyUsd,
  global_daily_usd: () => agentConfig.globalDailyUsd,
  request_usd: () => agentConfig.requestUsd,
  price_in: () => agentConfig.priceInPerMTok,
  weight_cached: () => agentConfig.tokenWeightCached,
  weight_output: () => agentConfig.tokenWeightOutput,
  max_concurrent: () => agentConfig.maxConcurrent
};

// 個人ごとの上限は同じ表に key='limit:<userId>' で入れる (新しい表は作らない)。
// 保存する値はドル。単価を変えたら付与額の意味も追従してほしいので、
// トークンに直してから保存はしない。
const GRANT_PREFIX = 'limit:';

export function getTunable(key) {
  const fallback = TUNABLES[key];
  if (!fallback) return null;

  const row = getSettingStmt.get(key);
  return Number.isFinite(row?.value) ? row.value : fallback();
}

export function setTunable(key, value, userId) {
  if (!TUNABLES[key]) return false;

  // null で env の既定に戻せるようにする (「元に戻す」手段が無いと怖くて触れない)
  if (value === null || value === undefined) {
    deleteSettingStmt.run(key);
    return true;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return false;

  setSettingStmt.run({ key, value: parsed, at: Date.now(), by: userId ?? null });
  return true;
}

export function listTunables() {
  return Object.keys(TUNABLES).map((key) => {
    const row = getSettingStmt.get(key);
    return {
      key,
      value: getTunable(key),
      overridden: Number.isFinite(row?.value),
      defaultValue: TUNABLES[key]()
    };
  });
}

function weights() {
  return {
    // 入力 (キャッシュミス) は正規化の基準なので常に 1
    w_in: 1,
    w_cached: getTunable('weight_cached'),
    w_out: getTunable('weight_output'),
    price_in: getTunable('price_in')
  };
}

const MICRO = 1_000_000;

/** 実行中の予算 (マイクロドル)。 */
export function usdToBudget(usd) {
  return Number.isFinite(usd) && usd > 0 ? usd * MICRO : Infinity;
}

/**
 * 実費が分かっているか。会話 agent は有料モデルだけなので、トークンを使ったのに
 * 請求額が 0 なのは「返ってこなかった」とみなす (無料扱いにして素通しさせない)。
 */
function costKnown(usage) {
  const tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
  return Number.isFinite(usage.cost) && (usage.cost > 0 || tokens === 0);
}

/** usage の実費 (USD)。分からないときだけトークンを固定の単価と重みで換算する。 */
export function costOf(usage = {}) {
  if (costKnown(usage)) return Math.max(0, usage.cost);
  const { w_in, w_cached, w_out, price_in } = weights();
  const prompt = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  return ((Math.max(0, prompt - cached) * w_in + cached * w_cached + completion * w_out) * price_in) / MICRO;
}

/** runtime の weigh に渡す (マイクロドル)。 */
export function weighCost(usage = {}) {
  return costOf(usage) * MICRO;
}

/** その人の1日上限 (ドル)。付与があればそれ、無ければ既定。 */
export function dailyUsdFor(userId) {
  const row = getSettingStmt.get(`${GRANT_PREFIX}${userId}`);
  return Number.isFinite(row?.value) ? row.value : getTunable('user_daily_usd');
}

/** 個人への付与。usd が null なら取り消して既定に戻す。 */
export function grantDailyUsd(userId, usd, byUserId) {
  const key = `${GRANT_PREFIX}${userId}`;

  if (usd === null || usd === undefined) {
    deleteSettingStmt.run(key);
    return true;
  }

  const parsed = Number(usd);
  if (!Number.isFinite(parsed) || parsed < 0) return false;

  setSettingStmt.run({ key, value: parsed, at: Date.now(), by: byUserId ?? null });
  return true;
}

/**
 * いまの窓の使用量を消す。上限を絞った直後に、既に使っていた人を締め出さないため。
 *
 * 行は消さずに counted = 0 を立てるだけ。請求と突き合わせるための記録は残す
 * (消してしまうと「なぜこの月これだけ請求が来たか」が追えなくなる)。
 * userId を渡せばその人だけ、省略すれば全員。戻り値は印を付けた件数。
 */
export function resetUsage(userId = null) {
  const since = Date.now() - Math.max(agentConfig.userWindowMs, agentConfig.globalWindowMs);

  const result = userId
    ? db.prepare('UPDATE agent_calls SET counted = 0 WHERE counted = 1 AND created_at >= ? AND user_id = ?')
      .run(since, userId)
    : db.prepare('UPDATE agent_calls SET counted = 0 WHERE counted = 1 AND created_at >= ?')
      .run(since);

  return result.changes;
}

/**
 * エージェントの回答を覚える。これへのリプライだけを会話の続きとして扱う。
 * メモリではなく DB に置くのは、再起動を挟んでも続けられるようにするため。
 */
export function rememberAgentReply(messageId, callId = null) {
  if (!messageId) return;

  try {
    db.prepare('INSERT OR IGNORE INTO agent_replies (message_id, call_id, created_at) VALUES (?, ?, ?)')
      .run(String(messageId), callId, Date.now());
  } catch (error) {
    // 覚えられなくても回答自体は返っているので、続きが効かなくなるだけ
    console.error('Failed to remember an agent reply:', error);
  }
}

/** その ID がエージェントの回答かどうか。経過表示やウェルカムは入っていない。 */
export function isAgentReply(messageId) {
  if (!messageId) return false;

  try {
    return Boolean(db.prepare('SELECT 1 FROM agent_replies WHERE message_id = ?').get(String(messageId)));
  } catch {
    return false;
  }
}

/** 付与済みの一覧。/agentlimit show に出す。 */
export function listGrants() {
  return db.prepare(`SELECT key, value, updated_by FROM agent_settings WHERE key LIKE '${GRANT_PREFIX}%'`)
    .all()
    .map((row) => ({ userId: row.key.slice(GRANT_PREFIX.length), usd: row.value, by: row.updated_by }));
}

function isExempt(userId, admin = false) {
  // 管理者は完全に素通り。上限は荒らしを止める壁で、運営を縛るものではない。
  return admin || agentConfig.exemptUsers.includes(userId);
}

/**
 * 枠を1つ確保する。空いていなければ理由と復帰時刻を返す。
 * admin: true ならトークンとドルの上限は見ない (同時実行だけは見る)。
 * skipUserLimitは統治側の回数枠を個人のinjection壁にする場合だけ使う。
 * サーバー全体の費用上限と1リクエスト上限は引き続き効く。
 */
export function reserveCall({ guildId, channelId, userId, admin = false, skipUserLimit = false }) {
  const now = Date.now();
  const exempt = isExempt(userId, admin);

  // 同時実行だけは管理者にも効かせる。
  //
  // これは費用の壁ではなくメモリの番人で、1実行ごとに Chrome の隔離タブを開く
  // (config.js のコメント参照)。素通りさせると管理者の並列実行だけで 12GiB を
  // 食い潰せてしまうし、そのぶん一般ユーザーが busy で締め出される。
  if (running >= getTunable('max_concurrent')) {
    return { ok: false, scope: 'busy' };
  }

  if (!exempt) {
    // 上限も使用量もドル (実費)
    if (!skipUserLimit) {
      const userUsd = dailyUsdFor(userId);
      const userSince = now - agentConfig.userWindowMs;
      const userUsed = sumUserStmt.get({ user_id: userId, since: userSince, ...weights() }).total;

      if (userUsd > 0 && userUsed >= userUsd) {
        const oldest = oldestUserStmt.get(userId, userSince).at ?? now;
        return {
          ok: false,
          scope: 'user',
          usedUsd: userUsed,
          limitUsd: userUsd,
          windowMs: agentConfig.userWindowMs,
          retryAt: oldest + agentConfig.userWindowMs
        };
      }
    }

    const globalUsd = getTunable('global_daily_usd');
    const globalSince = now - agentConfig.globalWindowMs;
    const globalUsed = sumGlobalStmt.get({ since: globalSince, ...weights() }).total;

    if (globalUsd > 0 && globalUsed >= globalUsd) {
      const oldest = oldestGlobalStmt.get(globalSince).at ?? now;
      return {
        ok: false,
        scope: 'global',
        usedUsd: globalUsed,
        limitUsd: globalUsd,
        windowMs: agentConfig.globalWindowMs,
        retryAt: oldest + agentConfig.globalWindowMs
      };
    }
  }

  // 素通りした実行は上限の判定に数えない (記録としては残る)
  const counted = exempt ? 0 : 1;
  const { lastInsertRowid } = insertStmt.run(guildId ?? null, channelId ?? null, userId, now, counted);
  running += 1;

  return { ok: true, id: Number(lastInsertRowid) };
}

/**
 * 使い終わった枠を確定する。usage は共通providerが正規化したトークン使用量。請求額はAI費用台帳で扱う。
 */
export function finalizeCall(id, { status = 'ok', rounds = 0, usage = {} } = {}) {
  running = Math.max(0, running - 1);

  try {
    finalizeStmt.run({
      id,
      status,
      finished_at: Date.now(),
      rounds,
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      cached_tokens: usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0,
      cost_usd: costKnown(usage) ? usage.cost : null
    });
  } catch (error) {
    console.error('Failed to finalize agent call:', error);
  }
}

/**
 * 失敗した実行の後片付け。
 *
 * トークンを1つも使っていなければ行を消す (ユーザーの落ち度でない失敗を数えない)。
 * 1つでも使っていたら消さずに status=error で残す — タイムアウトで9往復ぶん
 * 払っているのに使用量ゼロで記録すると、実際の請求と乖離していく。
 */
export function releaseCall(id, usage = null) {
  running = Math.max(0, running - 1);

  try {
    const spent = usage ? costOf(usage) + (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) : 0;
    if (spent <= 0) {
      releaseStmt.run(id);
      return;
    }

    finalizeStmt.run({
      id,
      status: 'error',
      finished_at: Date.now(),
      rounds: usage.rounds ?? 0,
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      cached_tokens: usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0,
      cost_usd: costKnown(usage) ? usage.cost : null
    });
  } catch (error) {
    console.error('Failed to release agent call:', error);
  }
}

/** 使ったツールを記録する。ブラウザは URL まで残す (事故の追跡用)。 */
export function recordToolCalls(callId, used = []) {
  if (!callId || used.length === 0) return;

  const now = Date.now();
  try {
    for (const entry of used.slice(0, 50)) {
      const detail = entry.name === 'browser'
        ? [entry.args?.action, entry.args?.url].filter(Boolean).join(' ')
        : JSON.stringify(entry.args ?? {});

      insertToolCallStmt.run(callId, String(entry.name ?? ''), String(detail ?? '').slice(0, 500), now);
    }
  } catch (error) {
    console.error('Failed to record tool calls:', error);
  }
}

/**
 * この人が今の窓で使える残り。1リクエストの予算をここから決める。
 * 上限が 0 (無制限) のときは Infinity。
 */
export function remainingFor(userId, admin = false, { skipUserLimit = false } = {}) {
  if (isExempt(userId, admin)) return Infinity;

  const now = Date.now();
  const w = weights();

  const userUsd = dailyUsdFor(userId);
  const globalUsd = getTunable('global_daily_usd');

  // 戻り値は実行中の予算と同じマイクロドル
  const userLeft = !skipUserLimit && userUsd > 0
    ? (userUsd - sumUserStmt.get({ user_id: userId, since: now - agentConfig.userWindowMs, ...w }).total) * MICRO
    : Infinity;
  const globalLeft = globalUsd > 0
    ? (globalUsd - sumGlobalStmt.get({ since: now - agentConfig.globalWindowMs, ...w }).total) * MICRO
    : Infinity;

  return Math.max(0, Math.min(userLeft, globalLeft));
}

export function getUsage(userId) {
  const now = Date.now();
  const w = weights();

  const userSpent = sumUserStmt.get({ user_id: userId, since: now - agentConfig.userWindowMs, ...w }).total;
  const globalSpent = sumGlobalStmt.get({ since: now - agentConfig.globalWindowMs, ...w }).total;
  const userUsd = dailyUsdFor(userId);
  const globalUsd = getTunable('global_daily_usd');

  // 上限の判定に乗らないぶん (管理者・リセット済み) も含めた実支出。
  // これが無いと、管理者から見た自分の使用量が常に $0.000 に見える。
  const userBilled = sumUserBilledStmt.get({ user_id: userId, since: now - agentConfig.userWindowMs, ...w }).total;
  const globalBilled = sumBilledStmt.get({ since: now - agentConfig.globalWindowMs, ...w }).total;

  return {
    // どれも実費 (USD)。実費の無い古い行だけ換算した見積もりが混ざる
    userUsd: userSpent,
    userLimitUsd: userUsd,
    globalUsd: globalSpent,
    globalLimitUsd: globalUsd,
    userBilledUsd: userBilled,
    globalBilledUsd: globalBilled,
    running
  };
}

/**
 * 集計に使わない古い行を落とす。呼び出し制限の窓より十分長く残す。
 */
export function pruneCalls(keepMs = 30 * 86_400_000) {
  try {
    const cutoff = Date.now() - keepMs;
    db.prepare('DELETE FROM agent_tool_calls WHERE call_id IN (SELECT id FROM agent_calls WHERE created_at < ?)').run(cutoff);
    db.prepare('DELETE FROM agent_calls WHERE created_at < ?').run(cutoff);
    db.prepare('DELETE FROM agent_replies WHERE created_at < ?').run(cutoff);
  } catch (error) {
    console.error('Failed to prune agent calls:', error);
  }
}
