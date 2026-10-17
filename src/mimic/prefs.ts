import { AGENT_ENGINES, DEFAULT_AGENT_ENGINE } from '../agent/engines.js';
// どのモデルで答えるかの選択。誰でも自分のぶんだけ変えられる。
//
// agent_settings は value が REAL なので文字列を入れられない。数値に符号化すると
// 「3 番のエンジン」みたいな読めない設定になるので、素直に別の表を持つ。

import { db } from '../db.js';
import { migrateGuildPreference, requireGuildId } from './scope.js';

/** /model に出す1行。 */
export interface EngineInfo {
  label: string;
  summary: string;
}

/** agent_engine の内訳の1行。 */
interface EngineCountRow {
  engine: string;
  n: number;
}

function engineColumn(row: unknown): string | null {
  return typeof row === 'object' && row !== null && 'engine' in row && typeof row.engine === 'string' ? row.engine : null;
}

function isEngineCountRow(row: unknown): row is EngineCountRow {
  return typeof row === 'object' && row !== null
    && 'engine' in row && typeof row.engine === 'string'
    && 'n' in row && typeof row.n === 'number';
}

migrateGuildPreference(db, 'agent_engine', 'engine');
const getStmt = db.prepare<[string, string]>('SELECT engine FROM agent_engine WHERE guild_id = ? AND user_id = ?');
const setStmt = db.prepare<[string, string, string, number]>(`
  INSERT INTO agent_engine (guild_id, user_id, engine, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET engine = excluded.engine, updated_at = excluded.updated_at
`);
const countStmt = db.prepare<[string]>('SELECT engine, COUNT(*) n FROM agent_engine WHERE guild_id = ? GROUP BY engine');

/**
 * 選べるエンジン。
 *
 * 別物なのは「モデル名が違う」だけではない。ling / glm / qwen / deepseek / mimo は道具を持ったエージェントで、
 * evex は 94万件から作った 5.87M の言語モデルで、道具も system プロンプトも使えず
 * 会話の続きを書くだけ。答えの形そのものが変わる。
 */
export const ENGINES: Record<string, EngineInfo> = {
  // 道具を持ったエージェント (検索・read・web・記憶・引用)。モデルだけが違う
  glm: {
    label: AGENT_ENGINES.glm,
    summary: '検索・read・web・記憶・引用つきのエージェント (既定)。日本語と道具の使い方が安定していて、日付や固有名に強い'
  },
  ling: {
    label: AGENT_ENGINES.ling,
    summary: '同じエージェントを ling-3.0-flash で。いちばん安いが、glm よりぶれやすい'
  },
  qwen: {
    label: AGENT_ENGINES.qwen,
    summary: '同じエージェントを qwen3.8-flash で。ノリが良く道具も使えるが、考えるぶん答えが遅い (30秒前後)'
  },
  deepseek: {
    label: AGENT_ENGINES.deepseek,
    summary: '同じエージェントを deepseek-v4.1-flash で。glm に近い出来でいじりも上手い。出典に無い URL を作ることがある'
  },
  mimo: {
    label: AGENT_ENGINES.mimo,
    summary: '同じエージェントを mimo-v2.6-flash で。安くて言い回しが面白い。調べ物で検索を重ねがち'
  },
  'evex-3.5': {
    label: 'evex-3.5',
    summary: 'evex-3 の語彙を3倍にして、公開のなりきり掲示板で会話の土台を作ってからこのサーバーで仕上げたもの。話者147人はこのサーバーのぶんだけで、外部データには使っていない'
  }
};

export const DEFAULT_ENGINE: string = DEFAULT_AGENT_ENGINE;

/**
 * 選べるエンジンの説明。知らない名前は null。
 *
 * **ENGINES[key] で直接引かない。**`toString` や `constructor` のように
 * Object の継承プロパティと同じ名前が来ると、そのまま「ある」と判定してしまう
 * (コマンドの選択肢は送り手が書き換えられるので、届いた値は検め直す)。
 */
export function engineInfo(engine: unknown): EngineInfo | null {
  return typeof engine === 'string' && Object.hasOwn(ENGINES, engine) ? ENGINES[engine] ?? null : null;
}

// **消したエンジンの読み替え先。**選択は DB に残るので、名前を消しただけだと
// `ENGINES[row.engine]` が undefined になって**黙って既定に落ちる**。
// 選び直しを強いるのも筋が違うので、後継に読み替える
// deepseek は 2026-10-15 に一度廃止したが、2026-10-17 に v4.1-flash で復活させた (読み替えは外した)。
// luna は 2026-10-17 に足して同じ日に廃止した。選んでいた人は既定のエージェントへ。
// 自作モデルは evex-3.5 だけ残して、同じ日にほかの世代を廃止した。選んでいた人は evex-3.5 へ
const RENAMED: Record<string, string> = { 'evex': 'evex-3.5', 'evex-1': 'evex-3.5', 'evex-ft': 'evex-3.5', 'evex-ft-2': 'evex-3.5', 'evex-ft-3': 'evex-3.5', 'evex-3': 'evex-3.5', 'evex-4': 'evex-3.5', 'evex-4.1': 'evex-3.5', 'evex-5': 'evex-3.5', 'evex-5.1': 'evex-3.5', 'evex-5.2': 'evex-3.5', 'evex-5.3': 'evex-3.5', 'evex-5.2-a': 'evex-3.5', 'evex-5.2-b': 'evex-3.5', luna: DEFAULT_AGENT_ENGINE };

function renamed(engine: string): string {
  return Object.hasOwn(RENAMED, engine) ? RENAMED[engine] ?? engine : engine;
}

export function engineFor(userId: string, guildId: unknown): string {
  const stored = engineColumn(getStmt.get(requireGuildId(guildId), String(userId)));
  const engine = stored === null ? null : renamed(stored);
  return engine !== null && engineInfo(engine) ? engine : DEFAULT_ENGINE;
}

export function setEngine(userId: string, engine: string, guildId: unknown): boolean {
  const guild = requireGuildId(guildId);
  const target = renamed(String(engine));
  if (!engineInfo(target)) return false;
  setStmt.run(guild, String(userId), target, Date.now());
  return true;
}

/** 誰がどれを使っているかの内訳。/model の表示に出す。 */
export function engineCounts(guildId: unknown): Array<{ engine: string; users: number }> {
  // 読み替えたぶんも足す。素の行のままだと消したエンジンの人が数から消える
  const counts = new Map<string, number>();
  for (const row of countStmt.all(requireGuildId(guildId)).filter(isEngineCountRow)) {
    const key = renamed(row.engine);
    counts.set(key, (counts.get(key) ?? 0) + row.n);
  }
  return Object.keys(ENGINES).map((key) => ({ engine: key, users: counts.get(key) ?? 0 }));
}
