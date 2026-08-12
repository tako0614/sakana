// どのモデルで答えるかの選択。誰でも自分のぶんだけ変えられる。
//
// agent_settings は value が REAL なので文字列を入れられない。数値に符号化すると
// 「3 番のエンジン」みたいな読めない設定になるので、素直に別の表を持つ。

import { db } from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_engine (
    user_id    TEXT PRIMARY KEY,
    engine     TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const getStmt = db.prepare('SELECT engine FROM agent_engine WHERE user_id = ?');
const setStmt = db.prepare(`
  INSERT INTO agent_engine (user_id, engine, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET engine = excluded.engine, updated_at = excluded.updated_at
`);
const countStmt = db.prepare('SELECT engine, COUNT(*) n FROM agent_engine GROUP BY engine');

/**
 * 選べるエンジン。
 *
 * 別物なのは「モデル名が違う」だけではない。deepseek は道具を持ったエージェントで、
 * evex は 94万件から作った 5.87M の言語モデルで、道具も system プロンプトも使えず
 * 会話の続きを書くだけ。答えの形そのものが変わる。
 */
export const ENGINES = {
  deepseek: {
    label: 'DeepSeek v4 Flash',
    summary: '検索・read・web・引用つきのエージェント。事実を調べて答える'
  },
  evex: {
    label: 'Evex (自作 5.87M)',
    summary: 'このサーバーの94万件だけで学習したモデル。道具なし・会話の続きを書くだけ'
  }
};

export const DEFAULT_ENGINE = 'deepseek';

export function engineFor(userId) {
  const row = getStmt.get(String(userId));
  return ENGINES[row?.engine] ? row.engine : DEFAULT_ENGINE;
}

export function setEngine(userId, engine) {
  if (!ENGINES[engine]) return false;
  setStmt.run(String(userId), engine, Date.now());
  return true;
}

/** 誰がどれを使っているかの内訳。/model の表示に出す。 */
export function engineCounts() {
  const counts = new Map(countStmt.all().map((row) => [row.engine, row.n]));
  return Object.keys(ENGINES).map((key) => ({ engine: key, users: counts.get(key) ?? 0 }));
}
