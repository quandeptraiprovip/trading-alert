/**
 * exp-exit-pyramid.ts — Ba hướng CHƯA TỪNG được test trong repo, đều có cơ chế nêu trước:
 *
 *  E1. TÁCH KÊNH THOÁT KHỎI KÊNH VÀO (Turtle gốc: vào 20d, ra 10d — hai số khác nhau).
 *      Engine hiện buộc chúng bằng nhau (`longMidClose` tính trên `dcEntry`). Attribution cho thấy
 *      100% lợi nhuận nằm ở 316 unit thoát bằng "mid" (exp +6,0R, giữ 17,9 ngày) → độ dài kênh
 *      thoát là tham số quan trọng NHẤT của hệ mà chưa ai chạm vào.
 *
 *  E2. SỐ UNIT PYRAMID > 4. Audit cũ chỉ test 1/2/3/4. Nhưng exp theo thứ tự unit là
 *      0,475 / 0,537 / 0,771 / 0,753 — unit THÊM tốt hơn unit đầu, nên trần 4 có thể đang cắt sớm.
 *      Trước đây không dám nới vì risk cộng dồn; với chính sách heat-decay thì risk đã tự khống chế.
 *
 *  E3. BƯỚC PYRAMID NHỎ HƠN. Audit cũ chỉ test 0,75–1,5×ATR (đều tệ hơn 0,5). Chiều ngược lại
 *      (0,25–0,4) chưa test.
 *
 * Chấm bằng Sharpe + ổn định 3 era, dưới CẢ hai chính sách risk để tách bạch tương tác.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-exit-pyramid.ts [days]
 */
import { TF_MS } from "../strategy";
import { T } from "../turtle";
import { AdmitFn, ExtParams, portfolioStats, riskMetrics, runBooks } from "./portfolio-engine";
import { buildGate, loadBasket, BASKET } from "./portfolio-equivalence";

const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const decay4: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / 4);

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  const data = await loadBasket(days);
  const gate = await buildGate(data, days);
  const base: ExtParams = { ...T, gate };

  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  // warmup theo biến thể DÀI NHẤT để mọi biến thể chấm trên cùng cửa sổ
  const warmup = Math.max(Math.round(90 * bpd), T.trendLen, T.atrPeriod) + 1;
  let from = -Infinity, to = Infinity;
  for (const c of data.values()) {
    from = Math.max(from, c[Math.min(warmup, c.length - 1)].openTime);
    to = Math.min(to, c[c.length - 1].openTime);
  }
  const eras = [0, 1, 2].map((k) => ({ name: ["A", "B", "C"][k], from: from + ((to - from) * k) / 3, to: from + ((to - from) * (k + 1)) / 3 }));
  console.log(`Cửa sổ ${fmtD(from)} → ${fmtD(to)}\n`);

  const HDR = "biến thể".padEnd(26) + "unit".padStart(6) + "NET R".padStart(8) + "Sharpe".padStart(8) +
    "NET/Ulc".padStart(8) + "NET/DD".padStart(8) + "exp/u".padStart(8) + "giữ(d)".padStart(8) + " | SharpeA      B      C";

  const run = (label: string, p: ExtParams, admit?: AdmitFn) => {
    const books = [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
    const res = runBooks(books, admit);
    const eq = res.equity.filter((e) => e.time >= from && e.time <= to);
    const rm = riskMetrics(eq);
    const st = portfolioStats(res, { from, to });
    const win = res.trades.filter((t) => t.entryTime >= from && t.entryTime <= to);
    const hold = win.length ? (win.reduce((s, t) => s + t.holdBars, 0) / win.length) / bpd : 0;
    const era = eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
    console.log(
      label.padEnd(26) + String(st.n).padStart(6) + rm.netR.toFixed(0).padStart(8) +
        rm.sharpe.toFixed(2).padStart(8) + rm.netOverUlcer.toFixed(1).padStart(8) +
        rm.netOverMaxDD.toFixed(2).padStart(8) + st.exp.toFixed(3).padStart(8) + hold.toFixed(1).padStart(8) +
        " |" + era.map((e) => e.sharpe.toFixed(2).padStart(7)).join(""),
    );
  };

  for (const [polName, admit] of [["BASELINE", undefined], ["decay 1/(1+h/4)", decay4]] as [string, AdmitFn | undefined][]) {
    console.log(`\n══ chính sách risk: ${polName} ══`);

    console.log("\n── E1. KÊNH THOÁT LONG (vào vẫn 15d) ──");
    console.log(HDR); console.log("-".repeat(112));
    for (const ex of [0, 8, 10, 15, 20, 25, 30, 45, 60])
      run(ex === 0 ? "exit=vào (15d, hiện tại)" : `exit ${ex}d`, { ...base, longExitDays: ex }, admit);

    console.log("\n── E2. TRẦN SỐ UNIT PYRAMID ──");
    console.log(HDR); console.log("-".repeat(112));
    for (const mu of [3, 4, 5, 6, 8, 10]) run(`maxUnits ${mu}`, { ...base, pyramidMaxUnits: mu }, admit);

    console.log("\n── E3. BƯỚC PYRAMID ──");
    console.log(HDR); console.log("-".repeat(112));
    for (const st of [0.25, 0.35, 0.5, 0.75, 1.0]) run(`step ${st}×ATR`, { ...base, pyramidStepAtr: st }, admit);
  }
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
