/**
 * exp-breakeven.ts — 15/08/2026. Kiểm chứng ĐỀ XUẤT CỦA CHÍNH USER trong playbook feedback:
 *
 *   turtle-13-0-1782806400000 · "lệnh này cũng đã bị quét, nhưng lệnh này cần dịch SL xuống entry
 *   thì sẽ đỡ bị thua hơn"
 *
 * Đây là luật THOÁT, không phải luật vào — và theo `indicator-families-rejected` vòng 4-5, edge của
 * hệ nằm ở khâu THOÁT chứ không ở khâu VÀO. Grep toàn bộ `exp-exit-*` cho thấy breakeven CHƯA TỪNG
 * được đo cho Turtle/Fast, nên đây là hướng còn trống thật sự.
 *
 * Luật: khi cực trị đã đi thuận ≥ k × R (R của unit đầu), kéo stop cứng về giá vào của unit đầu.
 *
 * CÁI BẪY PHẢI ĐỀ PHÒNG: breakeven gần như LUÔN cải thiện win-rate và maxDD, nhưng nó cắt cụt đuôi
 * phải — mà toàn bộ lợi nhuận của hệ trend nằm ở đuôi phải (`return-concentration-uptime`: 1% số
 * ngày mang 68% lợi nhuận). Vì vậy đọc theo NET và Sharpe, KHÔNG đọc theo win-rate.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-breakeven.ts [days]
 */
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, UnitTrade, riskMetrics, runBooks } from "./portfolio-engine";
import { decayH } from "./rx-lab";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";

interface Row {
  label: string;
  units: number;
  net: number;
  netLong: number;
  netShort: number;
  wr: number;
  sharpe: number;
  maxDD: number;
  netDd: number;
  era: number[];
}

function score(label: string, res: PortfolioResult, w: ReturnType<typeof coreWindow>): Row {
  const inWin = (t: UnitTrade) => t.entryTime >= w.from && t.entryTime <= w.to;
  const ts = res.trades.filter(inWin);
  const eq = res.equity.filter((e) => e.time >= w.from && e.time <= w.to);
  const m = riskMetrics(eq);
  const netOf = (d: "long" | "short") => ts.filter((t) => t.dir === d).reduce((s, t) => s + t.netR * t.weight, 0);
  return {
    label,
    units: ts.length,
    net: m.netR,
    netLong: netOf("long"),
    netShort: netOf("short"),
    wr: ts.length ? (100 * ts.filter((t) => t.netR > 0).length) / ts.length : 0,
    sharpe: m.sharpe,
    maxDD: m.maxDD,
    netDd: m.netOverMaxDD,
    era: w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)).sharpe),
  };
}

function printRow(r: Row, base?: Row) {
  const d = base && base !== r ? ` (${r.net >= base.net ? "+" : ""}${(r.net - base.net).toFixed(0)}R)` : "";
  console.log(
    r.label.padEnd(30) +
      String(r.units).padStart(7) +
      r.net.toFixed(0).padStart(8) +
      r.netLong.toFixed(0).padStart(9) +
      r.netShort.toFixed(0).padStart(9) +
      `${r.wr.toFixed(1)}%`.padStart(8) +
      r.sharpe.toFixed(3).padStart(8) +
      r.maxDD.toFixed(1).padStart(9) +
      r.netDd.toFixed(2).padStart(8) +
      "  " + r.era.map((x) => x.toFixed(2)).join(" / ") + d,
  );
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt — không dựng được BTC gate");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  const heat: AdmitFn = decayH(T.heatDecayK);
  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));
  const run = (be: number, tag: string, dir?: "long" | "short") => {
    const add = be ? { breakevenAtR: be, breakevenDir: dir } : {};
    return runBooks([...bk({ ...turtle, ...add }, `t${tag}`), ...bk({ ...fast, ...add }, `f${tag}`)], heat);
  };

  console.log(
    `Cửa sổ ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)} · ` +
      `${data.size} coin · HAI sleeve (Turtle + Fast), heat k=${T.heatDecayK}\n`,
  );
  console.log(
    "luật".padEnd(30) + "unit".padStart(7) + "NET R".padStart(8) + "NETlong".padStart(9) + "NETshort".padStart(9) +
      "WR".padStart(8) + "Sharpe".padStart(8) + "maxDD_R".padStart(9) + "NET/DD".padStart(8) + "  era A/B/C",
  );
  console.log("─".repeat(126));

  const base = score("ĐANG CHẠY (không breakeven)", run(0, "0"), w);
  printRow(base);
  for (const be of [0.5, 1.0, 1.5, 2.0, 3.0]) {
    printRow(score(`dịch SL về entry sau ${be.toFixed(1)}R`, run(be, String(be)), w), base);
  }

  console.log("\nCHỈ SHORT (đúng dạng note của user — lệnh turtle-13-0 là lệnh short):");
  for (const be of [0.5, 1.0, 1.5, 2.0]) {
    printRow(score(`SHORT: SL về entry sau ${be.toFixed(1)}R`, run(be, `s${be}`, "short"), w), base);
  }

  console.log(
    "\nWin-rate tăng mà NET giảm là dấu hiệu KINH ĐIỂN của việc cắt cụt đuôi phải, không phải cải\n" +
      "thiện. Chỉ khi NET và Sharpe cùng tăng mới đáng đưa tiếp qua cửa lệch pha nến + tập trung năm.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
