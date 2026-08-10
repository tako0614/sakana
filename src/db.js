import Database from 'better-sqlite3';
import path from 'path';

// dbファイルを /home/tako/Desktop/github/sakana などに保存
export const db = new Database('database.sqlite');
db.pragma('journal_mode = WAL');

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

export function addTextXP(guildId, userId, amount) {
  // 累計データを更新
  db.prepare(`
    INSERT INTO guild_users (guild_id, user_id, xp_text, xp_voice)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET xp_text = xp_text + excluded.xp_text
  `).run(guildId, userId, amount);

  // ログに記録
  db.prepare(`INSERT INTO xp_log (guild_id, user_id, type, amount) VALUES (?, ?, 'text', ?)`).run(guildId, userId, amount);
}

export function addVoiceXP(guildId, userId, amount) {
  // 累計データを更新
  db.prepare(`
    INSERT INTO guild_users (guild_id, user_id, xp_text, xp_voice)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET xp_voice = xp_voice + excluded.xp_voice
  `).run(guildId, userId, amount);

  // ログに記録
  db.prepare(`INSERT INTO xp_log (guild_id, user_id, type, amount) VALUES (?, ?, 'voice', ?)`).run(guildId, userId, amount);
}

// 動的に期間を指定してランキングを取得する関数
export function getTopXP(guildId, type, period = 'all', limit = 5) {
  let timeFilter = '';
  // period により取得するレコードの期間を絞る (過去24時間、過去7日間、過去30日間)
  if (period === 'day') timeFilter = "AND created_at >= datetime('now', '-1 day')";
  if (period === 'week') timeFilter = "AND created_at >= datetime('now', '-7 days')";
  if (period === 'month') timeFilter = "AND created_at >= datetime('now', '-30 days')";

  return db.prepare(`
    SELECT user_id as id, SUM(amount) as xp 
    FROM xp_log 
    WHERE guild_id = ? AND type = ? ${timeFilter}
    GROUP BY user_id 
    HAVING xp > 0
    ORDER BY xp DESC 
    LIMIT ?
  `).all(guildId, type, limit);
}

export function getUserRank(guildId, userId, type, period = 'all') {
  let timeFilter = '';
  if (period === 'day') timeFilter = "AND created_at >= datetime('now', '-1 day')";
  if (period === 'week') timeFilter = "AND created_at >= datetime('now', '-7 days')";
  if (period === 'month') timeFilter = "AND created_at >= datetime('now', '-30 days')";

  const userTotal = db.prepare(`SELECT SUM(amount) as xp FROM xp_log WHERE guild_id = ? AND user_id = ? AND type = ? ${timeFilter}`).get(guildId, userId, type)?.xp || 0;

  if (userTotal === 0) return { rank: '-', xp: 0 };

  const rank = db.prepare(`
    SELECT COUNT(*) as count FROM (
      SELECT SUM(amount) as total_xp FROM xp_log WHERE guild_id = ? AND type = ? ${timeFilter} GROUP BY user_id
    ) WHERE total_xp > ?
  `).get(guildId, type, userTotal).count + 1;

  return { rank, xp: userTotal };
}
