// 判定モデルに渡す state と質問。評価 (scripts/vex/eval.mjs・jev-api.mjs) と同じ形にしてある。
// 実際の会話 400 場面で、基準を criteria (はい/いいえの説明) に置く形が一番良かった (docs/vex.md)。
// 「vex・bot・AI が話題」のときも入る版 (scripts/vex/questions.mjs の about)。質問・頼みごとだけの版 (api) は雑談の流れで入れなかった。

export interface VexLine {
  author: string;
  bot: boolean;
  /** 決める時点から何分前の発言か。 */
  minutesAgo: number;
  text: string;
}

const MAX_CHARS = 140;

/**
 * 発言を判定用の1行の文にする。評価に使った場面 (scripts/vex/export-situations.mjs) と同じ順序で、
 * メンションを名前に直し、URL を <url> に、改行を ⏎ にして、140 字で切る。
 */
export function cleanLine(text: string, { botId = null, names = new Map<string, string>() }: { botId?: string | null; names?: ReadonlyMap<string, string> } = {}): string {
  return String(text ?? '')
    .replace(/<@!?(\d+)>/g, (_, id: string) => (botId && id === botId ? '@vex' : `@${names.get(id) ?? 'someone'}`))
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\s*\n\s*/g, ' ⏎ ')
    .trim()
    .slice(0, MAX_CHARS);
}

/** 直近の会話 (古い順) を state の文章にする。 */
export function buildVexState(lines: readonly VexLine[], { idleMinutes = 0, sinceVexMinutes = null }: { idleMinutes?: number; sinceVexMinutes?: number | null } = {}): string {
  const body = lines.map((line) => {
    const ago = line.minutesAgo < 1 ? '' : `${Math.round(line.minutesAgo)}分前 `;
    return `${ago}${line.author}${line.bot ? '[bot]' : ''}: ${line.text}`;
  });
  return [
    ...body,
    idleMinutes > 0 ? `(最後の発言から ${Math.round(idleMinutes * 10) / 10} 分、だれも返事していない)` : '',
    sinceVexMinutes !== null && sinceVexMinutes < 5 ? `(vex は ${Math.round(sinceVexMinutes)} 分前に発言した)` : ''
  ].filter(Boolean).join('\n');
}

export const VEX_QUESTIONS = {
  join: {
    type: 'noul' as const,
    instructions: 'この会話に、Discord の常連 AI「vex」が今返事をするべきか。',
    criteria: {
      true: 'vex が呼ばれている。または vex・bot・AI のことが話題になっている (褒める・けなす・不具合や機能の話)。'
        + 'だれも答えていない質問や頼みごと・事実や技術の間違いに vex が答えられる。',
      false: '人どうしの個人的なやりとり (誕生日・挨拶・内輪ネタ)・独り言・すでに誰かが答えている・vex が直前に話したばかり。'
    }
  }
} as const;
