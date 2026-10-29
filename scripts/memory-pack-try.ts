import 'dotenv/config';
import { readFileSync } from 'node:fs';

// 記憶の想起 (メモリパック) を試す。依頼ごとに、何が思い出されるかを表示する (AI の返事は作らない)。
//
//   MEMORY_DB_PATH=… node --import tsx scripts/memory-pack-try.ts --guild ID --text "たこって Rust 好きだっけ？"
//   MEMORY_DB_PATH=… node --import tsx scripts/memory-pack-try.ts --guild ID --file requests.txt     (1 行 1 依頼)
//
// 判定モデル (jev) を呼ぶので OPENROUTER_API_KEY が要る (1 依頼 約 $0.00003)。

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const guildId = flag('guild');
if (!guildId || !process.env.MEMORY_DB_PATH) throw new Error('使い方: MEMORY_DB_PATH=… memory-pack-try.ts --guild ID (--text 依頼 | --file 依頼の一覧)');
const requests = flag('file') ? readFileSync(flag('file') as string, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean) : [flag('text') ?? ''];

const { recallPack } = await import('../src/memory/pack.js');
const { shutdown, memoryWorker } = await import('../src/embed/worker.js');
// モデルの読み込みを先に済ませる (bot では常駐しているので、最初の 1 回だけ質問側が間に合わない)
await memoryWorker().embedTexts(['warmup'], { kind: 'query' });
for (const request of requests) {
  const started = Date.now();
  const pack = await recallPack(guildId, { request });
  const ms = Date.now() - started;
  console.log(`\n### ${request}  (${ms}ms)`);
  console.log(pack === null ? '(null: 従来の想起へ)' : pack.text === '' ? '(空: 記憶に触れない)' : pack.text);
}
shutdown();
process.exit(0);
