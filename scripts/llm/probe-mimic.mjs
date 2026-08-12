// 動いている推論サーバーに「その人として喋れ」を投げて、実際に出るか見る。
//
//   node scripts/llm/probe-mimic.mjs [回数]
//
// /mimic が通る経路 (speakers.json → impersonate → generate → 切り出し) を
// そのまま使う。Discord のスラッシュコマンドは手で叩けないので、ここで確かめる。
//
// probe.mjs との違いは、通常の返答ではなく**名指しの生成**を見ること。
// 話者トークンを渡せているかは出力を読まないと分からない —
// 申告と食い違うトークンを渡しても例外は出ず、静かに崩れるだけ。

import { mimicConfig, roleScheme, status } from '../../src/mimic/client.js';
import { impersonate } from '../../src/mimic/impersonate.js';
import { learnedSpeakers, speakerTableSize } from '../../src/mimic/speakers.js';

const times = Number(process.argv[2] ?? 3);

const health = await status();
if (!health.up) {
  console.error(`推論サーバーが起動していません (${mimicConfig.url})`);
  process.exit(1);
}

const scheme = await roleScheme();
console.log(`${mimicConfig.url} / epoch ${health.epoch} / val ${health.val_loss?.toFixed?.(4)}`);
console.log(`申告された話者トークン: ${scheme?.speakers?.length ?? 0} 個`);
console.log(`手元の話者表: ${speakerTableSize} 人\n`);

if (!speakerTableSize) {
  console.error('話者表が読めていません。mimic/speakers.json を確認してください。');
  process.exit(1);
}

// 上位3人と、お題あり / なしを見る
const targets = learnedSpeakers().slice(0, 3);
const topics = [null, 'これバグってる？'];

let ok = 0;
let total = 0;

for (const target of targets) {
  for (const topic of topics) {
    console.log(`--- ${target.name} (${target.count.toLocaleString('en-US')}件) ${topic ? `/ お題「${topic}」` : '/ お題なし'}`);

    for (let i = 0; i < times; i += 1) {
      const { text, how } = await impersonate(target.userId, { topic });
      total += 1;
      // 3文字未満は bot 側で引き直す対象。ここでは素の1回ぶんを見る
      if (text && text.length >= 3) ok += 1;
      console.log(`  ${text ? ' ' : '×'} [${how}] ${JSON.stringify(text)}`);
    }
  }
}

console.log(`\n出た: ${ok}/${total} (${((ok / total) * 100).toFixed(0)}%)`);
console.log('how が token なら重みに焼き付いた本人、examples なら実発言からの真似');
