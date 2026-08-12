"""Kaggle にそのまま入れられるノートブックを作る。

    .venv-llm/bin/python scripts/llm/make-kaggle-notebook.py

出力: dist/evex-3-kaggle.ipynb

finetune.py の中身を**そのまま埋め込む**。手書きのノートブックに写しを置くと
必ず古くなるので、ここで生成する。学習の本体は 1 箇所 (finetune.py) だけにする。

Kaggle を選んだ理由: 無料枠が週30時間、1セッション12時間、"Save Version → Run All"
でブラウザを閉じても走る。8 epoch が約5時間なので 1 セッションに収まる。
Colab の無料枠は4時間前後で切られるので 2〜3 回に分ける必要がある。
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = (ROOT / "scripts" / "llm" / "finetune.py").read_text(encoding="utf8")

DATASET = "tako080614/sakana-sft"
PUSH = "tako080614/evex-3"

INTRO = """# evex-3 — Qwen3-0.6B-Base にこのサーバーの口調を移す

## 動かす前に 2 つ

1. **Add-ons → Secrets** で `HF_TOKEN` を登録する (write 権限のあるトークン)。
   private のデータセットを読むのと、結果を push するのに使う。
2. 右の **Session options → Accelerator** を **GPU T4 x2** にする
   (使うのは 1 枚だが、T4 の枠はこれで取れる)。

そのあと右上の **Save Version → Save & Run All (Commit)**。
これでブラウザを閉じても走る。約5時間で終わる。

## 何をしているか

- 素の Qwen3-0.6B-**Base** を全パラメータ学習する。instruct 版だと
  「承知しました」の口調が焼き付いていて、7.46M トークンでは上書きしきれない
- 学習データは Discord の会話 39,050 件を `A: ` `B: ` の素のテキストにしたもの。
  独自トークンは足さない (足すとその埋め込みだけ未学習から始まる)
- epoch ごとに val と生成サンプルを残す。**val 最小が一番口調が濃いとは限らない**ので、
  最後に history.json を読んで選ぶ

## T4 で気をつけた点

- **bf16 が無い** (Turing) ので fp16 + GradScaler。重みは fp32 で持つ —
  fp16 のまま更新すると 5e-5 の変化が丸めで消える
- vocab が 151,936 あるので **logits がメモリの本体**。batch 8 だと fp32 コピーだけで
  5GB 行くので micro-batch は 2 にして、accum 8 で実効 16,384 tokens を保つ
- それでも OOM したら `--batch 1 --accum 16` に落とす
"""

RUN = f"""import os
from kaggle_secrets import UserSecretsClient

os.environ["HF_TOKEN"] = UserSecretsClient().get_secret("HF_TOKEN")

# 変えるならここ。5e-5 が全パラメータ学習の標準的な値。
# 口調がまだ薄ければ 1e-4 で回し直す (epoch ごとの重みは残るので比較できる)
LR = "5e-5"
EPOCHS = 8

!python finetune.py \\
  --dataset {DATASET} \\
  --push {PUSH} \\
  --epochs {{EPOCHS}} --lr {{LR}} \\
  --batch 2 --accum 8 --seq 1024 --keep 3
"""

cells = [
    {"cell_type": "markdown", "metadata": {}, "source": INTRO},
    {
        "cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [],
        # torch は Kaggle に入っている。transformers はローカルで動作を確かめた版に固定する
        "source": "%pip install -q transformers==5.15.0 -U huggingface_hub\n",
    },
    {
        "cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [],
        "source": f"%%writefile finetune.py\n{SCRIPT}",
    },
    {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": RUN},
]

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

out = ROOT / "dist" / "evex-3-kaggle.ipynb"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(notebook, ensure_ascii=False, indent=1) + "\n", encoding="utf8")

print(f"{out}  {out.stat().st_size / 1024:.0f} KB")
print(f"finetune.py を {len(SCRIPT.splitlines())} 行そのまま埋め込んだ")
print(f"dataset {DATASET} / push {PUSH}")
