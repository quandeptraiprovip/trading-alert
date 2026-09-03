#!/bin/bash
# Chép TradingWidget.app vào /Applications rồi đăng ký lại.
# Launch Services / WidgetKit đôi khi không nhận app nằm ngoài thư mục chuẩn.
set -euo pipefail
cd "$(dirname "$0")"

APP="TradingWidget.app"
DEST="/Applications/$APP"

[ -d "$APP" ] || { echo "Chưa dựng. Chạy ./build.sh trước." >&2; exit 1; }

pkill -f "$APP" 2>/dev/null || true
sleep 1
rm -rf "$DEST"
cp -R "$APP" "$DEST"

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$DEST" 2>/dev/null || true

echo "Đã cài: $DEST"
echo "Mở: open \"$DEST\""
