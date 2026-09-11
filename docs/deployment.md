# 本番運用メモ

2026-09-11時点。実行先はProxmoxのCT102 `discord`、既存の `sakana.service`。

- 作業・データディレクトリ: `/root/sakana`。
- 稼働ソース: `/root/sakana/releases/20260911T025701Z`。9月11日03:00 UTCに切替。systemdの `90-release.conf` がこのソースとtsxを指定する。
- 今回のバックアップ: `/root/sakana/backups/before-20260911T012405Z`。SQLiteのオンラインバックアップによるアーカイブ約1.47GBと、切替前のservice定義を保持。前回の停止中DBバックアップは `/root/sakana/backups/before-20260910T192754Z`。
- Atomはサーバー内のSQLite。新しい外部DB・GPU・推論モデルは追加していない。
- 模倣モデルの利用先にサーバー制約はない。会話の原文・記憶・実行記録・個人設定はサーバー単位で扱う。
- 法律サイト: https://sakana-laws.shoutatomiyama0614.workers.dev 。Worker版 `0e0f8fb1-c7e8-4ee7-8b5d-5ae27f4b5e08`。

## 初回履歴移行

導入時の `sakana-history-structure.service` はtakoserver、Evex Developersの再取得を終了コード0で完了した。中断時はチャンネルの保存済み取得位置から再試行する。Bot内のworker threadが原文キューをAtomへ同期する。CLIからAtomを同時更新しない。

移行開始時のアーカイブは約104万件。コピー上の試験は1,000件あたり約37秒だった。実際の所要時間はDiscordのレート制限、ディスク負荷、編集・再取得の量で変わる。初回ジョブの開始を全件完了とは扱わない。

再取得結果は `/root/sakana/releases/20260910T192754Z/history-import-result.json` と同じ場所の `history-<guildId>.log` に残る。原文同期の現況は `journalctl -u sakana.service` の `Conversation memory` に出る。原文の `memory_pending` が未反映数。所属先不明の古い行は、Discordから所属先を確認して再取得した時に補う。

## AIによる意味の整理

新しいリリースでは `deepseek-v4-flash` のWriterを有効にし、既存履歴と新着を継続的に整理する。説明・話題のまとまり・役割付き関係をAtomへ保存し、会話・警察・裁判・議会が共通の想起経路で読む。[構造と再処理の契約](agent-architecture.md)を参照。

原文同期とAI整理は一つのworkerが担当する。既定は最大60発言・60KB、同時に一バッチ。モデルの結果と確定状態を保存し、再起動時はチェックポイントから再開する。新しい外部DBやGPUは追加していない。

初回の本番確認で、Atomのメタデータ検索とキュー選択に全件走査・並べ替えが見つかった。最終版はメタデータのprefixとスコープ内ページングに索引を使い、次の仕事はキュー順の索引から取得する。まだAI整理が存在しないチャンネルではWriter用の既存整理検索を省く。

発言の訂正時に呼ぶAtomのpurgeも、全履歴の走査から、過去版の参照・出典・読取依存を辿る方式へ変更した。既存DBへの依存索引の移行はBotを止めて実施済み。索引はSQLiteのトリガーで更新されるため、コードを切り戻した場合の旧書込方式でも維持される。

読取記録の保持整理では、確定済みの書込に結び付く記録をキーだけで除外してから、一時記録の本文を読む。過去の書込記録を毎回メモリへ読み込む処理を避ける。

`memory_writer_pending` がAI未処理数、`memory_writer_runs` が完了バッチ・生成Atom数・API使用量。`processedMessages` は再整理を含む累計であり、固有の処理済み発言数ではない。約104万件の既存履歴は順次処理するため、リリース完了は全件の意味整理完了を意味しない。

本番の状態確認は `/root/sakana` を作業ディレクトリにして、リリース内の `scripts/organize-conversations.mjs --status --guild SERVER_ID` を実行する。Bot稼働中に別のWriterや原文同期CLIを同時実行しない。

## 9月10日に確認した統治の移行状態

takoserverの移行改憲案は提案82として登録済み。初期案への実AI審査は修正を要求しており、現時点で新憲法の成立を確認した記録はない。AIの起草・修正・独立審査の後、現行憲法の人間の公開投票を通す。人間の票や承認を管理スクリプトで代行しない。

執行モードは従来の `shadow` を維持する。ban/kick/unbanはBotが実行せず、成立条件を満たした案件に管理者の手動執行カードを出す。

takoserverの管理対象Botロール `Evex 公式` には、Discord側ではKickMembers/BanMembersが残っている。Botのトークンでその2権限だけを外す変更を試したが、DiscordがHTTP403 / 50013を返した。ブラウザのDiscordは未ログインだったため、管理者側でこの2権限を外す操作が残る。Evex Developers側には両権限もAdministratorも付いていない。

## 検証

リリース配置先で `npm run check`、Atom本体の全147テスト、実DeepSeekによる合成会話の整理・想起試験が通過。編集・削除による解釈の失効、入力変更中の確定拒否、永続化失敗後の再開、サーバー分離、統治の出力量予算も回帰検査に含む。purgeの全履歴走査と、保持整理で確定済み記録を読み込む処理を禁止した回帰例は旧版で失敗し、新版で通過した。テスト用DBは分離したtmpfsを使用し、Botのデータを検査入力にしていない。

リリース内の `verify-writer-result.json`、`cutover-writer-result.json` に検証と切替結果を保存する。初回バックアップの結果は `/root/sakana/releases/20260911T012405Z/backup-writer-result.json` に残る。`readback-writer-result.json` は直近のサービス状態・処理数。配布した変更ファイルは `writer-manifest.json` のSHA-256で照合してから切り替えた。

コードの切り戻しはserviceのリリース指定を戻して行う。DBは履歴取り込みや投票で更新されるため、バックアップを無条件に上書き復元しない。
