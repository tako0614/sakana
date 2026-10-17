# sakana-laws Worker

法令集の公開正本です。Discordの`法令集`Forumを廃止し、成立した憲法・法律をここへ集めます。
botは差分だけをHTTPで押し込み、公開ページとJSONはこのWorkerがD1から返します。

`web/`（chat.takos.jp）とは別のWorkerです。あちらはPagesのままで、CSPも触りません。

## いまの配置

- Worker: `https://sakana-laws.shoutatomiyama0614.workers.dev`
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

## 記憶の本 (wiki)

法令集と同じ Worker に、記憶の本 (bot が会話を読んでまとめた人・もの・ネタ・出来事) を wiki として出しています。
**法令集は公開のまま、記憶の本はこのサーバーのメンバーだけ**が読めます (Discord で `/memory url` を使うと入り口のリンクが出ます)
(人物の紹介や発言の引用が入るため。設定が済むまでは閉じたままです)。

| path | 内容 |
|---|---|
| `/wiki` | トップ (分類・出来事の多さ・最近の出来事・よく話題になるページ) |
| `/wiki/<path>` | 記事。本文の `[[リンク]]`、出典の `[数字]` (その出来事のページへ)、目次、子ページ、関連ページ。`?tab=timeline` で年表 (種類の絞り込み・古い順)、`?tab=links` でつながり |
| `/e/<id>` | 出来事。種類・日付・チャンネル・決め台詞の引用・根拠の発言 (Discord へのリンクつき)・前後の出来事 |
| `/t`, `/t/YYYY-MM` | 年表 (月ごとの多さが色で分かる) / その月の出来事を日ごとに |
| `/s?q=` | 検索 (ページと出来事。3文字以上は文中も探し、短い語は名前と説明から) |
| `/random` | ランダムなページ |
| `/auth/link`, `/auth/logout` (`/auth/login`, `/auth/callback`) | bot のログインリンク / ログアウト (任意で Discord OAuth2) |
| `/v1/memory/*` | bot からの取り込み (Bearer)。`hashes` / `batch` / `prune` / `finish` |

画面は Worker が D1 から組み立てます (JavaScript なし。分類の木は `<details>`、スマホのメニューはチェックボックス)。
本文は未信頼のテキストなので、HTML は `src/wiki/html.ts` の `html``` (埋め込んだ値は必ず escape) だけで組み、
CSP は `default-src 'none'` です。型検査は `npx tsc -p tsconfig.json` (strict)。

### 見せる範囲と入り方

- **入り方 (既定)**: サーバーのメンバーが Discord で **`/memory url`** を使うと、bot が (そのサーバーにいる人だと分かっているので)
  その人だけに、10分だけ有効で1回だけ開けるログインリンクを返します。サイトは署名・サーバー・期限・使用済みかを確かめて、
  署名つき cookie (7日) を渡します。**Discord の OAuth アプリも Client Secret も要りません**。
  鍵は bot の `MEMORY_SITE_LINK_SECRET` と Worker の secret `MEMORY_LINK_SECRET` を同じ値にします。
- **Discord でログイン (任意)**: OAuth の設定 (`DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`) があれば、ログイン画面に
  「Discord でログイン」も出ます (`identify guilds` だけ。アクセストークンは使い捨てて失効させる)。
- **閉じたまま**: `SESSION_SECRET` と入り方の設定が揃うまで、`/wiki` は「まだ公開されていません」と閉じています。
  `MEMORY_ACCESS=public` にすると誰でも読めます (人物ページに個人の自己申告が入るので、既定は `members`)。
- **引用**: 出来事の根拠の発言の原文は、全員に見えるチャンネルのものだけをサイトへ送ります
  (`/memory include` で足したチャンネル・名前に nsfw などを含むチャンネル・消された発言は送らない)。
  送らなかった発言は件数だけ出し、「見られるチャンネルが限られている発言 n 件は載せていません」と表示します。
- ページの本文と要約は、メンバー全員が読める前提です (`/memory include` した内容も、本文には入ります)。
- **1つのサーバーだけ**: サイトが見せるのは `MEMORY_GUILD_ID` のサーバーだけです (bot 側の `MEMORY_TREE_GUILD` と同じ)。
  別のサーバーでは `/memory url` もボタンも出ません。

### 配備

```bash
cd worker
npm run migrate                                  # 0003_memory.sql (記憶の本の表と全文検索) を本番 D1 へ
# 鍵を2つ作る。MEMORY_LINK_SECRET は bot の .env の MEMORY_SITE_LINK_SECRET と同じ値にする
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
openssl rand -base64 32 | tee /tmp/link-secret | npx wrangler secret put MEMORY_LINK_SECRET
npm run deploy
```

`wrangler.jsonc` の `vars` で `MEMORY_GUILD_ID` (見せるサーバー) と `MEMORY_ACCESS` を決めています。
書き込みの Bearer は法令集と同じ `GOVERNANCE_LAW_API_TOKEN` です。

bot 側 (builder の後に差分だけ送り、入り口を出す):

```bash
cp deploy/sakana-memory-site.{service,timer} /etc/systemd/system/    # 10分おき (AI は使わない)
systemctl enable --now sakana-memory-site.timer
# .env: GOVERNANCE_LAW_API_URL / _TOKEN があればそのまま使う (別にするなら MEMORY_SITE_URL / MEMORY_SITE_TOKEN)
#       MEMORY_SITE_PUBLIC_URL=https://<このサイト>   MEMORY_SITE_LINK_SECRET=<上の MEMORY_LINK_SECRET と同じ値>
tsx scripts/memory-site-sync.ts --dry-run          # 何件送るか (送らない)
```

初回は全部 (4,000 ページ・1.1 万出来事で約 80 リクエスト・20 秒)、あとは変わった行だけ送ります。
サイトの D1 を空にしても、次の回に全部送り直します (行ごとの `content_hash` をサイトに聞いて比べるため)。

### ローカルで見る

```bash
cd worker
printf 'GOVERNANCE_LAW_API_TOKEN=dev-token\nMEMORY_ACCESS=public\n' > .dev.vars    # コミットしない
npm run migrate:local && npx wrangler dev --local --port 8799
# 別の端末で: 実データの写しを作って (本番では --out)、手元へ送る
MEMORY_SITE_URL=http://127.0.0.1:8799 MEMORY_SITE_TOKEN=dev-token MEMORY_TREE_GUILD=<id> tsx scripts/memory-site-sync.ts [--from snapshot.json]
open http://127.0.0.1:8799/wiki
```

検査は `tsx scripts/check-wiki.mjs` (escape・取り込み・検索・ログイン・gate・全画面) と
`tsx scripts/check-memory-site.mjs` (記憶 DB → 差分送信 → 取り込み、引用の制限)。D1 は better-sqlite3 の代用品
(`test/d1-shim.ts`) で、FTS5・`json_each`・トリガーは本物の D1 と同じ SQLite の機能です。
