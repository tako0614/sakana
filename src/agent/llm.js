import { agentConfig } from './config.js';
import { requestModel } from '../ai/provider.js';
import { runAgent as executeAgent } from '../ai/runtime.js';
export { runAgent as runAgentRuntime } from '../ai/runtime.js';
export function runAgent(options) {
  return executeAgent({ ...options, modelIdentity: `openrouter:${agentConfig.model}`, request: ({ messages, tools, effort, deadlineAt, guildId, runId, final }) => requestModel({
    model: agentConfig.model, messages, tools, guildId, runId, role: 'chat', deadlineAt: final ? Infinity : deadlineAt,
    timeoutMs: agentConfig.httpTimeoutMs, maxOutputTokens: agentConfig.maxOutputTokens, retries: final ? 0 : 2,
    reasoning: agentConfig.thinking ? { effort: effort ?? agentConfig.reasoningEffort } : { enabled: false },
  }) });
}
