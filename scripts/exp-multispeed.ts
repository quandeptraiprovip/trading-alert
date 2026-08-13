/**
 * exp-multispeed.ts — ENSEMBLE NHIỀU TỐC ĐỘ: thay vì một kênh vào 15 ngày, chạy song song nhiều
 * kênh (10/15/25/40 ngày), mỗi kênh mang 1/K tỉ trọng risk.
 *
 * VÌ SAO ĐÂY LÀ HƯỚNG CHỐNG OVERFIT (không phải thêm tham số): trong managed futures, ensemble tốc
 * độ là cách chuẩn để KHỎI PHẢI CHỌN tốc độ đúng. Rủi ro lớn nhất của hệ hiện tại không phải là
 * 15 ngày sai, mà là 15 ngày được chọn bằng dữ liệu quá khứ và có thể không còn là tốc độ đúng của
 * chu kỳ tới. Trung bình hoá nhiều tốc độ làm phẳng rủi ro đó — đổi lại một chút hiệu suất đỉnh.
 * Tham chiếu: Baltas & Kosowski (2013) về trộn tốc độ trong quỹ trend; cùng logic với việc repo này
 * đã chọn plateau thay vì argmax.
 *
 * ĐIỀU KIỆN NHẬN (định trước):
 *   - Sharpe toàn kỳ KHÔNG được kém baseline quá 0,05 VÀ
 *   - phải thắng ở tiêu chí ổn định: cải thiện Sharpe TB trên 56 cửa sổ 365 ngày trượt, HOẶC
 *     giảm độ phân tán giữa các era (đó chính là thứ ensemble được kỳ vọng mua).
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-multispeed.ts [days]
 */
import { TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, riskMetrics, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

/** heat-decay chuẩn nhưng chia đều tỉ trọng cho K tốc độ ⇒ tổng risk danh mục giữ nguyên. */
const decayScaled = (k: number, K: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k) / K;

const win = (res: any, from: number, to: number) => riskMetrics(res.equity.filter((e: any) => e.time >= from && e.time <= to));

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadPool(days, CORE8);
  const baseGate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(baseGate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  const YEAR = 365 * TF_MS["1d"];
  const MONTH = 30 * TF_MS["1d"];
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · ${data.size} coin · heat k=${T.heatDecayK}\n`);

  const ENSEMBLES: [string, number[]][] = [
    ["15d (Turtle đang chạy)", [15]],
    ["10d (Fast đang chạy)", [10]],
    ["25d", [25]],
    ["40d", [40]],
    ["10+15", [10, 15]],
    ["10+20+40", [10, 20, 40]],
    ["10+15+25", [10, 15, 25]],
    ["10+15+25+40", [10, 15, 25, 40]],
    ["15+40", [15, 40]],
    ["8+15+30+60", [8, 15, 30, 60]],
  ];

  for (const [sleeveName, base] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
    console.log("=".repeat(120));
    console.log(`  ${sleeveName} — ensemble tốc độ (mỗi tốc độ mang 1/K risk; kênh THOÁT giữ nguyên production)`);
    console.log("=".repeat(120));
    console.log("tốc độ                 vịthế  Sharpe   NET R   maxDD   N/DD   era A/B/C        độ lệch era   730d      365d     WF TB");
    console.log("-".repeat(120));
    for (const [label, speeds] of ENSEMBLES) {
      const bs: Book[] = [];
      for (const sp of speeds) {
        for (const [sym, candles] of data) {
          bs.push({ key: `${sym}@${sp}`, symbol: sym, candles, p: { ...base, entryDays: sp } });
        }
      }
      const res = runBooks(bs, decayScaled(T.heatDecayK, speeds.length));
      const m = win(res, w.from, w.to);
      const eras = w.eras.map((e) => win(res, e.from, e.to).sharpe);
      const eraSd = Math.sqrt(eras.reduce((s, x) => s + (x - eras.reduce((a, b) => a + b, 0) / 3) ** 2, 0) / 3);
      const l730 = win(res, w.to - 730 * TF_MS["1d"], w.to);
      const l365 = win(res, w.to - YEAR, w.to);
      const wf: number[] = [];
      for (let end = w.from + YEAR; end <= w.to; end += MONTH) wf.push(win(res, end - YEAR, end).sharpe);
      const pos = new Set(res.trades.map((t: any) => `${t.book}#${t.positionId}`)).size;
      console.log(
        `${label.padEnd(22)} ${String(pos).padStart(5)} ${m.sharpe.toFixed(2).padStart(7)} ${m.netR.toFixed(0).padStart(7)} ` +
          `${m.maxDD.toFixed(1).padStart(7)} ${m.netOverMaxDD.toFixed(2).padStart(6)}   ${eras.map((x) => x.toFixed(2)).join("/")}   ` +
          `${eraSd.toFixed(3).padStart(11)}   ${l730.sharpe.toFixed(2)}|${String(l730.netR.toFixed(0)).padStart(3)}  ` +
          `${l365.sharpe.toFixed(2)}|${String(l365.netR.toFixed(0)).padStart(3)}   ${(wf.reduce((s, x) => s + x, 0) / wf.length).toFixed(2)}`,
      );
    }
    console.log();
  }
}

if (require.main === module && /exp-multispeed\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error("Lỗi:", e?.message ?? e);
    process.exit(1);
  });
}
