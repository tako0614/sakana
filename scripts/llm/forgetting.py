"""追加学習で元のモデルが何をどれだけ失ったかを測る。

    .venv-llm/bin/python scripts/llm/forgetting.py --base <dir> --tuned <dir> \
        --general docs --chat sft/val.jsonl

**「口調が移ったか」と「元の力が残っているか」は別の軸で、val では分けられない。**
学習に使った会話の val は下がって当然 (それを最小化している) なので、下がったことは
何も保証しない。元の力を見るには**学習に入っていない普通の文**で測るしかない。

出すのは2つの perplexity。

    general  学習に一切入っていない普通の日本語 (このリポジトリの docs)
    chat     学習に使ったのと同じ形の会話 (val 分割)

    general が上がって chat が下がっていれば、狙った通りの取引ができている。
    general の上がり方が極端なら、払い過ぎ (LoRA / replay / epoch を検討する)。

窓は学習と同じ長さで切る。長い文脈での劣化を見たいときは --seq を伸ばす —
学習は 1024 までしか見ていないので、そこを超えると差が開く見込み。
"""

import argparse
import json
import math
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

parser = argparse.ArgumentParser()
parser.add_argument("--base", required=True)
parser.add_argument("--tuned", required=True)
parser.add_argument("--general", default="docs", help="普通の日本語 (ディレクトリか .md)")
parser.add_argument("--chat", default=None, help="会話の val (.jsonl / text フィールド)")
parser.add_argument("--seq", type=int, default=1024)
parser.add_argument("--windows", type=int, default=12, help="各セットで測る窓の数")
parser.add_argument("--threads", type=int, default=10)
args = parser.parse_args()

torch.set_num_threads(args.threads)
torch.set_grad_enabled(False)

# tokenizer は base と tuned で同じ (追加学習で語彙は増やしていない)。
# 違っていたら窓の切り方が変わって比較にならないので、そこは確かめる
tok_base = AutoTokenizer.from_pretrained(args.base)
tok_tuned = AutoTokenizer.from_pretrained(args.tuned)
if tok_base.vocab_size != tok_tuned.vocab_size:
    raise SystemExit(f"語彙が違う: {tok_base.vocab_size} vs {tok_tuned.vocab_size}")


def read_general(where):
    path = Path(where)
    files = sorted(path.rglob("*.md")) if path.is_dir() else [path]
    parts = []
    for file in files:
        parts.append(file.read_text(encoding="utf8"))
    if not parts:
        raise SystemExit(f"普通の日本語が見つからない: {where}")
    return "\n\n".join(parts)


def read_chat(where):
    lines = Path(where).read_text(encoding="utf8").splitlines()
    texts = []
    for line in lines:
        if not line.strip():
            continue
        row = json.loads(line)
        texts.append(row["text"] if isinstance(row, dict) else str(row))
    return "\n".join(texts)


def windows(text, tok):
    ids = tok(text, add_special_tokens=False).input_ids
    usable = len(ids) // args.seq * args.seq
    if usable == 0:
        raise SystemExit(f"{args.seq} トークンに届かない ({len(ids)} トークン)")
    chunks = [ids[i: i + args.seq] for i in range(0, usable, args.seq)]
    return chunks[: args.windows], len(ids)


sets = {"general": read_general(args.general)}
if args.chat:
    sets["chat"] = read_chat(args.chat)

prepared = {}
for name, text in sets.items():
    chunks, total = windows(text, tok_base)
    prepared[name] = chunks
    print(f"{name}: {total:,} トークン → {len(chunks)} 窓 × {args.seq}")

results = {}

for label, where in (("base", args.base), ("tuned", args.tuned)):
    model = AutoModelForCausalLM.from_pretrained(where, dtype=torch.float32)
    model.eval()
    results[label] = {}

    for name, chunks in prepared.items():
        total = 0.0
        for chunk in chunks:
            x = torch.tensor([chunk], dtype=torch.long)
            total += model(input_ids=x, labels=x).loss.item()
        loss = total / len(chunks)
        results[label][name] = loss
        print(f"  {label:<6} {name:<8} loss {loss:.4f}  ppl {math.exp(min(20, loss)):8.2f}", flush=True)

    del model

print(f"\n{'セット':<10} {'base ppl':>10} {'tuned ppl':>11} {'倍率':>8}")
for name in prepared:
    b = math.exp(min(20, results["base"][name]))
    t = math.exp(min(20, results["tuned"][name]))
    print(f"{name:<10} {b:>10.2f} {t:>11.2f} {t / b:>7.2f}x")

print(
    "\ngeneral が上がって chat が下がっていれば狙った取引。"
    "\ngeneral の倍率が大きすぎるなら払い過ぎ (LoRA / replay / epoch を検討する)。"
)
