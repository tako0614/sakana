# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "torch",
#   "transformers==5.15.0",
#   "huggingface_hub",
#   "safetensors",
# ]
# ///
"""Qwen3-0.6B-Base にこのサーバーの口調を移す (evex-3)。

HF Jobs で回す:

    hf jobs uv run --flavor a10g-small --secrets HF_TOKEN \
      scripts/llm/finetune.py -- --dataset tako080614/sakana-sft --push tako080614/evex-3

ローカルで形だけ確かめる (GPU 不要、数十 step で止める):

    .venv-llm/bin/python scripts/llm/finetune.py --local sft --max-steps 5 --device cpu

## なぜ base 版か

instruct 版は「承知しました」「〜がおすすめです」の口調が事前学習で焼き付いていて、
7.46M トークンでは上書きしきれない。base は素なので口調が丸ごと入る。
evex-1 を DeepSeek 側で読みにくいと判断して削ったのと同じ口調が、
instruct を選ぶと最初から入っている状態になる。

## なぜフル学習か (LoRA でない)

LoRA は容量が足りないときの手段。0.6B のフル学習は 24GB に収まる
(重み 1.2 + 勾配 1.2 + Adam 4.8 = 約 8GB)。口調を移すのが目的なので、
一部の行列だけ動かすより全部動かした方が入る。

## 学習は会話の全体に掛ける

「最後の 1 発言だけ損失を取る」やり方 (instruction tuning の作法) は取らない。
移したいのは特定の応答ではなく会話の流れ全体なので、
出てくる全トークンを予測させた方が口調が濃く入る。
"""

import argparse
import json
import math
import os
import time
from contextlib import nullcontext
from pathlib import Path

import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, get_cosine_schedule_with_warmup

BASE = "Qwen/Qwen3-0.6B-Base"

parser = argparse.ArgumentParser()
parser.add_argument("--base", default=BASE)
parser.add_argument("--dataset", default=None, help="HF の private データセット (repo id)")
parser.add_argument("--local", default=None, help="ローカルの sft/ ディレクトリ")
parser.add_argument("--push", default=None, help="学習後に push する repo id (private で作る)")
parser.add_argument("--out", default="out")
parser.add_argument("--epochs", type=int, default=8)
parser.add_argument("--lr", type=float, default=5e-5)
parser.add_argument("--seq", type=int, default=1024)
parser.add_argument("--batch", type=int, default=8)
parser.add_argument("--accum", type=int, default=2)
parser.add_argument("--warmup", type=float, default=0.03)
parser.add_argument("--clip", type=float, default=1.0)
parser.add_argument("--wd", type=float, default=0.01)
# Adam の状態は fp32 で 2 本 = 4.77GB。重み 2.38 + 勾配 2.38 + autocast の fp16 コピー 1.19 と
# 合わせて固定分が 10.72GB になり、T4 14.56GB では活性と logits の余地が残らない
# (batch 1 まで落としても forward の lm_head で OOM した)。8bit にすると状態が 1.19GB になり、
# 固定分 7.14GB で batch 2 が戻せる。量子化されるのは状態だけで、重みと更新は fp32 のまま。
parser.add_argument("--optim", default="adamw", choices=["adamw", "adamw8bit"])
parser.add_argument("--max-steps", type=int, default=0, help="0 なら最後まで")
# 24GB に対して 0.6B のフル学習は約 8GB + 活性 2.3GB で収まるので既定は切る。
# 有効にすると活性を捨てて前向きを2回走らせるので、計算が 25% 増えて時間も金も増える。
# 窓や batch を大きくして OOM したときだけ立てる
parser.add_argument("--grad-ckpt", action="store_true")
parser.add_argument("--val-batches", type=int, default=0, help="0 なら val 全部")
# 1 epoch あたり 1.2GB (bf16) 出る。全部残すと 8 epoch で 9.6GB を上げることになるので、
# 新しい方から数個だけ残す。どの epoch が一番口調が濃いかは history.json の
# サンプルで判断できるので、重みを全部持つ必要はない
parser.add_argument("--keep", type=int, default=4, help="残す epoch 数 (0 なら全部)")
parser.add_argument("--device", default="auto")
# bf16 は Ampere 以降だけ。Kaggle / Colab の無料枠は T4 (Turing) なので fp16 になる。
# fp16 は重みを fp16 で持つと 5e-5 の更新が丸めで消えるので、master は fp32 で持って
# 計算だけ fp16 にする (autocast + GradScaler)。bf16 は指数部が広いのでその必要が無い。
parser.add_argument("--precision", default="auto", choices=["auto", "bf16", "fp16", "fp32"])
parser.add_argument("--seed", type=int, default=0)
args = parser.parse_args()

torch.manual_seed(args.seed)

device = args.device
if device == "auto":
    device = "cuda" if torch.cuda.is_available() else "cpu"

precision = args.precision
if precision == "auto":
    if device != "cuda":
        precision = "fp32"
    else:
        # torch.cuda.is_bf16_supported() は使わない。既定で including_emulation=True
        # なので、bf16 テンソルが作れれば True を返す = T4 (sm_75) でも True になる。
        # 実際に Kaggle の T4 で bf16 が選ばれた。ハードウェア支援が無いまま bf16 で
        # 回ると遅いうえ、重みが bf16 のままなので 5e-5 の更新が丸めで消える。
        # bf16 が本当に効くのは Ampere (sm_80) 以降。
        major, _ = torch.cuda.get_device_capability()
        precision = "bf16" if major >= 8 else "fp16"

# 重みを持つ dtype。fp16 のときだけ master を fp32 にして、計算を autocast に任せる
weight_dtype = torch.bfloat16 if precision == "bf16" else torch.float32
amp_dtype = torch.float16 if precision == "fp16" else None
scaler = torch.amp.GradScaler("cuda", enabled=precision == "fp16")


def forward_ctx():
    """fp16 のときだけ autocast を掛ける。bf16 は重みごと bf16 なので要らない。"""
    if amp_dtype is None:
        return nullcontext()
    return torch.autocast("cuda", dtype=amp_dtype)


out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)

print(f"device {device} / precision {precision} / 重み {weight_dtype}", flush=True)
if device == "cuda":
    free, total = torch.cuda.mem_get_info()
    print(f"GPU {torch.cuda.get_device_name(0)} / {total / 1024**3:.1f} GB", flush=True)

# --- データ ---


def load_split(name):
    """train / val の1つを読む。HF から落とすかローカルを見るか。"""
    if args.local:
        path = Path(args.local) / f"{name}.jsonl"
    else:
        from huggingface_hub import hf_hub_download
        path = Path(hf_hub_download(args.dataset, f"{name}.jsonl", repo_type="dataset"))
    # U+2028 で割れるのを避けるため、書き出し側と同じく \n だけで切る
    text = path.read_text(encoding="utf8")
    return [json.loads(line)["text"] for line in text.split("\n") if line]


tok = AutoTokenizer.from_pretrained(args.base)
eos = tok.eos_token_id


class Packed(Dataset):
    """会話を EOS で継いで seq 長に詰める。

    1 会話 190 トークン前後に対して窓が 1024 なので、会話ごとにパディングすると
    8 割が無駄になる。詰めれば全部が学習に使われる。境界を跨ぐ attention は
    止めない (EOS が区切りだと学べる形で、標準的なやり方)。
    """

    def __init__(self, texts, seq):
        ids = []
        for text in texts:
            ids.extend(tok(text, add_special_tokens=False).input_ids)
            ids.append(eos)
        # 端数は捨てる。1 窓に満たない分だけなので影響は無い
        usable = len(ids) // seq * seq
        self.ids = torch.tensor(ids[:usable], dtype=torch.long)
        self.seq = seq
        self.n = usable // seq
        self.tokens = len(ids)

    def __len__(self):
        return self.n

    # ずらさずに返す。`labels=` を渡すと transformers が内部で 1 つずらすので、
    # ここでもずらすと 2 つ先を予測させることになる (実際にやって val 7.12 が出た。
    # base モデルの日本語なら 3 前後が出るはずの値で、サンプルも崩れていた)
    def __getitem__(self, i):
        return self.ids[i * self.seq : (i + 1) * self.seq]


train_set = Packed(load_split("train"), args.seq)
val_set = Packed(load_split("val"), args.seq)
print(f"train {train_set.tokens:,} tokens / {len(train_set):,} 窓", flush=True)
print(f"val   {val_set.tokens:,} tokens / {len(val_set):,} 窓", flush=True)

train_loader = DataLoader(train_set, batch_size=args.batch, shuffle=True, drop_last=True)
val_loader = DataLoader(val_set, batch_size=args.batch, shuffle=False)

# --- モデル ---

model = AutoModelForCausalLM.from_pretrained(args.base, dtype=weight_dtype)
model.to(device)
if args.grad_ckpt:
    model.gradient_checkpointing_enable()
model.config.use_cache = False

total = sum(p.numel() for p in model.parameters())
print(f"{args.base} / {total:,} params", flush=True)

# weight decay は 1 次元 (LayerNorm / bias) から外す。掛けると害になる
decay = [p for n, p in model.named_parameters() if p.dim() >= 2]
plain = [p for n, p in model.named_parameters() if p.dim() < 2]
groups = [{"params": decay, "weight_decay": args.wd}, {"params": plain, "weight_decay": 0.0}]

if args.optim == "adamw8bit":
    import bitsandbytes as bnb
    opt = bnb.optim.AdamW8bit(groups, lr=args.lr, betas=(0.9, 0.95), eps=1e-8)
else:
    opt = torch.optim.AdamW(groups, lr=args.lr, betas=(0.9, 0.95), eps=1e-8)
print(f"optimizer {args.optim}", flush=True)

steps_per_epoch = max(1, len(train_loader) // args.accum)
total_steps = steps_per_epoch * args.epochs
if args.max_steps:
    total_steps = min(total_steps, args.max_steps)
sched = get_cosine_schedule_with_warmup(opt, int(total_steps * args.warmup), total_steps)

print(f"{steps_per_epoch:,} step/epoch × {args.epochs} = {total_steps:,} step "
      f"(実効 batch {args.batch * args.accum * args.seq:,} tokens)", flush=True)


@torch.no_grad()
def evaluate():
    model.eval()
    loss_sum = 0.0
    count = 0
    for x in val_loader:
        x = x.to(device)
        with forward_ctx():
            loss_sum += model(input_ids=x, labels=x).loss.item()
        count += 1
        # GPU なら val 全部 (214 窓) で 2 秒なので既定は無制限。
        # CPU で形を確かめるときだけ絞る — 素で 11 分かかって固まって見えた
        if args.val_batches and count >= args.val_batches:
            break
    model.train()
    return loss_sum / max(1, count)


# 各 epoch のサンプル。「val が下がった」と「読める」は別なので両方残す。
# 学習時と同じ形で渡す — 形が違うとモデルは見たことのない入力を受け取る
PROMPTS = [
    "#ch2\nA: これバグってる？\nB:",
    "#ch2\nA: Cloudflare Containers ってどうなん\nB:",
    "#ch0\nA: 眠い\nB:",
]


@torch.no_grad()
def samples():
    model.eval()
    model.config.use_cache = True
    got = []
    for prompt in PROMPTS:
        ids = tok(prompt, return_tensors="pt").to(device)
        with forward_ctx():
            gen = model.generate(
                **ids, max_new_tokens=48, do_sample=True, temperature=0.9, top_k=40,
                pad_token_id=eos,
            )
        text = tok.decode(gen[0][ids.input_ids.shape[1]:], skip_special_tokens=True)
        got.append({"prompt": prompt, "reply": text.split("\n")[0].strip()})
    model.config.use_cache = False
    model.train()
    return got


# --- 学習 ---

history = []
step = 0

# 学習前の val。配線が正しいかの確認と「どこから始まったか」の基準になる。
# base モデルがこのデータで 3 前後を出せば、損失の計算が合っている
# (ずらしを二重にしていたときは 7.12 が出た)。
base_val = evaluate()
print(f"\n学習前 val {base_val:.4f} (ppl {math.exp(min(20, base_val)):.1f})", flush=True)
for s in samples():
    print(f"  {s['prompt'].splitlines()[-1]} → {s['reply']!r}", flush=True)

# 評価と生成が確保したブロックを返す。この後 Adam の状態が乗るので、
# 余っているキャッシュを抱えたままにすると 14.56GB では足りなくなる
if device == "cuda":
    torch.cuda.empty_cache()

started = time.time()
model.train()

for epoch in range(1, args.epochs + 1):
    print(f"\n--- epoch {epoch}/{args.epochs}", flush=True)
    seen = 0
    loss_sum = 0.0
    opt.zero_grad(set_to_none=True)

    for i, x in enumerate(train_loader):
        x = x.to(device)
        with forward_ctx():
            loss = model(input_ids=x, labels=x).loss
        scaler.scale(loss / args.accum).backward()
        loss_sum += loss.item()
        seen += 1

        if (i + 1) % args.accum:
            continue

        # fp16 の勾配は scaler が掛けた倍率のままなので、先に戻さないと
        # clip の閾値 1.0 が意味を持たない (何万倍かの値と比べることになる)
        scaler.unscale_(opt)
        torch.nn.utils.clip_grad_norm_(model.parameters(), args.clip)
        scaler.step(opt)
        scaler.update()
        sched.step()
        opt.zero_grad(set_to_none=True)
        step += 1

        if step % 25 == 0:
            done = step * args.batch * args.accum * args.seq
            rate = done / (time.time() - started)
            left = (total_steps - step) * args.batch * args.accum * args.seq / max(1, rate)
            peak = torch.cuda.max_memory_allocated() / 1024**3 if device == "cuda" else 0
            print(f"step {step}/{total_steps} loss {loss_sum / seen:.4f} "
                  f"lr {sched.get_last_lr()[0]:.2e} {rate:,.0f} tok/s "
                  f"残り {left / 60:.0f}分 峰 {peak:.1f}GB", flush=True)
            loss_sum = 0.0
            seen = 0

        if args.max_steps and step >= args.max_steps:
            break

    val = evaluate()
    got = samples()
    history.append({"epoch": epoch, "step": step, "val_loss": val,
                    "ppl": math.exp(min(20, val)), "samples": got})
    print(f"val {val:.4f} (ppl {math.exp(min(20, val)):.1f})", flush=True)
    for s in got:
        print(f"  {s['prompt'].splitlines()[-1]} → {s['reply']!r}", flush=True)

    # epoch ごとに残す。「val 最小」と「口調が濃い」がずれたときに選び直せる
    epoch_dir = out / f"epoch-{epoch}"
    model.save_pretrained(epoch_dir, safe_serialization=True)
    tok.save_pretrained(epoch_dir)
    (out / "history.json").write_text(json.dumps(history, ensure_ascii=False, indent=2) + "\n")

    if args.keep:
        import shutil
        old = sorted(out.glob("epoch-*"), key=lambda p: int(p.name.split("-")[1]))[: -args.keep]
        for path in old:
            shutil.rmtree(path)

    if args.max_steps and step >= args.max_steps:
        break

took = (time.time() - started) / 60
print(f"\n完了 {took:.0f}分 / val {history[-1]['val_loss']:.4f}", flush=True)

# --- 公開 ---

if args.push:
    from huggingface_hub import HfApi
    api = HfApi(token=os.environ.get("HF_TOKEN"))
    api.create_repo(args.push, private=True, exist_ok=True)
    # epoch ごとの重みは revision を分けず、全部フォルダのまま上げる。
    # あとで読んで選ぶ (val 最小が一番読めるとは限らない)
    api.upload_folder(repo_id=args.push, folder_path=str(out),
                      commit_message=f"evex-3 / {args.epochs} epoch / val {history[-1]['val_loss']:.4f}")
    print(f"pushed → https://huggingface.co/{args.push} (private)", flush=True)
