import { requestModel } from '../ai/provider.js';
import { runAgent as runRuntime, type AgentRequest, type AgentResult, type RunAgentOptions } from '../ai/runtime.js';
import { agentConfig } from './config.js';
import { agentFallbackModels, agentProviderPrefs } from './engines.js';
export { runAgent as runAgentRuntime } from '../ai/runtime.js';

/** 会話 agent の実行に渡すもの。request は OpenRouter に固定するので呼び出し側は渡さない。 */
export type AgentRunOptions = Omit<RunAgentOptions, 'request' | 'modelIdentity'> & { model?: string };

export function runAgent({ model = agentConfig.model, ...options }: AgentRunOptions): Promise<AgentResult> {
  return runRuntime({ ...options, modelIdentity: `openrouter:${model}`, request: ({ messages, tools, effort, deadlineAt, guildId, runId, final, beforeSend, consumeRequest }: AgentRequest) => requestModel({
    model, fallbackModels: agentFallbackModels(model), fallbackStatuses: [429], providerPrefs: agentProviderPrefs(model), messages, tools, guildId, runId, beforeSend, consumeRequest, role: 'chat', deadlineAt: final ? Infinity : deadlineAt,
    timeoutMs: agentConfig.httpTimeoutMs, maxOutputTokens: agentConfig.maxOutputTokens, retries: final ? 0 : 2,
    reasoning: agentConfig.thinking ? { effort: effort ?? agentConfig.reasoningEffort } : { enabled: false },
  }) });
}
