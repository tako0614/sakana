"""推論サーバーの入口の守り (src/mimic/http_guard.py) を確かめる。

torch もモデルも要らない。127.0.0.1 の空いているポートに中身の無いサーバーを立てて、
server.py と同じ GuardedHandler を通した要求がどう返るかを見る。

    python3 scripts/check-mimic-server.py
"""

import http.client
import json
import socket
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "mimic"))
from http_guard import (  # noqa: E402
    MAX_BODY_BYTES, BodyError, GuardedHandler, authorized, bind_error, body_length, is_loopback
)


def fail(message):
    raise SystemExit(f"FAIL {message}")


# --- 待ち受け先 ---
for host in ("127.0.0.1", "127.0.0.2", "::1", "localhost"):
    if not is_loopback(host):
        fail(f"{host} はループバック")
    if bind_error(host, None) is not None:
        fail(f"ループバック ({host}) は合言葉なしで起動できる (既定の動きを変えない)")
for host in ("0.0.0.0", "", "192.168.0.31", "::", "example.com"):
    if is_loopback(host):
        fail(f"{host!r} をループバック扱いしている")
    if bind_error(host, None) is None:
        fail(f"{host!r} で合言葉なしの起動を許している")
    if bind_error(host, "s3cret") is not None:
        fail(f"{host!r} は合言葉があれば起動できる")

# --- 合言葉 ---
if not authorized(None, None) or not authorized("Bearer x", None):
    fail("合言葉が無ければ通す")
for header in (None, "", "Bearer", "Bearer wrong", "Basic s3cret", "s3cret", "Bearer s3cret2"):
    if authorized(header, "s3cret"):
        fail(f"違う Authorization を通している: {header!r}")
for header in ("Bearer s3cret", "bearer s3cret", "Bearer  s3cret "):
    if not authorized(header, "s3cret"):
        fail(f"正しい Authorization を断っている: {header!r}")

# --- 本文の長さ ---
if body_length(None) != 0 or body_length("12") != 12 or body_length(str(MAX_BODY_BYTES)) != MAX_BODY_BYTES:
    fail("上限以下の長さを読めていない")
for value, status in ((str(MAX_BODY_BYTES + 1), 413), ("99999999999", 413), ("-1", 400), ("abc", 400)):
    try:
        body_length(value)
    except BodyError as error:
        if error.status != status:
            fail(f"content-length {value} は {status} (実際 {error.status})")
    else:
        fail(f"content-length {value} を通している")


# --- 実際の要求で ---
class Echo(GuardedHandler):
    def do_GET(self):
        if not self._authorized():
            return
        self._send(200, {"ok": True})

    def do_POST(self):
        if not self._authorized():
            return
        payload = self._read_json()
        if payload is None:
            return
        self._send(200, {"got": payload})


def serve(token):
    handler = type("Handler", (Echo,), {"token": token})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def request(server, method, path, body=None, headers=None, declared=None):
    conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
    try:
        conn.putrequest(method, path)
        for key, value in (headers or {}).items():
            conn.putheader(key, value)
        data = b"" if body is None else json.dumps(body).encode("utf8")
        conn.putheader("content-length", str(len(data) if declared is None else declared))
        conn.endheaders()
        # 申告だけ大きくして本文は送らない。サーバーが読みに行けばここで時間切れになる
        if declared is None:
            conn.send(data)
        response = conn.getresponse()
        return response.status, json.loads(response.read() or b"{}"), response.getheader("connection")
    finally:
        conn.close()


open_server = serve(None)
try:
    status, payload, _ = request(open_server, "POST", "/generate", {"prompt": "x"})
    if status != 200 or payload.get("got") != {"prompt": "x"}:
        fail(f"合言葉なしのループバックで普通の要求が通らない: {status} {payload}")

    # 上限を超える申告は読む前に断る (本文を送っていないので、読みに行けば時間切れ)
    status, payload, connection = request(open_server, "POST", "/generate", declared=MAX_BODY_BYTES + 1)
    if status != 413:
        fail(f"上限を超える本文を 413 で断っていない: {status} {payload}")
    if (connection or "").lower() != "close":
        fail("読まずに断ったのに接続を閉じていない (残った本文が次の要求として読まれる)")

    status, _, _ = request(open_server, "POST", "/generate", declared=-5)
    if status != 400:
        fail(f"負の content-length を断っていない: {status}")

    status, payload, _ = request(open_server, "POST", "/generate", [1, 2])
    if status != 400:
        fail(f"object でない本文を断っていない: {status} {payload}")
finally:
    open_server.shutdown()

locked = serve("s3cret")
try:
    for headers in ({}, {"authorization": "Bearer nope"}, {"authorization": "s3cret"}):
        for method, path in (("GET", "/health"), ("POST", "/generate")):
            status, _, _ = request(locked, method, path, {"prompt": "x"} if method == "POST" else None, headers)
            if status != 401:
                fail(f"合言葉が違うのに {method} {path} が {status} を返した ({headers})")

    good = {"authorization": "Bearer s3cret"}
    status, _, _ = request(locked, "GET", "/health", None, good)
    if status != 200:
        fail(f"正しい合言葉で /health が通らない: {status}")
    status, payload, _ = request(locked, "POST", "/generate", {"prompt": "x"}, good)
    if status != 200 or payload.get("got") != {"prompt": "x"}:
        fail(f"正しい合言葉で /generate が通らない: {status} {payload}")
finally:
    locked.shutdown()

# 繋いだまま何も送らない相手は切る (1接続1スレッドを握り続けさせない)
quick = ThreadingHTTPServer(("127.0.0.1", 0), type("Quick", (Echo,), {"timeout": 0.5}))
threading.Thread(target=quick.serve_forever, daemon=True).start()
try:
    idle = socket.create_connection(("127.0.0.1", quick.server_address[1]), timeout=5)
    try:
        if idle.recv(1) != b"":
            fail("黙っている接続に何か返している")
    except TimeoutError:
        fail("黙っている接続を切っていない")
    finally:
        idle.close()
finally:
    quick.shutdown()

print("mimic server guard ok (ループバック以外は合言葉が必須 / 合言葉は Bearer で照合 / 1MiB 超は読む前に 413 / 黙った接続は切る)")
