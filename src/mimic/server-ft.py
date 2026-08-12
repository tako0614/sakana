"""追加学習した大きい方 (evex-ft-1) の推論を常駐させる。127.0.0.1 だけで待ち受ける。

    .venv-llm/bin/python src/mimic/server-ft.py --model mimic-ft --port 8766

server.py (自作 5.87M 用) と **HTTP の契約を同じにしてある**ので、bot 側は
接続先を変えるだけで繋がる。中身が transformers になっただけ:

    POST /generate  {prompt, max_new_tokens, temperature, top_k, min_p, repetition_penalty}
    GET  /health    {format, label, params, ...}

evex-1 と**同時に立てる**前提で別ポートにする。世代を置き換えないのは性質が
違うから — あちらは 94万件だけで純度が高い代わりに荒く、こちらは Qwen3-0.6B の
日本語を引き継いで読める代わりに Qwen の知識が混ざる。/model で選んで比べる。

## 速度

実測 (i5-12600K / 8スレッド / fp32): 9.4 tok/s。毎トークン重み 2.22GB を読むので
メモリ帯域で決まる (実効 20.9 GB/s)。--int8 で Linear を動的量子化すると重みが
1/4 になるぶん速くなる。llama.cpp の Q8_0 なら 36+ tok/s だが、まず品質を見てから
ビルドする (載せる価値が無かったときに無駄になる)。

そのため max_new_tokens の既定は小さめ。返答は1発言なので、長く生成させても
bot 側が最初の1発言で切り捨てる。
"""

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

parser = argparse.ArgumentParser()
parser.add_argument("--model", default="mimic-ft", help="重みのディレクトリ")
parser.add_argument("--label", default=os.environ.get("MIMIC_FT_LABEL", "evex-ft-1-preview"))
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=8766)
# 生成は 1 トークンずつなので並列度が上がらない。bot と同居するならコアを全部
# 取らない方がいい (bot 側の応答が詰まる)
parser.add_argument("--threads", type=int, default=int(os.environ.get("MIMIC_FT_THREADS", 6)))
parser.add_argument("--max-new-cap", type=int, default=200)
# Linear を int8 に動的量子化する。0.6B のうち lm_head だけで 155M (vocab 151,936)
# あるので効きは大きいが、小さいモデルは量子化の影響も大きい。比べてから決める
parser.add_argument("--int8", action="store_true")
args = parser.parse_args()

torch.set_num_threads(args.threads)
torch.set_grad_enabled(False)

model_dir = Path(args.model)
if not model_dir.exists():
    raise SystemExit(f"重みが無い: {model_dir}")

tok = AutoTokenizer.from_pretrained(str(model_dir))
model = AutoModelForCausalLM.from_pretrained(str(model_dir), dtype=torch.float32)
model.eval()
model.config.use_cache = True

params = sum(p.numel() for p in model.parameters())

if args.int8:
    model = torch.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)

# 学習時の記録があれば出す (どの epoch を載せているかを /model に表示するため)
meta = {}
for name in ("history.json", "meta.json"):
    path = model_dir / name
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf8"))
            meta = loaded[-1] if isinstance(loaded, list) and loaded else loaded
            break
        except (ValueError, OSError):
            pass

INFO = {
    # bot 側はこれを見て直列化の形式を決める。取り違えるとモデルが一度も見ていない
    # 入力を受け取り、例外を出さずに静かに崩れる (evex-1 に <|a|> を渡して壊した)
    "format": "plain",
    "label": args.label,
    "params": params,
    "int8": bool(args.int8),
    "epoch": meta.get("epoch"),
    "val_loss": meta.get("val_loss"),
    "model": str(model_dir),
    # 素の日本語形式なので独自の役トークンは持たない。bot 側は labels.json を見る
    "roles": [],
    "speakers": [],
}

# 1 プロセスで同時に回すと互いに遅くなるだけなので直列化する
lock = threading.Lock()


def run(prompt, max_new_tokens, temperature, top_k, min_p, repetition_penalty):
    ids = tok(prompt, return_tensors="pt")
    # 学習の窓は 1024。超えたら後ろを残す (直近の会話が本題)
    if ids.input_ids.shape[1] > 1023:
        ids = {k: v[:, -1023:] for k, v in ids.items()}

    with lock:
        out = model.generate(
            **ids,
            max_new_tokens=max_new_tokens,
            do_sample=temperature > 0,
            temperature=temperature,
            top_k=top_k,
            # min_p と繰り返しペナルティは top_k だけのときより崩れた出力が減る。
            # 5.87M のときは記号だけの返答が 38% 出たが、あれは推論側で禁止して
            # 抑えるしかなかった。こちらは素のサンプリングで抑える
            min_p=min_p,
            repetition_penalty=repetition_penalty,
            pad_token_id=tok.eos_token_id,
        )

    # bot 側は prompt を落として続きだけを見るので、全文を返す
    return tok.decode(out[0], skip_special_tokens=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/health":
            self._send(404, {"error": "not found"})
            return
        self._send(200, INFO)

    def do_POST(self):
        if self.path != "/generate":
            self._send(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError) as error:
            self._send(400, {"error": f"bad request: {error}"})
            return

        prompt = payload.get("prompt") or ""
        if not prompt:
            self._send(400, {"error": "prompt is required"})
            return

        started = time.time()
        try:
            text = run(
                prompt,
                min(int(payload.get("max_new_tokens", 64)), args.max_new_cap),
                float(payload.get("temperature", 0.9)),
                int(payload.get("top_k", 40)),
                float(payload.get("min_p", 0.05)),
                float(payload.get("repetition_penalty", 1.1)),
            )
        except Exception as error:  # noqa: BLE001 - 落とさずに理由を返す
            self._send(500, {"error": str(error)})
            return

        self._send(200, {"text": text, "took_ms": int((time.time() - started) * 1000), **INFO})

    def log_message(self, fmt, *fmt_args):
        # 1 リクエストごとの行は要らない。エラーは _send 側で返している
        pass


print(f"{model_dir} / {params:,} params / int8 {args.int8}")
print(f"epoch {INFO['epoch']} / val {INFO['val_loss']}")
print(f"threads {args.threads} / listening on http://{args.host}:{args.port}", flush=True)

ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
