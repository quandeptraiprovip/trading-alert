#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
STRAT=strategy.ts

patch() {
  node <<NODE
const fs=require('fs');
const o=${1};
let s=fs.readFileSync('$STRAT','utf8');
s=s.replace(/requirePullbackAfterArm: (true|false)/,'requirePullbackAfterArm: '+o.pullback);
s=s.replace(/ltfConfirmRejectionMode: \"[^\"]+\" as LtfConfirmRejectionMode/,'ltfConfirmRejectionMode: \"'+o.rej+'\" as LtfConfirmRejectionMode');
s=s.replace(/useDiscountPremiumFilter: (true|false)/,'useDiscountPremiumFilter: '+o.disc);
fs.writeFileSync('$STRAT',s);
NODE
}

run_one() {
  local label="$1"
  shift
  patch "$1"
  echo "=== $label ==="
  ./node_modules/.bin/ts-node backtest.ts 250 1 btcusdt 2>&1 | rg "Tổng lệnh|NET R       |p-value"
  echo
}

run_one "current BOS+ARM" '{"pullback":"false","rej":"off","disc":"false"}'
run_one "wick rejection" '{"pullback":"false","rej":"wick","disc":"false"}'
run_one "pullback required" '{"pullback":"true","rej":"off","disc":"false"}'
run_one "wick + pullback" '{"pullback":"true","rej":"wick","disc":"false"}'
run_one "discount/premium 1h" '{"pullback":"false","rej":"off","disc":"true"}'
run_one "wick+pullback" '{"pullback":"true","rej":"wick","disc":"false"}'
run_one "wick+disc" '{"pullback":"false","rej":"wick","disc":"true"}'
run_one "pull+disc" '{"pullback":"true","rej":"off","disc":"true"}'

patch '{"pullback":"false","rej":"off","disc":"false"}'
