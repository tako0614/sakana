#!/usr/bin/env python3
"""evex-1/2 をブラウザ向け ONNX + tokenizer.json に変換する。

ONNX グラフはレイヤーごとの KV cache を入出力に持つ。最初の呼び出しだけ
プロンプト全体を渡し、以後は生成した 1 token だけを渡せる。

Usage:
    .venv-llm/bin/python scripts/llm/export-web.py \
      /path/to/hf/snapshot /path/to/output
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
from pathlib import Path

import sentencepiece as spm
import torch
from safetensors.torch import load_file
from tokenizers import AddedToken, Regex, Tokenizer, decoders, normalizers, pre_tokenizers
from tokenizers.models import BPE
from transformers.convert_slow_tokenizer import SentencePieceExtractor

from model import Config, MicroLM, RMSNorm


class CachedMicroLM(torch.nn.Module):
    """MicroLM と同じ計算を、ONNX に載る明示的な cache 付き演算で行う。"""

    def __init__(self, model: MicroLM):
        super().__init__()
        self.model = model
        self.cfg = model.cfg

    @staticmethod
    def _norm(layer: RMSNorm, x: torch.Tensor) -> torch.Tensor:
        inv = torch.rsqrt(torch.mean(x.float() * x.float(), dim=-1, keepdim=True) + layer.eps)
        return (x.float() * inv).to(x.dtype) * layer.weight

    def _rope(self, x: torch.Tensor, offset: torch.Tensor) -> torch.Tensor:
        # x: [B, H, T, D]. offset は過去 cache の長さ。
        half = self.cfg.d_head // 2
        inv = 1.0 / (
            10000.0
            ** (torch.arange(0, half, device=x.device, dtype=torch.float32) * 2 / self.cfg.d_head)
        )
        positions = torch.arange(x.shape[2], device=x.device, dtype=torch.float32) + offset.float()
        freqs = positions[:, None] * inv[None, :]
        cos = torch.cos(freqs)[None, None, :, :]
        sin = torch.sin(freqs)[None, None, :, :]
        even, odd = x[..., 0::2], x[..., 1::2]
        rotated = torch.stack((even * cos - odd * sin, even * sin + odd * cos), dim=-1)
        return rotated.flatten(-2)

    def forward(self, input_ids: torch.Tensor, *past: torch.Tensor):
        x = self.model.embed(input_ids)
        outputs: list[torch.Tensor] = []

        for layer_index, block in enumerate(self.model.blocks):
            past_k = past[layer_index * 2]
            past_v = past[layer_index * 2 + 1]
            past_len = torch._shape_as_tensor(past_k)[2]

            residual = x
            normed = self._norm(block.n1, x)
            q, k, v = block.attn.qkv(normed).split(self.cfg.d_model, dim=2)
            batch, length, _ = q.shape
            shape = (batch, length, self.cfg.n_heads, self.cfg.d_head)
            q = q.view(shape).transpose(1, 2)
            k = k.view(shape).transpose(1, 2)
            v = v.view(shape).transpose(1, 2)
            q = self._rope(q, past_len)
            k = self._rope(k, past_len)

            present_k = torch.cat((past_k, k), dim=2)
            present_v = torch.cat((past_v, v), dim=2)
            scores = torch.matmul(q, present_k.transpose(-2, -1)) / math.sqrt(self.cfg.d_head)

            # query i が見られる key は、past_len + i まで。
            query_pos = torch.arange(length, device=x.device)[:, None] + past_len
            key_pos = torch.arange(present_k.shape[2], device=x.device)[None, :]
            scores = scores.masked_fill(key_pos > query_pos, torch.finfo(scores.dtype).min)
            attention = torch.softmax(scores.float(), dim=-1).to(scores.dtype)
            attended = torch.matmul(attention, present_v)
            attended = attended.transpose(1, 2).contiguous().view(batch, length, self.cfg.d_model)
            x = residual + block.attn.proj(attended)

            residual = x
            normed = self._norm(block.n2, x)
            x = residual + block.ff.down(torch.nn.functional.silu(block.ff.gate(normed)) * block.ff.up(normed))
            outputs.extend((present_k, present_v))

        logits = self.model.head(self._norm(self.model.norm, x))
        return (logits, *outputs)


def load_model(source: Path) -> MicroLM:
    raw = json.loads((source / "config.json").read_text(encoding="utf-8"))
    cfg = Config(
        vocab_size=raw["vocab_size"],
        n_layers=raw["n_layers"],
        d_model=raw["d_model"],
        n_heads=raw["n_heads"],
        context=raw["context"],
        dropout=0.0,
        attn_dropout=0.0,
    )
    model = MicroLM(cfg)
    missing, unexpected = model.load_state_dict(load_file(source / "model.safetensors"), strict=False)
    if unexpected or any(name != "head.weight" for name in missing):
        raise RuntimeError(f"state dict mismatch: missing={missing}, unexpected={unexpected}")
    return model.eval()


def export_onnx(model: MicroLM, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    cfg = model.cfg
    wrapper = CachedMicroLM(model).eval()
    input_ids = torch.tensor([[3, 6, 100]], dtype=torch.long)
    empty_cache = tuple(
        torch.empty((1, cfg.n_heads, 0, cfg.d_head), dtype=torch.float32)
        for _ in range(cfg.n_layers * 2)
    )
    input_names = ["input_ids"]
    output_names = ["logits"]
    dynamic_axes: dict[str, dict[int, str]] = {"input_ids": {1: "sequence"}, "logits": {1: "sequence"}}
    for index in range(cfg.n_layers):
        for kind in ("key", "value"):
            input_name = f"past.{index}.{kind}"
            output_name = f"present.{index}.{kind}"
            input_names.append(input_name)
            output_names.append(output_name)
            dynamic_axes[input_name] = {2: "past_sequence"}
            dynamic_axes[output_name] = {2: "total_sequence"}

    torch.onnx.export(
        wrapper,
        (input_ids, *empty_cache),
        destination,
        input_names=input_names,
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        opset_version=18,
        do_constant_folding=True,
        dynamo=False,
    )


def export_tokenizer(source: Path, destination: Path) -> None:
    model_file = source / "tok.model"
    processor = spm.SentencePieceProcessor(model_file=str(model_file))
    proto = processor.serialized_model_proto()

    # SentencePieceExtractor は score 順から、元の BPE merge 順を復元する。
    vocab_scores = [(processor.id_to_piece(i), processor.get_score(i)) for i in range(processor.get_piece_size())]
    extracted = SentencePieceExtractor(str(model_file)).extract(BPE)
    vocab = extracted["vocab"]
    merges = extracted["merges"]
    tokenizer = Tokenizer(BPE(vocab, merges, unk_token="<unk>", fuse_unk=True, byte_fallback=True))

    # identity normalization / no dummy prefix / whitespace preservation は学習時の指定。
    tokenizer.normalizer = normalizers.Sequence([normalizers.Replace(Regex("\\r\\n|[\\n\\r]"), "<nl>")])
    tokenizer.pre_tokenizer = pre_tokenizers.Metaspace(replacement="▁", prepend_scheme="never", split=True)
    tokenizer.decoder = decoders.Sequence(
        [decoders.Metaspace(replacement="▁", prepend_scheme="never"), decoders.ByteFallback(), decoders.Fuse()]
    )

    from sentencepiece import sentencepiece_model_pb2

    parsed = sentencepiece_model_pb2.ModelProto()
    parsed.ParseFromString(proto)
    tokenizer.add_tokens(
        [
            AddedToken(piece.piece, normalized=False, special=piece.type == 3)
            for piece in parsed.pieces
            if piece.type in (3, 4)
        ]
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    tokenizer.save(str(destination), pretty=True)

    # 変換が静かにずれるのが一番危険。実際の制御記号・日本語・byte fallback を比較する。
    probes = [
        "<|conv|><|other|>こんにちは<|other|>",
        "空白  を  保つ",
        "全角　と半角 🙂 ⚗️",
        "<code>const x = 1;</code><nl>次",
        "https://example.com/@someone",
    ]
    for text in probes:
        expected = processor.encode(text, out_type=int)
        actual = tokenizer.encode(text, add_special_tokens=False).ids
        if expected != actual:
            raise RuntimeError(f"tokenizer parity failed for {text!r}: {expected} != {actual}")
        if processor.decode(expected) != tokenizer.decode(actual, skip_special_tokens=False):
            raise RuntimeError(f"tokenizer decode parity failed for {text!r}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    output = args.output.resolve()

    model = load_model(source)
    export_onnx(model, output / "onnx" / "model.onnx")
    export_tokenizer(source, output / "tokenizer.json")
    shutil.copy2(source / "speakers.json", output / "speakers.json")
    (output / "tokenizer_config.json").write_text(
        json.dumps(
            {
                "tokenizer_class": "PreTrainedTokenizerFast",
                "unk_token": "<unk>",
                "bos_token": "<s>",
                "eos_token": "</s>",
                "model_max_length": model.cfg.context,
                "clean_up_tokenization_spaces": False,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (output / "browser-config.json").write_text(
        json.dumps(
            {
                "format": "evex-cached-onnx-v1",
                "vocab_size": model.cfg.vocab_size,
                "layers": model.cfg.n_layers,
                "heads": model.cfg.n_heads,
                "head_dim": model.cfg.d_head,
                "context": model.cfg.context,
                "dtype": "float32",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"exported browser artifacts to {output}")


if __name__ == "__main__":
    main()
