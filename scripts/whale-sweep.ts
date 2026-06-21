/**
 * A/B dấu hiệu whale / MM (spring, sweep, upthrust, delta confirm) — 250d BTC 15m.
 * Chạy: npx ts-node scripts/whale-sweep.ts
 */
import "../load-env";
import { CONFIG, applyEntryTf } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";
import { TF_MS } from "../strategy";

type O = Partial<typeof CONFIG>;

const BASELINE_NET = 15.68;

function whaleDefaults() {
  return {
    entryArmMinSpringWick: CONFIG.entryArmMinSpringWick,
    entryArmMinVolMult: CONFIG.entryArmMinVolMult,
    entryArmRequireDelta: CONFIG.entryArmRequireDelta,
    entryRequireLiquiditySweep: CONFIG.entryRequireLiquiditySweep,
    entryLiquiditySweepPct: CONFIG.entryLiquiditySweepPct,
    entryConfirmMaxTrapWick: CONFIG.entryConfirmMaxTrapWick,
    entryConfirmDeltaMin: CONFIG.entryConfirmDeltaMin,
    entryConfirmCloseLocationMin: CONFIG.entryConfirmCloseLocationMin,
    entryRejectHighVolLowBody: CONFIG.entryRejectHighVolLowBody,
    entryConfirmMinBodyRatio: CONFIG.entryConfirmMinBodyRatio,
    entryConfirmDeltaImproving: CONFIG.entryConfirmDeltaImproving,
  };
}

function restoreWhale(w: ReturnType<typeof whaleDefaults>) {
  Object.assign(CONFIG, w);
}

async function main() {
  applyEntryTf("15m");
  const days = 250;
  const totalBars = Math.ceil(days * (TF_MS["1d"] / TF_MS["15m"])) + 400;
  console.log("Tải nến một lần…");
  const ltf = await fetchKlinesPaged("btcusdt", "15m", totalBars);

  const variants: { name: string; o: O }[] = [
    { name: "baseline", o: {} },
    { name: "spring ARM wick≥0.35", o: { entryArmMinSpringWick: 0.35 } },
    { name: "spring ARM wick≥0.45", o: { entryArmMinSpringWick: 0.45 } },
    { name: "ARM vol ≥1.2x avg", o: { entryArmMinVolMult: 1.2 } },
    { name: "ARM vol ≥1.5x avg", o: { entryArmMinVolMult: 1.5 } },
    { name: "liquidity sweep bắt buộc", o: { entryRequireLiquiditySweep: true } },
    { name: "sweep + spring0.35", o: { entryRequireLiquiditySweep: true, entryArmMinSpringWick: 0.35 } },
    { name: "trap wick confirm ≤0.45", o: { entryConfirmMaxTrapWick: 0.45 } },
    { name: "trap wick confirm ≤0.35", o: { entryConfirmMaxTrapWick: 0.35 } },
    { name: "confirm delta ≥0.58", o: { entryConfirmDeltaMin: 0.58 } },
    { name: "confirm delta ≥0.60", o: { entryConfirmDeltaMin: 0.6 } },
    { name: "CLV0.55 + trap0.45", o: { entryConfirmCloseLocationMin: 0.55, entryConfirmMaxTrapWick: 0.45 } },
    { name: "ARM delta bắt buộc", o: { entryArmRequireDelta: true } },
    { name: "BOS body ≥0.40", o: { entryConfirmMinBodyRatio: 0.4 } },
    { name: "BOS body ≥0.50", o: { entryConfirmMinBodyRatio: 0.5 } },
    { name: "delta momentum confirm", o: { entryConfirmDeltaImproving: true } },
    { name: "chặn vol cao body nhỏ", o: { entryRejectHighVolLowBody: true } },
    { name: "spring0.30 + ARM delta", o: { entryArmMinSpringWick: 0.3, entryArmRequireDelta: true } },
    { name: "trap0.50 + CLV0.55", o: { entryConfirmMaxTrapWick: 0.5, entryConfirmCloseLocationMin: 0.55 } },
    { name: "sweep + delta momentum", o: { entryRequireLiquiditySweep: true, entryConfirmDeltaImproving: true } },
    {
      name: "sweep+spring0.35+trap0.45",
      o: {
        entryRequireLiquiditySweep: true,
        entryArmMinSpringWick: 0.35,
        entryConfirmMaxTrapWick: 0.45,
      },
    },
    {
      name: "full whale stack",
      o: {
        entryRequireLiquiditySweep: true,
        entryArmMinSpringWick: 0.35,
        entryArmMinVolMult: 1.2,
        entryConfirmMaxTrapWick: 0.45,
        entryConfirmCloseLocationMin: 0.55,
        entryConfirmDeltaMin: 0.58,
      },
    },
  ];

  const saved = { ...CONFIG };
  const whale0 = whaleDefaults();

  console.log("\nWhale / MM proxy variants     | Lệnh | NET R    | vs 15.68R");
  console.log("-".repeat(68));

  let best = { name: "baseline", net: -Infinity };

  for (const v of variants) {
    Object.assign(CONFIG, saved);
    restoreWhale(whale0);
    Object.assign(CONFIG, v.o);

    const trades = runBacktest("btcusdt", ltf);
    const net = trades.reduce((s, t) => s + t.netR, 0);
    if (net > best.net) best = { name: v.name, net };
    const mark = net >= BASELINE_NET - 1e-9 ? "✓" : " ";
    console.log(
      `${v.name.padEnd(28)} | ${String(trades.length).padStart(4)} | ${(net >= 0 ? "+" : "") + net.toFixed(2).padStart(7)}R | ${(net - BASELINE_NET >= 0 ? "+" : "") + (net - BASELINE_NET).toFixed(2)}R ${mark}`,
    );
  }

  Object.assign(CONFIG, saved);
  restoreWhale(whale0);

  console.log("-".repeat(68));
  console.log(`Tốt nhất: ${best.name} → ${best.net.toFixed(2)}R`);
  if (best.net <= BASELINE_NET + 1e-9) {
    console.log("→ Giữ CONFIG mặc định (không bật whale filter).");
  } else {
    console.log(`→ Có thể bật: ${best.name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
