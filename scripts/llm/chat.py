"""evex と CLI で話す。

    .venv-llm/bin/python scripts/llm/chat.py
    .venv-llm/bin/python scripts/llm/chat.py --ckpt scripts/llm/out/ckpt-e10.pt

コマンド:
    /as <名前|番号>   その人として返させる (話者を指定)
    /who              話者の一覧
    /temp <数>        温度 (既定 0.9)
    /raw              生成の生トークンを見せる/隠す
    /reset            会話を捨てる
    /quit             終了

正規化の本体は src/mimic/serialize.js。ここでは**人が打ち込むもの**に必要な分だけ
実装している (URL と改行)。`<@123>` のような Discord の記法は CLI では出てこない。
"""

import argparse
import re
import readline  # noqa: F401 - import するだけで行編集と履歴が効く
import sys
from pathlib import Path

import sentencepiece as spm
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import Config, MicroLM  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--corpus", default="corpus")
parser.add_argument("--ckpt", default="scripts/llm/out/ckpt-e10.pt")
parser.add_argument("--temperature", type=float, default=0.9)
parser.add_argument("--top-k", type=int, default=40)
parser.add_argument("--max-new", type=int, default=80)
parser.add_argument("--threads", type=int, default=8)
# 直近いくつを文脈にするか。学習時の会話は 20件 / 1200字で切ってあるので
# それより長い文脈を渡すと学習中に見ていない形になる。
parser.add_argument("--history", type=int, default=16)
args = parser.parse_args()

torch.set_num_threads(args.threads)
torch.set_grad_enabled(False)

corpus = Path(args.corpus)
sp = spm.SentencePieceProcessor(model_file=str(corpus / "tok.model"))
END_ID = sp.piece_to_id("<|end|>")

# 正規化が作った記号は発言ではない。出させると「(画像)」だけの返答になる
# (禁止前は実測 38%、禁止後 12%)。
BAN = [sp.piece_to_id(t) for t in ("<file>", "<url>", "<mention>", "<channel>", "<time>")]

import json  # noqa: E402

# speakers.json は2種類ある。build-corpus.mjs が出すもの (count / userId 付き) と、
# HF 公開用に ID と表示名を落としたもの (messages / 名前なし)。どちらでも読む。
speakers = json.loads((corpus / "speakers.json").read_text(encoding="utf8"))
for i, s in enumerate(speakers):
    s.setdefault("rank", i)
    s.setdefault("count", s.get("messages", 0))
    s.setdefault("name", f"s{s['rank']}")

blob = torch.load(args.ckpt, map_location="cpu", weights_only=False)
saved = blob["config"]
cfg = Config(
    vocab_size=saved["vocab_size"], n_layers=saved["n_layers"], d_model=saved["d_model"],
    n_heads=saved["n_heads"], context=saved["context"], dropout=0.0, attn_dropout=0.0,
)
model = MicroLM(cfg)
model.load_state_dict(blob["model"])
model.eval()


def normalize(text):
    """人が打ち込んだものを学習時の形にそろえる。本体は serialize.js。"""
    out = re.sub(r"https?://\S+", "<url>", text)
    return re.sub(r"\r\n|[\n\r  ]", "<nl>", out).strip()


def first_turn(text):
    """最初の1発言だけ取る。切らないと他人の発言まで作った長文になる。"""
    cut = re.search(r"<\|s\d+\|>|<\|other\|>|<\|end\|>|<\|conv\|>", text)
    body = text[: cut.start()] if cut else text
    for a, b in (("<|re|>", ""), ("<nl>", "\n"), ("<code>", "```\n"), ("</code>", "\n```")):
        body = body.replace(a, b)
    return body.strip()


def find_speaker(needle):
    """名前でも順位でも引く。"""
    if needle.isdigit() and int(needle) < len(speakers):
        return speakers[int(needle)]
    lowered = needle.lower()
    for s in speakers:
        if s["name"].lower() == lowered:
            return s
    for s in speakers:
        if lowered in s["name"].lower():
            return s
    return None


# 会話は [(話者トークン, 本文)] で持つ。自分の発言は <|other|> にする
# (bot と同じ扱い。特定の人に成り代わらせない)
history = []
voice = "<|other|>"
voice_name = "evex"
temperature = args.temperature
show_raw = False

print(f"evex ({args.ckpt} / epoch {blob.get('epoch')} / val {blob.get('val_loss'):.4f})")
print(f"{blob['config']['n_layers']}層 {blob['config']['d_model']}次元 / "
      f"このサーバーの94万件だけで学習。一般知識はありません")
print("/as <名前> で話者を指定、/who で一覧、/quit で終了\n")


def build_prompt():
    parts = ["<|conv|>"]
    for token, text in history[-args.history:]:
        parts.append(token)
        parts.append(text)
    parts.append(voice)
    return "".join(parts)


def generate_reply():
    prompt = build_prompt()
    ids = sp.encode(prompt, out_type=int)
    # context を超えたら後ろを残す (直近の会話が本題)
    ids = ids[-(cfg.context - 1):]
    tensor = torch.tensor([ids], dtype=torch.long)

    # 短すぎたら引き直す。禁止しても「これ」のような2文字が 12% 出る
    for _ in range(3):
        out = model.generate(
            tensor.clone(), max_new_tokens=args.max_new, temperature=temperature,
            top_k=args.top_k, stop_id=END_ID, ban_ids=BAN, min_new_tokens=2,
        )
        raw = sp.decode(out[0].tolist())[len(sp.decode(ids)):]
        body = first_turn(raw)
        if len(body) >= 3:
            return body, raw
    return body, raw


while True:
    try:
        line = input("> ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        break

    if not line:
        continue

    if line in ("/quit", "/exit", "/q"):
        break

    if line == "/reset":
        history = []
        print("(会話を捨てた)")
        continue

    if line == "/who":
        for s in speakers[:16]:
            print(f"  {s['rank']:>2} {s['name']:<24} {s['count']:>7}件")
        print(f"  (上位{len(speakers)}人。/as <名前|番号>)")
        continue

    if line == "/raw":
        show_raw = not show_raw
        print(f"(生トークン {'表示' if show_raw else '非表示'})")
        continue

    if line.startswith("/temp"):
        try:
            temperature = float(line.split()[1])
            print(f"(温度 {temperature})")
        except (IndexError, ValueError):
            print(f"(いまの温度 {temperature})")
        continue

    if line.startswith("/as"):
        needle = line[3:].strip()
        if not needle:
            voice, voice_name = "<|other|>", "evex"
            print("(話者の指定を外した)")
            continue

        found = find_speaker(needle)
        if not found:
            print(f"(「{needle}」は上位48人に居ない。/who で一覧)")
            continue

        voice, voice_name = found["token"], found["name"]
        print(f"(これから {voice_name} として返す。学習データに {found['count']:,}件)")
        continue

    if line.startswith("/"):
        print("(/as /who /temp /raw /reset /quit)")
        continue

    history.append(("<|other|>", normalize(line)))
    body, raw = generate_reply()
    history.append((voice, normalize(body)))

    print(f"{voice_name}: {body}")
    if show_raw:
        print(f"  raw: {raw!r}")
