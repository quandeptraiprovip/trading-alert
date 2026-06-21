/**
 * Sweep điểm yếu #5 — gate NET > 21.62R (250d BTC, baseline hiện tại).
 */
import "../load-env";
import { CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";

const GATE = 21.62;
const DAYS = 250;

type Variant = { name: string; o: Partial<typeof CONFIG> };

async function main() {
  const totalBars = Math.ceil(DAYS * (TF_MS["1d"] / TF_MS[CONFIG.entryTf])) + 400;
  console.log("Tải nến…");
  const ltf = await fetchKlinesPaged("btcusdt", CONFIG.entryTf, totalBars);
  const saved = { ...CONFIG };

  const variants: Variant[] = [
    { name: "baseline", o: {} },
    { name: "trailStart 1.75R", o: { trailStartR: 1.75 } },
    { name: "trailStart 2.0R", o: { trailStartR: 2.0 } },
    { name: "trailStart 2.25R", o: { trailStartR: 2.25 } },
    { name: "trailStart 2.5R", o: { trailStartR: 2.5 } },
    { name: "trail 2 + pull0.28", o: { trailStartR: 2.0, minPullbackRiskFrac: 0.28 } },
    { name: "origin age 168", o: { maxZoneOriginAgeBars: 168 } },
    { name: "origin168 + trail2", o: { maxZoneOriginAgeBars: 168, trailStartR: 2.0 } },
    { name: "setupExpiry 20", o: { setupExpiryBars: 20 } },
    { name: "setupExpiry 18", o: { setupExpiryBars: 18 } },
    { name: "pullback 0.28R", o: { minPullbackRiskFrac: 0.28 } },
    { name: "pullback 0.26R", o: { minPullbackRiskFrac: 0.26 } },
    { name: "minBars 4", o: { minBarsAfterArm: 4 } },
    { name: "retest zone", o: { requirePullbackRetestZone: true } },
    { name: "wick invalidation", o: { zoneInvalidationUseWick: true } },
    { name: "delta 0.542", o: { deltaBuyMin: 0.542 } },
    { name: "delta 0.548", o: { deltaBuyMin: 0.548 } },
    { name: "ltfConfirm 1.32", o: { ltfConfirmVolMult: 1.32 } },
    { name: "ltfConfirm 1.38", o: { ltfConfirmVolMult: 1.38 } },
    { name: "volSpike 2.1", o: { volSpikeMult: 2.1 } },
    { name: "maxMitig 0", o: { maxZoneMitigations: 0 } },
    { name: "minEntryRR 1.05", o: { minEntryRR: 1.05 } },
    { name: "CLV 0.48", o: { confirmCloseLocationMin: 0.48 } },
    { name: "chase 1.5%", o: { confirmMaxExtensionAboveZonePct: 0.015, confirmMaxExtensionBelowZonePct: 0.015 } },
    { name: "targetRR 3.0", o: { targetRR: 3.0 } },
    { name: "maxHold 6.75d", o: { maxHoldBars: Math.round(96 * 6.75) } },
    { name: "maxHold 7.25d", o: { maxHoldBars: Math.round(96 * 7.25) } },
    { name: "cooldown 40", o: { cooldownBars: 40 } },
    { name: "cooldown 56", o: { cooldownBars: 56 } },
    { name: "trail2 + origin168", o: { trailStartR: 2.0, maxZoneOriginAgeBars: 168 } },
    { name: "trail2 + setupExp20", o: { trailStartR: 2.0, setupExpiryBars: 20 } },
  ];

  console.log(`\nGate NET > ${GATE}R\n`);
  console.log("Variant                              | Lệnh | NET R    | Δ gate   | WR");
  console.log("-".repeat(78));

  let best = { name: "", net: -Infinity, trades: 0 };
  const pass: { v: Variant; net: number }[] = [];

  for (const v of variants) {
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, v.o);
    const trades = runBacktest("btcusdt", ltf);
    const net = trades.reduce((s, t) => s + t.netR, 0);
    const wr = trades.length ? trades.filter((t) => t.netR > 0).length / trades.length : 0;
    if (net > GATE + 1e-9) pass.push({ v, net });
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
  console.log(`Pass (${pass.length}):`);
  for (const p of pass.slice(0, 12)) {
    console.log(`  +${(p.net - GATE).toFixed(2)}R  ${p.v.name}  ${JSON.stringify(p.v.o)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
