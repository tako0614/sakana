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

  // --- 1回の実行に使える量 ---
  // 縛るのはトークンだけ。往復回数や文字数で縛ると、軽い往復と重い往復が
  // 同じ1回として数えられて実際の費用と合わない。
  // これを超えたらツールを外して、その場の材料で答えを書かせる。
  // 単位は換算トークン (下の重み付け後)。
  // 暴走を止めるためだけの値。実測の最悪が11往復 $0.0116 なので、その1.7倍。
  // 1人あたり/日 ($0.05) より小さくしてある。1リクエストで1日ぶんを
  // 使い切れてしまうと、暴走1回でその人が締め出される。
  requestUsd: number(process.env.AGENT_REQUEST_USD, 0.02),
  // ツール出力に載せる1メッセージあたりの本文文字数。
  messageChars: number(process.env.AGENT_MESSAGE_CHARS, 300),
  // 最初から渡す直近の会話はこちらを使う。人がスマホで見ているのは切られていない
  // 本文なので、ここで切ると「読んだはずの発言」が欠けたまま答えることになる。
  // user メッセージ側なのでキャッシュの前方一致は壊さない。
  preloadChars: number(process.env.AGENT_PRELOAD_CHARS, 800),
  // 呼ばれた時点で直近メッセージを最初から渡しておく (ツール往復を1回減らす)。0 で無効。
  preloadMessages: number(process.env.AGENT_PRELOAD_MESSAGES, 30),
  // max_tokens には思考ぶんも含まれる。4000 だと reasoning_effort:high の思考で
  // 使い切って本文が空のまま返り、「うまく答えをまとめられませんでした」になる。
  // 回答自体は1000字までなので、ここはほぼ全部が思考の枠。
  maxOutputTokens: number(process.env.AGENT_MAX_OUTPUT_TOKENS, 40_000),
  // 1回の HTTP 呼び出しに掛かるタイムアウト。「ソケットが死んだときの保険」で、
  // 超えても失敗にはせず retryable として callModel が引き直す。
  httpTimeoutMs: number(process.env.AGENT_HTTP_TIMEOUT_MS, 180_000),
  // リクエスト全体の締め切り。
  //
  // 費用を止めるのはトークンの予算で、こちらは「枠を占有し続けさせない」ための壁。
  // 予算だけだとキャッシュヒットが効いた実行が70往復ほど回れてしまい、1回で
  // 同時実行3枠のうち1つを数時間押さえる (その間チャンネルには thinking が出たまま)。
  // 超えたら打ち切るのではなくツールを外すだけなので、答えはその場の材料で必ず書かれる。
  // 実測の重い実行が11往復なので10分は十分な余裕がある。
  deadlineMs: number(process.env.AGENT_DEADLINE_MS, 600_000),
  // 経過表示の編集をまとめる待ち時間。秒は <t:...:R> でクライアントが進めるので、
  // 編集が走るのはツールが切り替わったときだけ。連続で切り替わる分をここで畳む。
  progressIntervalMs: number(process.env.AGENT_PROGRESS_INTERVAL_MS, 1000),

  // --- 使用量の制限 ---
  // 勘定はトークン、意思決定はドル。
  //
  // 数えるのは呼び出し回数ではなくトークン (1回の実行で 8千〜14万トークン使うので、
  // 回数で縛ると軽い質問と重い調査が同じ1回として扱われて費用と合わない)。
  // ただし「換算トークン500万」では高いか安いか判断できないので、
  // 設定する数字はドルで書き、内部でトークンに直す。
  //
  // 重みは「キャッシュミス入力1トークン = 1」に正規化した実単価の比。
  // deepseek-v4-flash は 1Mトークンあたり 入力 $0.14 / キャッシュ $0.028 / 出力 $0.28
  // なので 0.028/0.14 = 0.2、0.28/0.14 = 2.0。
  // (キャッシュヒットの単価は資料で $0.028 と $0.0028 が食い違っていた。上限は壁なので
  //  高い方を採る。実際が安ければ厳しめに働くだけで、逆より安全。)
  tokenWeightInput: number(process.env.AGENT_TOKEN_WEIGHT_INPUT, 1),
  tokenWeightCached: number(process.env.AGENT_TOKEN_WEIGHT_CACHED, 0.2),
  tokenWeightOutput: number(process.env.AGENT_TOKEN_WEIGHT_OUTPUT, 2.0),

  // ドル ↔ 換算トークンの変換に使う単価。換算トークン1個は
  // 「キャッシュミス入力1トークン」なので、その値段がそのまま換算レートになる。
  priceInPerMTok: number(process.env.AGENT_PRICE_IN_PER_MTOK, 0.14),

  // 上限はドルで書く。/agentlimit で管理者が実行中に変えられる。0 で無制限。
  // 管理者は判定そのものを通らないので、これは他の人を縛る壁。
  //
  // 実測 (プロンプトを直した後の57件): 1回 平均 $0.0024 / 最悪 $0.0116。
  // 1人 $0.05/日 なら平均 約21回・重いの4回。全体の 10% なので、
  // 10人が同じだけ使ってようやく全体に当たる。
  // 以前の $0.25 は1人で約104回・全体の半分を取れてしまい、2人で全体が尽きた。
  // 信頼している人は /agentlimit grant で個別に上げる。
  globalDailyUsd: number(process.env.AGENT_GLOBAL_DAILY_USD, 0.5),
  userDailyUsd: number(process.env.AGENT_USER_DAILY_USD, 0.05),
  userWindowMs: number(process.env.AGENT_USER_WINDOW_MS, 86_400_000),
  globalWindowMs: number(process.env.AGENT_GLOBAL_WINDOW_MS, 86_400_000),
  // 費用の制限ではなくメモリの番人。1リクエストごとに Chrome の隔離タブを開くので、
  // 同時に何十本も走ると 12GiB を食い潰す。トークンでは同時実行数は縛れない。
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
  // web 検索は「検索エンジンのページを開いて結果を抜く」だけ。API キーは要らない。
  // 前から順に試して、結果が取れなかったら次へ落とす (lite 版は datacenter IP から
  // だと anomaly ページを返すことがあるので、素の HTML を出す Bing を控えに置く)。
  // クエリはこの末尾に URL エンコードして足すので、`?q=` まで含めて書く。
  searchEngines: list(process.env.AGENT_BROWSER_SEARCH_URLS).length
    ? list(process.env.AGENT_BROWSER_SEARCH_URLS)
    : ['https://lite.duckduckgo.com/lite/?q=', 'https://www.bing.com/search?q='],
  // 1回の検索で渡す件数と抜粋の長さ。ここがそのまま毎回のトークン。
  // 5件×180字なら約 1.5KB。足りなければ open で本文を読ませる方が安い。
  searchResults: number(process.env.AGENT_BROWSER_SEARCH_RESULTS, 5),
  searchSnippetChars: number(process.env.AGENT_BROWSER_SEARCH_SNIPPET_CHARS, 180),
  // click / type / eval / 生 CDP など、ブラウザを操作する系の action を誰に許すか。
  // ログイン済みプロファイルを触れてしまうので、既定では信頼済みの人だけ。
  browserFullForAll: flag(process.env.AGENT_BROWSER_FULL_FOR_ALL, false),
  browserTrustedUsers: list(process.env.AGENT_BROWSER_TRUSTED_USERS),
  // file: / chrome: など、ローカルを覗けるスキームを許すか。
  browserAllowLocal: flag(process.env.AGENT_BROWSER_ALLOW_LOCAL, false)
};

export const agentEnabled = Boolean(agentConfig.apiKey);
