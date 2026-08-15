# evex browser chat

Cloudflare Pagesで配信する完全ブラウザ推論のチャットです。PagesはHTML/CSS/JSと
ONNX Runtimeだけを配信し、モデルはHugging Faceのimmutable revisionから取得します。
プロンプトと生成結果を送るAPI、Pages Functions、analyticsはありません。
会話履歴はブラウザの`localStorage`に保存し、左のサイドバーから切り替え・削除できます。
対応モデルでは入力欄の上にある「なりきり」をONにすると、Hugging Faceの
`speakers.json`から人物を選べます。OFFでは通常の匿名応答になります。

## Models

| model | browser artifact | backend | initial download |
|---|---|---|---:|
| evex-1 | KV-cache付きfp32 ONNX | WebGPU / WASM | 約28 MB |
| evex-2 | KV-cache付きfp32 ONNX | WebGPU / WASM | 約28 MB |
| evex-ft-1 epoch 2 | Qwen3 fp16 ONNX | WebGPUのみ | 約1.3 GB |

現在公開している3モデルはすべてなりきり対応です。対応可否は`src/models.ts`に明示し、
対応モデルだけUIを有効にします。

`src/models.ts`のrevisionは公開後のHugging Face commit SHAへ固定します。privateの
`evex-ft-1-preview`はレジストリに含めません。

`evex-ft-1`は量子化していません。対応端末を限定する代わりにfp16の品質を保ちます。
初回取得後のファイルはTransformers.jsのcustom cacheとして実装したIndexedDBへ
8 MiBチャンクで保存します。保存完了のmetadataを最後に書くため、中断した取得を
次回の有効なcache hitとして扱いません。

## Export

```bash
.venv-llm/bin/pip install -r scripts/llm/requirements-web.txt

.venv-llm/bin/python scripts/llm/export-web.py HF_EVEX_1_SNAPSHOT OUT_EVEX_1
.venv-llm/bin/python scripts/llm/check-web-export.py HF_EVEX_1_SNAPSHOT OUT_EVEX_1

.venv-llm/bin/python scripts/llm/export-ft-web.py HF_EVEX_FT_1_EPOCH_2 OUT_EVEX_FT_1
```

`export-web.py`は空のKV cacheを受け取れるONNXを作り、SentencePieceと
`tokenizer.json`の制御token・空白・byte fallbackの一致を検査します。
`check-web-export.py`はPyTorchとのlogit一致と、全系列推論とKV-cacheによる1 token推論の
一致を検査します。

`export-ft-web.py`は学習時の`rope_parameters.rope_theta`をOptimumが読む
`rope_theta`へ明示的に橋渡しします。これを省くとQwen3の位置計算が既定値へ戻るため、
変換後にも値を検査します。

## Develop and verify

```bash
npm install
npm test
npm run build
npm run dev
```

Cloudflare Pagesのbuild outputは`web/dist`です。`public/_headers`でCOOP/COEP、CSP、
`nosniff`を設定します。モデルはPagesのasset上限を超えるためPagesへコピーしません。

## Deploy to Cloudflare Pages

初回だけPages projectを作り、previewを確認してからproduction branchへ出します。

```bash
npx wrangler pages project create takos-chat --production-branch main
npm run deploy:preview
npm run deploy
```

その後、Cloudflare dashboardの`Workers & Pages > takos-chat > Custom domains`で
`chat.takos.jp`を追加します。Git連携を使う場合はroot directoryを`web`、build commandを
`npm run build`、build output directoryを`dist`にします。モデル本体をPagesへ置く必要は
ありません。
