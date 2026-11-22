import { requestModel } from '../ai/provider.js';
import { runAgent as runRuntime, type AgentRequest, type AgentResult, type RunAgentOptions } from '../ai/runtime.js';
import { agentConfig } from './config.js';
import { agentFallbackModels, agentProviderPrefs } from './engines.js';
export { runAgent as runAgentRuntime } from '../ai/runtime.js';

/** 会話 agent の実行に渡すもの。request は OpenRouter に固定するので呼び出し側は渡さない。 */
export type AgentRunOptions = Omit<RunAgentOptions, 'request' | 'modelIdentity'> & {
  model?: string;
  onModelElapsed?: (elapsedMs: number) => void;
};

export function runAgent({ model = agentConfig.model, onModelElapsed, ...options }: AgentRunOptions): Promise<AgentResult> {
  const request = async ({ messages, tools, effort, deadlineAt, guildId, runId, final, beforeSend, consumeRequest }: AgentRequest) => {
    const start = performance.now();
    try {
      return await requestModel({
        model, fallbackModels: agentFallbackModels(model), fallbackStatuses: [429], providerPrefs: agentProviderPrefs(model), messages, tools, guildId, runId, beforeSend, consumeRequest, role: 'chat', deadlineAt: final ? Infinity : deadlineAt,
        timeoutMs: agentConfig.httpTimeoutMs, maxOutputTokens: agentConfig.maxOutputTokens, retries: final ? 0 : 2,
        reasoning: agentConfig.thinking ? { effort: effort ?? agentConfig.reasoningEffort } : { enabled: false },
      });
    } finally {
      onModelElapsed?.(performance.now() - start);
    }
  };
  return runRuntime({ ...options, modelIdentity: `openrouter:${model}`, request });
}
