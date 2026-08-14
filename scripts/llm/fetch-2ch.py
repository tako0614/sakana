"""おーぷん2ちゃんねる対話コーパスを jsonl に落とす (build-2ch.mjs が読む形)。

    .venv-llm/bin/hf download p1atdev/open2ch --type dataset \\
      --include "all-corpus-cleaned/*" --local-dir external/open2ch
    .venv-llm/bin/python scripts/llm/fetch-2ch.py external/open2ch

p1atdev/open2ch は **Apache-2.0**。元は 1never/open2ch-dialogue-corpus
(おーぷん2ちゃんねる対話コーパス / 稲葉通将)。**モデルカードに出典を書く。**

`-cleaned` の方を使う。あちらは上流が有害表現を含む発話を落とした版で、
HF 側に `not-for-all-audiences` が付いているのは素の `all-corpus` の話。

--- 構造 ---

    dialogue: struct<speaker: list<int8>, content: list<string>>
    board:    livejupiter | news4vip | newsplus

1 行 = 1 対話で、**85% が 2 発話**しかない。スレッドから連続する返信を
切り出したものなので、**parquet の行の並びは概ね同じスレッド由来**
(実測: 先頭 4 行のうち 3 行が同じ「アメリカvs北朝鮮」の実況スレ)。
繋ぎ直すのは build-2ch.mjs 側でやるので、ここでは並びを保ったまま流す。
"""

import json
import sys
from pathlib import Path

import pyarrow.parquet as pq

src = Path(sys.argv[1] if len(sys.argv) > 1 else "external/open2ch")
files = sorted((src / "all-corpus-cleaned").glob("*.parquet"))
if not files:
    sys.exit(f"{src}/all-corpus-cleaned/ に parquet が無い。先に hf download を回す")

out = src / "open2ch.jsonl"
written = 0
with out.open("w", encoding="utf8") as sink:
    for file in files:
        reader = pq.ParquetFile(file)
        for batch in reader.iter_batches(batch_size=50_000, columns=["dialogue", "board"]):
            dialogues = batch.column("dialogue").to_pylist()
            boards = batch.column("board").to_pylist()
            for row, board in zip(dialogues, boards):
                posts = [
                    {"speaker": int(s), "content": c}
                    for s, c in zip(row["speaker"], row["content"])
                    if c
                ]
                if len(posts) < 2:
                    continue
                sink.write(json.dumps({"board": board, "posts": posts},
                                      ensure_ascii=False) + "\n")
                written += 1

print(f"{out}  {written:,} 対話 / {out.stat().st_size / 1e6:.0f} MB")
print("Apache-2.0 — **モデルカードに 1never/open2ch-dialogue-corpus の出典を書くこと**")
