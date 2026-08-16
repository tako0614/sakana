"""参照モデルでトークンを採点し、学習に使うものだけの 0/1 を書き出す (Rho-1)。

    .venv-llm/bin/python scripts/llm/score-tokens.py \\
      --ckpt evex4/evex4-s2/ckpt-e8.pt --corpus corpus-v8 --name pretrain

出力: {corpus}/{name}.keep.npy   uint8 の 0/1。train.py の --keep-mask に渡す。

--- なぜ要るのか ---

段1 の 70% は外部データ (なりきり掲示板・映画字幕・なんJ) で、**中身の全部が
evex に要るわけではない**。字幕の翻訳調も、なんJ弁も、そのまま学ぶと evex度を
下げる方向に働く。だが外部を減らすと日本語と会話の土台が痩せる
(段1 だけで val 4.84 まで来ているので、土台としては効いている)。

Rho-1 (arXiv:2404.07965) は「トークンは全部が等しく要るわけではない」として、
**参照モデルで採点して要るものだけ損失に入れる**。同じ精度に 5〜10 倍速く
届くと報告されている。

**参照モデルを evex で仕上げたもの (evex-4 の段2) にするのが肝。**
「evex から見て予測しやすい = このサーバーの言葉づかいに近い」トークンが残り、
「evex から見て突拍子もない = 外部特有の言い回し」が落ちる。
つまり **外部データを量として使いながら、学ぶ中身を evex 側に寄せられる**。

--- 何を残すか ---

Rho-1 の原典は「参照との差 (excess loss) が大きいトークン」を残す。あれは
「参照は解けるのに自分は解けない = これから学ぶべき」を選ぶため。

こちらは目的が違う。**参照 (evex) にとって自然なトークンを残したい**ので、
`--mode low` (参照の loss が低い順) を既定にする。原典どおりの選び方も
`--mode excess` で試せるようにしてあるが、そちらは学習中のモデルが要るので
ここでは参照だけで決まる `low` を使う。

**話者トークンや制御記号は必ず残す。**あれは構造そのもので、落とすと会話の
形が壊れる。
"""

import argparse
import re
from pathlib import Path

import numpy as np
import sentencepiece as spm
import torch

from model import Config, MicroLM

parser = argparse.ArgumentParser()
parser.add_argument("--ckpt", required=True, help="参照モデル (evex で仕上げたもの)")
parser.add_argument("--corpus", default="corpus-v8")
parser.add_argument("--name", default="pretrain", help="採点する .u16.npy の名前")
parser.add_argument("--keep", type=float, default=0.6, help="残す割合")
# **`low` は使ってはいけない。**evex-5 preview で段1 に掛けたら、残ったのが
# 句読点・構造記号・助詞ばかり (内容語が上位15 に 1 つも無い) で、外部 66.2% /
# evex 67.9% とドメインの差もまったく付かなかった。役の噛み合いが 36.7% → 16.7%。
#
# 狙いは「ドメインで選ぶ」だったが、効いた軸は「予測しやすいか」でこれは
# ドメインと直交する。**ドメインで絞りたいなら LLM_BASE_SHARE で evex の比率を
# 上げる方が素直。**Rho-1 を使うなら原典どおり excess loss にすること。
parser.add_argument("--mode", default="high", choices=["low", "high"])
parser.add_argument("--batch", type=int, default=16)
parser.add_argument("--threads", type=int, default=10)
args = parser.parse_args()

torch.set_num_threads(args.threads)
torch.set_grad_enabled(False)

corpus = Path(args.corpus)
sp = spm.SentencePieceProcessor(model_file=str(corpus / "tok.model"))

blob = torch.load(args.ckpt, map_location="cpu", weights_only=False)
cfg = Config(**{k: v for k, v in blob["config"].items()
                if k in Config.__dataclass_fields__})
model = MicroLM(cfg)
model.load_state_dict(blob["model"])
model.eval()

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model.to(device)
print(f"参照 {args.ckpt} / {model.parameter_count():,} パラメータ / device {device}")

ids = np.load(corpus / f"{args.name}.u16.npy")
print(f"採点する {args.name}: {len(ids):,} トークン")

# --- 必ず残すトークン ---
#
# 制御記号と話者と役とチャンネル。**構造そのもの**なので、落とすと
# 「誰が喋っているか」「会話がどこで終わるか」が学べなくなる
STRUCTURAL = re.compile(r"^<\|.+\|>$|^<(?:nl|url|file|mention|channel|time|/?code)>$")
protected = torch.zeros(cfg.vocab_size, dtype=torch.bool)
for piece in range(cfg.vocab_size):
    if STRUCTURAL.match(sp.id_to_piece(piece)):
        protected[piece] = True
print(f"構造トークン {int(protected.sum())} 個は必ず残す")

# --- 1 パス forward して loss を集める ---
#
# 窓は重ねない。**先頭のトークンは文脈が無くて loss が高く出る**ので、
# 窓ごとに最初の数個は採点から外す (`WARM`)。
WARM = 32
step = cfg.context
losses = np.zeros(len(ids), dtype=np.float32)
scored = np.zeros(len(ids), dtype=bool)

starts = list(range(0, len(ids) - cfg.context - 1, step))
for at in range(0, len(starts), args.batch):
    group = starts[at:at + args.batch]
    window = np.stack([ids[s:s + cfg.context + 1] for s in group]).astype(np.int64)
    chunk = torch.from_numpy(window).to(device)
    x, y = chunk[:, :-1], chunk[:, 1:]

    logits, _ = model(x)
    per_token = torch.nn.functional.cross_entropy(
        logits.float().view(-1, cfg.vocab_size), y.reshape(-1), reduction="none"
    ).view(y.shape).cpu().numpy()

    for row, s in enumerate(group):
        # y は 1 つずれているので、位置 s+1+i の loss になる
        losses[s + 1 + WARM: s + 1 + cfg.context] = per_token[row, WARM:]
        scored[s + 1 + WARM: s + 1 + cfg.context] = True

    if at % (args.batch * 200) == 0:
        done = min(at + args.batch, len(starts))
        print(f"  {done:,}/{len(starts):,} 窓 ({done / len(starts) * 100:.1f}%)", flush=True)

print(f"採点できた {int(scored.sum()):,} / {len(ids):,} トークン")

# --- 残すものを決める ---

token_ids = torch.from_numpy(ids.astype(np.int64))
is_structural = protected[token_ids].numpy()

candidates = scored & ~is_structural
values = losses[candidates]
# low: 参照にとって自然なもの / high: 参照が驚くもの (原典寄り)
quantile = args.keep if args.mode == "low" else 1.0 - args.keep
threshold = float(np.quantile(values, quantile))

keep = np.zeros(len(ids), dtype=np.uint8)
keep[is_structural] = 1
keep[~scored] = 1                       # 採点できなかった端は残す (捨てる理由が無い)
picked = (losses <= threshold) if args.mode == "low" else (losses >= threshold)
keep[candidates & picked] = 1

out = corpus / f"{args.name}.keep.npy"
np.save(out, keep)

total = int(keep.sum())
print(f"\nしきい値 loss {threshold:.3f} ({args.mode})")
print(f"残す {total:,} / {len(ids):,} = {total / len(ids) * 100:.1f}%")
print(f"  うち構造トークン {int(is_structural.sum()):,}")
print(f"-> {out}")
print("\n**外部と evex で残り方が違うか確かめること。**外部の方が多く落ちて"
      "いなければ、採点が効いていない (pretrain.txt は外部が先・evex が後ろ)")
