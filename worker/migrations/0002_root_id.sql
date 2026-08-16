-- 改正で版が変わっても同じ法令として沿革を並べるための系列ID。
-- 既存行は自分自身を系列の起点として扱う。
ALTER TABLE instruments ADD COLUMN root_id TEXT;
UPDATE instruments SET root_id = instrument_id WHERE root_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_instruments_root
  ON instruments (guild_id, type, root_id, version);
