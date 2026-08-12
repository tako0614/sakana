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
    label: 'evex-2-preview (自作 5.87M)',
    summary: 'このサーバーの94万件だけで一から学習した素のチャットボット。道具も検索も無く、会話の続きを1発言返すだけ。evex-1 から LR を直して val 4.2404 → 4.0613'
  },
  // 一から学習した最初の世代。evex-2 に差し替えたあとも比べられるように残す。
  // 同じコーパス・同じ tokenizer で、違うのは LR だけ (3e-4 → 1e-3)。
  'evex-1': {
    label: 'evex-1 (自作 5.87M / 初代)',
    summary: 'このサーバーの94万件だけで一から学習した最初の版。val 4.2404。evex-2 と読み比べるために残してある'
  },
  // 別プロセス・別ポートで並走させる。evex を置き換えないのは性質が違うから —
  // あちらは 94万件だけで純度が高い代わりに荒く、こちらは Qwen3-0.6B の日本語を
  // 引き継いで読める代わりに Qwen の知識が混ざる。読み比べられる形にしておく。
  'evex-ft': {
    label: 'evex-ft-1-preview',
    summary: 'Qwen3-0.6B-Base にこのサーバーの口調を追加学習したもの。日本語は読めるが事実は当てにならない。147人の口調を持つ (evex-2 は48人)'
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
