// 会話 agent のモデル。/model で人ごとに選ぶ (自作の evex 系とは別の、道具を持つエージェント)。
//
// 2026-10-15 に DeepSeek v4 flash を外し、OpenRouter の安いモデル3つにした。
// 既定は glm (2026-10-17 に ling から変更: 日本語と、検索してから答える道具の使い方が安定している。
// 日付・固有名にも強く、記憶の比較で最良)。ling はいちばん安い。
// 同じ日に、偽の検索ツールで10モデルに同じ3問を出して比べた (道具を先に使うか・日本語・いじりの面白さ・捏造):
// qwen は 3.7 が別人の話をして作り話もしたので 3.8 に、luna・deepseek・mimo を足した。
export const AGENT_ENGINES = {
  ling: process.env.AGENT_MODEL_LING || 'inclusionai/ling-3.0-flash',
  glm: process.env.AGENT_MODEL_GLM || 'z-ai/glm-5.3-flash',
  qwen: process.env.AGENT_MODEL_QWEN || 'qwen/qwen3.8-flash',
  luna: process.env.AGENT_MODEL_LUNA || 'openai/gpt-6-luna',
  deepseek: process.env.AGENT_MODEL_DEEPSEEK || 'deepseek/deepseek-v4.1-flash-1017',
  mimo: process.env.AGENT_MODEL_MIMO || 'xiaomi/mimo-v2.6-flash'
};

export type AgentEngine = keyof typeof AGENT_ENGINES;

export const DEFAULT_AGENT_ENGINE: AgentEngine = 'glm';

export const isAgentEngine = (engine: unknown): engine is AgentEngine => (
  typeof engine === 'string' && Object.hasOwn(AGENT_ENGINES, engine)
);

export const agentModelFor = (engine: unknown): string => (
  isAgentEngine(engine) ? AGENT_ENGINES[engine] : AGENT_ENGINES[DEFAULT_AGENT_ENGINE]
);

// 混んだときの回し先の優先順 (出来が良くて安いもの)。luna・deepseek は価格が一段上なので入れない。
const FALLBACK_ORDER: readonly AgentEngine[] = ['glm', 'mimo', 'qwen', 'ling'];

/**
 * 選んだモデルが混んでいる (429) ときに回す先。優先順で、選んだものは除いて2つまで。
 * ling は provider が Novita と DeepInfra の2つだけで、同時に断られると会話が止まる。
 * 429 だけに使う (llm.ts)。障害のたびに回すと、1回 180 秒の待ちが何倍にもなる。
 */
export const agentFallbackModels = (model: string): string[] =>
  [...new Set(FALLBACK_ORDER.map((engine) => AGENT_ENGINES[engine]))].filter((candidate) => candidate !== model).slice(0, 2);
