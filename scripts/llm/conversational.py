"""「会話できているか」と「evex のままか」を数える。

    .venv-llm/bin/python scripts/llm/conversational.py --model <dir> --corpus sft-v5

val loss は「口調が移ったか」しか測らない。evex-ft-1 は val 2.5415 まで下げたのに
`git rebase と merge の違いって何` に `まじ？` と返す。逆に外の対話データを混ぜ過ぎると
「中の Qwen が出てくる」— どちらも loss には出ないので、生成を数えるしかない。

見るのは4つ。**全部このサーバー自身の val を同じ尺度で測って地の値にする** —
「多い/少ない」は絶対値では判断できない。

    答えた率      20字以上で返した割合。フィラー (`まじ？`) を数えないため
    噛み合い率    質問に出た内容語が返答にも出た割合。話を受けているか
    助手っぽさ    敬体で終わる率 / markdown 記法の率。instruct の口調が漏れると上がる
    未知語率      コーパスに一度も無い語の割合。**Qwen の地が出ると上がる**

地の値 (sft-v4 実測): 20字以上 25.6% / 敬体 2.4% / markdown 0.6% / 未知語 14.8%
"""

import argparse
import json
import re
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True, help="重みのディレクトリ")
parser.add_argument("--corpus", default="sft-v5", help="地の値と語彙を取る sft ディレクトリ")
parser.add_argument("--seeds", type=int, default=3)
parser.add_argument("--max-new", type=int, default=80)
parser.add_argument("--threads", type=int, default=10)
parser.add_argument("--label", default=None, help="喋らせる人 (既定は labels.json の最多)")
parser.add_argument("--show", type=int, default=8, help="出力を何本見せるか")
args = parser.parse_args()

torch.set_num_threads(args.threads)
torch.set_grad_enabled(False)

corpus = Path(args.corpus)
LINE = re.compile(r"^([^\n:]{1,12}): ([\s\S]*)$")
# 内容語だけ拾う。助詞や1文字は噛み合いの判定に使えない
WORD = re.compile(r"[一-龥ァ-ヶー]{2,}|[A-Za-z][A-Za-z0-9_.-]{2,}")
POLITE = re.compile(r"(です|ます|ください|ましょう|でしょう)[。！？\s]*$")
MARKDOWN = re.compile(r"^[-*#>]|\*\*")


def bodies(name):
    """sft の分割から発言の本文だけを取り出す。"""
    path = corpus / f"{name}.jsonl"
    found = []
    for line in path.read_text(encoding="utf8").split("\n"):
        if not line:
            continue
        for row in json.loads(line)["text"].split("\n"):
            m = LINE.match(row)
            if m and m.group(2).strip():
                found.append(m.group(2).strip())
    return found


train_bodies = bodies("train")
val_bodies = bodies("val")

vocab = set()
for body in train_bodies:
    for word in WORD.findall(body):
        vocab.add(word.lower())


def score(texts):
    """4つの指標をまとめて出す。"""
    if not texts:
        return None
    words = [w.lower() for t in texts for w in WORD.findall(t)]
    return {
        "n": len(texts),
        "long": sum(1 for t in texts if len(t) >= 20) / len(texts),
        "polite": sum(1 for t in texts if POLITE.search(t)) / len(texts),
        "markdown": sum(1 for t in texts if MARKDOWN.search(t)) / len(texts),
        "oov": (sum(1 for w in words if w not in vocab) / len(words)) if words else 0.0,
        "chars": sum(len(t) for t in texts) / len(texts),
    }


# --- 地の値 ---

base_line = score(val_bodies)

# --- 生成 ---

label = args.label
if label is None:
    rows = json.loads((corpus / "labels.json").read_text(encoding="utf8"))
    rows.sort(key=lambda r: -r.get("count", 0))
    label = rows[0]["label"]

# 疑問で終わるものだけを使う。「答えるか」を測りたいので、雑談は混ぜない。
# 話題はこのサーバーで実際に出るものに寄せる (未知語率の判定を歪めないため)
QUESTIONS = [
    "git rebase と merge の違いって何",
    "TCP と UDP どっちが速いん",
    "docker の bind mount と volume の違いわかる？",
    "Cloudflare Workers と Pages ってどう違うの",
    "python と node どっちがいいと思う？",
    "型つけるのめんどくない？",
    "この エラー どう直すん",
    "sqlite と postgres どっち使うべき",
    "vim と vscode どっち派？",
    "ドメインどこで取るのが安い？",
]

tok = AutoTokenizer.from_pretrained(args.model)
model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float32)
model.eval()

NEXT_TURN = re.compile(r"\n[^\n:]{1,12}:[ 　]")


def first_turn(text):
    cut = NEXT_TURN.search(text)
    body = text[: cut.start()] if cut else text
    return body.split("\n#")[0].strip()


replies = []
overlaps = []
shown = []

for question in QUESTIONS:
    asked = {w.lower() for w in WORD.findall(question)}
    prompt = f"#ch2\nA: {question}\n{label}:"
    ids = tok(prompt, return_tensors="pt")

    for seed in range(args.seeds):
        torch.manual_seed(1000 + seed)
        out = model.generate(
            **ids, max_new_tokens=args.max_new, do_sample=True, temperature=0.9,
            top_k=40, min_p=0.05, repetition_penalty=1.1, pad_token_id=tok.eos_token_id
        )
        reply = first_turn(tok.decode(out[0], skip_special_tokens=True)[len(prompt):])
        if not reply:
            continue
        replies.append(reply)

        got = {w.lower() for w in WORD.findall(reply)}
        overlaps.append(1.0 if (asked & got) else 0.0)
        if len(shown) < args.show:
            shown.append(f"  {question} → {reply[:90]!r}")

got = score(replies)
overlap = sum(overlaps) / len(overlaps) if overlaps else 0.0

pct = lambda x: f"{x * 100:5.1f}%"  # noqa: E731

print(f"{args.model} / 喋らせた人 {label} / {len(replies)} 本\n")
print("\n".join(shown))
print(f"\n{'':<12} {'このモデル':>10} {'地の値 (val)':>12}")
print(f"{'20字以上':<12} {pct(got['long']):>10} {pct(base_line['long']):>12}")
print(f"{'噛み合い':<12} {pct(overlap):>10} {'—':>12}")
print(f"{'敬体':<12} {pct(got['polite']):>10} {pct(base_line['polite']):>12}")
print(f"{'markdown':<12} {pct(got['markdown']):>10} {pct(base_line['markdown']):>12}")
print(f"{'未知語':<12} {pct(got['oov']):>10} {pct(base_line['oov']):>12}")
print(f"{'平均の長さ':<12} {got['chars']:9.0f}字 {base_line['chars']:11.0f}字")
print("\n未知語が地の値より大きく上なら Qwen の地が出ている。"
      "\n敬体と markdown が上なら instruct の口調が漏れている。")
