"""学習ループ。CPU でも GPU でも回る。

    # 速度だけ測る (これで所要時間を決める)。**本番の前に必ず通す**
    .venv-llm/bin/python scripts/llm/train.py --bench

    # 本番 (CPU)
    .venv-llm/bin/python scripts/llm/train.py --epochs 8

    # 本番 (GPU)。batch を上げないと GPU が埋まらない
    python train.py --corpus corpus-v4 --epochs 4 --batch 64 --lr 1e-3

モデルの大きさは環境変数で決まる (model.py の Config):

    LLM_DMODEL=384 LLM_LAYERS=8 LLM_HEADS=6 LLM_CONTEXT=1024   # evex-3  15.8M
    LLM_DMODEL=256 LLM_LAYERS=6 LLM_HEADS=4 LLM_CONTEXT=512    # evex-2   5.87M

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
# どのファイルを train に使うか。**二段学習のため。**
#   pretrain … 外部の会話 + evex。会話能力の土台を作る (段1)
#   train    … evex だけ。口調と 147 人を焼き付ける (段2)
# val はどちらの段でも evex のものを使う ({corpus}/val.txt) —
# 「外部を混ぜている最中に evex の val がどう動くか」が見たい値そのもの。
parser.add_argument("--train-name", default="train", help="{corpus}/<name>.txt を学習に使う")
# 段1 のチェックポイントから続ける。形が違うものは弾く
parser.add_argument("--init", default=None, help="重みの初期値にする ckpt (段2 用)")
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
# 半精度で回す。**cuda に載せるだけでは速くならない。**
#
# 15.7M は 1 トークン 6×15.7M = 94 MFLOP。T4 の fp32 は 8.1 TFLOPS しかないので、
# 実効 25% で 24k tok/s = 14700K の CPU (実測 12k) の 2 倍にしかならない。
# 効くのは tensor core で、fp16 なら 65 TFLOPS ある。
#
# T4 (Turing / sm_75) には bf16 が無いので fp16 + GradScaler。sm_80 以上なら
# bf16 でスケーリング不要。重みは fp32 のまま持つ (finetune.py と同じ形)。
parser.add_argument("--amp", action=argparse.BooleanOptionalAction, default=True,
                    help="cuda のとき半精度で回す (cpu では無視される)")
# weight decay をどこに掛けるか。
#   all      … 全パラメータ (evex-1 と同じ。既定はこちらにして対照を崩さない)
#   matrices … 行列だけ。RMSNorm のゲインと埋め込みを外す
# 1次元パラメータに weight decay を掛けるのは標準的には有害とされる。
# 埋め込みは 5.87M のうち 105万 (18%) なので効き方が大きい。
parser.add_argument("--wd-mode", default="all", choices=["all", "matrices"])
# 正規化が作った記号 (<file> <url> <mention> <channel> <time>) を損失から外す。
# 文脈には残るので流れは学べるが、自分では書かなくなる
parser.add_argument("--mask-tokens", action=argparse.BooleanOptionalAction, default=True)
# 話者ごとの学習率の倍率の上限。1.0 で無効。
#
# 147 人の発言数は **最多 55,964 / 最少 203 で 276 倍**の開きがあり、下位50人の
# 合計は全体の 2.7% しかない。話者トークンは「その人が喋ったときにしか勾配が
# 来ない」ので、少ない人ほど更新回数が足りず、`/as` でその人を指名しても
# 実質学習されていない。
#
# **基準は幾何平均にする。**素朴に `sqrt(最多件数 / その人の件数)` にすると
# 上限 ×4 で 147 人中 116 人が上限に張り付き、「補正」ではなく
# 「話者だけ一律 4 倍」になる (実測)。幾何平均 (1,187 件) を基準にすると
# 多い人は下げ・少ない人は上げる形になり、埋め込み全体の学習率は動かない:
#
#   最多 55,964 件 → ×0.33     50位 1,816 件 → ×0.81
#   100位   415 件 → ×1.69     最少   203 件 → ×2.42     (上限 3.0)
parser.add_argument("--speaker-lr-cap", type=float, default=1.0)
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


train_ids = load(args.train_name)
val_ids = load("val")

print(f"train {len(train_ids):,} トークン ({args.train_name}.txt) / val {len(val_ids):,} トークン")
print(f"vocab {cfg.vocab_size} / layers {cfg.n_layers} / d_model {cfg.d_model} "
      f"/ context {cfg.context} / dropout {cfg.dropout} (attn {cfg.attn_dropout})")
print(f"threads {args.threads} / batch {args.batch} / wd {args.wd_mode}")

model = MicroLM(cfg)
params = model.parameter_count()
print(f"パラメータ {params:,} ({params / 1e6:.2f}M)")

# --- 段1 の続きから始める ---
#
# **形が 1 つでも違ったら止める。**vocab や d_model が違う ckpt を
# strict=False で読ませると、合ったテンソルだけ入って残りは初期値のまま走る。
# 例外は出ないので「なぜか収束しない run」として時間だけ溶ける。
if args.init:
    blob = torch.load(args.init, map_location="cpu", weights_only=False)
    saved = blob.get("config", {})
    mismatch = {k: (saved.get(k), getattr(cfg, k))
                for k in ("vocab_size", "n_layers", "d_model", "n_heads", "context")
                if k in saved and saved[k] != getattr(cfg, k)}
    if mismatch:
        raise SystemExit(f"--init の形が違う: {mismatch}")

    model.load_state_dict(blob["model"])
    print(f"初期値 {args.init} (epoch {blob.get('epoch')} / val {blob.get('val_loss', float('nan')):.4f})")

def cuda_usable():
    """torch.cuda.is_available() だけでは足りない。

    GTX 960 (sm_52) では is_available() が True を返すのに、カーネルを起動すると
    「no kernel image is available」で落ちる。

    **対応表との突き合わせではなく、実際にカーネルを起動して確かめる。**
    以前は `get_device_capability()` が `get_arch_list()` に**完全一致**するかを
    見ていたが、それだと L4 (sm_89) を弾いた — wheel が sm_80/86/90 を積んでいて
    sm_89 が一覧に無くても、PTX から JIT されて普通に動く。
    HF Jobs の l4x1 で静かに CPU に落ち、200 step の bench が 24 分たっても
    終わらなかった (しかも bench は出力を握っていたので理由が見えなかった)。
    """
    if not torch.cuda.is_available():
        return False

    try:
        probe = torch.zeros(64, 64, device="cuda")
        (probe @ probe).sum().item()          # 同期させて実際に起動を確かめる
        return True
    except Exception as error:                # noqa: BLE001
        have = torch.cuda.get_device_capability(0)
        print(f"cuda を使わない: sm_{have[0]}{have[1]} でカーネルが起動しない "
              f"({type(error).__name__}: {error})。"
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

# 半精度の型を決める。bf16 は sm_80 (Ampere) 以上、fp16 は sm_70 以上で
# tensor core に乗る。fp16 は指数部が狭くて勾配が 0 に落ちるので GradScaler が要る。
#
# **`torch.cuda.is_bf16_supported()` で判定してはいけない。** あれは T4 (sm_75) でも
# True を返す — エミュレーションを含めて「動くか」を答えるので、tensor core を
# 使わない経路に落ちる。実際に T4 で bf16 を選んでしまい、65 TFLOPS の fp16 経路に
# 乗らずに 13,223 tok/s (実効 1.27 TFLOPS / MFU 15.7%) しか出なかった。
# 世代で決めるのが確実。
amp_on = bool(args.amp and picked == "cuda")
amp_dtype = torch.float32
if amp_on:
    major = torch.cuda.get_device_capability(0)[0]
    amp_dtype = torch.bfloat16 if major >= 8 else torch.float16
    print(f"amp {str(amp_dtype).removeprefix('torch.')}"
          f"{' + GradScaler' if amp_dtype is torch.float16 else ''} (sm_{major}x)")

scaler = torch.amp.GradScaler("cuda", enabled=(amp_on and amp_dtype is torch.float16))


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


# **トークン列は最初に一度だけ device に載せる。**
#
# 元は毎 step numpy で窓を stack して .to(device) していた。CPU では気にならないが、
# GPU だと 1 step が数十 ms しかないので、そこが支配的になって GPU が待つ。
# 24M トークン × int64 = 192MB なので、丸ごと置いておける。
OFFSETS = torch.arange(cfg.context + 1, device=device)


def on_device(ids):
    return torch.as_tensor(ids.astype(np.int64)).to(device)


def batches(ids, batch_size, generator, mask=None):
    """context+1 の窓を無作為に切る。端は捨てる。"""
    high = len(ids) - cfg.context - 1
    use = args.mask_tokens if mask is None else mask
    ban = torch.tensor(masked_ids, dtype=torch.long, device=device) if use else None
    stream = on_device(ids)

    while True:
        # 開始位置は CPU の generator で引く。**乱数の出方を変えないため** —
        # device 側で引くと過去の run と同じ系列にならず、比べられなくなる
        starts = torch.randint(0, high, (batch_size,), generator=generator).to(device)
        chunk = stream[starts[:, None] + OFFSETS[None, :]]
        x, y = chunk[:, :-1], chunk[:, 1:]

        if ban is not None:
            # 入力 (x) はそのまま。目標 (y) だけ外すので、文脈としては見えたまま
            y = y.masked_fill(torch.isin(y, ban), IGNORE)

        yield x, y


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


def speaker_grad_scale():
    """話者トークンの行にだけ勾配の倍率を掛ける。

    埋め込み表の一部だけ学習率を変えるには行単位のスケールが要るので、
    optimizer の param_group ではなく**勾配のフック**で掛ける。

    **head と embed は tying している**ので、この倍率は「その人を表す向き」
    だけでなく「その人が次に喋る確率」の学習にも掛かる。発言の少ない人の
    logit が振れやすくなるということなので、上限 (--speaker-lr-cap) を
    置いて効き過ぎないようにする。既定は 1.0 = 無効で、振りの軸にする。
    """
    if args.speaker_lr_cap <= 1.0:
        return None

    speakers_json = corpus / "speakers.json"
    if not speakers_json.exists():
        print("speakers.json が無いので話者の学習率補正は掛けない")
        return None

    rows = json.loads(speakers_json.read_text(encoding="utf8"))
    counts = [max(1, row["count"]) for row in rows]
    # 幾何平均。件数が 276 倍も開いているので算術平均だと上位に引っぱられる
    ref = math.exp(sum(math.log(c) for c in counts) / len(counts))
    cap = args.speaker_lr_cap

    scale = torch.ones(cfg.vocab_size)
    for row, count in zip(rows, counts):
        piece = sp.piece_to_id(row["token"])
        # 語彙に無い = 世代がずれている。**黙って進めない** (学習していない
        # トークンを推論で渡す形になる)
        if piece <= 0:
            raise SystemExit(f"{row['token']} が tokenizer に無い。世代が対になっていない")
        scale[piece] = min(cap, max(1.0 / cap, math.sqrt(ref / count)))

    touched = scale[scale != 1.0]
    print(f"話者の学習率補正: {len(rows)} 人 / 基準 {ref:,.0f} 件 / "
          f"範囲 ×{touched.min():.2f}〜×{touched.max():.2f} (上限 ×{cap})")

    scale = scale.to(device).unsqueeze(1)
    model.embed.weight.register_hook(lambda grad: grad * scale)
    return scale


speaker_scale = speaker_grad_scale()


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

    **ここは半精度にしない。** 20 iter しか回さないので速度に効かないし、
    fp16 で測ると evex-1 / evex-2 の val (4.2404 / 4.0384) と桁の揃わない数字になる。
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
#
# **トークンは決め打ちにしない。**世代で語彙が変わる — evex-1/2 は <|other|> を
# 持っていたが v4 には無いので、そのまま書くとバイト分解された文字列を渡すことに
# なり、サンプルが読めなくなって「学習が壊れている」ように見える。
def piece(*candidates):
    """語彙にあるものを先頭から選ぶ。どれも無ければ最後のものを返す。"""
    for name in candidates:
        if sp.piece_to_id(name) != sp.unk_id():
            return name
    return candidates[-1]


ME, YOU, ANON = piece("<|s0|>"), piece("<|s3|>", "<|s0|>"), piece("<|a|>", "<|other|>")

# チャンネル (evex-4 以降)。**学習データは 100% がこれで始まる**ので、
# 付けずに引くとサンプルだけ分布の外になる。持たない世代では空文字になる
CH = piece("<|c0|>", "")
CH2 = piece("<|c2|>", "<|c0|>", "")

SAMPLE_PROMPTS = [
    f"{CH2}<|conv|>{YOU}Cloudflare Containers ってどうなん{ME}",
    f"{CH2}<|conv|>{ME}rebase 疲れた{YOU}",
    f"{CH}<|conv|>{ANON}これバグってる？{ANON}",
    # 返信先まで置く形 (evex-3 以降)。学習と同じ並びを見せる
    f"{CH}<|conv|>{ANON}日本の首都どこ{ME}<|re|>{ANON}",
    f"{CH}<|conv|>",
]


def samples(tag):
    end_id = sp.piece_to_id("<|end|>")
    lines = []
    for prompt in SAMPLE_PROMPTS:
        # **モデルと同じ device に置く。**CPU 決め打ちにしていたので、cuda で回すと
        # epoch の終わりにここで落ちた (「index is on cpu」)。学習は CPU でしか
        # 回していなかったので気付けなかった。**チェックポイントの保存はこの前**なので
        # 重みは残るが、そのあとの push まで進まずに全部無駄になる
        ids = torch.tensor([sp.encode(prompt, out_type=int)], dtype=torch.long, device=device)
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
    with torch.autocast("cuda", dtype=amp_dtype, enabled=amp_on):
        _, loss = model(x, y)

    opt.zero_grad(set_to_none=True)
    scaler.scale(loss).backward()
    # clip する前に必ず戻す。スケールしたままの勾配を切ると閾値が意味を失う
    scaler.unscale_(opt)
    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    scaler.step(opt)
    scaler.update()

    seen += tokens_per_step

    if (step + 1) % 20 == 0:
        rate = seen / (time.time() - window)
        print(f"step {step + 1:>6}/{total_steps}  loss {loss.item():.4f}  "
              f"lr {lr_at(step):.2e}  {rate:,.0f} tok/s", flush=True)
        window, seen = time.time(), 0

    if args.bench and step + 1 == 200:
        # **測る前に必ず同期する。** cuda はカーネルの起動が非同期なので、
        # 待たずに time.time() を読むと実際より速い数字が出る
        if picked == "cuda":
            torch.cuda.synchronize()
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
        # **サンプルで落ちても学習は止めない。**読むためのおまけなので、ここで
        # 例外を上げると残りの epoch と push が丸ごと消える (実際に消した)。
        try:
            for line in samples(f"e{epoch}"):
                print(f"    {line[:160]}", flush=True)
        except Exception as error:                                    # noqa: BLE001
            print(f"    (サンプル生成は飛ばした: {error})", flush=True)

        (out / "history.json").write_text(json.dumps(history, indent=2))

print()
print(f"完了 {(time.time() - started) / 60:.0f} 分")
best = min(history, key=lambda h: h["val"]) if history else None
if best:
    print(f"val 最小は epoch {best['epoch']} ({best['val']:.4f})")
    print("文体は val 最小より後の方が「らしい」ことがあるので、samples-*.txt を読んで選ぶ")
