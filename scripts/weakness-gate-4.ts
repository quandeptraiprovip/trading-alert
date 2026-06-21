/**
 * Sweep điểm yếu #4 — gate NET > 19.81R (250d BTC).
 */
import "../load-env";
import { CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";

const GATE = 19.81;
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
    { name: "targetRR 2.75", o: { targetRR: 2.75 } },
    { name: "targetRR 3.0", o: { targetRR: 3.0 } },
    { name: "targetRR 3.5", o: { targetRR: 3.5 } },
    { name: "pullback 0.28R", o: { minPullbackRiskFrac: 0.28 } },
    { name: "pullback 0.30R", o: { minPullbackRiskFrac: 0.3 } },
    { name: "pullback 0.32R", o: { minPullbackRiskFrac: 0.32 } },
    { name: "retest zone", o: { requirePullbackRetestZone: true } },
    { name: "origin age 168", o: { maxZoneOriginAgeBars: 168 } },
    { name: "origin age 192", o: { maxZoneOriginAgeBars: 192 } },
    { name: "maxMitig 0", o: { maxZoneMitigations: 0 } },
    { name: "minBars 4", o: { minBarsAfterArm: 4 } },
    { name: "minBars 2", o: { minBarsAfterArm: 2 } },
    { name: "setupExpiry 20", o: { setupExpiryBars: 20 } },
    { name: "setupExpiry 28", o: { setupExpiryBars: 28 } },
    { name: "ltfConfirm 1.32", o: { ltfConfirmVolMult: 1.32 } },
    { name: "ltfConfirm 1.38", o: { ltfConfirmVolMult: 1.38 } },
    { name: "volSpike 2.1", o: { volSpikeMult: 2.1 } },
    { name: "volSpike 2.15", o: { volSpikeMult: 2.15 } },
    { name: "delta 0.543", o: { deltaBuyMin: 0.543 } },
    { name: "delta 0.547", o: { deltaBuyMin: 0.547 } },
    { name: "minEntryRR 1.05", o: { minEntryRR: 1.05 } },
    { name: "CLV 0.48", o: { confirmCloseLocationMin: 0.48 } },
    { name: "chase 1.5%", o: { confirmMaxExtensionAboveZonePct: 0.015, confirmMaxExtensionBelowZonePct: 0.015 } },
    { name: "disc/prem 1h", o: { useDiscountPremiumFilter: true } },
    { name: "maxHold 5d", o: { maxHoldBars: 96 * 5 } },
    { name: "maxHold 7d", o: { maxHoldBars: 96 * 7 } },
    { name: "cooldown 40", o: { cooldownBars: 40 } },
    { name: "trail2 + target3", o: { trailStartR: 2.0, targetRR: 3.0 } },
    { name: "trail2 + pull0.28", o: { trailStartR: 2.0, minPullbackRiskFrac: 0.28 } },
    { name: "origin168 + trail2", o: { maxZoneOriginAgeBars: 168, trailStartR: 2.0 } },
  ];

  console.log(`\nGate NET > ${GATE}R\n`);
  console.log("Variant                              | Lệnh | NET R    | Δ gate   | WR");
  console.log("-".repeat(78));

  let best = { name: "", net: -Infinity, trades: 0 };
  const pass: Variant[] = [];

  for (const v of variants) {
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, v.o);
    const trades = runBacktest("btcusdt", ltf);
    const net = trades.reduce((s, t) => s + t.netR, 0);
    const wr = trades.length ? trades.filter((t) => t.netR > 0).length / trades.length : 0;
    if (net > GATE + 1e-9) pass.push(v);
    if (net > best.net) best = { name: v.name, net, trades: trades.length };
    const mark = net > GATE + 1e-9 ? "✓" : " ";
    console.log(
      `${v.name.padEnd(36)} | ${String(trades.length).padStart(4)} | ${(net >= 0 ? "+" : "") + net.toFixed(2).padStart(7)}R | ${(net - GATE >= 0 ? "+" : "") + (net - GATE).toFixed(2).padStart(6)}R ${mark} | ${(wr * 100).toFixed(0)}%`,
    );
  }

  Object.assign(CONFIG, saved);
  console.log("-".repeat(78));
  console.log(`Best: ${best.name} → ${best.net.toFixed(2)}R (${best.trades} lệnh)`);
  console.log(`Pass count: ${pass.length}`);
  for (const p of pass.sort((a, b) => {
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, a.o);
    const na = runBacktest("btcusdt", ltf).reduce((s, t) => s + t.netR, 0);
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, b.o);
    const nb = runBacktest("btcusdt", ltf).reduce((s, t) => s + t.netR, 0);
    return nb - na;
  })) {
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, p.o);
    const net = runBacktest("btcusdt", ltf).reduce((s, t) => s + t.netR, 0);
    console.log(`  PASS ${net.toFixed(2)}R  ${p.name}  ${JSON.stringify(p.o)}`);
  }
  Object.assign(CONFIG, saved);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
