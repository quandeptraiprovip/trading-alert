/**
 * fx-carry.ts — ứng viên NGHIÊM TÚC CUỐI CÙNG cho câu hỏi "có phương pháp nào ăn được trên CẶP
 * TIỀN không". Trend đã bị loại hai lần bằng hai cơ chế khác nhau (fx-speed.ts, fx-native.ts).
 * Carry là nhân tố FX có bằng chứng học thuật mạnh nhất và cơ chế hoàn toàn khác: không dự đoán
 * hướng, mà thu chênh lệch lãi suất.
 *
 * NHƯNG có một chi tiết bán lẻ quyết định sống chết, và nó phải nằm trong mô hình chứ không phải
 * trong phần thảo luận: người bán lẻ KHÔNG nhận được chênh lệch lãi suất liên ngân hàng. Broker
 * ăn markup trên CẢ HAI chiều (thường 0,5–1,5%/năm mỗi chiều). Một cú carry 3%/năm trên giấy có
 * thể còn 0–2%/năm trong tài khoản. Vì thế mọi con số dưới đây được in ở 3 mức markup.
 *
 * Dữ liệu lãi suất: FRED, lãi suất liên ngân hàng 3 tháng (IR3TIB01…), theo THÁNG. Dùng giá trị
 * của THÁNG TRƯỚC để không nhìn trước.
 *
 * Chạy: npx ts-node fx/fx-carry.ts
 */

import fs from "fs";
import path from "path";
import https from "https";
import { FX7, loadDaily } from "./fx-transfer";

const RATE_SERIES: Record<string, string> = {
  USD: "IR3TIB01USM156N", EUR: "IR3TIB01EZM156N", JPY: "IR3TIB01JPM156N", GBP: "IR3TIB01GBM156N",
  CHF: "IR3TIB01CHM156N", AUD: "IR3TIB01AUM156N", CAD: "IR3TIB01CAM156N", NZD: "IR3TIB01NZM156N",
};
const CACHE = path.join(process.cwd(), ".cache", "fx", "rates.json");

/** Markup broker thu MỖI CHIỀU, %/năm trên notional. 0 = lý tưởng liên ngân hàng. */
const MARKUPS = [0, 0.5, 1.0, 1.5];
const VOL_WINDOW = 60;
const TARGET_VOL = 0.10;

function get(url: string): Promise<string> {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res(d));
    }).on("error", rej);
  });
}

/** {CCY: {"YYYY-MM": lãi suất %}} */
async function loadRates(): Promise<Record<string, Record<string, number>>> {
  if (fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  const out: Record<string, Record<string, number>> = {};
  for (const [ccy, id] of Object.entries(RATE_SERIES)) {
    const csv = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`);
    const m: Record<string, number> = {};
    for (const line of csv.split("\n").slice(1)) {
      const [d, v] = line.split(",");
      const x = parseFloat(v);
      if (d && Number.isFinite(x)) m[d.slice(0, 7)] = x;
    }
    out[ccy] = m;
    console.log(`  ${ccy}: ${Object.keys(m).length} tháng (${id})`);
  }
  fs.writeFileSync(CACHE, JSON.stringify(out));
  return out;
}

const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);
/** Tháng TRƯỚC tháng của `ms` — bản dữ liệu chắc chắn đã công bố tại thời điểm ra quyết định. */
function prevMonth(ms: number): string {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

interface Bar { openTime: number; close: number; spread: number }

/**
 * Carry theo CHUỖI THỜI GIAN: mỗi cặp, long nếu carry dương, short nếu âm, size vol-target,
 * rebalance đầu tháng. Lợi nhuận = biến động giá giao ngay + carry tích luỹ − markup − spread.
 */
function carryPnl(
  symbol: string, bars: Bar[], rates: Record<string, Record<string, number>>, markup: number,
): { time: number; net: number; carryOnly: number; spot: number }[] {
  const base = symbol.slice(0, 3), quote = symbol.slice(3, 6);
  const ret: number[] = [0];
  for (let i = 1; i < bars.length; i++) ret.push(Math.log(bars[i].close / bars[i - 1].close));

  const out: { time: number; net: number; carryOnly: number; spot: number }[] = [];
  let w = 0, carryRate = 0;
  for (let i = VOL_WINDOW + 1; i < bars.length; i++) {
    const isNewMonth = monthKey(bars[i - 1].openTime) !== monthKey(bars[i - 2].openTime);
    let turnover = 0;
    if (isNewMonth) {
      const mk = prevMonth(bars[i - 1].openTime);
      const rb = rates[base]?.[mk], rq = rates[quote]?.[mk];
      if (rb === undefined || rq === undefined) { w = 0; carryRate = 0; out.push({ time: bars[i].openTime, net: 0, carryOnly: 0, spot: 0 }); continue; }
      // Long BASEQUOTE thu (rb − rq); broker cắt `markup` bất kể chiều nào.
      const gross = rb - rq;
      const sig = Math.sign(gross);
      const win = ret.slice(i - VOL_WINDOW, i);
      const mean = win.reduce((s, x) => s + x, 0) / win.length;
      const sd = Math.sqrt(win.reduce((s, x) => s + (x - mean) ** 2, 0) / (win.length - 1));
      const annVol = sd * Math.sqrt(252);
      const target = annVol > 0 ? sig * Math.min(TARGET_VOL / annVol, 10) : 0;
      turnover = Math.abs(target - w);
      w = target;
      carryRate = (Math.abs(gross) - markup) / 100 / 252; // thu ròng mỗi ngày, theo tỉ lệ notional
    }
    const spreadFrac = bars[i - 1].spread / bars[i - 1].close;
    const carry = Math.abs(w) * carryRate;
    const spot = w * ret[i];
    out.push({ time: bars[i].openTime, net: spot + carry - turnover * spreadFrac, carryOnly: carry, spot });
  }
  return out;
}

function stats(p: number[], times: number[]) {
  const n = p.length;
  const mean = p.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(p.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  let cum = 0, peak = 0, maxDD = 0;
  for (const x of p) { cum += x; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  const byYear = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const y = new Date(times[i]).getUTCFullYear();
    byYear.set(y, (byYear.get(y) ?? 0) + p[i]);
  }
  const yrs = [...byYear.values()];
  return {
    annRet: mean * 252, annVol: sd * Math.sqrt(252), sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0,
    maxDD, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    posYears: yrs.filter((v) => v > 0).length, nYears: yrs.length,
  };
}

async function main() {
  console.log("═══ CARRY TRÊN CẶP TIỀN — nhân tố FX có bằng chứng mạnh nhất ═══");
  console.log("Nạp lãi suất liên ngân hàng 3 tháng (FRED):");
  const rates = await loadRates();

  console.log(
    "\nmarkup/chiều".padEnd(14) + "annRet".padStart(8) + "annVol".padStart(8) + "Sharpe".padStart(8) +
    "maxDD".padStart(8) + "t-stat".padStart(8) + "năm+".padStart(8) + "   | phần carry  phần giá",
  );
  for (const markup of MARKUPS) {
    const perDay = new Map<number, { n: number; c: number; s: number }>();
    for (const sym of FX7) {
      for (const p of carryPnl(sym, loadDaily(sym) as Bar[], rates, markup)) {
        const d = Math.floor(p.time / 86400e3);
        const e = perDay.get(d) ?? { n: 0, c: 0, s: 0 };
        e.n += p.net; e.c += p.carryOnly; e.s += p.spot;
        perDay.set(d, e);
      }
    }
    const days = [...perDay.keys()].sort((a, b) => a - b);
    const times = days.map((d) => d * 86400e3);
    const r = stats(days.map((d) => perDay.get(d)!.n / FX7.length), times);
    const carryPart = days.reduce((s, d) => s + perDay.get(d)!.c / FX7.length, 0) / days.length * 252;
    const spotPart = days.reduce((s, d) => s + perDay.get(d)!.s / FX7.length, 0) / days.length * 252;
    console.log(
      `${markup.toFixed(1)}%/năm`.padEnd(14) +
      `${(r.annRet * 100).toFixed(1)}%`.padStart(8) + `${(r.annVol * 100).toFixed(1)}%`.padStart(8) +
      r.sharpe.toFixed(2).padStart(8) + `${(r.maxDD * 100).toFixed(0)}%`.padStart(8) +
      r.t.toFixed(2).padStart(8) + `${r.posYears}/${r.nYears}`.padStart(8) +
      `   | ${(carryPart * 100).toFixed(1)}%      ${(spotPart * 100).toFixed(1)}%`,
    );
  }
  console.log(
    "\n'phần carry' = lãi suất thu được; 'phần giá' = lời/lỗ do tỉ giá dịch chuyển.\n" +
    "Nếu phần giá ÂM và nuốt gần hết phần carry ⇒ đúng bản chất đã biết của carry: ăn đều đặn\n" +
    "rồi trả lại một lần khi tỉ giá đảo (crash risk), chứ không phải một dòng tiền miễn phí.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
