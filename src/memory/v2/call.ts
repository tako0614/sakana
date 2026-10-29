import { createHash, randomUUID } from 'node:crypto';
import { ensureModelBudget } from '../../ai/cost.js';
import { requestModel, type MaxPrice, type ReasoningOptions } from '../../ai/provider.js';
import {
  StopRun, avoidProvider, avoidedProviders, forgetAvoidedProviders, parseModelJson, recordProvider, treeConfig
} from '../build.js';
import { memoryDb } from '../store.js';
import { detailsOf, errorMessage } from '../types.js';

// v2 のモデル呼び出し。工程ごとにモデル・推論・出力の長さを変えられ、結果を入力のハッシュで保存する。
//   - 止めて再開しても、同じ入力は払い直さない (v2_llm_cache)。検査 (check) を直したら、保存した出力にも新しい検査をかける
//   - 429・壊れた出力・暴れる provider の扱いは v1 の呼び出し (build.ts openRouterCaller) と同じ
//   - 予算は台帳 (ai_model_budgets) で止める。上限に当たったら StopRun

const list = (value: string | undefined, fallback: string): string[] => (value || fallback).split(',').map((item) => item.trim()).filter(Boolean);

export interface StageSpec {
  models: string[];
  reasoning?: ReasoningOptions;
  outputTokens: number;
  temperature: number;
  providerPrefs?: { quantizations?: readonly string[]; order?: readonly string[] };
  maxPrice?: MaxPrice | null;
}

const LOW: ReasoningOptions = { effort: 'low', exclude: true };
const MEDIUM: ReasoningOptions = { effort: 'medium', exclude: true };
const REASONING: Record<string, ReasoningOptions | undefined> = { low: LOW, medium: MEDIUM, high: { effort: 'high', exclude: true }, off: { enabled: false } };
const effort = (name: string | undefined, fallback: ReasoningOptions): ReasoningOptions | undefined => (name ? REASONING[name] ?? fallback : fallback);

const DEEPSEEK = 'deepseek/deepseek-v4.1-flash-1017';
const deepseekPrefs = { quantizations: ['fp8'], order: ['DeepInfra'] } as const;

export const v2Config = {
  /** S1 抽出: 読むだけなので安いモデルで。思考は軽く */
  extract: {
    models: list(process.env.MEMORY_V2_EXTRACT_MODELS, 'z-ai/glm-5.3-flash,inclusionai/ling-3.0-flash'),
    reasoning: effort(process.env.MEMORY_V2_EXTRACT_REASONING, LOW),
    outputTokens: Number(process.env.MEMORY_V2_EXTRACT_TOKENS || 24000),
    temperature: 0.2,
    maxPrice: treeConfig.maxPrice
  } satisfies StageSpec,
  /** S2 検証: 抽出とは別のモデルが根拠に照らして判定する */
  verify: {
    models: list(process.env.MEMORY_V2_VERIFY_MODELS, DEEPSEEK),
    reasoning: effort(process.env.MEMORY_V2_VERIFY_REASONING, MEDIUM),
    outputTokens: Number(process.env.MEMORY_V2_VERIFY_TOKENS || 24000),
    temperature: 0,
    providerPrefs: deepseekPrefs
  } satisfies StageSpec,
  /** S4〜S6 組み立て: 検証済みの主張から文章にする */
  compose: {
    models: list(process.env.MEMORY_V2_COMPOSE_MODELS, DEEPSEEK),
    reasoning: effort(process.env.MEMORY_V2_COMPOSE_REASONING, LOW),
    outputTokens: Number(process.env.MEMORY_V2_COMPOSE_TOKENS || 24000),
    temperature: 0.2,
    providerPrefs: deepseekPrefs
  } satisfies StageSpec,
  /** S2 検証を回すか。費用の半分以上を占めるので、最低コストで行くときは MEMORY_V2_VERIFY=off (抽出の結果をそのまま使う。後から検証だけ足せる) */
  verifyEnabled: !['off', '0', 'false', 'no'].includes(String(process.env.MEMORY_V2_VERIFY ?? 'on').toLowerCase()),
  timeoutMs: Number(process.env.MEMORY_V2_TIMEOUT_MS || 420_000),
  /** 同時に投げる呼び出しの数 */
  concurrency: Math.max(1, Number(process.env.MEMORY_V2_CONCURRENCY || 16)),
  /** 構築全体の費用の上限 (USD) */
  budgetUsd: Number(process.env.MEMORY_V2_BUDGET_USD || 30)
};

export interface V2CallInput {
  stage: string;
  spec: StageSpec;
  system: string;
  user: string;
  /** 読めた JSON の検査 (落ちたら投げる)。保存した出力にもかける */
  check?: (json: unknown) => void;
}

export interface V2CallResult {
  json: unknown;
  model: string;
  provider: string | null;
  cost: number;
  cached: boolean;
}

export type V2Caller = (input: V2CallInput) => Promise<V2CallResult>;

export const budgetIdV2 = (guildId: string): string => `memory-v2:${guildId}:${v2Config.budgetUsd}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const hashOf = (...parts: readonly string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex');

/** 保存した出力から読む。検査に落ちたら捨てる (検査を直したあとの再実行で、古い出力を通さない)。 */
function fromCache(hash: string, check: V2CallInput['check']): V2CallResult | null {
  const row = memoryDb().prepare<[string], { output: string; model: string | null; provider: string | null; cost: number }>(
    'SELECT output, model, provider, cost FROM v2_llm_cache WHERE hash = ?').get(hash);
  if (!row) return null;
  try {
    const json: unknown = JSON.parse(row.output);
    check?.(json);
    return { json, model: row.model ?? '', provider: row.provider, cost: 0, cached: true };
  } catch {
    memoryDb().prepare('DELETE FROM v2_llm_cache WHERE hash = ?').run(hash);
    return null;
  }
}

function toCache(hash: string, stage: string, result: V2CallResult): void {
  memoryDb().prepare(`
    INSERT OR REPLACE INTO v2_llm_cache (hash, stage, model, provider, cost, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(hash, stage, result.model, result.provider, result.cost, JSON.stringify(result.json), Date.now());
}

/** 実際に OpenRouter へ投げる呼び出し。 */
export function openRouterCallerV2({ guildId, runId = randomUUID() }: { guildId: string; runId?: string }): V2Caller {
  const budgetId = budgetIdV2(guildId);
  ensureModelBudget({ id: budgetId, guildId, limitUsd: v2Config.budgetUsd });
  return async function call({ stage, spec, system, user, check }: V2CallInput): Promise<V2CallResult> {
    const hash = hashOf(stage, spec.models.join(','), JSON.stringify(spec.reasoning ?? null), system, user);
    const cached = fromCache(hash, check);
    if (cached) return cached;
    for (let transient = 0, swapped = 0, cleared = false; ; transient += 1) {
      let provider: string | null = null;
      const ignored = avoidedProviders();
      try {
        const [model = spec.models[0] as string, ...fallbackModels] = spec.models;
        const data = await requestModel({
          model, fallbackModels,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          maxOutputTokens: spec.outputTokens, timeoutMs: v2Config.timeoutMs,
          guildId, role: `memory-v2-${stage}`, runId, budgetId, temperature: spec.temperature, reasoning: spec.reasoning,
          jsonOnly: true, ignoreProviders: ignored, maxPrice: spec.maxPrice ?? null,
          ...(spec.providerPrefs ? { providerPrefs: spec.providerPrefs } : {})
        });
        provider = data.provider ?? null;
        const json = parseModelJson(data.choices[0].message.content);
        check?.(json);
        recordProvider(provider, false);
        const cost = typeof data.usage.cost === 'number' && Number.isFinite(data.usage.cost) ? data.usage.cost : 0;
        const result: V2CallResult = { json, model: data.model ?? model, provider, cost, cached: false };
        toCache(hash, stage, result);
        return result;
      } catch (error) {
        const details = detailsOf(error);
        const message = errorMessage(error);
        const blame = provider ?? (typeof details.provider === 'string' ? details.provider : null);
        const broken = details.code === 'BAD_OUTPUT' || /truncated/.test(message);
        if (broken && recordProvider(blame, true)) {
          avoidProvider(blame);
          console.warn(`memory-v2: ${blame} を 1 時間外す (壊れた出力が続いた: ${message})`);
        }
        if (broken && swapped < 2) { swapped += 1; continue; }
        if (broken) throw error;
        const status = typeof details.status === 'number' ? details.status : null;
        if (status === 404 && ignored.length > treeConfig.ignoreProviders.length && !cleared) {
          forgetAvoidedProviders();
          cleared = true;
          continue;
        }
        if (status !== null && [401, 402, 403].includes(status)) throw new StopRun(`OpenRouter HTTP ${status}`, 'auth');
        if (/BUDGET/.test(String(details.code ?? ''))) throw new StopRun(message, 'budget');
        const retryAt = typeof details.retryAt === 'number' && Number.isFinite(details.retryAt) ? details.retryAt : null;
        const wait = retryAt !== null ? retryAt - Date.now() : null;
        if (retryAt !== null && wait !== null && wait > treeConfig.maxWaitMs) {
          throw new StopRun(`上限 (再開 ${new Date(retryAt).toISOString()})`, 'quota');
        }
        if (!details.retryable || transient >= 5) throw error;
        await sleep(Math.max(wait ?? 0, 5000 * (transient + 1)));
      }
    }
  };
}

/** 出力が長さで切れた (区間を割って読み直すべき) エラーか。 */
export const isTruncated = (error: unknown): boolean => /truncated|length/i.test(errorMessage(error)) && !/BUDGET/.test(String(detailsOf(error).code ?? ''));
