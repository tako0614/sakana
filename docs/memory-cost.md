# Sakanaの記憶処理とAI費用

AtomはJSライブラリ。履歴キュー、モデル接続、ローカルE5、費用と定期実行はSakanaが持つ。

## 共通接続

|処理|モデル・実行先|支払い|
|---|---|---|
|会話・警察・裁判・議会|OpenRouter `deepseek/deepseek-v4-flash-0731`|各リクエストの実料金|
|意味分解・関係・まとまりのWriter|OpenRouter `inclusionai/ling-3.0-flash`|各リクエストの実料金|
|原文・Atom・関係検索|既存SQLite|API課金なし|
|文脈・明示的thought・Atomの埋め込み|既存ローカルE5 worker|API課金なし。CPU・メモリ使用|
|模倣モデル|既存の自前接続先|この切替の対象外|

`OPENROUTER_API_KEY` を共通で使う。`AI_MODEL` が会話・統治の既定、`AGENT_MODEL`・統治の既存役割別model・`MEMORY_WRITER_MODEL` で上書きできる。全有料リクエストは `src/ai/provider.js` を通り、`sort: 'price'`・`require_parameters: true`・`allow_fallbacks: true` を指定する。同じモデルに対応する接続先の中で価格順に試し、ツール等の指定を満たす提供元を使う。別モデルへ自動で切り替えない。[OpenRouterのprovider選択](https://openrouter.ai/docs/guides/routing/provider-selection)に対応する。

## 請求額と未確定分

`ai_model_calls` にサーバー・役割・モデル・提供元・run ID・リクエストID・usageを記録する。`usage.cost` がある場合はそのOpenRouter請求額を使う。tokenから計算した額を請求額として扱わない。出力検証が失敗しても発生した費用を記録する。[usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)を参照。

通信障害やプロセス停止で額が分からない場合は、事前の予約額を未確定として残す。料金も取得できなかった未確定リクエストは `unpricedCalls` で区別し、予約額0を無料とは扱わない。旧 `memory_writer_calls` の記録は共通台帳へ一度移し、旧版のtoken推定額は `estimatedUsd` として分離する。旧記録にサーバー識別子がないため、それを任意サーバーの実績に推定配賦しない。

```sh
# 保存済みのWriter実績と見積もり。AIを呼ばない。
npm run memory:organize -- --status --guild SERVER_ID
npm run memory:organize -- --estimate --guild SERVER_ID
```

`--estimate` は当該サーバーの直近100完了バッチのtokensを未処理件数へ外挿する。共通台帳に保存したモデル料金を使う。試料・料金がなければ見積もり不可。モデルや期間による品質・出力量・再整理回数の差があるため、確定予算や有料全履歴処理の開始指示ではない。

## Writerの支払上限

`MEMORY_WRITER_DAILY_USD` はUTC日単位の全Writer合計予算。空欄は金額上限なし、0は有料Writer停止。請求額・旧推定額・未確定予約額と次回の保守的な予約額で、API送信前に判定する。日をまたいでも未処理キューと確定済み結果は保持する。

OpenRouterのモデル別endpoint料金を1時間キャッシュし、対応先の最大入力・出力単価から予約する。上限有効時は料金の取得が必要で、同じ単価を `provider.max_price` に指定して高い提供先へ流れないようにする。予約には入力のUTF-8 bytesに固定余裕を加え、最大出力tokensを使う。これは実token数より保守的な通常入力向けの上界で、提供元の課金変更や特殊な添付課金まで保証するものではない。今回の共通経路はテキストのメッセージを送る。

Writerの上限は裁判や会話を止めない。会話の既存 `/agentlimit` と `AGENT_*_USD` は、固定レートによる換算使用量の枠として維持する。OpenRouterの実請求額の上限ではない。既存の投票・承認・権限制御も機能側が持つ。

## 長期間の履歴を段階的に整理する

Writerは同じチャンネルの未処理履歴を既定で最大7日・60件・60KBの範囲にまとめる。30分の固定区切りは廃止した。疎な会話は数日分を一度に読め、活発な会話は件数・バイト上限でさらに分かれる。`MEMORY_WRITER_BATCH_WINDOW_MS`、`MEMORY_WRITER_BATCH_MESSAGES`、`MEMORY_WRITER_BATCH_BYTES` で調整できる。期間は転送上の範囲であり、話題の分類やその期間全体の完了を意味しない。

AIは過去の整理を `memory_search` で調べ、同じ話題のAtomを再利用・改訂し、新しい情報と関係をまとめて最大40 Atomの編集計画にする。`MEMORY_WRITER_MAX_STEPS` は検索と最終出力を合わせて既定6回まで。1回で足りればそこで完了する。件数だけを増やすと出力予算や文脈の限界に当たり得るので、実際の利用量と整理品質を見て調整する。

Sakanaの進捗単位は処理済みのメッセージ世代で、モデル結果・Atom確定・索引・永続化のチェックポイントから再開する。失敗時に期間全体を読み直したり、確定済みのモデル呼び出しを繰り返したりしない。AtomのJSライブラリには長期ジョブや課金スケジューラーを持ち込まない。
