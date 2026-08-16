# sakana-laws Worker

法令集の公開正本です。Discordの`法令集`Forumを廃止し、成立した憲法・法律をここへ集めます。
botは差分だけをHTTPで押し込み、公開ページとJSONはこのWorkerがD1から返します。

`web/`（chat.takos.jp）とは別のWorkerです。あちらはPagesのままで、CSPも触りません。

## いまの配置

- Worker: `https://sakana-laws.shoutatomiyama0614.workers.dev`
- D1: `sakana-laws` (`a7a062b4-750f-46bd-b1b6-1663e6537efe`, APAC) — `0001_init.sql` 適用済み
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
npm run migrate:local
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

## API

| method | path | 認証 | 内容 |
|---|---|---|---|
| POST | `/v1/instruments` | Bearer | 1件のupsert。`(guildId, type, instrumentId)`が主キーなので何度送っても同じ |
| GET | `/v1/laws?guild=<id>` | なし | 現行の憲法・法律の一覧。`&history=1`で旧版・廃止・違憲も |
| GET | `/v1/laws/<code>?guild=<id>` | なし | 1法令の全文と執行定義 |
| GET | `/?guild=<id>` | なし | 人が読む一覧ページ |

bot側は `GOVERNANCE_LAW_API_URL`（このWorkerのorigin）、`GOVERNANCE_LAW_API_TOKEN`、
`GOVERNANCE_LAW_SITE_URL`（公開ページのorigin。手続チャンネルのリンクに使う）を設定します。
未設定なら押し込みは行わず、統治機能はDiscord内だけで動きます。
