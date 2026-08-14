"""Kaggle にそのまま入れられるノートブックを作る。

    .venv-llm/bin/python scripts/llm/make-kaggle-notebook.py ft     # Qwen の追加学習
    .venv-llm/bin/python scripts/llm/make-kaggle-notebook.py evex   # ゼロから学習

出力: dist/evex-ft-kaggle.ipynb / dist/evex-3-kaggle.ipynb

学習の本体 (finetune.py / train.py + model.py) を**そのまま埋め込む**。手書きの
ノートブックに写しを置くと必ず古くなるので、ここで生成する。本体は 1 箇所だけ。

Kaggle を選んだ理由: 無料枠が週30時間、1セッション12時間、"Save Version → Run All"
でブラウザを閉じても走る。Colab の無料枠は4時間前後で切られる。

**枠の残りはノートブック内の表示を信じないこと。** あれは古い値が出る
(実際に 09:06 と出ていて settings では 24:58 だった)。kaggle.com/settings で見る。
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LLM = ROOT / "scripts" / "llm"

MODE = (sys.argv[1] if len(sys.argv) > 1 else "ft").lower()
if MODE not in {"ft", "evex", "runner"}:
    raise SystemExit("使い方: make-kaggle-notebook.py [ft|evex|runner]")

DATASET = "tako080614/sakana-sft"          # private。実在の会話が入っている

# --- Qwen3-0.6B の追加学習 (evex-ft-N) ---

FT_PUSH = "tako080614/evex-ft-4"

FT_INTRO = """# evex-ft — Qwen3-0.6B にこのサーバーの口調を移す

## 動かす前に 2 つ

1. **Add-ons → Secrets** で `HF_TOKEN` を登録する (write 権限のあるトークン)。
   private のデータセットを読むのと、結果を push するのに使う。
2. 右の **Session options → Accelerator** を **GPU T4 x2** にする
   (使うのは 1 枚だが、T4 の枠はこれで取れる)。

そのあと右上の **Save Version → Save & Run All (Commit)**。
これでブラウザを閉じても走る。

## T4 で気をつけた点

- **bf16 が無い** (Turing) ので fp16 + GradScaler。重みは fp32 で持つ —
  fp16 のまま更新すると 5e-5 の変化が丸めで消える
- vocab が 151,936 あるので **logits がメモリの本体**。micro-batch 2 / accum 8 で
  実効 16,384 tokens。OOM したら `--batch 1 --accum 16` に落とす
"""

FT_RUN = f"""import os
from kaggle_secrets import UserSecretsClient

os.environ["HF_TOKEN"] = UserSecretsClient().get_secret("HF_TOKEN")

!python finetune.py \\
  --dataset {DATASET} \\
  --push {FT_PUSH} \\
  --epochs 2 --lr 5e-5 \\
  --batch 2 --accum 8 --seq 1024 --keep 3
"""

# --- ゼロから学習 (evex-3) ---

EVEX_PUSH = "tako080614/evex-3"
CORPUS_DIR = "corpus-v4"

EVEX_INTRO = f"""# evex-3 — このサーバーのログだけで一から学習する

## 動かす前に 2 つ

1. **Add-ons → Secrets** で `HF_TOKEN` を登録する (write 権限のあるトークン)。
2. **Session options → Accelerator** を **GPU T4 x2** にする。

そのあと **Save Version → Save & Run All (Commit)**。

## 何をしているか

`{DATASET}` (private) に置いた `{CORPUS_DIR}/` を読んで、**2 本**回す:

| | d_model | 層 | head | context | パラメータ |
|---|---|---|---|---|---|
| **evex-3** | 384 | 8 | 6 | 1024 | 約 15.8M |
| 対照 | 256 | 6 | 4 | 512 | 約 5.87M (evex-2 と同一) |

対照を同じコーパスで回すのは、**良くなったのがコーパスのおかげか大きさのおかげか**を
分けるため。1 本が数分なので、ここをけちる理由が無い。

## コーパス v4 で変えたこと

evex-2 のコーパスには evex-ft-2 / ft-3 で効いた工夫が入っていなかった。全部
コーパス側の話なので記号に翻訳して持ち込んである:

- 上位 **147 人**に固有トークン (evex-1 は 48 人 / 被覆 85.3% → 96.6%)
- **返信先を残す** `<|re|><|sM|>` (真偽だけだと誰に答えたかを捨てている)
- 窓を 60分 / 60件 / 3600字 に (検索用の 15分 / 20件 / 1200字 は学習には短い)
- 噛み合った箇所と長い発言を切り出して重く見せる (train の 12.5% / 24.5%)
- 窓の切り方を 3 通りにして 2.08 倍に増やす

train **23,950,617 トークン** (evex-2 は 6,479,221 = 3.70 倍)。

## epoch の数え方に注意

窓の切り方で 2.08 倍にしてあるので、**1 epoch が evex-2 の約 2 epoch にあたる**。
evex-2 の 12 epoch に相当するのは **5〜6 epoch**。ここを間違えると丸暗記する。

## T4 で気をつけた点

- **cuda に載せるだけでは速くならない。** 15.8M は 1 トークン 94 MFLOP で、
  T4 の fp32 は 8.1 TFLOPS しかない。fp16 の tensor core (65 TFLOPS) に乗せる
- bf16 は sm_80 以上。T4 は sm_75 なので fp16 + GradScaler になる
- **トークン列は最初に一度だけ GPU に載せる。**毎 step CPU で窓を作ると、
  1 step が数十 ms しかないのでそこが支配的になる
- val だけは fp32 で測る。evex-1 / evex-2 の val と桁を揃えるため
"""

EVEX_SETUP = f"""import os
from kaggle_secrets import UserSecretsClient
from huggingface_hub import snapshot_download

os.environ["HF_TOKEN"] = UserSecretsClient().get_secret("HF_TOKEN")

# private のデータセットから コーパスだけ取る。
# **speakers.json は入れていない** (userId と表示名が入っているので手元だけ)
snapshot_download(
    repo_id="{DATASET}", repo_type="dataset", local_dir=".",
    allow_patterns=["{CORPUS_DIR}/*"], token=os.environ["HF_TOKEN"],
)
!ls -la {CORPUS_DIR}/
"""

# 速度を先に測る。ここを飛ばすと「12 時間で終わらない設定」に気付けない
EVEX_BENCH = f"""%env LLM_DMODEL=384
%env LLM_LAYERS=8
%env LLM_HEADS=6
%env LLM_CONTEXT=1024
!python train.py --corpus {CORPUS_DIR} --bench --batch 24 --lr 1e-3
"""

EVEX_RUN = f"""# --- evex-3 本命 15.8M ---
%env LLM_DMODEL=384
%env LLM_LAYERS=8
%env LLM_HEADS=6
%env LLM_CONTEXT=1024
!python train.py --corpus {CORPUS_DIR} --out out-15m --epochs 6 --batch 24 --lr 1e-3
"""

EVEX_CONTROL = f"""# --- 対照 5.87M (evex-2 と同じ形・同じ新コーパス) ---
%env LLM_DMODEL=256
%env LLM_LAYERS=6
%env LLM_HEADS=4
%env LLM_CONTEXT=512
!python train.py --corpus {CORPUS_DIR} --out out-6m --epochs 6 --batch 24 --lr 1e-3
"""

# **学習が終わるたびに押す。**まとめて最後に押すと、枠切れやセッション断で
# 全部消える。1 本目 (本命) を先に確保してから 2 本目に進む
def push_cell(folder, prefix):
    return f"""from huggingface_hub import HfApi
api = HfApi(token=os.environ["HF_TOKEN"])
api.create_repo("{EVEX_PUSH}", private=True, exist_ok=True)

# tok.model も一緒に上げる。重みだけあっても読めない
!cp {CORPUS_DIR}/tok.model {folder}/

api.upload_folder(repo_id="{EVEX_PUSH}", folder_path="{folder}",
                  path_in_repo="{prefix}", commit_message="evex-3 {prefix}")
print("pushed {prefix} → https://huggingface.co/{EVEX_PUSH} (private)", flush=True)
"""


# --- ノートブックを使わない経路 ---
#
# Kaggle の「Import Notebook」は a11y ツリーに出ないダイアログなので、
# 自動で .ipynb を入れられなかった。**代わりに全部入りの run.py を private
# データセットに置いて、ノートブック側は 6 行だけにする。**
# 貼るのが 6 行なら手でもすぐ直せるし、中身を直すのは HF に上げ直すだけで済む。

RUNNER = f'''"""evex-3 を GPU で回す。Kaggle でも HF Jobs でも同じものが動く。

ノートブック側はこれだけ:

    import os
    from kaggle_secrets import UserSecretsClient
    os.environ["HF_TOKEN"] = UserSecretsClient().get_secret("HF_TOKEN")
    !pip install -q sentencepiece -U huggingface_hub
    from huggingface_hub import hf_hub_download
    exec(open(hf_hub_download("{DATASET}", "runner/run.py",
         repo_type="dataset", token=os.environ["HF_TOKEN"])).read())
"""

import os
import subprocess
import sys
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download

DATASET = "{DATASET}"
PUSH = "{EVEX_PUSH}"
CORPUS = "{CORPUS_DIR}"
TOKEN = os.environ["HF_TOKEN"]

# train.txt の実トークン数 (train-tokenizer.py が測った値)。持ち時間から
# epoch を逆算するのに使う。コーパスを作り直したら stats.json から取り直す
TRAIN_TOKENS = 23_950_617

# 本体は 2 ファイル。ここに丸ごと埋め込んである (写しを手で持たないため)
Path("model.py").write_text(MODEL_PY, encoding="utf8")
Path("train.py").write_text(TRAIN_PY, encoding="utf8")

# **speakers.json は入っていない** (userId と表示名が入っているので手元だけ)
snapshot_download(repo_id=DATASET, repo_type="dataset", local_dir=".",
                  allow_patterns=[CORPUS + "/*"], token=TOKEN)
print("corpus:", sorted(p.name for p in Path(CORPUS).iterdir()), flush=True)

api = HfApi(token=TOKEN)
api.create_repo(PUSH, private=True, exist_ok=True)


def env_for(size):
    d_model, layers, heads, context = size
    return {{**os.environ,
            "LLM_DMODEL": str(d_model), "LLM_LAYERS": str(layers),
            "LLM_HEADS": str(heads), "LLM_CONTEXT": str(context)}}


def bench(size, batch=24):
    """実測の tok/s を返す。**本番の前に必ず通す。**

    Kaggle の週枠は 30 時間で、残りが 1 時間ということが普通にある。
    速度を測らずに epoch を決め打ちすると、押す前に切られて全部消える。
    """
    cmd = [sys.executable, "train.py", "--corpus", CORPUS, "--batch", str(batch), "--bench"]
    print("\\n$ " + " ".join(cmd), flush=True)
    done = subprocess.run(cmd, env=env_for(size), check=True,
                          capture_output=True, text=True)
    print(done.stdout[-2000:], flush=True)

    for line in done.stdout.splitlines():
        if line.startswith("実測"):
            return float(line.split()[1].replace(",", "").replace("tok/s", ""))
    raise RuntimeError("bench の tok/s を読めなかった")


def epochs_for(rate, minutes, tokens=TRAIN_TOKENS, hi=6):
    """持ち時間に収まる epoch 数。上限は 6 (evex-2 の 12 epoch 相当)。

    **下限を 2 にしていたのが間違いだった。**13,223 tok/s のとき 32 分に収まるのは
    1.06 epoch なのに、下限で 2 epoch に切り上げて 60 分の予定になっていた
    (持ち時間を守るための計算が、持ち時間を破る方向に働いていた)。
    収まらないなら 1 epoch にして、**足りないことを表示する**。
    """
    fits = int(rate * minutes * 60 // tokens)
    if fits < 1:
        need = tokens / rate / 60
        print(f"⚠ 1 epoch に {{need:.0f}} 分かかる (持ち時間 {{minutes:.0f}} 分)。"
              f"1 epoch で回すが学習は足りない", flush=True)
    return max(1, min(hi, fits))


def run(size, epochs, batch=24, lr="1e-3"):
    """学習して出力ディレクトリを返す。

    **落ちても例外にしない。**train.py は epoch ごとにチェックポイントを書くので、
    途中で死んでもそこまでの重みは残っている。ここで上げると push まで進まず、
    回した時間が丸ごと消える (epoch 1 のサンプル生成で落ちて実際に消した)。
    """
    d_model, layers = size[0], size[1]
    out = f"out-{{d_model}}x{{layers}}"
    cmd = [sys.executable, "train.py", "--corpus", CORPUS, "--batch", str(batch),
           "--lr", lr, "--out", out, "--epochs", str(epochs)]

    print("\\n$ " + " ".join(cmd), flush=True)
    done = subprocess.run(cmd, env=env_for(size), check=False)
    if done.returncode != 0:
        print(f"⚠ train.py が {{done.returncode}} で終了。"
              f"残っているチェックポイントだけ押す", flush=True)
    return out


def push(out, prefix):
    """**1 本終わるたびに押す。**まとめて最後にすると枠切れで全部消える。"""
    found = sorted(Path(out).glob("ckpt-e*.pt")) if Path(out).exists() else []
    if not found:
        print(f"⚠ {{out}} にチェックポイントが無いので押さない", flush=True)
        return

    subprocess.run(["cp", f"{{CORPUS}}/tok.model", out], check=True)   # 重みだけでは読めない
    api.upload_folder(repo_id=PUSH, folder_path=out, path_in_repo=prefix,
                      commit_message=f"evex-3 {{prefix}}")
    print(f"pushed {{prefix}} ({{len(found)}} epoch) → https://huggingface.co/{{PUSH}}", flush=True)


BIG = (384, 8, 6, 1024)     # evex-3 本命    約 15.8M
SMALL = (256, 6, 4, 512)    # 対照 (evex-2 と同じ形) 約 5.87M

# 持ち時間 (分)。Kaggle の週枠が残り 1 時間でも収まるように配る。
# 環境変数で伸ばせる — 枠に余裕がある週は EVEX_BIG_MIN=60 などにする
BIG_MINUTES = float(os.environ.get("EVEX_BIG_MIN", 32))
SMALL_MINUTES = float(os.environ.get("EVEX_SMALL_MIN", 12))

big_rate = bench(BIG)
big_epochs = epochs_for(big_rate, BIG_MINUTES)
print(f"\\n本命 {{big_rate:,.0f}} tok/s → {{BIG_MINUTES:.0f}} 分で {{big_epochs}} epoch", flush=True)

# **本命を先に回して押し切る。**対照はそのあと (途中で切れても本命は残る)
push(run(BIG, big_epochs), "15m")

small_rate = bench(SMALL)
small_epochs = epochs_for(small_rate, SMALL_MINUTES)
print(f"\\n対照 {{small_rate:,.0f}} tok/s → {{SMALL_MINUTES:.0f}} 分で {{small_epochs}} epoch", flush=True)
push(run(SMALL, small_epochs), "6m")

print("\\n完了", flush=True)
'''


def code(source):
    return {"cell_type": "code", "metadata": {}, "execution_count": None,
            "outputs": [], "source": source}


def markdown(source):
    return {"cell_type": "markdown", "metadata": {}, "source": source}


def embed(name):
    """学習の本体をノートブックに書き出すセル。写しを手で持たないための仕掛け。"""
    return code(f"%%writefile {name}\n{(LLM / name).read_text(encoding='utf8')}")


if MODE == "runner":
    # 本体を文字列として先頭に置く。書き出す側と書き出される側を 1 ファイルにする
    body = "".join(
        f"{name.removesuffix('.py').upper()}_PY = r'''"
        + (LLM / name).read_text(encoding="utf8").replace("'''", "\\x27\\x27\\x27")
        + "'''\n\n"
        for name in ("model.py", "train.py")
    ) + RUNNER

    out = ROOT / "dist" / "evex-3-run.py"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(body, encoding="utf8")

    print(f"{out}  {out.stat().st_size / 1024:.0f} KB")
    print("次: private データセットの runner/run.py として上げる")
    print(f"  hf upload {DATASET} {out} runner/run.py --repo-type dataset")
    raise SystemExit(0)

if MODE == "ft":
    cells = [
        markdown(FT_INTRO),
        # torch は Kaggle に入っている。transformers はローカルで確かめた版に固定する
        code("%pip install -q transformers==5.15.0 -U huggingface_hub\n"),
        embed("finetune.py"),
        code(FT_RUN),
    ]
    out = ROOT / "dist" / "evex-ft-kaggle.ipynb"
    embedded = ["finetune.py"]
else:
    cells = [
        markdown(EVEX_INTRO),
        code("%pip install -q sentencepiece -U huggingface_hub\n"),
        # train.py が `from model import Config, MicroLM` するので両方要る
        embed("model.py"),
        embed("train.py"),
        code(EVEX_SETUP),
        markdown("## 速度を測る\n\n**本番の前に必ず通す。**"
                 "ここで 1 本あたりの所要が分かる (12 時間に収まるか)。"),
        code(EVEX_BENCH),
        markdown("## 本命 15.8M\n\n**先にこちらを回して押し切る。**"
                 "週の残り枠が少ないので、途中で切れても本命だけは残る順にする。"),
        code(EVEX_RUN),
        code(push_cell("out-15m", "15m")),
        markdown("## 対照 5.87M\n\n同じコーパス・同じ epoch。"
                 "これが無いと「コーパスのおかげか大きさのおかげか」を分けられない。"
                 "**ここで枠が切れても本命は上に押してある。**"),
        code(EVEX_CONTROL),
        code(push_cell("out-6m", "6m")),
    ]
    out = ROOT / "dist" / "evex-3-kaggle.ipynb"
    embedded = ["model.py", "train.py"]

notebook = {
    "cells": cells,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python"},
        "accelerator": "GPU",
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(notebook, ensure_ascii=False, indent=1) + "\n", encoding="utf8")

print(f"{out}  {out.stat().st_size / 1024:.0f} KB")
for name in embedded:
    lines = len((LLM / name).read_text(encoding="utf8").splitlines())
    print(f"  {name} を {lines} 行そのまま埋め込んだ")
print(f"dataset {DATASET} / push {FT_PUSH if MODE == 'ft' else EVEX_PUSH}")
