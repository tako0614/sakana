#!/usr/bin/env python3
"""記憶の検索の評価用データを、記憶 DB の写し (読み取り専用) から作る (Phase 0)。

  scripts/memory-eval-export.py --db /root/dev/memory-v2-eval/memory-v1.sqlite --out /root/dev/memory-v2-eval [--n 600]

作るもの (--out の下):
  corpus.jsonl     検索の対象。今の本番の断片 (memory_chunks) 1 つ = 1 行。text4embed は本番と同じ埋め込みの文 (src/memory/chunks.ts の chunkText)
  sample.jsonl     質問の正解にする断片の見本 (n 件)。ページごとに 3 件まで・人物 / 話題 / そのほかを偏らせずに取る (乱数の種は固定)
  queries_a.jsonl  質問 A (出典の出来事の題名 + 要約。v1 の評価 scripts/memory-chunks-eval.ts と同じ作り)。正解は sample の断片

質問 B (短い自然な質問) は、sample の断片から LLM で作る (scripts/memory-eval-questions.mjs)。
"""
import argparse
import json
import random
import sqlite3
from pathlib import Path

GUILD = "1255359848644608035"


def chunk_text(path: str, aliases: list[str], heading: str, text: str) -> str:
    """src/memory/chunks.ts の chunkText と同じ。"""
    head = f"{path or '記憶の根'}" + (f" ({', '.join(aliases[:6])})" if aliases else "")
    return "\n".join([head, f"{heading + ': ' if heading else ''}{text[:700]}"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--n", type=int, default=600)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    aliases_of = {}
    for node_id, raw in db.execute("SELECT id, aliases FROM nodes WHERE guild_id = ?", (GUILD,)):
        try:
            aliases_of[node_id] = [a for a in json.loads(raw) if isinstance(a, str)]
        except (TypeError, ValueError):
            aliases_of[node_id] = []
    episodes = {row[0]: (row[1], row[2]) for row in db.execute("SELECT id, title, summary FROM episodes WHERE guild_id = ?", (GUILD,))}

    corpus = []
    for chunk_id, node_id, path, heading, text, cites in db.execute(
        "SELECT id, node_id, path, heading, text, cites FROM memory_chunks WHERE guild_id = ? ORDER BY id", (GUILD,)
    ):
        try:
            cite_ids = [c for c in json.loads(cites) if isinstance(c, int)]
        except (TypeError, ValueError):
            cite_ids = []
        corpus.append({
            "id": chunk_id, "path": path, "heading": heading, "text": text, "cites": cite_ids,
            "text4embed": chunk_text(path, aliases_of.get(node_id, []), heading, text),
        })
    with open(out / "corpus.jsonl", "w", encoding="utf-8") as handle:
        for row in corpus:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    # 見本: 出典があり、短すぎず長すぎない断片。ページごとに 3 件まで。人物 50% / 話題 25% / そのほか 25%
    rng = random.Random(20261029)
    pool = [c for c in corpus if "/" in c["path"] and c["cites"] and 25 <= len(c["text"]) <= 300 and c["cites"][0] in episodes]
    rng.shuffle(pool)
    quota = {"people": int(args.n * 0.5), "topics": int(args.n * 0.25)}
    quota["other"] = args.n - quota["people"] - quota["topics"]
    taken: dict[str, int] = {}
    per_page: dict[str, int] = {}
    sample = []
    for c in pool:
        group = c["path"].split("/", 1)[0]
        group = group if group in ("people", "topics") else "other"
        if taken.get(group, 0) >= quota[group] or per_page.get(c["path"], 0) >= 3:
            continue
        taken[group] = taken.get(group, 0) + 1
        per_page[c["path"]] = per_page.get(c["path"], 0) + 1
        sample.append(c)
        if len(sample) >= args.n:
            break
    with open(out / "sample.jsonl", "w", encoding="utf-8") as handle:
        for c in sample:
            handle.write(json.dumps({k: c[k] for k in ("id", "path", "heading", "text")}, ensure_ascii=False) + "\n")
    with open(out / "queries_a.jsonl", "w", encoding="utf-8") as handle:
        for c in sample:
            title, summary = episodes[c["cites"][0]]
            handle.write(json.dumps({"gold": c["id"], "path": c["path"], "query": f"{title}\n{summary[:150]}", "kind": "A"}, ensure_ascii=False) + "\n")
    print(f"corpus {len(corpus)} / sample {len(sample)} {taken} / pages in sample {len(per_page)}")


if __name__ == "__main__":
    main()
