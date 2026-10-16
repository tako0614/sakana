"""推論サーバー (server.py) の入口の守り。標準ライブラリだけで書く。

torch も sentencepiece も要らないので、モデル無しの機械でも試せる
(scripts/check-mimic-server.py)。

守るのは3つ:

  - 待ち受け先    ループバック以外で待ち受けるなら合言葉 (MIMIC_SERVER_TOKEN) を必須にする。
                  合言葉が無いまま外から届く場所に置くと、誰でも CPU を張り付かせられる
  - 合言葉        設定されていれば、全ての要求に `Authorization: Bearer <合言葉>` を求める
  - 本文の大きさ  Content-Length を**読む前に**見て、上限を超えたら 413 で断る。
                  以前は申告された長さをそのまま読んでいたので、大きな値を書くだけで
                  メモリを食わせられた (負の値なら接続が閉じるまで読み続けた)

既定 (127.0.0.1 / 合言葉なし) の動きは変えない。bot (src/mimic/client.ts) は
MIMIC_SERVER_TOKEN があるときだけ同じ値を送る。
"""

import hmac
import ipaddress
import json
from http.server import BaseHTTPRequestHandler

# 本文の上限。bot が送る一番大きい依頼でも 400KB ほど (文脈 16 発言 × 4000 字を
# JSON で書いた最悪の場合。制御文字は \uXXXX で 6 バイトになる) なので、
# 余裕を見て 1MiB で頭打ちにする。窓 (context) を超えたぶんはどのみち捨てる
MAX_BODY_BYTES = 1 << 20


def is_loopback(host):
    """127.0.0.0/8 と ::1 (と localhost) だけをループバックとみなす。"""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        # 名前で書かれた待ち受け先は解決先が分からないので、外から届くものとして扱う
        return False


def bind_error(host, token):
    """その待ち受け先で起動してよいか。駄目なら理由を返す (良ければ None)。"""
    if is_loopback(host) or token:
        return None
    return (
        f"--host {host} はループバックではありません。外から届く場所で待ち受けるなら "
        "MIMIC_SERVER_TOKEN を設定してください (bot 側にも同じ値を置く)。"
    )


def authorized(header, token):
    """Authorization ヘッダが合言葉と一致するか。合言葉が無ければ常に通す。"""
    if not token:
        return True
    scheme, _, value = (header or "").partition(" ")
    if scheme.lower() != "bearer":
        return False
    # 長さや一致した位置で時間が変わらない比較にする
    return hmac.compare_digest(value.strip().encode("utf8"), token.encode("utf8"))


class BodyError(Exception):
    """本文を読む前に断る理由。status をそのまま返す。"""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def body_length(value, limit=MAX_BODY_BYTES):
    """Content-Length を読む。上限を超えたもの・負のもの・数でないものは断る。"""
    try:
        length = int(value or 0)
    except ValueError as error:
        raise BodyError(400, f"bad request: {error}") from None
    if length < 0:
        raise BodyError(400, "bad request: content-length must not be negative")
    if length > limit:
        raise BodyError(413, f"payload too large: {length} > {limit} bytes")
    return length


class GuardedHandler(BaseHTTPRequestHandler):
    """合言葉と本文の上限を確かめてから中身を読む要求処理。server.py がこれを継ぐ。"""

    protocol_version = "HTTP/1.1"
    # 起動時に入れる。None なら合言葉なし (ループバック専用)
    token = None
    max_body_bytes = MAX_BODY_BYTES
    # 読み書きが止まった接続を切るまでの秒数。既定 (None) だと、繋いだまま何も送らない
    # 相手が1人1スレッドを握り続けられる。推論の時間はここに含まれない (読み終えてから回す)。
    # bot (undici) は 4 秒で空き接続を閉じるので、待ち受け側が先に切ることは無い
    timeout = 30

    def _send(self, code, payload, close=False):
        body = json.dumps(payload, ensure_ascii=False).encode("utf8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        if close:
            # 本文を読まずに返すときは接続を閉じる。残した本文が次の要求として読まれる
            self.send_header("connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        """合言葉を確かめる。違えば 401 を返して False。"""
        if authorized(self.headers.get("authorization"), self.token):
            return True
        self._send(401, {"error": "unauthorized"}, close=True)
        return False

    def _read_json(self):
        """本文を JSON の object として読む。読めなければ理由を返して None。"""
        try:
            length = body_length(self.headers.get("content-length"), self.max_body_bytes)
        except BodyError as error:
            self._send(error.status, {"error": str(error)}, close=True)
            return None

        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except ValueError as error:  # json.JSONDecodeError / UnicodeDecodeError も含む
            self._send(400, {"error": f"bad request: {error}"})
            return None

        if not isinstance(payload, dict):
            self._send(400, {"error": "bad request: body must be a JSON object"})
            return None
        return payload

    def log_message(self, fmt, *fmt_args):
        # 1 リクエストごとの行は要らない。エラーは _send 側で返している
        pass
