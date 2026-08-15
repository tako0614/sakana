#!/usr/bin/env python3
"""evex-ft-1 の選択 epoch を WebGPU fp16 ONNX に変換する。

学習に使った Transformers 5 は `rope_parameters` を書く一方、現行の
Optimum ONNX が要求する Transformers 4 は `rope_theta` を読む。変換前に値を
明示的に橋渡ししないと既定の 10000 に戻るため、このスクリプトに変換境界を集約する。

Usage:
    .venv-llm/bin/python scripts/llm/export-ft-web.py \
      /path/to/evex-ft-1/epoch-2 /path/to/output
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


SMALL_FILES = (
    "chat_template.jinja",
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    source_config = json.loads((source / "config.json").read_text(encoding="utf-8"))
    rope_parameters = source_config.get("rope_parameters") or {}
    rope_theta = rope_parameters.get("rope_theta", source_config.get("rope_theta"))
    if not rope_theta:
        raise RuntimeError("Qwen3 RoPE theta is missing")

    optimum_cli = Path(sys.executable).with_name("optimum-cli")
    if not optimum_cli.exists():
        raise RuntimeError("optimum-cli is missing; install optimum-onnx[onnxruntime]")

    with tempfile.TemporaryDirectory(prefix="evex-ft-web-", dir=output.parent) as temporary:
        stage = Path(temporary) / "source"
        raw_output = Path(temporary) / "onnx"
        stage.mkdir()
        for name in SMALL_FILES:
            shutil.copy2(source / name, stage / name)
        os.symlink(source / "model.safetensors", stage / "model.safetensors")

        compatible = dict(source_config)
        compatible["rope_theta"] = float(rope_theta)
        (stage / "config.json").write_text(
            json.dumps(compatible, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

        subprocess.run(
            [
                str(optimum_cli),
                "export",
                "onnx",
                "-m",
                str(stage),
                "--task",
                "text-generation-with-past",
                "--dtype",
                "fp16",
                "--opset",
                "18",
                "--atol",
                "1.5",
                str(raw_output),
            ],
            check=True,
        )

        exported_config = json.loads((raw_output / "config.json").read_text(encoding="utf-8"))
        if exported_config.get("rope_theta") != float(rope_theta):
            raise RuntimeError(
                f"RoPE theta drifted during export: {exported_config.get('rope_theta')} != {rope_theta}"
            )

        (output / "onnx").mkdir(parents=True, exist_ok=True)
        os.replace(raw_output / "model.onnx", output / "onnx" / "model_fp16.onnx")
        for name in SMALL_FILES:
            source_file = raw_output / name if (raw_output / name).exists() else stage / name
            shutil.copy2(source_file, output / name)
        (output / "browser-config.json").write_text(
            json.dumps(
                {
                    "format": "transformers-js-qwen3-fp16-v1",
                    "epoch": 2,
                    "context": 1024,
                    "dtype": "fp16",
                    "device": "webgpu",
                    "download_bytes": (output / "onnx" / "model_fp16.onnx").stat().st_size,
                    "rope_theta": float(rope_theta),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    print(f"exported WebGPU fp16 artifacts to {output}")


if __name__ == "__main__":
    main()
