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
    文章の ppl    `--judge` に別のモデルを渡すと、生成文がそもそも文章として
                  成り立っているかを外から採点する

**文章の ppl は「低いほど良い」ではない。** 本物の発言を同じ審査で測った値との比で見る:

    比 > 1.5   崩れている (別モデルから見て当てにくい)
    比 ≈ 1     本物と同じ手触り
    比 < 0.5   無難すぎる — 本物より当てやすい = evex の手触りが薄い

evex-ft-1 (epoch 2) の実測は **0.19x** で、崩れてはいないが無難に寄っている。
本物の Discord 発言は身内ネタ・断片・誤字だらけで外から見れば読みにくいので、
そこに近づくのが「evex らしさ」になる。

地の値 (sft-v5 実測 / val): 20字以上 33.4% / 敬体 3.0% / markdown 0.3% / 未知語 14.8%
"""

import argparse
import json
import math
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
# 「文章として成り立っているか」を別のモデルに採点させる。
# 自分自身で測ると崩れた文でも自信満々に低い loss を出すので、独立した審査が要る。
# 素の Qwen はこのサーバーの俗語を低く見るので、**同じ審査で val の本物の発言も
# 測って**、そこを地の値にする (未知語率と同じ考え方)。
parser.add_argument("--judge", default=None, help="流暢さを採点させる別モデルのディレクトリ")
parser.add_argument("--judge-sample", type=int, default=200, help="地の値に使う val の発言数")
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

# 逐語コピーの判定に使う。切り出しを増やすと「覚えたものをそのまま出す」危険が上がる
# (sft-v5 は噛み合い 12.3% + 長い発言 25.6% = 38% が切り出し)
train_set = set(train_bodies)

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
        # 学習データの発言と完全一致。「その人が言いそうなこと」ではなく
        # 「実際に言ったこと」を出していたら、それは覚えただけ
        "verbatim": sum(1 for t in texts if t in train_set) / len(texts),
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

# --- 文章として成り立っているか ---
#
# 生成文を**別のモデル**に読ませて perplexity を取る。崩れた文は当てにくいので上がる。
# 判定は絶対値ではなく **val の本物の発言を同じ審査で測った値との比**で見る —
# このサーバーの発言は俗語だらけで、素の Qwen から見れば元々当てにくい。
judged = None
if args.judge:
    del model                                    # 2つ同時に持つと CPU の RAM が厳しい
    j_tok = AutoTokenizer.from_pretrained(args.judge)
    j_model = AutoModelForCausalLM.from_pretrained(args.judge, dtype=torch.float32)
    j_model.eval()

    def fluency(texts):
        """1 発言ずつ loss を取って平均する (短文なので窓は要らない)。"""
        total, count = 0.0, 0
        for text in texts:
            ids = j_tok(text, return_tensors="pt").input_ids
            if ids.shape[1] < 2:
                continue
            total += j_model(input_ids=ids, labels=ids).loss.item()
            count += 1
        return total / count if count else float("nan")

    # 地の値は長さをそろえて選ぶ。短い発言ばかりだと ppl が下がるので、
    # 生成文と同じくらいの長さの本物と比べないと意味がない
    lo = min(len(t) for t in replies) if replies else 0
    similar = [t for t in val_bodies if lo <= len(t) <= max(len(t) for t in replies)]
    judged = {
        "model": math.exp(min(20, fluency(replies))),
        "real": math.exp(min(20, fluency(similar[: args.judge_sample]))),
        "n_real": len(similar[: args.judge_sample]),
    }
    del j_model

pct = lambda x: f"{x * 100:5.1f}%"  # noqa: E731

print(f"{args.model} / 喋らせた人 {label} / {len(replies)} 本\n")
print("\n".join(shown))
print(f"\n{'':<12} {'このモデル':>10} {'地の値 (val)':>12}")
print(f"{'20字以上':<12} {pct(got['long']):>10} {pct(base_line['long']):>12}")
print(f"{'噛み合い':<12} {pct(overlap):>10} {'—':>12}")
print(f"{'敬体':<12} {pct(got['polite']):>10} {pct(base_line['polite']):>12}")
print(f"{'markdown':<12} {pct(got['markdown']):>10} {pct(base_line['markdown']):>12}")
print(f"{'未知語':<12} {pct(got['oov']):>10} {pct(base_line['oov']):>12}")
print(f"{'逐語コピー':<12} {pct(got['verbatim']):>10} {'—':>12}")
print(f"{'平均の長さ':<12} {got['chars']:9.0f}字 {base_line['chars']:11.0f}字")
if judged:
    print(f"{'文章の ppl':<12} {judged['model']:9.1f} {judged['real']:11.1f}"
          f"  ({judged['n_real']} 本の本物と比較 / 審査 {Path(args.judge).name})")
    ratio = judged["model"] / judged["real"]
    print(f"{'':12} 比 {ratio:.2f}x — "
          + ("崩れている (別モデルから見て当てにくい)" if ratio > 1.5
             else "本物と同じ手触り" if ratio > 0.5
             else "無難すぎる (本物より当てやすい = evex の手触りが薄い)"))
print("\n未知語が地の値より大きく上なら Qwen の地が出ている。"
      "\n敬体と markdown が上なら instruct の口調が漏れている。")
