# 2026-09-16 本番メモリ切替の準備

新しいDream/Writerはまだ稼働版へ切り替えていない。CT102へ候補を配置し、実行環境での隔離テストを完了した。OpenRouterキーの設定後、DB移行、取得範囲の検証、Dream開始、保存・索引・想起の実確認が必要。

## 確認した本番

- Proxmox: `pve2`、CT102 `discord`、`192.168.0.117`。
- データ: `/root/sakana`。サービス: `sakana.service`。
- 稼働ソース: `/root/sakana/releases/20260911T031350Z`。今回の候補ではない。
- Node: `24.15.0`。
- 旧WriterのEvexキューには100回以上再試行された発言が残っていた。全履歴の整理完了を示す状態ではない。

接続時、42 GiBのrootfsが100%で、利用可能領域は約228 KiBだった。既存の`hdd`ストレージには約3.9 TBの空きがあったため、rootfsを96 GiBへ拡張した。Proxmoxのresizeタスクは`OK`、ゲスト内の空きは約51 GiBになった。原文やAtomの削除はしていない。

拡張直後の空き容量は、バックアップや今後のQwen索引を含めた容量保証ではない。4096次元の全履歴索引は容量を実測し、空き不足ならDreamを停止できる運用を整えてから継続する。

## 配置した候補

- 配置先: `/root/sakana/releases/20260916T131500Z`。
- Sakana: `33c548a48bbfe23f7f97a0e73e2a319da08b6e4a`。
- Atom: `da015ced20226362ae3931d93d8bd15ec2058217`、パッケージ版`0.9.0`。
- 配布物SHA-256: `405d633adb5d16672b7da620394263e38558d591f93590137283358d2ef82a24`。
- `release-manifest.json`の各ファイルのSHA-256を配置時に照合した。
- `npm ci`、ネストしたAtomのビルド、`npm run check`がCT102で成功。`stage-verified.json`に記録した。

未コミットの作業ファイルを配布物へ入れていない。模倣モデルの学習チェックポイント`evex4/`は含めず、既存のモデルサービスを維持した。Atom 0.10の取得実験を本番の既定へ変更していない。

検証は本番DB・本番認証情報から隔離した。初回は検証用プロセスに`MEMORY_WRITER_ENABLED=false`を継承させたため、Writerを実行するfixtureが失敗した。隔離を維持して運用用の無効化設定をテストから外し、全チェックを再実行して成功した。アプリのソース変更による修正ではない。

## バックアップ

`/root/sakana/backups/before-20260916T131500Z`に、Bot停止中にSQLite backup APIで以下をコピーした。WALのコミット済み状態も含む。

- `database.sqlite`：通常のBot・統治データ。
- `archive.sqlite`：原文、キュー、Writerの処理記録。
- `database.sqlite.agents.sqlite`：Agentの永続実行状態。
- `archive.sqlite.atoms.sqlite`：Atom本文、関係、版、メタデータ。

service定義・drop-in・環境設定も同じバックアップに保持する。環境設定は秘密情報を含むため公開しない。コピー後、旧版のサービスを再起動した。13:26:59 UTC開始のPID `51009`、`active`、`NRestarts=0`と旧リリースのExecStartを読み戻した。

コピーの作成と検査は別に扱う。`backup-result.json`の`verified:true`と全4 DBの`quickChecks`が`ok`であることを、移行前に必ず確認する。検査未完了ならコピーだけを検証済みバックアップと呼ばない。

## 再開時の手順

1. サービスの実行先と`stage-verified.json`、バックアップ結果を再確認する。稼働中DBが更新された分も踏まえ、実際の移行直前に整合したバックアップを確保する。
2. `/root/sakana/.env`の`OPENROUTER_API_KEY`の存在を値を表示せず確認する。APIキーはチャット、journal、公開記録へ出さない。
3. Atomのコピーで新しいSqliteStorageの移行を試し、索引構築時間・容量・整合性を確認する。`purge:pending`があれば解消するまで切り替えない。
4. 保守中はWriterとDreamを無効にし、通常Writerの`MEMORY_WRITER_DAILY_USD=0`を設定する。Botと原文取得CLIを同時に動かさず、Evexのfull取得を検証する。件数だけでは開始しない。`clean`と`verifiedFull`が必要。
5. Dream対象を`1255359848644608035`だけにし、`--start`で永続ジョブを登録する。既存の予算・累計を消さず、上限30 USDを確認する。全原資料の再投影・Qwen索引の完了と、一件のWriterの優先投影・索引完了は区別する。
6. 最終設定はWriterとDreamを有効にし、通常Writerのdaily上限は0のままとする。DreamのLingとQwenは別の永続30 USD枠を使用する。サービスの参照先を新リリースへ切り替える。
7. 現在の権限に基づく公開範囲と非公開範囲を確認する。実際のWriter生成物、出典・条件・構成関係、`committed:true`、Qwenの索引、flush後の再読込、対象世代の完了を照合する。Botの現在のcontextから、その生成物を想起できることを確認する。

当日の公開endpoint確認ではLingの`:free`に利用可能なendpointがなく、有料の同モデルへの既存フォールバックが必要だった。Qwen3 Embedding 8Bには利用可能なendpointがあった。この確認は認証付きの実推論成功を意味しない。

serviceが`active`であること、候補のテスト成功、ジョブ登録、過去のAtom件数だけを、新しいDream/Writerの実運用成功として報告しない。
