#!/usr/bin/env python3
"""検索の方式の比較 (Phase 0。計算だけで、クレジットは要らない)。

  scripts/memory-retrieval-eval.py --data /root/dev/memory-v2-eval --model ruri-130m [--model e5-small ...]

memory-embed-bakeoff.py が残した埋め込み (emb/<model>-{corpus,queries}.npy) と、corpus / queries から、
  dense   埋め込みだけ
  fts     文字 3-gram の BM25 (SQLite FTS5 trigram。本番の nodes_fts / episodes_fts と同じトークナイザ)
  rrf     dense と fts を逆順位で融合 (RRF、k=60)
  rrf+    dense と fts を重みつきで融合 (dense 1.0 / fts 0.7)
の hit@1/3/10 と MRR を、質問の種類 (A / B1 / B2) ごとに出す。--rerank-out を付けると、融合の上位 20 件を
jev の再順位づけ用に書き出す (scripts/memory-rerank-eval.mjs が読む)。
"""
import argparse
import json
import re
import sqlite3
from pathlib import Path

import numpy as np


def load_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def grams(query: str, limit: int = 80):
    """質問の文字 3-gram (記号・空白をまたがない)。重複を除き、前から limit 個。"""
    out, seen = [], set()
    for piece in re.split(r"[\s、。,.!！?？「」『』()（）\[\]【】:：;；/／\-_~〜]+", query):
        for i in range(len(piece) - 2):
            g = piece[i : i + 3]
            if g not in seen:
                seen.add(g)
                out.append(g)
    return out[:limit]


def build_fts(corpus):
    db = sqlite3.connect(":memory:")
    db.execute("CREATE VIRTUAL TABLE t USING fts5(text, tokenize='trigram')")
    db.executemany("INSERT INTO t(rowid, text) VALUES (?, ?)", [(i + 1, f"{c['path']} {c['heading']} {c['text']}") for i, c in enumerate(corpus)])
    return db


def fts_rank(db, query: str, limit: int = 100):
    gs = grams(query)
    if not gs:
        return []
    match = " OR ".join('"' + g.replace('"', '""') + '"' for g in gs)
    rows = db.execute("SELECT rowid FROM t WHERE t MATCH ? ORDER BY bm25(t) LIMIT ?", (match, limit)).fetchall()
    return [r[0] - 1 for r in rows]


def rrf(lists, weights, k: int = 60):
    score = {}
    for ranking, weight in zip(lists, weights):
        for rank, doc in enumerate(ranking):
            score[doc] = score.get(doc, 0.0) + weight / (k + rank + 1)
    return [d for d, _ in sorted(score.items(), key=lambda x: -x[1])]


def evaluate(rankings, queries, index_of, paths):
    report = {}
    for kind in ("A", "B1", "B2", "B"):
        idx = [i for i, q in enumerate(queries) if q["kind"] == kind or (kind == "B" and q["kind"] in ("B1", "B2"))]
        if not idx:
            continue
        ranks, page_ranks, rr = [], [], []
        for i in idx:
            gold = index_of[queries[i]["gold"]]
            ranking = rankings[i]
            r = ranking.index(gold) + 1 if gold in ranking else 999
            ranks.append(r)
            rr.append(1 / r if r <= 10 else 0.0)
            pr = next((p + 1 for p, d in enumerate(ranking) if paths[d] == queries[i]["path"]), 999)
            page_ranks.append(pr)
        at = lambda v, k: round(100 * sum(1 for x in v if x <= k) / len(v), 1)
        report[kind] = {"chunk": [at(ranks, 1), at(ranks, 3), at(ranks, 10)], "mrr": round(sum(rr) / len(rr), 3), "page": [at(page_ranks, 1), at(page_ranks, 3), at(page_ranks, 10)]}
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--model", action="append", required=True)
    parser.add_argument("--rerank-out", default="")
    parser.add_argument("--off-out", default="", help="関係ない質問 (OFF_TOPIC) の上位 20 件を書き出す (最初の --model で埋め込む)")
    args = parser.parse_args()
    data = Path(args.data)
    corpus = load_jsonl(data / "corpus.jsonl")
    index_of = {c["id"]: i for i, c in enumerate(corpus)}
    paths = [c["path"] for c in corpus]
    queries = []
    for name in ("queries_a.jsonl", "queries_b.jsonl"):
        queries += [q for q in load_jsonl(data / name) if q["gold"] in index_of]
    db = build_fts(corpus)
    fts = [fts_rank(db, q["query"]) for q in queries]
    print(f"corpus {len(corpus)} queries {len(queries)}")
    show = lambda name, rep: print(f"  {name:7s} " + " | ".join(f"{k}: {rep[k]['chunk']} mrr {rep[k]['mrr']} page {rep[k]['page']}" for k in ('A', 'B1', 'B2')))
    print("fts-only"); show("fts", evaluate(fts, queries, index_of, paths))
    for model in args.model:
        c = np.load(data / "emb" / f"{model}-corpus.npy").astype(np.float32)
        q = np.load(data / "emb" / f"{model}-queries.npy").astype(np.float32)
        if len(q) != len(queries):
            print(f"[{model}] queries.npy の件数 {len(q)} が queries {len(queries)} と合わない (bake-off と同じ --data / --limit で作ること)")
            continue
        scores = q @ c.T
        dense = [list(np.argsort(-scores[i])[:100]) for i in range(len(queries))]
        print(f"[{model}]")
        show("dense", evaluate(dense, queries, index_of, paths))
        show("rrf", evaluate([rrf([dense[i], fts[i]], [1.0, 1.0]) for i in range(len(queries))], queries, index_of, paths))
        fused = [rrf([dense[i], fts[i]], [1.0, 0.7]) for i in range(len(queries))]
        show("rrf+", evaluate(fused, queries, index_of, paths))
        if args.off_out and model == args.model[0]:
            import importlib.util
            import torch
            from transformers import AutoModel, AutoTokenizer
            spec = importlib.util.spec_from_file_location("bakeoff", Path(__file__).with_name("memory-embed-bakeoff.py"))
            bake = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(bake)
            cfg = bake.MODELS[model]
            tok = AutoTokenizer.from_pretrained(cfg["name"])
            net = AutoModel.from_pretrained(cfg["name"]).eval()
            off = bake.encode([cfg["q"] + t for t in bake.OFF_TOPIC], tok, net, cfg["pool"], 256)
            top = np.argsort(-(off @ c.T), axis=1)[:, :20]
            rows = [{"query": t, "kind": "OFF", "candidates": [{"id": corpus[d]["id"], "path": corpus[d]["path"], "heading": corpus[d]["heading"], "text": corpus[d]["text"]} for d in top[i]]} for i, t in enumerate(bake.OFF_TOPIC)]
            Path(args.off_out).write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
            print("wrote", args.off_out, len(rows))
        if args.rerank_out and model == args.model[0]:
            out = []
            for i, qq in enumerate(queries):
                out.append({"query": qq["query"], "kind": qq["kind"], "gold": qq["gold"], "path": qq["path"],
                            "candidates": [{"id": corpus[d]["id"], "path": corpus[d]["path"], "heading": corpus[d]["heading"], "text": corpus[d]["text"]} for d in fused[i][:20]]})
            Path(args.rerank_out).write_text("\n".join(json.dumps(o, ensure_ascii=False) for o in out) + "\n", encoding="utf-8")
            print("wrote", args.rerank_out, len(out))


if __name__ == "__main__":
    main()
