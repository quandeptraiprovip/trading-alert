/**
 * exp-concentration.ts — PHÉP KIỂM TẬP TRUNG, bổ sung vào cửa duyệt cạnh lệch-pha-nến.
 *
 * VÌ SAO CẦN, bằng một ca cụ thể: 13/08/2026, rổ trend chậm trên hàng hoá+chỉ số (nghiên cứu FX)
 * đậu TOÀN BỘ cửa duyệt đang có — nhiễu tham số 16/16 dương, bỏ-từng-công-cụ 10/10 dương, holdout
 * hai nửa đều dương, Sharpe dương cả ba era. Rồi hoá ra **66% lợi nhuận nằm trong đúng một năm**;
 * bỏ ra còn 2,8R/năm so với drawdown 61R. Bốn phép kiểm kia đều đậu vì **tất cả chúng đều bao gồm
 * năm đó** — không phép nào nhìn sự tập trung theo thời gian. Cùng vòng, một rổ khác có Sharpe 0,3
 * nhưng một công cụ chiếm 104% tổng.
 *
 * Ở đây áp cho hệ CRYPTO đang chạy tiền thật, nơi phép này chưa từng được chạy.
 *
 * HAI CÁI DỄ LÀM SAI, đã xử lý:
 *   - Chuỗi `res.equity` CHƯA lọc theo cửa sổ đánh giá sẽ gộp cả những năm nằm ngoài cửa sổ, làm
 *     tỉ lệ % sai hoàn toàn. Ở đây luôn lọc trước khi chia năm.
 *   - Chia theo năm phải dùng mark-to-market (đúng thời điểm P&L phát sinh), còn chia theo symbol
 *     buộc phải dùng trade (equity không mang nhãn symbol). Hai tổng vì thế lệch nhẹ — cả hai đều
 *     được in để chênh lệch không bị giấu.
 *
 * Chạy: npx ts-node scripts/exp-concentration.ts [số ngày]
 */

import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, PortfolioResult, riskMetrics, runBooks } from "./portfolio-engine";
import { decayH } from "./rx-lab";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";

/**
 * Ngưỡng loại. Cả hai đặt ở 50% với cùng một nghĩa: **không thành phần đơn lẻ nào được chiếm quá
 * nửa lợi nhuận** — dù là một năm hay một công cụ.
 *
 * Bản đầu tiên của file này để ngưỡng công cụ ở 100% và đã cho ĐẬU một rổ mà USDTRY chiếm 95%
 * (5 công cụ còn lại cộng lại ≈ 0). Một rổ như thế không phải chiến lược mà là một vị thế đơn lẻ,
 * nên ngưỡng đã siết lại.
 */
const YEAR_FAIL_PCT = 50;
const SYMBOL_FAIL_PCT = 50;

export interface ConcentrationReport {
  label: string;
  netEquity: number;
  netTrades: number;
  maxDD: number;
  byYear: [number, number][];
  bySymbol: [string, number][];
  pass: boolean;
}

export function concentration(
  label: string, res: PortfolioResult, from: number, to: number,
): ConcentrationReport {
  const eq = res.equity.filter((e) => e.time >= from && e.time <= to);
  const rm = riskMetrics(eq);

  const byYear = new Map<number, number>();
  for (let i = 1; i < eq.length; i++) {
    const y = new Date(eq[i].time).getUTCFullYear();
    byYear.set(y, (byYear.get(y) ?? 0) + (eq[i].mtm - eq[i - 1].mtm));
  }
  const bySymbol = new Map<string, number>();
  let netTrades = 0;
  for (const t of res.trades) {
    if (t.entryTime < from || t.entryTime > to) continue;
    const v = t.netR * t.weight;
    netTrades += v;
    bySymbol.set(t.symbol, (bySymbol.get(t.symbol) ?? 0) + v);
  }

  const years = [...byYear.entries()].sort((a, b) => a[0] - b[0]);
  const syms = [...bySymbol.entries()].sort((a, b) => b[1] - a[1]);
  const total = rm.netR;
  const topYear = [...years].sort((a, b) => b[1] - a[1]);
  const yearPct = total !== 0 ? (topYear[0]?.[1] ?? 0) / total * 100 : 0;
  const symPct = netTrades !== 0 ? (syms[0]?.[1] ?? 0) / netTrades * 100 : 0;

  console.log(`\n═══ ${label} ═══`);
  console.log(
    `NET R ${total.toFixed(0)} (theo equity) / ${netTrades.toFixed(0)} (theo trade) · maxDD ${rm.maxDD.toFixed(0)}R · ` +
    `Sharpe ${rm.sharpe.toFixed(2)} · ${years.length} năm`,
  );

  console.log("  theo NĂM:");
  for (const [y, v] of years) {
    const pct = total > 0 ? (v / total) * 100 : 0;
    console.log(
      `    ${y}  ${v >= 0 ? "+" : ""}${v.toFixed(1).padStart(8)}R` +
      `${v > 0 && total > 0 ? ` (${pct.toFixed(0)}% tổng)`.padStart(14) : "".padStart(14)}` +
      `  ${(v >= 0 ? "█" : "░").repeat(Math.min(40, Math.max(0, Math.round(Math.abs(v) / Math.max(1, Math.abs(total)) * 60))))}`,
    );
  }
  const t1 = topYear[0]?.[1] ?? 0, t2 = t1 + (topYear[1]?.[1] ?? 0);
  const rest = total - t1;
  const restPerYear = rest / Math.max(1, years.length - 1);
  // Chỉ số so sánh được GIỮA CÁC HỆ: sau khi bỏ năm may nhất, mỗi năm kiếm lại được bao nhiêu phần
  // của drawdown tệ nhất. 1,0 = một năm gỡ xong một drawdown. Đây là con số cần đặt cạnh nhau khi
  // cân nhắc chia vốn sang một nhánh mới.
  const recovery = rm.maxDD > 0 ? restPerYear / rm.maxDD : 0;
  console.log(
    `    → năm tốt nhất ${topYear[0]?.[0]}: ${yearPct.toFixed(0)}% tổng · hai năm tốt nhất: ` +
    `${total !== 0 ? (t2 / total * 100).toFixed(0) : "—"}% · BỎ năm đó ra: ${rest.toFixed(0)}R trên ` +
    `${years.length - 1} năm = ${restPerYear.toFixed(1)}R/năm vs maxDD ${rm.maxDD.toFixed(0)}R` +
    `  ⇒ hồi phục ${recovery.toFixed(2)} drawdown/năm`,
  );

  console.log("  theo CÔNG CỤ:");
  for (const [s, v] of syms) {
    console.log(`    ${s.padEnd(10)} ${v >= 0 ? "+" : ""}${v.toFixed(1).padStart(8)}R` +
      `${netTrades > 0 ? ` (${(v / netTrades * 100).toFixed(0)}%)`.padStart(9) : ""}`);
  }
  const restSym = netTrades - (syms[0]?.[1] ?? 0);
  console.log(`    → lớn nhất ${syms[0]?.[0]}: ${symPct.toFixed(0)}% tổng · BỎ ra: ${restSym.toFixed(0)}R`);

  // Tổng ÂM (hoặc ~0) thì câu hỏi "lãi dồn vào đâu" không có nghĩa — mọi tỉ lệ % đổi dấu và một
  // sổ đang LỖ sẽ được chấm ĐẬU. Bản đầu tiên của file này mắc đúng lỗi đó với rổ 7 major.
  const applicable = total > 0 && netTrades > 0;
  const pass = applicable && yearPct <= YEAR_FAIL_PCT && symPct <= SYMBOL_FAIL_PCT
    && rest > 0 && restSym > 0;
  console.log(
    `  KẾT LUẬN: ${!applicable ? "⚪ KHÔNG ÁP DỤNG (sổ không có lãi để nói về tập trung)" : pass ? "✅ ĐẬU" : "❌ RỚT"}` +
    `${applicable ? ` (ngưỡng: năm ≤ ${YEAR_FAIL_PCT}%, công cụ ≤ ${SYMBOL_FAIL_PCT}%, và cả hai phần còn lại > 0)` : ""}` +
    `${pass && yearPct > YEAR_FAIL_PCT * 0.9 ? `  ⚠️ năm tốt nhất ${yearPct.toFixed(0)}% SÁT ngưỡng` : ""}`,
  );
  return { label, netEquity: total, netTrades, maxDD: rm.maxDD, byYear: years, bySymbol: syms, pass };
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  console.log(`Nạp ${CORE8.length} symbol CORE8, ${days} ngày nến 4h...`);
  const data = await loadPool(days, CORE8);
  if (data.size < CORE8.length) {
    console.log(`⚠️  CHỈ nạp được ${data.size}/${CORE8.length} symbol — kết quả KHÔNG so được với các lần chạy khác.`);
  }

  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt — không dựng được BTC gate");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const heat: AdmitFn = decayH(T.heatDecayK);
  const w = coreWindow(data, T.btcGateSlow + 200);
  console.log(`Cửa sổ đánh giá: ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)}`);

  const bk = (p: typeof turtle, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));

  concentration("TURTLE trên CORE8 — SỔ ĐANG CÓ TIỀN THẬT", runBooks(bk(turtle, "t"), heat), w.from, w.to);
  concentration("FAST trên CORE8 — đang shadow, chưa bật lệnh thật", runBooks(bk(fast, "f"), heat), w.from, w.to);
  concentration("HAI SLEEVE CHẠY CHUNG", runBooks([...bk(turtle, "t"), ...bk(fast, "f")], heat), w.from, w.to);

  console.log(
    "\nGhi chú đọc kết quả: ĐẬU ở đây KHÔNG có nghĩa là chiến lược tốt — chỉ có nghĩa lợi nhuận\n" +
    "không dồn vào một năm hay một công cụ. RỚT thì mọi phép kiểm khác (perturbation, leave-one-out,\n" +
    "holdout, era) đều mất giá trị, vì chúng đều tính cả phần tập trung đó.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
