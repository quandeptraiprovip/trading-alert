#!/usr/bin/env bash
# Chỉ merge thay đổi strategy khi NET 250d BTC (15m entry) >= baseline.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BASELINE_NET="${BASELINE_NET_R:-21.50}"
DAYS="${1:-250}"
RISK="${2:-1}"
SYMBOL="${3:-btcusdt}"
TF="${4:-15m}"

OUT="$(./node_modules/.bin/ts-node backtest.ts "$DAYS" "$RISK" "$SYMBOL" "$TF" 2>&1)" || {
  echo "$OUT"
  exit 1
}

NET="$(echo "$OUT" | sed -n 's/^NET R[[:space:]]*:[[:space:]]*\([+-][0-9.]*\)R.*/\1/p' | head -1)"
TRADES="$(echo "$OUT" | sed -n 's/^Tổng lệnh[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -1)"

if [[ -z "$NET" ]]; then
  echo "$OUT"
  echo "baseline-gate: không parse được NET R"
  exit 2
fi

echo "$OUT" | tail -20
echo ""
echo "baseline-gate: NET=${NET}R (${TRADES} lệnh) vs baseline ${BASELINE_NET}R"

python3 - "$NET" "$BASELINE_NET" <<'PY'
import sys
net = float(sys.argv[1])
base = float(sys.argv[2])
if net >= base - 1e-9:
    print(f"PASS — giữ / đổi code (NET >= {base}R)")
    sys.exit(0)
print(f"FAIL — hoàn tác CONFIG (NET {net}R < {base}R)")
sys.exit(1)
PY
