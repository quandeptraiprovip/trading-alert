/**
 * exp-turtle-overfit.ts — Audit overfit cho chiến lược Turtle (turtle.ts).
 *  (A) OUT-OF-SAMPLE theo THỜI GIAN: chia toàn bộ lịch sử thành 3 era không chồng lấn.
 *      Era cũ nhất = OOS thật (config 7d/3×ATR chọn từ ~386d gần đây). Metric chính =
 *      expectancy (NET R/lệnh) — bền với số lệnh khác nhau giữa era.
 *  (B) PERTURBATION: jitter ngẫu nhiên ±15% các tham số Turtle, xem edge có sống không
 *      (sụt mạnh = cliff/overfit; gần plateau = robust).
 *
 * Config audit = cấu hình đã chọn: rổ 8 large-cap, breakout 7d, chandelier 3×ATR.
 *
 * Run: ./node_modules/.bin/ts-node exp-turtle-overfit.ts [soNgay]
 */
import { Candle, TF_MS } from "./strategy";
import { fetchKlinesPaged } from "./backtest";
import { T, runTurtle, Trade } from "./turtle";

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "bnbusdt", "adausdt", "avaxusdt"];

function stats(ts: Trade[]) {
  const n = ts.length, net = ts.reduce((s, t) => s + t.netR, 0);
  const wr = n ? (ts.filter((t) => t.netR > 0).length / n) * 100 : 0;
  return { n, net, wr, exp: n ? net / n : 0 };
}

async function main() {
  // chốt cấu hình đã chọn
  T.entryDays = 20;
  T.chandelierMult = 3.0;

  const DAYS = parseInt(process.argv[2] ?? "1050", 10);
  const bpd = TF_MS["1d"] / TF_MS[T.tf]; // 4h → 6/ngày
  const totalBars = Math.ceil(DAYS * bpd) + T.trendLen + 50;
  console.log(`Fetch ~${DAYS}d × ${SYMBOLS.length} symbol @ ${T.tf} (breakout ${T.entryDays}d / chandelier ${T.chandelierMult}×ATR)...`);

  const data = new Map<string, Candle[]>();
  for (const s of SYMBOLS) {
    const c = await fetchKlinesPaged(s, T.tf, totalBars);
    if (c.length >= T.trendLen + 100) data.set(s, c);
    console.log(`  ${s.toUpperCase()} ${c.length} nến (~${Math.round(c.length / bpd)}d)`);
  }
  if (data.size === 0) { console.log("Không tải được symbol nào."); return; }

  const warmup = Math.max(Math.round(T.entryDays * bpd), T.trendLen, T.atrPeriod) + 1;

  // ── (A) ERA theo thời gian: 3 phần ~đều, mỗi era kèm warmup phía trước ──
  const minLen = Math.min(...[...data.values()].map((d) => d.length));
  const eraLen = Math.floor((minLen - warmup) / 3);
  const eras = [
    { name: "Era A (cũ nhất ~OOS)", lo: 0 },
    { name: "Era B (giữa)", lo: 1 },
    { name: "Era C (gần đây, in-sample)", lo: 2 },
  ];
  console.log("\n" + "=".repeat(78));
  console.log("  (A) OUT-OF-SAMPLE THEO THỜI GIAN — expectancy (NET R/lệnh) phải ổn định & dương");
  console.log("=".repeat(78));
  console.log("Era".padEnd(28) + "khoảng".padEnd(22) + "lệnh  WR%   NETR   R/lệnh");
  console.log("-".repeat(78));
  const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  for (const e of eras) {
    const all: Trade[] = [];
    let t0 = Infinity, t1 = -Infinity;
    for (const [sym, d] of data) {
      const sliceStart = Math.max(0, warmup + e.lo * eraLen - warmup); // kèm warmup phía trước
      const sliceEnd = warmup + (e.lo + 1) * eraLen;
      const slice = d.slice(sliceStart, sliceEnd);
      const tr = runTurtle(sym, slice);
      const eraStartTime = d[warmup + e.lo * eraLen]?.openTime ?? 0;
      const kept = tr.filter((t) => t.entryTime >= eraStartTime);
      all.push(...kept);
      for (const t of kept) { t0 = Math.min(t0, t.entryTime); t1 = Math.max(t1, t.entryTime); }
    }
    const s = stats(all);
    const range = all.length ? `${fmtD(t0)}→${fmtD(t1)}` : "—";
    console.log(e.name.padEnd(28) + range.padEnd(22) + `${String(s.n).padStart(4)} ${s.wr.toFixed(0).padStart(4)} ${(s.net >= 0 ? "+" : "") + s.net.toFixed(1)}`.padEnd(8) + `  ${s.exp.toFixed(3).padStart(6)}`);
  }

  // ── (B) PERTURBATION: jitter tham số Turtle, chạy trên toàn bộ lịch sử ──
  const base = { entryDays: T.entryDays, chandelierMult: T.chandelierMult, atrPeriod: T.atrPeriod, trendLen: T.trendLen, maxHoldDays: T.maxHoldDays };
  const runFull = () => { const all: Trade[] = []; for (const [sym, d] of data) all.push(...runTurtle(sym, d)); return stats(all); };
  const baseStats = runFull();

  const SEEDS = 30, jit = 0.15;
  const nets: number[] = [], exps: number[] = [];
  for (let s = 0; s < SEEDS; s++) {
    T.entryDays = Math.max(2, Math.round(base.entryDays * (1 + (Math.random() * 2 - 1) * jit)));
    T.chandelierMult = base.chandelierMult * (1 + (Math.random() * 2 - 1) * jit);
    T.atrPeriod = Math.max(5, Math.round(base.atrPeriod * (1 + (Math.random() * 2 - 1) * jit)));
    T.trendLen = Math.max(10, Math.round(base.trendLen * (1 + (Math.random() * 2 - 1) * jit)));
    T.maxHoldDays = Math.max(5, Math.round(base.maxHoldDays * (1 + (Math.random() * 2 - 1) * jit)));
    const st = runFull();
    nets.push(st.net); exps.push(st.exp);
  }
  // restore
  Object.assign(T, base);

  nets.sort((a, b) => a - b);
  exps.sort((a, b) => a - b);
  const q = (arr: number[], p: number) => arr[Math.floor((arr.length - 1) * p)];
  const pos = nets.filter((x) => x > 0).length;
  const posExp = exps.filter((x) => x > 0).length;
  console.log("\n" + "=".repeat(78));
  console.log(`  (B) PERTURBATION — ${SEEDS} seed jitter ±${jit * 100}% tham số (toàn bộ ~${Math.round(minLen / bpd)}d)`);
  console.log("=".repeat(78));
  console.log(`Baseline NET R          : ${baseStats.net.toFixed(1)}R (${baseStats.n} lệnh, exp ${baseStats.exp.toFixed(3)}R/lệnh)`);
  console.log(`Jitter NET R phân bố    : min ${nets[0].toFixed(1)} | p25 ${q(nets, .25).toFixed(1)} | median ${q(nets, .5).toFixed(1)} | p75 ${q(nets, .75).toFixed(1)} | max ${nets[nets.length - 1].toFixed(1)}`);
  console.log(`Jitter exp phân bố      : min ${q(exps, 0).toFixed(3)} | median ${q(exps, .5).toFixed(3)} | max ${q(exps, 1).toFixed(3)}`);
  console.log(`Seed có NET R > 0       : ${pos}/${SEEDS} (${(pos / SEEDS * 100).toFixed(0)}%)  | exp>0: ${posExp}/${SEEDS}`);
  console.log(`Median jitter / baseline: ${(q(nets, .5) / baseStats.net * 100).toFixed(0)}%  (gần 100% = plateau/robust; sụt mạnh = cliff/overfit)`);
}
main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
