import type Database from 'better-sqlite3';
import { memoryDb } from '../store.js';

// v2 の作業用の表。v1 と同じ形の表 (nodes / episodes / …) は store.ts が作るので、
// MEMORY_DB_PATH を新しいファイルに向ければ、ここは「その上に足す表」だけを作る。
//
//   v2_sections        区間 (1 回の読み取りの単位)。範囲だけ持ち、台本はアーカイブから作り直す
//   v2_episodes        出来事 (検証つき)。id が最終の [eN] になる
//   v2_claims          主張 (1 主張 = 1 命題 + 根拠の行 + 話の種類 + 時刻)。ページはこれから組み立てる
//   v2_claim_evidence  主張 ↔ 根拠の発言
//   v2_entities        ページになるもの。人物は author_id で決まる
//   v2_jobs / v2_llm_cache  工程の台帳と、モデルの出力の保存 (入力のハッシュ → 出力。止まっても続きから)

export function ensureV2Schema(db: Database.Database = memoryDb()): Database.Database {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      parent_id INTEGER,               -- 長さ切れで割った元の区間
      depth INTEGER NOT NULL DEFAULT 0,
      channel_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      from_ms INTEGER NOT NULL,
      to_ms INTEGER NOT NULL,
      messages INTEGER NOT NULL,
      chars INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', -- pending | extracted | done | split | failed
      extract_model TEXT,
      verify_model TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE (guild_id, channel_id, from_id, to_id)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_sections_state ON v2_sections(guild_id, state);

    CREATE TABLE IF NOT EXISTS v2_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      section_id INTEGER NOT NULL,
      ord INTEGER NOT NULL,            -- 出力の中の番号
      conv TEXT,
      kind TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT '',
      importance INTEGER NOT NULL DEFAULT 2,
      channel_id TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      entities TEXT NOT NULL DEFAULT '[]',  -- 関わった author_id と、ページ名 (JSON: [{"k":"person","v":"…"}])
      related TEXT NOT NULL DEFAULT '[]',   -- 同じ出力の中の続き (出来事の番号)
      verdict TEXT NOT NULL DEFAULT 'ok',   -- ok | weak | wrong
      hedged INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      seed INTEGER NOT NULL DEFAULT 0,
      UNIQUE (section_id, ord)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_episodes_time ON v2_episodes(guild_id, at_ms);

    CREATE TABLE IF NOT EXISTS v2_episode_messages (
      episode_id INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,              -- core | quote (決め台詞は core でもある)
      PRIMARY KEY (episode_id, message_id, role)
    );

    CREATE TABLE IF NOT EXISTS v2_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      section_id INTEGER NOT NULL,
      episode_id INTEGER,              -- v2_episodes.id (出典の出来事)
      ord INTEGER NOT NULL,
      about_kind TEXT NOT NULL,        -- person | thing
      about_key TEXT NOT NULL,         -- person: author_id / thing: 名前そのまま
      category TEXT NOT NULL DEFAULT 'others',
      text TEXT NOT NULL,
      type TEXT NOT NULL,
      modality TEXT NOT NULL DEFAULT 'plain',
      attrs TEXT NOT NULL DEFAULT '{}',
      as_of INTEGER NOT NULL,          -- 根拠の発言の時刻 (ms)
      verdict TEXT NOT NULL DEFAULT 'ok',
      hedged INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      seed INTEGER NOT NULL DEFAULT 0,
      entity_id INTEGER,               -- resolve が決める
      UNIQUE (section_id, ord)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_claims_entity ON v2_claims(guild_id, entity_id, as_of);
    CREATE INDEX IF NOT EXISTS idx_v2_claims_episode ON v2_claims(episode_id);

    CREATE TABLE IF NOT EXISTS v2_claim_evidence (
      claim_id INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (claim_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS v2_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      kind TEXT NOT NULL,              -- person | thing
      key TEXT NOT NULL,               -- person: author_id / thing: 正規化した名前
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'others',
      path TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      aliases TEXT NOT NULL DEFAULT '[]',
      meta TEXT NOT NULL DEFAULT '{}',   -- person: 発言数・最初と最後の発言・アカウント数 など
      UNIQUE (guild_id, kind, key)
    );

    -- 組み立てたページ (S4〜S6)。投影 (project) が nodes に写す
    CREATE TABLE IF NOT EXISTS v2_pages (
      guild_id TEXT NOT NULL,
      path TEXT NOT NULL,
      entity_id INTEGER,
      summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',   -- [eN] 済み
      aliases TEXT NOT NULL DEFAULT '[]',
      weight INTEGER NOT NULL DEFAULT 0,
      claims INTEGER NOT NULL DEFAULT 0,    -- 材料にした主張の数
      cited INTEGER NOT NULL DEFAULT 0,     -- そのうち文に入った数 (残りは機械が追記する)
      source TEXT NOT NULL DEFAULT 'compose', -- compose | mechanical | arc | root
      first_at INTEGER,
      last_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, path)
    );

    CREATE TABLE IF NOT EXISTS v2_jobs (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,               -- 'extract:12' 'verify:12' 'compose:people/たこ' …
      stage TEXT NOT NULL,
      state TEXT NOT NULL,             -- done | failed
      attempts INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      model TEXT,
      provider TEXT,
      error TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, key)
    );

    CREATE TABLE IF NOT EXISTS v2_llm_cache (
      hash TEXT PRIMARY KEY,           -- sha256(stage + model + system + user)
      stage TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      cost REAL NOT NULL DEFAULT 0,
      output TEXT NOT NULL,            -- 読めた JSON (まだ検査していない)
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}
