/**
 * exp-universe-robust.ts — kiểm định ĐỘ VỮNG của luật rổ "top-N theo thanh khoản quá khứ".
 *
 * Ứng viên đến từ `exp-liquidity-universe.ts`: rổ chọn point-in-time thắng rổ CORE8 cố định ở
 * 365 ngày gần nhất (Turtle 1,01|59R vs 0,57|29R) dù thua ở toàn kỳ. Trước khi tin, phải loại
 * bốn cách nó có thể là ảo:
 *
 *   G1 PLATEAU   — cải thiện phải trải trên nhiều (lookback × rebalance × N), không phải một điểm.
 *   G2 PLACEBO   — luật ĐẢO (bottom-N thanh khoản) phải XẤU rõ. Nếu bottom-N cũng tốt thì thứ
 *                  đang hoạt động là "nhiều coin hơn/khác CORE8", không phải thanh khoản.
 *   G3 WALK-FWD  — thắng trên PHẦN LỚN 56 cửa sổ 365 ngày trượt, không phải một cửa sổ may.
 *   G4 QUY KẾT   — lợi ích không được đến từ MỘT coin duy nhất (vd zecusdt 2026).
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-universe-robust.ts [days] [gate=all|g1|g2|g3|g4]
 */
import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { ExtParams, riskMetrics, runBooks, Book, UnitTrade } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { decayH, Gate, fmtD } from "./rx-lab";
import { CORE8, POOL46, loadPool, coreWindow } from "./exp-breadth";

type Win = ReturnType<typeof coreWindow>;
type Rank = "top" | "bottom";

/** Bản tổng quát của buildLiquidityUniverse: tham số hoá lookback/rebalance + đảo chiều xếp hạng. */
function buildUniverse(
  data: Map<string, Candle[]>,
  n: number,
  from: number,
  to: number,
  lookbackDays: number,
  rebalanceDays: number,
  rank: Rank = "top",
) {
  const step = rebalanceDays * TF_MS["1d"];
  const lookMs = lookbackDays * TF_MS["1d"];
  const sets: Set<string>[] = [];
  for (let t = from; t <= to + step; t += step) {
    const scored: { sym: string; v: number }[] = [];
    for (const [sym, c] of data) {
      const vols: number[] = [];
      for (let i = c.length - 1; i >= 0; i--) {
        const bt = c[i].openTime;
        if (bt >= t) continue;
        if (bt < t - lookMs) break;
        vols.push(c[i].quoteVolume);
      }
      if (vols.length < lookbackDays * 6 * 0.8) continue;
      vols.sort((a, b) => a - b);
      scored.push({ sym, v: vols[Math.floor(vols.length / 2)] });
    }
    scored.sort((a, b) => (rank === "top" ? b.v - a.v : a.v - b.v));
    sets.push(new Set(scored.slice(0, n).map((x) => x.sym)));
  }
  return (symbol: string, time: number) => {
    let idx = Math.floor((time - from) / step);
    if (idx < 0) idx = 0;
    if (idx >= sets.length) idx = sets.length - 1;
    return sets[idx].has(symbol);
  };
}

function run(
  data: Map<string, Candle[]>,
  p: ExtParams,
  baseGate: Gate,
  inUniverse: ((s: string, t: number) => boolean) | null,
  syms: string[],
) {
  const bs: Book[] = syms
    .filter((s) => data.has(s))
    .map((s) => ({
      key: s,
      symbol: s,
      candles: data.get(s)!,
      p: { ...p, gate: (t: number, dir: "long" | "short") => baseGate(t, dir) && (!inUniverse || inUniverse(s, t)) },
    }));
  return runBooks(bs, decayH(T.heatDecayK));
}

/** Sharpe & NET R của một cửa sổ [from,to] trên chuỗi equity. */
const win = (res: { equity: { time: number }[] }, from: number, to: number) =>
  riskMetrics((res as any).equity.filter((e: any) => e.time >= from && e.time <= to));

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const which = (process.argv[3] ?? "all").toLowerCase();
  const data = await loadPool(days, POOL46);
  const baseGate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(baseGate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  const sleeves: [string, ExtParams][] = [["TURTLE", turtle], ["FAST", fast]];
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · ${data.size} symbol · heat k=${T.heatDecayK}\n`);

  // ───────────────────────── G1 — PLATEAU trên (lookback × rebalance × N) ─────────────────────────
  if (which === "all" || which === "g1") {
    console.log("=".repeat(112));
    console.log("  G1 — PLATEAU: Sharpe toàn kỳ | Sharpe 365d, quét lookback × rebalance × N (TURTLE)");
    console.log("=".repeat(112));
    for (const N of [8, 10, 12]) {
      console.log(`\nN = ${N}`);
      console.log("lookback\\rebal      7d            14d            30d            60d");
      for (const lb of [30, 60, 90, 180]) {
        const cells: string[] = [];
        for (const rb of [7, 14, 30, 60]) {
          const u = buildUniverse(data, N, w.from, w.to, lb, rb);
          const res = run(data, turtle, baseGate, u, POOL46);
          const all = win(res, w.from, w.to);
          const l365 = win(res, w.to - 365 * TF_MS["1d"], w.to);
          cells.push(`${all.sharpe.toFixed(2)}|${l365.sharpe.toFixed(2)}`.padStart(13));
        }
        console.log(`${String(lb).padStart(6)}d   ${cells.join("  ")}`);
      }
    }
    const ref = run(data, turtle, baseGate, null, CORE8);
    console.log(
      `\nTham chiếu CORE8 cố định: toàn kỳ ${win(ref, w.from, w.to).sharpe.toFixed(2)} | ` +
        `365d ${win(ref, w.to - 365 * TF_MS["1d"], w.to).sharpe.toFixed(2)}`,
    );
  }

  // ───────────────────────── G2 — PLACEBO: bottom-N thanh khoản ─────────────────────────
  if (which === "all" || which === "g2") {
    console.log("\n" + "=".repeat(112));
    console.log("  G2 — PLACEBO: đảo chiều xếp hạng (bottom-N thanh khoản). Phải XẤU rõ.");
    console.log("=".repeat(112));
    console.log("sleeve   luật rổ            vị thế   Sharpe   NET R   maxDD   N/DD   era A/B/C        365d");
    console.log("-".repeat(112));
    for (const [name, p] of sleeves) {
      for (const [label, u] of [
        ["CORE8 cố định", null],
        ["top-10 thanh khoản", buildUniverse(data, 10, w.from, w.to, 90, 30, "top")],
        ["PLACEBO bottom-10", buildUniverse(data, 10, w.from, w.to, 90, 30, "bottom")],
      ] as [string, any][]) {
        const res = run(data, p, baseGate, u, u ? POOL46 : CORE8);
        const m = win(res, w.from, w.to);
        const eras = w.eras.map((e) => win(res, e.from, e.to).sharpe);
        const l365 = win(res, w.to - 365 * TF_MS["1d"], w.to);
        const pos = new Set(res.trades.map((t) => `${t.book}#${t.positionId}`)).size;
        console.log(
          `${name.padEnd(8)} ${label.padEnd(19)} ${String(pos).padStart(5)} ${m.sharpe.toFixed(2).padStart(7)} ` +
            `${m.netR.toFixed(0).padStart(7)} ${m.maxDD.toFixed(1).padStart(7)} ${m.netOverMaxDD.toFixed(2).padStart(6)}   ` +
            `${eras.map((x) => x.toFixed(2)).join("/")}   ${l365.sharpe.toFixed(2)}|${l365.netR.toFixed(0)}`,
        );
      }
      console.log("-".repeat(112));
    }
  }

  // ───────────────────────── G3 — WALK-FORWARD: 365d trượt theo tháng ─────────────────────────
  if (which === "all" || which === "g3") {
    console.log("\n" + "=".repeat(112));
    console.log("  G3 — WALK-FORWARD: mọi cửa sổ 365 ngày trượt theo tháng — top-10 vs CORE8");
    console.log("=".repeat(112));
    for (const [name, p] of sleeves) {
      const u = buildUniverse(data, 10, w.from, w.to, 90, 30);
      const rTop = run(data, p, baseGate, u, POOL46);
      const rRef = run(data, p, baseGate, null, CORE8);
      const MONTH = 30 * TF_MS["1d"];
      const YEAR = 365 * TF_MS["1d"];
      let winsTop = 0, total = 0, sumTop = 0, sumRef = 0, netTop = 0, netRef = 0;
      const perWin: { d: string; a: number; b: number }[] = [];
      for (let end = w.from + YEAR; end <= w.to; end += MONTH) {
        const a = win(rTop, end - YEAR, end);
        const b = win(rRef, end - YEAR, end);
        total++;
        if (a.sharpe > b.sharpe) winsTop++;
        sumTop += a.sharpe;
        sumRef += b.sharpe;
        netTop += a.netR;
        netRef += b.netR;
        perWin.push({ d: fmtD(end), a: a.sharpe, b: b.sharpe });
      }
      console.log(
        `${name}: ${total} cửa sổ · top-10 thắng ${winsTop} (${((winsTop / total) * 100).toFixed(0)}%) · ` +
          `Sharpe TB ${(sumTop / total).toFixed(2)} vs ${(sumRef / total).toFixed(2)} · ` +
          `NET R TB ${(netTop / total).toFixed(0)} vs ${(netRef / total).toFixed(0)}`,
      );
      // in thưa để thấy hình dạng theo thời gian
      console.log(
        "  " +
          perWin
            .filter((_, i) => i % 6 === 0)
            .map((x) => `${x.d.slice(2, 7)} ${x.a.toFixed(1)}/${x.b.toFixed(1)}`)
            .join("  "),
      );
    }
  }

  // ───────────────────────── G4 — QUY KẾT: lợi ích 365d đến từ đâu ─────────────────────────
  if (which === "all" || which === "g4") {
    console.log("\n" + "=".repeat(112));
    console.log("  G4 — QUY KẾT 365d: NET R theo coin (top-10 vs CORE8). Lợi ích KHÔNG được dồn vào 1 coin.");
    console.log("=".repeat(112));
    const from365 = w.to - 365 * TF_MS["1d"];
    for (const [name, p] of sleeves) {
      const u = buildUniverse(data, 10, w.from, w.to, 90, 30);
      for (const [label, res, tag] of [
        ["top-10", run(data, p, baseGate, u, POOL46), "T"],
        ["CORE8", run(data, p, baseGate, null, CORE8), "C"],
      ] as [string, { trades: UnitTrade[] }, string][]) {
        const by = new Map<string, number>();
        for (const t of res.trades) {
          if (t.entryTime < from365) continue;
          by.set(t.symbol, (by.get(t.symbol) ?? 0) + t.netR * t.weight);
        }
        const rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
        const tot = rows.reduce((s, r) => s + r[1], 0);
        const top1 = rows.length ? rows[0][1] : 0;
        console.log(
          `${name} ${label.padEnd(7)} tổng ${tot.toFixed(0).padStart(4)}R · coin tốt nhất ${top1.toFixed(0)}R ` +
            `(${tot > 0 ? ((top1 / tot) * 100).toFixed(0) : "—"}%) · ` +
            rows.slice(0, 8).map(([s, v]) => `${s.replace("usdt", "")} ${v.toFixed(0)}`).join(" · "),
        );
      }
      console.log("-".repeat(112));
    }
  }
}

if (require.main === module && /exp-universe-robust\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error("Lỗi:", e?.message ?? e);
    process.exit(1);
  });
}
