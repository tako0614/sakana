// DeepSeek (OpenAI 互換の ChatCompletions) を叩いて、ツール呼び出しループを回す。
//
// トークンの効き方:
//   ツールを1回呼ぶたびに会話全体を再送するので、往復回数がそのまま費用になる。
//   だから maxRounds で往復を、maxToolChars でツール出力の総量を縛る。
//   system → tools → messages の順序と中身を実行ごとに変えないでおくと、
//   DeepSeek 側のコンテキストキャッシュに乗って入力ぶんが安くなる。

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

async function requestOnce({ messages, tools, dropThinking, effort, signal }) {
  const response = await fetch(`${agentConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${agentConfig.apiKey}`
    },
    body: JSON.stringify(buildBody({ messages, tools, dropThinking, effort })),
    signal
  });

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

async function callModel({ messages, tools, signal, effort }) {
  let dropThinking = false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestOnce({ messages, tools, dropThinking, effort, signal });
    } catch (error) {
      if (error.name === 'AbortError') throw error;

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

      if (error instanceof DeepSeekError && error.retryable && attempt < 2) {
        await sleep(800 * (attempt + 1));
        continue;
      }

      throw error;
    }
  }

  throw new DeepSeekError('DeepSeek API に接続できませんでした。');
}

function parseArguments(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * ツールループ本体。最終的なテキストと、使ったトークンを返す。
 */
export async function runAgent({ system, userContent, toolset, onToolCall, signal, usage }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userContent }
  ];

  // usage は呼び出し側から受け取って積む。中断や例外でここを抜けても、
  // 使ったぶんが呼び出し側に残っている必要がある (使用量の記録に要る)。
  const totals = usage ?? { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 };
  const used = [];
  let rounds = 0;

  const accumulate = (data) => {
    if (!data?.usage) return;
    totals.prompt_tokens += data.usage.prompt_tokens ?? 0;
    totals.completion_tokens += data.usage.completion_tokens ?? 0;
    totals.prompt_cache_hit_tokens += data.usage.prompt_cache_hit_tokens ?? 0;
  };

  const isBlank = (choice) => {
    const message = choice?.message;
    if (!message) return false;
    return (message.tool_calls ?? []).length === 0 && !String(message.content ?? '').trim();
  };

  for (; rounds < agentConfig.maxRounds; rounds += 1) {
    // 最後の1往復はツールを外して必ず文章で締めさせる。
    // ただし maxRounds=1 のときにツールを一度も出さないのは行き過ぎなので除く。
    const isLastRound = agentConfig.maxRounds > 1 && rounds === agentConfig.maxRounds - 1;
    const tools = isLastRound ? null : toolset.definitions;

    let data = await callModel({ messages, tools, signal });
    accumulate(data);

    // max_tokens には思考ぶんが含まれるので、思考で使い切ると本文が空で返る。
    // effort を落として1回だけ引き直す (謝るより先に必ず1回書かせる)。
    if (isBlank(data.choices?.[0])) {
      console.warn(
        `DeepSeek returned an empty answer (finish_reason=${data.choices?.[0]?.finish_reason}). Retrying with low effort.`
      );
      data = await callModel({ messages, tools, signal, effort: 'low' });
      accumulate(data);
    }

    const choice = data.choices?.[0];
    const message = choice?.message;

    if (!message) {
      throw new DeepSeekError('DeepSeek から応答がありませんでした。');
    }

    const toolCalls = message.tool_calls ?? [];

    // reasoning_content は送り返すと 400 になるので載せない。
    const assistantMessage = { role: 'assistant', content: message.content ?? '' };
    if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
    messages.push(assistantMessage);

    if (toolCalls.length === 0) {
      const text = message.content ?? '';
      if (text.trim()) return { text, rounds: rounds + 1, usage: totals, used };

      // 2回引いても空。ツールを外して「今ある情報で書け」と言い直す。
      const forced = await finalAnswer({ messages, signal });
      accumulate(forced.data);
      return { text: forced.text, rounds: rounds + 2, usage: totals, used };
    }

    for (const toolCall of toolCalls) {
      const name = toolCall.function?.name ?? '';
      const args = parseArguments(toolCall.function?.arguments);

      let result;
      if (args === null) {
        result = '引数の JSON が壊れています。正しい JSON で呼び直してください。';
      } else {
        used.push({ name, args });
        onToolCall?.(name, args);
        result = await toolset.call(name, args);
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result || '(結果なし)'
      });
    }
  }

  // 往復を使い切った。ここで空文字を返すと謝り文だけが出るので、必ず1回書かせる。
  const forced = await finalAnswer({ messages, signal });
  accumulate(forced.data);

  return { text: forced.text, rounds: rounds + 1, usage: totals, used };
}

/**
 * ツールを外して、今ある材料だけで答えを書かせる最後の1往復。
 *
 * 空の本文をそのまま返すと「うまく答えをまとめられませんでした」になる。
 * 材料は既に会話に載っているので、書かせないまま諦めるのがいちばん惜しい。
 */
async function finalAnswer({ messages, signal }) {
  const closing = [
    ...messages,
    {
      role: 'user',
      content: 'ここまでで取得できた材料だけで、いま答えを書いて。'
        + '足りない部分は「分からない」と書けばよく、道具を呼び直す必要はない。'
    }
  ];

  try {
    const data = await callModel({ messages: closing, tools: null, signal, effort: 'low' });
    return { text: data.choices?.[0]?.message?.content ?? '', data };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    console.error('Final answer attempt failed:', error);
    return { text: '', data: null };
  }
}
