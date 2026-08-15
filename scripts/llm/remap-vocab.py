"""チェックポイントを**別の語彙に写す**。

    .venv-llm/bin/python scripts/llm/remap-vocab.py \\
      --ckpt evex41/evex4-s2/ckpt-e8.pt --from-corpus corpus-v8 --to-corpus corpus-v10 \\
      --out evex41/remapped.pt

--- なぜ要るのか ---

Rho-1 の採点には「evex で仕上げた参照モデル」が要る。ところが evex-5 の語彙は
`<|hi|>` を足したぶん**トークン番号がずれている**ので、evex-4.1 の重みを
そのまま当てると別の語を指す。

**中身 (piece) で対応を取れば写せる。**語彙は同じテキストからほぼ同じ条件で
学習しているので、実際にはほとんどの piece が両方にある。共通のものは行を
そのまま持ってきて、新しい語彙にしか無いものだけ平均で埋める。

学習し直すより桁違いに安い (0 円・数秒) し、**参照は「evex らしさの物差し」
として使うだけ**なので、多少の欠けは効かない。
"""

import argparse
from pathlib import Path

import sentencepiece as spm
import torch

from model import Config, MicroLM

parser = argparse.ArgumentParser()
parser.add_argument("--ckpt", required=True)
parser.add_argument("--from-corpus", required=True, help="その ckpt を学習した語彙")
parser.add_argument("--to-corpus", required=True, help="写し先の語彙")
parser.add_argument("--out", required=True)
args = parser.parse_args()

src = spm.SentencePieceProcessor(model_file=str(Path(args.from_corpus) / "tok.model"))
dst = spm.SentencePieceProcessor(model_file=str(Path(args.to_corpus) / "tok.model"))

blob = torch.load(args.ckpt, map_location="cpu", weights_only=False)
state = blob["model"]
cfg = Config(**{k: v for k, v in blob["config"].items()
                if k in Config.__dataclass_fields__})

src_index = {src.id_to_piece(i): i for i in range(src.get_piece_size())}
n_new = dst.get_piece_size()

# **語彙が変わる = 埋め込み表の行を並べ替える。**head は tying しているので
# embed だけ直せば良い (保存側も head を落としている)
embed = state["embed.weight"]
fresh = embed.mean(dim=0, keepdim=True).repeat(n_new, 1)
# 平均だけだと全部同じ向きになるので、元の表の散らばりで少し揺らす
fresh += torch.randn_like(fresh) * embed.std().item() * 0.1

hit = 0
missing = []
for new_id in range(n_new):
    piece = dst.id_to_piece(new_id)
    old_id = src_index.get(piece)
    if old_id is not None and old_id < embed.size(0):
        fresh[new_id] = embed[old_id]
        hit += 1
    else:
        missing.append(piece)

state["embed.weight"] = fresh
blob["config"]["vocab_size"] = n_new
blob["model"] = state

model = MicroLM(Config(**{k: v for k, v in blob["config"].items()
                          if k in Config.__dataclass_fields__}))
model.load_state_dict(state)          # 形が合うことをここで確かめる

torch.save(blob, args.out)
print(f"{args.from_corpus} ({src.get_piece_size()}) -> {args.to_corpus} ({n_new})")
print(f"  そのまま写せた {hit:,} / {n_new:,} ({hit / n_new * 100:.1f}%)")
print(f"  新しい語彙にしか無い {len(missing):,}: {missing[:8]}")
print(f"-> {args.out}")
if hit / n_new < 0.9:
    print("\n⚠ 一致が 9 割を切っている。語彙が別物すぎて参照として使えないかもしれない")
