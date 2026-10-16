import { agentConfig } from './config.js';
import { model as transport, type RuntimeOptions, type RuntimeRequest, type RuntimeResult } from './boundary.js';
export { runAgent as runAgentRuntime } from '../ai/runtime.js';

/** 会話 agent の実行に渡すもの。request は OpenRouter に固定するので呼び出し側は渡さない。 */
export type AgentRunOptions = Omit<RuntimeOptions, 'request' | 'modelIdentity'> & { model?: string };

export function runAgent({ model = agentConfig.model, ...options }: AgentRunOptions): Promise<RuntimeResult> {
  return transport.runAgent({ ...options, modelIdentity: `openrouter:${model}`, request: ({ messages, tools, effort, deadlineAt, guildId, runId, final, beforeSend, consumeRequest }: RuntimeRequest) => transport.requestModel({
    model, messages, tools, guildId, runId, beforeSend, consumeRequest, role: 'chat', deadlineAt: final ? Infinity : deadlineAt,
    timeoutMs: agentConfig.httpTimeoutMs, maxOutputTokens: agentConfig.maxOutputTokens, retries: final ? 0 : 2,
    reasoning: agentConfig.thinking ? { effort: effort ?? agentConfig.reasoningEffort } : { enabled: false },
  }) });
}
