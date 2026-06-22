/**
 * liquidity-experiments.ts — So sánh baseline vs các biến thể "thanh khoản"
 *
 * Ý tưởng test (theo lý thuyết liquidity hunt / stop run):
 *   #1 sweep   : chỉ ARM sau khi có cú quét swing 15m + reclaim (requireLiquiditySweep)
 *   #4 disc    : long ở discount / short ở premium của range HTF (requireDiscountPremium)
 *   #2 targetLq: target = pool thanh khoản swing 1h đối diện (targetOppositeLiquidity)
 *
 * Fetch data MỘT LẦN/symbol rồi chạy lại runBacktest với từng cấu hình flag.
 * Chỉ in tổng NET R (basket) + per-symbol để so với baseline. KHÔNG đổi default.
 *
 * Run: npx ts-node scripts/liquidity-experiments.ts [soNgay] [symbols]
 */
import { Candle, CONFIG } from "../strategy";
import { fetchKlinesPaged, runBacktest, Trade } from "../backtest";
import { TF_MS } from "../strategy";

type Flags = Partial<Pick<typeof CONFIG,
  "requireLiquiditySweep" | "requireDiscountPremium" | "targetOppositeLiquidity">>;

const VARIANTS: { name: string; flags: Flags }[] = [
  { name: "baseline", flags: {} },
  { name: "#1 sweep", flags: { requireLiquiditySweep: true } },
  { name: "#4 disc/prem", flags: { requireDiscountPremium: true } },
  { name: "#2 targetLiq", flags: { targetOppositeLiquidity: true } },
  { name: "#1+#4", flags: { requireLiquiditySweep: true, requireDiscountPremium: true } },
  { name: "#1+#2", flags: { requireLiquiditySweep: true, targetOppositeLiquidity: true } },
  { name: "#4+#2", flags: { requireDiscountPremium: true, targetOppositeLiquidity: true } },
  { name: "#1+#4+#2", flags: { requireLiquiditySweep: true, requireDiscountPremium: true, targetOppositeLiquidity: true } },
];

function applyFlags(f: Flags) {
  CONFIG.requireLiquiditySweep = !!f.requireLiquiditySweep;
  CONFIG.requireDiscountPremium = !!f.requireDiscountPremium;
  CONFIG.targetOppositeLiquidity = !!f.targetOppositeLiquidity;
}

function netOf(trades: Trade[]): number {
  return trades.reduce((s, t) => s + t.netR, 0);
}

async function main() {
  const days = parseInt(process.argv[2] ?? "250", 10);
  const symbols = (process.argv[3] ? process.argv[3].split(",") : CONFIG.symbols).map((s) => s.trim().toLowerCase());
  const barsPerDay = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const totalBars = Math.ceil(days * barsPerDay) + 400;

  console.log(`Tải ~${days} ngày × ${symbols.length} symbol...\n`);
  const dataBySymbol = new Map<string, Candle[]>();
  for (const sym of symbols) {
    const ltf = await fetchKlinesPaged(sym, CONFIG.entryTf, totalBars);
    if (ltf.length < 500) { console.log(`[${sym}] thiếu data, bỏ.`); continue; }
    dataBySymbol.set(sym, ltf);
  }
  console.log();

  // Lưu lại default để khôi phục
  const orig: Flags = {
    requireLiquiditySweep: CONFIG.requireLiquiditySweep,
    requireDiscountPremium: CONFIG.requireDiscountPremium,
    targetOppositeLiquidity: CONFIG.targetOppositeLiquidity,
  };

  const syms = [...dataBySymbol.keys()];
  const results: { name: string; net: number; trades: number; perSym: Record<string, number>; perCnt: Record<string, number> }[] = [];

  for (const v of VARIANTS) {
    applyFlags(v.flags);
    let totalNet = 0;
    let totalTrades = 0;
    const perSym: Record<string, number> = {};
    const perCnt: Record<string, number> = {};
    for (const sym of syms) {
      const trades = runBacktest(sym, dataBySymbol.get(sym)!);
      const n = netOf(trades);
      perSym[sym] = n;
      perCnt[sym] = trades.length;
      totalNet += n;
      totalTrades += trades.length;
    }
    results.push({ name: v.name, net: totalNet, trades: totalTrades, perSym, perCnt });
  }
  applyFlags(orig); // khôi phục

  const base = results[0].net;

  console.log("=".repeat(78));
  console.log(`  SO SÁNH BIẾN THỂ THANH KHOẢN — ${days} ngày — ${syms.map((s) => s.toUpperCase()).join(", ")}`);
  console.log("=".repeat(78));
  console.log(`${"Biến thể".padEnd(16)} ${"Lệnh".padStart(5)} ${"NET R".padStart(10)} ${"Δ vs base".padStart(11)}   ${"NET/lệnh".padStart(9)}`);
  console.log("-".repeat(78));
  for (const r of results) {
    const delta = r.net - base;
    const perTrade = r.trades ? r.net / r.trades : 0;
    const mark = r.name === "baseline" ? "" : delta > 0.01 ? "  ✅ TỐT HƠN" : delta < -0.01 ? "  ❌" : "  ≈";
    console.log(
      `${r.name.padEnd(16)} ${String(r.trades).padStart(5)} ${(r.net >= 0 ? "+" : "") + r.net.toFixed(2)}R`.padEnd(34) +
      `${(delta >= 0 ? "+" : "") + delta.toFixed(2)}R`.padStart(11) +
      `   ${(perTrade >= 0 ? "+" : "") + perTrade.toFixed(3)}R`.padStart(9) + mark
    );
  }
  console.log("-".repeat(78));
  console.log("\nPER-SYMBOL NET R (lệnh):");
  console.log(`${"Biến thể".padEnd(16)} ` + syms.map((s) => s.toUpperCase().padStart(13)).join(""));
  for (const r of results) {
    console.log(
      `${r.name.padEnd(16)} ` +
      syms.map((s) => `${(r.perSym[s] >= 0 ? "+" : "") + r.perSym[s].toFixed(1)}R(${r.perCnt[s]})`.padStart(13)).join("")
    );
  }
  console.log();

  const winners = results.slice(1).filter((r) => r.net > base + 0.01).sort((a, b) => b.net - a.net);
  if (winners.length) {
    console.log(`👉 Biến thể vượt baseline (NET ${base.toFixed(2)}R): ` +
      winners.map((w) => `${w.name} (+${(w.net - base).toFixed(2)}R)`).join(", "));
    console.log(`   Tốt nhất: ${winners[0].name} → NET ${winners[0].net.toFixed(2)}R`);
  } else {
    console.log(`👉 KHÔNG biến thể nào vượt baseline (${base.toFixed(2)}R) → giữ nguyên baseline.`);
  }
  console.log();
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
