/**
 * exp-core-plus.ts — GIỮ rổ lõi đang chạy, CHỈ THÊM coin (breadth thuần), thay vì thay rổ.
 *
 * Vì sao tách khỏi `exp-liquidity-universe.ts`: ở đó luật "top-N thanh khoản" THAY rổ CORE8 và
 * kết quả walk-forward là hoà (Turtle Sharpe TB 1,23 vs 1,22 trên 56 cửa sổ) — không đủ để đổi.
 * Nhưng câu hỏi "có nên giao dịch NHIỀU coin hơn" khác câu hỏi "có nên đổi coin". Ở đây rổ lõi
 * giữ nguyên (đã có đường ống live, đã audit), phần thêm chọn bằng luật thanh khoản point-in-time.
 *
 * Đây cũng là cách so sánh CÔNG BẰNG duy nhất: mọi cấu hình đều chứa CORE8 nên phần "may mắn chọn
 * đúng 8 coin sống sót" là HẰNG SỐ, chênh lệch còn lại đúng bằng đóng góp của breadth.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-core-plus.ts [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { ExtParams, riskMetrics, runBooks, Book } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { decayH, Gate, fmtD } from "./rx-lab";
import { CORE8, POOL46, loadPool, coreWindow } from "./exp-breadth";

const LOOKBACK_DAYS = 90;
const REBALANCE_DAYS = 30;

/** "CORE8 luôn được phép + top-K coin thanh khoản nhất NGOÀI lõi tại thời điểm đó". */
function buildCorePlus(data: Map<string, Candle[]>, extraK: number, from: number, to: number) {
  const step = REBALANCE_DAYS * TF_MS["1d"];
  const lookMs = LOOKBACK_DAYS * TF_MS["1d"];
  const sets: Set<string>[] = [];
  for (let t = from; t <= to + step; t += step) {
    const scored: { sym: string; v: number }[] = [];
    for (const [sym, c] of data) {
      if (CORE8.includes(sym)) continue;
      const vols: number[] = [];
      for (let i = c.length - 1; i >= 0; i--) {
        const bt = c[i].openTime;
        if (bt >= t) continue;
        if (bt < t - lookMs) break;
        vols.push(c[i].quoteVolume);
      }
      if (vols.length < LOOKBACK_DAYS * 6 * 0.8) continue;
      vols.sort((a, b) => a - b);
      scored.push({ sym, v: vols[Math.floor(vols.length / 2)] });
    }
    scored.sort((a, b) => b.v - a.v);
    sets.push(new Set([...CORE8, ...scored.slice(0, extraK).map((x) => x.sym)]));
  }
  return (symbol: string, time: number) => {
    let idx = Math.floor((time - from) / step);
    if (idx < 0) idx = 0;
    if (idx >= sets.length) idx = sets.length - 1;
    return sets[idx].has(symbol);
  };
}

function run(data: Map<string, Candle[]>, p: ExtParams, baseGate: Gate, inU: ((s: string, t: number) => boolean) | null, syms: string[]) {
  const bs: Book[] = syms
    .filter((s) => data.has(s))
    .map((s) => ({
      key: s,
      symbol: s,
      candles: data.get(s)!,
      p: { ...p, gate: (t: number, dir: "long" | "short") => baseGate(t, dir) && (!inU || inU(s, t)) },
    }));
  return runBooks(bs, decayH(T.heatDecayK));
}

const win = (res: any, from: number, to: number) => riskMetrics(res.equity.filter((e: any) => e.time >= from && e.time <= to));

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadPool(days, POOL46);
  const baseGate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(baseGate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  const YEAR = 365 * TF_MS["1d"];
  const MONTH = 30 * TF_MS["1d"];
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · ${data.size} symbol · heat k=${T.heatDecayK}`);
  console.log(`Phần THÊM = top-K thanh khoản ngoài lõi (trung vị quoteVolume ${LOOKBACK_DAYS}d, tái cân bằng ${REBALANCE_DAYS}d)\n`);

  for (const [name, p] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
    console.log("=".repeat(122));
    console.log(`  ${name} — CORE8 + K coin thêm`);
    console.log("=".repeat(122));
    console.log("cấu hình         vịthế  Sharpe   NET R   maxDD   N/DD  N/Ulc   era A/B/C        730d       365d     WF thắng/56  WF Sharpe TB");
    console.log("-".repeat(122));

    // tham chiếu để tính tỉ lệ thắng walk-forward
    const ref = run(data, p, baseGate, null, CORE8);
    const refWf: number[] = [];
    for (let end = w.from + YEAR; end <= w.to; end += MONTH) refWf.push(win(ref, end - YEAR, end).sharpe);

    for (const K of [0, 2, 4, 6, 8, 12, 16, 24, 38]) {
      const u = K === 0 ? null : buildCorePlus(data, K, w.from, w.to);
      const res = run(data, p, baseGate, u, K === 0 ? CORE8 : POOL46);
      const m = win(res, w.from, w.to);
      const eras = w.eras.map((e) => win(res, e.from, e.to).sharpe);
      const l730 = win(res, w.to - 730 * TF_MS["1d"], w.to);
      const l365 = win(res, w.to - YEAR, w.to);
      const pos = new Set(res.trades.map((t: any) => `${t.book}#${t.positionId}`)).size;
      const wf: number[] = [];
      for (let end = w.from + YEAR; end <= w.to; end += MONTH) wf.push(win(res, end - YEAR, end).sharpe);
      const wins = wf.filter((x, i) => x > refWf[i]).length;
      const wfAvg = wf.reduce((s, x) => s + x, 0) / wf.length;
      console.log(
        `${(K === 0 ? "CORE8 (đang chạy)" : `CORE8 + ${K}`).padEnd(16)} ${String(pos).padStart(5)} ${m.sharpe.toFixed(2).padStart(7)} ` +
          `${m.netR.toFixed(0).padStart(7)} ${m.maxDD.toFixed(1).padStart(7)} ${m.netOverMaxDD.toFixed(2).padStart(6)} ` +
          `${m.netOverUlcer.toFixed(1).padStart(6)}   ${eras.map((x) => x.toFixed(2)).join("/")}   ` +
          `${l730.sharpe.toFixed(2)}|${String(l730.netR.toFixed(0)).padStart(3)}   ${l365.sharpe.toFixed(2)}|${String(l365.netR.toFixed(0)).padStart(3)}   ` +
          `${String(wins).padStart(6)}/56    ${wfAvg.toFixed(2)}`,
      );
    }
    console.log();
  }
}

if (require.main === module && /exp-core-plus\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error("Lỗi:", e?.message ?? e);
    process.exit(1);
  });
}
