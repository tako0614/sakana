// 自発参加で agent に渡す一言と、「返す価値が無い」の答えの見分け。

/** 呼ばれていない会話に入るときの前置き。依頼の本文の前に付ける。 */
export const AMBIENT_HINT = '(だれにも呼ばれていない。この会話に自分から入る場面。上の発言に対して、役に立つ一言か場に合う一言だけ返す。'
  + '返す価値が無ければ (skip) とだけ書く)';

/** (skip) だけの答えか。飾り・句読点・大文字小文字の違いは許す。 */
export function isPassAnswer(text: unknown): boolean {
  return /^[\s(（\[「『]*skip[\s)）\]」』.。!！]*$/i.test(String(text ?? ''));
}
