"""チェックポイントを横並びで比べる。どれを載せるか決めるための道具。

    .venv-llm/bin/python scripts/llm/compare.py

val が最小の点と、文体が一番「らしい」点は一致しない見込み。数字では出ないので、
同じプロンプト・同じ乱数で全チェックポイントを回して読み比べる。

あわせて逐語コピーの率も出す。669万トークンを何周もするので、後半の
チェックポイントは実際の発言をそのまま再生している可能性が高い。
「その人が言いそうなこと」ではなく「その人が実際に言ったこと」が出ていないかは
val loss には現れないので、ここで見る。
"""

import argparse
import json
import os
import re
from pathlib import Path

import sentencepiece as spm
import torch

from model import Config, MicroLM

parser = argparse.ArgumentParser()
parser.add_argument("--corpus", default="corpus")
parser.add_argument("--out", default="scripts/llm/out")
parser.add_argument("--n", type=int, default=2, help="1 プロンプトあたりの生成数")
parser.add_argument("--max-new", type=int, default=60)
parser.add_argument("--threads", type=int, default=int(os.environ.get("OMP_NUM_THREADS", 4)))
args = parser.parse_args()

torch.set_num_threads(args.threads)
torch.set_grad_enabled(False)

corpus = Path(args.corpus)
sp = spm.SentencePieceProcessor(model_file=str(corpus / "tok.model"))
speakers = json.loads((corpus / "speakers.json").read_text(encoding="utf8"))
train_text = (corpus / "train.txt").read_text(encoding="utf8")
END_ID = sp.piece_to_id("<|end|>")

# 実際の使い方に近い形。話者トークンだけ渡すと文脈が無くて記号の羅列になる。
PROMPTS = [
    "<|conv|><|s3|>Cloudflare Containers ってどうなん<|s0|>",
    "<|conv|><|s0|>rebase 疲れた<|s3|>",
    "<|conv|><|other|>これバグってる？<|other|>",
]


def name_of(rank):
    return speakers[rank]["name"] if rank < len(speakers) else f"s{rank}"


def readable(text):
    out = text
    end = out.find("<|end|>")
    if end >= 0:
        out = out[:end]
    out = out.replace("<|conv|>", "").replace("<|re|>", "↩")
    out = re.sub(r"<\|s(\d+)\|>", lambda m: f"\n{name_of(int(m.group(1)))}: ", out)
    out = out.replace("<|other|>", "\nだれか: ").replace("<nl>", " / ")
    return out.strip()


def copy_rate(text):
    """生成文の 20 文字以上の断片が train にそのまま在るか。"""
    body = re.sub(r"<\|[^|]*\|>|<nl>|<[a-z]+>", " ", text)
    pieces = [s for s in re.split(r"[\s。、！？]+", body) if len(s) >= 20]
    hits = [s for s in pieces if s in train_text]
    return len(hits), max((len(s) for s in hits), default=0)


ckpts = sorted(
    Path(args.out).glob("ckpt-e*.pt"),
    key=lambda p: int(re.search(r"e(\d+)", p.name).group(1))
)
if not ckpts:
    raise SystemExit(f"チェックポイントが無い: {args.out}")

summary = []

for path in ckpts:
    blob = torch.load(path, map_location="cpu", weights_only=False)
    saved = blob["config"]
    cfg = Config(
        vocab_size=saved["vocab_size"], n_layers=saved["n_layers"], d_model=saved["d_model"],
        n_heads=saved["n_heads"], context=saved["context"], dropout=0.0, attn_dropout=0.0,
    )
    model = MicroLM(cfg)
    model.load_state_dict(blob["model"])
    model.eval()

    print(f"\n{'=' * 72}")
    print(f"epoch {blob['epoch']}  train {blob['train_loss']:.4f}  val {blob['val_loss']:.4f}")
    print("=" * 72)

    copies, longest = 0, 0
    for prompt in PROMPTS:
        ids = torch.tensor([sp.encode(prompt, out_type=int)], dtype=torch.long)
        for i in range(args.n):
            # 同じ乱数で回す。チェックポイント間の差だけを見たい
            torch.manual_seed(1000 + i)
            got = model.generate(
                ids.clone(), max_new_tokens=args.max_new,
                temperature=0.9, top_k=40, stop_id=END_ID
            )
            text = sp.decode(got[0].tolist())
            n, span = copy_rate(text[len(prompt):])
            copies += n
            longest = max(longest, span)
            print(f"\n--- {prompt[:40]}… #{i + 1}")
            print(readable(text))

    summary.append({
        "epoch": blob["epoch"], "val": blob["val_loss"],
        "copies": copies, "longest_copy": longest
    })
    print(f"\n[逐語コピー] 20文字以上でそのまま一致 {copies} 箇所 (最長 {longest} 文字)")

print(f"\n\n{'=' * 72}")
print("まとめ (val が最小の点と、文体が一番らしい点は一致しない)")
print("=" * 72)
print(f"{'epoch':>6} {'val':>9} {'逐語コピー':>12} {'最長':>6}")
for row in summary:
    print(f"{row['epoch']:>6} {row['val']:>9.4f} {row['copies']:>12} {row['longest_copy']:>6}")

best = min(summary, key=lambda r: r["val"])
print(f"\nval 最小: epoch {best['epoch']} ({best['val']:.4f})")
print("上の出力を読んで、val の数字ではなく「読めるか」で選ぶ。")
print("逐語コピーが増えている epoch は、実際の発言を思い出しているだけの可能性がある。")
