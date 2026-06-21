/**
 * A/B volume / whale-proxy filters — 250d BTC 15m. Không ghi đè strategy.ts.
 * Chạy: npx ts-node scripts/volume-sweep.ts
 */
import "../load-env";
import { CONFIG, applyEntryTf } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";
import { TF_MS } from "../strategy";

type Overrides = Partial<typeof CONFIG> & {
  entryConfirmCloseLocationMin?: number;
  entryRejectHighVolLowBody?: boolean;
};

const BASELINE_NET = 15.68;

function parseNet(out: string): { net: number; trades: number } {
  const netM = out.match(/NET R\s+:\s+([+-]?[\d.]+)R/);
  const trM = out.match(/Tổng lệnh\s+:\s+(\d+)/);
  return { net: netM ? parseFloat(netM[1]) : NaN, trades: trM ? parseInt(trM[1], 10) : 0 };
}

async function main() {
  applyEntryTf("15m");
  const days = 250;
  const barsPerDay = TF_MS["1d"] / TF_MS["15m"];
  const warmup = Math.ceil(400 * (TF_MS["15m"] / TF_MS["15m"]));
  const totalBars = Math.ceil(days * barsPerDay) + warmup;
  console.log("Tải nến một lần…");
  const ltf = await fetchKlinesPaged("btcusdt", "15m", totalBars);

  const variants: { name: string; o: Overrides }[] = [
    { name: "baseline (hiện tại)", o: {} },
    { name: "RVOL theo giờ", o: { useTimeOfDayRVOL: true } },
    { name: "delta 0.58", o: { deltaBuyMin: 0.58 } },
    { name: "delta 0.52", o: { deltaBuyMin: 0.52 } },
    { name: "confirm vol 1.5x", o: { ltfConfirmVolMult: 1.5 } },
    { name: "confirm vol 1.2x", o: { ltfConfirmVolMult: 1.2 } },
    { name: "zone spike 2.5x", o: { volSpikeMult: 2.5 } },
    { name: "zone spike 1.8x", o: { volSpikeMult: 1.8 } },
    { name: "CLV confirm ≥0.55", o: { entryConfirmCloseLocationMin: 0.55 } },
    { name: "CLV confirm ≥0.65", o: { entryConfirmCloseLocationMin: 0.65 } },
    { name: "chặn vol cao body nhỏ", o: { entryRejectHighVolLowBody: true } },
    {
      name: "RVOL + CLV0.55 + delta0.58",
      o: { useTimeOfDayRVOL: true, entryConfirmCloseLocationMin: 0.55, deltaBuyMin: 0.58 },
    },
  ];

  const saved = { ...CONFIG };
  const extSaved = {
    clv: CONFIG.entryConfirmCloseLocationMin,
    rej: CONFIG.entryRejectHighVolLowBody,
  };

  console.log("\nVariant                          | Lệnh | NET R    | vs baseline");
  console.log("-".repeat(72));

  let best = { name: "", net: -Infinity };

  for (const v of variants) {
    Object.assign(CONFIG, saved);
    CONFIG.entryConfirmCloseLocationMin = extSaved.clv;
    CONFIG.entryRejectHighVolLowBody = extSaved.rej;
    Object.assign(CONFIG, v.o);

    const trades = runBacktest("btcusdt", ltf);
    const net = trades.reduce((s, t) => s + t.netR, 0);
    const delta = net - BASELINE_NET;
    const mark = net >= BASELINE_NET - 1e-9 ? "✓" : " ";
    console.log(
      `${v.name.padEnd(32)} | ${String(trades.length).padStart(4)} | ${(net >= 0 ? "+" : "") + net.toFixed(2).padStart(7)}R | ${(delta >= 0 ? "+" : "") + delta.toFixed(2)}R ${mark}`,
    );
    if (net > best.net) best = { name: v.name, net };
  }

  Object.assign(CONFIG, saved);
  CONFIG.entryConfirmCloseLocationMin = extSaved.clv;
  CONFIG.entryRejectHighVolLowBody = extSaved.rej;

  console.log("-".repeat(72));
  console.log(`Tốt nhất: ${best.name} → ${best.net.toFixed(2)}R (baseline ref ${BASELINE_NET}R)`);
  if (best.net <= BASELINE_NET) {
    console.log("→ Không đổi code mặc định (không variant nào vượt baseline).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
