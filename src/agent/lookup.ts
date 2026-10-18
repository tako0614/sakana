// 事実を聞かれたのに、何も調べずに答えそうなとき、答える前に1回だけ確かめさせる。
//
// 本番の実行の3割は道具を1回も呼ばずに答えていた。雑談ならそれでよいが、「〇〇について教えて」「さかなのやらかし」の
// ような事実を聞く依頼を記憶や推測で答えると、作り話が混ざる。依頼が事実を聞いていて、まだ何も調べていないときだけ、
// 最初の答えを1回やり直させる (2回目は何を答えてもよい)。

// 事実・過去・人物を聞く言い回し
const ASKING = /(教えて|について|とは[？?\s]|って(何|なに|誰|だれ|どんな|いつ|どこ)|どんな(人|やつ|話|奴)|誰|だれ|いつ|なんで|なぜ|エピ|やらかし|過去|昔|前に|探して|調べて|知ってる|覚えてる|どうなの|どういう|何をした|何した)/;

/** 事実を聞いていそうか。known: 依頼に名前が出てきた記憶のページがあるか。 */
export function lookupAdvised(request: string, { known = false }: { known?: boolean } = {}): boolean {
  const text = request.replace(/<@!?\d+>/g, '').replace(/https?:\/\/\S+/g, '').trim();
  if (text.length < 4) return false;
  if (ASKING.test(text)) return true;
  // 知っている名前が出て、疑問の形のとき (「たこってダブスタじゃない？」)
  return known && /[？?]/.test(text);
}

/**
 * 調べたことになる道具か。memory_focus は思い出したいことを伝えるだけで、何も取ってこない
 * (呼んだだけで「調べた」扱いになり、事実を聞かれても調べずに答えられていた)。
 */
export const countsAsLookup = (toolName: string): boolean => toolName !== 'memory_focus';

export const LOOKUP_HINT = '事実が絡む話なのに、まだ何も調べていない。答える前に、過去ログ (search) か記憶 (memory) で1回確かめて。確かめても材料が無ければ、そう言って答えていい。';

/**
 * runtime の validate に渡す関数を作る。最初の答えが道具なしで、依頼が事実を聞いているときだけ1回やり直させる
 * (runtime は投げられたエラーの governanceRetryHint を「RETRY: …」として足して、もう1往復させる)。
 */
export function lookupGuard({ request, known, usedTool }: { request: string; known: boolean; usedTool: () => boolean }):
  (message: { content?: unknown }) => unknown {
  let asked = false;
  return (message) => {
    if (!asked && !usedTool() && lookupAdvised(request, { known })) {
      asked = true;
      throw Object.assign(new Error('lookup advised'), { governanceRetryHint: LOOKUP_HINT });
    }
    return message.content;
  };
}
