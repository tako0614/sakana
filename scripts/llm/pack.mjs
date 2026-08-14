// 推論に必要なものだけを1つのディレクトリにまとめる。
//
//   node scripts/llm/pack.mjs scripts/llm/out/ckpt-e5.pt dist/mimic
//
// 学習はこの開発機で回すが、推論は bot の機械で動かす。運ぶのは4つだけ:
//   ckpt.pt        重み (5.87M × fp32 = 約 25MB)
//   tok.model      tokenizer。これが無いと同じ切り方にならない
//   speakers.json  Discord の user_id → 話者トークン
//   channels.json  channel_id → 順位。**これを運んでいなかった。**
//
// **channels.json を落とすと、話題の手がかりが推論だけ丸ごと消える。**
// plain.js の loadChannelRanks() は mimic/channels.json を読んで `#ch0..#ch15`
// (ft 系) と `<|c0|>..<|c15|>` (evex-4 以降) の順位表を作るが、無いと空の Map に
// なって**例外を出さずに全部 `#other` / `<|cx|>` に落ちる**。ft 系は上位16chで
// 発言の 97% を覆っているので、丸ごと 1 つの信号を捨てていたことになる。
//
// **順位表は世代と対にする。**発言数の増分で順位が入れ替わるので、
// 載せているモデルを学習したときの channels.json でなければならない
// ([[labels-follow-corpus]] と同じ罠)。
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

// channels.json は生の書き出し側 (export-raw.mjs) にある。corpus-v7 に対する
// corpus-v7-raw のように、`-raw` を付けた隣を見る
const rawDir = process.env.LLM_RAW_DIR ?? `${corpus}-raw`;

const items = [
  [ckpt, 'ckpt.pt', true],
  [path.join(corpus, 'tok.model'), 'tok.model', true],
  [path.join(corpus, 'speakers.json'), 'speakers.json', true],
  [path.join(rawDir, 'channels.json'), 'channels.json', false]
];

let total = 0;
for (const [from, to, required] of items) {
  const info = await stat(from).catch(() => null);
  if (!info) {
    if (!required) {
      console.error(`⚠ ${from} が無い。チャンネルの手がかりが推論で全部 `
        + `#other / <|cx|> に落ちる (LLM_RAW_DIR で場所を指定できる)`);
      continue;
    }
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
