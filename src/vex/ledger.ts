// 判定の記録。閾値を後から調整できるように、判定ごとに確率とどうしたかを残す。
// 入った回数 (冷却・1時間の上限) と判定の費用 (1日の上限) もここから数える (再起動しても効く)。
import { db } from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS vex_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    model TEXT,
    p REAL,
    cost_usd REAL NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    action TEXT NOT NULL,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_vex_decisions_channel ON vex_decisions(channel_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_vex_decisions_time ON vex_decisions(created_at);
`);

/**
 * どうしたか。
 *   joined 入ると決めた (冷却と上限はこれを数える) / below 閾値に届かない / skipped 門で止めた (理由は note)
 *   error 判定か agent に失敗 / moved_on 会話が進んだので入らなかった (note: いつ)
 *   sent 実際に送った / passed agent が「返す価値が無い」と答えた
 */
export type VexAction = 'joined' | 'below' | 'skipped' | 'error' | 'moved_on' | 'sent' | 'passed';

export interface VexRecord {
  guildId: string;
  channelId: string;
  messageId: string;
  model?: string | null;
  p?: number | null;
  costUsd?: number;
  latencyMs?: number | null;
  action: VexAction;
  note?: string | null;
}

const insert = db.prepare(`
  INSERT INTO vex_decisions (created_at, guild_id, channel_id, message_id, model, p, cost_usd, latency_ms, action, note)
  VALUES (@created_at, @guild_id, @channel_id, @message_id, @model, @p, @cost_usd, @latency_ms, @action, @note)
`);

export function recordVex(record: VexRecord, now = Date.now()): void {
  insert.run({
    created_at: now, guild_id: record.guildId, channel_id: record.channelId, message_id: record.messageId, model: record.model ?? null,
    p: record.p ?? null, cost_usd: record.costUsd ?? 0, latency_ms: record.latencyMs ?? null, action: record.action, note: record.note ?? null
  });
}

const joinedSince = db.prepare<[string, number], { n: number; last: number | null }>(
  "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM vex_decisions WHERE channel_id = ? AND action = 'joined' AND created_at > ?");
const spentSince = db.prepare<[number], { total: number | null }>('SELECT SUM(cost_usd) AS total FROM vex_decisions WHERE created_at > ?');

/** そのチャンネルで、since 以降に入った回数と、最後に入った時刻。 */
export function joinedInChannel(channelId: string, since: number): { count: number; last: number | null } {
  const row = joinedSince.get(channelId, since);
  return { count: row?.n ?? 0, last: row?.last ?? null };
}

/** since 以降の判定の費用 (USD)。 */
export function decisionSpend(since: number): number {
  return spentSince.get(since)?.total ?? 0;
}
