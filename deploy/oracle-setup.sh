#!/usr/bin/env bash
# ============================================================================
# Cài & chạy BTC Alert Bot 24/7 trên Oracle Cloud Always Free VM (Ubuntu)
# ----------------------------------------------------------------------------
# Cách dùng (SSH vào VM rồi chạy):
#   git clone https://github.com/quandeptraiprovip/trading-alert.git
#   cd trading-alert
#   bash deploy/oracle-setup.sh
#
# Script sẽ: cài Node 20 LTS + pm2, cài deps, hỏi token Telegram, tạo .env,
# rồi chạy bot bằng pm2 (tự sống lại khi crash & khi reboot VM).
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo "==> [1/5] Cài Node.js 20 LTS + git"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs git
fi
node -v

echo "==> [2/5] Cài pm2 (process manager giữ bot chạy 24/7)"
sudo npm install -g pm2

echo "==> [3/5] Cài dependencies (gồm cả devDeps: ts-node, typescript)"
npm install --include=dev

echo "==> [4/5] Tạo file .env"
if [ ! -f .env ]; then
  read -rp "TELEGRAM_BOT_TOKEN: " BOT_TOKEN
  read -rp "TELEGRAM_CHAT_ID: "   CHAT_ID
  cat > .env <<EOF
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
TELEGRAM_CHAT_ID=$CHAT_ID
# BẮT BUỘC trên cloud: dùng stream Binance .vision để tránh bị chặn 451
BINANCE_PUBLIC=1
EOF
  echo "   -> Đã tạo .env"
else
  echo "   -> .env đã tồn tại, bỏ qua. (Nhớ phải có BINANCE_PUBLIC=1)"
fi

echo "==> [5/5] Chạy bot bằng pm2"
pm2 delete btc-bot >/dev/null 2>&1 || true
pm2 start npm --name btc-bot -- start
pm2 save
# Đăng ký khởi động cùng VM (in ra 1 lệnh sudo, copy chạy theo hướng dẫn)
pm2 startup systemd -u "$USER" --hp "$HOME" | tail -n 1 || true

echo ""
echo "============================================================"
echo " Xong! Bot đang chạy. Vài lệnh hữu ích:"
echo "   pm2 logs btc-bot     # xem log realtime"
echo "   pm2 status           # xem trạng thái"
echo "   pm2 restart btc-bot  # khởi động lại"
echo " Nếu pm2 in ra 1 dòng 'sudo env PATH=...' ở trên -> copy chạy 1 lần"
echo " để bot tự bật lại sau khi VM reboot."
echo "============================================================"
