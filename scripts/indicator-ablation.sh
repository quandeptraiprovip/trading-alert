#!/usr/bin/env bash
# A/B chỉ báo entry — bash scripts/indicator-ablation.sh
set -e
cd "$(dirname "$0")/.."
S=strategy.ts

patch() {
  node <<NODE
const fs=require('fs');
const o=$1;
let s=fs.readFileSync('$S','utf8');
const b=(k,v)=>{ s=s.replace(new RegExp(k+': (true|false)'), k+': '+v); };
b('entryRsiEnabled', o.rsi);
b('entryEmaLtfEnabled', o.ltf);
b('entryEmaHtfEnabled', o.htf);
b('entryAdxEnabled', o.adx);
fs.writeFileSync('$S',s);
NODE
}

run() {
  patch "$2"
  echo "=== $1 ==="
  ./node_modules/.bin/ts-node backtest.ts 250 1 btcusdt 2>&1 | rg "Tổng lệnh|NET R       |p-value"
  echo
}

run "baseline (all off)" '{"rsi":"false","ltf":"false","htf":"false","adx":"false"}'
run "RSI>=50/<=50" '{"rsi":"true","ltf":"false","htf":"false","adx":"false"}'
run "EMA21 15m" '{"rsi":"false","ltf":"true","htf":"false","adx":"false"}'
run "EMA50 1h" '{"rsi":"false","ltf":"false","htf":"true","adx":"false"}'
run "ADX>=20" '{"rsi":"false","ltf":"false","htf":"false","adx":"true"}'
run "RSI+EMA15m" '{"rsi":"true","ltf":"true","htf":"false","adx":"false"}'
run "EMA15m+EMA1h" '{"rsi":"false","ltf":"true","htf":"true","adx":"false"}'
run "RSI+EMA1h" '{"rsi":"true","ltf":"false","htf":"true","adx":"false"}'
run "RSI+EMA15+1h" '{"rsi":"true","ltf":"true","htf":"true","adx":"false"}'
run "all four" '{"rsi":"true","ltf":"true","htf":"true","adx":"true"}'

patch '{"rsi":"false","ltf":"false","htf":"false","adx":"false"}'
