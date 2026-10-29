#!/usr/bin/env python3
"""埋め込みモデルの比較 (Phase 0。計算だけで、クレジットは要らない)。1 回の実行で 1 モデル。

  scripts/memory-embed-bakeoff.py --model e5-small --data /root/dev/memory-v2-eval [--threads 12]

--data の中の corpus.jsonl (本番の断片 12,764 個) を埋め込み、質問 (queries_a / queries_b) で引いて測る:
  - 断片の hit@1/3/10・MRR@10、ページの hit@1/3/10 (質問の種類 A / B1 / B2 ごと)
  - 関係ない質問 (OFF_TOPIC) の 1 位のスコアと、関係ある質問 (B1+B2) の 1 位のスコアの分離 (AUC、関係ある質問の 90% を残す閾値での誤り率)
  - 1 件の質問の埋め込み遅延 (p50 / p95 ms)、コーパスの埋め込み速度 (件/秒)、最大 RSS (MB)
結果は --data/results/<model>.json、ベクトルは --data/emb/<model>-{corpus,queries}.npy (float16) に残す (あとのハイブリッド検索の実験で使い回す)。
モデルごとにプロセスを分けること (RSS が混ざらないように)。
"""
import argparse
import json
import math
import resource
import time
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer

MODELS = {
    "e5-small": dict(name="intfloat/multilingual-e5-small", q="query: ", p="passage: ", pool="mean"),
    "e5-base": dict(name="intfloat/multilingual-e5-base", q="query: ", p="passage: ", pool="mean"),
    "e5-large": dict(name="intfloat/multilingual-e5-large", q="query: ", p="passage: ", pool="mean"),
    "bge-m3": dict(name="BAAI/bge-m3", q="", p="", pool="cls"),
    "ruri-130m": dict(name="cl-nagoya/ruri-v3-130m", q="検索クエリ: ", p="検索文書: ", pool="mean"),
    "ruri-310m": dict(name="cl-nagoya/ruri-v3-310m", q="検索クエリ: ", p="検索文書: ", pool="mean"),
}

# 記憶に関係のない質問 (雑談・一般知識・挨拶)。「出すべきでない依頼で何も出ない」ことの見込みを、スコアの分離で見る
OFF_TOPIC = [
    "今日の天気は？", "おはよう", "1+1は？", "お腹すいた", "眠い", "明日の東京の気温は", "カレーの作り方教えて", "今何時？", "宿題終わらない",
    "おすすめの映画ある？", "日本の首都はどこ？", "富士山の高さは？", "犬と猫どっちが好き？", "バイトだるい", "彼女ほしい", "サッカーのルール教えて",
    "TCP と UDP の違いは？", "Python でリストを逆順にするには", "ありがとう", "ごめんね", "ねむねむ", "ラーメン食べたい", "休みの日何してる？",
    "円周率を 10 桁まで", "光の速さは？", "今日は何曜日？", "疲れた", "暇だなあ", "お昼どうする？", "何か面白い話して",
    "地球から月までの距離は", "英語で『ありがとう』は？", "最近寒いね", "歯が痛い", "雨ふってきた", "電車遅れてる", "コーヒー飲みたい",
    "宝くじ当たらないかな", "夏休みの予定は", "掃除めんどくさい",
]


def pool_hidden(hidden: torch.Tensor, mask: torch.Tensor, how: str) -> torch.Tensor:
    if how == "cls":
        return hidden[:, 0]
    weights = mask.unsqueeze(-1).to(hidden.dtype)
    return (hidden * weights).sum(1) / weights.sum(1).clamp(min=1e-9)


@torch.no_grad()
def encode(texts, tok, model, how, max_len, batch=32, label=""):
    order = np.argsort([len(t) for t in texts])
    out = None
    started = time.time()
    for start in range(0, len(texts), batch):
        idx = order[start:start + batch]
        enc = tok([texts[i] for i in idx], padding=True, truncation=True, max_length=max_len, return_tensors="pt")
        vec = pool_hidden(model(**enc).last_hidden_state, enc["attention_mask"], how)
        vec = torch.nn.functional.normalize(vec, dim=-1).float().cpu().numpy()
        if out is None:
            out = np.zeros((len(texts), vec.shape[1]), dtype=np.float32)
        out[idx] = vec
        if label and (start // batch) % 100 == 0:
            print(f"  [{label}] {min(len(texts), start + batch)}/{len(texts)} ({time.time() - started:.0f}s)", flush=True)
    return out


def load_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def auc(pos: np.ndarray, neg: np.ndarray) -> float:
    """pos の 1 位スコアが neg より高い確率 (関係ある質問が、関係ない質問より高く出るか)。"""
    wins = 0.0
    for p in pos:
        wins += float((p > neg).sum()) + 0.5 * float((p == neg).sum())
    return wins / (len(pos) * len(neg))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, choices=sorted(MODELS))
    parser.add_argument("--data", required=True)
    parser.add_argument("--threads", type=int, default=12)
    parser.add_argument("--max-len", type=int, default=256)
    parser.add_argument("--limit", type=int, default=0, help="コーパスを先頭からこの件数に絞る (動作確認用)")
    args = parser.parse_args()
    cfg = MODELS[args.model]
    data = Path(args.data)
    torch.set_num_threads(args.threads)

    corpus = load_jsonl(data / "corpus.jsonl")
    if args.limit:
        corpus = corpus[: args.limit]
    index_of = {row["id"]: i for i, row in enumerate(corpus)}
    queries = []
    for name in ("queries_a.jsonl", "queries_b.jsonl"):
        if (data / name).exists():
            queries += [q for q in load_jsonl(data / name) if q["gold"] in index_of]
    print(f"[{args.model}] corpus {len(corpus)} / queries {len(queries)} / off-topic {len(OFF_TOPIC)}", flush=True)

    load_started = time.time()
    tok = AutoTokenizer.from_pretrained(cfg["name"])
    model = AutoModel.from_pretrained(cfg["name"], torch_dtype=torch.float32).eval()
    load_s = time.time() - load_started

    corpus_started = time.time()
    c_vec = encode([cfg["p"] + row["text4embed"] for row in corpus], tok, model, cfg["pool"], args.max_len, label="corpus")
    corpus_s = time.time() - corpus_started
    q_vec = encode([cfg["q"] + q["query"] for q in queries], tok, model, cfg["pool"], args.max_len)
    off_vec = encode([cfg["q"] + text for text in OFF_TOPIC], tok, model, cfg["pool"], args.max_len)

    # 1 件ずつの質問の遅延 (実際の使い方)
    times = []
    probe = [cfg["q"] + q["query"] for q in queries[:60:2]]
    for text in probe[:3]:
        encode([text], tok, model, cfg["pool"], args.max_len, batch=1)
    for text in probe:
        t0 = time.perf_counter()
        encode([text], tok, model, cfg["pool"], args.max_len, batch=1)
        times.append((time.perf_counter() - t0) * 1000)

    paths = np.array([row["path"] for row in corpus])
    scores = q_vec @ c_vec.T
    order = np.argsort(-scores, axis=1)[:, :200]
    report = {"model": args.model, "name": cfg["name"], "dim": int(c_vec.shape[1]), "corpus": len(corpus), "load_s": round(load_s, 1),
              "corpus_docs_per_s": round(len(corpus) / corpus_s, 1), "query_ms_p50": round(float(np.percentile(times, 50)), 1),
              "query_ms_p95": round(float(np.percentile(times, 95)), 1), "rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024), "sets": {}}
    for kind in ("A", "B1", "B2", "B"):
        rows = [i for i, q in enumerate(queries) if (q["kind"] == kind or (kind == "B" and q["kind"] in ("B1", "B2")))]
        if not rows:
            continue
        ranks, page_ranks, rr = [], [], []
        for i in rows:
            gold = index_of[queries[i]["gold"]]
            hits = order[i]
            where = np.where(hits == gold)[0]
            rank = int(where[0]) + 1 if len(where) else 999
            ranks.append(rank)
            rr.append(1.0 / rank if rank <= 10 else 0.0)
            page_where = np.where(paths[hits] == queries[i]["path"])[0]
            page_ranks.append(int(page_where[0]) + 1 if len(page_where) else 999)
        at = lambda values, k: round(100 * sum(1 for r in values if r <= k) / len(values), 1)
        report["sets"][kind] = {"n": len(rows), "chunk_hit": [at(ranks, 1), at(ranks, 3), at(ranks, 10)], "mrr10": round(sum(rr) / len(rr), 3),
                                "page_hit": [at(page_ranks, 1), at(page_ranks, 3), at(page_ranks, 10)]}
    # 関係ある質問 (B) と関係ない質問の、1 位のスコアの分離
    on_idx = [i for i, q in enumerate(queries) if q["kind"] in ("B1", "B2")]
    top_on = scores[on_idx].max(axis=1)
    top_off = (off_vec @ c_vec.T).max(axis=1)
    threshold = float(np.percentile(top_on, 10))
    report["off_topic"] = {"top1_on_mean": round(float(top_on.mean()), 3), "top1_off_mean": round(float(top_off.mean()), 3),
                           "auc": round(auc(top_on, top_off), 3), "false_rate_at_keep90": round(float((top_off >= threshold).mean()), 3)}
    (data / "results").mkdir(exist_ok=True)
    (data / "emb").mkdir(exist_ok=True)
    (data / "results" / f"{args.model}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    np.save(data / "emb" / f"{args.model}-corpus.npy", c_vec.astype(np.float16))
    np.save(data / "emb" / f"{args.model}-queries.npy", q_vec.astype(np.float16))
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
