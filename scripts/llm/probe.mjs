// 動いている推論サーバーを叩いて、返答の質を数える。
//
//   node scripts/llm/probe.mjs [回数]
//
// bot が実際に使う経路 (buildPrompt → generate → ownTurns) をそのまま通すので、
// 「記号だけ」「短すぎる」がどれだけ出るかを本番の設定で測れる。
// 記号の禁止を入れる前は 38% が使えなかった。入れてからの実測をここで確認する。

import { generate, mimicConfig, roleScheme, status } from '../../src/mimic/client.js';
import { assignRoles, buildPrompt, messageText, nextRole, ownTurns } from '../../src/mimic/serialize.js';

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
const scheme = await roleScheme();
console.log(`${mimicConfig.url} / epoch ${health.epoch} / val ${health.val_loss?.toFixed(4)}`);
console.log(`役: ${scheme?.roles?.join(' ') ?? '(申告なし)'}\n`);

let usable = 0;
let total = 0;

for (const [messages] of CASES) {
  // 役はサーバーの申告に従う。ここを固定値にしていたので evex-1 に <|a|> を
  // 渡して出力を崩壊させた (probe だけ直し忘れて、直った後も壊れて見えた)。
  const roles = assignRoles(messages.map((_, i) => `u${i % 2}`), scheme);
  const turns = messages.map((content, i) => ({
    token: roles.get(`u${i % 2}`), reply: false, content: messageText(content)
  }));
  const trailing = nextRole(roles, scheme);
  const prompt = buildPrompt(turns, trailing);

  console.log(`--- ${messages.join(' / ')}`);
  for (let i = 0; i < times; i += 1) {
    const result = await generate({ prompt, maxNewTokens: 40 });
    const body = ownTurns(String(result.text ?? '').slice(prompt.length), trailing);

    total += 1;
    // 3文字未満は bot 側で引き直す対象。ここでは素の1回ぶんを見る
    const ok = body.length >= 3;
    if (ok) usable += 1;
    console.log(`  ${ok ? ' ' : '×'} ${JSON.stringify(body)}`);
  }
}

console.log(`\n1回で使えた: ${usable}/${total} (${((usable / total) * 100).toFixed(0)}%)`);
console.log('× は bot 側で最大3回まで引き直す');
