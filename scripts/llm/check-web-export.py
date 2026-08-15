#!/usr/bin/env python3
"""export-web.py の ONNX が PyTorch と一致し、KV cache が使えることを検証する。"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch


_SPEC = importlib.util.spec_from_file_location("export_web", Path(__file__).with_name("export-web.py"))
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError("export-web.py could not be loaded")
_EXPORT_WEB = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_EXPORT_WEB)
load_model = _EXPORT_WEB.load_model


def empty_cache(config: dict) -> dict[str, np.ndarray]:
    return {
        f"past.{layer}.{kind}": np.empty(
            (1, config["heads"], 0, config["head_dim"]), dtype=np.float32
        )
        for layer in range(config["layers"])
        for kind in ("key", "value")
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("export", type=Path)
    args = parser.parse_args()

    graph_path = args.export / "onnx" / "model.onnx"
    onnx.checker.check_model(onnx.load(graph_path))
    config = json.loads((args.export / "browser-config.json").read_text(encoding="utf-8"))
    session = ort.InferenceSession(str(graph_path), providers=["CPUExecutionProvider"])
    ids = np.asarray([[3, 6, 314, 159, 6]], dtype=np.int64)

    full = session.run(None, {"input_ids": ids, **empty_cache(config)})
    prefix = session.run(None, {"input_ids": ids[:, :-1], **empty_cache(config)})
    cached_feeds = {"input_ids": ids[:, -1:]}
    for layer in range(config["layers"]):
        cached_feeds[f"past.{layer}.key"] = prefix[1 + layer * 2]
        cached_feeds[f"past.{layer}.value"] = prefix[2 + layer * 2]
    cached = session.run(None, cached_feeds)

    model = load_model(args.source)
    with torch.no_grad():
        expected, _ = model(torch.from_numpy(ids))
    np.testing.assert_allclose(full[0], expected.numpy(), rtol=2e-4, atol=2e-4)
    np.testing.assert_allclose(cached[0][:, -1], full[0][:, -1], rtol=2e-4, atol=2e-4)
    print("ONNX parity ok; KV cache incremental output matches full inference")


if __name__ == "__main__":
    main()
