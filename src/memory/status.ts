import { db as archive } from '../archive/db.js';
import { getCursor, getState, loadPublicChannels, memoryCounts, memoryDb, type MemoryCounts } from './store.js';
import { isLockState, isPauseState, isTotals, type PauseState, type Totals } from './types.js';

// /memory status に出す進み具合。どれも索引で引ける軽い問い合わせだけ
// (全件を数えるのは builder が6時間に1回やって totals に控えている)。

const HOUR_MS = 3_600_000;
const LOCK_FRESH_MS = 10 * 60_000;

interface SegmentGroup {
  status: string;
  segments: number;
  messages: number;
  last: number | null;
}

export interface MemoryStatus {
  read: number;
  done: number;
  failed: number;
  lastDoneAt: number | null;
  totals: Totals | null;
  remaining: number | null;
  etaHours: number | null;
  lastHour: { messages: number; segments: number };
  channels: { total: number; caughtUp: number };
  memory: MemoryCounts;
  spentUsd: number;
  monthUsd: number;
  calls: number;
  budgetUsd: number;
  running: boolean;
  paused: PauseState | null;
}

export function memoryStatus(guildId: string, { budgetUsd = 0, now = Date.now() }: { budgetUsd?: number; now?: number } = {}): MemoryStatus {
  const d = memoryDb();
  const bySegment: Record<string, SegmentGroup> = Object.fromEntries(d.prepare<[string], SegmentGroup>(`
    SELECT status, COUNT(*) AS segments, COALESCE(SUM(messages), 0) AS messages, MAX(done_at) AS last
    FROM segments WHERE guild_id = ? GROUP BY status
  `).all(guildId).map((row) => [row.status, row]));
  const done = bySegment.done ?? { segments: 0, messages: 0, last: null };
  const failed = bySegment.failed ?? { segments: 0, messages: 0 };
  const lastHour = d.prepare<[string, number], { messages: number; segments: number }>(`
    SELECT COALESCE(SUM(messages), 0) AS messages, COUNT(*) AS segments FROM segments
    WHERE guild_id = ? AND done_at >= ?
  `).get(guildId, now - HOUR_MS) ?? { messages: 0, segments: 0 };

  const saved = getState(`totals:${guildId}`);
  const totals = isTotals(saved) ? saved : null;
  const read = done.messages + failed.messages;
  const remaining = totals ? Math.max(0, totals.messages - read) : null;
  const etaHours = remaining !== null && lastHour.messages > 0 ? remaining / lastHour.messages : null;

  // 読み終えたチャンネル: cursor がそのチャンネルの最新の発言に届いているか (索引の端を見るだけ)
  const channels = loadPublicChannels(guildId)?.channelIds ?? [];
  const newest = archive.prepare<[string], { at: number | null }>('SELECT MAX(created_at) AS at FROM messages WHERE channel_id = ?');
  let caughtUp = 0;
  for (const channelId of channels) {
    const latest = newest.get(channelId)?.at;
    const cursor = getCursor(guildId, channelId);
    if (!latest || (cursor && cursor.last_ms >= latest)) caughtUp += 1;
  }

  // 上限は月 (UTC) ごとなので、今月のぶんと累計を分けて出す
  let spent = { usd: 0, calls: 0, month: 0 };
  try {
    const date = new Date(now);
    spent = archive.prepare<[number, string], { usd: number; calls: number; month: number }>(`
      SELECT COALESCE(SUM(COALESCE(reported_usd, estimated_usd, 0)), 0) AS usd, COUNT(*) AS calls,
        COALESCE(SUM(CASE WHEN started_at >= ? THEN COALESCE(reported_usd, estimated_usd, 0) ELSE 0 END), 0) AS month
      FROM ai_model_calls WHERE guild_id = ? AND role LIKE 'memory-%'
    `).get(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), guildId) ?? spent;
  } catch {
    // 台帳がまだ無い (一度も呼んでいない)
  }

  const lock = getState(`lock:${guildId}`);
  const paused = getState(`pause:${guildId}`);
  return {
    read, done: done.segments, failed: failed.segments, lastDoneAt: done.last,
    totals, remaining, etaHours, lastHour,
    channels: { total: channels.length, caughtUp },
    memory: memoryCounts(guildId),
    spentUsd: spent.usd, monthUsd: spent.month, calls: spent.calls, budgetUsd,
    running: Boolean(isLockState(lock) && now - lock.at < LOCK_FRESH_MS),
    paused: isPauseState(paused) ? paused : null
  };
}
