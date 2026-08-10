#!/usr/bin/env python3
"""常駐して文章をベクトルにするワーカー。

analyze-emotions.py と違い、モデルのロードは起動時の1回だけ。
1件ごとに from_pretrained していると数十万件のバックフィルは不可能なので、
プロセスを立てたまま NDJSON で受け続ける。

プロトコル (1行1JSON, UTF-8, \\n 終端):
  Node -> Python
    {"id":1,"op":"embed","kind":"passage","encode":"int8","texts":["...","..."]}
    {"id":2,"op":"embed","kind":"query","encode":"float32","texts":["..."]}
    {"id":3,"op":"info"}
    {"op":"shutdown"}
  Python -> Node
    {"op":"ready","model":...,"dim":384,...}
    {"id":1,"ok":true,"dim":384,"encode":"int8","vectors":["<b64>"],"scales":[0.0019],...}
    {"id":1,"ok":false,"error":"...","fatal":false}

ベクトルは base64 で運ぶ。数値配列の JSON にすると 50万件で 1.8GB 余分に
パースすることになる。量子化は numpy 側でまとめてやる。
"""

import base64
import json
import os
import sys
import time

# 何かが print したときにプロトコルを壊さないよう、実 stdout を退避してから
# sys.stdout を stderr に差し替える。ライブラリの print は珍しくない。
_OUT = sys.stdout
sys.stdout = sys.stderr

os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np
import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

MODEL_NAME = os.environ.get("SEMANTIC_MODEL_NAME", "intfloat/multilingual-e5-small")
MAX_LENGTH = int(os.environ.get("SEMANTIC_MAX_LENGTH", "192"))
THREADS = int(os.environ.get("SEMANTIC_THREADS", "4"))
MICRO_BATCH = int(os.environ.get("SEMANTIC_MICRO_BATCH", "16"))
NICE = int(os.environ.get("SEMANTIC_NICE", "5"))

# e5 系は前置きが要る。ここで付けて embed_models に記録することで、
# 規約の違うモデルとベクトル空間が混ざるのを防ぐ。
PREFIX_QUERY = os.environ.get("SEMANTIC_PREFIX_QUERY", "query: ")
PREFIX_PASSAGE = os.environ.get("SEMANTIC_PREFIX_PASSAGE", "passage: ")


def emit(payload):
    _OUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _OUT.flush()


def log(level, message):
    emit({"op": "log", "level": level, "message": str(message)[:500]})


def quantize_int8(vectors):
    """対称量子化。単位ベクトルなので max|v| で割れば十分な精度が出る。

    クエリ側は float32 のまま比較する (非対称にして量子化損を取り戻す)。
    """
    scales = np.abs(vectors).max(axis=1) / 127.0
    scales[scales == 0] = 1.0
    quantized = np.rint(vectors / scales[:, None]).clip(-127, 127).astype(np.int8)
    return quantized, scales


class Embedder:
    def __init__(self):
        torch.set_num_threads(THREADS)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass  # 既に並列領域に入っていると失敗する

        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
        self.model = AutoModel.from_pretrained(MODEL_NAME)
        self.model.eval()
        self.dim = int(self.model.config.hidden_size)

    def encode(self, texts, kind):
        prefix = PREFIX_QUERY if kind == "query" else PREFIX_PASSAGE

        # 長さでまとめるとパディングの無駄が減り、ピークメモリも Node が
        # 何件送ってきても MICRO_BATCH で抑えられる。
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        out = np.zeros((len(texts), self.dim), dtype=np.float32)

        for start in range(0, len(order), MICRO_BATCH):
            chunk = order[start:start + MICRO_BATCH]
            batch = self.tokenizer(
                [prefix + texts[i] for i in chunk],
                padding=True, truncation=True, max_length=MAX_LENGTH,
                return_tensors="pt",
            )

            with torch.inference_mode():
                hidden = self.model(**batch).last_hidden_state

            # e5 は mean pooling で学習されている (CLS ではない)
            mask = batch["attention_mask"].unsqueeze(-1).float()
            pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
            pooled = F.normalize(pooled, p=2, dim=1)

            for row, index in enumerate(chunk):
                out[index] = pooled[row].numpy()

        return out


def handle_embed(embedder, request):
    texts = request.get("texts") or []
    if not isinstance(texts, list) or len(texts) == 0:
        raise ValueError("texts is required")

    cleaned = []
    for text in texts:
        value = "" if text is None else str(text)
        # 空文字を通すとゼロベクトルになり、何にでも 0 で当たる嘘の結果になる
        if not value.strip():
            raise ValueError("empty text is not allowed")
        cleaned.append(value)

    kind = request.get("kind", "passage")
    encode = request.get("encode", "int8")

    started = time.time()
    vectors = embedder.encode(cleaned, kind)

    response = {
        "id": request.get("id"),
        "ok": True,
        "dim": embedder.dim,
        "encode": encode,
        "count": len(cleaned),
        "ms": int((time.time() - started) * 1000),
    }

    if encode == "int8":
        quantized, scales = quantize_int8(vectors)
        response["vectors"] = [base64.b64encode(row.tobytes()).decode("ascii") for row in quantized]
        response["scales"] = [float(s) for s in scales]
    else:
        response["vectors"] = [base64.b64encode(row.tobytes()).decode("ascii") for row in vectors]
        response["scales"] = [1.0] * len(cleaned)

    return response


def main():
    try:
        os.nice(NICE)
    except OSError:
        pass  # 上げられないだけなので続行する

    embedder = Embedder()

    emit({
        "op": "ready",
        "model": MODEL_NAME,
        "dim": embedder.dim,
        "max_length": MAX_LENGTH,
        "prefix_query": PREFIX_QUERY,
        "prefix_passage": PREFIX_PASSAGE,
        "torch": torch.__version__,
        "threads": THREADS,
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            log("error", f"bad json: {error}")
            continue

        op = request.get("op")

        if op == "shutdown":
            break

        try:
            if op == "embed":
                emit(handle_embed(embedder, request))
            elif op == "info":
                emit({"id": request.get("id"), "ok": True, "model": MODEL_NAME, "dim": embedder.dim})
            else:
                emit({"id": request.get("id"), "ok": False, "error": f"unknown op: {op}", "fatal": False})
        except Exception as error:  # noqa: BLE001 - 1件の失敗でワーカーを落とさない
            emit({"id": request.get("id"), "ok": False, "error": str(error)[:500], "fatal": False})


if __name__ == "__main__":
    main()
