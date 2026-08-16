"""話者ごとの切り出しで「対象の人の発言だけ」を損失に入れるマスクを作る (evex-5.3)。

    .venv-llm/bin/python scripts/llm/speaker-mask.py --corpus corpus-v13

出力: {corpus}/speaker.keep.npy   uint8 の 0/1。train.py の --keep-mask に渡す。

--- なぜ要るのか ---

話者ごとの切り出しは `[前の2発言] + [その人の発言]` の形をしている
(`EXCERPT.qaContext = 2`)。ところが損失は**3発言ぶん全部に流れる**ので、
勾配の 2/3 は「他人の話し方」を学ぶのに使われている。

狙いは「`<|s37|>` なら何と言うか」を覚えさせることなので、**対象の発言だけ残せば
同じ本数で勾配が約3倍濃くなる。**本数を増やすより先に、いま入れているぶんを
効かせる。

evex-5.2 では 147人 × 2,500本を入れたのに弁別性が +1.5% → +1.6% (誤差) しか
動かなかった。量が足りないのに加えて、**入れた量の 1/3 しか効いていなかった**
可能性がある。

--- どう作るか ---

train.py の `load()` と**同じ順序・同じ `sp.encode(lines)`** で数える。
ここがずれると長さが合わず、train.py が弾く (向こうに検査がある)。

切り出しは連続した塊で train に push されるので、build-corpus.mjs が
`speaker_excerpt_range: [from, to)` を stats.json に残している。その範囲の行だけ
**最後の話者トークンより前を 0** にする (切り出しは `slice(conv, [from, i])` で
対象の発言が必ず末尾に来る)。

それ以外の行は全部 1。**素の窓も噛み合い切り出しも今までどおり全部学ぶ。**

--- 必ず中身を開くこと ---

Rho-1 を `--mode low` で掛けたとき、残ったのが句読点と助詞ばかりなのに割合
(66%) だけ見て回して、噛み合いを半分にした前科がある。**残ったトークンを
実際に印字して、対象話者の発言になっているか目で見ること。**
"""

import argparse
import collections
import json
from pathlib import Path

import numpy as np
import sentencepiece as spm

parser = argparse.ArgumentParser()
parser.add_argument("--corpus", default="corpus-v13")
parser.add_argument("--name", default="train", help="対象の .txt / .u16.npy")
parser.add_argument("--show", type=int, default=6, help="中身を何本見せるか")
args = parser.parse_args()

corpus = Path(args.corpus)
sp = spm.SentencePieceProcessor(model_file=str(corpus / "tok.model"))
stats = json.loads((corpus / "stats.json").read_text(encoding="utf8"))

span = stats.get("speaker_excerpt_range")
if not span:
    raise SystemExit(
        f"{corpus}/stats.json に speaker_excerpt_range が無い。"
        "話者ごとの切り出しを入れずに組んだコーパス (LLM_PER_SPEAKER=0) には掛けられない")
start, end = span
print(f"話者ごとの切り出し: {args.name}.txt の {start:,} 行目から {end:,} 行目 "
      f"({end - start:,} 本)")

# --- 話者トークンの id を集める ---
#
# 対象は `<|sN|>` だけ。役 (`<|a|>`..`<|h|>`) は匿名なので切り出しには出てこないが、
# 前の2発言には出る。**そこを終端と誤認すると他人の発言を残すことになる**ので、
# 「最後の話者トークン」は <|sN|> に限らず**あらゆる話者トークン**で探す
def piece_id(piece):
    got = sp.piece_to_id(piece)
    return got if got != sp.unk_id() else None


speaker_ids = set()
for i in range(sp.get_piece_size()):
    piece = sp.id_to_piece(i)
    if piece.startswith("<|s") and piece.endswith("|>"):
        speaker_ids.add(i)
    elif len(piece) == 5 and piece.startswith("<|") and piece.endswith("|>") \
            and piece[2].isalpha():
        speaker_ids.add(i)          # 役 <|a|>..<|h|> と溢れ <|z|>
print(f"話者トークン {len(speaker_ids)} 個を終端の目印にする")

RE_ID = piece_id("<|re|>")          # `<話者><|re|><返信先>本文` の返信先も落とす

lines = (corpus / f"{args.name}.txt").read_text(encoding="utf8").splitlines()
print(f"{args.name}.txt {len(lines):,} 行")

# --- 1 行ずつ数える ---
#
# train.py の load() は `sp.encode(lines)` の結果をそのまま連結している。
# ここも同じにする (1 行ずつ encode すると結果が変わることは無いが、
# **順序と連結の仕方を揃える**のが目的)
keep_parts = []
total = 0
masked = 0
replies = 0
headless = 0
shape = collections.Counter()
shown = []

for index, ids in enumerate(sp.encode(lines, out_type=int)):
    total += len(ids)
    if not (start <= index < end):
        keep_parts.append(np.ones(len(ids), dtype=np.uint8))
        continue

    # 最後の話者トークンを探す。そこから後ろ (話者トークン自身も含む) を残す
    cut = None
    for at in range(len(ids) - 1, -1, -1):
        if ids[at] in speaker_ids:
            cut = at
            break

    # **返信のときは 2 つ戻す。**最後の turn は `<話者><|re|><返信先>本文` なので、
    # 素直に「最後の話者トークン」を取ると**返信先**に当たってしまい、
    # 喋っている本人のトークンが残す範囲から外れる。turn の頭に合わせる
    if cut is not None and cut >= 2 and RE_ID is not None \
            and ids[cut - 1] == RE_ID and ids[cut - 2] in speaker_ids:
        cut -= 2
        replies += 1

    row = np.zeros(len(ids), dtype=np.uint8)
    if cut is None:
        # 話者トークンが無い = 想定外の行。**落とさず全部残す** (学習から消える方が怖い)
        row[:] = 1
        headless += 1
    else:
        row[cut:] = 1
        masked += cut
        # **全件で数え直す。**残す範囲に話者トークンが何個あるか。
        # 1 個 = 素の発言 / 2 個 = 返信 (本人 + 返信先)。**3 個以上は切り出し位置の間違い**で、
        # 他人の発言まで損失に入っていることになる
        shape[sum(1 for t in ids[cut:] if t in speaker_ids)] += 1

    keep_parts.append(row)
    # **返信つきの例を優先して見せる。**切り出し位置がずれるとしたらそこなので
    if cut and cut > 2 and (len(shown) < args.show or
                            (replies and len(shown) < args.show * 2)):
        shown.append((sp.decode(ids[:cut]), sp.decode(ids[cut:])))

keep = np.concatenate(keep_parts)
out = corpus / "speaker.keep.npy"
np.save(out, keep)

cache = corpus / f"{args.name}.u16.npy"
if cache.exists():
    have = len(np.load(cache, mmap_mode="r"))
    if have != len(keep):
        raise SystemExit(f"長さが合わない: {args.name}.u16.npy {have:,} 対 マスク {len(keep):,}")
    print(f"{args.name}.u16.npy と長さ一致 ({have:,})")
else:
    print(f"※ {cache.name} がまだ無い。train.py が作るときに長さを検査する")

kept = int(keep.sum())
print(f"\n損失に入れる {kept:,} / {total:,} トークン ({kept / total * 100:.1f}%)")
print(f"  外したのは切り出しの文脈ぶん {masked:,} トークン "
      f"({masked / total * 100:.1f}%)")
print(f"  うち返信つきで turn の頭に戻したもの {replies:,} 本")

# **切り出し位置の検算。**残す範囲の話者トークンは 1 個 (素の発言) か
# 2 個 (返信 = 本人 + 返信先) のはず。3 個以上あるなら他人の発言まで残っている
print("\n残す範囲に入った話者トークンの数:")
for count in sorted(shape):
    note = {1: "素の発言", 2: "返信 (本人 + 返信先)"}.get(count, "**間違い。他人の発言まで残っている**")
    print(f"  {count} 個 … {shape[count]:>9,} 本   {note}")
if headless:
    print(f"  話者トークンが無い行 {headless:,} 本は丸ごと残した")
wrong = sum(n for c, n in shape.items() if c > 2)
if wrong:
    raise SystemExit(f"\n切り出し位置が間違っている行が {wrong:,} 本ある。マスクを使わないこと")
print(f"-> {out}")

# --- 中身を見せる。ここを飛ばさないこと ---
print("\n=== 落とす文脈 | 残す発言 ===")
for context, target in shown:
    print(f"  落とす: {context[:70]}")
    print(f"  残す  : {target[:70]}")
    print()
print("**残す側が「対象の人の1発言」になっているか目で見ること。**"
      "\n他人の発言まで残っていたら、話者トークンの探し方が間違っている。")
