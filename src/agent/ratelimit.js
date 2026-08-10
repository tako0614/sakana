// エージェントの呼び出し制限と使用量の記録。
//
// 制限は「1人あたり」と「全体」の2段構え。
// プロセスを再起動しても効くように、カウントはメモリではなく SQLite に置く。
// 予約 (reserveCall) → 実行 → 確定 (finalizeCall) の順に使う。
// better-sqlite3 は同期実行なので、予約は他の呼び出しと競合しない。

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
`);

const countUserStmt = db.prepare(
  'SELECT COUNT(*) AS count FROM agent_calls WHERE user_id = ? AND created_at >= ?'
);
const countGlobalStmt = db.prepare(
  'SELECT COUNT(*) AS count FROM agent_calls WHERE created_at >= ?'
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

// 実行中の件数。同時実行数を抑えて、レート制限と課金の暴発を防ぐ。
let running = 0;

function isExempt(userId) {
  return agentConfig.exemptUsers.includes(userId);
}

/**
 * 枠を1つ確保する。空いていなければ理由と復帰時刻を返す。
 */
export function reserveCall({ guildId, channelId, userId }) {
  const now = Date.now();

  if (!isExempt(userId)) {
    if (running >= agentConfig.maxConcurrent) {
      return { ok: false, scope: 'busy' };
    }

    const userSince = now - agentConfig.userWindowMs;
    const userCount = countUserStmt.get(userId, userSince).count;
    if (userCount >= agentConfig.userLimit) {
      const oldest = oldestUserStmt.get(userId, userSince).at ?? now;
      return {
        ok: false,
        scope: 'user',
        limit: agentConfig.userLimit,
        windowMs: agentConfig.userWindowMs,
        retryAt: oldest + agentConfig.userWindowMs
      };
    }

    const globalSince = now - agentConfig.globalWindowMs;
    const globalCount = countGlobalStmt.get(globalSince).count;
    if (globalCount >= agentConfig.globalLimit) {
      const oldest = oldestGlobalStmt.get(globalSince).at ?? now;
      return {
        ok: false,
        scope: 'global',
        limit: agentConfig.globalLimit,
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
 * API に届かなかった等、こちら側の都合で失敗したときは枠を返す。
 * 「制限は寛大に」なので、ユーザーの落ち度でない失敗は数えない。
 */
export function releaseCall(id) {
  running = Math.max(0, running - 1);

  try {
    releaseStmt.run(id);
  } catch (error) {
    console.error('Failed to release agent call:', error);
  }
}

export function getUsage(userId) {
  const now = Date.now();
  return {
    user: countUserStmt.get(userId, now - agentConfig.userWindowMs).count,
    userLimit: agentConfig.userLimit,
    global: countGlobalStmt.get(now - agentConfig.globalWindowMs).count,
    globalLimit: agentConfig.globalLimit,
    running
  };
}

/**
 * 集計に使わない古い行を落とす。呼び出し制限の窓より十分長く残す。
 */
export function pruneCalls(keepMs = 30 * 86_400_000) {
  try {
    db.prepare('DELETE FROM agent_calls WHERE created_at < ?').run(Date.now() - keepMs);
  } catch (error) {
    console.error('Failed to prune agent calls:', error);
  }
}
