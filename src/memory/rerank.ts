import { askProbabilities, loadEmotionJevConfig, type EmotionJevConfig, type Questions } from '../emotion-jev.js';

// 想起の「関連の門」と再順位づけ。判定モデル (jev, OpenRouter の Decisions API) に、1 回の呼び出しで
//   gate  依頼そのものが、このコミュニティの具体的な人・出来事・もの・過去の話に触れているか (記憶が要るか)
//   q0…   候補の記憶ごとに、依頼が その記憶の具体的な話を指しているか
// を聞き、はい の確率で選ぶ。埋め込みのコサインは 0.80〜0.91 の狭い帯に集まって関係の有無を選り分けられないので、
// 閾値で切れるスコアはここで作る (v1 のデータ 300 問・40 の無関係な質問で測った。docs/memory-v2.md)。
//   gate 0.2 以上で、関係ある質問の 82% が通り、関係ない質問は 0% (全部止まる)
//   候補 0.6 以上で、関係ある質問の 91% に 1 件以上が残る (1 質問あたり約 3.8 件)。0.7 なら 89% / 2.5 件
// 費用は 1 回 $0.00003 ほど、0.5 秒。

export interface JudgeResult {
  /** 依頼が記憶を要する話か (0〜1)。判定できなければ null */
  gate: number | null;
  /** 候補ごとの関連 (0〜1)。判定できなければ null */
  scores: number[] | null;
}

const clip = (text: string, limit: number): string => ([...text].length > limit ? `${[...text].slice(0, limit).join('')}…` : text);

export function judgeQuestions(items: readonly string[]): Questions {
  const questions: Questions = {
    gate: {
      type: 'noul',
      instructions: 'この発言は、このコミュニティの具体的な人物・出来事・作ったもの・過去の話題・内輪のネタについて尋ねたり触れたりしているか。',
      criteria: {
        true: 'コミュニティの具体的な人・出来事・もの・過去の話に触れている。',
        false: '挨拶・雑談・一般的な知識の質問・独り言で、コミュニティの具体的な話には触れていない。'
      }
    }
  };
  items.forEach((item, index) => {
    questions[`q${index}`] = {
      type: 'noul',
      instructions: `この依頼は、次の記憶に書かれている具体的な人物・出来事・もの・話題について尋ねたり、触れたりしているか。記憶: 「${clip(item, 180)}」`,
      criteria: {
        true: '依頼は、その記憶に書かれている具体的な人物・出来事・もの・話題を指している。',
        false: '依頼は、その記憶の具体的な人物・出来事・もの・話題を指していない (一般的な話・挨拶・別の話題)。'
      }
    };
  });
  return questions;
}

export type Judge = (request: string, items: readonly string[]) => Promise<JudgeResult>;

/** 実際に jev へ聞く。失敗 (混んだ・落ちた・時間切れ) は { gate: null, scores: null }。 */
export function jevJudge({ timeoutMs = 3500, config }: { timeoutMs?: number; config?: EmotionJevConfig } = {}): Judge {
  return async (request, items) => {
    try {
      const base = config ?? loadEmotionJevConfig();
      const answers = await askProbabilities(request, judgeQuestions(items), { config: { ...base, timeoutMs } });
      const byId = new Map(answers.map((answer) => [answer.label, answer.score]));
      const scores = items.map((_, index) => byId.get(`q${index}`));
      if (scores.some((score) => typeof score !== 'number')) return { gate: byId.get('gate') ?? null, scores: null };
      return { gate: byId.get('gate') ?? null, scores: scores as number[] };
    } catch {
      return { gate: null, scores: null };
    }
  };
}
