// 判定モデル (d1-3B / Clef-flash) に渡す state と質問。
//
// 判定モデルは state (文章) と型つきの質問だけを見て、選択肢ごとの確率を返す (文章は作らない)。
// 質問の言い回しで結果が大きく変わるので、候補を名前で並べて評価で選ぶ (eval.mjs --set)。

/**
 * 場面 (export-situations.mjs の1行) を state の文章にする。
 * CPU での推論は 1秒に約 100 トークンしか進まない (d1-3B Q8_0、i5-12600K で実測) ので、短く書く:
 * 直近 6 件・1件 140 字まで・時刻は分だけ。判定の手がかり (呼ばれたか・質問か・静かになってどれだけか) は残す。
 */
export function buildState(situation, { messages = 6, chars = 140, header = false } = {}) {
  const recent = situation.recent.slice(-messages);
  const lines = recent.map((message) => {
    const ago = message.minutes_ago < 1 ? '' : `${Math.round(message.minutes_ago)}分前 `;
    return `${ago}${message.author}${message.bot ? '[bot]' : ''}: ${message.text.slice(0, chars)}`;
  });
  const since = situation.minutes_since_vex;
  const idle = situation.idle_minutes ?? 0;
  return [
    ...(header ? [`# Discord #${situation.channel}`] : []),
    ...lines,
    idle > 0 ? `(最後の発言から ${idle} 分、だれも返事していない)` : '',
    since === null || since === undefined ? '' : since < 5 ? `(vex は ${Math.round(since)} 分前に発言した)` : ''
  ].filter(Boolean).join('\n');
}

const ROLE = 'vex は Discord サーバーの常連の AI。質問に答える、調べものをする、事実の間違いを正す、会話を盛り上げる、ができる。';

/** 質問のまとまり。join (はい/いいえ) の確率が主。 */
export const QUESTION_SETS = {
  // 最小: 何も教えず聞く
  min: {
    join: { type: 'noul', instructions: 'vex が今この会話に入ると役に立つ?' }
  },
  // 短い基準 (CPU では質問文のトークンも 1 件ごとに払う。rubric の約半分)
  short: {
    join: {
      type: 'noul',
      instructions: 'vex (Discord の常連 AI) が今返事をすると、歓迎されて役に立つ? '
        + '呼ばれている・答えのない質問がある・事実を正せる → はい。人どうしの雑談・独り言・別の人宛て → いいえ。'
    }
  },
  // API 用: 基準は instructions ではなく criteria (はい / いいえの説明) に書く。判定モデルはこの形で学習されている
  api: {
    join: {
      type: 'noul',
      instructions: 'この会話に、Discord の常連 AI「vex」が今返事をするべきか。',
      criteria: {
        true: 'vex が呼ばれている (@vex)・だれも答えていない質問や頼みごとがある・事実の間違いを正せる・vex が役に立てることが明らかにある。',
        false: '人どうしの雑談・独り言・感想・別の人宛て・すでに誰かが答えている・vex が直前に話したばかり。'
      }
    }
  },
  // 役割と基準を書く
  rubric: {
    join: {
      type: 'noul',
      instructions: `${ROLE} いま最後の発言のあとで vex が返事をすると、歓迎されて役に立つか。`
        + '呼ばれている (@vex)・答えが付いていない質問や頼みごとがある・事実の間違いを正せる・vex だけが知っていそうな話題、のときは「はい」。'
        + '人どうしの雑談が続いている・相槌や感想だけ・独り言・別の人に宛てた発言・vex が直前に話したばかり、のときは「いいえ」。'
    }
  },
  // 理由も聞く (join の確率は同じ。why は解析用)
  full: {
    join: {
      type: 'noul',
      instructions: `${ROLE} いま最後の発言のあとで vex が返事をすると、歓迎されて役に立つか。`
        + '呼ばれている (@vex)・答えが付いていない質問や頼みごとがある・事実の間違いを正せる、のときは「はい」。'
        + '人どうしの雑談が続いている・相槌や感想だけ・独り言・別の人に宛てた発言、のときは「いいえ」。'
    },
    why: {
      type: 'choice',
      instructions: 'vex が入るとしたら、いちばん近い理由は?',
      criteria: {
        called: '@vex と呼ばれている',
        question: '答えが付いていない質問や頼みごとがある',
        fact: '事実の間違いや調べものがある',
        banter: '会話を盛り上げられる',
        none: '入る理由は無い (人どうしの会話・相槌・独り言)'
      }
    },
    urgency: { type: 'score', instructions: 'vex が返事をする必要は、どれくらい高いか。', criteria: ['要らない', 'あれば嬉しい', '返事が欲しい', 'すぐ返事が必要'] }
  },
  // 英語の質問文 (日本語の state)。日本語の質問文が弱いときの比較用
  en: {
    join: {
      type: 'noul',
      instructions: 'vex is an AI regular in a Japanese Discord server (answers questions, looks things up, corrects facts, jokes). '
        + 'After the last message, would a reply from vex be welcome and useful? Yes if vex is addressed (@vex), a question or request has gone unanswered, or a fact can be corrected. '
        + 'No if humans are just chatting, the message is an acknowledgement, a monologue, addressed to someone else, or vex just spoke.'
    }
  }
};
