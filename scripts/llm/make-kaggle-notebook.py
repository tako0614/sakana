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

EVEX_PUSH = "tako080614/evex-3.5"
CORPUS_DIR = "corpus-v5"

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

RUNNER = f'''# /// script
# requires-python = ">=3.10"
# dependencies = ["torch", "numpy", "sentencepiece", "huggingface_hub"]
# ///
"""evex-3.5 を GPU で回す。Kaggle でも HF Jobs でも同じものが動く。

HF Jobs:
    hf jobs uv run --flavor l4x1 --secrets HF_TOKEN --timeout 2h dist/evex-3-run.py

上の PEP 723 ヘッダを uv が読んで依存を入れる。torch は既定の wheel に
CUDA が同梱されているので、それでそのまま GPU が使える。

ノートブック側はこれだけ:

    import os
    from kaggle_secrets import UserSecretsClient
    os.environ["HF_TOKEN"] = UserSecretsClient().get_secret("HF_TOKEN")
    !pip install -q sentencepiece -U huggingface_hub
    from huggingface_hub import hf_hub_download
    exec(open(hf_hub_download("{DATASET}", "runner/run.py",
         repo_type="dataset", token=os.environ["HF_TOKEN"])).read())
"""

import json
import os
import subprocess
import sys
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download

DATASET = "{DATASET}"
PUSH = "{EVEX_PUSH}"
CORPUS = os.environ.get("EVEX_CORPUS", "{CORPUS_DIR}")
TOKEN = os.environ["HF_TOKEN"]

# 実トークン数 (train-tokenizer.py が測った値)。持ち時間から epoch を逆算する。
# コーパスを作り直したら stats.json から取り直す
PRETRAIN_TOKENS = 209_636_220       # 段1: 外部 146.7M + evex 62.9M (evex が 30.0%)
TRAIN_TOKENS = 44_484_559           # 段2: evex だけ (切り方 8 通り + 切り出し)
REACTED_TOKENS = 692_050            # 段3: **使わない** (evex-4 で噛み合いが 53.3 → 36.7)

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
            "LLM_HEADS": str(heads), "LLM_CONTEXT": str(context),
            # evex-5 の形。**既定は切ってある** — 環境変数で入れる
            "LLM_PLE": os.environ.get("EVEX_PLE", "0"),
            "LLM_DPLE": os.environ.get("EVEX_DPLE", "64"),
            "LLM_QK_NORM": os.environ.get("EVEX_QK_NORM", "0"),
            # **断片化で落ちるのを防ぐ。**30M / batch 48 は bench (200 step) を
            # 通ったのに本番の 1 step 目で OOM した。空きは 838 MiB あるのに
            # 「reserved but unallocated が 962 MiB」という典型的な断片化で、
            # 1.12 GiB の連続領域が取れなかった。可変セグメントにすると繋がる
            "PYTORCH_CUDA_ALLOC_CONF": os.environ.get(
                "PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")}}


# batch と compile。**実測で決めた既定** (t4-small / 18.88M):
#   batch 24            56,194 tok/s
#   batch 48            OOM (語彙ヘッドの logits が 2.25 GiB)
#   batch 48 + compile  74,140 tok/s  ← compile は速いだけでなくメモリも減る
#   batch 96 + compile  OOM
BATCH = int(os.environ.get("EVEX_BATCH", 48))
COMPILE = os.environ.get("EVEX_COMPILE", "1") == "1"


def bench(size, batch=BATCH, compile_on=COMPILE, strict=True):
    """実測の tok/s を返す。**本番の前に必ず通す。**

    Kaggle の週枠は 30 時間で、残りが 1 時間ということが普通にある。
    速度を測らずに epoch を決め打ちすると、押す前に切られて全部消える。
    """
    cmd = [sys.executable, "train.py", "--corpus", CORPUS, "--batch", str(batch), "--bench"]
    if compile_on:
        cmd += ["--compile"]
    print("\\n$ " + " ".join(cmd), flush=True)

    # **握りつぶさずに流す。**capture_output にしていたら、l4x1 で
    # 「cuda を使わない」と出ていたのが見えないまま CPU で 24 分回り続けた。
    # 1 行ずつ出しながら、必要な行だけ拾う
    rate = None
    proc = subprocess.Popen(cmd, env=env_for(size), stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        print(line.rstrip(), flush=True)
        if line.startswith("実測"):
            rate = float(line.split()[1].replace(",", "").replace("tok/s", ""))
    proc.wait()
    if rate is None:
        # 速度の振りでは OOM も情報なので、止めずに None を返せるようにする
        if not strict:
            return None
        raise RuntimeError("bench の tok/s を読めなかった")

    # **GPU に乗らなかったら止める。**CPU で回すと 1 本 10 時間コースで、
    # 課金だけ進んで何も残らない
    if rate < 20_000 and strict:
        raise SystemExit(f"{{rate:,.0f}} tok/s しか出ていない。GPU に乗っていない可能性が高いので止める")
    return rate


def pick_batch(size):
    """乗る batch を**測って**決める。落ちたら半分にして試す。

    **形を変えると乗る batch も変わる。**19M では 48 が通ったが、30M や
    context 2048 では同じ 48 で OOM する。決め打ちのまま投げると、段1 の
    1 step 目で落ちて job ごと無駄になる (回せる job は限られている)。
    bench は 200 step なので、1 段あたり数分の保険で済む。
    """
    batch = BATCH
    while batch >= 8:
        rate = bench(size, batch=batch, compile_on=COMPILE, strict=False)
        if rate and rate >= 20_000:
            print(f"batch {{batch}} で {{rate:,.0f}} tok/s", flush=True)
            # **bench を通っても本番で落ちることがある。**bench は train.txt を
            # 200 step 回すだけで、途中保存も勾配フックも無い。実際 30M は
            # bench を通ってから本番の 1 step 目で OOM した。ぎりぎりを避けて
            # 1 段下げる余地を残す (EVEX_BATCH_MARGIN=0 で切れる)
            if os.environ.get("EVEX_BATCH_MARGIN", "1") == "1" and batch > 8:
                print(f"  安全側に batch {{batch // 2}} で回す "
                      f"(EVEX_BATCH_MARGIN=0 で無効化)", flush=True)
                return batch // 2, rate * 0.95
            return batch, rate
        print(f"batch {{batch}} は乗らなかった。半分にする", flush=True)
        batch //= 2
    raise SystemExit("batch 8 でも乗らない。形かハードを見直す")


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


def run(size, epochs, batch=BATCH, lr="1e-3", train_name="train", init=None, tag="",
        max_tokens=0, save_steps=0):
    """学習して出力ディレクトリを返す。

    **落ちても例外にしない。**train.py は epoch ごとにチェックポイントを書くので、
    途中で死んでもそこまでの重みは残っている。ここで上げると push まで進まず、
    回した時間が丸ごと消える (epoch 1 のサンプル生成で落ちて実際に消した)。
    """
    d_model, layers = size[0], size[1]
    out = f"out-{{d_model}}x{{layers}}{{tag}}"
    cmd = [sys.executable, "train.py", "--corpus", CORPUS, "--batch", str(batch),
           "--lr", lr, "--out", out, "--epochs", str(epochs),
           "--train-name", train_name]
    if init:
        cmd += ["--init", init]
    # 等計算量で振るときの上限 (実測 tok/s × 分)
    if max_tokens:
        cmd += ["--max-tokens", str(max_tokens)]
    # 振りの軸。環境変数で渡してここで train.py の引数に直す
    if os.environ.get("EVEX_WD"):
        cmd += ["--wd-mode", os.environ["EVEX_WD"]]
    if os.environ.get("EVEX_SPEAKER_LR"):
        cmd += ["--speaker-lr-cap", os.environ["EVEX_SPEAKER_LR"]]
    if COMPILE:
        cmd += ["--compile"]
    # evex-5 の学習側の軸。**渡さなければ全部これまでどおり**
    for flag, key in (("--optimizer", "EVEX_OPTIMIZER"), ("--schedule", "EVEX_SCHEDULE"),
                      ("--decay-frac", "EVEX_DECAY_FRAC"), ("--z-loss", "EVEX_Z_LOSS"),
                      ("--loss-chunks", "EVEX_LOSS_CHUNKS")):
        if os.environ.get(key):
            cmd += [flag, os.environ[key]]
    if os.environ.get("EVEX_DOC_MASK") == "1":
        cmd += ["--doc-mask"]
    # Rho-1 の採点結果。段1 にだけ掛ける (段2 は evex 本体なので全部使う)
    keep = os.environ.get("EVEX_KEEP_MASK")
    if keep and train_name == "pretrain":
        cmd += ["--keep-mask", f"{{CORPUS}}/{{keep}}"]
    # 長い epoch の途中でも書く。段1 は 179M トークンを 1 epoch で回すので、
    # 33 分のあいだ 1 度も書かないと事故で全部消える (実際に消した)
    if save_steps:
        cmd += ["--save-steps", str(save_steps)]

    print("\\n$ " + " ".join(cmd), flush=True)
    done = subprocess.run(cmd, env=env_for(size), check=False)
    if done.returncode != 0:
        print(f"⚠ train.py が {{done.returncode}} で終了。"
              f"残っているチェックポイントだけ押す", flush=True)
    return out


def last_ckpt(out):
    """その run で一番進んだチェックポイント。段2 の初期値に使う。"""
    found = sorted(Path(out).glob("ckpt-e*.pt"),
                   key=lambda p: int(p.stem.removeprefix("ckpt-e")))
    return str(found[-1]) if found else None


def best_ckpt(out):
    """**val が最小の** epoch。段3 の初期値はこちらでなければならない。

    段1 が強くなってから、段2 は 1 epoch で val が底を打って以降は
    丸暗記になる (実測: 4.7410 → 4.7852 → ... → 5.0172)。最後の epoch から
    段3 を始めると、**一番過学習した重みを土台にする**ことになる
    (実際にそれをやって段3 が 5.0413 まで悪化した)。
    """
    history = Path(out, "history.json")
    if not history.exists():
        return last_ckpt(out)

    rows = [r for r in json.loads(history.read_text(encoding="utf8"))
            if r.get("val_loss") is not None]
    if not rows:
        return last_ckpt(out)

    best = min(rows, key=lambda r: r["val_loss"])
    found = Path(out, f"ckpt-e{{best['epoch']}}.pt")
    print(f"段3 の初期値は val 最小の epoch {{best['epoch']}} "
          f"(val {{best['val_loss']:.4f}}) を使う", flush=True)
    return str(found) if found.exists() else last_ckpt(out)


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


# 形。**振りの候補**でもある (d_model, layers, heads, context)。
SHAPES = {{
    "19M": (384, 8, 6, 1024),      # evex-3.5 と同じ (語彙 12288 で埋め込みが 4.72M)
    "30M": (448, 10, 7, 1024),
    "45M": (512, 12, 8, 1024),
    "19M-c2048": (384, 8, 6, 2048),
}}
SIZE = SHAPES[os.environ.get("EVEX_SHAPE", "19M")]

# **既に押してある重みから続ける。**段1 をやり直さないための経路。
#   EVEX_RESUME=evex35   … evex-3.5/evex35 の最終 epoch から段2 を延長する
RESUME = os.environ.get("EVEX_RESUME")

# 持ち時間 (分)。**トークン数ではなく分で配る。**段1 のデータが 7.7 倍になっても、
# 分で配れば段1 の epoch が減るだけで evex に使う割合は動かない。
# 実測: 段1 ×1 + 段2 ×6 で evex に触れる計算量が 57%
PRE_MINUTES = float(os.environ.get("EVEX_PRE_MIN", 56))
FT_MINUTES = float(os.environ.get("EVEX_FT_MIN", 58))

# 学習率。**batch を上げたら合わせて上げる。**batch 24 → 48 で 1 step あたりの
# トークンが倍になるぶん、同じトークン数での更新回数が半分になる。
# 教科書どおり sqrt(2) 倍にしておく (線形だと上げ過ぎで崩れやすい)。
# 既定は batch 48 前提の値。batch 24 で回すなら 1e-3 / 3e-4 / 1e-4 に戻す
PRE_LR = os.environ.get("EVEX_PRE_LR", "1.4e-3")
FT_LR = os.environ.get("EVEX_FT_LR", "4.2e-4")
S3_LR = os.environ.get("EVEX_S3_LR", "1.4e-4")

# --- 速度を振る ---
#
# **形より先にこれを測る。**実測 54,556 tok/s は T4 の理論値 (fp16 65 TFLOPS) の
# 7.9% しか使えていない。19M は行列が小さいので、RMSNorm の fp32 往復・RoPE の
# stack・SwiGLU の要素積といった**帯域律速の小さいカーネルの数**で律速している。
#
# batch を上げて torch.compile を掛けると、同じ金額で回せる量が変わる。
# 本番が 2 時間の仕事なので、ここで 1.5 倍出れば 40 分ぶんが浮く。
# **この振り自体は数分で終わる** (200 step の bench を並べるだけ)。
if os.environ.get("EVEX_SPEED"):
    grid = [(24, False), (48, False), (48, True), (96, True), (192, True)]
    cost_per_hour = float(os.environ.get("EVEX_COST_HOUR", 0.40))
    found = []

    # evex-5 の軸も同じ土俵で測る。**Muon は CPU で 26 倍遅かった**が、
    # 直交化が CPU 向きでないだけなので GPU で測るまで採否を決めない。
    # 文書内マスクは融合カーネルから落ちるので、その代償をここで見る
    extra = []
    if os.environ.get("EVEX_SPEED_AXES") == "1":
        extra = [("muon", {{"EVEX_OPTIMIZER": "muon"}}),
                 ("doc-mask", {{"EVEX_DOC_MASK": "1"}}),
                 ("PLE", {{"EVEX_PLE": "1", "EVEX_QK_NORM": "1"}})]

    for batch, comp in grid:
        label = f"batch {{batch}}" + (" + compile" if comp else "")
        try:
            rate = bench(SIZE, batch=batch, compile_on=comp, strict=False)
        except Exception as error:                      # OOM も情報なので拾う
            print(f"  {{label}}: 落ちた ({{type(error).__name__}})", flush=True)
            rate = None
        found.append((label, batch, comp, rate))

    # 軸ごとに 1 本ずつ。基準は既定の batch + compile
    for name, env in extra:
        os.environ.update(env)
        try:
            rate = bench(SIZE, batch=BATCH, compile_on=COMPILE, strict=False)
        except Exception as error:
            print(f"  {{name}}: 落ちた ({{type(error).__name__}})", flush=True)
            rate = None
        for key in env:
            os.environ.pop(key, None)
        found.append((f"+ {{name}}", BATCH, COMPILE, rate))

    print("\\n=== 速度の振り ===", flush=True)
    best = None
    for label, batch, comp, rate in found:
        if rate is None:
            print(f"  {{label:<22}} —  (乗らなかった)", flush=True)
            continue
        # 本番で見るトークン数 = 段1 ×1 + 段2 ×6
        total = PRETRAIN_TOKENS + TRAIN_TOKENS * 6
        hours = total / rate / 3600
        print(f"  {{label:<22}} {{rate:>8,.0f}} tok/s  本番 {{hours:>4.1f}} 時間 "
              f"${{hours * cost_per_hour:>5.2f}}", flush=True)
        if best is None or rate > best[1]:
            best = (label, rate, batch, comp)
    if best:
        print(f"\\n最良: {{best[0]}} ({{best[1]:,.0f}} tok/s)", flush=True)
    raise SystemExit(0)


# --- 形を振る ---
#
# **同じ持ち時間で回す。**等トークン数で比べると大きい模型が不利に出るので、
# 実測 tok/s × 分 を --max-tokens に入れて「同じ計算量」を揃える。
#
# **val だけで判定してはいけない。**容量を増やせば val はほぼ必ず下がるので、
# それだけ見ると毎回「大きい方が良い」になる。evex-3 のときも val は 15.74M の
# 方が低かったが、生成を見たら噛み合いの差は +3.4pt しか無かった。
# ここで出すのは段1 の val だけ。生成側の判定は段2 まで通してから。
if os.environ.get("EVEX_SWEEP"):
    minutes = float(os.environ.get("EVEX_SWEEP_MIN", 15))
    names = os.environ.get("EVEX_SWEEP_SHAPES", "19M,30M,45M").split(",")
    results = []

    for name in [x.strip() for x in names if x.strip()]:
        size = SHAPES[name]
        rate = bench(size)
        budget = int(rate * minutes * 60)
        print(f"\\n振り {{name}} {{size}} — {{rate:,.0f}} tok/s × {{minutes:.0f}} 分 "
              f"= {{budget:,}} トークン", flush=True)
        out = run(size, 1, lr="1e-3", train_name="pretrain", tag=f"-sw-{{name}}",
                  max_tokens=budget)
        push(out, f"sweep-{{name}}")

        history = Path(out, "history.json")
        val = None
        if history.exists():
            rows = json.loads(history.read_text(encoding="utf8"))
            val = rows[-1].get("val_loss") if rows else None
        results.append((name, size, rate, budget, val))

    print("\\n=== 振りの結果 (段1 の val だけ。生成側は段2 まで通してから) ===", flush=True)
    for name, size, rate, budget, val in results:
        shown = f"{{val:.4f}}" if val is not None else "—"
        print(f"  {{name:<10}} d{{size[0]}}x{{size[1]}} ctx{{size[3]}}  "
              f"{{rate:>7,.0f}} tok/s  {{budget:>12,}} tok  val {{shown}}", flush=True)
    raise SystemExit(0)

BATCH, rate = pick_batch(SIZE)

# 段2 の epoch。**分から逆算すると多すぎる。**19M で 58 分配ったら 8 epoch に
# なり、val は epoch 1 が底で残り 7 epoch は悪化させただけだった (約 $0.25 の無駄)。
# 段1 が強い今は 1〜2 で足りるので、既定は 2 にして分の逆算は上限としてだけ使う
# **段2 は 8 epoch。**val は epoch 1 が底だが、噛み合いは epoch 8 が最良だった
# (26.7% → 30.0% → 53.3%)。val は短い相槌の予測に支配されるので選択には使えない
ft_epochs = int(os.environ.get("EVEX_FT_EPOCHS", 8))

if RESUME:
    # 押してある重みを落として初期値にする。lr は段2 の続きなので低めから
    got = snapshot_download(repo_id=PUSH, local_dir="resume",
                            allow_patterns=[RESUME + "/*"], token=TOKEN)
    found = sorted(Path(got, RESUME).glob("ckpt-e*.pt"),
                   key=lambda p: int(p.stem.removeprefix("ckpt-e")))
    if not found:
        raise SystemExit(f"{{RESUME}} にチェックポイントが無い")
    # EVEX_TAG で押し先を分ける。段2 の延長なら "-long"、段3 なら "-anon" など
    tag = os.environ.get("EVEX_TAG", "long")
    lr = os.environ.get("EVEX_LR", "1.5e-4")
    print(f"\\n{{RESUME}} の続き {{ft_epochs}} epoch / lr {{lr}} / 初期値 {{found[-1]}} / "
          f"corpus {{CORPUS}}", flush=True)
    push(run(SIZE, ft_epochs, lr=lr, init=str(found[-1]), tag="-" + tag), RESUME + "-" + tag)

else:
    # **段1: 外部の会話 + 素の evex で土台を作る。**
    pre_epochs = epochs_for(rate, PRE_MINUTES, tokens=PRETRAIN_TOKENS, hi=3)
    print(f"\\n段1 {{rate:,.0f}} tok/s → {{PRE_MINUTES:.0f}} 分で {{pre_epochs}} epoch", flush=True)
    stage1 = run(SIZE, pre_epochs, lr=PRE_LR, train_name="pretrain", tag="-pre",
                 save_steps=int(os.environ.get("EVEX_SAVE_STEPS", 500)))
    push(stage1, "pretrain")

    init = last_ckpt(stage1)
    if init is None:
        raise SystemExit("段1 のチェックポイントが無いので段2 に進めない")

    # **段2 A: 段1 から続ける (本命)。**lr は段1 の 1/3 から
    print(f"\\n段2 A (段1 から) {{FT_MINUTES:.0f}} 分で {{ft_epochs}} epoch / 初期値 {{init}}", flush=True)
    stage2 = run(SIZE, ft_epochs, lr=FT_LR, init=init, tag="-ft")
    push(stage2, "evex4-s2")

    # **段3: リアクションの付いた切り出しだけ。**サーバーが実際に反応した発言で
    # 仕上げる。0.69M トークンしか無いので**過学習しやすい** — lr を段2 の 1/3 に
    # 落として 2 epoch。**逐語コピー (20字以上) で必ず確かめる**。上がるなら捨てる。
    #
    # 段2 の重みは別名 (evex4-s2) で押してあるので、段3 が悪ければそちらに戻せる
    # 既定で切る。evex-4 で段3 を掛けたら噛み合いが 53.3% → 36.7% に落ちた
    if os.environ.get("EVEX_STAGE3", "0") == "1":
        init2 = best_ckpt(stage2)
        if init2 is None:
            print("⚠ 段2 のチェックポイントが無いので段3 は飛ばす", flush=True)
        else:
            s3_epochs = int(os.environ.get("EVEX_S3_EPOCHS", 2))
            print(f"\\n段3 (リアクション {{REACTED_TOKENS:,}} tok) {{s3_epochs}} epoch / "
                  f"初期値 {{init2}}", flush=True)
            push(run(SIZE, s3_epochs, lr=S3_LR, train_name="reacted", init=init2,
                     tag="-re"), "evex4")

    # **段2 B: ゼロから (対照)。**これが無いと外部データが効いたか分からない
    if os.environ.get("EVEX_CONTROL", "1") == "1":
        print(f"\\n段2 B (ゼロから / 対照) {{ft_epochs}} epoch", flush=True)
        push(run(SIZE, ft_epochs, lr=PRE_LR, tag="-scratch"), "control")

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
    # **PEP 723 は必ずファイルの先頭。**uv はここしか読まない。
    # 埋め込んだ本体より前に置かないと、依存が入らないまま起動して落ちる
    header = (
        "# /// script\n"
        '# requires-python = ">=3.10"\n'
        '# dependencies = ["torch", "numpy", "sentencepiece", "huggingface_hub"]\n'
        "# ///\n\n"
    )
    # 本体を文字列として先頭に置く。書き出す側と書き出される側を 1 ファイルにする
    body = header + "".join(
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
