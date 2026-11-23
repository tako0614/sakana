// 事実を聞かれたのに、何も調べずに答えそうなとき、答える前に1回だけ確かめさせる。
//
// 過去ログや人の言動を聞かれたとき、推測で答えないように1回だけ確かめさせる。
// 「教えて」「調べて」だけでは、広い調査依頼に一言返す場合にも検索を強制してしまう。

const LOOKUP_REQUEST = /(?:掘り返して|昔の話を?して|(?:過去ログ|発言|黒歴史|やらかし(?:エピ(?:ソード)?)?)(?:を)?(?:教えて|探して|調べて))(?:くれ(?:る)?|ください|ほしい|もらえる)?[。！!？?\s]*$/u;
const FACT_QUESTION = /(?:って\s*(?:誰|だれ|どんな人|いつ[^。！？?\n]{0,24})|(?:黒歴史|やらかし|エピソード)(?:って)?(?:は|が)?ある|(?:誰|だれ)が(?:言った|決めた)|何を?した)[。！？?\s]*$/u;

/** 過去ログの依頼や、根拠が要る具体的な質問だけを検索のやり直し対象にする。 */
export function lookupAdvised(request: string): boolean {
  const text = request.replace(/<@!?\d+>/g, '').replace(/https?:\/\/\S+/g, '').trim();
  // 複数文の最後に質問があっても、依頼全体の意図は通常のプロンプトで判断する。
  if (text.length < 4 || /[。！？!?\n]/u.test(text.replace(/[。！？!?\s]+$/u, ''))) return false;
  return LOOKUP_REQUEST.test(text) || FACT_QUESTION.test(text);
}

/**
 * 調べたことになる道具か。memory_focus は思い出したいことを伝えるだけで、何も取ってこない
 * (呼んだだけで「調べた」扱いになり、事実を聞かれても調べずに答えられていた)。
 */
export const countsAsLookup = (toolName: string): boolean => toolName !== 'memory_focus';

export const LOOKUP_HINT = '会話で答えるのに必要な事実があれば、適切なツールで一度だけ確かめて。作業を丸ごと頼まれた場合は、調査を始めず一言で返す。';

/**
 * runtime の validate に渡す関数を作る。最初の答えが道具なしで、依頼が事実を聞いているときだけ1回やり直させる
 * (runtime は投げられたエラーの governanceRetryHint を「RETRY: …」として足して、もう1往復させる)。
 */
export function lookupGuard({ request, usedTool }: { request: string; usedTool: () => boolean }):
  (message: { content?: unknown }) => unknown {
  const shouldCheck = lookupAdvised(request);
  let asked = false;
  return (message) => {
    if (shouldCheck && !asked && !usedTool()) {
      asked = true;
      throw Object.assign(new Error('lookup advised'), { governanceRetryHint: LOOKUP_HINT });
    }
    return message.content;
  };
}
