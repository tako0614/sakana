"""コーパス専用の tokenizer を作る。既存の tokenizer は使わない。

    .venv-llm/bin/python scripts/llm/train-tokenizer.py [corpus_dir]

このスクリプトの本当の目的は「実トークン数の確定」。ここまでの見積り (約 780 万) は
文字数から割った推定値で、モデルサイズと epoch 数はこの実測で決め直す。

出力: <dir>/tok.model, <dir>/tok.vocab, <dir>/stats.json
"""

import json
import random
import sys
from pathlib import Path

import sentencepiece as spm

CORPUS = Path(sys.argv[1] if len(sys.argv) > 1 else "corpus")
import os

VOCAB_SIZE = int(os.environ.get("LLM_VOCAB", 4096))
# 0.9995 だと 3,037 文字を語彙に入れる必要があり、4096 枠のうち実マージが 410 個
# しか残らなかった (= 日本語がほぼ文字単位)。0.995 なら 1,492 文字で足りて、
# 捨てる 4,216 文字は全体の 0.5% なのでバイト送りで足りる。
COVERAGE = float(os.environ.get("LLM_COVERAGE", 0.995))

# 1トークンに収めたい記号。BPE に学習させると `<|s3|>` が 3〜4 トークンに割れて、
# 会話 1 件ぶんの構造だけで数百トークン払うことになる。
CONTROL = [
    "<|conv|>", "<|end|>", "<|re|>", "<|z|>",
    "<url>", "<mention>", "<channel>", "<time>",
    "<code>", "</code>", "<nl>", "<file>",
]
# 名前を持たない人に会話ごとの出現順で振る相対トークン (src/mimic/serialize.js)。
# 8 個で 99.1% を被覆する。
ROLES = [f"<|{c}|>" for c in "abcdefgh"]

# 固有の話者トークン。**何人いるかはコーパスが決める** —
# build-corpus.mjs が speakers.json に書いた人数をそのまま読む。
# 数を手で書くと、閾値を変えたときに静かにずれて「学習していないトークンを
# 推論で渡す」形になる (evex-1 で一度やった)。
#
# v4 は 147 人 (200 件以上 / 発言の 96.6%)。evex-1 は 48 人 (85.3%) だった。
# user_defined が 99 個増えるぶん実マージは約 140 減るが、被覆の +11.3pt の方が大きい。
speakers_json = CORPUS / "speakers.json"
SPEAKERS = (
    [row["token"] for row in json.loads(speakers_json.read_text(encoding="utf8"))]
    if speakers_json.exists() else []
)

SYMBOLS = CONTROL + SPEAKERS + ROLES

train_txt = CORPUS / "train.txt"
prefix = str(CORPUS / "tok")

spm.SentencePieceTrainer.train(
    input=str(train_txt),
    model_prefix=prefix,
    vocab_size=VOCAB_SIZE,
    model_type="bpe",
    # 未知の絵文字や珍しい漢字で落ちないように、バイトへ落とす道を残す。
    # 256 のバイトトークンを食うが、`⚗` のような1文字で unk になる方が痛い。
    byte_fallback=True,
    character_coverage=COVERAGE,
    user_defined_symbols=SYMBOLS,
    # 会話 1 件が 1 行。1200 字 × 3 バイト + 話者トークンで既定 (4192) を超えるので上げる。
    # 超えた行は黙って捨てられるので、ここを忘れると長い会話だけ学習から消える。
    max_sentence_length=32768,
    input_sentence_size=0,
    normalization_rule_name="identity",  # 全角/半角を勝手に潰されると文体が変わる
    # 行頭に ▁ を足させない。チャットの1行は文の途中ではないので幽霊スペースが
    # 混ざるだけで、往復が戻らなくなるし `<|s3|>` 単体が 2 トークンに割れる。
    add_dummy_prefix=False,
    # 連続スペースを潰させない。既定は true で、コードブロックのインデントが
    # 全部 1 スペースに畳まれる (往復が戻らない行はこれが原因だった)。
    remove_extra_whitespaces=False,
    num_threads=16,
)

sp = spm.SentencePieceProcessor(model_file=f"{prefix}.model")

# --- 検証 ---

problems = []

# 1) 制御記号が 1 トークンに収まっているか
for symbol in SYMBOLS:
    ids = sp.encode(symbol, out_type=int)
    if len(ids) != 1:
        problems.append(f"{symbol} が {len(ids)} トークンに割れている: {sp.encode(symbol, out_type=str)}")

# 2) 往復。絵文字・コード・全角を含む行で decode(encode(x)) == x
lines = train_txt.read_text(encoding="utf8").splitlines()
random.seed(0)
sample = random.sample(lines, min(1000, len(lines)))
broken = [s for s in sample if sp.decode(sp.encode(s, out_type=int)) != s]
if broken:
    problems.append(f"往復で戻らない行が {len(broken)}/{len(sample)} 件: {broken[0][:80]!r}")


def count(path):
    text = path.read_text(encoding="utf8")
    rows = text.splitlines()
    tokens = sum(len(ids) for ids in sp.encode(rows, out_type=int))
    return {"lines": len(rows), "chars": len(text), "tokens": tokens}


train = count(train_txt)
val = count(CORPUS / "val.txt")
total_tokens = train["tokens"] + val["tokens"]
ratio = (train["chars"] + val["chars"]) / total_tokens

# 3) 語彙が使われているか。
#
# 圧縮率だけでは判断できない (日本語の BPE は 1.5〜2.5 文字/トークンが普通で、
# 高い方が悪いわけではない)。効くのは「学習例が付かない語彙がどれだけあるか」。
# 出現 100 回未満の語彙が多いなら、その枠は死んでいるので vocab を削る。
freq = [0] * sp.get_piece_size()
for ids in sp.encode(lines, out_type=int):
    for i in ids:
        freq[i] += 1

reserved = len(SYMBOLS) + 259  # 制御記号 + 話者 + バイト 256 + unk/bos/eos
thin = sum(1 for i, f in enumerate(freq) if f < 100 and sp.id_to_piece(i) not in SYMBOLS)
unused = sum(1 for f in freq if f == 0)

if ratio < 1.3:
    problems.append(f"圧縮率が低すぎる ({ratio:.2f} 文字/トークン)。vocab を増やす")
if thin > sp.get_piece_size() * 0.4:
    problems.append(f"出現 100 回未満の語彙が {thin}/{sp.get_piece_size()} 個。vocab を削る")

stats = {
    "vocab_size": sp.get_piece_size(),
    "reserved_pieces": reserved,
    "speaker_tokens": len(SPEAKERS),
    "thin_pieces": thin,
    "unused_pieces": unused,
    "chars_per_token": round(ratio, 3),
    "train": train,
    "val": val,
    "total_tokens": total_tokens,
}

# build-corpus.mjs が書いた条件と件数を消さない。両方あって初めて
# 「どのコーパスをどの語彙で切ったか」が1ファイルで追える
stats_path = CORPUS / "stats.json"
if stats_path.exists():
    stats = {**json.loads(stats_path.read_text(encoding="utf8")), **stats}
stats_path.write_text(json.dumps(stats, ensure_ascii=False, indent=2))

print()
print(f"vocab            {sp.get_piece_size()} cov={COVERAGE} "
      f"(固定 {reserved} = 制御 {len(CONTROL)} + 話者 {len(SPEAKERS)} + 役 {len(ROLES)} + バイト等 259 / "
      f"出現100回未満 {thin} / 未使用 {unused})")
print(f"圧縮率           {ratio:.2f} 文字/トークン")
print(f"train            {train['tokens']:,} トークン ({train['lines']:,} 会話)")
print(f"val              {val['tokens']:,} トークン ({val['lines']:,} 会話)")
print(f"合計             {total_tokens:,} トークン")
print()

# Chinchilla (20 トークン/パラメータ) から見た目安。ここが設計の根拠になる。
print(f"Chinchilla 最適  {total_tokens // 20 / 1e6:.2f}M パラメータ")
for params in (3e6, 6e6, 12e6, 20e6):
    print(f"  {params / 1e6:>4.0f}M なら  {total_tokens / params:.1f} トークン/パラメータ"
          f" (最適の {total_tokens / params / 20 * 100:.0f}%)")

if problems:
    print()
    for p in problems:
        print(f"NG  {p}")
    sys.exit(1)

print()
print("tokenizer ok")
