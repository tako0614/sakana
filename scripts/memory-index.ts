import 'dotenv/config';

// 記憶の意味索引 (ベクトル + 主張の語彙索引) を、bot の定期実行を待たずに作る。初回の振りは数十万件になる (ruri-v3-130m で 1〜2 時間)ので、
// 切り替えの前に別プロセスで済ませておく。変わったものだけ振るので、何度呼んでもよい (止めても続きから)。
//
//   MEMORY_DB_PATH=/root/sakana/data/memory2.sqlite MEMORY_EMBED_THREADS=12 \
//     node --import tsx scripts/memory-index.ts --guild ID [--minutes 240]
//
// SEMANTIC_PYTHON_BIN (.venv/bin/python) は bot の作業ディレクトリ (/root/sakana) からの相対なので、そこで動かすこと。

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const guildId = flag('guild');
if (!guildId) throw new Error('使い方: memory-index.ts --guild ID [--minutes N]');
if (!process.env.MEMORY_DB_PATH) throw new Error('MEMORY_DB_PATH を指定してください (対象の記憶の DB)');
const minutes = Number(flag('minutes') ?? 240);

const { syncMemoryVectors } = await import('../src/memory/vectors.js');
const { shutdown } = await import('../src/embed/worker.js');
const { memoryDb } = await import('../src/memory/store.js');

const started = Date.now();
let total = 0;
for (;;) {
  const result = await syncMemoryVectors(guildId, { batchSize: 32, sleepMs: 0, deadlineMs: 10 * 60_000 });
  total += result.embedded;
  const counts = memoryDb().prepare<[string], { kind: string; c: number }>('SELECT kind, COUNT(*) AS c FROM memory_vectors WHERE guild_id = ? GROUP BY kind').all(guildId);
  console.log(`${new Date().toISOString().slice(11, 19)} 振った ${result.embedded} / 残り ${result.remaining} / 消した ${result.removed} / ${counts.map((row) => `${row.kind}=${row.c}`).join(' ')}`);
  if (result.remaining === 0 || result.embedded === 0) break;
  if (Date.now() - started > minutes * 60_000) { console.log('時間切れ。続きは同じコマンドで'); break; }
}
console.log(`完了: ${total} 件を ${((Date.now() - started) / 60000).toFixed(1)} 分で`);
shutdown();
process.exit(0);
