"""Decoder-only Transformer。RoPE + RMSNorm + SwiGLU + weight tying。

669万トークンしか無いので、パラメータは意図的に小さく取る (Chinchilla 最適は 33万)。
d_model / n_layers は環境変数で振れるようにしてある。

    .venv-llm/bin/python scripts/llm/model.py     # パラメータ数と過学習テスト
"""

import math
import os
from dataclasses import dataclass

import torch
import torch.nn.functional as F
from torch import nn


@dataclass
class Config:
    vocab_size: int = 4096
    n_layers: int = int(os.environ.get("LLM_LAYERS", 6))
    d_model: int = int(os.environ.get("LLM_DMODEL", 256))
    n_heads: int = int(os.environ.get("LLM_HEADS", 4))
    context: int = int(os.environ.get("LLM_CONTEXT", 512))
    dropout: float = float(os.environ.get("LLM_DROPOUT", 0.1))
    # アテンション内の dropout は既定で切る。
    #
    # dropout_p > 0 を渡すと scaled_dot_product_attention は融合カーネルを使えず、
    # B×H×T×T のアテンション行列を実体化する math 経路に落ちる
    # (24×4×512×512 で 1 層あたり 100MB。6 層ぶんの往復でメモリ帯域を食い潰す)。
    # 正則化は残差側の dropout で足りるので、ここは 0 にして融合経路に乗せる。
    attn_dropout: float = float(os.environ.get("LLM_ATTN_DROPOUT", 0.0))

    # --- evex-5 で足したもの。**既定は False で、旧世代の重みがそのまま読める** ---
    #
    # PLE (Per-Layer Embeddings / Gemma 3n)。トークンごと・層ごとの補助ベクトルを
    # 引いて各層の残差に足す。**行列積ではなく引き算**なので、容量は増えるのに
    # 計算量はほぼ増えない (d_ple=64 で パラメータ +34% / FLOP +1.04%)。
    #
    # evex は CPU 推論で行列積律速なので、この交換比は理屈が合う。
    ple: bool = os.environ.get("LLM_PLE", "0") == "1"
    d_ple: int = int(os.environ.get("LLM_DPLE", 64))
    # q/k を RMSNorm してから RoPE を掛ける (Gemma 3)。ほぼ 0 パラメータで
    # 学習が安定し、学習率を上げられる
    qk_norm: bool = os.environ.get("LLM_QK_NORM", "0") == "1"

    @property
    def d_ff(self):
        # SwiGLU は行列が 3 つなので、4*d_model 相当に合わせて 2/3 に縮める。
        # 64 の倍数に丸めて行列積を素直にする。
        raw = int(self.d_model * 4 * 2 / 3)
        return (raw + 63) // 64 * 64

    @property
    def d_head(self):
        return self.d_model // self.n_heads


class RMSNorm(nn.Module):
    """LayerNorm から平均を引く処理を落としたもの。小さいモデルでは差が出ないが安い。"""

    def __init__(self, dim, eps=1e-6):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(dim))
        self.eps = eps

    def forward(self, x):
        norm = x.float().pow(2).mean(-1, keepdim=True).add(self.eps).rsqrt()
        return (x.float() * norm).type_as(x) * self.weight


def rope_cache(context, d_head, device, base=10000.0):
    """RoPE の cos/sin を先に作っておく。学習中は使い回すだけ。"""
    inv = 1.0 / (base ** (torch.arange(0, d_head, 2, device=device).float() / d_head))
    pos = torch.arange(context, device=device).float()
    freqs = torch.outer(pos, inv)
    return freqs.cos(), freqs.sin()


def apply_rope(x, cos, sin):
    # x: (B, heads, T, d_head)
    t = x.shape[2]
    cos = cos[:t].view(1, 1, t, -1)
    sin = sin[:t].view(1, 1, t, -1)

    # **回転は fp32 で計算して、最後に x の型に戻す。**
    #
    # cos/sin は fp32 の buffer なので、半精度の x と掛けると結果だけ fp32 に
    # 昇格する。そのまま返すと q/k が fp32・v が半精度で
    # scaled_dot_product_attention に入り、型が揃わない。
    # 精度も落とさずに済むので、計算は fp32 のまま最後に揃える。
    even, odd = x[..., 0::2].float(), x[..., 1::2].float()
    rotated = torch.stack((even * cos - odd * sin, even * sin + odd * cos), dim=-1)
    return rotated.flatten(-2).to(x.dtype)


class Attention(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.cfg = cfg
        self.qkv = nn.Linear(cfg.d_model, cfg.d_model * 3, bias=False)
        self.proj = nn.Linear(cfg.d_model, cfg.d_model, bias=False)
        self.dropout = cfg.attn_dropout
        # **RoPE の前に掛ける。**後だと回転した向きごと正規化してしまう
        self.qn = RMSNorm(cfg.d_head) if cfg.qk_norm else None
        self.kn = RMSNorm(cfg.d_head) if cfg.qk_norm else None

    def forward(self, x, cos, sin, attn_mask=None):
        b, t, _ = x.shape
        h, dh = self.cfg.n_heads, self.cfg.d_head

        q, k, v = self.qkv(x).split(self.cfg.d_model, dim=2)
        q = q.view(b, t, h, dh).transpose(1, 2)
        k = k.view(b, t, h, dh).transpose(1, 2)
        v = v.view(b, t, h, dh).transpose(1, 2)

        if self.qn is not None:
            q, k = self.qn(q).type_as(v), self.kn(k).type_as(v)

        q = apply_rope(q, cos, sin)
        k = apply_rope(k, cos, sin)

        # is_causal で三角マスクは自前で持たない (CPU でも flash 経路に乗る)。
        #
        # **文書内マスクを渡すと融合カーネルから落ちる。**呼ぶ側が既に因果性を
        # 含めたマスクを組んでいるので、そのときは is_causal を外す
        out = F.scaled_dot_product_attention(
            q, k, v,
            attn_mask=attn_mask,
            is_causal=attn_mask is None,
            dropout_p=self.dropout if self.training else 0.0
        )
        return self.proj(out.transpose(1, 2).contiguous().view(b, t, self.cfg.d_model))


class SwiGLU(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.gate = nn.Linear(cfg.d_model, cfg.d_ff, bias=False)
        self.up = nn.Linear(cfg.d_model, cfg.d_ff, bias=False)
        self.down = nn.Linear(cfg.d_ff, cfg.d_model, bias=False)

    def forward(self, x):
        return self.down(F.silu(self.gate(x)) * self.up(x))


class Block(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.n1 = RMSNorm(cfg.d_model)
        self.attn = Attention(cfg)
        self.n2 = RMSNorm(cfg.d_model)
        self.ff = SwiGLU(cfg)
        self.drop = nn.Dropout(cfg.dropout)

        # PLE の注入 (Gemma 3n の per-layer input)。その層ぶんの補助ベクトル p を
        # ゲートで混ぜて残差に足す。**行列は d_model×d_ple の 2 枚だけ**なので、
        # 引いてきた容量に対して計算量はほとんど増えない
        if cfg.ple:
            self.ple_gate = nn.Linear(cfg.d_model, cfg.d_ple, bias=False)
            self.ple_out = nn.Linear(cfg.d_ple, cfg.d_model, bias=False)
        else:
            self.ple_gate = self.ple_out = None

    def forward(self, x, cos, sin, per_layer=None, attn_mask=None):
        x = x + self.drop(self.attn(self.n1(x), cos, sin, attn_mask))
        x = x + self.drop(self.ff(self.n2(x)))

        if self.ple_out is not None and per_layer is not None:
            x = x + self.ple_out(F.silu(self.ple_gate(x)) * per_layer)
        return x


class MicroLM(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.cfg = cfg
        self.embed = nn.Embedding(cfg.vocab_size, cfg.d_model)
        self.drop = nn.Dropout(cfg.dropout)
        self.blocks = nn.ModuleList(Block(cfg) for _ in range(cfg.n_layers))
        self.norm = RMSNorm(cfg.d_model)
        self.head = nn.Linear(cfg.d_model, cfg.vocab_size, bias=False)

        # PLE の 2 系統 (Gemma 3n と同じ組み合わせ):
        #   ple_table  トークン同一性。語彙 × 層 × d_ple の引き表
        #   ple_proj   文脈側。入力埋め込みから層ぶんを作る (per_layer_model_projection)
        # 足して RMSNorm したものが、その層の補助ベクトルになる
        if cfg.ple:
            self.ple_table = nn.Embedding(cfg.vocab_size, cfg.n_layers * cfg.d_ple)
            self.ple_proj = nn.Linear(cfg.d_model, cfg.n_layers * cfg.d_ple, bias=False)
            self.ple_norm = RMSNorm(cfg.d_ple)
        else:
            self.ple_table = self.ple_proj = self.ple_norm = None

        # weight tying。669万トークンで語彙 4096 ぶんの出力行列を別に学ぶ余裕はない
        self.head.weight = self.embed.weight

        cos, sin = rope_cache(cfg.context, cfg.d_head, torch.device("cpu"))
        self.register_buffer("cos", cos, persistent=False)
        self.register_buffer("sin", sin, persistent=False)

        self.apply(self._init)
        # 残差の出口だけ層数でスケールを落とす (深くしたときに発散させない)
        for name, param in self.named_parameters():
            if name.endswith("proj.weight") or name.endswith("down.weight"):
                nn.init.normal_(param, mean=0.0, std=0.02 / math.sqrt(2 * cfg.n_layers))

    @staticmethod
    def _init(module):
        if isinstance(module, nn.Linear):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def per_layer_inputs(self, idx, x):
        """各層に配る補助ベクトル (B, T, n_layers, d_ple)。PLE が無ければ None。"""
        if self.ple_table is None:
            return None
        b, t = idx.shape
        shape = (b, t, self.cfg.n_layers, self.cfg.d_ple)
        # 表の側だけ sqrt(d_ple) で持ち上げる (Gemma 3n と同じ。射影側と桁を揃える)
        table = self.ple_table(idx).view(shape) * math.sqrt(self.cfg.d_ple)
        return self.ple_norm(table + self.ple_proj(x).view(shape)).type_as(x)

    def forward(self, idx, targets=None, attn_mask=None):
        x = self.drop(self.embed(idx))
        per_layer = self.per_layer_inputs(idx, x)

        for i, block in enumerate(self.blocks):
            p = per_layer[:, :, i] if per_layer is not None else None
            x = block(x, self.cos, self.sin, p, attn_mask)
        logits = self.head(self.norm(x))

        if targets is None:
            return logits, None

        loss = F.cross_entropy(
            logits.view(-1, logits.size(-1)), targets.reshape(-1), ignore_index=-1
        )
        return logits, loss

    def parameter_count(self):
        # tying しているので head は数えない (embed と同じテンソル)
        seen = set()
        total = 0
        for param in self.parameters():
            if id(param) in seen:
                continue
            seen.add(id(param))
            total += param.numel()
        return total

    @torch.no_grad()
    def generate(self, idx, max_new_tokens, temperature=0.9, top_k=40, stop_id=None,
                 ban_ids=None, min_new_tokens=0, min_p=0.0, repetition_penalty=1.0):
        """ban_ids: 絶対に出させないトークン。min_new_tokens: それまでは stop_id も出させない。

        チャットに使うと `<url>` や `<file>` だけを吐いて終わることが多い
        (実測 38%)。あれは正規化が作った記号で発言ではないので、
        呼び出し側から外せるようにしてある。

        min_p と repetition_penalty は **evex-ft (transformers) 側と同じ手を
        こちらでも使えるようにするため**に足した。世代を読み比べるときに、
        サンプリングが違うと差がモデル由来かハーネス由来か分からなくなる。
        """
        self.eval()
        for step in range(max_new_tokens):
            window = idx[:, -self.cfg.context:]
            logits, _ = self(window)
            logits = logits[:, -1, :]

            # 繰り返しペナルティは温度より前に掛ける (transformers と同じ順序)。
            # 既に出したトークンの確率を割る。負の logit は掛ける方が下がるので分ける
            if repetition_penalty and repetition_penalty != 1.0:
                for row in range(idx.size(0)):
                    seen = torch.unique(idx[row])
                    picked = logits[row, seen]
                    logits[row, seen] = torch.where(
                        picked > 0, picked / repetition_penalty, picked * repetition_penalty
                    )

            logits = logits / max(temperature, 1e-5)

            if ban_ids:
                logits[:, ban_ids] = float("-inf")
            # 何か言う前に終わらせない
            if stop_id is not None and step < min_new_tokens:
                logits[:, stop_id] = float("-inf")

            if top_k:
                kth = torch.topk(logits, min(top_k, logits.size(-1))).values[:, -1:]
                logits = logits.masked_fill(logits < kth, float("-inf"))

            probs = F.softmax(logits, dim=-1)

            # min_p: 最大確率の min_p 倍を下回る候補を切る。top_k だけより崩れが減る。
            # 分布が尖っているときは強く絞り、平らなときは緩む
            if min_p and min_p > 0:
                floor = probs.max(dim=-1, keepdim=True).values * min_p
                probs = torch.where(probs < floor, torch.zeros_like(probs), probs)
                probs = probs / probs.sum(dim=-1, keepdim=True)

            nxt = torch.multinomial(probs, num_samples=1)
            idx = torch.cat((idx, nxt), dim=1)

            if stop_id is not None and int(nxt) == stop_id:
                break
        return idx


if __name__ == "__main__":
    cfg = Config()
    model = MicroLM(cfg)
    params = model.parameter_count()

    print(f"layers {cfg.n_layers} / d_model {cfg.d_model} / heads {cfg.n_heads} "
          f"/ d_ff {cfg.d_ff} / context {cfg.context}")
    print(f"パラメータ {params:,} ({params / 1e6:.2f}M)")

    embed = cfg.vocab_size * cfg.d_model
    print(f"  うち埋め込み {embed:,} ({embed / params * 100:.0f}%)")
    print(f"669万トークンに対して {6_685_152 / params:.1f} トークン/パラメータ"
          f" (Chinchilla 最適の {6_685_152 / params / 20 * 100:.0f}%)")

    # --- 実装が正しいかの確認 ---
    #
    # 小さい切片を暗記させる。ここで loss が落ちないならモデルかデータの配線が
    # 壊れているので、本番を一晩回す意味がない。
    #
    # dropout は切る。見ているのは「暗記できるか = 配線が通っているか」で、
    # 正則化が効いていると当然落ちきらない (0.1 のままだと 400 step で 0.62 止まり、
    # 切れば 200 step で 0.012 まで落ちる)。
    torch.manual_seed(0)
    model = MicroLM(Config(dropout=0.0))
    data = torch.randint(0, cfg.vocab_size, (4, 65))
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3)

    model.train()
    losses = []
    for step in range(200):
        _, loss = model(data[:, :-1], data[:, 1:])
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        losses.append(loss.item())

    print(f"暗記テスト loss {losses[0]:.3f} -> {losses[-1]:.4f}")
    assert losses[-1] < 0.1, f"暗記できていない (loss {losses[-1]:.3f})。配線が壊れている"

    # 生成が止まること
    out = model.generate(torch.zeros((1, 1), dtype=torch.long), max_new_tokens=8, stop_id=None)
    assert out.shape == (1, 9), out.shape

    print("model ok")
