/**
 * fast-trend-audit.ts — Audit overfit (kiểu exp-turtle-overfit.ts) cho SLEEVE TREND NHANH.
 * So sánh breakout 20d (core turtle) vs 15d/10d (sleeve nhanh) trên rổ turtle hiện tại, CÓ BTC gate:
 *   (A) 3-ERA OOS — expectancy (NET R/lệnh) phải dương & ổn định cả 3 era (Era A = OOS cũ nhất).
 *   (B) PERTURBATION ±15% × 30 seed — edge sống qua nhiễu tham số (plateau, không cliff).
 *
 * Kết luận (2026-07): cả 3 lookback đậu (mọi era dương, 30/30 seed). 10d giao dịch cả lúc chop
 * (turtle 20d im) nhưng expectancy Era-A mỏng nhất → dùng ALERT-ONLY forward-test (fast-trend-live.ts).
 *
 * Run: ./node_modules/.bin/ts-node scripts/fast-trend-audit.ts [soNgay]
 */
import { Candle, TF_MS } from "../strategy";
import { fetchKlinesPaged } from "../backtest";
import { T, runTurtle, buildBtcGateLongs, Trade, TurtleParams } from "../turtle";

// Rổ turtle hiện tại (hoán đổi 2026-07: bỏ BNB, thêm DOT). Đồng bộ với TURTLE_SYMBOLS trong btc-alert-bot.ts.
const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "adausdt", "avaxusdt", "dotusdt"];
const CANDIDATES = [20, 15, 10]; // 20 = core; 15/10 = sleeve nhanh
const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const stats = (ts: Trade[]) => { const n = ts.length, net = ts.reduce((s, t) => s + t.netR, 0); return { n, net, wr: n ? ts.filter((t) => t.netR > 0).length / n * 100 : 0, exp: n ? net / n : 0 }; };

async function main() {
  const DAYS = parseInt(process.argv[2] ?? "1050", 10);
  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const totalBars = Math.ceil(DAYS * bpd) + T.btcGateSlow + 50;
  console.log(`Fetch ~${DAYS}d × ${SYMBOLS.length} @ ${T.tf} (rổ turtle hiện tại, có BTC gate ${T.btcGateFast / 6}/${T.btcGateSlow / 6}d)...`);
  const data = new Map<string, Candle[]>();
  for (const s of SYMBOLS) { const c = await fetchKlinesPaged(s, T.tf, totalBars); if (c.length >= T.trendLen + 100) data.set(s, c); }
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);

  const warmup = Math.max(Math.round(20 * bpd), T.trendLen, T.atrPeriod, T.btcGateSlow) + 1;
  const minLen = Math.min(...[...data.values()].map((d) => d.length));
  const eraLen = Math.floor((minLen - warmup) / 3);
  const t1 = Math.max(...[...data.values()].map((c) => c[c.length - 1].openTime));

  for (const entryDays of CANDIDATES) {
    const p: TurtleParams = { ...T, entryDays, gate };
    console.log("\n" + "=".repeat(80));
    console.log(`  ${entryDays === 20 ? "CORE" : "SLEEVE NHANH"} — breakout ${entryDays}d / chandelier ${p.chandelierMult}×ATR`);
    console.log("=".repeat(80));
    console.log("  (A) 3-ERA OOS — expectancy phải dương cả 3 era:");
    console.log("  " + "Era".padEnd(24) + "range".padEnd(24) + "lệnh WR%   NETR    exp");
    let eraAexp = 0, allPos = true;
    for (const [idx, name] of [[0, "A (cũ nhất=OOS thật)"], [1, "B (giữa)"], [2, "C (gần đây)"]] as [number, string][]) {
      const all: Trade[] = [];
      let a = Infinity, b = -Infinity;
      for (const [sym, d] of data) {
        const slice = d.slice(0, warmup + (idx + 1) * eraLen);
        const eraStart = d[warmup + idx * eraLen]?.openTime ?? 0;
        const eraEnd = d[warmup + (idx + 1) * eraLen - 1]?.openTime ?? Infinity;
        const tr = runTurtle(sym, slice, p).filter((t) => t.entryTime >= eraStart && t.entryTime <= eraEnd);
        all.push(...tr);
        for (const t of tr) { a = Math.min(a, t.entryTime); b = Math.max(b, t.entryTime); }
      }
      const s = stats(all);
      if (idx === 0) eraAexp = s.exp;
      if (s.net <= 0) allPos = false;
      console.log("  " + name.padEnd(24) + (all.length ? `${fmtD(a)}→${fmtD(b)}` : "—").padEnd(24) + `${String(s.n).padStart(4)} ${s.wr.toFixed(0).padStart(3)} ${((s.net >= 0 ? "+" : "") + s.net.toFixed(1)).padStart(7)} ${s.exp.toFixed(3).padStart(6)}`);
    }

    const runFull = (pp: TurtleParams) => { const all: Trade[] = []; for (const [sym, d] of data) all.push(...runTurtle(sym, d, pp)); return stats(all); };
    const baseFull = runFull(p);
    const SEEDS = 30, jit = 0.15, nets: number[] = [];
    for (let s = 0; s < SEEDS; s++) {
      const f = (m: number) => 1 + (((s * 2654435761) % 1000) / 1000 * 2 - 1) * jit * m;
      nets.push(runFull({ ...p,
        entryDays: Math.max(2, Math.round(entryDays * f(1.0))),
        chandelierMult: p.chandelierMult * f(0.7),
        atrPeriod: Math.max(5, Math.round(p.atrPeriod * f(0.5))),
        trendLen: Math.max(10, Math.round(p.trendLen * f(0.9))),
        maxHoldDays: Math.max(5, Math.round(p.maxHoldDays * f(1.1))),
      }).net);
    }
    nets.sort((x, y) => x - y);
    const pos = nets.filter((x) => x > 0).length, median = nets[Math.floor(nets.length / 2)];
    const last = (() => { let m = 0; for (const [sym, d] of data) for (const t of runTurtle(sym, d, p)) m = Math.max(m, t.entryTime); return m; })();
    console.log(`  (B) PERTURBATION ±15% (${SEEDS} seed): baseline NET ${baseFull.net.toFixed(0)}R exp ${baseFull.exp.toFixed(3)} | seed NET>0 ${pos}/${SEEDS} | median ${(median / baseFull.net * 100).toFixed(0)}% baseline`);
    console.log(`  → lệnh gần nhất: ${fmtD(last)} (${((t1 - last) / TF_MS["1d"]).toFixed(0)}d trước)  ·  VERDICT: Era-A ${eraAexp > 0 ? "✅" : "❌"} | cả-3-era-dương ${allPos ? "✅" : "❌"} | perturbation ${pos >= SEEDS * 0.8 ? "✅" : "⚠️"}`);
  }
  console.log("\nLƯU Ý: 20d = core turtle (tiền thật). 10d = sleeve nhanh (fast-trend-live.ts, ALERT-ONLY).");
}
main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
