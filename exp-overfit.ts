/**
 * exp-overfit.ts — Audit overfit cho baseline.
 *  (A) OUT-OF-SAMPLE theo THỜI GIAN: chia ~1050 ngày thành 3 era không chồng lấn. Era cũ nhất
 *      KHÔNG nằm trong dữ liệu tune (tune tham chiếu 250d & 500d gần đây) ⇒ OOS thật.
 *  (B) PERTURBATION: jitter ngẫu nhiên ±15% nhiều tham số, xem edge có sống không (cliff = overfit).
 *  Metric chính = expectancy (NET R/lệnh) — bền với số lệnh khác nhau giữa era.
 */
import { CONFIG, Candle, TF_MS } from "./strategy";
import { fetchKlinesPaged, runBacktest, Trade } from "./backtest";

function stats(ts: Trade[]) {
  const n = ts.length, net = ts.reduce((s, t) => s + t.netR, 0);
  const wr = n ? (ts.filter((t) => t.netR > 0).length / n) * 100 : 0;
  const meanM = n ? ts.reduce((s, t) => s + t.sizeMult, 0) / n : 1;
  const wnet = n ? ts.reduce((s, t) => s + (t.sizeMult / meanM) * t.netR, 0) : 0;
  return { n, net, wr, exp: n ? net / n : 0, wnet };
}

async function main() {
  const DAYS = 1050;
  const syms = CONFIG.symbols.map((s) => s.toLowerCase());
  const bpd = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const totalBars = Math.ceil(DAYS * bpd) + 400;
  console.log(`Fetch ~${DAYS}d × ${syms.length} (maxStop ${CONFIG.maxStopPct}, qualitySizing ${CONFIG.qualitySizing})...`);
  const data = new Map<string, Candle[]>();
  for (const s of syms) {
    const ltf = await fetchKlinesPaged(s, CONFIG.entryTf, totalBars);
    if (ltf.length >= 5000) data.set(s, ltf);
    console.log(`  ${s.toUpperCase()} ${ltf.length} nến (~${Math.round(ltf.length / bpd)}d)`);
  }

  // ── (A) ERA theo thời gian: 3 phần ~đều, mỗi era kèm 400 nến warmup phía trước ──
  const minLen = Math.min(...[...data.values()].map((d) => d.length));
  const eraLen = Math.floor((minLen - 400) / 3);
  const eras = [
    { name: "Era A (cũ nhất ~OOS)", lo: 0 },
    { name: "Era B (giữa)", lo: 1 },
    { name: "Era C (gần đây, in-sample)", lo: 2 },
  ];
  console.log("\n" + "=".repeat(78));
  console.log("  (A) OUT-OF-SAMPLE THEO THỜI GIAN — expectancy (NET R/lệnh) phải ổn định & dương");
  console.log("=".repeat(78));
  console.log("Era".padEnd(28) + "khoảng".padEnd(22) + "lệnh  WR%   NETR   R/lệnh  wNETR");
  console.log("-".repeat(78));
  const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  for (const e of eras) {
    const all: Trade[] = [];
    let t0 = Infinity, t1 = -Infinity;
    for (const [sym, d] of data) {
      const start = e.lo === 0 ? 0 : 400 + e.lo * eraLen - 400; // kèm warmup
      const sliceStart = Math.max(0, 400 + e.lo * eraLen - 400);
      const sliceEnd = 400 + (e.lo + 1) * eraLen;
      const slice = d.slice(sliceStart, sliceEnd);
      const tr = runBacktest(sym, slice);
      // chỉ tính lệnh có entry nằm trong era (sau warmup)
      const eraStartTime = d[400 + e.lo * eraLen]?.openTime ?? 0;
      const kept = tr.filter((t) => t.entryTime >= eraStartTime);
      all.push(...kept);
      for (const t of kept) { t0 = Math.min(t0, t.entryTime); t1 = Math.max(t1, t.entryTime); }
    }
    const s = stats(all);
    const range = all.length ? `${fmtD(t0)}→${fmtD(t1)}` : "—";
    console.log(e.name.padEnd(28) + range.padEnd(22) + `${String(s.n).padStart(4)} ${s.wr.toFixed(0).padStart(4)} ${(s.net >= 0 ? "+" : "") + s.net.toFixed(1)}`.padEnd(7) + `  ${s.exp.toFixed(3).padStart(6)}  ${(s.wnet >= 0 ? "+" : "") + s.wnet.toFixed(1)}`);
  }

  // ── (B) PERTURBATION: jitter ngẫu nhiên tham số, chạy trên toàn bộ ~1050d ──
  const KEYS_MULT = ["volSpikeMult", "ltfConfirmVolMult", "zoneTapTolPct", "slBufferPct", "maxStopPct", "trailStartR", "targetRR", "setupExpiryBars", "zoneInvalidationPct"] as const;
  const base: Record<string, any> = {}; for (const k of KEYS_MULT) base[k] = (CONFIG as any)[k];
  const baseDelta = base["deltaBuyMin"]; const baseCd = CONFIG.cooldownBars; const baseHold = CONFIG.maxHoldBars; const baseMBA = CONFIG.minBarsAfterArm; const baseDB = CONFIG.deltaBuyMin;

  const runFull = () => { const all: Trade[] = []; for (const [sym, d] of data) all.push(...runBacktest(sym, d)); return stats(all); };
  const baseStats = runFull();

  const SEEDS = 30, jit = 0.15;
  const nets: number[] = [];
  for (let s = 0; s < SEEDS; s++) {
    for (const k of KEYS_MULT) (CONFIG as any)[k] = base[k] * (1 + (Math.random() * 2 - 1) * jit);
    CONFIG.deltaBuyMin = Math.min(0.65, Math.max(0.50, baseDB + (Math.random() * 2 - 1) * 0.04));
    CONFIG.cooldownBars = Math.round(baseCd * (1 + (Math.random() * 2 - 1) * jit));
    CONFIG.maxHoldBars = Math.round(baseHold * (1 + (Math.random() * 2 - 1) * jit));
    CONFIG.minBarsAfterArm = Math.max(0, Math.round(baseMBA + (Math.random() * 2 - 1) * 2));
    nets.push(runFull().net);
  }
  // restore
  for (const k of KEYS_MULT) (CONFIG as any)[k] = base[k];
  CONFIG.deltaBuyMin = baseDB; CONFIG.cooldownBars = baseCd; CONFIG.maxHoldBars = baseHold; CONFIG.minBarsAfterArm = baseMBA;

  nets.sort((a, b) => a - b);
  const q = (p: number) => nets[Math.floor((nets.length - 1) * p)];
  const pos = nets.filter((x) => x > 0).length;
  console.log("\n" + "=".repeat(78));
  console.log(`  (B) PERTURBATION — ${SEEDS} seed jitter ±${jit * 100}% tham số (toàn bộ ~${DAYS}d)`);
  console.log("=".repeat(78));
  console.log(`Baseline NET R         : ${baseStats.net.toFixed(1)}R (${baseStats.n} lệnh, exp ${baseStats.exp.toFixed(3)}R/lệnh)`);
  console.log(`Jitter NET R phân bố   : min ${nets[0].toFixed(1)} | p25 ${q(.25).toFixed(1)} | median ${q(.5).toFixed(1)} | p75 ${q(.75).toFixed(1)} | max ${nets[nets.length - 1].toFixed(1)}`);
  console.log(`Seed có NET R > 0      : ${pos}/${SEEDS} (${(pos / SEEDS * 100).toFixed(0)}%)`);
  console.log(`Median jitter / baseline: ${(q(.5) / baseStats.net * 100).toFixed(0)}%  (gần 100% = plateau/robust; sụt mạnh = cliff/overfit)`);
}
main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
