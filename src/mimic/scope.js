export function requireGuildId(guildId) {
  if (typeof guildId !== 'string' || !guildId.trim()) throw new Error('A guildId is required');
  return guildId;
}

export function migrateGuildPreference(db, table, field) {
  if (!['agent_engine:engine', 'agent_persona:target_id'].includes(`${table}:${field}`)) throw new Error('Unknown preference table');
  db.transaction(() => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.length && !columns.some((row) => row.name === 'guild_id')) {
      // The source guild of a global preference cannot be reconstructed. Retain
      // the old records for migration review without applying them to any guild.
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy_unscoped`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, ${field} TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id)
    )`);
  })();
}
