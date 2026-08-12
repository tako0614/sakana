"""自作モデルの推論を常駐させる。127.0.0.1 だけで待ち受ける。

    .venv-llm/bin/python src/mimic/server.py --ckpt scripts/llm/out/ckpt-e8.pt

bot と同じプロセスで回さないのは、CPU 推論がイベントループを止めて Discord の
REST が全部落ちるから。別プロセスなら推論が固まっても bot は生きている。

FastAPI は入れない。要るのは POST 1本と health なので標準ライブラリで足りる。
"""

import argparse
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import sentencepiece as spm
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "llm"))
from model import Config, MicroLM  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--ckpt", default="scripts/llm/out/ckpt-e8.pt")
parser.add_argument("--corpus", default="corpus")
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=8765)
# 生成は 1 トークンずつなので並列度が上がらない。bot と同居するなら
# コアを全部取らない方がいい (bot 側の応答が詰まる)。
parser.add_argument("--threads", type=int, default=int(os.environ.get("MIMIC_THREADS", 4)))
parser.add_argument("--max-new-cap", type=int, default=300)
args = parser.parse_args()

torch.set_num_threads(args.threads)
torch.set_grad_enabled(False)

sp = spm.SentencePieceProcessor(model_file=str(Path(args.corpus) / "tok.model"))
END_ID = sp.piece_to_id("<|end|>")

# 正規化が作った記号は「発言」ではないので、既定でサンプリングから外す。
# これを許すと `<url>` だけ吐いて終わる返答が実測 38% 出た (外すと 12%)。
NORMALIZED = ("<file>", "<url>", "<mention>", "<channel>", "<time>", "<code>", "</code>")
DEFAULT_BAN = [sp.piece_to_id(t) for t in NORMALIZED]


def has_piece(piece):
    return sp.piece_to_id(piece) != sp.unk_id()


# 自分がどの形式で学習されたかを申告する。
#
# evex-1 は実在の人物に紐づく <|s0|>..<|s47|> と <|other|>、
# evex-2 は会話ごとに振り直す <|a|>..<|h|>。
# bot 側がこれを見ずに固定のトークンを渡すと、モデルが一度も見ていない記号を
# 受け取ってバイト分解され、出力が崩壊する (実際に evex-1 に <|a|> を渡して壊した)。
if has_piece("<|a|>"):
    ROLES = [f"<|{c}|>" for c in "abcdefgh"]
    OVERFLOW = "<|z|>"
elif has_piece("<|other|>"):
    # 相対の役は無いので、参加者は全員 <|other|>
    ROLES = ["<|other|>"]
    OVERFLOW = "<|other|>"
else:
    raise SystemExit("tokenizer が evex-1 でも evex-2 でもない")

blob = torch.load(args.ckpt, map_location="cpu", weights_only=False)
saved = blob["config"]
cfg = Config(
    vocab_size=saved["vocab_size"], n_layers=saved["n_layers"], d_model=saved["d_model"],
    n_heads=saved["n_heads"], context=saved["context"], dropout=0.0, attn_dropout=0.0,
)
model = MicroLM(cfg)
model.load_state_dict(blob["model"])
model.eval()

INFO = {
    "roles": ROLES,
    "overflow": OVERFLOW,
    "epoch": blob.get("epoch"),
    "val_loss": blob.get("val_loss"),
    "train_loss": blob.get("train_loss"),
    "params": model.parameter_count(),
    "ckpt": args.ckpt,
}

# 1 プロセスで同時に回すと互いに遅くなるだけなので直列化する
lock = threading.Lock()


def run(prompt, max_new_tokens, temperature, top_k, ban, min_new_tokens):
    ids = sp.encode(prompt, out_type=int)
    # プロンプトが context を超えていたら後ろを残す (直近の会話が本題)
    ids = ids[-(cfg.context - 1):]

    with lock:
        out = model.generate(
            torch.tensor([ids], dtype=torch.long),
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            top_k=top_k,
            stop_id=END_ID,
            ban_ids=ban,
            min_new_tokens=min_new_tokens,
        )
    return sp.decode(out[0].tolist())


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

        try:
            # ban を明示的に [] で渡せば素の挙動に戻せる (研究用)
            requested = payload.get("ban")
            ban = DEFAULT_BAN if requested is None else [
                sp.piece_to_id(t) for t in requested if sp.piece_to_id(t) > 0
            ]

            text = run(
                prompt,
                min(int(payload.get("max_new_tokens", 200)), args.max_new_cap),
                float(payload.get("temperature", 0.9)),
                int(payload.get("top_k", 40)),
                ban,
                int(payload.get("min_new_tokens", 2)),
            )
        except Exception as error:  # noqa: BLE001 - 落とさずに理由を返す
            self._send(500, {"error": str(error)})
            return

        self._send(200, {"text": text, **INFO})

    def log_message(self, fmt, *fmt_args):
        # 1 リクエストごとの行は要らない。エラーは _send 側で返している
        pass


print(f"ckpt {args.ckpt} (epoch {INFO['epoch']} / val {INFO['val_loss']})")
print(f"パラメータ {INFO['params']:,} / threads {args.threads}")
print(f"listening on http://{args.host}:{args.port}", flush=True)

ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
