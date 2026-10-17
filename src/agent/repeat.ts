// 同じ答えを2回重ねて書いたとき、最後の版だけを残す。
//
// flash 系のモデルは、答えを書いたあとにもう一度頭から書き直して、両方を1つの返信に出すことがある
// (2026-10-17: 「さかなのやらかしは割と在庫があるよ。…」の段落の並びが、日付の書き方だけ変えてもう一度続いた)。
// 主な対策はプロンプト (答えは1回だけ) で、これは取りこぼしの保険。
//
// 見分け方: 最初の段落と(ほぼ)同じ段落があとにもう一度出てきて、そこから先の段落も
// 前の版の2段落目に似ているなら「頭から書き直した」とみなし、後ろの版から読ませる。
// 結びの1文がたまたま冒頭に似ているだけの返信は触らない (書き直しの目印は、2段落ぶん続く重なり)。

const MIN_LENGTH = 12;
const SAME = 0.6;
const NEXT = 0.4;

function bigrams(text: string): Set<string> {
  const flat = text.replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let index = 0; index + 1 < flat.length; index += 1) grams.add(flat.slice(index, index + 2));
  return grams;
}

/** 字の2連の重なり (Dice 係数)。同じ文は 1、無関係な文は 0 に近い。 */
export function similarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

export function dropRestartedAnswer(text: string): string {
  let current = text;
  for (let round = 0; round < 3; round += 1) {
    const paragraphs = current.split(/\n{2,}/);
    const first = (paragraphs[0] ?? '').trim();
    const second = (paragraphs[1] ?? '').trim();
    if (paragraphs.length < 4 || first.length < MIN_LENGTH) return current;

    // 2段落目以降で、最初の段落にもう一度似る段落
    let restart = -1;
    for (let index = 2; index < paragraphs.length - 1; index += 1) {
      const candidate = (paragraphs[index] ?? '').trim();
      if (candidate.length < MIN_LENGTH || similarity(first, candidate) < SAME) continue;
      // 続きも前の版の2段落目に似ていること (書き直しは1文では終わらない)
      if (similarity(second, (paragraphs[index + 1] ?? '').trim()) >= NEXT) restart = index;
    }
    if (restart < 0) return current;
    current = paragraphs.slice(restart).join('\n\n');
  }
  return current;
}
