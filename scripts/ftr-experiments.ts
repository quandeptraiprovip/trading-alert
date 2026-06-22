/**
 * ftr-experiments.ts — Baseline vs biến thể FTR (Kudakwashe — Failure to Return)
 *
 *   disp        : chỉ giữ vùng có cú rời impulsive (requireDisplacement, mult 1.0)
 *   disp1.5     : displacement mạnh hơn (mult 1.5)
 *   FTB strict  : chỉ vào lần hồi ĐẦU (maxZoneMitigations = 0) — "failure to return" thuần
 *   disp+FTB    : kết hợp
 *
 * Fetch MỘT LẦN/symbol, chạy lại runBacktest theo từng cấu hình. Chỉ in NET, không đổi default.
 * Run: npx ts-node scripts/ftr-experiments.ts [soNgay] [symbols]
 */
import { Candle, CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest, Trade } from "../backtest";

type Cfg = {
  requireDisplacement: boolean;
  displacementMult: number;
  displacementWindow: number;
  maxZoneMitigations: number;
};

const VARIANTS: { name: string; cfg: Partial<Cfg> }[] = [
  { name: "baseline", cfg: {} },
  { name: "disp×1 ATR", cfg: { requireDisplacement: true, displacementMult: 1.0 } },
  { name: "disp×2 ATR", cfg: { requireDisplacement: true, displacementMult: 2.0 } },
  { name: "disp×3 ATR", cfg: { requireDisplacement: true, displacementMult: 3.0 } },
  { name: "disp×2 w5", cfg: { requireDisplacement: true, displacementMult: 2.0, displacementWindow: 5 } },
  { name: "FTB strict", cfg: { maxZoneMitigations: 0 } },
  { name: "disp×2+FTB", cfg: { requireDisplacement: true, displacementMult: 2.0, maxZoneMitigations: 0 } },
];

function apply(c: Partial<Cfg>) {
  CONFIG.requireDisplacement = c.requireDisplacement ?? false;
  CONFIG.displacementMult = c.displacementMult ?? 1.0;
  CONFIG.displacementWindow = c.displacementWindow ?? 3;
  CONFIG.maxZoneMitigations = c.maxZoneMitigations ?? 1;
}

const net = (ts: Trade[]) => ts.reduce((s, t) => s + t.netR, 0);

async function main() {
  const days = parseInt(process.argv[2] ?? "250", 10);
  const symbols = (process.argv[3] ? process.argv[3].split(",") : CONFIG.symbols).map((s) => s.trim().toLowerCase());
  const totalBars = Math.ceil((days * TF_MS["1d"]) / TF_MS[CONFIG.entryTf]) + 400;

  console.log(`Tải ~${days} ngày × ${symbols.length} symbol...\n`);
  const data = new Map<string, Candle[]>();
  for (const sym of symbols) {
    const ltf = await fetchKlinesPaged(sym, CONFIG.entryTf, totalBars);
    if (ltf.length >= 500) data.set(sym, ltf);
  }
  const syms = [...data.keys()];
  console.log();

  // backup default
  const orig: Partial<Cfg> = {
    requireDisplacement: CONFIG.requireDisplacement,
    displacementMult: CONFIG.displacementMult,
    displacementWindow: CONFIG.displacementWindow,
    maxZoneMitigations: CONFIG.maxZoneMitigations,
  };

  const rows: { name: string; net: number; n: number; per: Record<string, number>; cnt: Record<string, number> }[] = [];
  for (const v of VARIANTS) {
    apply(v.cfg);
    let tot = 0, n = 0;
    const per: Record<string, number> = {}, cnt: Record<string, number> = {};
    for (const sym of syms) {
      const ts = runBacktest(sym, data.get(sym)!);
      per[sym] = net(ts); cnt[sym] = ts.length; tot += per[sym]; n += ts.length;
    }
    rows.push({ name: v.name, net: tot, n, per, cnt });
  }
  apply(orig); // restore

  const base = rows[0].net;
  console.log("=".repeat(78));
  console.log(`  FTR EXPERIMENTS — ${days} ngày — ${syms.map((s) => s.toUpperCase()).join(", ")}`);
  console.log("=".repeat(78));
  console.log(`${"Biến thể".padEnd(14)} ${"Lệnh".padStart(5)} ${"NET R".padStart(10)} ${"Δ base".padStart(10)} ${"NET/lệnh".padStart(10)}`);
  console.log("-".repeat(78));
  for (const r of rows) {
    const d = r.net - base, pt = r.n ? r.net / r.n : 0;
    const mark = r.name === "baseline" ? "" : d > 0.01 ? " ✅" : d < -0.01 ? " ❌" : " ≈";
    console.log(
      `${r.name.padEnd(14)} ${String(r.n).padStart(5)} ${((r.net >= 0 ? "+" : "") + r.net.toFixed(2) + "R").padStart(10)} ${((d >= 0 ? "+" : "") + d.toFixed(2) + "R").padStart(10)} ${((pt >= 0 ? "+" : "") + pt.toFixed(3) + "R").padStart(10)}${mark}`
    );
  }
  console.log("-".repeat(78));
  console.log("\nPER-SYMBOL NET R (lệnh):");
  console.log(`${"Biến thể".padEnd(14)} ` + syms.map((s) => s.toUpperCase().padStart(13)).join(""));
  for (const r of rows) {
    console.log(`${r.name.padEnd(14)} ` + syms.map((s) => `${(r.per[s] >= 0 ? "+" : "") + r.per[s].toFixed(1)}R(${r.cnt[s]})`.padStart(13)).join(""));
  }
  console.log();
  const win = rows.slice(1).filter((r) => r.net > base + 0.01).sort((a, b) => b.net - a.net);
  console.log(win.length
    ? `👉 Vượt baseline (${base.toFixed(2)}R): ${win.map((w) => `${w.name} (+${(w.net - base).toFixed(2)}R)`).join(", ")}`
    : `👉 KHÔNG biến thể nào vượt baseline (${base.toFixed(2)}R) → giữ nguyên.`);
  console.log();
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
