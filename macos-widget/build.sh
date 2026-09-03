#!/bin/bash
# Dựng TradingWidget.app: app thanh menu + widget extension S/M/L nhúng bên trong.
#
# Không có chứng chỉ ký nào trên máy này (security find-identity → 0 valid),
# nên tất cả ký AD-HOC. Đủ để dùng cục bộ, KHÔNG phân phát được cho máy khác.
set -euo pipefail
cd "$(dirname "$0")"

APP="TradingWidget.app"
APP_ID="local.trading.widget"
TARGET="arm64-apple-macos14.0"


# Metadata nền tảng. Xcode tự nhúng những khoá này; bundle dựng tay thì không có,
# và widget của Apple đều mang chúng — thiếu thì hệ có thể không coi là widget hợp lệ.
SDK_VER=$(xcrun --sdk macosx --show-sdk-version 2>/dev/null || echo 26.5)
SDK_BUILD=$(xcrun --sdk macosx --show-sdk-build-version 2>/dev/null || echo 25F70)
XC_BUILD=$(xcodebuild -version 2>/dev/null | awk '/Build version/{print $3}')
OS_BUILD=$(sw_vers -buildVersion)
: "${XC_BUILD:=17F113}"
DT_PLATFORM_BUILD=$SDK_BUILD

# WidgetKit kiểm chữ ký khi quyết định nạp extension. Ad-hoc (TeamIdentifier=not set)
# là nghi phạm số một khi widget không hiện trong thư viện. Dùng chứng chỉ thật nếu có.
SIGN_ID=$(security find-identity -v -p codesigning 2>/dev/null \
  | grep -oE '"Apple Development: [^"]+"' | head -1 | tr -d '"' || true)
if [ -z "$SIGN_ID" ]; then
  SIGN_ID=$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -oE '"Developer ID Application: [^"]+"' | head -1 | tr -d '"' || true)
fi
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="-"
  SIGN_NOTE="ad-hoc (chưa có chứng chỉ — widget có thể KHÔNG hiện trong thư viện)"
else
  SIGN_NOTE="$SIGN_ID"
fi

platform_keys() {
  cat <<KEYS
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>DTPlatformName</key><string>macosx</string>
  <key>DTPlatformVersion</key><string>$SDK_VER</string>
  <key>DTSDKName</key><string>macosx$SDK_VER</string>
  <key>DTSDKBuild</key><string>$SDK_BUILD</string>
  <key>DTCompiler</key><string>com.apple.compilers.llvm.clang.1_0</string>
  <key>DTPlatformBuild</key><string>$DT_PLATFORM_BUILD</string>
  <key>DTXcode</key><string>2660</string>
  <key>DTXcodeBuild</key><string>$XC_BUILD</string>
  <key>BuildMachineOSBuild</key><string>$OS_BUILD</string>
KEYS
}

# Xcode có thể đã cài nhưng chưa chấp nhận license → swiftc từ chối chạy.
# Rơi về Command Line Tools để dựng được app; widget extension vẫn cần Xcode.
if ! swiftc --version >/dev/null 2>&1; then
  if [ -d /Library/Developer/CommandLineTools ]; then
    export DEVELOPER_DIR=/Library/Developer/CommandLineTools
    echo "⚠︎  Xcode chưa chấp nhận license — dùng Command Line Tools."
  else
    echo "Không dùng được swiftc và không có Command Line Tools." >&2
    exit 1
  fi
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# ── App thanh menu ──────────────────────────────────────────────────────────
swiftc -O -swift-version 5 -target "$TARGET" \
  -o "$APP/Contents/MacOS/TradingWidget" Sources/*.swift

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>TradingWidget</string>
  <key>CFBundleDisplayName</key><string>Trading Widget</string>
  <key>CFBundleIdentifier</key><string>$APP_ID</string>
  <key>CFBundleExecutable</key><string>TradingWidget</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- KHÔNG dùng LSUIElement: cờ này ẩn app khỏi Launch Services, mà widget gallery
       lại liệt kê widget theo app. Dock icon đã được ẩn ở runtime bằng
       NSApp.setActivationPolicy(.accessory) trong main.swift — hành vi y hệt. -->
$(platform_keys)
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSExceptionDomains</key>
    <dict>
      <key>127.0.0.1</key>
      <dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
    </dict>
  </dict>
</dict>
</plist>
PLIST

# Widget extension S/M/L KHÔNG dựng ở đây nữa — nó thuộc project Xcode
# ~/Desktop/trading-widget (ký chứng chỉ thật, deployment target đúng OS).
# Đồng bộ nguồn sang đó bằng: node ~/Desktop/trading-widget/sync-from-menubar.js

codesign --force --sign "$SIGN_ID" --timestamp=none "$APP"

# Đăng ký với Launch Services để widget hiện trong thư viện widget.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$(pwd)/$APP" 2>/dev/null || true

echo "Dựng xong: $(pwd)/$APP"
echo "  ký bằng: $SIGN_NOTE"
