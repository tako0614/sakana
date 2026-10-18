// 会話 agent のモデル。/model で人ごとに選ぶ (自作の evex 系とは別の、道具を持つエージェント)。
//
// 2026-10-15 に DeepSeek v4 flash を外し、OpenRouter の安いモデル3つにした。
// 既定は deepseek (2026-10-18 に glm から変更)。本番の実行記録 13 件の材料を固定して返事を作り直し、
// 別系統のモデルに伏せて順位をつけさせた (1 位 15 / 26 回、順位 0.21。glm は 0.42〜0.61)。
// 費用は 1 回 $0.0003 (glm は $0.0005)、速さは 3.6 秒 (glm は 10〜12 秒)。fp8 の provider (DeepInfra) に回す。
// glm の 81% が回っていた OpenInference (fp4) は、考えても調べに行く率が上がらず、普通の v4.1-flash は
// そこに回ると 1 往復 30 秒を超えた。glm (2026-10-17 に ling から変更: 日本語と道具の使い方が安定、
// 日付・固有名にも強い) と ling (いちばん安い) は /model で選べる。
// 同じ日に、偽の検索ツールで10モデルに同じ3問を出して比べた (道具を先に使うか・日本語・いじりの面白さ・捏造):
// qwen は 3.7 が別人の話をして作り話もしたので 3.8 に、deepseek・mimo を足した。
// luna (openai/gpt-6-luna) は足したが、思考が暗号化されて読めず、いじりも控えめなので同じ日に廃止した。
export const AGENT_ENGINES = {
  ling: process.env.AGENT_MODEL_LING || 'inclusionai/ling-3.0-flash',
  glm: process.env.AGENT_MODEL_GLM || 'z-ai/glm-5.3-flash',
  qwen: process.env.AGENT_MODEL_QWEN || 'qwen/qwen3.8-flash',
  deepseek: process.env.AGENT_MODEL_DEEPSEEK || 'deepseek/deepseek-v4.1-flash-1017',
  mimo: process.env.AGENT_MODEL_MIMO || 'xiaomi/mimo-v2.6-flash'
};

export type AgentEngine = keyof typeof AGENT_ENGINES;

export const DEFAULT_AGENT_ENGINE: AgentEngine = 'deepseek';

export const isAgentEngine = (engine: unknown): engine is AgentEngine => (
  typeof engine === 'string' && Object.hasOwn(AGENT_ENGINES, engine)
);

export const agentModelFor = (engine: unknown): string => (
  isAgentEngine(engine) ? AGENT_ENGINES[engine] : AGENT_ENGINES[DEFAULT_AGENT_ENGINE]
);

/**
 * モデルごとの provider の指定。OpenRouter の「安い順」は fp4 の provider (OpenInference など) を先に選ぶので、
 * deepseek は fp8 に絞る (`AGENT_DEEPSEEK_QUANTIZATIONS=` と空にすると絞らない。複数ならカンマ区切り)。
 * 選んだモデル本体の回し先だけに掛け、混んだときの回し先 (別のモデル) には掛けない。
 */
export function agentProviderPrefs(model: string): { quantizations?: string[] } {
  if (model !== AGENT_ENGINES.deepseek) return {};
  const quantizations = (process.env.AGENT_DEEPSEEK_QUANTIZATIONS ?? 'fp8').split(',').map((value) => value.trim()).filter(Boolean);
  return quantizations.length ? { quantizations } : {};
}

// 混んだときの回し先の優先順 (出来が良くて安いもの)。deepseek は価格が一段上なので入れない。
const FALLBACK_ORDER: readonly AgentEngine[] = ['glm', 'mimo', 'qwen', 'ling'];

/**
 * 選んだモデルが混んでいる (429) ときに回す先。優先順で、選んだものは除いて2つまで。
 * ling は provider が Novita と DeepInfra の2つだけで、同時に断られると会話が止まる。
 * 429 だけに使う (llm.ts)。障害のたびに回すと、1回 180 秒の待ちが何倍にもなる。
 */
export const agentFallbackModels = (model: string): string[] =>
  [...new Set(FALLBACK_ORDER.map((engine) => AGENT_ENGINES[engine]))].filter((candidate) => candidate !== model).slice(0, 2);
