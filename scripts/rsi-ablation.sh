#!/usr/bin/env bash
# RSI modes × EMA1h (mặc định ON) — bash scripts/rsi-ablation.sh
set -e
cd "$(dirname "$0")/.."
S=strategy.ts

patch_mode() {
  node <<NODE
const fs=require('fs');
const mode='$1';
let s=fs.readFileSync('$S','utf8');
s=s.replace(/entryRsiMode: \"[^\"]+\" as EntryRsiMode/, 'entryRsiMode: "'+mode+'" as EntryRsiMode');
fs.writeFileSync('$S',s);
NODE
}

run() {
  patch_mode "$1"
  printf "%-18s" "$2"
  ./node_modules/.bin/ts-node backtest.ts 250 1 btcusdt 2>&1 | rg "Tổng lệnh|NET R       |p-value" | tr '\n' ' '
  echo
}

echo "Base: BOS+ARM + EMA50 1h. RSI Wilder 14."
run "off" "off (baseline)"
run "minLevel" "minLevel >=50/<=50"
run "trendBand" "trendBand 40-72"
run "rising" "rising bar"
run "pullbackRecover" "pullbackRecover"

patch_mode "off"
echo "Done. Restored entryRsiMode=off"
