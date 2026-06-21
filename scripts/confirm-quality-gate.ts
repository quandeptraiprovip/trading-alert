/**
 * Sweep chất lượng nến CONFIRM + minRR — 250d BTC, gate 15.68R NET.
 * Chạy: npx ts-node scripts/confirm-quality-gate.ts
 */
import "../load-env";
import { CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";

const BASELINE_NET = 15.68;
const DAYS = 250;

type Variant = {
  name: string;
  o: Partial<typeof CONFIG>;
};

function netR(trades: ReturnType<typeof runBacktest>): number {
  return trades.reduce((s, t) => s + t.netR, 0);
}

async function main() {
  const barsPerDay = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const totalBars = Math.ceil(DAYS * barsPerDay) + 400;
  console.log("Tải nến BTC 15m một lần…");
  const ltf = await fetchKlinesPaged("btcusdt", CONFIG.entryTf, totalBars);

  const saved = { ...CONFIG };

  const variants: Variant[] = [
    { name: "infra only (pending+ARM pick, filter tắt)", o: {} },
    { name: "CLV confirm 0.50", o: { confirmCloseLocationMin: 0.5 } },
    { name: "CLV confirm 0.55", o: { confirmCloseLocationMin: 0.55 } },
    { name: "CLV confirm 0.60", o: { confirmCloseLocationMin: 0.6 } },
    { name: "CLV 0.55 + wick", o: { confirmCloseLocationMin: 0.55, confirmRequireWickRejection: true } },
    { name: "CLV 0.55 + trap body", o: { confirmCloseLocationMin: 0.55, confirmRejectHighVolLowBody: true } },
    { name: "CLV 0.55 + wick + trap", o: { confirmCloseLocationMin: 0.55, confirmRequireWickRejection: true, confirmRejectHighVolLowBody: true } },
    { name: "minRR 1.0", o: { minEntryRR: 1.0 } },
    { name: "minRR 1.2", o: { minEntryRR: 1.2 } },
    { name: "minRR 1.5", o: { minEntryRR: 1.5 } },
    { name: "CLV0.55 + minRR1.0", o: { confirmCloseLocationMin: 0.55, minEntryRR: 1.0 } },
    { name: "CLV0.55 + minRR1.2", o: { confirmCloseLocationMin: 0.55, minEntryRR: 1.2 } },
    { name: "CLV0.55+wick+minRR1.0", o: { confirmCloseLocationMin: 0.55, confirmRequireWickRejection: true, minEntryRR: 1.0 } },
    { name: "CLV0.55+wick+minRR1.2", o: { confirmCloseLocationMin: 0.55, confirmRequireWickRejection: true, minEntryRR: 1.2 } },
    { name: "CLV0.50+wick+minRR1.0", o: { confirmCloseLocationMin: 0.5, confirmRequireWickRejection: true, minEntryRR: 1.0 } },
    { name: "CLV0.55+wick+trap+minRR1.0", o: { confirmCloseLocationMin: 0.55, confirmRequireWickRejection: true, confirmRejectHighVolLowBody: true, minEntryRR: 1.0 } },
    { name: "wick only (no CLV)", o: { confirmRequireWickRejection: true } },
    { name: "CLV 0.45", o: { confirmCloseLocationMin: 0.45 } },
    { name: "pullback 1 bar", o: { minBarsAfterArm: 1 } },
    { name: "pullback 2 bar", o: { minBarsAfterArm: 2 } },
    { name: "pullback 3 bar", o: { minBarsAfterArm: 3 } },
    { name: "pullback2 + CLV0.55", o: { minBarsAfterArm: 2, confirmCloseLocationMin: 0.55 } },
    { name: "pullback2 + wick", o: { minBarsAfterArm: 2, confirmRequireWickRejection: true } },
    { name: "pullback1 + CLV0.50", o: { minBarsAfterArm: 1, confirmCloseLocationMin: 0.5 } },
    { name: "maxMitig 0 only", o: { maxZoneMitigations: 0 } },
    { name: "delta 0.58", o: { deltaBuyMin: 0.58 } },
    { name: "delta 0.52", o: { deltaBuyMin: 0.52 } },
    { name: "confirm vol 1.5x", o: { ltfConfirmVolMult: 1.5 } },
    { name: "confirm vol 1.2x", o: { ltfConfirmVolMult: 1.2 } },
    { name: "pullback2 + delta0.58", o: { minBarsAfterArm: 2, deltaBuyMin: 0.58 } },
    { name: "pullback2 + vol1.5", o: { minBarsAfterArm: 2, ltfConfirmVolMult: 1.5 } },
  ];

  console.log("\nVariant                              | Lệnh | NET R    | Δ vs 15.68 | WR");
  console.log("-".repeat(78));

  let best = { name: "", net: -Infinity, trades: 0, wr: 0 };

  for (const v of variants) {
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, v.o);
    const trades = runBacktest("btcusdt", ltf);
    const net = netR(trades);
    const wr = trades.length ? trades.filter((t) => t.netR > 0).length / trades.length : 0;
    const mark = net >= BASELINE_NET - 1e-9 ? "✓" : " ";
    console.log(
      `${v.name.padEnd(36)} | ${String(trades.length).padStart(4)} | ${(net >= 0 ? "+" : "") + net.toFixed(2).padStart(7)}R | ${(net - BASELINE_NET >= 0 ? "+" : "") + (net - BASELINE_NET).toFixed(2).padStart(6)}R ${mark} | ${(wr * 100).toFixed(0)}%`,
    );
    if (net > best.net) best = { name: v.name, net, trades: trades.length, wr };
  }

  Object.assign(CONFIG, saved);

  console.log("-".repeat(78));
  console.log(`Tốt nhất: "${best.name}" → ${best.net.toFixed(2)}R (${best.trades} lệnh, WR ${(best.wr * 100).toFixed(0)}%)`);
  console.log(`Gate baseline: ${BASELINE_NET}R — ${best.net >= BASELINE_NET ? "PASS (có thể bật CONFIG mặc định)" : "FAIL (giữ filter tắt)"}`);

  if (best.net >= BASELINE_NET) {
    const winner = variants.find((v) => v.name === best.name)!;
    console.log("\nĐề xuất CONFIG:");
    console.log(JSON.stringify(winner.o, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
