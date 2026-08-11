// エージェントの使用量制限と記録。
//
// 勘定はトークン、意思決定はドル。
//   - 保存するのは生のトークン数 (prompt / completion / cached)。値上げされても
//     過去の記録の意味が変わらないようにするため
//   - 集計は「換算トークン」(キャッシュミス入力1トークン = 1 に正規化した重み付き合計)
//   - 上限はドルで設定して、判定の直前にトークンへ直す。換算トークン1個の値段が
//     そのまま換算レートになる (= キャッシュミス入力1トークンの単価)
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

  -- 上限を実行中に変えられるようにする。env は既定値で、ここに入っていれば勝つ。
  CREATE TABLE IF NOT EXISTS agent_settings (
    key        TEXT PRIMARY KEY,
    value      REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );
`);

// 換算トークンの合計。SQL 側で重みを掛ける (行を JS に運ばずに済む)。
const WEIGHTED_SUM = `
  COALESCE(SUM(
    MAX(prompt_tokens - cached_tokens, 0) * @w_in
    + cached_tokens * @w_cached
    + completion_tokens * @w_out
  ), 0) AS total
`;

const sumUserStmt = db.prepare(
  `SELECT ${WEIGHTED_SUM} FROM agent_calls WHERE user_id = @user_id AND created_at >= @since`
);
const sumGlobalStmt = db.prepare(
  `SELECT ${WEIGHTED_SUM} FROM agent_calls WHERE created_at >= @since`
);
const oldestUserStmt = db.prepare(
  'SELECT MIN(created_at) AS at FROM agent_calls WHERE user_id = ? AND created_at >= ?'
);
const oldestGlobalStmt = db.prepare(
  'SELECT MIN(created_at) AS at FROM agent_calls WHERE created_at >= ?'
);
const insertStmt = db.prepare(
  'INSERT INTO agent_calls (guild_id, channel_id, user_id, created_at) VALUES (?, ?, ?, ?)'
);
const finalizeStmt = db.prepare(`
  UPDATE agent_calls
  SET status = @status,
      finished_at = @finished_at,
      rounds = @rounds,
      prompt_tokens = @prompt_tokens,
      completion_tokens = @completion_tokens,
      cached_tokens = @cached_tokens
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
    w_out: getTunable('weight_output')
  };
}

/**
 * ドル ↔ 換算トークン。
 * 換算トークン1個は「キャッシュミス入力1トークン」なので、その単価が換算レート。
 */
export function usdToTokens(usd) {
  const rate = getTunable('price_in') / 1_000_000;
  if (!Number.isFinite(rate) || rate <= 0) return Infinity;
  return usd / rate;
}

export function tokensToUsd(tokens) {
  return tokens * (getTunable('price_in') / 1_000_000);
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

/** 付与済みの一覧。/agentlimit show に出す。 */
export function listGrants() {
  return db.prepare(`SELECT key, value, updated_by FROM agent_settings WHERE key LIKE '${GRANT_PREFIX}%'`)
    .all()
    .map((row) => ({ userId: row.key.slice(GRANT_PREFIX.length), usd: row.value, by: row.updated_by }));
}

/** usage 1件を換算トークンにする。表示にも使う。 */
export function weighTokens(usage = {}) {
  const { w_in, w_cached, w_out } = weights();
  const prompt = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;

  return Math.max(0, prompt - cached) * w_in + cached * w_cached + completion * w_out;
}

function isExempt(userId, admin = false) {
  // 管理者は完全に素通り。上限は荒らしを止める壁で、運営を縛るものではない。
  return admin || agentConfig.exemptUsers.includes(userId);
}

/**
 * 枠を1つ確保する。空いていなければ理由と復帰時刻を返す。
 * admin: true なら回数・トークン・同時実行のどれも見ない。
 */
export function reserveCall({ guildId, channelId, userId, admin = false }) {
  const now = Date.now();

  if (!isExempt(userId, admin)) {
    if (running >= getTunable('max_concurrent')) {
      return { ok: false, scope: 'busy' };
    }

    // 上限はドルで持っているので、判定の直前にトークンへ直す
    const userUsd = dailyUsdFor(userId);
    const userLimit = userUsd > 0 ? usdToTokens(userUsd) : 0;
    const userSince = now - agentConfig.userWindowMs;
    const userUsed = sumUserStmt.get({ user_id: userId, since: userSince, ...weights() }).total;

    if (userLimit > 0 && userUsed >= userLimit) {
      const oldest = oldestUserStmt.get(userId, userSince).at ?? now;
      return {
        ok: false,
        scope: 'user',
        usedUsd: tokensToUsd(userUsed),
        limitUsd: userUsd,
        windowMs: agentConfig.userWindowMs,
        retryAt: oldest + agentConfig.userWindowMs
      };
    }

    const globalUsd = getTunable('global_daily_usd');
    const globalLimit = globalUsd > 0 ? usdToTokens(globalUsd) : 0;
    const globalSince = now - agentConfig.globalWindowMs;
    const globalUsed = sumGlobalStmt.get({ since: globalSince, ...weights() }).total;

    if (globalLimit > 0 && globalUsed >= globalLimit) {
      const oldest = oldestGlobalStmt.get(globalSince).at ?? now;
      return {
        ok: false,
        scope: 'global',
        usedUsd: tokensToUsd(globalUsed),
        limitUsd: globalUsd,
        windowMs: agentConfig.globalWindowMs,
        retryAt: oldest + agentConfig.globalWindowMs
      };
    }
  }

  const { lastInsertRowid } = insertStmt.run(guildId ?? null, channelId ?? null, userId, now);
  running += 1;

  return { ok: true, id: Number(lastInsertRowid) };
}

/**
 * 使い終わった枠を確定する。usage は DeepSeek のレスポンスの usage をそのまま渡す。
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
      cached_tokens: usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0
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
    const spent = usage ? weighTokens(usage) : 0;
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
      cached_tokens: usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0
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
export function remainingFor(userId, admin = false) {
  if (isExempt(userId, admin)) return Infinity;

  const now = Date.now();
  const w = weights();

  const userUsd = dailyUsdFor(userId);
  const globalUsd = getTunable('global_daily_usd');

  const userLeft = userUsd > 0
    ? usdToTokens(userUsd) - sumUserStmt.get({ user_id: userId, since: now - agentConfig.userWindowMs, ...w }).total
    : Infinity;
  const globalLeft = globalUsd > 0
    ? usdToTokens(globalUsd) - sumGlobalStmt.get({ since: now - agentConfig.globalWindowMs, ...w }).total
    : Infinity;

  return Math.max(0, Math.min(userLeft, globalLeft));
}

export function getUsage(userId) {
  const now = Date.now();
  const w = weights();

  const userTokens = sumUserStmt.get({ user_id: userId, since: now - agentConfig.userWindowMs, ...w }).total;
  const globalTokens = sumGlobalStmt.get({ since: now - agentConfig.globalWindowMs, ...w }).total;
  const userUsd = dailyUsdFor(userId);
  const globalUsd = getTunable('global_daily_usd');

  return {
    // 表示はドル、突き合わせ用にトークンも返す (内部の勘定はトークンなので)
    userUsd: tokensToUsd(userTokens),
    userLimitUsd: userUsd,
    userTokens,
    userLimitTokens: userUsd > 0 ? usdToTokens(userUsd) : Infinity,
    globalUsd: tokensToUsd(globalTokens),
    globalLimitUsd: globalUsd,
    globalTokens,
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
  } catch (error) {
    console.error('Failed to prune agent calls:', error);
  }
}
