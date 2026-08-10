# Sakana Discord Bot

`discord.js` で作ったシンプルな Discord bot です。

## Commands

- `/top [type] [period]` - テキスト / ボイスの XP ランキングを表示
- `/index <build|update|verify|embed|status|cancel|reset>` - 過去ログの取り込み・取りこぼしの確認・意味検索の準備 (サーバー管理権限が必要)
- `/search` - 過去ログ検索 (誰でも使える)
- `/searchstats` - 検索条件に一致したメッセージを「誰が / どこで / いつ」で集計
- `/context message:<link|id>` - 指定メッセージの前後を並べて表示
- `/archivestats` - よく付くリアクション / よく貼られるドメイン
- `/searchhelp` - 検索クエリの書き方

メンションで呼ぶ AI エージェントもあります (下記)。

## AI エージェント (メンションで呼ぶ)

bot を直接メンションすると、サーバーの会話を読んで答えます。用途は Discord の中で起きることに絞っています。

```
@bot この議論まとめて
@bot どっちが正しい？                     ← 口論しているメッセージにリプライしつつ
@bot たこが前に言ってた実装方針どこ？
@bot このURL何が書いてある？ https://...
```

- **議論のまとめ** — 誰がどの立場か / 論点 / 合意点 / 未解決を整理します。
- **口論の判定** — 双方の主張を並べ、事実で裏づく部分と価値観の相違を分けます。論点ごとに評価し、人格には触れません。発言が足りなければ判定を保留します。
- **過去の言動の検索** — 「いつ誰が何と言ったか」を検索し、引用リンク付きで示します。

引用は `[1]` `[2]` のような番号で返り、そのままメッセージへのリンクになります。

### 実行中の表示

考えている間は経過秒数を小文字 (subtext) で出し、毎秒更新します。いまどのツールを叩いているかも出ます。

```
-# thinking (3s)
-# thinking (12s) · search_messages
```

答えができたらこの表示は**削除**し、回答は**新しいメッセージとして送り直します**。編集で置き換えると、待っている間に他の人が発言した場合に回答が過去の位置に埋まってしまうためです。

Discord のメッセージ編集はチャンネルあたり 5回/5秒あたりで絞られるので、毎秒更新はほぼ上限です。表示が変わらない間は編集を飛ばすようにしてありますが、詰まるようなら `AGENT_PROGRESS_INTERVAL_MS=2000` にしてください。

起動する条件は2つです。

1. **bot への直接メンション** — `@bot ...`
2. **エージェントの回答へのリプライ** — メンション無しでも会話の続きとして扱います。前の回答と直近の流れが文脈に入るので、`もっと詳しく` `その3番目どういう文脈？` のように続けられます。

`@everyone`、ロールメンション、無関係な人へのリプライでは起動しません。bot 自身の発言では起動しないのでループしません。返信で人に通知が飛ばないよう、回答内では表示名を使いメンションは打ちません。

自分が投稿した回答の ID を覚えておいて突き合わせているので、リプライ判定に追加の API 呼び出しはありません (再起動を挟んだ古い回答へのリプライは、返信通知が付いていれば拾えます)。

### モデルとトークン

`deepseek-v4-flash` を OpenAI 互換の ChatCompletions で呼びます (`thinking` 有効 / `reasoning_effort=high`)。`low / high / max` の真ん中が `high` です。

トークンを使わないための作りが何点かあります。

| やっていること | 効果 |
| --- | --- |
| 呼ばれた時点で直近 30 件を最初から渡す | 「まとめて」系はツールを1回も呼ばずに終わる |
| 19桁のメッセージ ID をモデルに見せず `[3]` の番号で扱う | 引用のたびに ID を書かせない |
| ユーザー ID ではなく表示名を渡す | 同上。誤爆メンションも防げる |
| 使えないツールは定義ごと出さない | アーカイブ未取り込み / Chrome 不在のとき丸ごと削れる |
| チャンネル一覧を prompt に載せず `list_channels` にする | 探索しないターンでは払わない |
| ブラウザ操作を `browser` 1ツールの `action` に集約 | ツール定義15個ぶんの毎ターン課金を避ける |
| 空白・改行を畳み、本文を 300 文字で切る | 会話の取り込み量を抑える |
| `AGENT_MAX_ROUNDS` / `AGENT_MAX_TOOL_CHARS` | 往復回数とツール出力の総量に上限 |
| system → tools → messages の順序を固定 | DeepSeek のコンテキストキャッシュに乗りやすくする |

スクリーンショットはモデルに渡さず、返信に画像として添付します。

### ツール

| ツール | 使えるとき | 何をするか |
| --- | --- | --- |
| `search_messages` | 常時 | 過去ログ検索。既定はローカルの DSL 検索 (API 消費ゼロ)、`source:discord` で Discord 本体の検索も使える |
| `list_channels` | 常時 | 読めるチャンネルを発言数順に一覧する (エージェントは呼ばれたチャンネル以外の名前を知らない) |
| `read_channel` | 常時 | チャンネルを時系列で読む。`channel` にカンマ区切りで最大5つ渡せる。検索ヒットの番号を `around` に渡せば、その発言の周辺 (別チャンネルでも) を読む |
| `aggregate_messages` | 取り込み済みのとき | 「一番言っているのは誰か」「いつ増えたか」を件数で出す。`by:term` で**話題**も抽出できる。本文を返さないので安い |
| `semantic_search` | ベクトルがあるとき | 言い方が違っても意味が近い発言を探す (下記) |
| `browser` | 9222 に Chrome が居るとき | 専用 Chrome の操作 (下記) |

`/index build` で過去ログを取り込んでおくと、`search_messages` が `OR` / 除外 / 正規表現 / `reactions:>5` / `hour:22-4` などを使えるようになり、Discord の検索 API を消費しません。取り込んでいない場合は Discord の検索 API を使うので、単純なキーワードのみです (Discord 側のインデックス構築中は少し待つ必要があります)。

#### 検索元は2つあり、用途で使い分けます

| | ローカル (既定 `source:archive`) | Discord (`source:discord`) |
| --- | --- | --- |
| クエリ | `OR` / 除外 / 括弧 / 正規表現 / `reactions:>5` / `len:` / `hour:` / `weekday:` / `domain:` | 単純なキーワードのみ |
| 並び順 | `new` / `old` / `reactions` / `long` / `random` | `new` / `old` / **`relevance`** (Discord の関連度) |
| 集計・意味検索 | できる | できない |
| API 消費 | ゼロ | Discord の検索 API を消費 |
| 範囲 | 取り込み済みのぶん | Discord が持っているぶん |

取り込み済みならローカルが既定です。機能が多く、API を消費しません。`source:discord` を使う場面は主に2つで、

- **`sort:relevance`** が欲しいとき（Discord 独自の関連度順はローカルで再現できません）
- **ローカルで0件だったときの裏取り** — 「本当に言っていない」のか「取り込みの穴」なのかを切り分けられます。0件のときは出力にこの手段を案内します

`sort:relevance` を指定すると `source` を省略しても自動で Discord に回ります。**勝手にフォールバックはしません** — どちらを引いたか分からないまま結果を読むほうが危ないので、結果の1行目に「検索元: ローカル / Discord」を必ず出します。

**検索結果は呼び出した人が見えるチャンネルに限られます。** `/search` と同じ権限スコープを通しているので、見えないチャンネルの中身は件数にも集計にも出てきません。

### 話題を抽出する (`by:term`)

`aggregate_messages` に `by:term` を渡すと、その条件でよく話している**話題**が出ます。「探す語が事前に分からない」用途 (例: ある人の主張の食い違いを探す) の入口です。出てきた語を `search_messages` の `query` に入れれば、その話題についていつ何と言っていたかを追えます。

```
author:daco by:term
  絶対: 40件 (全体比 8.0倍)
  品質管理: 40件 (全体比 8.0倍)
  レビュー: 40件 (全体比 8.0倍)
  型安全: 25件 (全体比 7.9倍)

author:daco after:2026-04-01 by:term
  型安全: 24件
  静的解析: 24件        ← 期間で絞ると話題が移っているのが見える
```

要点が2つあります。

- **形態素解析器を入れていません。** 辞書が重く依存も増えるので、文字種の連続を語の代わりに使います。日本語では動詞・形容詞が「漢字1+かな」になるため、**漢字2文字以上を要求するとほぼ名詞だけが残る**のがこれが辞書無しで成立する理由です。カタカナは3文字以上、ラテンは3文字以上 (`AI`/`PC` のような大文字2字だけ例外)。コードブロック・引用行・URL・メンションは除去します。
- **並べるのは頻度ではなく偏り**です。生の頻度では「する」「です」しか出てきません。サーバー全体の出現率を事前分布にした log-odds (z値) で並べるので、一般語は自動的に沈みます。全体比が 1.5 倍未満の語は出しません。

サンプリングは**期間を等分した層化抽出**です。`ORDER BY RANDOM()` は数百万行だと全走査になるので使いません。直近だけを見ると昔の話題が落ちて**立場の変遷が検出できなくなる**ので、全期間から均等に拾います。

**標本であることは必ず出力に書きます。** ここに無い語を「言っていない」と読まれると、この用途では結論が逆になるためです。閾値は `.env` で全部変えられます (実データで一度チューニングする前提の値)。

### チャンネルを横断する

サーバー全体を調べる用事のために、チャンネルを1つずつ覗いて回らない作りにしてあります。往復するたび会話全体を再送するので、往復回数がそのまま費用です。

- **`list_channels` で読めるチャンネルを一覧できます。** 発言数の多い順、`#general(15k) #dev(3.4k)` のような表記で、既定30件・`filter` で名前絞り込み。**呼び出した人に見えないチャンネルは出しません。** system prompt には載せず**ツールにしてある**のは、チャンネル数の多いサーバーだと一覧を毎ターン払うことになるためです（探索するときだけ1往復払う）。エージェントに最初から見えているのは呼ばれたチャンネル1つだけです。
- **`search_messages` は最初から全チャンネル横断**です。「どこで話してたか」はまずこれで足ります。
- **`aggregate_messages by:channel`** でどのチャンネルの話題かを件数だけで把握できます (本文が返らないので安い)。
- **`read_channel` は複数チャンネルを1回で読めます** — `channel: "general, dev, random"` で最大5つ。件数はチャンネル数で割って配分するので、出力量は1チャンネルぶんと同程度に収まります。
- **アーカイブ済みスレッドも読めます。** キャッシュに載っていないチャンネルは ID から取りに行くので、検索でスレッド内の発言がヒットしたらその前後も追えます。

想定している手順は「検索 → (集計) → 必要なチャンネルをまとめて読む → 特定の発言だけ `around` で掘る」で、2〜3往復で済みます。チャンネル名自体を知りたいときだけ `list_channels` が挟まります。system prompt にもこの順序を書いてあります。往復上限は `AGENT_MAX_ROUNDS` (既定 10)。

### 意味検索 (ローカル埋め込み)

`search_messages` は文字列一致なので、**言い換えを跨げません**。

```
レビュー無しでマージするのは絶対にやめるべき
急ぎだから自分のPRはレビュー飛ばして通した
```

この2つは共通する部分文字列がほぼ無いので、trigram FTS では原理的に結び付きません。`semantic_search` はこれを繋ぎます。実測:

```
=== キーワード検索 ("レビュー無しでマージ") ===
1 件ヒット   ← 言い換えには届かない

=== semantic_search ===
意味が近い発言 3 件 / daco の中から (類似度 0.93〜0.83、候補 8 件)
埋め込み済み: このサーバーの 91%。ここに無い=言っていない、ではない。
(1位から離れすぎた 5 件は関連が薄いので除外した)
類似度は相対値。無関係な文でも 0.78 前後になるので、順位で見ること。
--- 時系列順 ---
1) [02/01 daco] レビュー無しでマージするのは絶対にやめるべき 近さ#1(0.93)
2) [07/01 daco] 急ぎだから自分のPRはレビュー飛ばして通した 近さ#2(0.85)
3) [07/11 daco] テストは後で書く、とりあえず動くので出す 近さ#3(0.83)
```

**外部 API は使いません。** `intfloat/multilingual-e5-small` (384次元) をローカルの CPU で動かします。`AutoModel` + mean pooling なので `sentence-transformers` は不要です。

`-base` (768次元) も試しましたが**採用しませんでした**。マージンが小さく (+0.027 対 small の +0.032)、推論は6倍遅く、RSS は 1.3GiB 対 1.0GiB でした。実測で small が勝ったので small です。

#### 類似度は絶対値で判断できない

実測で分かった一番大事な性質です。**無関係な日本語の文どうしでもコサインは 0.77〜0.82 出ます。**

| 比較 | 類似度 |
| --- | --- |
| 「レビュー無しでマージするのはやめるべき」↔「レビュー飛ばして通した」 | 0.85 |
| 同 ↔「猫の写真を貼っておきます」 | 0.78 |

つまり閾値では絞れず、意味があるのは**順位だけ**です。そのため、

- 各行に `近さ#2(0.85)` と**順位を併記**します。
- **1位から 0.1 以上落ちた候補は捨てます** (`SEMANTIC_RELATIVE_CUTOFF`)。これが無いと `limit` の枠を埋めるために無関係な発言が並び、モデルが「これも関連している」と誤読します。
- 出力に「類似度は相対値」と毎回書きます。

#### 運用

| | |
| --- | --- |
| ストレージ | int8 量子化 (ベクトル毎 scale) で **384 バイト/件**。1M 件でも +230MB |
| 速度 | 実測 **476 件/秒**。50万件のバックフィルで約 20 分 |
| メモリ | Python ワーカー約 1.0GiB。**10分使われないと落ちる**ので常駐しない |
| 起動 | cold start 6.9秒 / warm query **5ms**。ツールを出すとき先に温める |
| 対象 | bot 以外・10文字以上。URL はホスト名だけ残す (パスは雑音) |
| 追随 | 夜間 cron。on-write は 1GiB を24時間常駐させるのでやらない |

`/index embed` で作ります。開始前に「対象 248,300 件 / 推定 61 分 / 追加ディスク 115MB」を**実数で**出してから始めます。`/index status` に被覆率が出ます。

**権限は走査まで届きます。** 候補は `buildSearch` の SQL で絞ってからベクトルを引くので、呼んだ人に見えないチャンネルは走査対象にすら入りません (テストで固定済み)。

モデルを変えると既存ベクトルは全部意味を失うので、`embed_models` にモデルの同一性を記録し、旧モデルのベクトルは「無視される」だけで壊れません (`/index embed rebuild:true` で作り直し)。

> **注意**: `VACUUM` は rowid を振り直します。FTS も同じ依存を持つ既存の性質ですが、VACUUM 後は FTS の再構築と `/index embed rebuild:true` が必要です。

### 外付け Chrome (CDP)

bot のプロセスに Chrome を埋め込まず、**別プロセスの Chrome に CDP (既定 `127.0.0.1:9222`) で繋ぐ**だけの構成です。**この bot は Chrome を起動も終了もしません。** 居なければブラウザツールを出さないので、無ければ無いなりに動きます。

**推奨は bot と同じホストに専用 Chrome を1つ置くことです。** 人が普段使っているブラウザに相乗りさせると、そのログインセッションを Discord 経由で触らせることになり、タブを壊す事故も起きます。専用にすれば両方消えます。

起動方法は [deckide](https://github.com/tako0614/ide) の `agent-browser` に合わせています。要点は「headless を使わず、実 Google Chrome を Xvfb 上で headful 起動する」ことで、これは自動化検知 (Cloudflare の Managed Challenge 等) で弾かれにくくするためです。

```ini
# /etc/systemd/system/sakana-chrome.service の ExecStart で使う起動フラグ
xvfb-run -a --server-args="-screen 0 1280x720x24 -nolisten tcp" \
  /usr/bin/google-chrome \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir=/var/lib/sakana-chrome/profile \
  --no-first-run --no-default-browser-check --disable-dev-shm-usage \
  --autoplay-policy=no-user-gesture-required \
  --disable-gpu-sandbox \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --disable-blink-features=AutomationControlled \
  --lang=ja-JP --window-size=1280,720 --no-sandbox about:blank
```

- `--disable-gpu-sandbox` … GPU の無いサーバで headful 起動するために必要。
- **`--in-process-gpu` は付けないこと。** deckide は付けていますが (Chrome 149 では GPU プロセスの起動失敗で即死するのを回避するため必要だった)、Chrome 151 では逆効果です。GPU を browser プロセス内で動かすと ANGLE/Vulkan の初期化失敗がそのまま browser プロセスを殺し、`DevTools listening on ws://...` を出した直後に SIGTRAP (exit 133) で落ちます。GPU を別プロセスに残せば初期化失敗は無害に終わり、WebGL は SwiftShader で動きます。
- `--use-angle=swiftshader --enable-unsafe-swiftshader` … WebGL を実際に動かす。WebGL が無いのは実 Chrome として不自然で、検知の信号になる。
- `--disable-blink-features=AutomationControlled` … `navigator.webdriver` を立てない。
- `--no-sandbox` … unprivileged LXC で必要 (コンテナ側の権限を緩める代わりにこれで済む)。

CDP 側でも `navigator.webdriver` を `undefined` に保ち、`navigator.languages` を `Accept-Language` と揃える程度の補正を入れています。plugins や WebGL ベンダの**偽装はしません** — 不整合はかえって検知材料になるためです。

`browser` ツール1つに全機能を載せています: `open` / `text` / `links` / `html` / `screenshot` / `click` / `type` / `key` / `scroll` / `wait` / `eval` / `back` / `forward` / `reload` / `tabs` / `tab` / `new_tab` / `close_tab` / `console` / `network`、そして生の CDP を直接叩く `cdp` (`Page.printToPDF` など、ここに実装していないものはこれで呼べます)。

権限は2段に分けています。

- **誰でも**: `open` / `text` / `links` / `screenshot` / `scroll` / `wait` / `back` / `forward` / `reload` / `console` / `network`。ただし **Cookie を共有しない独立コンテキスト** (`Target.createBrowserContext`) に作った専用タブの中だけです。既存タブは読めず、ログイン済みサイトも引き継ぎません。
- **「サーバー管理」権限か `AGENT_BROWSER_TRUSTED_USERS`**: 上記に加えて `click` / `type` / `key` / `eval` / `cdp` / タブ操作。既定プロファイルの既存タブも触れます。

全員に全機能を許すなら `AGENT_BROWSER_FULL_FOR_ALL=true` にしてください。`file:` とローカル/内部ネットワークへのアクセスは既定で拒否します (`AGENT_BROWSER_ALLOW_LOCAL=true` で解除)。

### 呼び出し制限

既定は **1人 30回/時** と **全体 500回/日**。カウントは SQLite (`database.sqlite` の `agent_calls`) に残るので、再起動しても効きます。同時実行は3件までです。

API 側の障害やタイムアウトで失敗した分は消費に数えません。使ったトークン数も同じテーブルに記録されるので、あとから集計できます。

### 設定

```env
DEEPSEEK_API_KEY=sk-...             # これが無ければエージェントは無効 (他の機能は動く)
DEEPSEEK_MODEL=deepseek-v4-flash
AGENT_REASONING_EFFORT=high         # low / high / max の真ん中
AGENT_THINKING=true

AGENT_USER_LIMIT=30                 # 1人あたり
AGENT_USER_WINDOW_MS=3600000        # の 1 時間で
AGENT_GLOBAL_LIMIT=500              # 全体
AGENT_GLOBAL_WINDOW_MS=86400000     # の 1 日で
AGENT_MAX_CONCURRENT=3
AGENT_EXEMPT_USERS=                 # 制限を無視できる人 (カンマ区切り)

AGENT_PRELOAD_MESSAGES=30           # 最初から渡す直近メッセージ数 (0 で無効)
AGENT_MESSAGE_CHARS=300             # 1メッセージの本文上限
AGENT_MAX_ROUNDS=10                 # ツール往復の上限
AGENT_MAX_TOOL_CHARS=24000          # ツール出力の総量上限
AGENT_TIMEOUT_MS=150000
AGENT_PROGRESS_INTERVAL_MS=1000     # 「-# thinking (10s)」の更新間隔

AGENT_BROWSER=true
AGENT_BROWSER_CDP_PORT=9222         # 専用 Chrome の CDP ポート (deckide と同じ変数名)
AGENT_BROWSER_FULL_FOR_ALL=false
AGENT_BROWSER_TRUSTED_USERS=
AGENT_BROWSER_ALLOW_LOCAL=false
```

## メッセージアーカイブと検索

サーバーの過去ログを SQLite に取り込み、Discord 標準検索ではできない条件で検索できるようにします。

### 取り込み (管理者)

```
/index build     全チャンネル・全スレッドを最古まで遡って取り込む
/index update    前回の続きから最新分だけ取り込む
/index status    進捗・チャンネル別の件数・エラーを確認
/index verify    取りこぼした期間 (bot 停止中など) を探して埋める
/index embed     意味検索用のベクトルを作る (rebuild:true で作り直し)
/index cancel    実行中の取り込みを中止
/index reset     このサーバーのインデックスを全削除 (確認ボタンあり)
```

- `build` は中断しても大丈夫です。チャンネルごとに「どこまで遡ったか」を保存しているので、もう一度実行すると続きから再開します。
- 一度取り込んだあとは、新しいメッセージ・編集・削除・リアクションを自動で追記するので、基本的に `/index update` は不要です。
- Bot が読めないチャンネルは自動でスキップし、完了時に一覧を出します。

`/index` は「サーバー管理」権限を持つ人か、`ARCHIVE_ADMIN_USERS` に ID を書いた人だけが実行できます。Discord の `default_member_permissions` で絞ると許可リストの人からもコマンド自体が見えなくなる（入力候補に出ない）ので、**可視性は開けて実行可否をコード側で判定**しています。権限の無い人が叩いても断られるだけで何も起きません。

`ARCHIVE_ADMIN_USERS` を使う理由は、サーバーの ManageGuild を渡すとサーバー名変更・招待・Webhook・連携の管理まで付いてしまうためです。bot の管理コマンドだけ渡したいときはこちらを使ってください。

### 全期間を取りこぼさない

「取り切った期間」をチャンネルごとに**区間**として記録しています (`channel_spans`)。単一カーソルだけだと、bot が落ちている間に流れた分を復帰後の最初の1通がカーソルごと飛び越えてしまい、**その穴は二度と埋まらず `/index status` からも見えません**。区間で持てば穴を列挙して塞げます。

- **起動時と再接続時に自動で追いつきます。** 落ちていた間の分はここで取りに行きます。
- **新着メッセージで区間を伸ばすのは、そのチャンネルの追いつきが済んでいる間だけ**です。切断を検知したら印を捨てるので、繋がっていなかった期間を「取った」ことにしません。
- `/index status` に**被覆**が出ます。穴があれば件数と合計時間、多い順にチャンネルを表示します。
- `/index verify` で穴を埋めます (複数回ダウンした場合など、末尾以外の穴も対象)。

区間演算はメッセージ ID の文字列比較ではなく snowflake から取り出した時刻で行っています。snowflake は 17〜19 桁あり、**桁数が違うと文字列比較の大小が実際の時系列と逆になる**ためです。

**限界**: 削除されたメッセージは Discord 側にも残っていないので復元できません。「全期間保有」はこの意味で完全ではありません。bot に閲覧権限が無かった期間の分も取れません (権限が付いたあとの `/index build` で入ります)。アーカイブ済みスレッドの列挙は 200 ページで打ち切ります。

### 検索 (全員)

`/search` は誰でも使えますが、**実行者が閲覧できるチャンネルの結果しか返しません**。見えないチャンネルの中身が検索経由で漏れることはありません。

Discord 標準の検索と違って、こういう条件が使えます。

| 書き方 | 意味 |
| --- | --- |
| `会議 OR ミーティング` | どちらか (標準検索は AND だけ) |
| `会議 -中止` | 除外 |
| `(猫 OR 犬) かわいい` | 括弧でグループ化 |
| `"明日の会議"` | 空白込みの部分一致 |
| `reactions:>5` | リアクションが5個より多い |
| `reaction:👍` | 特定のリアクションが付いている |
| `len:>200` / `len:<10` | 文字数 |
| `hour:22-4` | 深夜帯の発言だけ |
| `weekday:sat,sun` | 土日の発言だけ |
| `domain:github.com` | 特定サイトの URL が貼られたもの |
| `regex:/^\d+$/` | 正規表現 (本文のみ。空白や `)` 単体を含むなら `regex:"/a b/"` と引用符で囲む) |
| `sort:reactions` | 反応が多い順に並べる |

標準検索と同じ条件も一通り使えます: `from:` `in:` `mentions:` `replyto:` `before:` `after:` `during:` `has:` `is:`。

日本語は3文字以上なら FTS5 の trigram インデックスを使い、1〜2文字の語は `LIKE` にフォールバックします (件数が多いと少し遅くなります)。

`in:#channel` はそのチャンネルのスレッドも含めて検索します。

### 削除されたメッセージ

取り込み後に削除されたメッセージは、消えたことを記録したうえで検索結果から除外します。`is:deleted` で明示的に探せますが、これは「メッセージの管理」権限を持つ人だけです。

### 設定

```env
ARCHIVE_DB_PATH=archive.sqlite      # アーカイブの保存先 (XP 用 DB とは別ファイル)
ARCHIVE_TZ_OFFSET_HOURS=9           # hour:/weekday:/日付指定を解釈するタイムゾーン
ARCHIVE_FETCH_DELAY_MS=150          # 取り込み時の待ち時間 (小さくすると速いがレート制限に当たりやすい)
ARCHIVE_REGEX_BUDGET=300000         # regex: 1回あたりの最大走査件数
```

## Setup

1. Discord Developer Portal で Application と Bot を作成します。
2. Bot token と Application ID を取得します。
3. `.env.example` を `.env` にコピーして値を入れます。

```bash
cp .env.example .env
```

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_client_id_here
DISCORD_GUILD_ID=your_test_server_id_here
OSS_TARGET_USERNAME=kurage.1
OSS_TRIGGER_TEXT=oss
OSS_RESPONSE_TEXT=oss!
EMOTION_TRIGGER_TEXT=きもち
EMOTION_PYTHON_BIN=python3
EMOTION_MODEL_NAME=neuralnaut/deberta-wrime-emotions
EMOTION_MAX_LENGTH=128
EMOTION_ANALYSIS_TIMEOUT_MS=180000
```

開発中は `DISCORD_GUILD_ID` を設定すると、スラッシュコマンドの反映が速くなります。

`kurage.1` が `oss` と送ったとき、bot は同じチャンネルに `oss!` と送ります。文言は `OSS_RESPONSE_TEXT` で変更できます。

任意のメッセージに `きもち` とリプライすると、リプライ先の本文を `neuralnaut/deberta-wrime-emotions` で分析し、HTML から生成した画像を返信します。初回は Hugging Face からモデルをダウンロードするため時間がかかります。

通常メッセージを読むには、Discord Developer Portal の Bot 設定で `Message Content Intent` を有効にしてください。

## Install

```bash
npm install
```

気持ち分析機能は Python 依存関係も必要です。

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

`requirements.txt` は CPU 版の torch を指しています。既定の index を使うと**未使用の CUDA wheel が 2.7GB** 入るためです (CPU 版なら venv 全体で約 1.2GB)。

Debian / Ubuntu では `python3-venv` が別パッケージなので、`No module named 'ensurepip'` が出たら `apt install python3.14-venv` (バージョンは環境に合わせる) が必要です。

venv を使う場合は `.env` の `EMOTION_PYTHON_BIN` を以下にします。

```env
EMOTION_PYTHON_BIN=.venv/bin/python
```

## Register Slash Commands

```bash
npm run deploy
```

## Run

```bash
npm start
```

## Invite URL

Developer Portal の OAuth2 URL Generator で以下を選んで bot をサーバーに招待してください。

- Scopes: `bot`, `applications.commands`
- Bot Permissions: `Send Messages`, `Use Slash Commands`, `Read Message History`, `Attach Files`

過去ログを取り込みたいチャンネルすべてで `View Channel` と `Read Message History` が必要です。非公開スレッドまで取り込むなら `Manage Threads` も付けてください。
