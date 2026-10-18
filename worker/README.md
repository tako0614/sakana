# sakana-laws Worker

法令集の公開正本です。Discordの`法令集`Forumを廃止し、成立した憲法・法律をここへ集めます。
botは差分だけをHTTPで押し込み、公開ページとJSONはこのWorkerがD1から返します。

`web/`（chat.takos.jp）とは別のWorkerです。あちらはPagesのままで、CSPも触りません。

## いまの配置

- Worker: `https://sakana.takos.jp` (カスタムドメイン。`wrangler.jsonc` の `routes`)。`https://sakana-laws.shoutatomiyama0614.workers.dev` も残していて、bot が法令・記憶を押し込む先 (`GOVERNANCE_LAW_API_URL`) はこちら。
- D1: `sakana-laws` (`a7a062b4-750f-46bd-b1b6-1663e6537efe`, APAC) — `0001_init.sql` 適用済み。
  沿革を並べるための`root_id`を足したので、`npm run migrate`で`0002_root_id.sql`を当てます。
  既存行の`root_id`は自分自身になりますが、botが再起動時に全件を押し直すと正しい系列に揃います
- secret `GOVERNANCE_LAW_API_TOKEN` 設定済み。bot側の同名env varと同じ値にします

## 作り直す / 別アカウントへ置く

```bash
cd worker
npm install
npx wrangler d1 create sakana-laws          # 出力の database_id を wrangler.jsonc へ
npm run migrate                              # 本番D1へschemaを適用
npx wrangler secret put GOVERNANCE_LAW_API_TOKEN
npm run deploy
```

`GOVERNANCE_LAW_API_TOKEN` はbot側の同名の環境変数と同じ値にします。書き込みはこのトークンを
`Authorization: Bearer` で持つリクエストだけが通ります。読み取りは公開です。

## ローカルで動かす

```bash
npm run migrate:local          # 0002_root_id.sql まで適用する
npm run dev
curl -X POST http://127.0.0.1:8787/v1/instruments \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"guildId":"1","type":"law","instrumentId":"1","code":"LAW-1-R1","title":"テスト法",
       "version":1,"status":"active","publicationStatus":"現行法","text":"本文",
       "provisions":{"articles":[]},"contentHash":"abc","effectiveAt":1,"endedAt":null}'
curl 'http://127.0.0.1:8787/v1/laws?guild=1'
open 'http://127.0.0.1:8787/?guild=1'
```

`wrangler dev --local` はローカルの`.wrangler/state`を使うので、secretは`.dev.vars`に
`GOVERNANCE_LAW_API_TOKEN=...`と書きます（このファイルはコミットしません）。

## 画面

読むための画面はWorkerがD1から組み立てます（ビルド無し・JS無し）。

- **一覧**: 憲法と法律を分けて並べ、現行を先に置く。検索はGETフォームなのでJSを切っていても動く
- **法令**: 題名・状態・施行日・版、目次、本文、条文（`#a-<条番号>`のアンカー付き）、違反と処分、機能制限の定義、沿革、本文hash
- **憲法**: 題名、目次（各条へのリンク）、条文、実行規則（JSONは折りたたみ）
- 旧版を開くと現行版への案内を出す。法令本文はすべてescapeして出すのでHTMLとして解釈しない

描画は`src/render.js`にD1もfetchも触らない純関数として置き、`node scripts/check-lawsite.mjs`で
検査します。

## API

| method | path | 認証 | 内容 |
|---|---|---|---|
| POST | `/v1/instruments` | Bearer | 1件のupsert。`(guildId, type, instrumentId)`が主キーなので何度送っても同じ |
| GET | `/v1/laws?guild=<id>` | なし | 現行の憲法・法律の一覧。`&history=1`で旧版・廃止・違憲も |
| GET | `/v1/laws/<code>?guild=<id>` | なし | 1法令の全文と執行定義 |
| GET | `/?guild=<id>` | なし | 一覧。`&q=`で全文検索、`&type=law\|constitution`で種類、`&history=1`で旧版・廃止も |
| GET | `/law/<instrumentId>?guild=<id>` | なし | 法律1件。本文・条文・違反と処分・機能制限の定義・沿革 |
| GET | `/constitution/<instrumentId>?guild=<id>` | なし | 憲法1件。条文と実行規則を分けて表示 |

bot側は `GOVERNANCE_LAW_API_URL`（このWorkerのorigin）、`GOVERNANCE_LAW_API_TOKEN`、
`GOVERNANCE_LAW_SITE_URL`（公開ページのorigin。手続チャンネルのリンクに使う）を設定します。
未設定なら押し込みは行わず、統治機能はDiscord内だけで動きます。

## 記憶 (wiki)

法令集と同じ Worker に、記憶 (bot が会話を読んでまとめた人・もの・ネタ・出来事) を wiki として出しています。
法令集は誰でも読める公開サイトです。記憶は、**Discord でログインした、そのサーバーのメンバーだけ**が読めます
(Discord で `/memory url` を使うとリンクが出ます。ログインの設定が揃うまでは `MEMORY_ACCESS=public` で公開のまま、下の「ログイン」を参照)。
検索エンジンには `noindex` を出しています (人物の紹介や発言の引用が入るため。見つけてもらう場ではなく、リンクで渡す場として使う)。

| path | 内容 |
|---|---|
| `/<サーバーID>/wiki` | トップ (分類・出来事の多さ・最近の出来事・よく話題になるページ) |
| `/<サーバーID>/wiki/<path>` | 記事。本文の `[[リンク]]`、出典の `[数字]` (その出来事のページへ)、目次、子ページ、関連ページ。`?tab=timeline` で年表 (種類の絞り込み・古い順)、`?tab=links` でつながり |
| `/<サーバーID>/e/<id>` | 出来事。種類・日付・チャンネル・決め台詞の引用・根拠の発言 (Discord へのリンクつき)・前後の出来事 |
| `/<サーバーID>/t`, `/t/YYYY-MM` | 年表 (月ごとの多さが色で分かる) / その月の出来事を日ごとに |
| `/<サーバーID>/s?q=` | 検索 (ページと出来事。3文字以上は文中も探し、短い語は名前と説明から) |
| `/<サーバーID>/random` | ランダムなページ |
| `/auth/login?g=<サーバーID>` → Discord → `/auth/callback` | Discord ログイン (`identify` と `guilds`。メンバーかを確かめて cookie を渡す) |
| `/<サーバーID>/auth/logout` | ログアウト |
| `/auth/link` | 以前の bot のログインリンク。開かれたら記憶のトップ (ログイン画面) へ転送 |
| `/v1/memory/*` | bot からの取り込み (Bearer)。`hashes` / `batch` / `prune` / `finish` |

画面は Worker が D1 から組み立てます (JavaScript なし。分類の木は `<details>`、スマホのメニューはチェックボックス)。
本文は未信頼のテキストなので、HTML は `src/wiki/html.ts` の `html``` (埋め込んだ値は必ず escape) だけで組み、
CSP は `default-src 'none'` です。型検査は `npx tsc -p tsconfig.json` (strict)。

### 見せる範囲

- **メンバーだけ**: `MEMORY_ACCESS` が `public` でなければ、Discord でログインして、そのサーバーに入っていると確かめられた人だけ。
  見せるサーバーは `MEMORY_GUILD_IDS` に書いたものだけで、一覧に無い ID の URL はそのサーバーがあるかも教えずに 404 です。
  ログインの設定が揃っていなければ、何も見せずに閉じます (503)。共有キャッシュには残さない (`cache-control: private, no-store`)。
- **引用**: 出来事の根拠の発言の原文は、全員に見えるチャンネルのものだけをサイトへ送ります
  (`/memory include` で足したチャンネル・名前に nsfw などを含むチャンネル・消された発言は送らない)。
  送らなかった発言は件数だけ出し、「見られるチャンネルが限られている発言 n 件は載せていません」と表示します。
- ページの本文と要約は、サーバーのメンバーに見せる前提です (`/memory include` した内容も、本文には入ります)。人物ページには会話から読み取った
  自己申告 (学校・身長体重など) が入りうるので、載せたくない内容は builder の入力 (チャンネルの公開範囲・`/memory include`) 側で止めてください。
- **サーバーごとに分ける**: URL は `/<サーバーID>/wiki/…`。データ (D1 の `guild_id`)・リンク・検索・取り込みのどれも、
  サーバーをまたいで混ざりません (同じ ID・同じパスで別の内容を入れて確かめています: `scripts/check-wiki.mjs`)。
  サーバーの付かない旧い URL (`/wiki` など) は、見せているサーバーが1つのときだけそこへ転送します。
- **サーバーを足す**: `wrangler.jsonc` の `MEMORY_GUILD_IDS` に ID を足して配備し、bot の `.env` の `MEMORY_SITE_GUILDS` にも足します
  (builder がそのサーバーの記憶を作り終えていること。記憶の無いサーバーは送りません)。

### ログイン (Discord OAuth)

- 仕組み: `/auth/login` が Discord (`identify guilds`) へ送り、`/auth/callback` で戻る。state を cookie と突き合わせ、ユーザーの
  サーバー一覧に対象サーバーがあるときだけ、署名つき cookie (`sk_session_<サーバーID>`、7 日、`Path=/<サーバーID>`、HttpOnly、Secure、SameSite=Lax) を渡す。
  OAuth のアクセストークンはその場で失効させて保存しない。メッセージもフレンドも読まない。cookie は中にサーバー ID を持ち (署名の中)、
  別のサーバーの URL では使えない。ログイン後の戻り先はそのサーバーの中の絶対パスだけ。
- 入口は `MEMORY_SITE_ORIGIN` (正式な origin) 1 つ。別の入口 (workers.dev) から来た人はそちらへ転送する (cookie も Discord の戻り先もそこにしか無い)。
- 設定 (Discord の Developer Portal → アプリ → OAuth2):
  1. **Redirects** に `https://sakana.takos.jp/auth/callback` を登録する。
  2. **Client Secret** を Worker の secret にする: `cd worker && npx wrangler secret put DISCORD_CLIENT_SECRET`。
  3. `DISCORD_CLIENT_ID` は bot と同じアプリの ID (`wrangler.jsonc` の `vars`、公開してよい)。
  4. `SESSION_SECRET` はランダムな文字列 (`npx wrangler secret put SESSION_SECRET`)。変えると全員がログインし直しになる。
  5. 揃ったら `wrangler.jsonc` の `MEMORY_ACCESS` を `members` にして配備する (`public` の間は誰でも読める)。

### 配備

```bash
cd worker
npm run migrate                                  # 0003_memory.sql (記憶の表と全文検索) を本番 D1 へ
npm run deploy
```

`wrangler.jsonc` の `vars` で `MEMORY_GUILD_IDS` (見せるサーバー) を決めています。
書き込みの Bearer は法令集と同じ `GOVERNANCE_LAW_API_TOKEN` です。

bot 側 (builder の後に差分だけ送り、入り口を出す):

```bash
cp deploy/sakana-memory-site.{service,timer} /etc/systemd/system/    # 10分おき (AI は使わない)
systemctl enable --now sakana-memory-site.timer
# .env: GOVERNANCE_LAW_API_URL / _TOKEN があればそのまま使う (別にするなら MEMORY_SITE_URL / MEMORY_SITE_TOKEN)
#       MEMORY_SITE_PUBLIC_URL=https://<このサイト>
tsx scripts/memory-site-sync.ts --dry-run          # 何件送るか (送らない)
```

初回は全部 (4,000 ページ・1.1 万出来事で約 80 リクエスト・20 秒)、あとは変わった行だけ送ります。
サイトの D1 を空にしても、次の回に全部送り直します (行ごとの `content_hash` をサイトに聞いて比べるため)。

### ローカルで見る

```bash
cd worker
printf 'GOVERNANCE_LAW_API_TOKEN=dev-token\nMEMORY_GUILD_IDS=<id>\n' > .dev.vars    # コミットしない
npm run migrate:local && npx wrangler dev --local --port 8799
# 別の端末で: 実データの写しを作って (本番では --out)、手元へ送る
MEMORY_SITE_URL=http://127.0.0.1:8799 MEMORY_SITE_TOKEN=dev-token MEMORY_SITE_GUILDS=<id> tsx scripts/memory-site-sync.ts [--from snapshot.json]
open http://127.0.0.1:8799/<サーバーID>/wiki
```

検査は `tsx scripts/check-wiki.mjs` (escape・取り込み・検索・サーバーの分離・全画面) と
`tsx scripts/check-memory-site.mjs` (記憶 DB → 差分送信 → 取り込み、引用の制限)。D1 は better-sqlite3 の代用品
(`test/d1-shim.ts`) で、FTS5・`json_each`・トリガーは本物の D1 と同じ SQLite の機能です。
