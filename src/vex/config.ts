// vex (会話に自分から入る・名前で呼ばれたら動く) の設定。すべて環境変数で、既定はオフ。
//
// 判定は OpenRouter の Decisions API (判定モデル: 文章を作らず、はい/いいえの確率を1回で返す)。
// 費用は 100 万トークンあたり $0.01〜0.04 で、1回 約 $0.000003 (docs/vex.md)。
import { providerConfig } from '../ai/provider.js';

function number(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}
function list(value: string | undefined): string[] {
  return String(value ?? '').split(/[\s,]+/).filter(Boolean);
}

const origin = (() => {
  try { return new URL(providerConfig.baseUrl).origin; } catch { return 'https://openrouter.ai'; }
})();

export interface VexConfig {
  /** 発言にこの名前 (英字の単語として) が出たら、呼ばれたかもしれない強い手がかりとして判定に回す。 */
  names: string[];
  /** 名前が出た発言を判定に回す (確定では答えない。判定モデルが文脈で決める)。 */
  call: boolean;
  ambient: boolean;
  /** 自発参加してよいチャンネル。空なら自発参加はどこでもしない。 */
  channels: Set<string>;
  model: string;
  fallbacks: string[];
  endpoint: string;
  apiKey: string;
  /** 判定の確率がこれ以上なら入る。 */
  threshold: number;
  /** 名前が出た発言の閾値。名前は呼ばれている強い手がかりなので、自発参加より低い。 */
  nameThreshold: number;
  /** 名前が出てから判定するまでの待ち (ms)。続けて書かれる発言を拾うだけで、静かになるまでは待たない。 */
  nameDelayMs: number;
  /** 最後の発言からこれだけ静かになったら判定する (ms)。 */
  quietMs: number;
  /** 同じチャンネルで、入ったあとこれだけ空ける (ms)。 */
  cooldownMs: number;
  maxPerHour: number;
  contextMessages: number;
  timeoutMs: number;
  /** 判定 (Decisions API) の1日の費用の上限 (USD)。 */
  dailyDecisionUsd: number;
}

export function loadVexConfig(env: NodeJS.ProcessEnv = process.env): VexConfig {
  return {
    names: list(env.VEX_NAMES ?? 'vex').map((name) => name.toLowerCase()),
    call: flag(env.VEX_CALL, false),
    ambient: flag(env.VEX_AMBIENT, false),
    channels: new Set(list(env.VEX_CHANNELS)),
    model: env.VEX_MODEL ?? 'perplexity/pplx-decider-flash-v1.2',
    fallbacks: list(env.VEX_FALLBACK_MODELS ?? 'typesafe/jev-1.14,inception/mercury-decide:free'),
    endpoint: env.VEX_API_URL ?? `${origin}/api/alpha/decisions`,
    apiKey: providerConfig.apiKey,
    threshold: number(env.VEX_THRESHOLD, 0.6),
    nameThreshold: number(env.VEX_NAME_THRESHOLD, 0.45),
    nameDelayMs: number(env.VEX_NAME_DELAY_MS, 2000),
    quietMs: number(env.VEX_QUIET_MS, 90_000),
    cooldownMs: number(env.VEX_COOLDOWN_MS, 15 * 60_000),
    maxPerHour: number(env.VEX_MAX_PER_HOUR, 3),
    // 評価 (docs/vex.md) は直近 6 件で測った。増やすと費用が増える (6→20 件で約 1.5 倍) わりに、精度は測っていない
    contextMessages: Math.max(2, Math.min(50, number(env.VEX_CONTEXT_MESSAGES, 6))),
    timeoutMs: number(env.VEX_TIMEOUT_MS, 4000),
    dailyDecisionUsd: number(env.VEX_DAILY_USD, 0.05)
  };
}

export const vexConfig: VexConfig = loadVexConfig();
