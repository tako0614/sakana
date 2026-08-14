#!/bin/bash
# 自作モデルの世代を1つ bot に載せる。**順序を落とすと静かに壊れる**ので手で打たない。
#
#   bash deploy/add-engine.sh evex-ft-3 8769
#
# 落としやすいのは 4 と 5。実際に両方やった:
#
#   4 を忘れる → Discord の一覧には出るのに、選ぶと「そのモデルは選べません」。
#               走っている bot の ENGINES / ENDPOINTS は起動時に読まれるので、
#               git pull しただけでは新しいキーを知らない
#   5 を忘れる → /model の選択肢が古いまま。あれは Discord 側の登録データに
#               焼き付くので、コードを直して再起動しても変わらない
set -euo pipefail

engine="${1:?使い方: add-engine.sh <engine> <port>}"
port="${2:?使い方: add-engine.sh <engine> <port>}"
unit="sakana-mimic-${engine#evex-}"          # evex-ft-3 → sakana-mimic-ft-3
[ -f "deploy/$unit.service" ] || unit="sakana-mimic-${engine##*-}"

cd /root/sakana

echo "== 1. コードを合わせる"
git pull --ff-only

echo "== 2/3. unit を入れて読み直す ($unit)"
cp "deploy/$unit.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now "$unit"

echo "== 推論サーバーが応答するまで待つ (int8 の量子化は fp32 読み込みの後)"
for _ in $(seq 1 40); do
  if curl -sf "localhost:$port/health" >/dev/null; then break; fi
  sleep 5
done
curl -s "localhost:$port/health"; echo

echo "== 4. bot を再起動する (ENGINES / ENDPOINTS は起動時に読まれる)"
systemctl restart sakana
sleep 10
systemctl is-active sakana

echo "== 5. Discord のコマンド登録を更新する (/model の選択肢は登録データに焼き付く)"
node scripts/deploy-commands.js
node scripts/list-commands.js | grep -A2 '^/model$'

echo
echo "完了。/model に $engine が出て、選べるようになっているか確認する。"
echo "global 登録なのでクライアント側のキャッシュが残る (Ctrl+R で更新)。"
