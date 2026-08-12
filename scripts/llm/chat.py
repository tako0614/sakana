"""evex と CLI で話す。

    .venv-llm/bin/python scripts/llm/chat.py
    .venv-llm/bin/python scripts/llm/chat.py --ckpt scripts/llm/out/ckpt-e10.pt

コマンド:
    /temp <数>   温度 (既定 0.9)
    /raw         生成の生トークンを見せる/隠す
    /reset       会話を捨てる
    /quit        終了

話者は会話ごとに出現順で振る相対トークン。あなたが <|a|>、evex が <|b|>。
実在の人物には紐づかないので「その人として書かせる」ことはできない。

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
parser.add_argument("--corpus", default="corpus")  # リポジトリ root から実行する前提
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

# 話者トークンの形式は世代で違うので、tokenizer から判定する。
#
#   evex-1: 実在の人物に紐づく <|s0|>..<|s47|> と <|other|>
#   evex-2: 会話ごとに振り直す <|a|>..<|h|> (身元を持たない)
#
# チェックポイントと tokenizer は対の関係なので、片方だけ差し替えると
# トークン ID が総入れ替えになって出力が崩れる (実際にやって `',ぴの` が出た)。
def has_piece(piece):
    return sp.piece_to_id(piece) != sp.unk_id()


if has_piece("<|a|>"):
    YOU, EVEX, GEN = "<|a|>", "<|b|>", 2
elif has_piece("<|other|>"):
    # evex-1 の bot は自分も相手も <|other|> で喋っていた
    YOU, EVEX, GEN = "<|other|>", "<|other|>", 1
else:
    raise SystemExit(f"{args.corpus}/tok.model が evex-1 でも evex-2 でもない")

ROLE_RE = r"<\|s\d+\|>|<\|other\|>|<\|end\|>|<\|conv\|>" if GEN == 1 \
    else r"<\|[a-hz]\|>|<\|end\|>|<\|conv\|>"

def resolve_ckpt(given):
    """指定が無い / 見つからないときは out/ の一番進んだ epoch を使う。

    `npm run chat` を引数なしで叩けるようにするため。掃きの出力
    (out/lr*/ckpt-e*.pt) は拾わない — 直下だけ見る。
    """
    path = Path(given)
    if path.exists():
        return path

    out = Path(__file__).resolve().parent / "out"
    found = sorted(
        out.glob("ckpt-e*.pt"),
        key=lambda q: int(re.search(r"e(\d+)", q.name).group(1)),
    )
    if not found:
        raise SystemExit(f"チェックポイントが無い: {given} も {out}/ckpt-e*.pt も見つからない")

    print(f"({given} が無いので {found[-1]} を使う)")
    return found[-1]


ckpt = resolve_ckpt(args.ckpt)
blob = torch.load(ckpt, map_location="cpu", weights_only=False)
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
    cut = re.search(ROLE_RE, text)
    body = text[: cut.start()] if cut else text
    for a, b in (("<|re|>", ""), ("<nl>", "\n"), ("<code>", "```\n"), ("</code>", "\n```")):
        body = body.replace(a, b)
    return body.strip()


# 会話は [(役トークン, 本文)] で持つ
history = []
temperature = args.temperature
show_raw = False

print(f"evex ({ckpt} / epoch {blob.get('epoch')} / val {blob.get('val_loss'):.4f})")
print(f"{blob['config']['n_layers']}層 {blob['config']['d_model']}次元 / "
      f"このサーバーの94万件だけで学習。一般知識はありません")
print(f"形式 evex-{GEN} / /temp /raw /reset /quit\n")


def build_prompt():
    parts = ["<|conv|>"]
    for token, text in history[-args.history:]:
        parts.append(token)
        parts.append(text)
    parts.append(EVEX)
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

    if line.startswith("/"):
        print("(/temp /raw /reset /quit)")
        continue

    history.append((YOU, normalize(line)))
    body, raw = generate_reply()
    history.append((EVEX, normalize(body)))

    print(f"evex: {body}")
    if show_raw:
        print(f"  raw: {raw!r}")
