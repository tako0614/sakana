// 事実を聞かれたのに、何も調べずに答えそうなとき、答える前に1回だけ確かめさせる。
//
// 本番の実行の3割は道具を1回も呼ばずに答えていた。雑談ならそれでよいが、「〇〇について教えて」「さかなのやらかし」の
// ような事実を聞く依頼を記憶や推測で答えると、作り話が混ざる。依頼が事実を聞いていて、まだ何も調べていないときだけ、
// 最初の答えを1回やり直させる (2回目は何を答えてもよい)。

const LOOKUP_REQUEST = /(?:教えて|探して|調べて|掘り返して|昔の話を?して)(?:くれ(?:る)?|ください|ほしい|もらえる)?[。！!？?\s]*$/u;
const FACT_QUESTION = /(?:って\s*(?:誰|だれ|何|なに|どんな人|いつ[^。！？?\n]{0,24})|(?:黒歴史|やらかし|エピソード)(?:って)?(?:は|が)?ある|(?:誰|だれ)が(?:言った|決めた)|何を?した)[。！？?\s]*$/u;

/** 明示的な調査依頼や、根拠が要る具体的な質問だけを強制調査の対象にする。 */
export function lookupAdvised(request: string): boolean {
  const text = request.replace(/<@!?\d+>/g, '').replace(/https?:\/\/\S+/g, '').trim();
  return text.length >= 4 && (LOOKUP_REQUEST.test(text) || FACT_QUESTION.test(text));
}

/**
 * 調べたことになる道具か。memory_focus は思い出したいことを伝えるだけで、何も取ってこない
 * (呼んだだけで「調べた」扱いになり、事実を聞かれても調べずに答えられていた)。
 */
export const countsAsLookup = (toolName: string): boolean => toolName !== 'memory_focus';

export const LOOKUP_HINT = '依頼で聞かれた事実を、答える前に適切なツールで1回確かめて。分かったことから簡潔に答える。';

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
