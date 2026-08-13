/**
 * fx-exotic-carry.ts — SỬA MỘT LỖI MÔ HÌNH nghiêm trọng trong fx-exotic.ts.
 *
 * Ở đó, chi phí giữ lệnh là một hằng số đối xứng 1,5%/năm — hợp lý cho G10 (chênh lệch lãi suất
 * 0–4%), nhưng SAI HOÀN TOÀN với ngoại vi. USDTRY tăng +2987% trong 22 năm chính là lệnh "short
 * lira", và giữ lệnh đó nghĩa là TRẢ lãi suất TRY (trung bình ~20%/năm, hiện tại 35,5%) để NHẬN
 * lãi suất USD (~2%). Đó không phải chi tiết kế toán: nó là gần như toàn bộ mức tăng của tỉ giá.
 * Đây đúng là cơ chế mà ngang giá lãi suất có phòng hộ mô tả — tỉ giá dịch chuyển để bù chênh lệch
 * lãi suất, nên "trend" của cặp lãi suất cao gần như không phải tiền.
 *
 * Ở đây swap được tính THEO CHIỀU và THEO THỜI ĐIỂM từ lãi suất thật (FRED), thay cho hằng số:
 *   long  USDXXX → nhận r_USD, trả r_XXX  ⇒ carry = (r_USD − r_XXX)/năm
 *   short USDXXX → ngược lại
 *   markup broker luôn TRỪ, bất kể chiều.
 * Quy về R: carryR = carry_năm × (số ngày giữ / 365) × (entry / |entry − SL|).
 * Nhân tử cuối là notional trên mỗi đơn vị R — với stop 3×ATR trên cặp biến động thấp, nó thường
 * là 30–80×, nên một chênh lệch lãi suất 15%/năm biến thành hàng chục phần trăm R mỗi tháng.
 *
 * Chạy: npx ts-node fx/fx-exotic-carry.ts
 */

import fs from "fs";
import path from "path";
import { CONFIG } from "../strategy";
import { T } from "../turtle";
import { PortfolioResult, riskMetrics } from "../scripts/portfolio-engine";
import { decayH, evaluate, windowOf } from "../scripts/rx-lab";
import { FX7, FX_SHARPE_ADJ, fxBooks, loadUniverse } from "./fx-transfer";
import { atSpeed, SPEEDS } from "./fx-speed";
import { EXOTICS } from "./fx-exotic";

const rates: Record<string, Record<string, number>> =
  JSON.parse(fs.readFileSync(path.join(process.cwd(), ".cache", "fx", "rates.json"), "utf8"));

/** Markup broker mỗi chiều, %/năm. Ngoại vi thực tế còn đắt hơn G10 nhiều. */
const MARKUP = 1.0;

function rateAt(ccy: string, ms: number): number | undefined {
  const m = rates[ccy];
  if (!m) return undefined;
  const d = new Date(ms);
  // lùi tối đa 6 tháng để bắt được chuỗi công bố trễ
  for (let k = 0; k < 6; k++) {
    const key = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)).toISOString().slice(0, 7);
    if (m[key] !== undefined) return m[key];
  }
  return undefined;
}

/** Tổng carry (theo R) của cả sổ, tính lại theo lãi suất thật thay cho hằng số của engine. */
function carryR(res: PortfolioResult): { total: number; perTrade: number; covered: number } {
  let total = 0, covered = 0;
  for (const t of res.trades) {
    const base = t.symbol.slice(0, 3), quote = t.symbol.slice(3, 6);
    const rb = rateAt(base, t.entryTime), rq = rateAt(quote, t.entryTime);
    if (rb === undefined || rq === undefined) continue;
    covered++;
    const net = (t.dir === "long" ? rb - rq : rq - rb) - MARKUP; // %/năm, markup luôn trừ
    const days = (t.exitTime - t.entryTime) / 86400e3;
    const notionalPerR = t.entryPrice / Math.abs(t.entryPrice - t.initialSL);
    total += (net / 100) * (days / 365) * notionalPerR * t.weight;
  }
  return { total, perTrade: res.trades.length ? total / res.trades.length : 0, covered: covered / Math.max(1, res.trades.length) };
}

function line(label: string, res: PortfolioResult, from: number, to: number) {
  const eq = res.equity.filter((e) => e.time >= from && e.time <= to);
  const rm = riskMetrics(eq);
  const c = carryR(res);
  const corrected = rm.netR + c.total;
  // Sharpe sau hiệu chỉnh: xấp xỉ bằng cách co giãn theo tỉ lệ NET (carry là dòng đều, gần như
  // không đổi độ lệch chuẩn ngày) — đủ để thấy dấu và bậc độ lớn.
  const sh = rm.netR !== 0 ? rm.sharpe * FX_SHARPE_ADJ * (corrected / rm.netR) : 0;
  console.log(
    label.padEnd(22) + rm.netR.toFixed(0).padStart(9) + c.total.toFixed(0).padStart(11) +
    corrected.toFixed(0).padStart(11) + sh.toFixed(2).padStart(9) +
    `${(c.covered * 100).toFixed(0)}%`.padStart(9),
  );
}

async function main() {
  // Tắt swap hằng số của engine để không tính hai lần.
  CONFIG.costs.fundingPer8hPct = 0;
  const heat = decayH(T.heatDecayK);

  console.log("═══ NGOẠI VI SAU KHI TÍNH ĐÚNG CHÊNH LỆCH LÃI SUẤT ═══");
  console.log(`Markup broker giả định ${MARKUP}%/năm mỗi chiều (thực tế ngoại vi còn đắt hơn).\n`);

  for (const [label, syms] of [["USDTRY/ZAR/MXN", EXOTICS], ["ĐỐI CHỨNG: 7 major USD", FX7]] as [string, string[]][]) {
    console.log(`─── ${label} ───`);
    console.log("tốc độ".padEnd(22) + "NET R (cũ)".padStart(9) + "carry thật".padStart(11) +
      "NET đúng".padStart(11) + "Sharpe".padStart(9) + "phủ".padStart(9));
    const w = windowOf(loadUniverse(syms), 60 * 8);
    for (const s of SPEEDS) {
      const r = evaluate(`s=${s}`, fxBooks(syms, atSpeed(s), `x${s}`), heat, w);
      line(`s=${s} (vào ${Math.round(15 * s)}d)`, r.res, w.from, w.to);
    }
    console.log();
  }

  console.log("Đọc bảng: 'NET R (cũ)' là con số của fx-exotic.ts khi swap là hằng số 1,5%/năm.");
  console.log("'carry thật' là chi phí/lợi ích lãi suất theo chiều lệnh và theo thời điểm.");
  console.log("Nếu cột đó nuốt gần hết NET, thì cái trông như trend chỉ là ngang giá lãi suất.");
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
