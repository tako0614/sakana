// 判定モデル (OpenRouter の Decisions API) を呼ぶ。
//
// モデルを並べておき、混んだ (429)・落ちた (5xx)・時間切れのときは次のモデルへ回す。
// 一度失敗したモデルは、少しのあいだ飛ばす (混んでいるところへ毎回当たらない)。
import { vexConfig, type VexConfig } from './config.js';
import { VEX_QUESTIONS } from './questions.js';

export interface Decision {
  /** 「入る」の確率 (0〜1)。 */
  p: number;
  model: string;
  costUsd: number;
  latencyMs: number;
}

const SKIP_MS = 60_000;
const skipUntil = new Map<string, number>();

/** 検査用: 失敗の記憶を消す。 */
export function resetDecideState(): void {
  skipUntil.clear();
}

type Fetch = typeof fetch;

async function ask(model: string, state: string, config: VexConfig, fetchImpl: Fetch): Promise<Decision> {
  const started = Date.now();
  const response = await fetchImpl(config.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, state: { conversation: state }, questions: VEX_QUESTIONS }),
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) throw Object.assign(new Error(`Decisions API HTTP ${response.status}`), { status: response.status });
  const body: unknown = await response.json();
  const answers = typeof body === 'object' && body !== null ? (body as { answers?: { join?: { noul?: unknown } } }).answers : undefined;
  const p = answers?.join?.noul;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new Error('Decisions API returned no probability');
  const usage = typeof body === 'object' && body !== null ? (body as { usage?: { cost?: unknown } }).usage : undefined;
  const cost = Number(usage?.cost ?? 0);
  return { p, model, costUsd: Number.isFinite(cost) ? cost : 0, latencyMs: Date.now() - started };
}

/** 判定する。全部のモデルが失敗したら null (呼び出し側は入らない)。 */
export async function decide(state: string, { config = vexConfig, fetchImpl = fetch, now = Date.now }: { config?: VexConfig; fetchImpl?: Fetch; now?: () => number } = {}): Promise<Decision | null> {
  if (!config.apiKey) return null;
  const models = [config.model, ...config.fallbacks.filter((model) => model !== config.model)];
  for (const model of models) {
    if ((skipUntil.get(model) ?? 0) > now()) continue;
    try {
      return await ask(model, state, config, fetchImpl);
    } catch (error) {
      skipUntil.set(model, now() + SKIP_MS);
      console.warn(`vex: ${model} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}
