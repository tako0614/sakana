"""学習したモデルで生成する (手元での確認用)。

    # 会話を勝手に始めさせる
    .venv-llm/bin/python scripts/llm/sample.py --ckpt scripts/llm/out/ckpt-e4.pt

    # 話者を指定して続きを書かせる
    .venv-llm/bin/python scripts/llm/sample.py --speaker 3 --prompt "Cloudflare どうなん"

    # 学習データの逐語コピーになっていないか見る
    .venv-llm/bin/python scripts/llm/sample.py --check-copy

`--speaker` は corpus/speakers.json の順位。誰が誰かはそのファイルで引ける。
"""

import argparse
import json
import re
from pathlib import Path

import sentencepiece as spm
import torch

from model import Config, MicroLM

parser = argparse.ArgumentParser()
parser.add_argument("--corpus", default="corpus")
parser.add_argument("--ckpt", default="scripts/llm/out/ckpt-e8.pt")
parser.add_argument("--speaker", type=int, default=None, help="話者の順位 (speakers.json)")
parser.add_argument("--reply-as", type=int, default=None, help="この話者に返させる")
parser.add_argument("--prompt", default="")
parser.add_argument("--n", type=int, default=5)
parser.add_argument("--max-new", type=int, default=150)
parser.add_argument("--temperature", type=float, default=0.9)
parser.add_argument("--top-k", type=int, default=40)
parser.add_argument("--check-copy", action="store_true", help="学習データとの一致を調べる")
args = parser.parse_args()

corpus = Path(args.corpus)
sp = spm.SentencePieceProcessor(model_file=str(corpus / "tok.model"))
speakers = json.loads((corpus / "speakers.json").read_text(encoding="utf8"))

blob = torch.load(args.ckpt, map_location="cpu", weights_only=False)
saved = blob["config"]
cfg = Config(
    vocab_size=saved["vocab_size"], n_layers=saved["n_layers"], d_model=saved["d_model"],
    n_heads=saved["n_heads"], context=saved["context"], dropout=0.0
)
model = MicroLM(cfg)
model.load_state_dict(blob["model"])
model.eval()

print(f"{args.ckpt} (epoch {blob.get('epoch')} / val {blob.get('val_loss'):.4f})")

end_id = sp.piece_to_id("<|end|>")


def build_prompt():
    parts = ["<|conv|>"]
    if args.speaker is not None:
        parts.append(f"<|s{args.speaker}|>")
    if args.prompt:
        parts.append(args.prompt)
    # 相手に返させたいなら、次の話者トークンまで置いて続きを書かせる
    if args.reply_as is not None:
        parts.append(f"<|s{args.reply_as}|>")
    return "".join(parts)


def pretty(text):
    """話者トークンを名前に戻して読める形にする。"""
    text = text.replace("<|conv|>", "").replace("<|end|>", "\n[終]")
    text = text.replace("<nl>", "\n").replace("<|re|>", "↩")

    def name(match):
        rank = int(match.group(1))
        who = speakers[rank]["name"] if rank < len(speakers) else f"s{rank}"
        return f"\n{who}: "

    text = re.sub(r"<\|s(\d+)\|>", name, text)
    return text.replace("<|other|>", "\nだれか: ").strip()


prompt = build_prompt()
ids = torch.tensor([sp.encode(prompt, out_type=int)], dtype=torch.long)

generated = []
for i in range(args.n):
    torch.manual_seed(i)
    got = model.generate(
        ids.clone(), max_new_tokens=args.max_new,
        temperature=args.temperature, top_k=args.top_k, stop_id=end_id
    )
    text = sp.decode(got[0].tolist())
    generated.append(text)
    print(f"\n--- {i + 1} ---")
    print(pretty(text))

# --- 逐語コピーの確認 ---
#
# 669万トークンを何周もするので、モデルは実際の発言をそのまま再生できる。
# 「その人が言いそうなこと」ではなく「その人が実際に言ったこと」が出ていないか、
# 生成文の断片が train.txt にそのまま存在するかで見る。
if args.check_copy:
    train = (corpus / "train.txt").read_text(encoding="utf8")
    print("\n=== 逐語コピーの確認 ===")

    for i, text in enumerate(generated, 1):
        body = re.sub(r"<\|[^|]*\|>|<nl>|<[a-z]+>", " ", text)
        # 20 文字以上の連続が train にそのまま在るなら、それは思い出しているだけ
        hits = [s for s in re.split(r"[\s。、！？]+", body) if len(s) >= 20 and s in train]
        longest = max((len(s) for s in hits), default=0)
        print(f"  {i}: 20文字以上でそのまま一致 {len(hits)} 箇所 (最長 {longest} 文字)")
        if hits:
            print(f"     例: {hits[0][:60]!r}")
