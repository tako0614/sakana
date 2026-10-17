// 会話 agent のモデル。/model で人ごとに選ぶ (自作の evex 系とは別の、道具を持つエージェント)。
//
// 2026-10-15 に DeepSeek v4 flash を外し、OpenRouter の安いモデル3つにした。
// 既定は ling (いちばん安い)。glm は日付・固有名に強く (記憶の比較で最良)、qwen はその間。
export const AGENT_ENGINES = {
  ling: process.env.AGENT_MODEL_LING || 'inclusionai/ling-3.0-flash',
  glm: process.env.AGENT_MODEL_GLM || 'z-ai/glm-5.3-flash',
  qwen: process.env.AGENT_MODEL_QWEN || 'qwen/qwen3.7-flash'
};

export type AgentEngine = keyof typeof AGENT_ENGINES;

export const DEFAULT_AGENT_ENGINE: AgentEngine = 'ling';

export const isAgentEngine = (engine: unknown): engine is AgentEngine => (
  typeof engine === 'string' && Object.hasOwn(AGENT_ENGINES, engine)
);

export const agentModelFor = (engine: unknown): string => (
  isAgentEngine(engine) ? AGENT_ENGINES[engine] : AGENT_ENGINES[DEFAULT_AGENT_ENGINE]
);

/**
 * 選んだモデルが混んでいる (429) ときに回す先。安い順で、選んだものは除く。
 * ling は provider が Novita と DeepInfra の2つだけで、同時に断られると会話が止まる。
 * 429 だけに使う (llm.ts)。障害のたびに3つ引くと、1回 180 秒の待ちが3倍になる。
 */
export const agentFallbackModels = (model: string): string[] =>
  [...new Set(Object.values(AGENT_ENGINES))].filter((candidate) => candidate !== model);
