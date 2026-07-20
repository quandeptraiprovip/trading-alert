/**
 * volume-sweep.ts — A/B các bộ lọc VOLUME / delta trên rổ CONFIG.symbols. Không ghi đè strategy.ts.
 *
 * Fetch data MỘT LẦN/symbol rồi chạy lại runBacktest với từng override. So tổng NET R (basket)
 * với biến thể "baseline" (động, không hard-code) để biết đổi tham số volume có cải thiện không.
 *
 * Run: npx ts-node scripts/volume-sweep.ts [soNgay] [symbols]
 *   vd: npx ts-node scripts/volume-sweep.ts 250
 *       npx ts-node scripts/volume-sweep.ts 500 btcusdt,solusdt
 */
import "../load-env";
import { Candle, CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest, Trade } from "../backtest";

type Overrides = Partial<typeof CONFIG>;

const VARIANTS: { name: string; o: Overrides }[] = [
  { name: "baseline", o: {} },
  { name: "RVOL theo giờ", o: { useTimeOfDayRVOL: true } },
  { name: "delta 0.58", o: { deltaBuyMin: 0.58 } },
  { name: "delta 0.52", o: { deltaBuyMin: 0.52 } },
  { name: "confirm vol 1.5x", o: { ltfConfirmVolMult: 1.5 } },
  { name: "confirm vol 1.2x", o: { ltfConfirmVolMult: 1.2 } },
  { name: "zone spike 2.5x", o: { volSpikeMult: 2.5 } },
  { name: "zone spike 1.8x", o: { volSpikeMult: 1.8 } },
  { name: "CLV confirm ≥0.55", o: { confirmCloseLocationMin: 0.55 } },
  { name: "CLV confirm ≥0.65", o: { confirmCloseLocationMin: 0.65 } },
  { name: "chặn vol cao body nhỏ", o: { confirmRejectHighVolLowBody: true } },
  {
    name: "RVOL + CLV0.55 + delta0.58",
    o: { useTimeOfDayRVOL: true, confirmCloseLocationMin: 0.55, deltaBuyMin: 0.58 },
  },
];

function netOf(trades: Trade[]): number {
  return trades.reduce((s, t) => s + t.netR, 0);
}

async function main() {
  const days = parseInt(process.argv[2] ?? "250", 10);
  const symbols = (process.argv[3] ? process.argv[3].split(",") : CONFIG.symbols).map((s) => s.trim().toLowerCase());
  const totalBars = Math.ceil(days * (TF_MS["1d"] / TF_MS[CONFIG.entryTf])) + 400;

  console.log(`Tải ~${days} ngày × ${symbols.length} symbol...\n`);
  const dataBySymbol = new Map<string, Candle[]>();
  for (const sym of symbols) {
    const ltf = await fetchKlinesPaged(sym, CONFIG.entryTf, totalBars);
    if (ltf.length < 500) { console.log(`[${sym}] thiếu data, bỏ.`); continue; }
    dataBySymbol.set(sym, ltf);
  }
  console.log();

  const saved = { ...CONFIG }; // các variant chỉ đổi field top-level → shallow copy đủ để khôi phục
  const syms = [...dataBySymbol.keys()];
  const results: { name: string; net: number; trades: number }[] = [];

  for (const v of VARIANTS) {
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, v.o);
    let net = 0;
    let n = 0;
    for (const sym of syms) {
      const trades = runBacktest(sym, dataBySymbol.get(sym)!);
      net += netOf(trades);
      n += trades.length;
    }
    results.push({ name: v.name, net, trades: n });
  }
  Object.assign(CONFIG, saved); // khôi phục default

  const base = results[0].net;
  console.log("=".repeat(74));
  console.log(`  A/B VOLUME / DELTA — ${days} ngày — ${syms.map((s) => s.toUpperCase()).join(", ")}`);
  console.log("=".repeat(74));
  console.log(`${"Variant".padEnd(28)} ${"Lệnh".padStart(5)} ${"NET R".padStart(10)} ${"Δ vs base".padStart(11)}`);
  console.log("-".repeat(74));
  for (const r of results) {
    const d = r.net - base;
    const mark = r.name === "baseline" ? "" : d > 0.01 ? "  ✅ TỐT HƠN" : d < -0.01 ? "  ❌" : "  ≈";
    console.log(
      `${r.name.padEnd(28)} ${String(r.trades).padStart(5)} ${((r.net >= 0 ? "+" : "") + r.net.toFixed(2)) + "R"}`.padEnd(46) +
      `${(d >= 0 ? "+" : "") + d.toFixed(2)}R`.padStart(11) + mark
    );
  }
  console.log("-".repeat(74));

  const winners = results.slice(1).filter((r) => r.net > base + 0.01).sort((a, b) => b.net - a.net);
  console.log(
    winners.length
      ? `👉 Vượt baseline (${base.toFixed(2)}R): ${winners.map((w) => `${w.name} (+${(w.net - base).toFixed(2)}R)`).join(", ")}`
      : `👉 KHÔNG variant nào vượt baseline (${base.toFixed(2)}R) → giữ nguyên cấu hình volume.`
  );
  console.log();
}

main().catch((e) => {
  console.error("Lỗi:", e?.response?.data ?? e.message);
  process.exit(1);
});
