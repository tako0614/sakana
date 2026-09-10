// DeepSeek (OpenAI 互換の ChatCompletions) を叩いて、ツール呼び出しループを回す。
//
// トークンの効き方:
//   ツールを1回呼ぶたびに会話全体を再送するので、往復回数がそのまま費用になる。
//   縛るのはトークンだけ。予算を使い切ったらツールを外して締めさせる
//   (往復や文字数で縛ると、軽い往復と重い往復が同じ「1回」になって費用と合わない)。
//   キャッシュは前方一致なので、system は1文字も可変にしない (時刻を入れていた頃は
//   その後ろ 5.5KB がリクエストごとに新規扱いになっていた)。可変な文脈は
//   user メッセージ側に置く。system → tools → messages の順序も変えない。

import { agentConfig } from './config.js';

class DeepSeekError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildBody({ messages, tools, dropThinking, effort }) {
  const body = {
    model: agentConfig.model,
    messages,
    max_tokens: agentConfig.maxOutputTokens,
    stream: false
  };

  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  if (!dropThinking) {
    if (agentConfig.thinking) {
      body.thinking = { type: 'enabled' };
      // 公式が推奨するサンプリング (reasoning 有効時は 1.0 / 1.0)
      body.temperature = 1;
      body.top_p = 1;
    }
    const level = effort ?? agentConfig.reasoningEffort;
    if (level) {
      body.reasoning_effort = level;
    }
  }

  return body;
}

async function requestOnce({ messages, tools, dropThinking, effort }) {
  // タイムアウトは1回の呼び出しにだけ掛ける。リクエスト全体に時間の上限は無い
  // (止めるのはトークンだけ)。ここは応答が来ないソケットを畳むための保険。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), agentConfig.httpTimeoutMs);
  timer.unref?.();

  let response;
  try {
    response = await fetch(`${agentConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${agentConfig.apiKey}`
      },
      body: JSON.stringify(buildBody({ messages, tools, dropThinking, effort })),
      signal: controller.signal
    });
  } catch (error) {
    // 自分で畳んだぶんは失敗扱いにしない。引き直せば通ることが多い。
    if (error.name === 'AbortError') {
      throw new DeepSeekError(
        `DeepSeek への1回の呼び出しが ${Math.round(agentConfig.httpTimeoutMs / 1000)} 秒で応答しませんでした。`,
        { retryable: true }
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) {
    return response.json();
  }

  const text = await response.text().catch(() => '');
  const retryable = response.status === 429 || response.status >= 500;

  throw new DeepSeekError(
    `DeepSeek API error ${response.status}: ${text.slice(0, 500)}`,
    { status: response.status, retryable }
  );
}

async function callModel({ messages, tools, effort, deadlineAt = Infinity }) {
  let dropThinking = false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestOnce({ messages, tools, dropThinking, effort });
    } catch (error) {
      // thinking / reasoning_effort を受けつけないモデルに当たったら、
      // その2つを外して素の ChatCompletions として1回だけ試す。
      if (
        error instanceof DeepSeekError
        && error.status === 400
        && !dropThinking
        && /thinking|reasoning_effort/i.test(error.message)
      ) {
        console.warn('DeepSeek rejected thinking/reasoning_effort. Retrying without them.');
        dropThinking = true;
        continue;
      }

      // 締め切りを過ぎたら引き直さない。ここで粘ると deadline が実質3倍になる
      // (1回の呼び出しが最大 180 秒 なので、3回で9分)。
      if (error instanceof DeepSeekError && error.retryable && attempt < 2 && Date.now() < deadlineAt) {
        await sleep(800 * (attempt + 1));
        continue;
      }

      throw error;
    }
  }

  throw new DeepSeekError('DeepSeek API に接続できませんでした。');
}

// Provider adapter; execution, budgets and checkpoints have one owner.
export { runAgent as runAgentRuntime } from '../ai/runtime.js';
import { runAgent as executeAgent } from '../ai/runtime.js';
export function runAgent(options) {
  return executeAgent({ ...options, request: callModel });
}
