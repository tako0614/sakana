// 「よっきゅう」: 発言の書き手の三大欲求 (食欲・睡眠欲・性欲) を、判定モデル (jev) に 3 問まとめて聞いて読む。
// きもち (emotion-jev.ts) と同じ聞き方で、質問が違うだけ。「はい」の確率がそのままゲージの長さになる。
import { askProbabilities, loadEmotionJevConfig, type EmotionJevConfig } from './emotion-jev.js';
import type { DesireResult } from './emotion-image.js';

/** 欲求の ID → [日本語名, 「書き手が〜」の説明]。順序は画像のゲージの順。 */
export const DESIRES: Record<string, readonly [string, string]> = {
  hunger: ['食欲', '空腹・何か食べたい・飲みたい・食べ物や飲み物を強く求めている'],
  sleep: ['睡眠欲', '眠い・疲れた・寝たい・休みたい・だるいと感じている'],
  sex: ['性欲', '性的な欲求・ムラムラ・色っぽい気分・性的なことへの強い関心がある']
};

export const DESIRE_QUESTIONS = Object.fromEntries(Object.entries(DESIRES).map(([id, [ja, description]]) => [id, {
  type: 'noul' as const,
  instructions: `この発言の書き手は、いま「${ja}」を感じているか。`,
  criteria: { true: `書き手が${description}。`, false: `書き手は${ja}を感じていない。` }
}]));

/** 発言の三大欲求を読む。どれも neutralBelow 未満なら neutral (欲求の無い発言)。全部のモデルが失敗したら投げる。 */
export async function analyzeDesire(text: string, options: { config?: EmotionJevConfig; fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<DesireResult> {
  const config = options.config ?? loadEmotionJevConfig();
  const desires = await askProbabilities(text, DESIRE_QUESTIONS, { ...options, config });
  const neutral = Math.max(...desires.map((desire) => desire.score)) < config.neutralBelow;
  return { desires, ...(neutral ? { neutral: true } : {}) };
}
