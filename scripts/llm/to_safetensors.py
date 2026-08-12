"""チェックポイントを safetensors に変換する (公開用)。

    .venv-llm/bin/python scripts/llm/to_safetensors.py scripts/llm/out/ckpt-e10.pt dist/hf

`.pt` は pickle なので、落とした人が読み込むと任意コードが走りうる。公開するなら
safetensors にする。アーキテクチャの数値は checkpoint の中にあるので、
テンソルと一緒に失わないよう別で出す。

話者の対応表 (Discord の user_id → 表示名) は出さない。あれはモデルの動作に要らず、
同意を取っていない実在の人物のデータなので、公開物に混ぜない。
"""

import argparse
import json
from pathlib import Path

import torch
from safetensors.torch import save_file

parser = argparse.ArgumentParser()
parser.add_argument("ckpt")
parser.add_argument("out", nargs="?", default="dist/hf")
args = parser.parse_args()

blob = torch.load(args.ckpt, map_location="cpu", weights_only=False)
state = blob["model"]

out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)

# weight tying で embed と head が同じテンソルを指しているので、
# safetensors がストレージの共有を拒む。head を落として読み込み側で結び直す。
shared = [k for k in state if k.endswith("head.weight")]
tensors = {k: v.contiguous().clone() for k, v in state.items() if k not in shared}

save_file(tensors, str(out / "model.safetensors"), metadata={"format": "pt"})

config = {
    **{k: v for k, v in blob["config"].items()},
    "architecture": "decoder-only transformer (RoPE + RMSNorm + SwiGLU)",
    "tie_word_embeddings": True,
    "trained_epoch": blob.get("epoch"),
    "train_loss": blob.get("train_loss"),
    "val_loss": blob.get("val_loss"),
    "params": sum(t.numel() for t in tensors.values()),
}
(out / "config.json").write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n")

size = (out / "model.safetensors").stat().st_size
print(f"model.safetensors  {size / 1024 / 1024:.2f} MB")
print(f"params             {config['params']:,}")
print(f"epoch {config['trained_epoch']} / val {config['val_loss']:.4f}")
print(f"tie_word_embeddings: head.weight は落として embed と結び直す前提 ({shared})")
