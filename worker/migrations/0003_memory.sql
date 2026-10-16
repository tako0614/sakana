-- 記憶の本 (wiki) の公開用の写し。正本は bot の memory.sqlite で、builder の後に差分だけ押し込む。
-- 行は content_hash を持ち、押し込み側は GET /v1/memory/hashes と比べて変わったものだけを送る。

CREATE TABLE IF NOT EXISTS memory_nodes (
  guild_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  path TEXT NOT NULL,                  -- '' が根。'people/あかり' のように / 区切り
  parent TEXT,
  name TEXT NOT NULL,
  depth INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',       -- 統合済みの本文 ([e12] と [[path]] を含む)
  pending TEXT NOT NULL DEFAULT '',    -- まだ本文に入っていない知識のメモ
  pending_count INTEGER NOT NULL DEFAULT 0,
  aliases TEXT NOT NULL DEFAULT '[]',
  weight INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER,
  last_at INTEGER,
  updated_at INTEGER NOT NULL,
  child_count INTEGER NOT NULL DEFAULT 0,
  episode_count INTEGER NOT NULL DEFAULT 0,   -- 子ページの出来事も数える
  content_hash TEXT NOT NULL,
  PRIMARY KEY (guild_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_nodes_path ON memory_nodes (guild_id, path);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_parent ON memory_nodes (guild_id, parent, weight DESC);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_updated ON memory_nodes (guild_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_episodes (
  guild_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL DEFAULT '',
  at_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  importance INTEGER NOT NULL DEFAULT 2,
  source_count INTEGER NOT NULL DEFAULT 0,
  hidden_quotes INTEGER NOT NULL DEFAULT 0,   -- 見られないチャンネルのため載せなかった発言の数
  content_hash TEXT NOT NULL,
  PRIMARY KEY (guild_id, id)
);
CREATE INDEX IF NOT EXISTS idx_memory_episodes_time ON memory_episodes (guild_id, at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_memory_episodes_kind ON memory_episodes (guild_id, kind, at_ms DESC);

-- 出来事の根拠の発言。全員に見えるチャンネルのものだけを押し込む
CREATE TABLE IF NOT EXISTS memory_quotes (
  guild_id TEXT NOT NULL,
  episode_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  highlight INTEGER NOT NULL DEFAULT 0,       -- 1: 決め台詞として選ばれた発言
  PRIMARY KEY (guild_id, episode_id, message_id)
);

CREATE TABLE IF NOT EXISTS memory_episode_nodes (
  guild_id TEXT NOT NULL,
  episode_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (guild_id, episode_id, path)
);
CREATE INDEX IF NOT EXISTS idx_memory_episode_nodes_path ON memory_episode_nodes (guild_id, path, episode_id);

CREATE TABLE IF NOT EXISTS memory_episode_links (
  guild_id TEXT NOT NULL,
  from_id INTEGER NOT NULL,            -- 新しい方
  to_id INTEGER NOT NULL,              -- 前の出来事
  PRIMARY KEY (guild_id, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_episode_links_to ON memory_episode_links (guild_id, to_id);

-- ページどうしのつながり (同じ出来事に出る・本文でリンクする)
CREATE TABLE IF NOT EXISTS memory_links (
  guild_id TEXT NOT NULL,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, src, dst)
);

CREATE TABLE IF NOT EXISTS memory_meta (
  guild_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (guild_id, key)
);

-- 日本語は単語で区切れないので trigram。3文字未満の語は LIKE に落とす (store.ts)
CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(
  path, summary, body, aliases, content='memory_nodes', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS memory_nodes_ai AFTER INSERT ON memory_nodes BEGIN
  INSERT INTO memory_nodes_fts(rowid, path, summary, body, aliases) VALUES (new.rowid, new.path, new.summary, new.body, new.aliases);
END;
CREATE TRIGGER IF NOT EXISTS memory_nodes_ad AFTER DELETE ON memory_nodes BEGIN
  INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, path, summary, body, aliases) VALUES ('delete', old.rowid, old.path, old.summary, old.body, old.aliases);
END;
CREATE TRIGGER IF NOT EXISTS memory_nodes_au AFTER UPDATE OF path, summary, body, aliases ON memory_nodes BEGIN
  INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, path, summary, body, aliases) VALUES ('delete', old.rowid, old.path, old.summary, old.body, old.aliases);
  INSERT INTO memory_nodes_fts(rowid, path, summary, body, aliases) VALUES (new.rowid, new.path, new.summary, new.body, new.aliases);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_episodes_fts USING fts5(
  title, summary, kind, content='memory_episodes', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS memory_episodes_ai AFTER INSERT ON memory_episodes BEGIN
  INSERT INTO memory_episodes_fts(rowid, title, summary, kind) VALUES (new.rowid, new.title, new.summary, new.kind);
END;
CREATE TRIGGER IF NOT EXISTS memory_episodes_ad AFTER DELETE ON memory_episodes BEGIN
  INSERT INTO memory_episodes_fts(memory_episodes_fts, rowid, title, summary, kind) VALUES ('delete', old.rowid, old.title, old.summary, old.kind);
END;
CREATE TRIGGER IF NOT EXISTS memory_episodes_au AFTER UPDATE OF title, summary, kind ON memory_episodes BEGIN
  INSERT INTO memory_episodes_fts(memory_episodes_fts, rowid, title, summary, kind) VALUES ('delete', old.rowid, old.title, old.summary, old.kind);
  INSERT INTO memory_episodes_fts(rowid, title, summary, kind) VALUES (new.rowid, new.title, new.summary, new.kind);
END;
