"""学習ループ。CPU で回す前提。

    # 速度だけ測る (これで所要時間を決める)
    .venv-llm/bin/python scripts/llm/train.py --bench

    # 本番
    .venv-llm/bin/python scripts/llm/train.py --epochs 8

train / val は build-corpus.mjs が時系列で切ってある。val は最後の 14 日で、
ランダム分割にしていない (完全一致の短文が 23% あるので時間で切らないと嘘になる)。
epoch ごとにチェックポイントと生成サンプルを残すので、あとから
「val が最小の点」と「文体が一番らしい点」を比べられる。
"""

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import sentencepiece as spm
import torch

from model import Config, MicroLM

parser = argparse.ArgumentParser()
parser.add_argument("--corpus", default="corpus")
parser.add_argument("--out", default="scripts/llm/out")
parser.add_argument("--epochs", type=int, default=8)
parser.add_argument("--batch", type=int, default=24)
parser.add_argument("--lr", type=float, default=3e-4)
parser.add_argument("--warmup", type=float, default=0.02)
parser.add_argument("--bench", action="store_true", help="200 step だけ回して速度を出す")
# i5-12600K は P コア 6 + E コア 4 の 16 スレッド。同期並列の行列積を全スレッドに
# 広げると P コアが E コアを待つので、素朴に 16 を指定すると逆に遅い
# (実測 attn_dropout=0 で 16 スレッド 2,104 → 12 スレッド 5,476 tok/s)。
parser.add_argument("--threads", type=int, default=12)
# GPU が使えるなら使う。auto は「あれば cuda」。
# CPU 決め打ちにしていたので、GPU のある機械に移しても回せなかった。
parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
# weight decay をどこに掛けるか。
#   all      … 全パラメータ (evex-1 と同じ。既定はこちらにして対照を崩さない)
#   matrices … 行列だけ。RMSNorm のゲインと埋め込みを外す
# 1次元パラメータに weight decay を掛けるのは標準的には有害とされる。
# 埋め込みは 5.87M のうち 105万 (18%) なので効き方が大きい。
parser.add_argument("--wd-mode", default="all", choices=["all", "matrices"])
# 正規化が作った記号 (<file> <url> <mention> <channel> <time>) を損失から外す。
# 文脈には残るので流れは学べるが、自分では書かなくなる
parser.add_argument("--mask-tokens", action=argparse.BooleanOptionalAction, default=True)
args = parser.parse_args()

corpus = Path(args.corpus)
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)

torch.manual_seed(0)
torch.set_num_threads(args.threads)

sp = spm.SentencePieceProcessor(model_file=str(corpus / "tok.model"))
cfg = Config(vocab_size=sp.get_piece_size())


def load(name):
    """会話を連結して 1 本の列にする。会話の境界は <|conv|> / <|end|> が持っている。"""
    cache = corpus / f"{name}.u16.npy"
    if cache.exists():
        return np.load(cache)

    lines = (corpus / f"{name}.txt").read_text(encoding="utf8").splitlines()
    ids = []
    for chunk in sp.encode(lines, out_type=int):
        ids.extend(chunk)

    # 語彙 4096 なので uint16 で足りる (int64 だと 4 倍のメモリと帯域を食う)
    arr = np.asarray(ids, dtype=np.uint16)
    np.save(cache, arr)
    return arr


train_ids = load("train")
val_ids = load("val")

print(f"train {len(train_ids):,} トークン / val {len(val_ids):,} トークン")
print(f"vocab {cfg.vocab_size} / layers {cfg.n_layers} / d_model {cfg.d_model} "
      f"/ context {cfg.context} / dropout {cfg.dropout} (attn {cfg.attn_dropout})")
print(f"threads {args.threads} / batch {args.batch} / wd {args.wd_mode}")

model = MicroLM(cfg)
params = model.parameter_count()
print(f"パラメータ {params:,} ({params / 1e6:.2f}M)")

def cuda_usable():
    """torch.cuda.is_available() だけでは足りない。

    GTX 960 (sm_52) では is_available() が True を返すのに、カーネルを起動すると
    「no kernel image is available」で落ちる。PyTorch 2.13+cu130 が持っているのは
    sm_75 以上で、Maxwell 世代は含まれていない。実際に対応表と突き合わせる。
    """
    if not torch.cuda.is_available():
        return False

    have = torch.cuda.get_device_capability(0)
    supported = {tuple(int(c) for c in a.removeprefix("sm_")) for a in torch.cuda.get_arch_list()}
    if have in supported:
        return True

    print(f"cuda を使わない: この GPU は sm_{have[0]}{have[1]} だが "
          f"PyTorch が持っているのは {sorted(torch.cuda.get_arch_list())}")
    return False


picked = args.device
if picked == "auto":
    picked = "cuda" if cuda_usable() else "cpu"

device = torch.device(picked)
model.to(device)

if picked == "cuda":
    print(f"device cuda: {torch.cuda.get_device_name(0)} "
          f"/ sm_{''.join(map(str, torch.cuda.get_device_capability(0)))}")
else:
    print(f"device cpu / threads {args.threads}")


# 正規化が作った記号。**文脈には残すが、書き方は教えない。**
#
# これらは「本文がそこにあったが渡せなかった」という印で、発言ではない。
# 普通に学習させると、モデルはこれを発言として書く — 実測で返答の 38% が
# 「(画像)」だけになり、推論時にトークンを禁止して 12% に抑えるしかなかった。
# あれは症状の抑え込みで、しかも高確率のトークンを削って再正規化するので
# 出てくる第二候補が歪む。
#
# 学習時に損失から外せば、確率の質量が最初から実際の語に乗る。
# 文脈からは消さない — 「誰かが画像を貼って、他の人が反応する」流れは学ばせたい。
#
# <nl> と <code> は外さない。改行もコードブロックもモデルが書いて良いもの。
MASKED_PIECES = ("<file>", "<url>", "<mention>", "<channel>", "<time>")
masked_ids = [sp.piece_to_id(p) for p in MASKED_PIECES if sp.piece_to_id(p) != sp.unk_id()]

# model.py の cross_entropy は ignore_index=-1 なので、-100 ではなく -1 を置く
IGNORE = -1


def batches(ids, batch_size, generator, mask=None):
    """context+1 の窓を無作為に切る。端は捨てる。"""
    high = len(ids) - cfg.context - 1
    use = args.mask_tokens if mask is None else mask
    ban = torch.tensor(masked_ids, dtype=torch.long) if use else None

    while True:
        starts = torch.randint(0, high, (batch_size,), generator=generator)
        block = np.stack([ids[s: s + cfg.context + 1] for s in starts.tolist()])
        chunk = torch.from_numpy(block.astype(np.int64))
        x, y = chunk[:, :-1], chunk[:, 1:]

        if ban is not None:
            # 入力 (x) はそのまま。目標 (y) だけ外すので、文脈としては見えたまま
            y = y.masked_fill(torch.isin(y, ban), IGNORE)

        yield x.to(device), y.to(device)


gen = torch.Generator().manual_seed(0)
train_batches = batches(train_ids, args.batch, gen)

tokens_per_step = args.batch * cfg.context
steps_per_epoch = max(1, len(train_ids) // tokens_per_step)
total_steps = 200 if args.bench else steps_per_epoch * args.epochs
warmup_steps = max(1, int(total_steps * args.warmup))

print(f"1 step {tokens_per_step:,} トークン / 1 epoch {steps_per_epoch:,} step "
      f"/ 合計 {total_steps:,} step")

def param_groups():
    if args.wd_mode == "all":
        return model.parameters()

    # 行列 (2次元以上) だけに weight decay を掛ける。RMSNorm のゲインは 1 次元、
    # 埋め込みは 2 次元だが名前で外す (tying しているので head も同じテンソル)。
    decay, plain = [], []
    seen = set()
    for name, param in model.named_parameters():
        if id(param) in seen:
            continue
        seen.add(id(param))
        (plain if param.dim() < 2 or "embed" in name else decay).append(param)

    print(f"weight decay: 掛ける {sum(p.numel() for p in decay):,} / "
          f"外す {sum(p.numel() for p in plain):,}")
    return [{"params": decay, "weight_decay": 0.1},
            {"params": plain, "weight_decay": 0.0}]


opt = torch.optim.AdamW(param_groups(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.1)


def lr_at(step):
    if step < warmup_steps:
        return args.lr * (step + 1) / warmup_steps
    progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
    return args.lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, progress))))


@torch.no_grad()
def evaluate(ids, iters=40, mask=None):
    """val を測る。

    mask=True は学習と同じ尺度 (記号を外した loss)。mask=False は記号も含めた素の
    loss で、**過去の run と比べられるのはこちら**。記号を外すと平均が変わるので、
    そこを混ぜると「良くなった/悪くなった」を誤読する。両方出す。
    """
    model.eval()
    local = torch.Generator().manual_seed(1234)
    stream = batches(ids, args.batch, local, mask=mask)
    total = 0.0
    for _ in range(iters):
        x, y = next(stream)
        _, loss = model(x, y)
        total += loss.item()
    model.train()
    return total / iters


# 話者トークンだけを渡すと文脈が無く、モデルは <url> や <file> のような
# 頻出トークンに流れる。実際の使い方 (直前の発言がある状態) に近い形で出す。
# epoch 1〜2 のサンプルが記号の羅列になっていて信号にならなかったので直した。
SAMPLE_PROMPTS = [
    "<|conv|><|s3|>Cloudflare Containers ってどうなん<|s0|>",
    "<|conv|><|s0|>rebase 疲れた<|s3|>",
    "<|conv|><|other|>これバグってる？<|other|>",
    "<|conv|>",
]


def samples(tag):
    end_id = sp.piece_to_id("<|end|>")
    lines = []
    for prompt in SAMPLE_PROMPTS:
        ids = torch.tensor([sp.encode(prompt, out_type=int)], dtype=torch.long)
        got = model.generate(ids, max_new_tokens=120, temperature=0.9, top_k=40, stop_id=end_id)
        lines.append(f"[{prompt}] {sp.decode(got[0].tolist())}")
    model.train()
    (out / f"samples-{tag}.txt").write_text("\n\n".join(lines), encoding="utf8")
    return lines


model.train()
history = []
started = time.time()
window = time.time()
seen = 0

for step in range(total_steps):
    for group in opt.param_groups:
        group["lr"] = lr_at(step)

    x, y = next(train_batches)
    _, loss = model(x, y)

    opt.zero_grad(set_to_none=True)
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    opt.step()

    seen += tokens_per_step

    if (step + 1) % 20 == 0:
        rate = seen / (time.time() - window)
        print(f"step {step + 1:>6}/{total_steps}  loss {loss.item():.4f}  "
              f"lr {lr_at(step):.2e}  {rate:,.0f} tok/s", flush=True)
        window, seen = time.time(), 0

    if args.bench and step + 1 == 200:
        rate = 200 * tokens_per_step / (time.time() - started)
        need = steps_per_epoch * args.epochs * tokens_per_step / rate
        print()
        print(f"実測 {rate:,.0f} tok/s")
        print(f"{args.epochs} epoch = {steps_per_epoch * args.epochs:,} step "
              f"= {need / 3600:.1f} 時間")
        raise SystemExit(0)

    # epoch の終わりごとに評価とサンプル
    if (step + 1) % steps_per_epoch == 0:
        epoch = (step + 1) // steps_per_epoch
        tr = evaluate(train_ids, iters=20)
        va = evaluate(val_ids, iters=20)
        # 記号を含めた素の loss。過去の run と比べられるのはこちらだけ
        raw = evaluate(val_ids, iters=20, mask=False) if args.mask_tokens else va
        history.append({"epoch": epoch, "step": step + 1, "train": tr, "val": va,
                        "val_raw": raw})

        print(f"--- epoch {epoch}  train {tr:.4f}  val {va:.4f}  素の val {raw:.4f}  "
              f"({(time.time() - started) / 60:.0f} 分経過)", flush=True)

        torch.save(
            {"model": model.state_dict(), "config": vars(cfg), "epoch": epoch,
             "train_loss": tr, "val_loss": va, "val_raw": raw},
            out / f"ckpt-e{epoch}.pt"
        )
        for line in samples(f"e{epoch}"):
            print(f"    {line[:160]}", flush=True)

        (out / "history.json").write_text(json.dumps(history, indent=2))

print()
print(f"完了 {(time.time() - started) / 60:.0f} 分")
best = min(history, key=lambda h: h["val"]) if history else None
if best:
    print(f"val 最小は epoch {best['epoch']} ({best['val']:.4f})")
    print("文体は val 最小より後の方が「らしい」ことがあるので、samples-*.txt を読んで選ぶ")
