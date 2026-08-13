/**
 * exp-side-risk.ts — 2026-08-10. Hướng CHƯA thử: không LỌC bớt lệnh (đã loại nhiều lần) mà chỉnh
 * TỈ TRỌNG RISK giữa hai bên.
 *
 * Số liệu nền (chop-diagnosis.ts gate, 2.026 ngày):
 *   LONG   834u  exp +1,27R/unit   (39% số unit)
 *   SHORT 1316u  exp +0,16R/unit   (61% số unit)
 * Tức phần lớn risk đang chảy vào bên có expectancy thấp hơn 8 lần. Nhưng CẮT short thì maxDD TĂNG
 * (short là hedge cho sổ long) — đã đo ở `exp-short-gate.ts`. Vậy câu hỏi đúng là: **giảm size**
 * short xuống bao nhiêu thì tốt nhất, chứ không phải bỏ short.
 *
 * `AdmitFn` của engine trả về TRỌNG SỐ (không phải bool) nên mô phỏng được đúng lớp sizing live
 * (`TurtleLive.heatWeight`).
 *
 * Kỷ luật: một tham số duy nhất, phải có plateau, cả 3 era không xấu đi, chấm bằng Sharpe +
 * NET/maxDD (bất biến đòn bẩy) chứ không phải NET R thô.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-side-risk.ts [days]
 */
import { TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, ExtParams, PortfolioResult, riskMetrics, runBooks } from "./portfolio-engine";
import { loadData, windowOf, books, fmtD } from "./rx-lab";
import { liveSleeves } from "./chop-diagnosis";

const DAY = TF_MS["1d"];
const heat = (k: number): AdmitFn => (c) => (k > 0 ? 1 / (1 + c.sameDirHeat / k) : 1);

/** heat-decay như production, nhân thêm hệ số size riêng cho mỗi bên. */
const sideAdmit = (k: number, kLong: number, kShort: number): AdmitFn => (c) =>
  heat(k)(c) * (c.dir === "long" ? kLong : kShort);

interface Row {
  label: string;
  sharpe: number;
  net: number;
  maxDD: number;
  netDd: number;
  eraSharpe: number[];
  eraNet: number[];
  res: PortfolioResult;
}

function scoreOf(label: string, res: PortfolioResult, w: ReturnType<typeof windowOf>): Row {
  const m = riskMetrics(res.equity.filter((e) => e.time >= w.from && e.time <= w.to));
  const eras = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
  return {
    label,
    sharpe: m.sharpe,
    net: m.netR,
    maxDD: m.maxDD,
    netDd: m.netOverMaxDD,
    eraSharpe: eras.map((x) => x.sharpe),
    eraNet: eras.map((x) => x.netR),
    res,
  };
}

const HDR =
  "biến thể".padEnd(26) + "NET R".padStart(8) + "maxDD".padStart(8) + "NET/DD".padStart(8) + "Sharpe".padStart(8) +
  "  | Sharpe A/B/C        | NET tđ (cùng maxDD)";

function printRow(r: Row, base?: Row) {
  const norm = base && r.maxDD > 0 ? (r.net * base.maxDD) / r.maxDD : undefined;
  const pct = base && norm !== undefined ? ((norm - base.net) / Math.abs(base.net)) * 100 : undefined;
  console.log(
    r.label.padEnd(26) + r.net.toFixed(0).padStart(8) + r.maxDD.toFixed(1).padStart(8) +
      r.netDd.toFixed(2).padStart(8) + r.sharpe.toFixed(2).padStart(8) + "  |" +
      r.eraSharpe.map((s) => s.toFixed(2).padStart(7)).join("") +
      (norm !== undefined ? `   ${norm.toFixed(0).padStart(6)}  (${pct! >= 0 ? "+" : ""}${pct!.toFixed(0)}%)` : ""),
  );
}

const WINS = [180, 365, 545, 730, 1095];

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadData(days);
  const btc = data.get("btcusdt")!;
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const sleeves = liveSleeves(gate);
  const w = windowOf(data, T.btcGateSlow + 130);
  console.log(`\nCửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} (${((w.to - w.from) / DAY).toFixed(0)} ngày)`);
  console.log(`Era A ${fmtD(w.eras[0].from)}→${fmtD(w.eras[0].to)} · B →${fmtD(w.eras[1].to)} · C →${fmtD(w.eras[2].to)}\n`);

  for (const name of ["turtle", "fast"] as const) {
    const p: ExtParams = sleeves[name];
    // Fast hiện KHÔNG có heat live; giữ đúng production để so sánh công bằng.
    const k = name === "turtle" ? T.heatDecayK : 0;
    const run = (kL: number, kS: number) => runBooks(books(data, p), sideAdmit(k, kL, kS));

    console.log("=".repeat(122));
    console.log(`  ${name.toUpperCase()} — quét hệ số size của SHORT (long giữ 1,0). heat k=${k || "TẮT"} như production`);
    console.log("=".repeat(122));
    console.log(HDR);
    console.log("-".repeat(122));
    const base = scoreOf("BASE short×1,00 (live)", run(1, 1), w);
    printRow(base);
    const rows: Row[] = [];
    for (const kS of [0.25, 0.4, 0.5, 0.6, 0.75, 1.25, 1.5]) {
      const r = scoreOf(`short×${kS.toFixed(2)}`, run(1, kS), w);
      rows.push(r);
      printRow(r, base);
    }

    console.log(`\n  ${name.toUpperCase()} — quét hệ số size của LONG (short giữ 1,0):`);
    console.log(HDR);
    console.log("-".repeat(122));
    printRow(base);
    for (const kL of [0.5, 0.75, 1.25, 1.5, 2.0]) {
      printRow(scoreOf(`long×${kL.toFixed(2)}`, run(kL, 1), w), base);
    }

    // cửa sổ trượt cho vài ứng viên
    console.log(`\n  ${name.toUpperCase()} — cửa sổ trượt (Sharpe|NET R), kiểm tra 12-18 tháng gần nhất:`);
    console.log("  " + "biến thể".padEnd(24) + WINS.map((d) => `${d}d`.padStart(14)).join(""));
    for (const [label, kL, kS] of [["BASE 1,00/1,00", 1, 1], ["short×0,50", 1, 0.5], ["short×0,75", 1, 0.75], ["long×1,50", 1.5, 1]] as [string, number, number][]) {
      const res = run(kL, kS);
      console.log(
        "  " + label.padEnd(24) +
          WINS.map((d) => {
            const m = riskMetrics(res.equity.filter((e) => e.time >= w.to - d * DAY));
            return `${m.sharpe.toFixed(2)}|${m.netR.toFixed(0)}`.padStart(14);
          }).join(""),
      );
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
