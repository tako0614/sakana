import Database from 'better-sqlite3';
import path from 'path';

// dbファイルを /home/tako/Desktop/github/sakana などに保存
const db = new Database('database.sqlite');
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

export function addTextXP(guildId, userId, amount) {
  const stmt = db.prepare(`
    INSERT INTO guild_users (guild_id, user_id, xp_text, xp_voice)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET xp_text = xp_text + excluded.xp_text
  `);
  stmt.run(guildId, userId, amount);
}

export function addVoiceXP(guildId, userId, amount) {
  const stmt = db.prepare(`
    INSERT INTO guild_users (guild_id, user_id, xp_text, xp_voice)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET xp_voice = xp_voice + excluded.xp_voice
  `);
  stmt.run(guildId, userId, amount);
}

export function getTopText(guildId, limit = 5) {
  return db.prepare(`SELECT user_id as id, xp_text FROM guild_users WHERE guild_id = ? AND xp_text > 0 ORDER BY xp_text DESC LIMIT ?`).all(guildId, limit);
}

export function getTopVoice(guildId, limit = 5) {
  return db.prepare(`SELECT user_id as id, xp_voice FROM guild_users WHERE guild_id = ? AND xp_voice > 0 ORDER BY xp_voice DESC LIMIT ?`).all(guildId, limit);
}

export function getUserTextRank(guildId, userId) {
  const user = db.prepare(`SELECT xp_text FROM guild_users WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
  if (!user || user.xp_text === 0) return { rank: '-', xp: 0 };
  const rank = db.prepare(`SELECT COUNT(*) as count FROM guild_users WHERE guild_id = ? AND xp_text > ?`).get(guildId, user.xp_text).count + 1;
  return { rank, xp: user.xp_text };
}

export function getUserVoiceRank(guildId, userId) {
  const user = db.prepare(`SELECT xp_voice FROM guild_users WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
  if (!user || user.xp_voice === 0) return { rank: '-', xp: 0 };
  const rank = db.prepare(`SELECT COUNT(*) as count FROM guild_users WHERE guild_id = ? AND xp_voice > ?`).get(guildId, user.xp_voice).count + 1;
  return { rank, xp: user.xp_voice };
}
