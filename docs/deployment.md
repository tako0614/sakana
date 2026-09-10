# 本番運用メモ

2026-09-10時点。実行先はProxmoxのCT102 `discord`、既存の `sakana.service`。

- 作業・データディレクトリ: `/root/sakana`。
- 稼働ソース: `/root/sakana/releases/20260910T192754Z`。systemdの `90-release.conf` がこのソースとtsxを指定する。
- DBバックアップ: `/root/sakana/backups/before-20260910T192754Z`。停止中のDBと従来のservice定義を保持。
- Atomはサーバー内のSQLite。新しい外部DB・GPU・推論モデルは追加していない。
- 模倣モデルの利用先にサーバー制約はない。会話の原文・記憶・実行記録・個人設定はサーバー単位で扱う。
- 法律サイト: https://sakana-laws.shoutatomiyama0614.workers.dev 。Worker版 `0e0f8fb1-c7e8-4ee7-8b5d-5ae27f4b5e08`。

## 初回履歴移行

`sakana-history-structure.service` がtakoserver、Evex Developersの順にDiscordから再取得する。中断時はチャンネルの保存済み取得位置から再試行する。Bot内のworker threadが原文キューをAtomへ同期する。CLIからAtomを同時更新しない。

移行開始時のアーカイブは約104万件。コピー上の試験は1,000件あたり約37秒だった。実際の所要時間はDiscordのレート制限、ディスク負荷、編集・再取得の量で変わる。初回ジョブの開始を全件完了とは扱わない。

状態はリリースディレクトリの `history-import-result.json`、`history-<guildId>.log` と `journalctl -u sakana.service` の `Conversation memory` に出る。原文の `memory_pending` が未反映数。所属先不明の古い行は、Discordから所属先を確認して再取得した時に補う。

## 統治の移行状態

takoserverの移行改憲案は提案82として登録済み。初期案への実AI審査は修正を要求しており、現時点で新憲法の成立を確認した記録はない。AIの起草・修正・独立審査の後、現行憲法の人間の公開投票を通す。人間の票や承認を管理スクリプトで代行しない。

執行モードは従来の `shadow` を維持する。ban/kick/unbanはBotが実行せず、成立条件を満たした案件に管理者の手動執行カードを出す。

takoserverの管理対象Botロール `Evex 公式` には、Discord側ではKickMembers/BanMembersが残っている。Botのトークンでその2権限だけを外す変更を試したが、DiscordがHTTP403 / 50013を返した。ブラウザのDiscordは未ログインだったため、管理者側でこの2権限を外す操作が残る。Evex Developers側には両権限もAdministratorも付いていない。

## 検証

全体の `npm run check`、サーバー分離、永続化失敗時の再処理、Atom SQLiteの関連88テストが通過。本番で見つかった再取得時のキュー重複は、失敗する回帰例を確認してからUPSERT対応のトリガーへ修正した。旧版DBコピーの移行・quick_checkも成功している。

コードの切り戻しはserviceのリリース指定を戻して行う。DBは履歴取り込みや投票で更新されるため、バックアップを無条件に上書き復元しない。
