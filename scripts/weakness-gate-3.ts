/**
 * Sweep điểm yếu #3 — discount/premium 1h, minRR, zone origin age, exit tune.
 * Gate: NET > 17.37R (250d BTC).
 */
import "../load-env";
import { CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";

const GATE_NET = 17.37;
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
    { name: "baseline hiện tại", o: {} },
    { name: "discount/premium 1h", o: { useDiscountPremiumFilter: true } },
    { name: "disc/prem lookback 24h", o: { useDiscountPremiumFilter: true, zoneDiscountLookbackBars: 24 } },
    { name: "disc/prem lookback 72h", o: { useDiscountPremiumFilter: true, zoneDiscountLookbackBars: 72 } },
    { name: "disc/prem lookback 96h", o: { useDiscountPremiumFilter: true, zoneDiscountLookbackBars: 96 } },
    { name: "minEntryRR 1.05", o: { minEntryRR: 1.05 } },
    { name: "minEntryRR 1.1", o: { minEntryRR: 1.1 } },
    { name: "minEntryRR 1.15", o: { minEntryRR: 1.15 } },
    { name: "minEntryRR 1.2", o: { minEntryRR: 1.2 } },
    { name: "disc/prem + minRR1.1", o: { useDiscountPremiumFilter: true, minEntryRR: 1.1 } },
    { name: "disc/prem + minRR1.05", o: { useDiscountPremiumFilter: true, minEntryRR: 1.05 } },
    { name: "origin age 120", o: { maxZoneOriginAgeBars: 120 } },
    { name: "origin age 168", o: { maxZoneOriginAgeBars: 168 } },
    { name: "origin age 200", o: { maxZoneOriginAgeBars: 200 } },
    { name: "maxMitig 0", o: { maxZoneMitigations: 0 } },
    { name: "CLV confirm 0.48", o: { confirmCloseLocationMin: 0.48 } },
    { name: "CLV confirm 0.50", o: { confirmCloseLocationMin: 0.5 } },
    { name: "delta 0.56", o: { deltaBuyMin: 0.56 } },
    { name: "delta 0.54", o: { deltaBuyMin: 0.54 } },
    { name: "volSpike 2.2", o: { volSpikeMult: 2.2 } },
    { name: "volSpike 2.3", o: { volSpikeMult: 2.3 } },
    { name: "ltfConfirm 1.35", o: { ltfConfirmVolMult: 1.35 } },
    { name: "ltfConfirm 1.4", o: { ltfConfirmVolMult: 1.4 } },
    { name: "trailStart 1.25R", o: { trailStartR: 1.25 } },
    { name: "trailStart 1.75R", o: { trailStartR: 1.75 } },
    { name: "trailStart 2.0R", o: { trailStartR: 2.0 } },
    { name: "targetRR 2.0", o: { targetRR: 2.0 } },
    { name: "targetRR 3.0", o: { targetRR: 3.0 } },
    { name: "cooldown 36", o: { cooldownBars: 36 } },
    { name: "cooldown 60", o: { cooldownBars: 60 } },
    { name: "pull0.25 + disc/prem", o: { useDiscountPremiumFilter: true } },
    { name: "pull0.28", o: { minPullbackRiskFrac: 0.28 } },
    { name: "pull0.22", o: { minPullbackRiskFrac: 0.22 } },
    { name: "minBars 4", o: { minBarsAfterArm: 4 } },
    { name: "retest zone", o: { requirePullbackRetestZone: true } },
    { name: "RVOL time-of-day", o: { useTimeOfDayRVOL: true } },
  ];

  console.log(`\nGate NET > ${GATE_NET}R\n`);
  console.log("Variant                              | Lệnh | NET R    | Δ gate   | WR");
  console.log("-".repeat(78));

  const passed: Variant[] = [];
  let best = { name: "", net: -Infinity, trades: 0, wr: 0 };

  for (const v of variants) {
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, v.o);
    const trades = runBacktest("btcusdt", ltf);
    const net = netR(trades);
    const wr = trades.length ? trades.filter((t) => t.netR > 0).length / trades.length : 0;
    const mark = net > GATE_NET + 1e-9 ? "✓" : " ";
    if (net > GATE_NET + 1e-9) passed.push(v);
    console.log(
      `${v.name.padEnd(36)} | ${String(trades.length).padStart(4)} | ${(net >= 0 ? "+" : "") + net.toFixed(2).padStart(7)}R | ${(net - GATE_NET >= 0 ? "+" : "") + (net - GATE_NET).toFixed(2).padStart(6)}R ${mark} | ${(wr * 100).toFixed(0)}%`,
    );
    if (net > best.net) best = { name: v.name, net, trades: trades.length, wr };
  }

  Object.assign(CONFIG, saved);

  console.log("-".repeat(78));
  console.log(`Tốt nhất: "${best.name}" → ${best.net.toFixed(2)}R (${best.trades} lệnh, WR ${(best.wr * 100).toFixed(0)}%)`);
  console.log(`Variant vượt gate: ${passed.length}`);
  for (const p of passed.sort((a, b) => netR(runBacktest("btcusdt", ltf)) - netR(runBacktest("btcusdt", ltf)))) {
    // skip broken sort
  }
  if (best.net > GATE_NET) {
    const w = variants.find((v) => v.name === best.name)!;
    console.log("\nĐề xuất CONFIG (best overall):");
    console.log(JSON.stringify(w.o, null, 2));
  }
  if (passed.length) {
    console.log("\nTất cả PASS:");
    for (const p of passed) {
      Object.assign(CONFIG, saved);
      Object.assign(CONFIG, p.o);
      const net = netR(runBacktest("btcusdt", ltf));
      console.log(`  ${p.name.padEnd(32)} ${net.toFixed(2)}R  ${JSON.stringify(p.o)}`);
    }
    Object.assign(CONFIG, saved);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
