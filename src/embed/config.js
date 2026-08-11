// 意味検索 (ローカル埋め込み) の設定。
// SEMANTIC_MODEL_NAME が変わると既存ベクトルは全部意味を失うので、
// モデルの同一性は embed_models に記録して突き合わせる。

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function flag(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

export const embedConfig = {
  enabled: flag(process.env.SEMANTIC_SEARCH, true),

  // きもち機能とは別のインタプリタを指せるようにしておく。
  // 片方だけ環境を作り替えたいことがあるため。
  pythonBin: process.env.SEMANTIC_PYTHON_BIN
    ?? process.env.EMOTION_PYTHON_BIN
    ?? 'python3',

  // 実測で e5-small が e5-base よりマージンが良く、推論は6倍速く、RSS は
  // 1.0GiB 対 1.3GiB だった。384次元は JS の総当たり走査も2倍安い。
  modelName: process.env.SEMANTIC_MODEL_NAME ?? 'intfloat/multilingual-e5-small',
  // 会話のまとまり1つで 400 トークン前後になるので 192 では切れる。
  // 1件あたりは遅くなるが、件数が 1/5 になるので合計では速い。
  maxLength: number(process.env.SEMANTIC_MAX_LENGTH, 384),
  threads: number(process.env.SEMANTIC_THREADS, 4),
  microBatch: number(process.env.SEMANTIC_MICRO_BATCH, 16),
  nice: number(process.env.SEMANTIC_NICE, 5),

  // 初回はモデルのダウンロードが入るので長めに待つ
  startupTimeoutMs: number(process.env.SEMANTIC_STARTUP_TIMEOUT_MS, 300_000),
  requestTimeoutMs: number(process.env.SEMANTIC_REQUEST_TIMEOUT_MS, 20_000),
  queryTimeoutMs: number(process.env.SEMANTIC_QUERY_TIMEOUT_MS, 20_000),
  // 使われない間は落とす。24時間 1GiB 常駐させない。
  idleMs: number(process.env.SEMANTIC_IDLE_MS, 600_000),
  prewarm: flag(process.env.SEMANTIC_PREWARM, true),

  // 埋め込む対象の絞り込み。
  // minChars は「まとまり」に対する下限。1発言ずつ埋めていた頃は10字未満の発言を
  // 全部捨てていて、実測で発言の半分が意味検索から消えていた
  // (「いや待って」「まあ今回は例外」のような短文にこそ立場が出る)。
  // まとまりに吸収されるので、ここは低くてよい。
  minChars: number(process.env.SEMANTIC_MIN_CHARS, 10),
  maxChars: number(process.env.SEMANTIC_MAX_CHARS, 1000),
  includeBots: flag(process.env.SEMANTIC_INCLUDE_BOTS, false),

  // --- 会話のまとまり (チャンク) ---
  // ベクトル化の単位。1発言は短すぎて主張が入りきらない
  // (Discord では「レビュー無しは駄目」→「急ぎだから」→「履歴に残らない」のように
  //  やり取りで初めて意味になる)。無言で区切って1単位にする。
  chunkGapMs: number(process.env.SEMANTIC_CHUNK_GAP_MS, 15 * 60_000),
  // 長い議論が1ベクトルに溶けないよう上限も置く
  chunkMaxMessages: number(process.env.SEMANTIC_CHUNK_MAX_MESSAGES, 20),
  chunkMaxChars: number(process.env.SEMANTIC_CHUNK_MAX_CHARS, 1200),
  // 1チャンネルを丸ごとメモリに載せないためのページ幅 (18.8万件のチャンネルがある)。
  // 小さくすればページ境界の持ち越しを試験できる。
  chunkPage: number(process.env.SEMANTIC_CHUNK_PAGE, 5000),

  // バックフィル
  batchSize: number(process.env.SEMANTIC_BATCH_SIZE, 32),
  sleepMs: number(process.env.SEMANTIC_SLEEP_MS, 120),
  sweepCron: process.env.SEMANTIC_SWEEP_CRON ?? '0 40 4 * * *',
  sweepWindowMs: number(process.env.SEMANTIC_SWEEP_WINDOW_MS, 7 * 86_400_000),

  // クエリ
  maxCandidates: number(process.env.SEMANTIC_MAX_CANDIDATES, 150_000),
  // 1位からこれ以上落ちた候補は捨てる。実測で無関係な文どうしでも 0.77〜0.82
  // 出るので絶対閾値では絞れず、相対でしか切れない。
  relativeCutoff: number(process.env.SEMANTIC_RELATIVE_CUTOFF, 0.1)
};
