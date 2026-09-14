# 本番運用メモ

## 2026-09-14: Atom 0.9と継続Writerの統合検証

ライブラリとSakanaの実装・一式のチェックは完了。[検証記録](writer-validation.md)に、再送・権限変更・索引待ち・遅れて届く再生成要求の試験を残した。本番Botは未切替。SSH認証とProxmoxの操作接続を回復した後、以下の停止・バックアップ・切替・読戻し手順を実行する。npmとDocsの公開状態は[ライブラリの公開manifest](https://atom-memory.takos.jp/release.json)を確認する。

## 2026-09-13: Evex Dreamの実装（本番切替未確認）

[Dream運用](dreaming.md)に、Ling 3.0 Flashによる全履歴・新着・定期見直しと、OpenRouter Qwen3 Embedding 8Bへの切替をまとめた。原資料・索引workerとAI workerは既存Bot内で分離し、Evexの永続30 USD枠へ両モデルを計上する。

以下の日付付き記録は過去の本番確認であり、今回の実行版の証拠にはしない。今回の切替にはservice・配置ファイル・新設定・初回取得証明・ジョブ状態の読み戻しが必要。

2026-09-11時点。実行先はProxmoxのCT102 `discord`、既存の `sakana.service`。

- 作業・データディレクトリ: `/root/sakana`。
- 稼働ソース: `/root/sakana/releases/20260911T031350Z`。9月11日03:15 UTCに切替。systemdの `90-release.conf` がこのソースとtsxを指定する。
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

添付だけの発言でも空の検索文を作らず、AIへ渡す。既存整理の想起が予算上限に達した場合は、その不完全性をAIへ明示して入力の原資料から整理を続ける。他の読取障害は通常どおり再試行する。

`memory_writer_pending` がAI未処理数、`memory_writer_runs` が完了バッチ・生成Atom数・API使用量。`processedMessages` は再整理を含む累計であり、固有の処理済み発言数ではない。約104万件の既存履歴は順次処理するため、リリース完了は全件の意味整理完了を意味しない。

本番の状態確認は `/root/sakana` を作業ディレクトリにして、リリース内の `scripts/organize-conversations.mjs --status --guild SERVER_ID` を実行する。Bot稼働中に別のWriterや原文同期CLIを同時実行しない。

## 9月10日に確認した統治の移行状態

takoserverの移行改憲案は提案82として登録済み。初期案への実AI審査は修正を要求しており、現時点で新憲法の成立を確認した記録はない。AIの起草・修正・独立審査の後、現行憲法の人間の公開投票を通す。人間の票や承認を管理スクリプトで代行しない。

執行モードは従来の `shadow` を維持する。ban/kick/unbanはBotが実行せず、成立条件を満たした案件に管理者の手動執行カードを出す。

takoserverの管理対象Botロール `Evex 公式` には、Discord側ではKickMembers/BanMembersが残っている。Botのトークンでその2権限だけを外す変更を試したが、DiscordがHTTP403 / 50013を返した。ブラウザのDiscordは未ログインだったため、管理者側でこの2権限を外す操作が残る。Evex Developers側には両権限もAdministratorも付いていない。

## 検証

リリース配置先で `npm run check`、Atom本体の全147テスト、実DeepSeekによる合成会話の整理・想起試験が通過。編集・削除による解釈の失効、入力変更中の確定拒否、永続化失敗後の再開、空本文・想起予算上限からの整理継続、サーバー分離、統治の出力量予算も回帰検査に含む。purgeの全履歴走査と、保持整理で確定済み記録を読み込む処理を禁止した回帰例は旧版で失敗し、新版で通過した。テスト用DBは分離したtmpfsを使用し、Botのデータを検査入力にしていない。

リリース内の `verify-writer-result.json`、`cutover-writer-result.json` に検証と切替結果を保存する。初回バックアップの結果は `/root/sakana/releases/20260911T012405Z/backup-writer-result.json` に残る。`readback-writer-result.json` は直近のサービス状態・処理数。配布した変更ファイルは `writer-manifest.json` のSHA-256で照合してから切り替えた。

コードの切り戻しはserviceのリリース指定を戻して行う。DBは履歴取り込みや投票で更新されるため、バックアップを無条件に上書き復元しない。

## 9月12日のライブラリ・Sakana更新（本番未反映）

Atomの差分索引API・SQLiteのベクトル候補取得と、Sakanaの共有埋め込み・Writer改訂・明示的な記憶焦点・Writer費用記録を追加した。AtomはJSライブラリのままで、常駐処理はSakanaが担当する。[費用と設定](memory-cost.md)を参照。

0.5の境界テスト、ドキュメント例、ドキュメントビルド、Sakana側のWriter lineage検査は進行中で、最終件数や実モデルの品質差は未確定である。このローカル環境にはDeepSeekのAPIキーがなく、今回の実DeepSeek試験と本番切替は未実施。

既存SQLiteへ初めて適用する時は、変更フィード用の `(policy,sequence,revision_id)` 索引を構築する。Botの停止中に新リリースのSqliteStorageを開いて移行を済ませてから起動する。v3索引のベクトル生成は起動後のscope別drainで行い、DBを開く段階で全履歴を埋め込まない。すべての提供policy scopeをdrainするまで、意味検索の準備完了を主張しない。

### 2026-09-12: Atom Memory 0.3.0 の公開

`atom-memory@0.3.0` をnpmのlatestとして公開し、同じtarballの再インストール・integrity・型・SQLite・バッチWriter・索引更新を確認した。docsは https://atom-memory.takos.jp/history を含む10ページを読み戻し、公開manifestとnpmの版を照合済み。Atomの157テスト、Node 22/24のCI、13個のdocs実行例が合格。公開記録は `subprojects/atom-memory/validation/release.json`。

SakanaのWriterは30分の固定区切りを最大7日・60件・60KBの入力範囲へ変更し、AIが以前の話題を検索・改訂しながらまとめて書く。探索と最終出力は既定最大6ステップ。入力範囲を期間全体の既読・完了と扱わず、既存のメッセージ世代と確定チェックポイントを使う。`MEMORY_WRITER_BATCH_WINDOW_MS` と `MEMORY_WRITER_MAX_STEPS` は `.env.example` を参照。

この変更はリポジトリへ反映し、Sakanaの全体チェックで検証した。稼働中のDiscord botへのデプロイ、今回の版での新しいDeepSeek呼び出し、全履歴の有料処理は実行していない。

## Atom 0.5 / OpenRouterへの切替手順（2026-09-12、未実施）

この節は今回のコードの手順。上の9月11日の稼働記録を今回のデプロイ済み証拠として扱わない。今回の作業環境ではOpenRouterキーが未設定で、保存済みProxmoxセッションの読取は401だった。実AI試験とCT102への切替は、接続が戻った後の未実施項目。

1. リリース用の新しいディレクトリへSakanaと固定したAtomサブモジュールを配置し、`npm ci` と隔離DBでの `npm run check` を完了する。稼働ディレクトリで開発・試験をしない。
2. 既存のEnvironmentFileへ `OPENROUTER_API_KEY`、`AI_MODEL=deepseek/deepseek-v4-flash-0731`、`MEMORY_WRITER_MODEL=inclusionai/ling-3.0-flash` を用意する。旧DeepSeekキーだけでは新コードの有料推論は有効にならない。金額上限は既存の運用値を引き継ぐ。
3. Botと別の書込ジョブを止め、アーカイブ・Atom・agent実行DB・通常DBをSQLite backupで保存し、service定義と旧リリース先も記録する。
4. Atomのバックアップを取り、`prepareIndex` はcursorでcurrent headを走査し、`updateIndex` はsequence 0の変更フィードから各policy scopeをdrainする。既知のv2設定からの再利用は、own-body hash、policy、encoder、dimensions、vectorsが一致する一行に限る。旧checkpointや旧cursorをコピーせず、リンク先本文を混ぜた旧行は再埋め込みする。各scopeの永続checkpointと `pending: false` を確認するまで、意味検索の準備完了や全履歴の網羅を主張しない。
5. systemdのリリース参照を切り替え、Botを起動する。MainPID、ExecStart、実リリースcommit、guild別Writer状態、OpenRouterのmodel/provider/usage、エラーログを読み戻す。原文・索引キューの未完了数をリリース成功と混同しない。

旧版へ戻す際はBotを停止して旧リリース参照へ戻す。共通費用台帳へ移した後は、旧版のWriter台帳が空になるので、そのまま有料Writerを起動しない。まず `MEMORY_WRITER_DAILY_USD=0` で止め、当日の `ai_model_calls` のWriter請求・推定・未確定予約を旧台帳へ引き継いでから既存上限を戻す。新しいメッセージを失うDB全体の無条件復元はしない。v3を読めない旧版へ戻す場合は、旧索引を別の投影として再準備し、v3索引のcheckpointを現行として流用しない。

## Atom 0.5の責務分離（作業ツリー、未デプロイ）

Atomのモデル実行・自動再生成・後継採用APIを外し、Sakanaの既存runAgent/Writerへ役割を集約した。stale通知から同じスコープのWriterキューへ再処理を要求する。readはstale候補をcurrent sourceへ代用せず、通常の候補取得・構造展開で独立に見つかったものだけを返す。Writerは公開receiptを実行中プロセスで認可確認に使い、receipt自体はcheckpointへ保存しない。checkpointには採用した既存Atomのentry・sourceと正確なbatch・Atom refを保存する。応答後とcommit直前にheadと認可を再検証し、最終editで採用refを再検査する。checkpoint復元時は正確な採用refを再束縛し、明示的なrevise対象はrevision CASで扱う。原文が同じ再整理も新しい仕事として識別するため、Writerのbatch IDにqueued_atを加えた。旧版の未完了runと新しい仕事のIDが異なる場合があり、切替前に処理状態と費用を確認する。

npm・公開Docs・稼働Botへの反映は未実施。ソースと公開版を混同しない。ライブラリの破壊的変更は `subprojects/atom-memory/docs/migration.md`、責務は [agent-architecture.md](agent-architecture.md) を参照。

## Atom 0.6の統合（2026-09-13、Bot本番切替は未実施）

作業ツリーは単一活性評価器とモデル入力の自動利用記録へ更新した。0.5のSQLite本文・版・出典・own-body v3ベクトルは維持する。古い検索cursorは失効し、設定は `ranking` から `activation` と `retrieval` へ移る。0.4以前は従来のv3索引移行も必要。ライブラリのnpm・Docsの公開状態は[公開manifest](https://atom-memory.takos.jp/release.json)で確認する。

0.6.0のnpm公開と空キャッシュからのインストール、Docsのデプロイと全18ページ・manifestの読戻しを完了した。Sakanaの `npm run precheck` も合格した。この確認は作業ツリーと公開ライブラリを対象にしており、Proxmox上の稼働Botは切り替えていない。

利用の集計・再送防止記録は既存Atom DB、成功したモデル応答と未通知状態は既存agent runtime DBに保存する。両DBを従来のバックアップ対象として保持する。古いcheckpointと新しい仕事を混ぜず、切替時はWriterと進行中agentを停止して状態を確認する。受理済みイベントの再送防止記録にはTTLを設定しないため、モデルroundと利用版の数に応じて保存量が増える。対象のpurgeでは同じtransactionで削除する。

半減期を変更する場合だけ `host.resetUse(binding)` を対象subject・読取policyごとに明示実行する。これは本文・ベクトルを消さず、古いイベントの再送防止記録も残す。通常の0.5→0.6更新でresetは不要。全policyの意味索引が準備済みか、全履歴のWriter処理が完了したかは、このリリースの合否とは別に確認する。

## Atom 0.7の統合（2026-09-13、npm・Docs・Bot未反映）

0.7は0.6の本文・版・出典・own-body v3ベクトルとWriterの責務境界を維持し、利用可能性だけを `AvailabilityModel` として差し替える。既定の `adaptiveUse({ initialHalfLifeMs, maxHalfLifeMs })` は `{ mass, updatedAt, halfLifeMs }` を保持し、初期7日・最大365日を既定にする。受理イベントで減衰massへ1を加え、保持率に応じて半減期を伸ばす。これはbounded engineering approximationであり、脳の再現や経験的に最適な値を主張しない。

`AvailabilityModel` の `id` は状態と設定のidentityに含める。意味やパラメータを変更したID不一致は `STATE_INVALIDATED` とし、対象subject・policy scopeで `host.resetUse(binding)` を明示してから再開する。ライブラリがscope、atomicity、event dedup、purge、1KiB以下のJSON状態検証を所有し、モデルcallbackへquery、context、最終score、候補graph、全履歴を渡さない。read・searchだけでは利用を記録せず、成功したモデル応答後のhost ackだけを `recordUse` として受理する。callbackの例外、Promise、無効state、非有限値は0へフォールバックせず失敗させる。

0.6のlegacy利用状態はreadで正確にdecodeし、readやイベント再送では書き換えない。次の新しいrecordUseだけでadaptiveUse形式へrewriteし、旧半減期が365日を超えていても短くしない。旧cursorは設定identityの変更で失効する。既存のv3ベクトルは再エンコードしない。移行fixtureの確認はAtom側の `ATOM_V06_PACKAGE=/path/to/published-0.6.0-package node scripts/check-v06-migration.mjs` を使う。

この節は作業ツリーの契約と検証手順であり、npm公開・Docsデプロイ・Sakana Bot本番切替の証拠ではない。公開前にAtomのモデル回帰、legacy migration、ドキュメント例、Sakanaの自動readとfocus lifecycle、checkpoint内のprovider reasoning境界を個別に読み戻す。


## Atom 0.9と継続Writer（2026-09-13）

採用契約と作業ツリーは[Writer設計](writer-design.md)、現在の設定は[Dream運用](dreaming.md)を正本とする。旧節は各時点の記録であり、公開状態を表さない。

公開APIは一括writeと一段inspectへ移行し、旧callback editを除去する。Sakanaはモデル呼び出し単位のInputTokenを保存するため、同じ入力の変更を再送できる。保存済みAtom本文を無条件に消す移行は行わない。旧Dream admissionを含む投影hashは内容だけのhashへ更新し、変更された投影とその依存生成は再整理対象になる。アーカイブ原文、旧見直し記録、累計費用は保持する。

切替時にはBotの旧Writerを停止し、archive・Atom・agent runtime・費用DBとWALを一貫した状態で保存する。新しいschedulerは旧review件数を完了証明に使わず、owner/fence付きの仕事と有限の見直し対象を作る。旧モデル出力checkpointを新schemaの完了結果と混ぜない。公開manifestは現在のDiscord権限から再構成する。

リリース検証はAtomのbuild/test/docs/consumer、Sakanaの`npm run check`、原資料投影・共有scope・再送回復の試験を行う。実Lingの品質確認、npm公開、配信Docsのmanifest、稼働Botの版・queue・commit/flushは別に読み戻す。ローカル試験合格だけで全履歴処理完了や本番切替完了とはしない。
