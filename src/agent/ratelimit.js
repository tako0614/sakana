// エージェントの使用量制限と記録。
//
// 数えるのは呼び出し回数ではなく「換算トークン」。軽い一言と全期間の調査を
// 同じ1回として数えると、実際の費用とまるで合わない。
// 入力 / キャッシュヒット入力 / 出力は単価が違うので、重みを掛けて合算する。
//
// 制限は「1人あたり」と「全体」の2段構え。プロセスを再起動しても効くように
// カウントはメモリではなく SQLite に置く。
// 予約 (reserveCall) → 実行 → 確定 (finalizeCall) の順に使う。
// better-sqlite3 は同期実行なので、予約は他の呼び出しと競合しない。
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

/** 実行中に変えられる設定。既定は env。 */
export const TUNABLES = {
  user_token_limit: () => agentConfig.userTokenLimit,
  global_token_limit: () => agentConfig.globalTokenLimit,
  max_concurrent: () => agentConfig.maxConcurrent,
  weight_input: () => agentConfig.tokenWeightInput,
  weight_cached: () => agentConfig.tokenWeightCached,
  weight_output: () => agentConfig.tokenWeightOutput
};

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
    w_in: getTunable('weight_input'),
    w_cached: getTunable('weight_cached'),
    w_out: getTunable('weight_output')
  };
}

/** usage 1件を換算トークンにする。表示にも使う。 */
export function weighTokens(usage = {}) {
  const { w_in, w_cached, w_out } = weights();
  const prompt = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;

  return Math.max(0, prompt - cached) * w_in + cached * w_cached + completion * w_out;
}

function isExempt(userId) {
  return agentConfig.exemptUsers.includes(userId);
}

/**
 * 枠を1つ確保する。空いていなければ理由と復帰時刻を返す。
 */
export function reserveCall({ guildId, channelId, userId }) {
  const now = Date.now();

  if (!isExempt(userId)) {
    if (running >= getTunable('max_concurrent')) {
      return { ok: false, scope: 'busy' };
    }

    const userLimit = getTunable('user_token_limit');
    const userSince = now - agentConfig.userWindowMs;
    const userUsed = sumUserStmt.get({ user_id: userId, since: userSince, ...weights() }).total;

    if (userLimit > 0 && userUsed >= userLimit) {
      const oldest = oldestUserStmt.get(userId, userSince).at ?? now;
      return {
        ok: false,
        scope: 'user',
        used: userUsed,
        limit: userLimit,
        windowMs: agentConfig.userWindowMs,
        retryAt: oldest + agentConfig.userWindowMs
      };
    }

    const globalLimit = getTunable('global_token_limit');
    const globalSince = now - agentConfig.globalWindowMs;
    const globalUsed = sumGlobalStmt.get({ since: globalSince, ...weights() }).total;

    if (globalLimit > 0 && globalUsed >= globalLimit) {
      const oldest = oldestGlobalStmt.get(globalSince).at ?? now;
      return {
        ok: false,
        scope: 'global',
        used: globalUsed,
        limit: globalLimit,
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

export function getUsage(userId) {
  const now = Date.now();
  const w = weights();

  return {
    user: sumUserStmt.get({ user_id: userId, since: now - agentConfig.userWindowMs, ...w }).total,
    userLimit: getTunable('user_token_limit'),
    global: sumGlobalStmt.get({ since: now - agentConfig.globalWindowMs, ...w }).total,
    globalLimit: getTunable('global_token_limit'),
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
