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
    label: 'deepseek-v4-flash',
    summary: '検索・read・web・引用つきのエージェント。事実を調べて答える'
  },
  evex: {
    label: 'evex-2',
    summary: 'このサーバーの94万件だけで一から学習した素のチャットボット。道具も検索も無く、会話の続きを書くだけ。evex-1 から LR を直し、正規化記号を損失から外して記号だけの返答を 38.5% → 0%'
  },
  // 一から学習した最初の世代。evex-2 に差し替えたあとも比べられるように残す。
  // 同じコーパス・同じ tokenizer で、違うのは LR だけ (3e-4 → 1e-3)。
  'evex-1': {
    label: 'evex-1',
    summary: 'このサーバーの94万件だけで一から学習した最初の版。val 4.2404。evex-2 と読み比べるために残してある'
  },
  // 別プロセス・別ポートで並走させる。evex を置き換えないのは性質が違うから —
  // あちらは 94万件だけで純度が高い代わりに荒く、こちらは Qwen3-0.6B の日本語を
  // 引き継いで読める代わりに Qwen の知識が混ざる。読み比べられる形にしておく。
  'evex-ft': {
    label: 'evex-ft-1',
    summary: 'Qwen3-0.6B-Base にこのサーバーの口調を追加学習したもの。日本語は読めるが事実は当てにならない。147人の口調を持ち、名前を持たない人も直近の発言から真似る (evex-2 は48人)'
  },
  // ft-1 と同じ base で、コーパスだけ違う。話を受けて返すようにしたもの。
  // 並走させて読み比べる — ft-1 は名前を指定すれば答えるが、指定しないと
  // `まじ？` `うーん` で終わっていた (実測: 20字以上で返す率 65% 対 30%)
  'evex-ft-2': {
    label: 'evex-ft-2',
    summary: 'evex-ft-1 と同じ土台で、聞かれたら答えるように学習し直したもの。事実は相変わらず当てにならないが、話は受ける'
  },
  // 土台を Qwen3-0.6B-Base から instruct 版に変えたもの。答えの形にはなるが、
  // なりきりの噛み合いは ft-2 より落ちる。読み比べるために並べる
  'evex-ft-3': {
    label: 'evex-ft-3',
    summary: 'evex-ft-2 と同じデータで、土台を instruct 版に変えたもの。答えの形になりやすい代わりに、なりきりは ft-2 より弱い'
  },
  // ゼロから学習した系の 3 代目。ft 系で効いたコーパスの工夫を記号に翻訳して
  // 持ち込み、大きさも 5.87M → 15.74M に上げたもの
  'evex-3': {
    label: 'evex-3',
    summary: 'このサーバーの94万件だけで一から学習した3代目。147人の口調を持ち (evex-2 は48人)、誰への返信かも学んでいる。15.74M パラメータ / 学習トークン 2,395万'
  },
  // 語彙を 4096 → 12288 にして、公開の会話データで土台を作ってから
  // evex だけで仕上げたもの。evex-3 と読み比べるために並べる
  'evex-3.5': {
    label: 'evex-3.5',
    summary: 'evex-3 の語彙を3倍にして、公開のなりきり掲示板で会話の土台を作ってからこのサーバーで仕上げたもの。話者147人はこのサーバーのぶんだけで、外部データには使っていない'
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
