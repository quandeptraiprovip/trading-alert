/**
 * exp-turtle-improve.ts — Thử các đòn bẩy expectancy CÓ CƠ SỞ LÝ THUYẾT cho Turtle,
 * và CHỈ chấp nhận nếu cải thiện ở CẢ 3 era OOS (không chỉ tổng) → chống overfit.
 *
 * Đòn bẩy test (không phải dò tham số bừa):
 *   1. Breakout dài hơn (7/10/15/20d) — trade chất lượng cao hơn, lọc false-breakout.
 *   2. Long-only — prior cấu trúc crypto (short trend crypto khó: short-squeeze).
 *
 * Tiêu chí ĐẬU: expectancy (NET R/lệnh) ở Era A (OOS thật, cũ nhất) KHÔNG tệ hơn baseline,
 * và dương ở cả 3 era. Nếu chỉ đẹp ở Era C (gần đây) → nghi overfit/regime.
 *
 * Run: ./node_modules/.bin/ts-node exp-turtle-improve.ts [soNgay]
 */
import { Candle, TF_MS } from "./strategy";
import { fetchKlinesPaged } from "./backtest";
import { T, runTurtle, Trade } from "./turtle";

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "bnbusdt", "adausdt", "avaxusdt"];

function exp(ts: Trade[]) { return ts.length ? ts.reduce((s, t) => s + t.netR, 0) / ts.length : 0; }
function net(ts: Trade[]) { return ts.reduce((s, t) => s + t.netR, 0); }
function wr(ts: Trade[]) { return ts.length ? (ts.filter((t) => t.netR > 0).length / ts.length) * 100 : 0; }

type Variant = { label: string; entryDays: number; allowShort: boolean };

async function main() {
  const DAYS = parseInt(process.argv[2] ?? "1050", 10);
  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const totalBars = Math.ceil(DAYS * bpd) + T.trendLen + 50;
  console.log(`Fetch ~${DAYS}d × ${SYMBOLS.length} @ ${T.tf}...`);
  const data = new Map<string, Candle[]>();
  for (const s of SYMBOLS) {
    const c = await fetchKlinesPaged(s, T.tf, totalBars);
    if (c.length >= T.trendLen + 100) data.set(s, c);
  }
  if (data.size === 0) { console.log("Không tải được."); return; }
  const minLen = Math.min(...[...data.values()].map((d) => d.length));
  const periodDays = minLen / bpd;

  // chạy 1 variant trên toàn bộ + tách 3 era OOS
  function run(v: Variant) {
    const p = { ...T, entryDays: v.entryDays, chandelierMult: 3.0, allowShort: v.allowShort };
    const warmup = Math.max(Math.round(v.entryDays * bpd), T.trendLen, T.atrPeriod) + 1;
    const eraLen = Math.floor((minLen - warmup) / 3);

    const full: Trade[] = [];
    for (const [sym, d] of data) full.push(...runTurtle(sym, d, p));

    const eras: Trade[][] = [[], [], []];
    for (let e = 0; e < 3; e++) {
      for (const [sym, d] of data) {
        const sliceEnd = warmup + (e + 1) * eraLen;
        const slice = d.slice(0, sliceEnd);
        const tr = runTurtle(sym, slice, p);
        const eraStartTime = d[warmup + e * eraLen]?.openTime ?? 0;
        eras[e].push(...tr.filter((t) => t.entryTime >= eraStartTime));
      }
    }
    return { full, eras };
  }

  // Nới tần suất xuống ~0.5/ngày (1 lệnh/2 ngày OK) → mở khóa breakout dài expectancy cao hơn.
  // Long-only đã LOẠI (Era C gần đây âm, regime-dependent). Chỉ so các breakout dài, long+short.
  const variants: Variant[] = [
    { label: "7d (baseline)", entryDays: 7, allowShort: true },
    { label: "15d", entryDays: 15, allowShort: true },
    { label: "20d", entryDays: 20, allowShort: true },
    { label: "25d", entryDays: 25, allowShort: true },
    { label: "30d", entryDays: 30, allowShort: true },
  ];

  console.log("\n" + "=".repeat(96));
  console.log("  ĐÒN BẨY EXPECTANCY — expectancy (R/lệnh) phải dương & KHÔNG tệ đi ở Era A (OOS cũ nhất)");
  console.log("=".repeat(96));
  console.log("variant".padEnd(26) + " | EraA(OOS)        EraB             EraC(gần)        | FULL: lệnh /ngày  exp    NET");
  console.log("-".repeat(96));
  const ef = (ts: Trade[]) => `${exp(ts).toFixed(3)}(${String(ts.length).padStart(3)},${wr(ts).toFixed(0)}%)`;
  for (const v of variants) {
    const { full, eras } = run(v);
    const freq = full.length / periodDays;
    const line =
      v.label.padEnd(26) + " | " +
      ef(eras[0]).padEnd(17) + ef(eras[1]).padEnd(17) + ef(eras[2]).padEnd(17) + " | " +
      `${String(full.length).padStart(4)} ${freq.toFixed(2)}  ${exp(full).toFixed(3)}  ${(net(full) >= 0 ? "+" : "") + net(full).toFixed(0)}R`;
    console.log(line);
  }
  console.log("-".repeat(96));
  console.log("Đọc: exp(số lệnh,WR%). ĐẬU = cả 3 era dương VÀ EraA(OOS) không thấp hơn baseline rõ rệt.");
  console.log(`(${periodDays.toFixed(0)} ngày, mỗi era ~${(periodDays / 3).toFixed(0)} ngày)`);
}
main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
