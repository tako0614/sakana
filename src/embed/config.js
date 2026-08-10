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
  maxLength: number(process.env.SEMANTIC_MAX_LENGTH, 192),
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

  // 埋め込む対象の絞り込み
  minChars: number(process.env.SEMANTIC_MIN_CHARS, 10),
  maxChars: number(process.env.SEMANTIC_MAX_CHARS, 1000),
  includeBots: flag(process.env.SEMANTIC_INCLUDE_BOTS, false),

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
