/**
 * exp-turtle-overfit.ts — Audit overfit cho chiến lược Turtle (turtle.ts).
 *  (A) ĐỘ BỀN THEO THỜI GIAN: chia toàn bộ lịch sử thành 3 era không chồng lấn.
 *      Vì config hiện đã được xem trên toàn lịch sử, đây KHÔNG còn là OOS nguyên chất;
 *      metric chính là expectancy (NET R/lệnh), bền với số lệnh khác nhau giữa era.
 *  (B) PERTURBATION: jitter ngẫu nhiên ±15% các tham số Turtle, xem edge có sống không
 *      (sụt mạnh = cliff/overfit; gần plateau = robust).
 *
 * Config audit = đúng production: rổ 8 large-cap, LONG Hybrid close/mid 15d,
 * SHORT close 30d/Chandelier, BTC gate LONG 10d/100d, pyramid tối đa 4 unit.
 *
 * Run: ./node_modules/.bin/ts-node exp-turtle-overfit.ts [soNgay]
 */
import { Candle, TF_MS } from "./strategy";
import { fetchKlinesPaged } from "./backtest";
import { T, runTurtle, Trade, TurtleParams, buildBtcGateLongs } from "./turtle";

// Rổ hoán đổi chất lượng 2026-07: BỎ BNB (solvency risk) → THÊM DOT (robust). Giữ 8 coin. Xem btc-alert-bot.ts.
const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "adausdt", "avaxusdt", "dotusdt"];

function stats(ts: Trade[]) {
  const n = ts.length, net = ts.reduce((s, t) => s + t.netR, 0);
  const wr = n ? (ts.filter((t) => t.netR > 0).length / n) * 100 : 0;
  return { n, net, wr, exp: n ? net / n : 0 };
}

async function main() {
  // chốt cấu hình đã chọn (2026-07-19: core turtle 20→15d, xem turtle.ts)
  T.entryDays = 15;
  T.chandelierMult = 3.0;

  const DAYS = parseInt(process.argv[2] ?? "1050", 10);
  const bpd = TF_MS["1d"] / TF_MS[T.tf]; // 4h → 6/ngày
  const totalBars = Math.ceil(DAYS * bpd) + T.btcGateSlow + 50;
  console.log(`Fetch ~${DAYS}d × ${SYMBOLS.length} symbol @ ${T.tf} (LONG ${T.entryDays}d / SHORT ${T.shortEntryDays || T.entryDays}d + BTC gate)...`);

  const data = new Map<string, Candle[]>();
  for (const s of SYMBOLS) {
    const c = await fetchKlinesPaged(s, T.tf, totalBars);
    if (c.length >= T.trendLen + 100) data.set(s, c);
    console.log(`  ${s.toUpperCase()} ${c.length} nến (~${Math.round(c.length / bpd)}d)`);
  }
  if (data.size === 0) { console.log("Không tải được symbol nào."); return; }
  const btc = data.get("btcusdt");
  if (!btc) { console.log("Thiếu BTCUSDT để dựng regime gate."); return; }
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);

  const warmup = Math.max(Math.round(T.entryDays * bpd), Math.round((T.shortEntryDays || T.entryDays) * bpd), T.trendLen, T.atrPeriod, T.btcGateSlow) + 1;

  // ── (A) ERA theo thời gian: 3 phần ~đều, mỗi era kèm warmup phía trước ──
  const minLen = Math.min(...[...data.values()].map((d) => d.length));
  const eraLen = Math.floor((minLen - warmup) / 3);
  const eras = [
    { name: "Era A (cũ nhất)", lo: 0 },
    { name: "Era B (giữa)", lo: 1 },
    { name: "Era C (gần đây, in-sample)", lo: 2 },
  ];
  console.log("\n" + "=".repeat(78));
  console.log("  (A) ĐỘ BỀN THEO THỜI GIAN — expectancy (NET R/lệnh) phải ổn định & dương");
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
      const tr = runTurtle(sym, slice, { ...T, gate });
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
  const base = { entryDays: T.entryDays, shortEntryDays: T.shortEntryDays, chandelierMult: T.chandelierMult, atrPeriod: T.atrPeriod, trendLen: T.trendLen, maxHoldDays: T.maxHoldDays };
  const auditStart = btc[warmup]?.openTime ?? 0; // loại toàn bộ vùng warmup/gate permissive khỏi metric full
  const runFull = (p: TurtleParams) => {
    const all: Trade[] = [];
    for (const [sym, d] of data) all.push(...runTurtle(sym, d, p).filter((t) => t.entryTime >= auditStart));
    return stats(all);
  };
  const baseStats = runFull({ ...T, gate });
  const previousStats = runFull({ ...T, shortEntryDays: 0, shortEntrySource: "low", shortExitMode: "chandelier", gate });
  const legacyStats = runFull({
    ...T, shortEntryDays: 0, initialStopObLookback: 0,
    longEntrySource: "high", longExitMode: "chandelier",
    shortEntrySource: "low", shortExitMode: "chandelier", gate,
  });
  const auditDays = Math.max(1, (btc[btc.length - 1].openTime - auditStart) / TF_MS["1d"]);

  const SEEDS = 30, jit = 0.15;
  const nets: number[] = [], exps: number[] = [];
  for (let s = 0; s < SEEDS; s++) {
    // PRNG cố định theo seed/salt để audit tái lập được giữa các lần chạy.
    const factor = (salt: number): number => {
      const x = (Math.imul(s + 1, 2654435761) + Math.imul(salt + 1, 1013904223)) >>> 0;
      return 1 + ((x / 0x100000000) * 2 - 1) * jit;
    };
    T.entryDays = Math.max(2, Math.round(base.entryDays * factor(0)));
    T.shortEntryDays = Math.max(2, Math.round(base.shortEntryDays * factor(5)));
    T.chandelierMult = base.chandelierMult * factor(1);
    T.atrPeriod = Math.max(5, Math.round(base.atrPeriod * factor(2)));
    T.trendLen = Math.max(10, Math.round(base.trendLen * factor(3)));
    T.maxHoldDays = Math.max(5, Math.round(base.maxHoldDays * factor(4)));
    const st = runFull({ ...T, gate });
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
  console.log(`  (B) PERTURBATION — ${SEEDS} seed jitter ±${jit * 100}% tham số (sau warmup ~${Math.round(auditDays)}d)`);
  console.log("=".repeat(78));
  console.log(`Baseline NET R          : ${baseStats.net.toFixed(1)}R (${baseStats.n} lệnh, ${(baseStats.n / auditDays).toFixed(2)}/ngày, exp ${baseStats.exp.toFixed(3)}R/lệnh)`);
  console.log(`Production trước fix    : ${previousStats.net.toFixed(1)}R (${previousStats.n} lệnh, ${(previousStats.n / auditDays).toFixed(2)}/ngày, exp ${previousStats.exp.toFixed(3)}R/lệnh)`);
  console.log(`Engine cũ cùng gate     : ${legacyStats.net.toFixed(1)}R (${legacyStats.n} lệnh, ${(legacyStats.n / auditDays).toFixed(2)}/ngày, exp ${legacyStats.exp.toFixed(3)}R/lệnh)`);
  console.log(`Jitter NET R phân bố    : min ${nets[0].toFixed(1)} | p25 ${q(nets, .25).toFixed(1)} | median ${q(nets, .5).toFixed(1)} | p75 ${q(nets, .75).toFixed(1)} | max ${nets[nets.length - 1].toFixed(1)}`);
  console.log(`Jitter exp phân bố      : min ${q(exps, 0).toFixed(3)} | median ${q(exps, .5).toFixed(3)} | max ${q(exps, 1).toFixed(3)}`);
  console.log(`Seed có NET R > 0       : ${pos}/${SEEDS} (${(pos / SEEDS * 100).toFixed(0)}%)  | exp>0: ${posExp}/${SEEDS}`);
  console.log(`Median jitter / baseline: ${(q(nets, .5) / baseStats.net * 100).toFixed(0)}%  (gần 100% = plateau/robust; sụt mạnh = cliff/overfit)`);
}
main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
