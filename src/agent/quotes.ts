// 「」で囲んだ引用が、モデルの見た材料に本当にあるかを確かめる。
//
// 本番の返事 (2026-10-14〜17、引用 140 件) を材料と突き合わせたら、そのまま載っているのは 77%、ほぼ載っているのが 9%、
// 一部だけが 6%、ほとんど載っていない (言い換え・モデル自身の評価・作り話) が 8% だった。
// 読む人は「」を本人の言葉として読む。材料に無いものは、「」を外して地の文にする (意味は変えない。引用の体裁だけ外す)。

const MIN_QUOTE = 6;
const SHINGLE = 4;
// これ未満しか材料と重ならない引用は、言葉そのままではないとみなす
const THRESHOLD = 0.5;

/** 文字・数字だけにそろえる (句読点・空白・JSON の記号・引用符の違いを無視する)。 */
const keep = (text: string): string => text.replace(/[^\p{L}\p{N}]/gu, '');

function shingles(text: string): Set<string> {
  const out = new Set<string>();
  for (let index = 0; index + SHINGLE <= text.length; index += 1) out.add(text.slice(index, index + SHINGLE));
  return out;
}

/** 引用が材料と重なる割合 (1 = そのまま載っている)。 */
export function quoteOverlap(quote: string, evidence: string): number {
  const wanted = keep(quote);
  if (wanted.length < MIN_QUOTE) return 1;
  if (evidence.includes(wanted)) return 1;
  const parts = shingles(wanted);
  if (parts.size === 0) return 1;
  const pool = shingles(evidence);
  let hit = 0;
  for (const part of parts) if (pool.has(part)) hit += 1;
  return hit / parts.size;
}

/** 材料に無い「」の引用から「」を外す。ほかは触らない。 */
export function softenUnverifiedQuotes(text: string, observed: string): string {
  if (!text.includes('「')) return text;
  const evidence = keep(observed);
  const cache = new Map<string, boolean>();
  return text.replace(/「([^」\n]{6,120})」/g, (match: string, inner: string) => {
    let ok = cache.get(inner);
    if (ok === undefined) {
      ok = quoteOverlap(inner, evidence) >= THRESHOLD;
      cache.set(inner, ok);
    }
    return ok ? match : inner;
  });
}
