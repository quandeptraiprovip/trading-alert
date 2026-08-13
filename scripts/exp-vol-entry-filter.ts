/**
 * exp-vol-entry-filter.ts — 2026-08-10. Hiệu ứng LỚN nhất đo được trong `chop-diagnosis.ts cost`:
 *
 *   Chia 2.150 unit Turtle thành 5 nhóm theo ATR20%/giá LÚC VÀO:
 *     Q1 0,6-1,7%  net 1,072R/unit      Q4 2,7-3,5%  net 0,309R/unit
 *     Q2 1,7-2,2%  net 0,853R/unit      Q5 3,5-21%   net 0,298R/unit
 *     Q3 2,2-2,7%  net 0,839R/unit
 *   (Fast gần như y hệt: 0,964 / 0,753 / 0,834 / 0,252 / 0,364.)
 *
 * Cơ chế: breakout xuất phát từ nền BIẾN ĐỘNG THẤP (tích luỹ) có dư địa mở rộng; breakout khi biến
 * động ĐÃ phình thì phần lớn quãng đường đã đi, và stop 3×ATR lúc đó rất rộng nên cùng 1R phải đi xa hơn.
 *
 * Không phải chỉ báo mới (ADX/ER/volume đã bị loại) — đây là ATR đã có trong hệ, dùng làm điều kiện VÀO.
 * Đối chứng cần thiết: hiệu ứng có thể chỉ là 2021 (ATR cao) trộn lẫn — nên bắt buộc xem cả 3 era,
 * plateau ngưỡng, và bản TƯƠNG ĐỐI (so ATR với chính nó 90 nến trước) vốn miễn nhiễm với regime.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-vol-entry-filter.ts [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs, atrSeries } from "../turtle";
import { AdmitCtx, AdmitFn, ExtParams, PortfolioResult, riskMetrics, runBooks } from "./portfolio-engine";
import { loadData, windowOf, books, fmtD } from "./rx-lab";
import { liveSleeves } from "./chop-diagnosis";

const DAY = TF_MS["1d"];
const REL_LOOKBACK = 90; // nến 4h = 15 ngày, dùng cho bản TƯƠNG ĐỐI

interface VolFeat { atrPct: number; rel: number }

/** atrPct và tỉ lệ ATR/median(ATR 90 nến TRƯỚC đó) cho từng (symbol, openTime) — không lookahead. */
function volFeatures(data: Map<string, Candle[]>): Map<string, Map<number, VolFeat>> {
  const out = new Map<string, Map<number, VolFeat>>();
  for (const [sym, c] of data) {
    const a = atrSeries(c, T.atrPeriod);
    const m = new Map<number, VolFeat>();
    for (let i = 0; i < c.length; i++) {
      let rel = 1;
      if (i >= REL_LOOKBACK) {
        const prev = a.slice(i - REL_LOOKBACK, i).filter((x) => x > 0).sort((x, y) => x - y);
        const med = prev.length ? prev[Math.floor(prev.length / 2)] : 0;
        rel = med > 0 ? a[i] / med : 1;
      }
      m.set(c[i].openTime, { atrPct: (a[i] / c[i].close) * 100, rel });
    }
    out.set(sym, m);
  }
  return out;
}

const heat = (k: number): AdmitFn => (c) => (k > 0 ? 1 / (1 + c.sameDirHeat / k) : 1);

/** Lọc chỉ áp cho lệnh MỞ MỚI (`entry`); pyramid add của trend đang chạy không bị chặn. */
function volAdmit(
  feats: Map<string, Map<number, VolFeat>>,
  k: number,
  test: (f: VolFeat) => boolean,
  alsoAdds = false,
): AdmitFn {
  return (c: AdmitCtx) => {
    const h = heat(k)(c);
    if (c.kind === "add" && !alsoAdds) return h;
    const f = feats.get(c.symbol)?.get(c.time);
    if (!f) return h;
    return test(f) ? h : 0;
  };
}

interface Row { label: string; net: number; maxDD: number; netDd: number; sharpe: number; era: number[]; eraNet: number[]; units: number; res: PortfolioResult }

function scoreOf(label: string, res: PortfolioResult, w: ReturnType<typeof windowOf>): Row {
  const m = riskMetrics(res.equity.filter((e) => e.time >= w.from && e.time <= w.to));
  const eras = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
  return {
    label,
    net: m.netR,
    maxDD: m.maxDD,
    netDd: m.netOverMaxDD,
    sharpe: m.sharpe,
    era: eras.map((x) => x.sharpe),
    eraNet: eras.map((x) => x.netR),
    units: res.trades.filter((t) => t.entryTime >= w.from).length,
    res,
  };
}

const HDR =
  "biến thể".padEnd(28) + "unit".padStart(6) + "NET R".padStart(8) + "maxDD".padStart(8) + "N/DD".padStart(7) +
  "Sharpe".padStart(8) + "  | Sharpe A/B/C        | NETtđ (cùng maxDD)";

function printRow(r: Row, base?: Row) {
  const norm = base && r.maxDD > 0 ? (r.net * base.maxDD) / r.maxDD : undefined;
  const pct = base && norm !== undefined ? ((norm - base.net) / Math.abs(base.net)) * 100 : undefined;
  console.log(
    r.label.padEnd(28) + String(r.units).padStart(6) + r.net.toFixed(0).padStart(8) + r.maxDD.toFixed(1).padStart(8) +
      r.netDd.toFixed(2).padStart(7) + r.sharpe.toFixed(2).padStart(8) + "  |" +
      r.era.map((s) => s.toFixed(2).padStart(7)).join("") +
      (norm !== undefined ? `   ${norm.toFixed(0).padStart(6)} (${pct! >= 0 ? "+" : ""}${pct!.toFixed(0)}%)` : ""),
  );
}

const WINS = [180, 365, 545, 730, 1095];
function winCells(res: PortfolioResult, to: number): string {
  return WINS.map((d) => {
    const m = riskMetrics(res.equity.filter((e) => e.time >= to - d * DAY));
    return `${m.sharpe.toFixed(2)}|${m.netR.toFixed(0)}`.padStart(14);
  }).join("");
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadData(days);
  const btc = data.get("btcusdt")!;
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const sleeves = liveSleeves(gate);
  const w = windowOf(data, T.btcGateSlow + 130);
  const feats = volFeatures(data);

  console.log(`\nCửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} (${((w.to - w.from) / DAY).toFixed(0)} ngày)`);
  console.log(`Era A ${fmtD(w.eras[0].from)}→${fmtD(w.eras[0].to)} · B →${fmtD(w.eras[1].to)} · C →${fmtD(w.eras[2].to)}`);
  console.log(`Lọc chỉ áp cho lệnh MỞ MỚI. Bản tương đối so ATR với median ${REL_LOOKBACK} nến trước (${REL_LOOKBACK / 6} ngày).\n`);

  for (const name of ["turtle", "fast"] as const) {
    const p: ExtParams = sleeves[name];
    const k = name === "turtle" ? T.heatDecayK : 0;
    const run = (test?: (f: VolFeat) => boolean, alsoAdds = false) =>
      runBooks(books(data, p), test ? volAdmit(feats, k, test, alsoAdds) : heat(k));

    console.log("=".repeat(126));
    console.log(`  ${name.toUpperCase()} — A) ngưỡng TUYỆT ĐỐI: chỉ mở mới khi ATR20%/giá ≤ X`);
    console.log("=".repeat(126));
    console.log(HDR);
    console.log("-".repeat(126));
    const base = scoreOf("BASE không lọc (live)", run(), w);
    printRow(base);
    for (const x of [1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0]) {
      printRow(scoreOf(`ATR% ≤ ${x.toFixed(1)}`, run((f) => f.atrPct <= x), w), base);
    }

    console.log(`\n  ${name.toUpperCase()} — B) ngưỡng TƯƠNG ĐỐI: chỉ mở mới khi ATR ≤ m × median(ATR 90 nến trước)`);
    console.log(HDR);
    console.log("-".repeat(126));
    printRow(base);
    for (const m of [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4]) {
      printRow(scoreOf(`ATR ≤ ${m.toFixed(1)}× median`, run((f) => f.rel <= m), w), base);
    }

    console.log(`\n  ${name.toUpperCase()} — cửa sổ trượt (Sharpe|NET R) cho vài ứng viên:`);
    console.log("  " + "biến thể".padEnd(26) + WINS.map((d) => `${d}d`.padStart(14)).join(""));
    console.log("  " + "BASE".padEnd(26) + winCells(base.res, w.to));
    for (const [label, test] of [
      ["ATR% ≤ 2,5", (f: VolFeat) => f.atrPct <= 2.5],
      ["ATR% ≤ 3,0", (f: VolFeat) => f.atrPct <= 3.0],
      ["ATR ≤ 1,0× median", (f: VolFeat) => f.rel <= 1.0],
      ["ATR ≤ 1,2× median", (f: VolFeat) => f.rel <= 1.2],
    ] as [string, (f: VolFeat) => boolean][]) {
      console.log("  " + label.padEnd(26) + winCells(run(test), w.to));
    }
    console.log();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Lỗi:", e?.response?.data ?? e);
    process.exit(1);
  });
}
