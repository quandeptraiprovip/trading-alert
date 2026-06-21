/**
 * Sweep điểm yếu #2: invalidation wick + pullback retest vùng + anti-chase + delta strict.
 * Gate: NET > 16.81R (250d BTC). Chạy: npx ts-node scripts/pullback-zone-gate.ts
 */
import "../load-env";
import { CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";

const GATE_NET = 16.81;
const DAYS = 250;

type Variant = { name: string; o: Partial<typeof CONFIG> };

function netR(trades: ReturnType<typeof runBacktest>): number {
  return trades.reduce((s, t) => s + t.netR, 0);
}

async function main() {
  const barsPerDay = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const totalBars = Math.ceil(DAYS * barsPerDay) + 400;
  console.log("Tải nến BTC 15m…");
  const ltf = await fetchKlinesPaged("btcusdt", CONFIG.entryTf, totalBars);

  const saved = { ...CONFIG };

  const variants: Variant[] = [
    { name: "baseline (minBars3 hiện tại)", o: {} },
    { name: "wick invalidation", o: { zoneInvalidationUseWick: true } },
    { name: "retest zone", o: { requirePullbackRetestZone: true } },
    { name: "pullback ≥0.25R", o: { minPullbackRiskFrac: 0.25 } },
    { name: "pullback ≥0.35R", o: { minPullbackRiskFrac: 0.35 } },
    { name: "pullback ≥0.50R", o: { minPullbackRiskFrac: 0.5 } },
    { name: "anti-chase +1%", o: { confirmMaxExtensionAboveZonePct: 0.01, confirmMaxExtensionBelowZonePct: 0.01 } },
    { name: "anti-chase +1.5%", o: { confirmMaxExtensionAboveZonePct: 0.015, confirmMaxExtensionBelowZonePct: 0.015 } },
    { name: "anti-chase +2%", o: { confirmMaxExtensionAboveZonePct: 0.02, confirmMaxExtensionBelowZonePct: 0.02 } },
    { name: "delta strict", o: { deltaStrict: true } },
    { name: "wick + retest", o: { zoneInvalidationUseWick: true, requirePullbackRetestZone: true } },
    { name: "retest + pull0.25R", o: { requirePullbackRetestZone: true, minPullbackRiskFrac: 0.25 } },
    { name: "retest + pull0.35R", o: { requirePullbackRetestZone: true, minPullbackRiskFrac: 0.35 } },
    { name: "retest + chase1.5%", o: { requirePullbackRetestZone: true, confirmMaxExtensionAboveZonePct: 0.015, confirmMaxExtensionBelowZonePct: 0.015 } },
    { name: "retest + pull0.25 + chase1.5%", o: { requirePullbackRetestZone: true, minPullbackRiskFrac: 0.25, confirmMaxExtensionAboveZonePct: 0.015, confirmMaxExtensionBelowZonePct: 0.015 } },
    { name: "wick + retest + pull0.25", o: { zoneInvalidationUseWick: true, requirePullbackRetestZone: true, minPullbackRiskFrac: 0.25 } },
    { name: "minBars4", o: { minBarsAfterArm: 4 } },
    { name: "minBars5", o: { minBarsAfterArm: 5 } },
    { name: "minBars4 + retest", o: { minBarsAfterArm: 4, requirePullbackRetestZone: true } },
    { name: "setupExpiry 18", o: { setupExpiryBars: 18 } },
    { name: "setupExpiry 32", o: { setupExpiryBars: 32 } },
    { name: "maxMitig 0", o: { maxZoneMitigations: 0 } },
    { name: "ltfConfirm 1.4x", o: { ltfConfirmVolMult: 1.4 } },
    { name: "ltfConfirm 1.35x", o: { ltfConfirmVolMult: 1.35 } },
  ];

  console.log(`\nGate NET > ${GATE_NET}R\n`);
  console.log("Variant                              | Lệnh | NET R    | Δ gate   | WR");
  console.log("-".repeat(78));

  let best = { name: "", net: -Infinity, trades: 0, wr: 0 };

  for (const v of variants) {
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, v.o);
    const trades = runBacktest("btcusdt", ltf);
    const net = netR(trades);
    const wr = trades.length ? trades.filter((t) => t.netR > 0).length / trades.length : 0;
    const mark = net > GATE_NET + 1e-9 ? "✓" : " ";
    console.log(
      `${v.name.padEnd(36)} | ${String(trades.length).padStart(4)} | ${(net >= 0 ? "+" : "") + net.toFixed(2).padStart(7)}R | ${(net - GATE_NET >= 0 ? "+" : "") + (net - GATE_NET).toFixed(2).padStart(6)}R ${mark} | ${(wr * 100).toFixed(0)}%`,
    );
    if (net > best.net) best = { name: v.name, net, trades: trades.length, wr };
  }

  Object.assign(CONFIG, saved);

  console.log("-".repeat(78));
  console.log(`Tốt nhất: "${best.name}" → ${best.net.toFixed(2)}R (${best.trades} lệnh, WR ${(best.wr * 100).toFixed(0)}%)`);
  if (best.net > GATE_NET) {
    const winner = variants.find((v) => v.name === best.name)!;
    console.log("\nPASS gate — đề xuất bật CONFIG:");
    console.log(JSON.stringify(winner.o, null, 2));
  } else {
    console.log(`\nFAIL gate — giữ baseline (${GATE_NET}R), không đổi mặc định.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
