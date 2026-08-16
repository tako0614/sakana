"""生成文がどれだけ「このサーバーらしいか」を測る (evex度)。

    .venv-llm/bin/python scripts/llm/evex-ness.py --corpus corpus-v10 \\
      --texts out-a.txt out-b.txt

--- なぜ要るのか ---

噛み合いは「質問の語を拾ったか」しか見ず、なんJ弁の検出は「漏れの有無」しか
見ない。**欲しいのは「このサーバーらしさ」そのもの**なのに、それを測る道具が
無かった。

計画では judge モデル (素の Qwen3-0.6B) に読ませた ppl 比を使うことにしていたが、
あれは 1.2GB の重みを落とす必要がある。**手元のコーパスだけで測れる代わり**を
用意する。

--- どう測るか ---

evex と外部の**語の使われ方の差**を使う。ある語 w について:

    evex度(w) = log( (evex での出現率 + a) / (外部での出現率 + a) )

これが大きい語は「このサーバーではよく使うが、なりきり掲示板・字幕・なんJ では
使わない語」= 内輪の語。生成文の内容語について平均を取れば、その文が
どれだけ内輪に寄っているかが出る。

**本物の発言 (val) を同じ物差しで測った値と比べる。**絶対値には意味が無く、
「本物と同じくらい内輪か」が知りたいので:

    evex度 = 生成文の平均 / val の平均

    ≈ 1   本物と同じ手触り
    < 1   無難すぎる (誰でも言う言葉ばかり)
    > 1   本物より内輪に寄っている

**外部にしか無い語も見る。**字幕やなんJ の語が混ざっていれば漏れとして出る。
"""

import argparse
import math
import re
from collections import Counter
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--corpus", default="corpus-v10")
parser.add_argument("--external", nargs="*", default=None,
                    help="外部の .txt (既定は corpus/external.txt など)")
parser.add_argument("--texts", nargs="+", required=True,
                    help="測る生成文。1 行 1 発言")
parser.add_argument("--min-count", type=int, default=5, help="語彙に入れる最低出現数")
args = parser.parse_args()

corpus = Path(args.corpus)

# 内容語だけ拾う。助詞や1文字は「らしさ」を運ばない (conversational.py と同じ規則)
WORD = re.compile(r"[一-龥ァ-ヶー]{2,}|[A-Za-z][A-Za-z0-9_.-]{2,}")
SPEAKER = re.compile(r"<\|s\d+\|>|<\|other\|>|<\|[a-hz]\|>|<\|end\|>|<\|conv\|>|<\|re\|>"
                     r"|<\|c(?:\d+|x)\|>|<\|hi\|>")


def words_of(path, limit=None):
    counts = Counter()
    with open(path, encoding="utf8") as f:
        for i, line in enumerate(f):
            if limit and i >= limit:
                break
            body = SPEAKER.sub(" ", line).replace("<nl>", " ")
            counts.update(w.lower() for w in WORD.findall(body))
    return counts


print("読んでいる…", flush=True)
evex = words_of(corpus / "train.txt")
val = words_of(corpus / "val.txt")

external_files = args.external or [
    str(corpus / name) for name in ("external.txt", "jesc.txt", "open2ch.txt")
    if (corpus / name).exists()
]
if not external_files:
    # v10 は外部を別ディレクトリに置いてある
    external_files = [str(p) for p in Path("corpus-v7").glob("*.txt")
                      if p.name in ("external.txt", "jesc.txt", "open2ch.txt")]

outside = Counter()
for path in external_files:
    # 全部読むと重いので先頭 40 万行で足りる (語の相対頻度が見たいだけ)
    outside.update(words_of(path, limit=400_000))

print(f"evex {sum(evex.values()):,} 語 / 外部 {sum(outside.values()):,} 語 "
      f"({len(external_files)} ファイル)")

total_evex = sum(evex.values())
total_out = sum(outside.values())
SMOOTH = 1e-7


def evexness(word):
    """その語がどれだけ内輪寄りか。0 が中立、正なら evex 寄り。"""
    p_in = evex.get(word, 0) / total_evex
    p_out = outside.get(word, 0) / total_out
    return math.log((p_in + SMOOTH) / (p_out + SMOOTH))


# 語彙は evex に一定数出るものだけ。1 回しか出ない語で振り回されないため
vocabulary = {w for w, c in evex.items() if c >= args.min_count}


def score(path_or_lines, label):
    lines = (path_or_lines if isinstance(path_or_lines, list)
             else Path(path_or_lines).read_text(encoding="utf8").splitlines())
    values, hits, misses = [], 0, 0
    for line in lines:
        for word in WORD.findall(SPEAKER.sub(" ", line).replace("<nl>", " ")):
            word = word.lower()
            if word in vocabulary:
                values.append(evexness(word))
                hits += 1
            else:
                misses += 1
    mean = sum(values) / len(values) if values else float("nan")
    return mean, hits, misses, len(lines)


# 本物の発言を同じ物差しで測る (これが 1.0 の基準)
val_lines = []
for line in (corpus / "val.txt").read_text(encoding="utf8").splitlines():
    val_lines.extend(p for p in SPEAKER.split(line) if p.strip())
base, *_ = score(val_lines, "val")
print(f"\n本物の発言 (val) の evex度 = {base:.3f}  ← これを 1.00 とする\n")

print(f"{'':28} {'evex度':>8} {'比':>7} {'語数':>7} {'語彙外':>7}")
for path in args.texts:
    mean, hits, misses, lines = score(path, path)
    ratio = mean / base if base else float("nan")
    verdict = ("本物と同じ手触り" if 0.85 <= ratio <= 1.25
               else "無難すぎる" if ratio < 0.85 else "本物より内輪")
    print(f"{Path(path).name:28} {mean:>8.3f} {ratio:>6.2f}x {hits:>7,} {misses:>7,}"
          f"   {verdict}")

print("\n比 < 0.85 なら誰でも言う言葉ばかり = evex らしさが薄い。"
      "\n> 1.25 なら本物より内輪に寄っている (悪いとは限らない)。"
      "\n**語彙外が多いモデルは外部の語を持ち込んでいる**ので、そちらも見ること。")
