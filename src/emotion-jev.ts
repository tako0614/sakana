// 「きもち」の感情分析。判定モデル (jev, OpenRouter の Decisions API) に、8 つの感情それぞれについて
// 「書き手はいま感じているか」を聞き、はい の確率をそのまま強さにする。
//
// 以前は Python の DeBERTa (WRIME) を毎回起動していた (モデルの読み込みに数十秒〜、約 1GB、torch が要る)。
// 判定モデルは 1 回 0.5 秒・約 $0.000005 で、「夜道怖すぎて動けない」を 恐れ 0.98 と読む (DeBERTa は悲しみ 0.51 を 1 位にしていた)。
// 感情の無い発言 (「おはよう」「LINEJSって何？」) は全部低い値になるので、neutral として「落ち着いている」と出す。
import type { EmotionResult } from './emotion-image.js';

/** 感情の ID → [日本語名, 「書き手が〜」の説明]。順序は画像の表と同じ (Plutchik の 8 感情)。 */
export const EMOTIONS: Record<string, readonly [string, string]> = {
  joy: ['喜び', '喜び・楽しさ・嬉しさ・満足を感じている'],
  sadness: ['悲しみ', '悲しみ・落ち込み・寂しさ・つらさを感じている'],
  anticipation: ['期待', '期待・楽しみ・わくわく・これからへの意欲を感じている'],
  surprise: ['驚き', '驚き・意外・びっくりを感じている'],
  anger: ['怒り', '怒り・苛立ち・不満・憤りを感じている'],
  fear: ['恐れ', '恐れ・不安・心配・怖さを感じている'],
  disgust: ['嫌悪', '嫌悪・うんざり・気持ち悪さ・軽蔑を感じている'],
  trust: ['信頼', '信頼・感謝・安心・親しみ・敬意を感じている']
};

export const EMOTION_QUESTIONS = Object.fromEntries(Object.entries(EMOTIONS).map(([id, [ja, description]]) => [id, {
  type: 'noul' as const,
  instructions: `この発言の書き手は、いま「${ja}」を感じているか。`,
  criteria: { true: `書き手が${description}。`, false: `書き手は${ja}を感じていない。` }
}]));

export interface EmotionJevConfig {
  endpoint: string;
  apiKey: string;
  /** 前から順に試す。混んだ (429)・落ちた (5xx)・時間切れのときは次へ。 */
  models: string[];
  timeoutMs: number;
  /** 8 感情のどれもこれ未満なら、感情の無い発言 (neutral) として扱う。 */
  neutralBelow: number;
}

const ORIGIN = 'https://openrouter.ai';

export function loadEmotionJevConfig(env: NodeJS.ProcessEnv = process.env): EmotionJevConfig {
  const number = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const list = (value: string | undefined, fallback: string): string[] => (value ?? fallback).split(/[\s,]+/).filter(Boolean);
  return {
    endpoint: env.EMOTION_API_URL ?? `${ORIGIN}/api/alpha/decisions`,
    apiKey: env.OPENROUTER_API_KEY ?? '',
    models: list(env.EMOTION_MODELS, 'typesafe/jev-1.14,perplexity/pplx-decider-flash-v1.2'),
    timeoutMs: number(env.EMOTION_TIMEOUT_MS, 8000),
    neutralBelow: number(env.EMOTION_NEUTRAL_BELOW, 0.4)
  };
}

const MAX_CHARS = 1000;
const SKIP_MS = 60_000;
const skipUntil = new Map<string, number>();

/** 検査用: 失敗の記憶を消す。 */
export function resetEmotionJevState(): void {
  skipUntil.clear();
}

type Fetch = typeof fetch;

type Questions = Record<string, { type: 'noul'; instructions: string; criteria: { true: string; false: string } }>;

function readProbabilities(body: unknown, ids: readonly string[]): { label: string; score: number }[] {
  const answers = typeof body === 'object' && body !== null ? (body as { answers?: Record<string, { noul?: unknown } | undefined> }).answers : undefined;
  return ids.map((label) => {
    const score = answers?.[label]?.noul;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) throw new Error(`Decisions API returned no probability for ${label}`);
    return { label, score: Math.round(score * 10_000) / 10_000 };
  });
}

/**
 * 発言について、はい/いいえの質問をまとめて 1 回で聞き、質問の ID ごとの「はい」の確率を返す (きもち・よっきゅう共通)。
 * 混んだ・落ちたモデルは次へ回し、一度失敗したモデルは少しのあいだ飛ばす。全部失敗したら投げる。
 */
export async function askProbabilities(text: string, questions: Questions, { config = loadEmotionJevConfig(), fetchImpl = fetch, now = Date.now }: { config?: EmotionJevConfig; fetchImpl?: Fetch; now?: () => number } = {}): Promise<{ label: string; score: number }[]> {
  if (!config.apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
  let lastError: unknown = new Error('no emotion model is available');
  for (const model of config.models) {
    if ((skipUntil.get(model) ?? 0) > now()) continue;
    try {
      const response = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state: { text: text.slice(0, MAX_CHARS) }, questions }),
        signal: AbortSignal.timeout(config.timeoutMs)
      });
      if (!response.ok) throw Object.assign(new Error(`Decisions API HTTP ${response.status}`), { status: response.status });
      return readProbabilities(await response.json(), Object.keys(questions));
    } catch (error) {
      lastError = error;
      skipUntil.set(model, now() + SKIP_MS);
      console.warn(`emotion: ${model} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 発言の感情を読む。全部のモデルが失敗したら投げる。 */
export async function analyzeEmotion(text: string, options: { config?: EmotionJevConfig; fetchImpl?: Fetch; now?: () => number } = {}): Promise<EmotionResult> {
  const config = options.config ?? loadEmotionJevConfig();
  const emotions = await askProbabilities(text, EMOTION_QUESTIONS, { ...options, config });
  const neutral = Math.max(...emotions.map((emotion) => emotion.score)) < config.neutralBelow;
  return { emotions, ...(neutral ? { neutral: true } : {}) };
}
