"""epoch ごとの重みを同じお題で叩いて読み比べる。

    python scripts/llm/compare-epochs.py --dir out --labels sft/labels.json
    python scripts/llm/compare-epochs.py --dir out --push tako080614/evex-ft-1-preview --pick 3

## なぜ val だけで選べないか

val は「平均的にどれだけ当てられるか」しか見ていない。今回の主目的は**個人の口調**で、
それは val に出ない。実際に走らせた 4 epoch では:

    epoch 1  val 2.6577   'あ、' 'それすき' 'いいな'
    epoch 2  val 2.5898   'どうやってやるのが一番安全？' '怖いよぉ'      ← val 最小
    epoch 3  val 2.6396   'あーそっかたしかに' 'そんなんあるんか'         ← 読める
    epoch 4  val ?

val 最小は epoch 2 だが、epoch 3 の方が口語として自然に読める。**両方見る必要がある。**

## 見るもの

1. 同じお題を別人に振って**読み分けられるか** (これが本命)
2. 日本語が崩れていないか
3. 逐語コピー — 学習データの行をそのまま吐いていないか
4. 記号だけ・短すぎる返答の率 (evex-1 は素で 38% だった)
"""

import argparse
import collections
import json
import random
import re
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

parser = argparse.ArgumentParser()
parser.add_argument("--dir", default="out", help="epoch-N を含む親ディレクトリ")
parser.add_argument("--labels", default="sft/labels.json")
parser.add_argument("--train", default=None, help="逐語コピーを見るための train.jsonl")
parser.add_argument("--people", type=int, default=4, help="上位何人を叩くか")
parser.add_argument("--times", type=int, default=3, help="1 組み合わせあたりの回数")
parser.add_argument("--max-new", type=int, default=48)
parser.add_argument("--threads", type=int, default=8)
parser.add_argument("--seed", type=int, default=0)
parser.add_argument("--push", default=None, help="選んだ epoch を上げる repo id")
parser.add_argument("--pick", type=int, default=None, help="--push と一緒に使う epoch 番号")
args = parser.parse_args()

torch.set_num_threads(args.threads)
torch.set_grad_enabled(False)

root = Path(args.dir)
epochs = sorted(root.glob("epoch-*"), key=lambda p: int(p.name.split("-")[1]))
if not epochs:
    raise SystemExit(f"{root}/epoch-* が無い")

def top_labels(n):
    """叩く相手を決める。

    labels.json があればそれを使うが、**無くても train.jsonl から数えられる**。
    あの表は Discord の実 ID を含むので HF に上げていない。行頭のラベルを数えれば
    同じ順位が出るので、身元を持ち出さずに済む。
    """
    path = Path(args.labels)
    if path.exists():
        rows = json.loads(path.read_text(encoding="utf8"))
        return [row["label"] for row in rows[:n]]

    if not args.train:
        raise SystemExit("--labels も --train も無いと誰を叩けばいいか分からない")

    found = collections.Counter()
    for line in Path(args.train).read_text(encoding="utf8").split("\n"):
        if not line:
            continue
        for turn in json.loads(line)["text"].split("\n")[1:]:
            head = turn.split(": ", 1)
            # 英字1文字の役は名前を持たない人。個人の口調は入っていないので外す
            if len(head) == 2 and len(head[0]) > 1:
                found[head[0]] += 1

    return [label for label, _ in found.most_common(n)]


people = top_labels(args.people)
print(f"叩く相手: {' / '.join(people)}\n")

# 学習データの行。逐語コピーの判定に使う (完全一致だけ見る)
seen = set()
if args.train:
    for line in Path(args.train).read_text(encoding="utf8").split("\n"):
        if not line:
            continue
        for turn in json.loads(line)["text"].split("\n"):
            body = turn.split(": ", 1)
            if len(body) == 2 and len(body[1]) >= 6:
                seen.add(body[1])
    print(f"逐語コピーの照合先: {len(seen):,} 行\n")

TOPICS = ["これバグってる？", "眠い", None]

# 次の話者の行で切る。名前ラベルは 12 字以内で `:` を含まない
NEXT_TURN = re.compile(r"\n[^\n:]{1,12}:[ 　]")


def first_turn(text):
    cut = NEXT_TURN.search(text)
    body = text[: cut.start()] if cut else text
    return re.split(r"\n#(?:ch\d+|other)\b", body)[0].strip()


history = {}
if (root / "history.json").exists():
    for row in json.loads((root / "history.json").read_text(encoding="utf8")):
        history[row["epoch"]] = row

for path in epochs:
    n = int(path.name.split("-")[1])
    row = history.get(n, {})
    print(f"{'=' * 70}")
    print(f"{path.name}  val {row.get('val_loss', '?')}")
    print(f"{'=' * 70}")

    tok = AutoTokenizer.from_pretrained(str(path))
    model = AutoModelForCausalLM.from_pretrained(str(path), dtype=torch.float32).eval()

    copied = 0
    short = 0
    total = 0

    for topic in TOPICS:
        head = f"お題「{topic}」" if topic else "お題なし"
        print(f"\n--- {head}")
        for who in people:
            # 同じ乱数から始めて、人だけを変える。差が人由来だと分かるように
            torch.manual_seed(args.seed)
            random.seed(args.seed)

            prompt = "#ch2\n" + (f"A: {topic}\n" if topic else "") + f"{who}:"
            ids = tok(prompt, return_tensors="pt")

            got = []
            for _ in range(args.times):
                out = model.generate(
                    **ids, max_new_tokens=args.max_new, do_sample=True,
                    temperature=0.9, top_k=40, min_p=0.05, repetition_penalty=1.1,
                    pad_token_id=tok.eos_token_id,
                )
                body = first_turn(tok.decode(out[0], skip_special_tokens=True)[len(prompt):])
                total += 1
                if len(body) < 3:
                    short += 1
                if body in seen:
                    copied += 1
                    body += "  ← 逐語コピー"
                got.append(body)

            print(f"  {who:<14} {' / '.join(repr(g) for g in got)}")

    print(f"\n  短すぎ {short}/{total} / 逐語コピー {copied}/{total}")
    del model

if args.push:
    if args.pick is None:
        raise SystemExit("--push には --pick で epoch 番号を指定する")

    source = root / f"epoch-{args.pick}"
    if not source.exists():
        raise SystemExit(f"{source} が無い")

    from huggingface_hub import HfApi
    api = HfApi()
    api.create_repo(args.push, private=True, exist_ok=True)
    api.upload_folder(repo_id=args.push, folder_path=str(source),
                      commit_message=f"epoch {args.pick}")
    # 学習の記録も一緒に。どの epoch を選んだかが後から分かるように
    if (root / "history.json").exists():
        api.upload_file(repo_id=args.push, path_or_fileobj=str(root / "history.json"),
                        path_in_repo="history.json")
    print(f"\npushed epoch {args.pick} → https://huggingface.co/{args.push} (private)")
