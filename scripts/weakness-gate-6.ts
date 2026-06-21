/**
 * Sweep điểm yếu #6 — gate NET > 23.55R (250d BTC).
 */
import "../load-env";
import { CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";

const GATE = 23.55;
const DAYS = 250;

type Variant = { name: string; o: Partial<typeof CONFIG> };

async function main() {
  const totalBars = Math.ceil(DAYS * (TF_MS["1d"] / TF_MS[CONFIG.entryTf])) + 400;
  console.log("Tải nến…");
  const ltf = await fetchKlinesPaged("btcusdt", CONFIG.entryTf, totalBars);
  const saved = { ...CONFIG };

  const variants: Variant[] = [
    { name: "baseline", o: {} },
    { name: "setupExpiry 20", o: { setupExpiryBars: 20 } },
    { name: "setupExpiry 22", o: { setupExpiryBars: 22 } },
    { name: "origin age 168", o: { maxZoneOriginAgeBars: 168 } },
    { name: "origin age 200", o: { maxZoneOriginAgeBars: 200 } },
    { name: "pullback 0.28", o: { minPullbackRiskFrac: 0.28 } },
    { name: "pullback 0.30", o: { minPullbackRiskFrac: 0.3 } },
    { name: "minBars 4", o: { minBarsAfterArm: 4 } },
    { name: "retest zone", o: { requirePullbackRetestZone: true } },
    { name: "wick invalidation", o: { zoneInvalidationUseWick: true } },
    { name: "CLV 0.48", o: { confirmCloseLocationMin: 0.48 } },
    { name: "CLV 0.50", o: { confirmCloseLocationMin: 0.5 } },
    { name: "wick confirm", o: { confirmRequireWickRejection: true } },
    { name: "trap body", o: { confirmRejectHighVolLowBody: true } },
    { name: "minEntryRR 1.05", o: { minEntryRR: 1.05 } },
    { name: "minEntryRR 1.1", o: { minEntryRR: 1.1 } },
    { name: "chase 1.5%", o: { confirmMaxExtensionAboveZonePct: 0.015, confirmMaxExtensionBelowZonePct: 0.015 } },
    { name: "disc/prem both", o: { useDiscountPremiumFilter: true } },
    { name: "delta 0.542", o: { deltaBuyMin: 0.542 } },
    { name: "delta 0.548", o: { deltaBuyMin: 0.548 } },
    { name: "ltfConfirm 1.32", o: { ltfConfirmVolMult: 1.32 } },
    { name: "ltfConfirm 1.4", o: { ltfConfirmVolMult: 1.4 } },
    { name: "volSpike 2.1", o: { volSpikeMult: 2.1 } },
    { name: "volSpike 2.2", o: { volSpikeMult: 2.2 } },
    { name: "maxMitig 0", o: { maxZoneMitigations: 0 } },
    { name: "maxHold 7.25d", o: { maxHoldBars: Math.round(96 * 7.25) } },
    { name: "maxHold 7.5d", o: { maxHoldBars: Math.round(96 * 7.5) } },
    { name: "trailStart 2.0", o: { trailStartR: 2.0 } },
    { name: "trailStart 2.25", o: { trailStartR: 2.25 } },
    { name: "targetRR 2.75", o: { targetRR: 2.75 } },
    { name: "slBuffer 0.003", o: { slBufferPct: 0.003 } },
    { name: "slBuffer 0.002", o: { slBufferPct: 0.002 } },
    { name: "setup20+origin168", o: { setupExpiryBars: 20, maxZoneOriginAgeBars: 168 } },
    { name: "setup20+pull0.28", o: { setupExpiryBars: 20, minPullbackRiskFrac: 0.28 } },
    { name: "origin168+pull0.28", o: { maxZoneOriginAgeBars: 168, minPullbackRiskFrac: 0.28 } },
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
