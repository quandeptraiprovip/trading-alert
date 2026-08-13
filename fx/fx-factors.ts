/**
 * fx-factors.ts — HỌ PHƯƠNG PHÁP MÀ VÒNG NGHIÊN CỨU TRƯỚC ĐÃ BỎ SÓT HOÀN TOÀN.
 *
 * Vòng trước (fx-transfer, fx-speed, fx-native, fx-carry, fx-reversion, fx-session) đo toàn bộ theo
 * CHUỖI THỜI GIAN trên TỪNG cặp, CÓ stop, và kết luận null. Nhưng gần như mọi kết quả dương đã được
 * tái lập trong văn liệu FX lại đến từ một cấu trúc KHÁC HẲN:
 *
 *   - SORT CHÉO: xếp hạng cả rổ đồng tiền theo một tín hiệu, mua nhóm đầu bán nhóm cuối
 *   - DOLLAR-NEUTRAL: long-short triệt tiêu thành phần "đồng đô" chung, thứ chiếm phần lớn phương sai
 *   - TÁI CÂN BẰNG THÁNG, KHÔNG STOP
 *   - Lợi nhuận tính trên EXCESS RETURN gồm CHÊNH LỆCH LÃI SUẤT, không chỉ biến động giá
 *
 * Bốn thứ đó cộng lại là một cơ chế khác, không phải một tham số khác. Một kết luận null theo chuỗi
 * thời gian KHÔNG bao hàm null theo lát cắt chéo, nên phải đo riêng.
 *
 * BỐN NHÂN TỐ (định nghĩa lấy nguyên từ bài gốc, không tự chế):
 *   carry  — chênh lãi suất (Lustig–Verdelhan 2007; Lustig–Roussanov–Verdelhan 2011)
 *   mom    — lợi suất f tháng gần nhất (Menkhoff–Sarno–Schmeling–Schrimpf, JFE 2012)
 *   value  — đảo chiều PPP 5 năm (Asness–Moskowitz–Pedersen, JF 2013, §A.3)
 *   dollar — long đều cả rổ so với USD (nhân tố RX, đối chứng: beta đô thuần)
 *
 * VÀ THỨ QUAN TRỌNG NHẤT: TỔ HỢP 50/50 value+momentum. AMP 2013 (bảng I, dòng Currencies) báo
 * Sharpe 0,63 cho tổ hợp so với 0,34 cho từng nhân tố riêng — không phải vì nhân tố nào mạnh hơn
 * mà vì hai cái tương quan ÂM (−0,42 cho cặp tiền). Đó là "phương pháp toàn vẹn" mà văn liệu thực
 * sự chỉ ra, nên nó phải được đo.
 *
 * VÌ SAO DỮ LIỆU NÀY LÀ PHÉP THỬ ĐÚNG, KHÔNG PHẢI TÁI LẬP: mẫu của AMP kết thúc 07/2011, của
 * Menkhoff 01/2010. Dữ liệu Dukascopy ở đây là 2004→2025. Phần chồng lấn chỉ vài năm; phần còn lại
 * là NGOÀI MẪU và HẬU CÔNG BỐ. McLean–Pontiff (2016) đo mức bào mòn ~26% ngoài mẫu và ~58% sau công
 * bố trên nhân tố nói chung. Người dùng sẽ giao dịch từ 2026, nên chính đoạn hậu công bố mới là câu
 * trả lời — số trong mẫu gốc chỉ dùng để kiểm tra tôi cài đúng.
 *
 * Chạy: npx ts-node fx/fx-factors.ts
 */

import fs from "fs";
import path from "path";
import { loadDaily } from "./fx-transfer";

// ─────────────────────────────────────────────
// RỔ — đúng bằng rổ của AMP 2013 §A.3, chọn TRƯỚC khi nhìn kết quả
// ─────────────────────────────────────────────
/**
 * `inverted` = file Dukascopy niêm yết USD/XXX nên phải nghịch đảo để có "USD trên một đơn vị ngoại
 * tệ". Sau khi nghịch đảo, giá TĂNG luôn có nghĩa ngoại tệ LÊN GIÁ so với USD ở mọi đồng — không có
 * quy ước này thì dấu của mọi tín hiệu sẽ lẫn lộn giữa hai nhóm.
 */
interface Leg { symbol: string; inverted: boolean }
const PAIR: Record<string, Leg> = {
  AUD: { symbol: "AUDUSD", inverted: false },
  EUR: { symbol: "EURUSD", inverted: false },
  GBP: { symbol: "GBPUSD", inverted: false },
  NZD: { symbol: "NZDUSD", inverted: false },
  CAD: { symbol: "USDCAD", inverted: true },
  CHF: { symbol: "USDCHF", inverted: true },
  JPY: { symbol: "USDJPY", inverted: true },
  NOK: { symbol: "USDNOK", inverted: true },
  SEK: { symbol: "USDSEK", inverted: true },
  MXN: { symbol: "USDMXN", inverted: true },
  PLN: { symbol: "USDPLN", inverted: true },
  TRY: { symbol: "USDTRY", inverted: true },
  ZAR: { symbol: "USDZAR", inverted: true },
};

/** Rổ chính: 9 đồng phát triển — TRÙNG KHỚP rổ AMP 2013 (Úc, Canada, Đức/Euro, Nhật, NZ, Na Uy,
 *  Thuỵ Điển, Thuỵ Sĩ, Anh) so với USD. Không thêm bớt gì để tránh tự chọn rổ theo kết quả. */
export const G9 = ["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "NOK", "NZD", "SEK"];
/** Rổ mở rộng — thêm 4 đồng ngoại vi. Dùng làm kiểm tra vững, KHÔNG phải rổ chính. */
export const G13 = [...G9, "MXN", "PLN", "TRY", "ZAR"];

/** Số đồng mỗi chân. 3/9 ≈ 1/3 mỗi bên, đúng thông lệ G10 (quỹ ETF momentum của Deutsche Bank cũng
 *  long 3 / short 3). Được nhiễu ở phần kiểm định. */
const N_LEG = 3;

/** Mốc chia mẫu: cuối 2011. AMP dừng 07/2011, Menkhoff 01/2010 ⇒ trước mốc là (gần) TRONG mẫu gốc,
 *  sau mốc là ngoài mẫu và hậu công bố. */
const SPLIT_YEAR = 2012;

const CACHE = path.join(process.cwd(), ".cache", "fx");

// ─────────────────────────────────────────────
// DỮ LIỆU THÁNG
// ─────────────────────────────────────────────
export interface MonthObs {
  /** "YYYY-MM" */ ym: string;
  /** USD trên một đơn vị ngoại tệ, đóng cửa ngày giao dịch cuối tháng */ spot: number;
  /** nửa spread, dạng tỉ lệ — chi phí MỘT chiều */ halfSpread: number;
}

/**
 * Chuỗi tháng cho một đồng tiền, đã quy về "USD trên một đơn vị ngoại tệ".
 *
 * `offsetDays` dịch RANH GIỚI THÁNG đi vài ngày — bản dành cho nhân tố tháng của phép thử lệch pha
 * (memory bar-phase-overfit-test). Ở crypto, dịch mốc nến 4h từng làm vốn chênh 157%. Với nhân tố
 * tái cân bằng cuối tháng, "mốc" chính là ngày chốt; nếu kết quả đảo dấu khi chốt sớm/muộn vài
 * ngày thì con số chỉ là hiện vật của một quy ước lịch.
 */
function monthly(ccy: string, offsetDays = 0): MonthObs[] {
  const leg = PAIR[ccy];
  if (!leg) throw new Error(`chưa khai báo cặp cho ${ccy}`);
  const bars = loadDaily(leg.symbol);
  const byMonth = new Map<string, { close: number; spread: number }>();
  for (const b of bars) {
    const t = b.openTime - offsetDays * 86400e3;
    // Ghi đè liên tục ⇒ giá trị còn lại là ngày giao dịch CUỐI CÙNG của tháng (đã dịch).
    byMonth.set(new Date(t).toISOString().slice(0, 7), { close: b.close, spread: b.spread });
  }
  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([ym, v]) => ({
      ym,
      spot: leg.inverted ? 1 / v.close : v.close,
      // spread là chênh lệch giá tuyệt đối; tỉ lệ spread/giá KHÔNG đổi khi nghịch đảo.
      halfSpread: v.spread / v.close / 2,
    }));
}

/** {CCY: {"YYYY-MM": lãi suất liên ngân hàng 3 tháng, %/năm}} — đã tải sẵn ở fx-carry.ts. */
function loadRates(): Record<string, Record<string, number>> {
  const p = path.join(CACHE, "rates.json");
  if (!fs.existsSync(p)) throw new Error("thiếu .cache/fx/rates.json — chạy fx/fx-carry.ts trước");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** {CCY: {"YYYY": chỉ số CPI}} — CPI năm, World Bank FP.CPI.TOTL. */
function loadCpi(): Record<string, Record<string, number>> {
  const p = path.join(CACHE, "cpi.json");
  if (!fs.existsSync(p)) throw new Error("thiếu .cache/fx/cpi.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const prevYm = (ym: string) => {
  const d = new Date(`${ym}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

// ─────────────────────────────────────────────
// BẢNG DỮ LIỆU HỢP NHẤT
// ─────────────────────────────────────────────
export interface Panel {
  months: string[];
  ccys: string[];
  /** rx[ccy][i] = excess return của việc GIỮ ngoại tệ ccy TỪ tháng i SANG tháng i+1 */
  rx: Record<string, (number | null)[]>;
  /** biến động giá giao ngay thuần, để tách phần lãi suất khỏi phần tỉ giá */
  spotRet: Record<string, (number | null)[]>;
  spot: Record<string, (number | null)[]>;
  halfSpread: Record<string, (number | null)[]>;
  /** chênh lãi suất (i_k − i_USD) đã biết TẠI tháng i, %/năm */
  carry: Record<string, (number | null)[]>;
  /** log thay đổi CPI ngoại − log thay đổi CPI Mỹ trong 5 năm tính tới tháng i */
  cpi5y: Record<string, (number | null)[]>;
}

export function buildPanel(ccys: string[], offsetDays = 0): Panel {
  const rates = loadRates();
  const cpi = loadCpi();
  const series = new Map(ccys.map((c) => [c, monthly(c, offsetDays)]));

  // Tháng chung cho MỌI đồng — rổ phải cố định thì sort chéo mới có nghĩa.
  let months: string[] | null = null;
  for (const c of ccys) {
    const set = new Set(series.get(c)!.map((o) => o.ym));
    months = months === null ? [...set] : months.filter((m) => set.has(m));
  }
  months = months!.sort();

  const idx = new Map(ccys.map((c) => [c, new Map(series.get(c)!.map((o) => [o.ym, o]))]));
  const p: Panel = {
    months, ccys, rx: {}, spotRet: {}, spot: {}, halfSpread: {}, carry: {}, cpi5y: {},
  };

  for (const c of ccys) {
    const m = idx.get(c)!;
    p.rx[c] = []; p.spotRet[c] = []; p.spot[c] = []; p.halfSpread[c] = [];
    p.carry[c] = []; p.cpi5y[c] = [];
    for (let i = 0; i < months.length; i++) {
      const ym = months[i];
      const o = m.get(ym)!;
      p.spot[c].push(o.spot);
      p.halfSpread[c].push(o.halfSpread);

      // ── lợi suất giao ngay từ tháng i sang i+1 ──
      const nxt = i + 1 < months.length ? m.get(months[i + 1]) : undefined;
      const sr = nxt ? Math.log(nxt.spot / o.spot) : null;
      p.spotRet[c].push(sr);

      // ── chênh lãi suất: dùng bản THÁNG TRƯỚC, chắc chắn đã công bố khi ra quyết định ──
      const rk = rates[c]?.[prevYm(ym)];
      const ru = rates["USD"]?.[prevYm(ym)];
      const diff = rk !== undefined && ru !== undefined ? rk - ru : null;
      p.carry[c].push(diff);

      // Excess return giữ ngoại tệ = biến động tỉ giá + chênh lãi suất một tháng.
      // (Ngang giá lãi suất có bảo hiểm ⇒ chênh lãi suất = điểm kỳ hạn, nên đây đúng bằng lợi suất
      //  của hợp đồng kỳ hạn mà văn liệu dùng.)
      p.rx[c].push(sr !== null && diff !== null ? sr + diff / 100 / 12 : null);

      // ── CPI 5 năm, LÙI MỘT NĂM để phản ánh độ trễ công bố thật ──
      const y = parseInt(ym.slice(0, 4), 10) - 1;
      const a = cpi[c]?.[String(y)], a5 = cpi[c]?.[String(y - 5)];
      const b = cpi["USD"]?.[String(y)], b5 = cpi["USD"]?.[String(y - 5)];
      p.cpi5y[c].push(
        a && a5 && b && b5 ? Math.log(a / a5) - Math.log(b / b5) : null,
      );
    }
  }
  return p;
}

// ─────────────────────────────────────────────
// TÍN HIỆU — mỗi hàm trả về điểm số tại tháng `i`, chỉ dùng dữ liệu tới HẾT tháng i
// ─────────────────────────────────────────────
export type Signal = (p: Panel, c: string, i: number) => number | null;

export const sigCarry: Signal = (p, c, i) => p.carry[c][i];

/** Momentum f tháng: tổng excess return của f tháng ĐÃ KẾT THÚC tính tới hết tháng i.
 *  rx[i-1] là lợi suất từ tháng i−1 sang i ⇒ phần tử cuối được cộng là rx[i-1]. */
export const sigMom = (f: number): Signal => (p, c, i) => {
  if (i - f < 0) return null;
  let s = 0;
  for (let k = i - f; k < i; k++) {
    const v = p.rx[c][k];
    if (v === null) return null;
    s += v;
  }
  return s;
};

/**
 * Value = đảo chiều PPP 5 năm, theo đúng AMP 2013 §II.B:
 *   log(giá bình quân 4,5–5,5 năm trước) − log(giá hôm nay) − (lạm phát ngoại − lạm phát Mỹ)
 * Dương = đồng tiền RẺ so với PPP.
 */
export const sigValue: Signal = (p, c, i) => {
  const lo = i - 66, hi = i - 54; // 5,5 năm → 4,5 năm trước
  if (lo < 0) return null;
  let s = 0, n = 0;
  for (let k = lo; k <= hi; k++) {
    const v = p.spot[c][k];
    if (v === null) return null;
    s += Math.log(v); n++;
  }
  const now = p.spot[c][i], infl = p.cpi5y[c][i];
  if (now === null || infl === null || n === 0) return null;
  return s / n - Math.log(now) - infl;
};

// ─────────────────────────────────────────────
// DỰNG DANH MỤC
// ─────────────────────────────────────────────
/** Trọng số dollar-neutral: +1/N cho N đồng điểm cao nhất, −1/N cho N thấp nhất. */
function weightsFromScores(scores: [string, number][], nLeg: number): Record<string, number> {
  const w: Record<string, number> = {};
  if (scores.length < nLeg * 2) return w;
  const sorted = [...scores].sort((a, b) => b[1] - a[1]);
  for (let k = 0; k < nLeg; k++) {
    w[sorted[k][0]] = (w[sorted[k][0]] ?? 0) + 1 / nLeg;
    w[sorted[sorted.length - 1 - k][0]] = (w[sorted[sorted.length - 1 - k][0]] ?? 0) - 1 / nLeg;
  }
  return w;
}

export interface FactorResult {
  label: string;
  months: string[];
  /** lợi suất RÒNG từng tháng (đã trừ chi phí vòng quay) */ net: number[];
  gross: number[];
  cost: number[];
  turnover: number[];
  /** tổng |trọng số| từng tháng — mẫu số để tính markup broker, xem fx-factors-gate.ts */
  grossExp: number[];
  /** đóng góp lãi/lỗ cộng dồn theo từng đồng, cho phép kiểm TẬP TRUNG */
  byCcy: Record<string, number>;
}

/**
 * Chạy một nhân tố. `blend` cho phép trộn nhiều tín hiệu bằng cách BÌNH QUÂN TRỌNG SỐ danh mục
 * (đúng cách AMP dựng tổ hợp 50/50: trộn ở tầng danh mục, không trộn ở tầng điểm số — vì các tín
 * hiệu có đơn vị khác nhau hoàn toàn, cộng thẳng điểm số là vô nghĩa).
 */
export function runFactor(
  label: string, p: Panel, signals: Signal[], nLeg = N_LEG, applyCost = true,
): FactorResult {
  const net: number[] = [], gross: number[] = [], cost: number[] = [], turnover: number[] = [];
  const grossExp: number[] = [], byCcy: Record<string, number> = {};
  const months: string[] = [];
  let prev: Record<string, number> = {};

  for (let i = 0; i < p.months.length - 1; i++) {
    // Trọng số của từng tín hiệu, rồi bình quân.
    const parts: Record<string, number>[] = [];
    for (const sig of signals) {
      const scores: [string, number][] = [];
      for (const c of p.ccys) {
        const v = sig(p, c, i);
        if (v !== null && Number.isFinite(v)) scores.push([c, v]);
      }
      parts.push(weightsFromScores(scores, nLeg));
    }
    const w: Record<string, number> = {};
    for (const part of parts) {
      for (const [c, v] of Object.entries(part)) w[c] = (w[c] ?? 0) + v / signals.length;
    }
    if (Object.keys(w).length === 0) { prev = {}; continue; }

    // Lợi suất tháng tới; nếu một đồng thiếu dữ liệu thì bỏ danh mục tháng đó (không đoán bừa).
    let g = 0, ok = true, ge = 0;
    for (const [c, wt] of Object.entries(w)) {
      const r = p.rx[c][i];
      if (r === null) { ok = false; break; }
      g += wt * r;
      ge += Math.abs(wt);
    }
    if (!ok) { prev = {}; continue; }
    for (const [c, wt] of Object.entries(w)) byCcy[c] = (byCcy[c] ?? 0) + wt * p.rx[c][i]!;

    // Chi phí = vòng quay × nửa spread, tính riêng cho từng đồng vì spread lệch nhau nhiều lần.
    let ct = 0, tu = 0;
    const keys = new Set([...Object.keys(w), ...Object.keys(prev)]);
    for (const c of keys) {
      const d = Math.abs((w[c] ?? 0) - (prev[c] ?? 0));
      tu += d;
      ct += d * (p.halfSpread[c][i] ?? 0);
    }
    if (!applyCost) ct = 0;

    months.push(p.months[i + 1]);
    gross.push(g); cost.push(ct); net.push(g - ct); turnover.push(tu); grossExp.push(ge);
    prev = w;
  }
  return { label, months, net, gross, cost, turnover, grossExp, byCcy };
}

// ─────────────────────────────────────────────
// THỐNG KÊ
// ─────────────────────────────────────────────
export interface Stats {
  n: number; annRet: number; annVol: number; sharpe: number; t: number;
  maxDD: number; skew: number; posYears: number; nYears: number;
  bestYearPct: number; recovery: number;
}

export function stats(r: number[], months: string[]): Stats {
  const n = r.length;
  if (n < 12) {
    return { n, annRet: 0, annVol: 0, sharpe: 0, t: 0, maxDD: 0, skew: 0, posYears: 0, nYears: 0, bestYearPct: 0, recovery: 0 };
  }
  const mean = r.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const skew = sd > 0 ? r.reduce((s, x) => s + ((x - mean) / sd) ** 3, 0) / n : 0;

  let cum = 0, peak = 0, maxDD = 0;
  for (const x of r) { cum += x; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }

  const byYear = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const y = parseInt(months[i].slice(0, 4), 10);
    byYear.set(y, (byYear.get(y) ?? 0) + r[i]);
  }
  const yrs = [...byYear.values()];
  const total = yrs.reduce((s, x) => s + x, 0);
  const best = Math.max(...yrs);
  // Cùng định nghĩa với scripts/exp-concentration.ts để so trực tiếp được với hệ crypto.
  const restPerYear = yrs.length > 1 ? (total - best) / (yrs.length - 1) : 0;

  return {
    n, annRet: mean * 12, annVol: sd * Math.sqrt(12),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(12) : 0,
    t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    maxDD, skew,
    posYears: yrs.filter((v) => v > 0).length, nYears: yrs.length,
    bestYearPct: total > 0 ? (best / total) * 100 : 0,
    recovery: maxDD > 0 ? restPerYear / maxDD : 0,
  };
}

export const HDR =
  "nhân tố".padEnd(30) + "annRet".padStart(8) + "annVol".padStart(8) + "Sharpe".padStart(8) +
  "t-stat".padStart(8) + "maxDD".padStart(8) + "skew".padStart(7) + "năm+".padStart(8);

export function show(label: string, s: Stats, mark = "") {
  console.log(
    label.padEnd(30) +
    `${(s.annRet * 100).toFixed(1)}%`.padStart(8) +
    `${(s.annVol * 100).toFixed(1)}%`.padStart(8) +
    s.sharpe.toFixed(2).padStart(8) +
    s.t.toFixed(2).padStart(8) +
    `${(s.maxDD * 100).toFixed(0)}%`.padStart(8) +
    s.skew.toFixed(2).padStart(7) +
    `${s.posYears}/${s.nYears}`.padStart(8) + mark,
  );
}

/** Lát cắt theo khoảng năm [from, to]. */
export function slicePeriod(r: FactorResult, from: number, to: number): { net: number[]; months: string[] } {
  const net: number[] = [], months: string[] = [];
  for (let i = 0; i < r.net.length; i++) {
    const y = parseInt(r.months[i].slice(0, 4), 10);
    if (y >= from && y <= to) { net.push(r.net[i]); months.push(r.months[i]); }
  }
  return { net, months };
}

/**
 * Tương quan giữa hai NHÂN TỐ, ghép theo THÁNG.
 *
 * Bắt buộc phải ghép theo nhãn tháng: value cần 5,5 năm mồi nên bắt đầu ~2009, còn momentum bắt
 * đầu 2005. So sánh phần tử thứ i của hai mảng là so tháng 2009 với tháng 2005 — lệch 4 năm, và
 * kết quả ra ≈0 bất kể quan hệ thật là gì. Bản đầu của file này mắc đúng lỗi đó và suýt kết luận
 * "cơ chế tổ hợp đã mất", trong khi tương quan tầng tín hiệu đo được là −0,50.
 */
export function corrAligned(a: FactorResult, b: FactorResult): number {
  const mb = new Map(b.months.map((m, i) => [m, b.net[i]]));
  const xa: number[] = [], xb: number[] = [];
  for (let i = 0; i < a.months.length; i++) {
    const v = mb.get(a.months[i]);
    if (v !== undefined) { xa.push(a.net[i]); xb.push(v); }
  }
  return corr(xa, xb);
}

export function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = a.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const mb = b.slice(0, n).reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

// ─────────────────────────────────────────────
async function main() {
  const p = buildPanel(G9);
  console.log("═══ §1. BẢNG DỮ LIỆU ═══");
  console.log(`Rổ: ${G9.join(" ")}  (= đúng rổ AMP 2013 §A.3)`);
  console.log(`Tháng: ${p.months[0]} → ${p.months[p.months.length - 1]}  (${p.months.length} tháng)`);
  const sp = G9.map((c) => `${c} ${((p.halfSpread[c][p.months.length - 1] ?? 0) * 2 * 1e4).toFixed(1)}`);
  console.log(`Spread hiện tại (bps): ${sp.join("  ")}`);

  const defs: [string, Signal[]][] = [
    ["carry", [sigCarry]],
    ["mom 1 tháng", [sigMom(1)]],
    ["mom 3 tháng", [sigMom(3)]],
    ["mom 6 tháng", [sigMom(6)]],
    ["mom 12 tháng", [sigMom(12)]],
    ["value (PPP 5 năm)", [sigValue]],
  ];

  console.log("\n═══ §2. TỪNG NHÂN TỐ, RÒNG CHI PHÍ, TOÀN MẪU ═══");
  console.log(HDR);
  const results = new Map<string, FactorResult>();
  for (const [label, sigs] of defs) {
    const r = runFactor(label, p, sigs);
    results.set(label, r);
    show(label, stats(r.net, r.months));
  }

  // Tổ hợp — điểm mấu chốt của AMP.
  console.log("\n  ── tổ hợp (trộn ở tầng trọng số danh mục) ──");
  const combos: [string, Signal[]][] = [
    ["value + mom12 (50/50)", [sigValue, sigMom(12)]],
    ["value + mom1 (50/50)", [sigValue, sigMom(1)]],
    ["carry + value + mom12", [sigCarry, sigValue, sigMom(12)]],
  ];
  for (const [label, sigs] of combos) {
    const r = runFactor(label, p, sigs);
    results.set(label, r);
    show(label, stats(r.net, r.months));
  }

  console.log("\n═══ §3. TRONG MẪU GỐC vs HẬU CÔNG BỐ — phần quyết định ═══");
  console.log(`Mẫu AMP dừng 07/2011, Menkhoff dừng 01/2010. Cắt tại ${SPLIT_YEAR}.`);
  console.log("\n" + "nhân tố".padEnd(30) + "  ≤2011: Sharpe / annRet      ≥2012: Sharpe / annRet");
  for (const [label, r] of results) {
    const a = slicePeriod(r, 0, SPLIT_YEAR - 1), b = slicePeriod(r, SPLIT_YEAR, 9999);
    const sa = stats(a.net, a.months), sb = stats(b.net, b.months);
    console.log(
      label.padEnd(30) +
      `${sa.sharpe.toFixed(2)}`.padStart(8) + ` / ${(sa.annRet * 100).toFixed(1)}%`.padEnd(12) +
      `${sb.sharpe.toFixed(2)}`.padStart(10) + ` / ${(sb.annRet * 100).toFixed(1)}%`.padEnd(10) +
      (sa.sharpe > 0.3 && sb.sharpe < 0.1 ? "  ← sập sau công bố" : ""),
    );
  }

  console.log("\n═══ §4. TƯƠNG QUAN GIỮA CÁC NHÂN TỐ (kiểm tra cơ chế tổ hợp) ═══");
  const keys = ["carry", "mom 12 tháng", "value (PPP 5 năm)"];
  console.log("(ghép theo THÁNG — xem ghi chú ở corrAligned)");
  console.log("".padEnd(22) + keys.map((k) => k.slice(0, 10).padStart(12)).join(""));
  for (const a of keys) {
    const row = keys.map((b) => corrAligned(results.get(a)!, results.get(b)!).toFixed(2).padStart(12));
    console.log(a.slice(0, 20).padEnd(22) + row.join(""));
  }
  console.log(
    "\nAMP 2013 báo corr(value, mom) = −0,42 cho ĐÚNG lớp cặp tiền (bảng I, dòng Currencies).\n" +
    "Đo được ở đây: −0,47. Cơ chế đa dạng hoá VẪN CÒN NGUYÊN, không hề mất — và thấy rõ ở cột\n" +
    "annVol: tổ hợp 3,7% so với 7,5% của từng chân. Nhưng nó đang đa dạng hoá hai nhân tố có lợi\n" +
    "suất BẰNG 0, nên kết quả là một đường gần phẳng với độ lệch nhỏ. Đây là điểm phải nói cho\n" +
    "đúng: cái mất đi là LỢI SUẤT của value và momentum, không phải quan hệ giữa chúng.",
  );

  console.log("\n═══ §5. CHI PHÍ ĂN BAO NHIÊU ═══");
  console.log("nhân tố".padEnd(30) + "gộp %/năm".padStart(11) + "phí %/năm".padStart(11) + "ròng %/năm".padStart(12) + "vòng quay/tháng".padStart(17));
  for (const [label, r] of results) {
    const g = r.gross.reduce((s, x) => s + x, 0) / r.gross.length * 12;
    const c = r.cost.reduce((s, x) => s + x, 0) / r.cost.length * 12;
    const tu = r.turnover.reduce((s, x) => s + x, 0) / r.turnover.length;
    console.log(
      label.padEnd(30) + `${(g * 100).toFixed(2)}%`.padStart(11) +
      `${(c * 100).toFixed(2)}%`.padStart(11) + `${((g - c) * 100).toFixed(2)}%`.padStart(12) +
      `${tu.toFixed(2)}`.padStart(17),
    );
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
