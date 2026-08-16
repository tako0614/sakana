# 法令検索

成立した法令だけを読むための公開サイトです。e-Gov法令検索と同じく、**読むこと**しかできません。
討議中の案件、投票、裁判、memberの記録は載せず、議会Forumのまま残します。

```
ブラウザ ─ Cloudflare Workers ─ Cloudflare Tunnel ─ 自宅鯖 (bot process) ─ SQLite
           静的asset + /api中継      cloudflared        読み取り専用API
```

- Workerは静的assetを配り、`/api/`だけをoriginへ中継します。`ORIGIN_TOKEN`はWorker secretに置き、ブラウザへは出しません。
- 中継できる経路は`worker/index.js`の許可listだけです。法令・憲法以外のURLはWorkerで止まります。
- originは`src/governance/http.js`で、法令と憲法しか読みません。tokenなしでは起動しません。

## 画面

| URL | 内容 |
|---|---|
| `#/` | 現行法の一覧。`?q=`で題名・本文・条文を全文検索、`?status=all`で旧版と廃止も含める |
| `#/law/<id>` | 法令の現行版。本文、条文、違反と処分、制限の定義、沿革、本文hash |
| `#/law/<id>/v/<n>` | その法令の過去の版 |
| `#/constitution` | 現行憲法。条文と実行規則を分けて表示する |
| `#/constitution/<v>` | 過去の憲法 |

法令本文はHTMLとして解釈せず、すべて`textContent`で描画します。

## 自宅鯖: origin を開ける

`.env`に次を足してbotを再起動します。tokenは`openssl rand -hex 32`などで作ります。

```bash
STATUTE_HTTP_PORT=8788
STATUTE_HTTP_HOST=127.0.0.1
STATUTE_HTTP_TOKEN=（32byte以上のランダム文字列）
```

`STATUTE_HTTP_TOKEN`がないと法令APIは起動しません。既定のbindはloopbackなので、
tunnel以外からは触れません。

```bash
curl -H "x-statute-token: $STATUTE_HTTP_TOKEN" http://127.0.0.1:8788/api/health
```

## Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create sakana-statutes
cloudflared tunnel route dns sakana-statutes statutes-origin.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: sakana-statutes
credentials-file: /home/USER/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: statutes-origin.example.com
    service: http://127.0.0.1:8788
  - service: http_status:404
```

```bash
sudo cloudflared service install   # 常駐させる
```

originのhostnameは公開されますが、tokenを持たない要求は401で落ちます。
Cloudflare Access を足す場合も、tokenは外さないでください。

## Cloudflare Workers

```bash
cd statutes
npm install
npx wrangler secret put ORIGIN_TOKEN   # 自宅鯖の STATUTE_HTTP_TOKEN と同じ値
npm run deploy
```

`wrangler.jsonc`の`vars.ORIGIN_URL`を、上で作ったtunnelのhostnameへ変えます。
公開URLはCloudflare dashboardの`Workers & Pages > sakana-statutes > Custom domains`で
好きなドメインに割り当てます。

```bash
npm run dev    # ローカル。ORIGIN_URLへ実際に届く必要がある
npm run tail   # 本番のログ
```

## 検査

```bash
node scripts/check-statutes.mjs
```

API経路、token、Workerの中継許可list、URL解析、日付と憲法本文の分割を検査します。
