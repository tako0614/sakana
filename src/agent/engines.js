// 会話 agent のモデル。/model で人ごとに選ぶ (自作の evex 系とは別の、道具を持つエージェント)。
//
// 2026-10-15 に DeepSeek v4 flash を外し、OpenRouter の安いモデル3つにした。
// 既定は ling (いちばん安い)。glm は日付・固有名に強く (記憶の本の比較で最良)、qwen はその間。
export const AGENT_ENGINES = {
  ling: process.env.AGENT_MODEL_LING || 'inclusionai/ling-3.0-flash',
  glm: process.env.AGENT_MODEL_GLM || 'z-ai/glm-5.3-flash',
  qwen: process.env.AGENT_MODEL_QWEN || 'qwen/qwen3.7-flash'
};

export const DEFAULT_AGENT_ENGINE = 'ling';

export const isAgentEngine = (engine) => Object.hasOwn(AGENT_ENGINES, engine);

export const agentModelFor = (engine) => AGENT_ENGINES[engine] ?? AGENT_ENGINES[DEFAULT_AGENT_ENGINE];
