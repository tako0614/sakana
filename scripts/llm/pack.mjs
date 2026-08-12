// 推論に必要なものだけを1つのディレクトリにまとめる。
//
//   node scripts/llm/pack.mjs scripts/llm/out/ckpt-e5.pt dist/mimic
//
// 学習はこの開発機で回すが、推論は bot の機械で動かす。運ぶのは3つだけ:
//   ckpt.pt        重み (5.87M × fp32 = 約 25MB)
//   tok.model      tokenizer。これが無いと同じ切り方にならない
//   speakers.json  Discord の user_id → 話者トークン
//
// コーパス本体 (train.txt / raw.jsonl.gz) は運ばない。推論には要らないし、
// 94万件の生ログを本番機に置く理由が無い。

import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ckpt = process.argv[2];
const outDir = process.argv[3] ?? 'dist/mimic';
const corpus = process.env.LLM_CORPUS_DIR ?? 'corpus';

if (!ckpt) {
  console.error('使い方: node scripts/llm/pack.mjs <ckpt.pt> [出力先]');
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

const items = [
  [ckpt, 'ckpt.pt'],
  [path.join(corpus, 'tok.model'), 'tok.model'],
  [path.join(corpus, 'speakers.json'), 'speakers.json']
];

let total = 0;
for (const [from, to] of items) {
  const info = await stat(from).catch(() => null);
  if (!info) {
    console.error(`見つかりません: ${from}`);
    process.exit(1);
  }

  await copyFile(from, path.join(outDir, to));
  total += info.size;
  console.log(`  ${to.padEnd(16)} ${(info.size / 1024 / 1024).toFixed(2)} MB`);
}

// どのチェックポイントを積んだか分からなくなるので、由来を残す。
// (val が最小の点と文体が一番らしい点は一致しないので、選んだ理由が後から要る)
await writeFile(
  path.join(outDir, 'MANIFEST.json'),
  `${JSON.stringify({ ckpt, corpus, bytes: total }, null, 2)}\n`
);

console.log(`\n合計 ${(total / 1024 / 1024).toFixed(2)} MB -> ${outDir}`);
console.log('\n運び方:');
console.log(`  scp -r ${outDir}/* root@192.168.0.117:/root/sakana/mimic/`);
console.log('  ssh root@192.168.0.117 systemctl restart sakana-mimic');
