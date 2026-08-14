"""JESC の日本語側を jsonl に落とす (build-jesc.mjs が読む形)。

    .venv-llm/bin/python scripts/llm/fetch-jesc.py external/jesc

parquet を直に読むのは node 側では面倒なので、ここで 1 行 1 JSON に落としておく。
本文だけ (`{"ja": "..."}`) にして、英語側は捨てる — 使うのは日本語だけ。

nntsuzu/JESC は **CC-BY-4.0**。モデルカードに出典を書く義務が付く。
"""

import json
import sys
from pathlib import Path

import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download

out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "external/jesc")
out_dir.mkdir(parents=True, exist_ok=True)

path = hf_hub_download("nntsuzu/JESC", "data/train-00000-of-00001.parquet",
                       repo_type="dataset")
print(f"落とした: {path}")

table = pq.read_table(path, columns=["translation"])
col = table.column("translation")

out = out_dir / "jesc-ja.jsonl"
written = 0
with out.open("w", encoding="utf8") as sink:
    for batch in col.to_pylist():
        ja = (batch or {}).get("ja")
        if not ja:
            continue
        sink.write(json.dumps({"ja": ja}, ensure_ascii=False) + "\n")
        written += 1

print(f"{out}  {written:,} 行 / {out.stat().st_size / 1e6:.0f} MB")
