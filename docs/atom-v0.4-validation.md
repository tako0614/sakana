# Atom 0.4と共通AI接続の検証

2026-09-12。Atomのソースは `1495d5aaf2004e014cb35caa51cbdc1e48eb5b1b` / `v0.4.0`。Sakanaはこのライブラリをビルドして使う。

## 実装した境界

- Atomの `search`・`read`・自動readを、入力種類別の類似度と役割・方向の重み付きグラフ伝播へ集約。5操作は同じAPI。重要度をLLMに採点させるサービスや全体の常駐ランキング処理は追加していない。
- 保存ベクトルの設定を順位設定から分離。公開0.3のSQLiteから0.4への移行で、3ベクトル・索引進捗・既存の派生物を再埋め込みなしで保持。
- Sakanaの有料接続を `src/ai/provider.js`、費用を `src/ai/cost.js` へ集約。会話と統治は既定DeepSeek V4 Flash 0731、WriterはLing 3.0 Flash。OpenRouterの価格順で同じモデルの提供元を選ぶ。
- Writerのcollectionリンクはlogical、根拠・主張はobserved。長期間の履歴を有限バッチで調べ、既存のまとまりを改訂する処理を継続する。
- ローカルE5、自前の模倣モデル、guild/channelの情報分離、投票・承認・拒否権・管理者の手動ban/kickの境界は維持。

## 実行済み

- Atom: 136テスト、Docs 15例の型検査・実行、7出力照合、Docs build、format。
- Node 22 / 24の[ライブラリCI](https://github.com/tako0614/atom-memory/actions/runs/34693103893)。
- npm用tarballを独立プロジェクトへインストールし、公開型、Memory/SQLite、構造検索、自動read、必須条件、旧exportの撤去を確認。
- 正しい関係・構造探索なし・同数の誤った関係を同一本文・固定ベクトル・予算で比較し、関連条件の取得は1 / 0 / 0。Writer品質の試験とは区別する。
- Sakana `npm run check` 全体。DBをtmpfsへ分離し、原文と記憶の分離、agentic統治、失敗再開、議会、裁判、警察、承認、投票、拒否権、手動執行、既存模倣モデル経路を検証。
- `check-openrouter.mjs`: 価格順・ツール要件・同モデルfallback指定、reasoningのツール継続、実usage.cost、旧推定額の移行、guild別集計、予算0でAPI送信前停止、障害時の未確定予約、モデル変更後の旧checkpoint拒否。
- `check-memory-writer.mjs`: collectionのlogicalリンクと根拠のobservedリンクも確認。

## 未実施

- OpenRouterの実API呼出し。この環境にはキーがない。`scripts/check-memory-writer-live.mjs` は質問を渡す前の2期間の合成会話を整理する隔離試験で、Writer日額上限を$1へ固定する。実行結果の意味の正しさは別途レビューする。
- CT102のBot切替。保存済みProxmoxセッションは401。新しい認証を必要とする。
- 全履歴の有料再処理。実装の確認としては開始していない。

npm公開とDocsの最終照合情報は、Atomリポジトリの `validation/release.json` に保存する。本番切替は[運用手順](deployment.md)、費用と上限は[費用仕様](memory-cost.md)を参照。
