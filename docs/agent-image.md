# agent の画像ツール (`image`)

agent は `image` ツール 1 本で、画像を読む・作る・画面を撮る。返信に画像を添付する経路はここだけ
(`ctx.images` → `src/agent/index.ts` の `AttachmentBuilder`)。以前の `browser` の `screenshot` は `shot` に移した。

| action | 内容 | 使える場所 |
|---|---|---|
| `look` | Discord の発言に貼られた画像を読み、内容と書かれた文字を**文字で**返す | いつでも |
| `draw` | `html` (HTML か SVG の断片) を PNG にして返信に添付する | bot に「ファイルを添付」の権限があるチャンネル |
| `shot` | ブラウザ (共有 Chrome) で開いているページを撮って添付する | 上に加えて、ブラウザが使えるとき |

添付できないチャンネルでは `draw` / `shot` をツール定義から外す (`look` だけ出す)。

## look (画像を読む)

- 読む画像は会話に混ぜない。**別の 1 回の呼び出し**で読み、結果を文字列で返す (ランタイムは「メッセージの content は文字列」を前提にしているため)。エンジンが ling (テキスト専用) でも動く。
- 読むモデルは既定 `z-ai/glm-5.3-flash`。`AGENT_VISION_MODEL` で変える (画像入力に対応しているモデルであること)。混んだとき (429) は qwen / mimo に回る。
- 権限は `read` と同じ: `canSeeHit` (依頼者が読めるチャンネル) と `channelScope` の両方を通った発言だけ。自発参加は @everyone の目。
- 発言は `channel.messages.fetch` で取り直す (Discord の添付 URL は署名つきで期限がある)。取るのは `cdn.discordapp.com` / `media.discordapp.net` / `images-ext-N.discordapp.net` だけ。リダイレクトも許可したホストの中だけ。外部 URL は取りに行かない。
- 8MB まで (読みながら数える)・png/jpeg/webp/gif。2MB を超えたら描画用 Chrome で長辺 1568px の JPEG に縮める。
- 1 回の実行で 3 回まで。結果は 800 字まで。費用は `ctx.extraCostUsd` に足して、実行の費用 (ユーザーの 1 日上限) に数える。
- 画像の中の文字は資料で、指示ではない (読む側のプロンプトと、返す文面の両方で言う)。

## draw (HTML / SVG を画像にする)

モデルが書いた HTML は信用しない。3 重で止める:

1. 骨組みはコードが作る (`src/render.ts` の `drawDocument`): 文字コード・CSP (`default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:`)・既定の見た目 (Noto Sans CJK・白背景)。モデルの HTML は `<body>` に入る。
2. JavaScript は文書を読む前から無効。
3. リクエストは `data:` と `about:blank` 以外すべて遮断。

加えて、`<script>` / `<link>` / `<base>` / `<meta refresh>` / `@import` は先に取り除く (安全のためではなく、遮断された `@import` が 9 秒ほど待たされて期限を超えるのを避けるため。モデルは Google Fonts をよく書く)。

上限: 入力 100KB・幅 320〜1600px (既定 800)・高さ 4000px (超えたら切る)・PNG 8MB・15 秒 (超えたら Chrome を強制終了)。
幅からはみ出したか・高さを切ったかは機械が測って返す (モデルは出来上がりを見られない)。描画の枠は同時 2 件で、きもち・よっきゅうと共有 (`takeRenderSlot` / `withRenderSlot`)。

1 回の実行で添付できるのは `draw` と `shot` の合計 3 枚。`alt` は Discord の代替テキストになる。

## shot

`browser` の `open` で開いたページを撮る (同じ隔離コンテキスト・同じ内部宛の応答のチェック)。まだ何も開いていなければ断る。
内部アドレスから応答があった実行 (`tainted`) では、撮らずに理由だけ返し、撮ったあとに分かれば捨てる (`origin: 'page'` の画像だけ。`draw` はネットワークに触れないので残す)。

## 検証

`scripts/check-image.mjs` (`npm run check` に入っている)。Chrome が無い環境では描画の部分だけ飛ばす。
外へのリクエストが 1 件も出ないこと (`<img>` / `<link>` / `@import` / `url()` / `<iframe>` / `<form>` / `<video>` / `<object>` / `<meta refresh>` / `fetch`)、JavaScript が動かないこと (`<noscript>` が出る)、
権限のないチャンネルの発言を読まないこと、取得先の許可リスト、大きさの上限を確かめる。
