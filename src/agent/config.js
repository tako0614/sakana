// AI エージェントの設定。
// DEEPSEEK_API_KEY が無ければ機能ごと無効になるので、既存の bot 動作には影響しない。

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function flag(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function list(value) {
  return String(value ?? '').split(/[\s,]+/).filter(Boolean);
}

export const agentConfig = {
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
  baseUrl: (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',

  // 公式のツマミは low / high / max。真ん中の high を既定にする。
  reasoningEffort: process.env.AGENT_REASONING_EFFORT ?? 'high',
  thinking: flag(process.env.AGENT_THINKING, true),

  // --- トークン節約のための上限 ---
  // ツールを呼ぶたびに会話全体を再送するので、往復回数が費用に直結する。
  maxRounds: number(process.env.AGENT_MAX_ROUNDS, 12),
  // 1回の実行でツール出力に使える合計文字数。超えたらツールが打ち切る。
  maxToolChars: number(process.env.AGENT_MAX_TOOL_CHARS, 32_000),
  // ツール出力に載せる1メッセージあたりの本文文字数。
  messageChars: number(process.env.AGENT_MESSAGE_CHARS, 300),
  // 呼ばれた時点で直近メッセージを最初から渡しておく (ツール往復を1回減らす)。0 で無効。
  preloadMessages: number(process.env.AGENT_PRELOAD_MESSAGES, 30),
  // max_tokens には思考ぶんも含まれる。4000 だと reasoning_effort:high の思考で
  // 使い切って本文が空のまま返り、「うまく答えをまとめられませんでした」になる。
  // 回答自体は1000字までなので、ここはほぼ全部が思考の枠。
  maxOutputTokens: number(process.env.AGENT_MAX_OUTPUT_TOKENS, 40_000),
  timeoutMs: number(process.env.AGENT_TIMEOUT_MS, 150_000),
  // 「-# thinking (10s)」の更新間隔。Discord のメッセージ編集はチャンネルあたり
  // 5回/5秒あたりで絞られるので、1秒はほぼ上限。詰まるようなら 2000 に上げる。
  progressIntervalMs: number(process.env.AGENT_PROGRESS_INTERVAL_MS, 1000),

  // --- 使用量の制限 ---
  // 数えるのは呼び出し回数ではなくトークン。1回の実行で 1.5万〜10万トークン使うので、
  // 回数で縛ると軽い質問と重い調査が同じ1回として扱われて実際の費用と合わない。
  //
  // 入力・キャッシュヒット入力・出力は単価が違うので、
  // 「キャッシュミス入力1トークン = 1」に正規化した重みを掛けて合算する。
  // 既定の重みは DeepSeek の価格比。価格表が変わったら env で上書きする。
  tokenWeightInput: number(process.env.AGENT_TOKEN_WEIGHT_INPUT, 1),
  tokenWeightCached: number(process.env.AGENT_TOKEN_WEIGHT_CACHED, 0.1),
  tokenWeightOutput: number(process.env.AGENT_TOKEN_WEIGHT_OUTPUT, 1.5),
  // 換算トークンでの上限。/agentlimit で管理者が実行中に変えられる。
  userTokenLimit: number(process.env.AGENT_USER_TOKEN_LIMIT, 500_000),
  userWindowMs: number(process.env.AGENT_USER_WINDOW_MS, 3_600_000),
  globalTokenLimit: number(process.env.AGENT_GLOBAL_TOKEN_LIMIT, 10_000_000),
  globalWindowMs: number(process.env.AGENT_GLOBAL_WINDOW_MS, 86_400_000),
  maxConcurrent: number(process.env.AGENT_MAX_CONCURRENT, 3),
  // 制限を無視できる人 (運営用)。
  exemptUsers: list(process.env.AGENT_EXEMPT_USERS),

  // --- 外付け Chrome (CDP) ---
  // deckide が 9222 に常駐させている共有ブラウザにそのまま相乗りする。
  // 自前で Chrome を起動はしない (= 外付け)。
  browserEnabled: flag(process.env.AGENT_BROWSER, true),
  cdpHost: process.env.AGENT_BROWSER_CDP_HOST ?? '127.0.0.1',
  cdpPort: number(process.env.AGENT_BROWSER_CDP_PORT, 9222),
  browserTimeoutMs: number(process.env.AGENT_BROWSER_TIMEOUT_MS, 30_000),
  // ページ本文の取得上限。
  browserTextChars: number(process.env.AGENT_BROWSER_TEXT_CHARS, 4000),
  // click / type / eval / 生 CDP など、ブラウザを操作する系の action を誰に許すか。
  // ログイン済みプロファイルを触れてしまうので、既定では信頼済みの人だけ。
  browserFullForAll: flag(process.env.AGENT_BROWSER_FULL_FOR_ALL, false),
  browserTrustedUsers: list(process.env.AGENT_BROWSER_TRUSTED_USERS),
  // file: / chrome: など、ローカルを覗けるスキームを許すか。
  browserAllowLocal: flag(process.env.AGENT_BROWSER_ALLOW_LOCAL, false)
};

export const agentEnabled = Boolean(agentConfig.apiKey);
