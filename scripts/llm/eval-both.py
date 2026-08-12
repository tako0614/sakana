"""同じ val セットを**両方の尺度**で測り直す。

    python scripts/llm/eval-both.py --corpus corpus out/v1-lr1e-3 out/v1-lr1e-3-mask

`--mask-tokens` を付けた run と付けない run では val の分母が違う (記号を外すと
その位置が平均に入らない)。片方が素の val しか残していないと「良くなった/悪くなった」
を誤読するので、**同じチェックポイントを両方の尺度で測って表にする。**

    素      記号 (<url> <file> ...) も予測対象に含める尺度
    マスク  記号を損失から外す尺度 = 実際に読まれる語だけの尺度

乱数もバッチ数も train.py の evaluate と同じにしてあるので、history.json の
数字と突き合わせられる。
"""

import argparse
import re
import sys
from pathlib import Path

import numpy as np
import sentencepiece as spm
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import Config, MicroLM  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("dirs", nargs="+")
parser.add_argument("--corpus", default="corpus")
parser.add_argument("--batch", type=int, default=24)
parser.add_argument("--iters", type=int, default=40)
parser.add_argument("--threads", type=int, default=8)
args = parser.parse_args()

torch.set_num_threads(args.threads)
torch.set_grad_enabled(False)

corpus = Path(args.corpus)
sp = spm.SentencePieceProcessor(model_file=str(corpus / "tok.model"))
val_ids = np.load(corpus / "val.u16.npy")

MASKED_PIECES = ("<file>", "<url>", "<mention>", "<channel>", "<time>")
masked_ids = [sp.piece_to_id(p) for p in MASKED_PIECES if sp.piece_to_id(p) != sp.unk_id()]
IGNORE = -1


def batches(ids, context, batch_size, generator, mask):
    """train.py の batches と同じ切り方・同じ乱数。"""
    high = len(ids) - context - 1
    ban = torch.tensor(masked_ids, dtype=torch.long) if mask else None

    while True:
        starts = torch.randint(0, high, (batch_size,), generator=generator)
        block = np.stack([ids[s: s + context + 1] for s in starts.tolist()])
        chunk = torch.from_numpy(block.astype(np.int64))
        x, y = chunk[:, :-1], chunk[:, 1:]
        if ban is not None:
            y = y.masked_fill(torch.isin(y, ban), IGNORE)
        yield x, y


def measure(model, context, mask):
    local = torch.Generator().manual_seed(1234)
    stream = batches(val_ids, context, args.batch, local, mask)
    total = 0.0
    for _ in range(args.iters):
        x, y = next(stream)
        _, loss = model(x, y)
        total += loss.item()
    return total / args.iters


rows = []

for name in args.dirs:
    run = Path(name)
    found = sorted(run.glob("ckpt-e*.pt"), key=lambda p: int(re.search(r"e(\d+)", p.name).group(1)))
    if not found:
        raise SystemExit(f"チェックポイントが無い: {run}")

    blob = torch.load(found[-1], map_location="cpu", weights_only=False)
    saved = blob["config"]
    cfg = Config(
        vocab_size=saved["vocab_size"], n_layers=saved["n_layers"], d_model=saved["d_model"],
        n_heads=saved["n_heads"], context=saved["context"], dropout=0.0, attn_dropout=0.0,
    )
    model = MicroLM(cfg)
    model.load_state_dict(blob["model"])
    model.eval()

    raw = measure(model, cfg.context, mask=False)
    masked = measure(model, cfg.context, mask=True)
    rows.append((run.name, blob.get("epoch"), raw, masked))
    print(f"{run.name} / epoch {blob.get('epoch')}: 素 {raw:.4f} / マスク {masked:.4f}")

print(f"\n{'run':<22} {'epoch':>5} {'素 val':>9} {'マスク val':>11}")
for name, epoch, raw, masked in rows:
    print(f"{name:<22} {epoch:>5} {raw:>9.4f} {masked:>11.4f}")

if len(rows) == 2:
    (an, _, ar, am), (bn, _, br, bm) = rows
    print(f"\n{bn} - {an}: 素 {br - ar:+.4f} / マスク {bm - am:+.4f}")
    print("マスク側が負なら、実際に読まれる語の予測は良くなっている")
