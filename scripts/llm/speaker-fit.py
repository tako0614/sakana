"""モデルが話者を本当に区別できているかを、**生成せずに**測る (evex-5.3)。

    .venv-llm/bin/python scripts/llm/speaker-fit.py \\
      --ckpt evex52a/evex4-s2/ckpt-e8.pt --corpus corpus-v12

--- なぜ要るのか ---

`conversational.py --distinct` は**生成文どうしの Jaccard 平均**で測っている。
値が 1% 前後しか出ず、4話者 × 5問なので **0.1pt の差は誤差**。実際

    evex-3.5  +3.7%      evex-5.1  +1.5%      evex-5.2  +1.6%

を根拠に「5.2 で `/as` を直した」と判断したが、**1.5% → 1.6% は動いたかどうかも
分からない。**指標の解像度が足りていない。

ここでは**生成しない**。val にある本物の発言を持ってきて、

    その人のトークンで条件付けたときの loss  ＜  他人のトークンのときの loss

になっているかを数える。**偶然なら 50%。**forward だけなので速く、決定的で、
本数を増やせばいくらでも精度が上がる。**5.3 の合否はこれで決める。**

--- 測り方 ---

val の 1 行から「ある人の発言 1 つ」と「その直前の文脈」を取り出し、

    <|cN|><|conv|>(文脈)<|s37|>本文        ← 本人
    <|cN|><|conv|>(文脈)<|s52|>本文        ← 他人 (話者トークンだけ差し替え)

の 2 通りで**本文の部分だけ**の loss を出す。文脈と本文は同じで、
**違うのは話者トークン 1 個だけ。**その 1 個で本文の予測が良くなるなら、
モデルはその人の言い回しを知っている。

`--others` で他人を何人引くかを決める (既定 4)。多いほど安定する。
"""

import argparse
import json
import math
import random
import re
import sys
from collections import defaultdict
from pathlib import Path

import sentencepiece as spm
import torch

from model import Config, MicroLM

parser = argparse.ArgumentParser()
parser.add_argument("--ckpt", required=True)
parser.add_argument("--corpus", default="corpus-v12", help="val と語彙を取る場所")
parser.add_argument("--speakers", type=int, default=40, help="上位から何人見るか")
parser.add_argument("--per-speaker", type=int, default=12, help="1 人あたりの発言数")
parser.add_argument("--others", type=int, default=4, help="1 件につき他人を何人引くか")
parser.add_argument("--min-chars", type=int, default=8, help="短すぎる発言は使わない")
parser.add_argument("--allow-seen", action="store_true",
                    help="文脈に本人が既に出ている断片も使う (既定は使わない)")
parser.add_argument("--threads", type=int, default=8)
parser.add_argument("--seed", type=int, default=0)
args = parser.parse_args()

torch.set_num_threads(args.threads)
torch.set_grad_enabled(False)
rng = random.Random(args.seed)

corpus = Path(args.corpus)
sp = spm.SentencePieceProcessor(model_file=str(corpus / "tok.model"))

blob = torch.load(args.ckpt, map_location="cpu", weights_only=False)
cfg = Config(**{k: v for k, v in blob["config"].items() if k in Config.__dataclass_fields__})
model = MicroLM(cfg)
model.load_state_dict(blob["model"])
model.eval()
print(f"{args.ckpt} / {model.parameter_count():,} パラメータ / epoch {blob.get('epoch', '?')}")

# --- val から「誰の発言か」が分かる断片を集める ---
#
# val.txt は 1 行 1 会話で、`<|cN|><|conv|><|s3|>本文<|s7|>本文...<|end|>` の形。
# 話者トークンで割れば、誰がどこで喋ったかが取れる
TURN = re.compile(r"(<\|(?:s\d+|[a-hz])\|>)((?:<\|re\|>(?:<\|(?:s\d+|[a-hz])\|>)?)?)([^<]*(?:<(?!\|)[^<]*)*)")
HEAD = re.compile(r"^(<\|c(?:\d+|x)\|>)?(<\|conv\|>)")

samples = defaultdict(list)
for line in (corpus / "val.txt").read_text(encoding="utf8").splitlines():
    head = HEAD.match(line)
    prefix = head.group(0) if head else "<|conv|>"
    for found in TURN.finditer(line):
        token, reply, body = found.group(1), found.group(2), found.group(3)
        body = body.replace("<|end|>", "")
        # **固有の話者だけ。**役 (<|a|>..) は匿名なので「その人らしさ」が無い
        if not token.startswith("<|s") or len(body) < args.min_chars:
            continue
        # 文脈はその発言より前の全部。窓に収まるよう後ろから切る
        context = prefix + line[len(prefix):found.start()]
        # **文脈にその人が既に出ている断片は使わない。**出ていると
        # 「さっき喋っていた人がまた喋る」を当てるだけで高く出てしまい、
        # 言い回しを知っているかどうかと区別が付かない
        if not args.allow_seen and token in context:
            continue
        samples[token].append((context, reply, body))

ranked = sorted(samples, key=lambda t: -len(samples[t]))
picked = ranked[: args.speakers]
print(f"val から {len(samples)} 人ぶん / 上位 {len(picked)} 人を見る "
      f"(1 人 {args.per_speaker} 件まで)")

# 差し替え用の他人。**val に出てくる人から引く** (語彙にしか無い人だと比較にならない)
pool = [t for t in ranked if len(samples[t]) >= 2]


def loss_of(context, token, reply, body):
    """その話者トークンを置いたときの、**本文だけ**の平均 loss。"""
    prompt = f"{context}{token}{reply}"
    prompt_ids = sp.encode(prompt)
    body_ids = sp.encode(body)
    if not body_ids:
        return None
    ids = (prompt_ids + body_ids)[-cfg.context:]
    keep = min(len(body_ids), len(ids) - 1)
    if keep < 1:
        return None

    x = torch.tensor([ids[:-1]])
    y = torch.tensor([ids[1:]])
    logits, _ = model(x)
    per_token = torch.nn.functional.cross_entropy(
        logits.float().view(-1, cfg.vocab_size), y.reshape(-1), reduction="none")
    return float(per_token[-keep:].mean())


rows = []
for at, token in enumerate(picked):
    chosen = samples[token][: args.per_speaker]
    for context, reply, body in chosen:
        mine = loss_of(context, token, reply, body)
        if mine is None:
            continue
        # **他人のトークンに差し替える。**本文も文脈もそのまま
        others = [t for t in rng.sample(pool, min(len(pool), args.others + 1)) if t != token]
        theirs = [loss_of(context, other, reply, body) for other in others[: args.others]]
        theirs = [v for v in theirs if v is not None]
        if theirs:
            rows.append((token, mine, sum(theirs) / len(theirs)))
    if (at + 1) % 10 == 0:
        print(f"  {at + 1}/{len(picked)} 人 ({len(rows):,} 件)", flush=True)

if not rows:
    raise SystemExit("測れる発言が集まらなかった。--min-chars を下げるか val を確認する")

# --- 集計 ---


def report(label, subset):
    if not subset:
        print(f"{label:16} —")
        return
    wins = sum(1 for _, mine, other in subset if mine < other)
    gap = sum(other - mine for _, mine, other in subset) / len(subset)
    rate = wins / len(subset)
    # 二項分布の標準誤差。**偶然 (50%) と区別が付くかをここで見る**
    err = math.sqrt(0.25 / len(subset))
    sigma = (rate - 0.5) / err if err else 0.0
    print(f"{label:16} {rate * 100:>6.1f}%  ({wins:,}/{len(subset):,})   "
          f"loss 差 {gap:>+.4f}   偶然との隔たり {sigma:>5.1f}σ")


order = {token: i for i, token in enumerate(ranked)}
half = len(picked) // 2
top = {t for t in picked if order[t] < half}

print(f"\n本人のトークンの方が loss が低かった割合 (偶然 = 50.0%)\n")
print(f"{'':16} {'当てはまり':>7}  {'件数':>13}   {'loss 差':>12}   {'有意性':>14}")
report("全体", rows)
report("  発言の多い上位", [r for r in rows if r[0] in top])
report("  発言の少ない下位", [r for r in rows if r[0] not in top])

print("\n**2σ を超えていなければ「区別できている」とは言えない。**"
      "\n50% 付近なら話者トークンは飾りで、`/as` は効いていない。")

json.dump({"ckpt": args.ckpt, "corpus": str(corpus), "rows": len(rows),
           "rate": sum(1 for _, m, o in rows if m < o) / len(rows)},
          sys.stdout)
print()
