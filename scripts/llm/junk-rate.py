"""正規化記号だけの返答が何割出るかを、チェックポイント間で比べる。

    python scripts/llm/junk-rate.py --corpus corpus out/v1-lr1e-3 out/v1-lr1e-3-mask

**val では決まらないものを測る道具。** 損失から記号を外す (`--mask-tokens`) と
val の分母が変わるので、外した run と外さない run の val は直接比べられない。
そもそもマスクの狙いは val を下げることではなく、`<url>` や `<file>` だけの
返答を減らすこと — evex-1 では返答の 38% がそれだった。効いたかどうかは
生成を数えるしかない。

数えるのは3つ:

    記号だけ  正規化記号を落とすと何も残らない返答 (bot に出せない)
    空        1文字も出なかった返答
    使える    それ以外

推論時に記号を禁止する手 (server.py の ban) は**使わない**。禁止すれば当然 0 に
なるが、それは「モデルが記号を出さなくなった」ことの確認にはならない。
"""

import argparse
import json
import re
import sys
from pathlib import Path

import sentencepiece as spm
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import Config, MicroLM  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("dirs", nargs="+", help="比べる run のディレクトリ")
parser.add_argument("--corpus", default="corpus")
parser.add_argument("--epoch", type=int, default=None, help="既定は各 run の最後")
parser.add_argument("--n", type=int, default=12, help="1 プロンプトあたりの生成数")
parser.add_argument("--max-new", type=int, default=60)
parser.add_argument("--threads", type=int, default=8)
args = parser.parse_args()

torch.set_num_threads(args.threads)
torch.set_grad_enabled(False)

corpus = Path(args.corpus)
sp = spm.SentencePieceProcessor(model_file=str(corpus / "tok.model"))
END_ID = sp.piece_to_id("<|end|>")

# 実際の使い方に近い形にする。話者トークンだけ渡すと文脈が無くて記号の羅列になり、
# 「記号だけ」の率が実際より高く出る (測りたいのは会話に混ざったときの率)。
#
# **トークンは決め打ちにしない。**世代で語彙が変わる (evex-1/2 は <|other|>、
# evex-3 は <|a|>..<|h|>)。無いトークンを書くとバイト分解された文字列を渡すことに
# なり、「記号だけ」の率が実際とは別のものを測ってしまう。
def piece(*candidates):
    for name in candidates:
        if sp.piece_to_id(name) != sp.unk_id():
            return name
    return candidates[-1]


ANON = piece("<|a|>", "<|other|>")
PROMPTS = [
    f"<|conv|><|s3|>Cloudflare Containers ってどうなん<|s0|>",
    f"<|conv|><|s0|>rebase 疲れた<|s3|>",
    f"<|conv|>{ANON}これバグってる？{ANON}",
    f"<|conv|><|s1|>今日ひま？<|s0|>",
    f"<|conv|><|s0|>それでいいと思う<|s1|>",
    f"<|conv|><|s2|>どこで止まってる？<|s0|>",
    f"<|conv|>{ANON}おはよう<|s0|>",
    f"<|conv|><|s0|>やば{ANON}",
]

# 正規化が作った記号。これだけの返答は bot が実際には出せない
SYMBOLS = re.compile(r"<(?:url|file|mention|channel|time)>|<nl>|<\|[^|]*\|>|[\s　]+")


# 発言の頭に付く返信の印。evex-3 以降は `<|re|><|相手|>本文` の順に書く。
# **相手を「次の話者」と読むと本文が丸ごと落ちる** — それで「記号だけ」が
# 42.2% に見えていた (モデルではなく数え方の問題)。serialize.js と同じ規則。
REPLY_MARK = re.compile(r"^<\|re\|>(?:<\|s\d+\|>|<\|other\|>|<\|[a-hz]\|>)?")


def first_turn(text):
    """次の話者トークンか <|end|> で切る (bot 側 ownTurns と同じ範囲)。"""
    body = REPLY_MARK.sub("", text)
    cut = re.search(r"<\|s\d+\|>|<\|other\|>|<\|[a-hz]\|>|<\|end\|>|<\|conv\|>", body)
    return body[: cut.start()] if cut else body


def classify(reply):
    body = first_turn(reply)
    if not SYMBOLS.sub("", body):
        # 記号を落として何も残らない。空文字も同じ穴に落ちるので先に分ける
        return "空" if not body.strip() else "記号だけ"
    return "使える"


def load(path):
    blob = torch.load(path, map_location="cpu", weights_only=False)
    saved = blob["config"]
    cfg = Config(
        vocab_size=saved["vocab_size"], n_layers=saved["n_layers"], d_model=saved["d_model"],
        n_heads=saved["n_heads"], context=saved["context"], dropout=0.0, attn_dropout=0.0,
    )
    model = MicroLM(cfg)
    model.load_state_dict(blob["model"])
    model.eval()
    return model, blob


rows = []

for name in args.dirs:
    run = Path(name)
    found = sorted(run.glob("ckpt-e*.pt"), key=lambda p: int(re.search(r"e(\d+)", p.name).group(1)))
    if args.epoch is not None:
        found = [p for p in found if int(re.search(r"e(\d+)", p.name).group(1)) == args.epoch]
    if not found:
        raise SystemExit(f"チェックポイントが無い: {run}")

    path = found[-1]
    model, blob = load(path)

    history = {}
    hist_path = run / "history.json"
    if hist_path.exists():
        loaded = json.loads(hist_path.read_text(encoding="utf8"))
        history = loaded[-1] if loaded else {}

    tally = {"使える": 0, "記号だけ": 0, "空": 0}
    shown = []

    for prompt in PROMPTS:
        ids = torch.tensor([sp.encode(prompt, out_type=int)], dtype=torch.long)
        for i in range(args.n):
            # 同じ乱数で回す。run 間の差だけを見たい
            torch.manual_seed(1000 + i)
            got = model.generate(
                ids.clone(), max_new_tokens=args.max_new,
                temperature=0.9, top_k=40, stop_id=END_ID
            )
            reply = sp.decode(got[0].tolist())[len(prompt):]
            kind = classify(reply)
            tally[kind] += 1
            if len(shown) < 6:
                shown.append(f"    [{kind}] {first_turn(reply)!r}")

    total = sum(tally.values())
    rows.append((run.name, blob.get("epoch"), history, tally, total))

    print(f"\n=== {run.name} / epoch {blob.get('epoch')} / {total} 回")
    print(f"  val {history.get('val')} / val_raw {history.get('val_raw')}")
    for kind, count in tally.items():
        print(f"  {kind:<6} {count:>4} ({count / total * 100:5.1f}%)")
    print("\n".join(shown))

print(f"\n{'=' * 60}")
print(f"{'run':<20} {'記号だけ':>10} {'空':>8} {'使える':>10}")
for name, epoch, history, tally, total in rows:
    print(
        f"{name:<20} {tally['記号だけ'] / total * 100:9.1f}% "
        f"{tally['空'] / total * 100:7.1f}% {tally['使える'] / total * 100:9.1f}%"
    )
