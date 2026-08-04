/**
 * exp-direction.ts — NGÂN SÁCH RỦI RO THEO HƯỚNG.
 *
 * SỰ THẬT ĐO ĐƯỢC (turtle-attribution.ts, 2.086 ngày, rổ 8 coin):
 *   long  : 1.198 unit, NET +1.342R, exp +1,120R/unit
 *   short : 1.501 unit, NET   +229R, exp +0,153R/unit
 *   exp short < exp long ở CẢ BA ERA (0,012 / 0,075 / 0,367 vs 1,274 / 0,428 / 1,945).
 *
 * CƠ CHẾ (nêu TRƯỚC khi test): crypto là lớp tài sản có drift dương dài hạn và đuôi phải dày
 * (short squeeze). Trend-following ở chiều short vì thế có edge mỏng hơn một cách CẤU TRÚC, không
 * phải do một chuỗi thua. Nhưng mỗi unit short vẫn tiêu tốn ĐÚNG một đơn vị rủi ro như unit long.
 * Phân bổ rủi ro bằng nhau cho hai chiều có edge chênh 7 lần là một quyết định danh mục SAI.
 *
 * ĐÂY KHÔNG PHẢI "gate short" (đã test là hại — bỏ lệnh theo điều kiện = fit điều kiện). Đây là
 * ngân sách rủi ro cố định theo chiều: MỌI lệnh short vẫn được vào, chỉ nhỏ size hơn.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-direction.ts [days]
 */
import { TF_MS } from "../strategy";
import { T, TurtleParams } from "../turtle";
import { AdmitFn, portfolioStats, riskMetrics, runTurtlePortfolio } from "./portfolio-engine";
import { buildGate, loadBasket } from "./portfolio-equivalence";

const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Ngân sách theo chiều × (tuỳ chọn) suy giảm theo heat cùng hướng. */
const dirPolicy = (shortW: number, decayK: number): AdmitFn => (c) => {
  const dw = c.dir === "short" ? shortW : 1;
  return decayK > 0 ? dw / (1 + c.sameDirHeat / decayK) : dw;
};

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  const data = await loadBasket(days);
  const gate = await buildGate(data, days);
  const base: TurtleParams = { ...T, gate };

  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const warmup = Math.max(Math.round(T.entryDays * bpd), Math.round(T.shortEntryDays * bpd), T.trendLen, T.atrPeriod) + 1;
  let from = -Infinity, to = Infinity;
  for (const c of data.values()) {
    from = Math.max(from, c[Math.min(warmup, c.length - 1)].openTime);
    to = Math.min(to, c[c.length - 1].openTime);
  }
  const eras = [0, 1, 2].map((k) => ({
    name: ["A", "B", "C"][k],
    from: from + ((to - from) * k) / 3,
    to: from + ((to - from) * (k + 1)) / 3,
  }));
  console.log(`Cửa sổ ${fmtD(from)} → ${fmtD(to)}\n`);

  const HDR = "biến thể".padEnd(28) + "unit".padStart(6) + "NET R".padStart(8) + "Sharpe".padStart(8) +
    "NET/Ulc".padStart(8) + "NET/DD".padStart(8) + "skew".padStart(7) + "wMon".padStart(7) + " | SharpeA      B      C";

  const run = (label: string, p: TurtleParams, admit?: AdmitFn) => {
    const res = runTurtlePortfolio(data, p, admit);
    const eq = res.equity.filter((e) => e.time >= from && e.time <= to);
    const rm = riskMetrics(eq);
    const st = portfolioStats(res, { from, to });
    const era = eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
    console.log(
      label.padEnd(28) + String(st.n).padStart(6) + rm.netR.toFixed(0).padStart(8) +
        rm.sharpe.toFixed(2).padStart(8) + rm.netOverUlcer.toFixed(1).padStart(8) +
        rm.netOverMaxDD.toFixed(2).padStart(8) + rm.skew.toFixed(2).padStart(7) +
        rm.worstMonthR.toFixed(0).padStart(7) + " |" + era.map((e) => e.sharpe.toFixed(2).padStart(7)).join(""),
    );
    return rm;
  };

  console.log("── A) NGÂN SÁCH RISK CHO SHORT (không decay) ──");
  console.log(HDR);
  console.log("-".repeat(110));
  for (const w of [1, 0.75, 0.5, 0.35, 0.25, 0.15, 0])
    run(`shortW=${w}`, base, w === 1 ? undefined : dirPolicy(w, 0));

  console.log("\n── B) NGÂN SÁCH RISK CHO SHORT × decay 1/(1+h/2) ──");
  console.log(HDR);
  console.log("-".repeat(110));
  for (const w of [1, 0.75, 0.5, 0.35, 0.25, 0.15, 0]) run(`shortW=${w} +decay2`, base, dirPolicy(w, 2));

  console.log("\n── C) decay k khác nhau tại shortW=0.5 (kiểm tra plateau 2 chiều) ──");
  console.log(HDR);
  console.log("-".repeat(110));
  for (const k of [1, 2, 3, 4, 6, 8, 12]) run(`shortW=0.5 +decay${k}`, base, dirPolicy(0.5, k));

  console.log("\n── D) LỐI THOÁT CHO SHORT (short đang 100% thoát bằng chandelier, giữ TB 2,2 ngày) ──");
  console.log(HDR);
  console.log("-".repeat(110));
  run("short exit=chandelier", base, dirPolicy(1, 2));
  run("short exit=mid", { ...base, shortExitMode: "mid" }, dirPolicy(1, 2));
  run("short chand 4.0×ATR", { ...base, chandelierMult: 4.0 }, dirPolicy(1, 2));
  run("short chand 5.0×ATR", { ...base, chandelierMult: 5.0 }, dirPolicy(1, 2));
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
