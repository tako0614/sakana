import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// テスト用の D1 の代用品。better-sqlite3 の上に D1 の prepare/bind/all/first/run/batch だけを作る。
// FTS5 (trigram)・json_each・トリガーは本物の D1 と同じ SQLite の機能なので、SQL はそのまま通る。

type Param = string | number | null;

/** D1 は `?1` `?2` と番号で bind する (同じ番号を何度使ってもよい)。better-sqlite3 は番号つきを受け付けないので、
 *  出てくる順の `?` に直して、値も出てくる順に並べ替える。 */
export function positional(sql: string, params: readonly Param[]): { sql: string; params: Param[] } {
  const ordered: Param[] = [];
  const text = sql.replace(/\?(\d+)/g, (_match, number: string) => {
    const value = params[Number(number) - 1];
    if (value === undefined) throw new Error(`bind されていない ?${number}`);
    ordered.push(value);
    return '?';
  });
  return { sql: text, params: ordered };
}

class Statement {
  constructor(private readonly db: Database.Database, readonly sql: string, readonly params: Param[] = []) {}
  bind(...values: Param[]): Statement {
    return new Statement(this.db, this.sql, values);
  }
  private prepared() {
    const { sql, params } = positional(this.sql, this.params);
    return { statement: this.db.prepare(sql), params };
  }
  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, never> }> {
    const { statement, params } = this.prepared();
    return { results: statement.all(...params) as T[], success: true, meta: {} };
  }
  async first<T>(): Promise<T | null> {
    const { statement, params } = this.prepared();
    return (statement.get(...params) as T | undefined) ?? null;
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const { statement, params } = this.prepared();
    return { success: true, meta: { changes: statement.run(...params).changes } };
  }
  /** batch から使う: 読む文か書く文かで呼び分ける */
  execute(): unknown {
    const { statement, params } = this.prepared();
    return statement.reader ? statement.all(...params) : statement.run(...params);
  }
}

export interface TestD1 {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
  exec(sql: string): void;
  raw: Database.Database;
}

/** migrations/ の SQL を順に当てた空の D1。0001/0002 (法令集) と 0003 (記憶の本) を入れる。 */
export function createD1(): TestD1 {
  const db = new Database(':memory:');
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, file), 'utf8'));
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    exec: (sql) => void db.exec(sql),
    // D1 の batch は1つのトランザクション。途中で落ちたら全部戻す
    async batch(statements) {
      return db.transaction(() => statements.map((statement) => statement.execute()))();
    }
  };
}
