/**
 * Sweep điểm yếu #7 — gate NET > 24.62R (250d BTC).
 * Trọng tâm: long trong premium (2 SL Mar/May) + các knob exit/entry còn lại.
 */
import "../load-env";
import { CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";

const GATE = 24.62;
const DAYS = 250;

type Variant = { name: string; o: Partial<typeof CONFIG> };

async function main() {
  const totalBars = Math.ceil(DAYS * (TF_MS["1d"] / TF_MS[CONFIG.entryTf])) + 400;
  console.log("Tải nến…");
  const ltf = await fetchKlinesPaged("btcusdt", CONFIG.entryTf, totalBars);
  const saved = { ...CONFIG };

  const variants: Variant[] = [
    { name: "baseline", o: {} },
    { name: "long1h max 0.50", o: { longMaxRangePosition1h: 0.5 } },
    { name: "long1h max 0.52", o: { longMaxRangePosition1h: 0.52 } },
    { name: "long1h max 0.55", o: { longMaxRangePosition1h: 0.55 } },
    { name: "long1h max 0.58", o: { longMaxRangePosition1h: 0.58 } },
    { name: "long1h max 0.60", o: { longMaxRangePosition1h: 0.6 } },
    { name: "long4h max 0.50", o: { longMaxRangePosition4h: 0.5 } },
    { name: "long4h max 0.55", o: { longMaxRangePosition4h: 0.55 } },
    { name: "long4h max 0.60", o: { longMaxRangePosition4h: 0.6 } },
    { name: "long1h0.55 + long4h0.55", o: { longMaxRangePosition1h: 0.55, longMaxRangePosition4h: 0.55 } },
    { name: "long1h0.52 + long4h0.55", o: { longMaxRangePosition1h: 0.52, longMaxRangePosition4h: 0.55 } },
    { name: "long1h0.50 + long4h0.50", o: { longMaxRangePosition1h: 0.5, longMaxRangePosition4h: 0.5 } },
    { name: "lookback1h 24", o: { zoneDiscountLookbackBars: 24, longMaxRangePosition1h: 0.55 } },
    { name: "lookback1h 72", o: { zoneDiscountLookbackBars: 72, longMaxRangePosition1h: 0.55 } },
    { name: "setupExpiry 18", o: { setupExpiryBars: 18 } },
    { name: "setupExpiry 20", o: { setupExpiryBars: 20 } },
    { name: "pullback 0.28", o: { minPullbackRiskFrac: 0.28 } },
    { name: "origin168", o: { maxZoneOriginAgeBars: 168 } },
    { name: "CLV 0.48", o: { confirmCloseLocationMin: 0.48 } },
    { name: "chase 1.5%", o: { confirmMaxExtensionAboveZonePct: 0.015, confirmMaxExtensionBelowZonePct: 0.015 } },
    { name: "delta 0.542", o: { deltaBuyMin: 0.542 } },
    { name: "minEntryRR 1.05", o: { minEntryRR: 1.05 } },
    { name: "maxHold 7.5d", o: { maxHoldBars: Math.round(96 * 7.5) } },
    { name: "trailStart 2.25", o: { trailStartR: 2.25 } },
    { name: "long1h0.55 + pull0.28", o: { longMaxRangePosition1h: 0.55, minPullbackRiskFrac: 0.28 } },
    { name: "long1h0.55 + exp20", o: { longMaxRangePosition1h: 0.55, setupExpiryBars: 20 } },
  ];

  console.log(`\nGate NET > ${GATE}R\n`);
  console.log("Variant                              | Lệnh | NET R    | Δ gate   | WR");
  console.log("-".repeat(78));

  let best = { name: "", net: -Infinity, trades: 0 };
  const pass: { name: string; net: number; o: Partial<typeof CONFIG> }[] = [];

  for (const v of variants) {
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, v.o);
    const trades = runBacktest("btcusdt", ltf);
    const net = trades.reduce((s, t) => s + t.netR, 0);
    const wr = trades.length ? trades.filter((t) => t.netR > 0).length / trades.length : 0;
    if (net > GATE + 1e-9) pass.push({ name: v.name, net, o: v.o });
    if (net > best.net) best = { name: v.name, net, trades: trades.length };
    const mark = net > GATE + 1e-9 ? "✓" : " ";
    console.log(
      `${v.name.padEnd(36)} | ${String(trades.length).padStart(4)} | ${(net >= 0 ? "+" : "") + net.toFixed(2).padStart(7)}R | ${(net - GATE >= 0 ? "+" : "") + (net - GATE).toFixed(2).padStart(6)}R ${mark} | ${(wr * 100).toFixed(0)}%`,
    );
  }

  Object.assign(CONFIG, saved);
  console.log("-".repeat(78));
  console.log(`Best: "${best.name}" → ${best.net.toFixed(2)}R (${best.trades} lệnh)`);
  pass.sort((a, b) => b.net - a.net);
  for (const p of pass) {
    console.log(`  PASS +${(p.net - GATE).toFixed(2)}R  ${p.name}  ${JSON.stringify(p.o)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
