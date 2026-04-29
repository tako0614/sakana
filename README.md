# Sakana Discord Bot

`discord.js` で作ったシンプルな Discord bot です。

## Commands

- `/ping` - Bot の応答速度を表示
- `/echo text:<message>` - 入力したテキストを返信
- `/help` - コマンド一覧を表示

## Setup

1. Discord Developer Portal で Application と Bot を作成します。
2. Bot token と Application ID を取得します。
3. `.env.example` を `.env` にコピーして値を入れます。

```bash
cp .env.example .env
```

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_client_id_here
DISCORD_GUILD_ID=your_test_server_id_here
OSS_TARGET_USERNAME=kurage.1
OSS_TRIGGER_TEXT=oss
OSS_RESPONSE_TEXT=oss!
EMOTION_TRIGGER_TEXT=きもち
EMOTION_PYTHON_BIN=python3
EMOTION_MODEL_NAME=neuralnaut/deberta-wrime-emotions
EMOTION_MAX_LENGTH=128
EMOTION_ANALYSIS_TIMEOUT_MS=180000
```

開発中は `DISCORD_GUILD_ID` を設定すると、スラッシュコマンドの反映が速くなります。

`kurage.1` が `oss` と送ったとき、bot は同じチャンネルに `oss!` と送ります。文言は `OSS_RESPONSE_TEXT` で変更できます。

任意のメッセージに `きもち` とリプライすると、リプライ先の本文を `neuralnaut/deberta-wrime-emotions` で分析し、HTML から生成した画像を返信します。初回は Hugging Face からモデルをダウンロードするため時間がかかります。

通常メッセージを読むには、Discord Developer Portal の Bot 設定で `Message Content Intent` を有効にしてください。

## Install

```bash
npm install
```

気持ち分析機能は Python 依存関係も必要です。

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

venv を使う場合は `.env` の `EMOTION_PYTHON_BIN` を以下にします。

```env
EMOTION_PYTHON_BIN=.venv/bin/python
```

## Register Slash Commands

```bash
npm run deploy
```

## Run

```bash
npm start
```

## Invite URL

Developer Portal の OAuth2 URL Generator で以下を選んで bot をサーバーに招待してください。

- Scopes: `bot`, `applications.commands`
- Bot Permissions: `Send Messages`, `Use Slash Commands`, `Read Message History`, `Attach Files`
