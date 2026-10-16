import Database from 'better-sqlite3';
import { scheduleOptimize, tuneSqlite } from './sqlite.js';

// dbファイルを /home/tako/Desktop/github/sakana などに保存
// テストや複数instanceでは別DBへ逃がせるようにする。未指定時の保存先は従来どおり。
export const db = new Database(process.env.DATABASE_PATH ?? 'database.sqlite', { timeout: 30_000 });
db.pragma('journal_mode = WAL');
tuneSqlite(db, { cacheMiB: 16, mmapMiB: 128, label: 'database' });
scheduleOptimize(db, { label: 'database' });

// guild_id と user_id ごとのテキストとボイスXPを保持するテーブル
db.exec(`
  CREATE TABLE IF NOT EXISTS guild_users (
    guild_id TEXT,
    user_id TEXT,
    xp_text INTEGER DEFAULT 0,
    xp_voice INTEGER DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  )
`);

// 期間集計用のログテーブル (いつ誰がどのXPを取得したか履歴を残す)
db.exec(`
  CREATE TABLE IF NOT EXISTS xp_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    user_id TEXT,
    type TEXT,       -- 'text' or 'voice'
    amount INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

/** ランキングの1行。 */
export interface XpRow {
  id: string;
  xp: number;
}

/** その人の順位。XP が無ければ順位は '-'。 */
export interface UserRank {
  rank: number | '-';
  xp: number;
}

// --- 行の形を確かめる (DB の中身は型を保証しない) ---

function isXpRow(row: unknown): row is XpRow {
  return typeof row === 'object' && row !== null
    && 'id' in row && typeof row.id === 'string'
    && 'xp' in row && typeof row.xp === 'number';
}

/** SUM(amount) の行。対象が無ければ xp は null。 */
function totalOf(row: unknown): number | null {
  if (typeof row !== 'object' || row === null || !('xp' in row)) return null;
  return typeof row.xp === 'number' ? row.xp : null;
}

/** COUNT(*) の行。 */
function countOf(row: unknown): number {
  if (typeof row !== 'object' || row === null || !('count' in row)) return 0;
  return typeof row.count === 'number' ? row.count : 0;
}

export function addTextXP(guildId: string, userId: string, amount: number): void {
  // 累計データを更新
  db.prepare(`
    INSERT INTO guild_users (guild_id, user_id, xp_text, xp_voice)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET xp_text = xp_text + excluded.xp_text
  `).run(guildId, userId, amount);

  // ログに記録
  db.prepare(`INSERT INTO xp_log (guild_id, user_id, type, amount) VALUES (?, ?, 'text', ?)`).run(guildId, userId, amount);
}

export function addVoiceXP(guildId: string, userId: string, amount: number): void {
  // 累計データを更新
  db.prepare(`
    INSERT INTO guild_users (guild_id, user_id, xp_text, xp_voice)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET xp_voice = xp_voice + excluded.xp_voice
  `).run(guildId, userId, amount);

  // ログに記録
  db.prepare(`INSERT INTO xp_log (guild_id, user_id, type, amount) VALUES (?, ?, 'voice', ?)`).run(guildId, userId, amount);
}

// 期間の絞り込み。SQL に直接埋めるので、決め打ちの4通り以外は全期間にする
function timeFilterOf(period: string): string {
  // period により取得するレコードの期間を絞る (過去24時間、過去7日間、過去30日間)
  if (period === 'day') return "AND created_at >= datetime('now', '-1 day')";
  if (period === 'week') return "AND created_at >= datetime('now', '-7 days')";
  if (period === 'month') return "AND created_at >= datetime('now', '-30 days')";
  return '';
}

// 動的に期間を指定してランキングを取得する関数
export function getTopXP(guildId: string, type: string, period: string = 'all', limit = 5): XpRow[] {
  const timeFilter = timeFilterOf(period);

  return db.prepare(`
    SELECT user_id as id, SUM(amount) as xp
    FROM xp_log
    WHERE guild_id = ? AND type = ? ${timeFilter}
    GROUP BY user_id
    HAVING xp > 0
    ORDER BY xp DESC
    LIMIT ?
  `).all(guildId, type, limit).filter(isXpRow);
}

export function getUserRank(guildId: string, userId: string, type: string, period: string = 'all'): UserRank {
  const timeFilter = timeFilterOf(period);

  const userTotal = totalOf(db.prepare(`SELECT SUM(amount) as xp FROM xp_log WHERE guild_id = ? AND user_id = ? AND type = ? ${timeFilter}`).get(guildId, userId, type)) || 0;

  if (userTotal === 0) return { rank: '-', xp: 0 };

  const rank = countOf(db.prepare(`
    SELECT COUNT(*) as count FROM (
      SELECT SUM(amount) as total_xp FROM xp_log WHERE guild_id = ? AND type = ? ${timeFilter} GROUP BY user_id
    ) WHERE total_xp > ?
  `).get(guildId, type, userTotal)) + 1;

  return { rank, xp: userTotal };
}
