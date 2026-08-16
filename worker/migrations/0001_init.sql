-- 法令の公開正本。botのgovernance_laws / governance_constitutions と同じ意味の列を持つ。
CREATE TABLE IF NOT EXISTS instruments (
  guild_id TEXT NOT NULL,
  type TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  publication_status TEXT NOT NULL,
  text TEXT NOT NULL,
  provisions_json TEXT,
  content_hash TEXT NOT NULL,
  effective_at INTEGER NOT NULL,
  ended_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, type, instrument_id)
);

CREATE INDEX IF NOT EXISTS idx_instruments_status
  ON instruments (guild_id, type, status, effective_at);
