// リクエスト全体の締め切りの検証 (npm run check から呼ぶ)。
//
// 大事なのは「時間切れで畳まない」こと。例外で落とすと、9往復ぶん払ったのに
// 謝り文だけが出る (以前そうなっていた)。予算切れと同じ経路 — ツールを外して
// もう1往復させる — に寄せてあることを固定する。
//
// DeepSeek は呼ばずに fetch を差し替える。

import { runAgent } from '../src/agent/llm.js';

const fail = (message) => { throw new Error(message); };

const toolset = {
  definitions: [{
    type: 'function',
    function: { name: 'search', parameters: { type: 'object', properties: {} } }
  }],
  call: async () => '結果'
};

let calls = [];
let failing = false;

// ツールを渡された最初の往復だけツールを呼び、あとは文章を返す偽の API。
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  calls.push(body);

  if (failing) {
    return { ok: false, status: 500, text: async () => 'boom' };
  }

  const wantsTool = Array.isArray(body.tools) && body.tools.length > 0 && calls.length === 1;

  return {
    ok: true,
    json: async () => ({
      choices: [{
        message: wantsTool
          ? { content: '', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{}' } }] }
          : { content: '手元の材料で書いた答え' }
      }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 0 }
    })
  };
};

const run = (over = {}) => {
  calls = [];
  return runAgent({ system: 's', userContent: 'u', toolset, ...over });
};

// --- 締め切り前は今までどおり ---
{
  const result = await run({ deadlineAt: Date.now() + 60_000 });
  if (!calls[0].tools) fail('締め切り前はツールを渡す');
  if (result.used.length !== 1) fail(`ツールが呼ばれていない: ${result.used.length}`);
  if (calls.length !== 2) fail(`ツール1回なら2往復: ${calls.length}`);
}

// --- 締め切り後はツールを外して、必ず答えを書かせる ---
{
  const result = await run({ deadlineAt: Date.now() - 1 });
  if (calls.length !== 1) fail(`時間切れなら1往復で締める: ${calls.length}`);
  if (calls[0].tools) fail('時間切れでツールを渡している');
  if (result.text !== '手元の材料で書いた答え') fail(`時間切れでも答えを書かせる: ${JSON.stringify(result.text)}`);
  if (result.usage.prompt_tokens !== 100) fail('使ったぶんが記録に残っていない');
}

// --- 予算切れの経路は壊していない ---
{
  const result = await run({ budget: 1, weigh: () => 1000 });
  if (calls[0].tools) fail('予算切れでツールを渡している');
  if (result.text !== '手元の材料で書いた答え') fail('予算切れでも答えを書かせる');
}

// --- 締め切り後は引き直さない ---
//
// 1回の呼び出しが最大 180 秒 なので、3回引き直すと締め切りが実質3倍になる。
{
  failing = true;
  try {
    let threw = false;
    try {
      await run({ deadlineAt: Date.now() - 1 });
    } catch {
      threw = true;
    }
    if (!threw) fail('落ち続けるなら例外を投げる');
    if (calls.length !== 1) fail(`締め切り後は引き直さない: ${calls.length} 回引いている`);

    // 締め切り前なら今までどおり3回まで引く
    threw = false;
    try {
      await run({ deadlineAt: Date.now() + 60_000 });
    } catch {
      threw = true;
    }
    if (!threw) fail('3回引いても駄目なら例外');
    if (calls.length !== 3) fail(`締め切り前は3回引く: ${calls.length}`);
  } finally {
    failing = false;
  }
}

console.log('deadline ok (時間切れは打ち切りではなく軟着陸 / 過ぎたら引き直さない)');
