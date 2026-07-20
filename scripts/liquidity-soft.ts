/**
 * liquidity-soft.ts — Re-test hướng "quét thanh khoản" với logic sweep+reclaim ĐÃ SIẾT.
 *
 * Khác liquidity-experiments.ts (chỉ test hard-gate lỏng cũ), file này so:
 *   - baseline (BOS)         : confirm bằng BOS phá swing 15m (mặc định hiện tại).
 *   - hard-gate sweep (siết) : requireLiquiditySweep — phải có sweep+reclaim TƯƠI trước khi ARM,
 *                              CHỒNG lên BOS (double-strict). Dùng sweptAndReclaimed đã siết.
 *   - SOFT sweep=confirm     : sweepAsConfirm — sweep+reclaim THAY BOS làm tín hiệu confirm
 *                              (không chồng gate) — đúng gợi ý "thử dạng SOFT".
 *
 * Tiêu chí quyết định: tổng NET R (basket) phải > baseline. Không đổi default strategy.ts.
 * Run: npx ts-node scripts/liquidity-soft.ts [soNgay] [symbols]
 */
import "../load-env";
import { Candle, CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest, Trade } from "../backtest";

type Overrides = Partial<typeof CONFIG>;

const VARIANTS: { name: string; o: Overrides }[] = [
  { name: "baseline (BOS)", o: {} },
  { name: "hard-gate sweep (siết)", o: { requireLiquiditySweep: true } },
  { name: "SOFT sweep=confirm", o: { sweepAsConfirm: true } },
  { name: "SOFT within=1 (chặt)", o: { sweepAsConfirm: true, sweepReclaimWithin: 1 } },
  { name: "SOFT within=4 (lỏng)", o: { sweepAsConfirm: true, sweepReclaimWithin: 4 } },
  { name: "SOFT + disc/prem", o: { sweepAsConfirm: true, requireDiscountPremium: true } },
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

  const saved = { ...CONFIG }; // các variant chỉ đổi field top-level → shallow copy đủ
  const syms = [...data.keys()];
  const results: { name: string; net: number; trades: number; win: number; perSym: Record<string, string> }[] = [];

  for (const v of VARIANTS) {
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, v.o);
    let all: Trade[] = [];
    const perSym: Record<string, string> = {};
    for (const sym of syms) {
      const tr = runBacktest(sym, data.get(sym)!);
      perSym[sym] = `${netOf(tr) >= 0 ? "+" : ""}${netOf(tr).toFixed(1)}R(${tr.length})`;
      all = all.concat(tr);
    }
    results.push({ name: v.name, net: netOf(all), trades: all.length, win: winOf(all), perSym });
  }
  Object.assign(CONFIG, saved); // khôi phục default

  const base = results[0].net;
  console.log("=".repeat(80));
  console.log(`  RE-TEST THANH KHOẢN (sweep ĐÃ SIẾT) — ${days} ngày — ${syms.map((s) => s.toUpperCase()).join(", ")}`);
  console.log("=".repeat(80));
  console.log(`${"Variant".padEnd(24)} ${"Lệnh".padStart(5)} ${"WR".padStart(5)} ${"NET R".padStart(9)} ${"Δ base".padStart(9)}`);
  console.log("-".repeat(80));
  for (const r of results) {
    const d = r.net - base;
    const mark = r.name === results[0].name ? "" : d > 0.01 ? "  ✅ TỐT HƠN" : d < -0.01 ? "  ❌" : "  ≈";
    console.log(
      `${r.name.padEnd(24)} ${String(r.trades).padStart(5)} ${(r.win * 100).toFixed(0).padStart(4)}% ${((r.net >= 0 ? "+" : "") + r.net.toFixed(2)).padStart(8)}R ${((d >= 0 ? "+" : "") + d.toFixed(2)).padStart(8)}R${mark}`
    );
  }
  console.log("-".repeat(80));
  console.log("\nPER-SYMBOL NET R (lệnh):");
  console.log(`${"Variant".padEnd(24)} ` + syms.map((s) => s.toUpperCase().padStart(14)).join(""));
  for (const r of results) {
    console.log(`${r.name.padEnd(24)} ` + syms.map((s) => (r.perSym[s] ?? "-").padStart(14)).join(""));
  }
  console.log();

  const winners = results.slice(1).filter((r) => r.net > base + 0.01).sort((a, b) => b.net - a.net);
  console.log(
    winners.length
      ? `👉 Vượt baseline (${base.toFixed(2)}R): ${winners.map((w) => `${w.name} (+${(w.net - base).toFixed(2)}R)`).join(", ")}`
      : `👉 KHÔNG variant sweep nào vượt baseline (${base.toFixed(2)}R) → xác nhận giữ nguyên baseline.`
  );
  console.log();
}

main().catch((e) => {
  console.error("Lỗi:", e?.response?.data ?? e.message);
  process.exit(1);
});
