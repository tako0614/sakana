// 動いている推論サーバーを叩いて、返答の質を数える。
//
//   node scripts/llm/probe.mjs [回数]
//
// bot が実際に使う経路 (buildPrompt → generate → firstTurn) をそのまま通すので、
// 「記号だけ」「短すぎる」がどれだけ出るかを本番の設定で測れる。
// 記号の禁止を入れる前は 38% が使えなかった。入れてからの実測をここで確認する。

import { generate, mimicConfig, status } from '../../src/mimic/client.js';
import { ROLE_TOKENS, buildPrompt, firstTurn, messageText } from '../../src/mimic/serialize.js';

const times = Number(process.argv[2] ?? 12);

const CASES = [
  [['これバグってる？', 'これでいい']],
  [['Cloudflare Containers ってどうなん']],
  [['rebase 疲れた', 'わかる']]
];

const health = await status();
if (!health.up) {
  console.error(`推論サーバーが起動していません (${mimicConfig.url})`);
  process.exit(1);
}
console.log(`${mimicConfig.url} / epoch ${health.epoch} / val ${health.val_loss?.toFixed(4)}\n`);

let usable = 0;
let total = 0;

for (const [messages] of CASES) {
  // 交互に喋っている2人として渡す。bot は3人目として答える
  const turns = messages.map((content, i) => ({
    token: ROLE_TOKENS[i % 2], reply: false, content: messageText(content)
  }));
  const prompt = buildPrompt(turns, ROLE_TOKENS[2]);

  console.log(`--- ${messages.join(' / ')}`);
  for (let i = 0; i < times; i += 1) {
    const result = await generate({ prompt, maxNewTokens: 40 });
    const body = firstTurn(String(result.text ?? '').slice(prompt.length));

    total += 1;
    // 3文字未満は bot 側で引き直す対象。ここでは素の1回ぶんを見る
    const ok = body.length >= 3;
    if (ok) usable += 1;
    console.log(`  ${ok ? ' ' : '×'} ${JSON.stringify(body)}`);
  }
}

console.log(`\n1回で使えた: ${usable}/${total} (${((usable / total) * 100).toFixed(0)}%)`);
console.log('× は bot 側で最大3回まで引き直す');
