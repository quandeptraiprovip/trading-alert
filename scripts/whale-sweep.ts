/**
 * whale-sweep.ts — A/B các TỔ HỢP xác nhận "whale / MM" trên rổ CONFIG.symbols.
 *
 * LƯU Ý: bản cũ của file này bám vào một API CONFIG đã bị GỠ khi refactor (applyEntryTf,
 * entryArmMinSpringWick, entryArmMinVolMult, entryArmRequireDelta, entryLiquiditySweepPct,
 * entryConfirmMaxTrapWick, entryConfirmDeltaMin, entryConfirmMinBodyRatio, entryConfirmDeltaImproving)
 * → không còn tồn tại nên KHÔNG test được nữa. File này chỉ giữ các tín hiệu MM mà strategy hiện
 * hỗ trợ và tập trung vào TỔ HỢP (stack nhiều xác nhận) — thứ mà confirm-quality-gate / liquidity-soft
 * test riêng lẻ. Không ghi đè strategy.ts.
 *
 * Tín hiệu dùng: requireLiquiditySweep (hard-gate sweep siết), sweepAsConfirm (SOFT), confirmCloseLocationMin
 * (CLV), confirmRequireWickRejection (wick từ chối), confirmRejectHighVolLowBody (loại trap body nhỏ), deltaBuyMin.
 *
 * Run: npx ts-node scripts/whale-sweep.ts [soNgay] [symbols]
 */
import "../load-env";
import { Candle, CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest, Trade } from "../backtest";

type Overrides = Partial<typeof CONFIG>;

const VARIANTS: { name: string; o: Overrides }[] = [
  { name: "baseline", o: {} },
  { name: "sweep hard-gate", o: { requireLiquiditySweep: true } },
  { name: "SOFT sweep=confirm", o: { sweepAsConfirm: true } },
  { name: "wick rejection", o: { confirmRequireWickRejection: true } },
  { name: "CLV0.55 + delta0.58", o: { confirmCloseLocationMin: 0.55, deltaBuyMin: 0.58 } },
  { name: "reject trap body", o: { confirmRejectHighVolLowBody: true } },
  { name: "sweep + wick", o: { requireLiquiditySweep: true, confirmRequireWickRejection: true } },
  {
    name: "MM stack (sweep+CLV+delta)",
    o: { requireLiquiditySweep: true, confirmCloseLocationMin: 0.55, deltaBuyMin: 0.58 },
  },
  {
    name: "SOFT MM stack (soft+wick+CLV)",
    o: { sweepAsConfirm: true, confirmRequireWickRejection: true, confirmCloseLocationMin: 0.55 },
  },
];

const netOf = (t: Trade[]): number => t.reduce((s, x) => s + x.netR, 0);
const winOf = (t: Trade[]): number => (t.length ? t.filter((x) => x.netR > 0).length / t.length : 0);

async function main() {
  const days = parseInt(process.argv[2] ?? "250", 10);
  const symbols = (process.argv[3] ? process.argv[3].split(",") : CONFIG.symbols).map((s) => s.trim().toLowerCase());
  const totalBars = Math.ceil(days * (TF_MS["1d"] / TF_MS[CONFIG.entryTf])) + 400;

  console.log(`Tải ~${days} ngày × ${symbols.length} symbol...\n`);
  const data = new Map<string, Candle[]>();
  for (const sym of symbols) {
    const ltf = await fetchKlinesPaged(sym, CONFIG.entryTf, totalBars);
    if (ltf.length < 500) { console.log(`[${sym}] thiếu data, bỏ.`); continue; }
    data.set(sym, ltf);
  }
  console.log();

  const saved = { ...CONFIG };
  const syms = [...data.keys()];
  const results: { name: string; net: number; trades: number; win: number }[] = [];

  for (const v of VARIANTS) {
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, v.o);
    let all: Trade[] = [];
    for (const sym of syms) all = all.concat(runBacktest(sym, data.get(sym)!));
    results.push({ name: v.name, net: netOf(all), trades: all.length, win: winOf(all) });
  }
  Object.assign(CONFIG, saved);

  const base = results[0].net;
  console.log("=".repeat(74));
  console.log(`  TỔ HỢP XÁC NHẬN WHALE / MM — ${days} ngày — ${syms.map((s) => s.toUpperCase()).join(", ")}`);
  console.log("=".repeat(74));
  console.log(`${"Variant".padEnd(30)} ${"Lệnh".padStart(5)} ${"WR".padStart(5)} ${"NET R".padStart(9)} ${"Δ base".padStart(9)}`);
  console.log("-".repeat(74));
  for (const r of results) {
    const d = r.net - base;
    const mark = r.name === "baseline" ? "" : d > 0.01 ? "  ✅" : d < -0.01 ? "  ❌" : "  ≈";
    console.log(
      `${r.name.padEnd(30)} ${String(r.trades).padStart(5)} ${(r.win * 100).toFixed(0).padStart(4)}% ${((r.net >= 0 ? "+" : "") + r.net.toFixed(2)).padStart(8)}R ${((d >= 0 ? "+" : "") + d.toFixed(2)).padStart(8)}R${mark}`
    );
  }
  console.log("-".repeat(74));

  const winners = results.slice(1).filter((r) => r.net > base + 0.01).sort((a, b) => b.net - a.net);
  console.log(
    winners.length
      ? `👉 Vượt baseline (${base.toFixed(2)}R): ${winners.map((w) => `${w.name} (+${(w.net - base).toFixed(2)}R)`).join(", ")}`
      : `👉 KHÔNG tổ hợp nào vượt baseline (${base.toFixed(2)}R).`
  );
  console.log();
}

main().catch((e) => {
  console.error("Lỗi:", e?.response?.data ?? e.message);
  process.exit(1);
});
