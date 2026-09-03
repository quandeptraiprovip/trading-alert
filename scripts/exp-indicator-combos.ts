/**
 * exp-indicator-combos.ts — (A) 26 CHỈ BÁO NỮA, và (B) GỘP NHIỀU CHỈ BÁO LẠI VỚI NHAU.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VÌ SAO PHẦN (B) MỚI LÀ PHẦN ĐÁNG LÀM
 *
 * Vòng trước quét 37 biến thể rồi lấy cái tốt nhất (MACD) — và White's Reality Check bác bỏ nó
 * (p = 0,98; SPA 0,31). Đó không phải sự cố, đó là ĐÚNG NHƯ DỰ ĐOÁN: chọn-cái-tốt-nhất là thao tác
 * mà Sullivan-Timmermann-White (1999) chứng minh không có giá trị ngoài mẫu.
 *
 * Tài liệu hiện đại làm khác hẳn. Neely, Rapach, Tu & Zhou (2014, *Management Science* 60(7)) dùng
 * **14 chỉ báo cùng lúc** — MA (ngắn 1/2/3 tháng vs dài 9/12 tháng), momentum, on-balance volume —
 * và KHÔNG chọn cái nào: họ GỘP chúng lại (trung bình / thành phần chính) rồi đưa vào hồi quy dự báo.
 * Lý lẽ: mỗi chỉ báo riêng lẻ quá nhiễu; nếu nhiễu của chúng độc lập nhau thì trung bình N cái làm
 * nhiễu giảm theo √N trong khi tín hiệu chung giữ nguyên.
 *
 * Điểm mấu chốt về OVERFIT: **gộp TẤT CẢ với trọng số bằng nhau KHÔNG có tham số tự do nào cả.**
 * Không chọn cái nào ⇒ không có chi phí chọn lọc. Đây là kiểu kết hợp DUY NHẤT trong file này miễn
 * nhiễm với data-snooping, và vì thế là ứng viên đáng tin nhất — bất kể nó thắng hay thua.
 *
 * Vì sao TRUNG BÌNH ĐỀU chứ không phải PCA/hồi quy có trọng số: (1) PCA ước lượng trên toàn mẫu là
 * LOOKAHEAD, còn ước lượng cuốn chiếu thì lại thêm cửa sổ = thêm tham số; (2) DeMiguel, Garlappi &
 * Uppal (2009) cho thấy trọng số 1/N thường ĐÁNH BẠI trọng số tối ưu hoá ngoài mẫu vì sai số ước
 * lượng lớn hơn phần lợi thu được. Trung bình đều là bản mạnh mẽ của cùng ý tưởng.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÁCH GỘP ĐƯỢC ĐO
 *   vote      : mỗi chỉ báo bỏ phiếu ±1 theo hướng lệnh; S = trung bình. Vào lệnh khi S ≥ ngưỡng.
 *   count     : cần ít nhất m/N chỉ báo đồng ý (bản rời rạc của vote)
 *   sizing    : KHÔNG chặn lệnh nào, chỉ nhân size theo (1 + λ·S) — giữ lại toàn bộ lệnh, chỉ đổi
 *               tỉ trọng. Đây là cách dùng gần với tài liệu nhất (chỉ báo là BIẾN DỰ BÁO CÓ ĐỘ LỚN,
 *               không phải công tắc bật/tắt) và là cách KHÔNG đâm vào sàn minNotional bằng cách bỏ lệnh.
 *   nhóm con  : gộp riêng theo họ (chỉ momentum / chỉ trendiness / chỉ volume) để xem nhiễu có thật
 *               sự độc lập giữa các họ không
 *
 * ĐỐI CHỨNG: cùng nhóm giả "lọc ngẫu nhiên KHỚP TỈ LỆ" như vòng trước, nhưng lần này dựng thành
 * ĐƯỜNG CONG theo tỉ lệ giữ lệnh (rẻ hơn nhiều lần chạy và cho cùng thông tin).
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-indicator-combos.ts [days=2000]
 */

import { Candle } from "../strategy";
import { T, atrSeries, buildBtcGateLongs, ema } from "../turtle";
import { AdmitCtx, AdmitFn, Book, ExtParams, riskMetrics, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";

type Dir = "long" | "short";

// ─────────────────────────────────────────────────────────────────────────────
// TIỆN ÍCH
// ─────────────────────────────────────────────────────────────────────────────
const sma = (x: number[], n: number): number[] => {
  const out = new Array(x.length).fill(0);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= n) s -= x[i - n];
    out[i] = i >= n - 1 ? s / n : x[i];
  }
  return out;
};
const diffN = (x: number[], n: number): number[] => x.map((v, i) => (i >= n ? v - x[i - n] : 0));

// ─────────────────────────────────────────────────────────────────────────────
// 26 CHỈ BÁO MỚI — mỗi hàm trả chuỗi CÓ HƯỚNG (dương = ủng hộ LONG) hoặc "độ mạnh trend" (không hướng)
// ─────────────────────────────────────────────────────────────────────────────

/** Aroon — bao lâu rồi kể từ đỉnh/đáy cao nhất trong n nến. Đo TUỔI của cực trị, không đo giá. */
function aroon(c: Candle[], n = 25): number[] {
  const out = new Array(c.length).fill(0);
  for (let i = n; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity, hIdx = i, lIdx = i;
    for (let j = i - n + 1; j <= i; j++) {
      if (c[j].high >= hi) { hi = c[j].high; hIdx = j; }
      if (c[j].low <= lo) { lo = c[j].low; lIdx = j; }
    }
    out[i] = ((n - (i - hIdx)) / n) * 100 - ((n - (i - lIdx)) / n) * 100;
  }
  return out;
}

/** Vortex — VI+ − VI−. Đo lực xoay lên/xuống bằng khoảng cách giữa các cực trị liên tiếp. */
function vortex(c: Candle[], n = 14): number[] {
  const vp = new Array(c.length).fill(0), vm = new Array(c.length).fill(0), tr = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    vp[i] = Math.abs(c[i].high - c[i - 1].low);
    vm[i] = Math.abs(c[i].low - c[i - 1].high);
    const pc = c[i - 1].close;
    tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - pc), Math.abs(c[i].low - pc));
  }
  const sp = sma(vp, n), sm = sma(vm, n), st = sma(tr, n);
  return st.map((t, i) => (t > 0 ? (sp[i] - sm[i]) / t : 0));
}

/** TRIX — tốc độ biến thiên của EMA làm mượt BA LẦN. Lọc gần hết nhiễu, chỉ còn xu hướng nền. */
function trix(c: Candle[], n = 15): number[] {
  const cl = c.map((x) => Math.log(x.close));
  const e3 = ema(ema(ema(cl, n), n), n);
  return e3.map((v, i) => (i > 0 ? v - e3[i - 1] : 0));
}

/** PPO — MACD chuẩn hoá theo giá (%), so được giữa các coin khác mức giá. */
function ppo(c: Candle[], f = 12, s = 26, sig = 9) {
  const cl = c.map((x) => x.close);
  const ef = ema(cl, f), es = ema(cl, s);
  const line = ef.map((v, i) => (es[i] > 0 ? ((v - es[i]) / es[i]) * 100 : 0));
  const signal = ema(line, sig);
  return line.map((v, i) => v - signal[i]);
}

/** True Strength Index — momentum làm mượt hai lần, chia cho |momentum| làm mượt hai lần. */
function tsi(c: Candle[], long = 25, short = 13): number[] {
  const m = c.map((x, i) => (i > 0 ? x.close - c[i - 1].close : 0));
  const a = ema(ema(m, long), short);
  const b = ema(ema(m.map(Math.abs), long), short);
  return a.map((v, i) => (b[i] > 0 ? (100 * v) / b[i] : 0));
}

/** Chande Momentum Oscillator — (tổng tăng − tổng giảm)/(tổng tuyệt đối) trên n nến. */
function cmo(c: Candle[], n = 14): number[] {
  const up = new Array(c.length).fill(0), dn = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    const d = c[i].close - c[i - 1].close;
    up[i] = Math.max(0, d); dn[i] = Math.max(0, -d);
  }
  const su = sma(up, n), sd = sma(dn, n);
  return su.map((v, i) => (v + sd[i] > 0 ? (100 * (v - sd[i])) / (v + sd[i]) : 0));
}

/** Williams %R — vị trí close trong biên độ n nến, thang −100..0. */
function williamsR(c: Candle[], n = 14): number[] {
  const out = new Array(c.length).fill(-50);
  for (let i = n - 1; i < c.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, c[j].high); ll = Math.min(ll, c[j].low); }
    out[i] = hh > ll ? (-100 * (hh - c[i].close)) / (hh - ll) : -50;
  }
  return out;
}

/** Ultimate Oscillator — gộp ba chân trời 7/14/28 với trọng số 4/2/1 (Williams 1985). */
function ultimateOsc(c: Candle[], a = 7, b = 14, d = 28): number[] {
  const bp = new Array(c.length).fill(0), tr = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    const pc = c[i - 1].close;
    const low = Math.min(c[i].low, pc), high = Math.max(c[i].high, pc);
    bp[i] = c[i].close - low;
    tr[i] = high - low;
  }
  const roll = (x: number[], n: number) => sma(x, n).map((v) => v * n);
  const [ba, bb, bd] = [roll(bp, a), roll(bp, b), roll(bp, d)];
  const [ta, tb, td] = [roll(tr, a), roll(tr, b), roll(tr, d)];
  return c.map((_, i) => {
    const r = (x: number, y: number) => (y > 0 ? x / y : 0.5);
    return (100 * (4 * r(ba[i], ta[i]) + 2 * r(bb[i], tb[i]) + r(bd[i], td[i]))) / 7 - 50;
  });
}

/** Awesome Oscillator — SMA5 − SMA34 của giá trung vị (Williams). */
function awesome(c: Candle[]): number[] {
  const mp = c.map((b) => (b.high + b.low) / 2);
  const a = sma(mp, 5), b = sma(mp, 34);
  return a.map((v, i) => (c[i].close > 0 ? ((v - b[i]) / c[i].close) * 100 : 0));
}

/** Chaikin Money Flow — dòng tiền có trọng số vị trí close trong nến, n nến. */
function cmf(c: Candle[], n = 20): number[] {
  const mfv = c.map((b) => {
    const r = b.high - b.low;
    return r > 0 ? (((b.close - b.low) - (b.high - b.close)) / r) * b.volume : 0;
  });
  const sv = sma(c.map((b) => b.volume), n), sm = sma(mfv, n);
  return sm.map((v, i) => (sv[i] > 0 ? v / sv[i] : 0));
}

/** Force Index — (Δgiá × volume) làm mượt. Kết hợp hướng và lực. */
function forceIndex(c: Candle[], n = 13): number[] {
  const f = c.map((b, i) => (i > 0 ? (b.close - c[i - 1].close) * b.volume : 0));
  const e = ema(f, n);
  // chuẩn hoá theo quy mô để so được giữa coin
  const scale = sma(c.map((b, i) => Math.abs(i > 0 ? (b.close - c[i - 1].close) * b.volume : 0)), 100);
  return e.map((v, i) => (scale[i] > 0 ? v / scale[i] : 0));
}

/** Ease of Movement — giá đi được bao xa cho mỗi đơn vị khối lượng. */
function easeOfMovement(c: Candle[], n = 14): number[] {
  const emv = c.map((b, i) => {
    if (i === 0) return 0;
    const mid = (b.high + b.low) / 2 - (c[i - 1].high + c[i - 1].low) / 2;
    const box = b.volume > 0 && b.high > b.low ? b.volume / (b.high - b.low) : 0;
    return box > 0 && b.close > 0 ? (mid / b.close) / box : 0;
  });
  const e = sma(emv, n);
  const scale = sma(emv.map(Math.abs), 100);
  return e.map((v, i) => (scale[i] > 0 ? v / scale[i] : 0));
}

/** Choppiness Index — 0 (trend sạch) .. 100 (lình xình). KHÔNG có hướng. */
function choppiness(c: Candle[], n = 14): number[] {
  const tr = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    const pc = c[i - 1].close;
    tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - pc), Math.abs(c[i].low - pc));
  }
  const out = new Array(c.length).fill(50);
  for (let i = n; i < c.length; i++) {
    let s = 0, hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) { s += tr[j]; hh = Math.max(hh, c[j].high); ll = Math.min(ll, c[j].low); }
    out[i] = hh > ll && s > 0 ? (100 * Math.log10(s / (hh - ll))) / Math.log10(n) : 50;
  }
  return out;
}

/** Vertical Horizontal Filter — |Δgiá n nến| / tổng |Δ từng nến|. Anh em của Efficiency Ratio. */
function vhf(c: Candle[], n = 28): number[] {
  const out = new Array(c.length).fill(0);
  for (let i = n; i < c.length; i++) {
    let hh = -Infinity, ll = Infinity, s = 0;
    for (let j = i - n + 1; j <= i; j++) {
      hh = Math.max(hh, c[j].close); ll = Math.min(ll, c[j].close);
      s += Math.abs(c[j].close - c[j - 1].close);
    }
    out[i] = s > 0 ? (hh - ll) / s : 0;
  }
  return out;
}

/** Detrended Price Oscillator — giá trừ SMA đã dịch, tách chu kỳ ngắn khỏi xu hướng. */
function dpo(c: Candle[], n = 20): number[] {
  const s = sma(c.map((b) => b.close), n);
  const shift = Math.floor(n / 2) + 1;
  return c.map((b, i) => (i >= shift && b.close > 0 ? ((b.close - s[i - shift]) / b.close) * 100 : 0));
}

/** Know Sure Thing — gộp bốn tốc độ ROC làm mượt (Pring). Bản gộp-đa-chân-trời kinh điển. */
function kst(c: Candle[]): number[] {
  const cl = c.map((b) => b.close);
  const roc = (n: number) => cl.map((v, i) => (i >= n && cl[i - n] > 0 ? ((v - cl[i - n]) / cl[i - n]) * 100 : 0));
  const a = sma(roc(10), 10), b = sma(roc(15), 10), d = sma(roc(20), 10), e = sma(roc(30), 15);
  return a.map((v, i) => v + 2 * b[i] + 3 * d[i] + 4 * e[i]);
}

/** Coppock — WMA của tổng hai ROC dài. Chỉ báo đáy dài hạn. */
function coppock(c: Candle[], r1 = 14, r2 = 11, wma = 10): number[] {
  const cl = c.map((b) => b.close);
  const roc = (n: number) => cl.map((v, i) => (i >= n && cl[i - n] > 0 ? ((v - cl[i - n]) / cl[i - n]) * 100 : 0));
  const s = roc(r1).map((v, i) => v + roc(r2)[i]);
  const out = new Array(c.length).fill(0);
  const wsum = (wma * (wma + 1)) / 2;
  for (let i = wma; i < c.length; i++) {
    let acc = 0;
    for (let j = 0; j < wma; j++) acc += s[i - j] * (wma - j);
    out[i] = acc / wsum;
  }
  return out;
}

/** Fisher Transform — ép vị trí giá về phân phối gần chuẩn, làm cực trị nổi rõ (Ehlers). */
function fisher(c: Candle[], n = 10): number[] {
  const out = new Array(c.length).fill(0);
  let v = 0, f = 0;
  for (let i = n; i < c.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, c[j].high); ll = Math.min(ll, c[j].low); }
    const mp = (c[i].high + c[i].low) / 2;
    const x = hh > ll ? (2 * (mp - ll)) / (hh - ll) - 1 : 0;
    v = 0.33 * 2 * x + 0.67 * v;
    v = Math.max(-0.999, Math.min(0.999, v));
    f = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * f;
    out[i] = f;
  }
  return out;
}

/** Hull MA — độ dốc. WMA lai làm mượt mà gần như không trễ (Hull). */
function hullSlope(c: Candle[], n = 20): number[] {
  const cl = c.map((b) => b.close);
  const wma = (x: number[], m: number) => {
    const o = new Array(x.length).fill(0);
    const ws = (m * (m + 1)) / 2;
    for (let i = m - 1; i < x.length; i++) {
      let a = 0;
      for (let j = 0; j < m; j++) a += x[i - j] * (m - j);
      o[i] = a / ws;
    }
    return o;
  };
  const h = wma(wma(cl, Math.floor(n / 2)).map((v, i) => 2 * v - wma(cl, n)[i]), Math.round(Math.sqrt(n)));
  return h.map((v, i) => (i > 0 && c[i].close > 0 ? ((v - h[i - 1]) / c[i].close) * 100 : 0));
}

/** KAMA — MA tự điều chỉnh tốc độ theo Efficiency Ratio (Kaufman). Trả độ dốc. */
function kamaSlope(c: Candle[], n = 10, fast = 2, slow = 30): number[] {
  const cl = c.map((b) => b.close);
  const k = new Array(c.length).fill(cl[0]);
  const fsc = 2 / (fast + 1), ssc = 2 / (slow + 1);
  for (let i = 1; i < c.length; i++) {
    if (i < n) { k[i] = cl[i]; continue; }
    let vol = 0;
    for (let j = i - n + 1; j <= i; j++) vol += Math.abs(cl[j] - cl[j - 1]);
    const er = vol > 0 ? Math.abs(cl[i] - cl[i - n]) / vol : 0;
    const sc = (er * (fsc - ssc) + ssc) ** 2;
    k[i] = k[i - 1] + sc * (cl[i] - k[i - 1]);
  }
  return k.map((v, i) => (i > 0 && c[i].close > 0 ? ((v - k[i - 1]) / c[i].close) * 100 : 0));
}

/** R² của hồi quy tuyến tính log giá theo thời gian — "trend này THẲNG đến đâu". Không hướng. */
function trendR2(c: Candle[], n = 50): number[] {
  const out = new Array(c.length).fill(0);
  const xs = Array.from({ length: n }, (_, k) => k);
  const mx = (n - 1) / 2;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  for (let i = n; i < c.length; i++) {
    let sy = 0;
    for (let k = 0; k < n; k++) sy += Math.log(c[i - n + 1 + k].close);
    const my = sy / n;
    let sxy = 0, syy = 0;
    for (let k = 0; k < n; k++) {
      const y = Math.log(c[i - n + 1 + k].close) - my;
      sxy += (xs[k] - mx) * y; syy += y * y;
    }
    out[i] = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  }
  return out;
}

/** Elder Ray — bull power + bear power so với EMA13, chuẩn hoá theo ATR. */
function elderRay(c: Candle[], n = 13): number[] {
  const e = ema(c.map((b) => b.close), n);
  const a = atrSeries(c, 20);
  return c.map((b, i) => (a[i] > 0 ? ((b.high - e[i]) + (b.low - e[i])) / (2 * a[i]) : 0));
}

/** Balance of Power — (close−open)/(high−low), làm mượt. Ai thắng TRONG từng nến. */
function balanceOfPower(c: Candle[], n = 14): number[] {
  return sma(c.map((b) => (b.high > b.low ? (b.close - b.open) / (b.high - b.low) : 0)), n);
}

/** Relative Vigor Index — (close−open) so (high−low), làm mượt kiểu SMA4 có trọng số. */
function rvi(c: Candle[], n = 10): number[] {
  const num = c.map((b, i) => {
    if (i < 3) return 0;
    const f = (j: number) => c[j].close - c[j].open;
    return (f(i) + 2 * f(i - 1) + 2 * f(i - 2) + f(i - 3)) / 6;
  });
  const den = c.map((b, i) => {
    if (i < 3) return 0;
    const g = (j: number) => c[j].high - c[j].low;
    return (g(i) + 2 * g(i - 1) + 2 * g(i - 2) + g(i - 3)) / 6;
  });
  const sn = sma(num, n), sd = sma(den, n);
  return sn.map((v, i) => (sd[i] > 0 ? v / sd[i] : 0));
}

/** Bollinger nằm TRONG Keltner = "squeeze" — nén biến động trước khi bung. Không hướng. */
function squeezeOn(c: Candle[], n = 20): number[] {
  const cl = c.map((b) => b.close);
  const m = sma(cl, n);
  const a = atrSeries(c, n);
  const out = new Array(c.length).fill(0);
  for (let i = n; i < c.length; i++) {
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (cl[j] - m[i]) ** 2;
    const sd = Math.sqrt(v / n);
    out[i] = 2 * sd < 1.5 * a[i] ? 1 : 0; // dải Bollinger 2σ nằm trong kênh Keltner 1,5ATR
  }
  return out;
}

/** Mass Index — dải biên độ phình ra (cảnh báo đảo chiều). Không hướng. */
function massIndex(c: Candle[], n = 25): number[] {
  const r = c.map((b) => b.high - b.low);
  const e1 = ema(r, 9), e2 = ema(e1, 9);
  const ratio = e1.map((v, i) => (e2[i] > 0 ? v / e2[i] : 1));
  return sma(ratio, n).map((v) => v * n);
}

/** Độ rộng kênh Donchian so với chính nó 100 nến trước — nén/giãn cấu trúc. Không hướng. */
function donchianWidth(c: Candle[], n = 20): number[] {
  const out = new Array(c.length).fill(0);
  for (let i = n; i < c.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, c[j].high); ll = Math.min(ll, c[j].low); }
    out[i] = c[i].close > 0 ? ((hh - ll) / c[i].close) * 100 : 0;
  }
  const base = sma(out, 100);
  return out.map((v, i) => (base[i] > 0 ? v / base[i] : 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// ĐỊNH NGHĨA TÍN HIỆU: mỗi chỉ báo → ±1 theo hướng lệnh
// ─────────────────────────────────────────────────────────────────────────────
type SigDef = {
  name: string;
  family: "momentum" | "trendiness" | "volume" | "structure";
  /** Chuỗi giá trị. */
  series: (c: Candle[]) => number[];
  /**
   * `directional` = giá trị mang HƯỚNG (dương ⇒ ủng hộ LONG) ⇒ phiếu = sign(giá trị × hướng lệnh).
   * `strength`    = giá trị KHÔNG mang hướng, chỉ đo độ mạnh trend ⇒ phiếu = +1 khi vượt ngưỡng.
   */
  kind: "directional" | "strength";
  /** Ngưỡng cho loại `strength`; `invert` = giá trị THẤP mới là tốt (Choppiness). */
  thr?: number;
  invert?: boolean;
};

const DEFS: SigDef[] = [
  { name: "Aroon(25)", family: "momentum", series: (c) => aroon(c, 25), kind: "directional" },
  { name: "Vortex(14)", family: "momentum", series: (c) => vortex(c, 14), kind: "directional" },
  { name: "TRIX(15)", family: "momentum", series: (c) => trix(c, 15), kind: "directional" },
  { name: "PPO(12,26,9)", family: "momentum", series: (c) => ppo(c), kind: "directional" },
  { name: "TSI(25,13)", family: "momentum", series: (c) => tsi(c), kind: "directional" },
  { name: "CMO(14)", family: "momentum", series: (c) => cmo(c, 14), kind: "directional" },
  { name: "Williams %R(14)", family: "momentum", series: (c) => williamsR(c, 14).map((v) => v + 50), kind: "directional" },
  { name: "Ultimate Osc(7,14,28)", family: "momentum", series: (c) => ultimateOsc(c), kind: "directional" },
  { name: "Awesome Osc(5,34)", family: "momentum", series: (c) => awesome(c), kind: "directional" },
  { name: "KST", family: "momentum", series: (c) => kst(c), kind: "directional" },
  { name: "Coppock", family: "momentum", series: (c) => coppock(c), kind: "directional" },
  { name: "Fisher(10)", family: "momentum", series: (c) => fisher(c, 10), kind: "directional" },
  { name: "DPO(20)", family: "momentum", series: (c) => dpo(c, 20), kind: "directional" },
  { name: "RVI(10)", family: "momentum", series: (c) => rvi(c, 10), kind: "directional" },
  { name: "Balance of Power(14)", family: "momentum", series: (c) => balanceOfPower(c, 14), kind: "directional" },
  { name: "Hull MA(20) dốc", family: "momentum", series: (c) => hullSlope(c, 20), kind: "directional" },
  { name: "KAMA(10) dốc", family: "momentum", series: (c) => kamaSlope(c), kind: "directional" },
  { name: "Elder Ray(13)", family: "momentum", series: (c) => elderRay(c, 13), kind: "directional" },

  { name: "Choppiness(14) < 50", family: "trendiness", series: (c) => choppiness(c, 14), kind: "strength", thr: 50, invert: true },
  { name: "VHF(28) > 0,35", family: "trendiness", series: (c) => vhf(c, 28), kind: "strength", thr: 0.35 },
  { name: "R² trend(50) > 0,5", family: "trendiness", series: (c) => trendR2(c, 50), kind: "strength", thr: 0.5 },
  { name: "Mass Index < 26,5", family: "trendiness", series: (c) => massIndex(c, 25), kind: "strength", thr: 26.5, invert: true },

  { name: "Chaikin MF(20)", family: "volume", series: (c) => cmf(c, 20), kind: "directional" },
  { name: "Force Index(13)", family: "volume", series: (c) => forceIndex(c, 13), kind: "directional" },
  { name: "Ease of Movement(14)", family: "volume", series: (c) => easeOfMovement(c, 14), kind: "directional" },

  { name: "Squeeze BB⊂KC", family: "structure", series: (c) => squeezeOn(c, 20), kind: "strength", thr: 0.5 },
  { name: "Donchian width < 1,0×", family: "structure", series: (c) => donchianWidth(c, 20), kind: "strength", thr: 1.0, invert: true },
];

type Pre = { idx: Map<number, number>; vals: number[][] };

function buildPre(data: Map<string, Candle[]>): Map<string, Pre> {
  const m = new Map<string, Pre>();
  for (const [s, c] of data) {
    m.set(s, { idx: new Map(c.map((b, i) => [b.openTime, i])), vals: DEFS.map((d) => d.series(c)) });
  }
  return m;
}

/** Phiếu ±1 của chỉ báo thứ `k` tại (sym, time, dir). */
function vote(pre: Map<string, Pre>, k: number, sym: string, time: number, dir: Dir): number {
  const p = pre.get(sym);
  const i = p?.idx.get(time);
  if (!p || i === undefined) return 0;
  const v = p.vals[k][i];
  const d = DEFS[k];
  if (d.kind === "directional") {
    const s = dir === "long" ? 1 : -1;
    return v * s > 0 ? 1 : v * s < 0 ? -1 : 0;
  }
  const pass = d.invert ? v < (d.thr ?? 0) : v > (d.thr ?? 0);
  return pass ? 1 : -1;
}

// ─────────────────────────────────────────────────────────────────────────────
type Filter = (sym: string, time: number, dir: Dir) => boolean;
type Sizer = (sym: string, time: number, dir: Dir) => number;
type Win = ReturnType<typeof coreWindow>;
const decayH = (k: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k);

function admitFilter(f: Filter | null, sizer: Sizer | null): AdmitFn {
  const heat = decayH(T.heatDecayK);
  return (c: AdmitCtx) => {
    if (c.kind !== "entry") return heat(c);
    if (f && !f(c.rawSymbol, c.time, c.dir)) return 0;
    const mult = sizer ? sizer(c.rawSymbol, c.time, c.dir) : 1;
    return heat(c) * mult;
  };
}

interface Row { sharpe: number; netR: number; maxDD: number; netDd: number; era: number[]; pos: number }

function scoreOf(bs: Book[], admit: AdmitFn, w: Win): Row {
  const res = runBooks(bs, admit);
  const m = riskMetrics(res.equity.filter((e) => e.time >= w.from && e.time <= w.to));
  const eras = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
  const tr = res.trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);
  return {
    sharpe: m.sharpe, netR: m.netR, maxDD: m.maxDD, netDd: m.netOverMaxDD,
    era: eras.map((e) => e.sharpe), pos: new Set(tr.map((t) => `${t.book}#${t.positionId}`)).size,
  };
}

function rng(seed: number) {
  let s = seed;
  return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function randomFilter(p: number, seed: number): Filter {
  const r = rng(seed);
  const cache = new Map<string, boolean>();
  return (sym, time) => {
    const k = `${sym}|${time}`;
    let v = cache.get(k);
    if (v === undefined) { v = r() < p; cache.set(k, v); }
    return v;
  };
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  console.log(`Nạp ${CORE8.length} symbol CORE8, ${days} ngày nến 4h...`);
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  const pre = buildPre(data);
  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));
  const both = [...bk(turtle, "t"), ...bk(fast, "f")];

  const base = scoreOf(both, admitFilter(null, null), w);
  const basePos = base.pos;
  console.log(`Cửa sổ ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)}`);
  console.log(`BASELINE: Sharpe ${base.sharpe.toFixed(3)} · NET ${base.netR.toFixed(0)}R · NET/DD ${base.netDd.toFixed(2)} · era ${base.era.map((x) => x.toFixed(2)).join("/")} · ${basePos} vị thế\n`);

  // ── ĐƯỜNG CONG NHÓM GIẢ: Sharpe TỐT NHẤT của 9 bộ lọc ngẫu nhiên, theo tỉ lệ giữ lệnh ──
  // Rẻ hơn nhiều so với chạy 9 nhóm giả riêng cho từng ứng viên, và cho đúng cùng thông tin.
  console.log("Dựng đường cong nhóm giả (lọc NGẪU NHIÊN theo tỉ lệ giữ lệnh)...");
  const RATES = [0.3, 0.45, 0.6, 0.75, 0.85, 0.92, 0.96, 0.99, 1.0];
  const curve: { rate: number; best: number; med: number }[] = [];
  for (const r of RATES) {
    const ss: number[] = [];
    for (let s = 0; s < 9; s++) ss.push(scoreOf(both, admitFilter(randomFilter(r, 5000 + s * 131), null), w).sharpe);
    ss.sort((a, b) => a - b);
    curve.push({ rate: r, best: ss[8], med: ss[4] });
  }
  console.log("  giữ%   " + curve.map((x) => `${(x.rate * 100).toFixed(0)}%`.padStart(7)).join(""));
  console.log("  giả TỐT NHẤT" + curve.map((x) => x.best.toFixed(2).padStart(7)).join(""));
  const placeboBest = (keep: number): number => {
    if (keep >= 1) return curve[curve.length - 1].best;
    for (let i = 1; i < curve.length; i++) {
      if (keep <= curve[i].rate) {
        const t = (keep - curve[i - 1].rate) / (curve[i].rate - curve[i - 1].rate);
        return curve[i - 1].best + t * (curve[i].best - curve[i - 1].best);
      }
    }
    return curve[curve.length - 1].best;
  };

  const HDR = "  " + "biến thể".padEnd(30) + "giữ%".padStart(6) + "Sharpe".padStart(8) + "Δ".padStart(7) +
    "NET R".padStart(8) + "NET/DD".padStart(8) + "  era A/B/C".padEnd(20) + "giả".padStart(6) + "  kết luận";

  const verdictOf = (r: Row, keep: number) => {
    const pb = placeboBest(keep);
    const eraOk = r.era.every((x, i) => x > base.era[i] * 0.9);
    return { pb, v: r.sharpe <= base.sharpe || r.netDd <= base.netDd ? "thua baseline" : r.sharpe <= pb ? "THUA NHIỄU" : !eraOk ? "rớt era" : "★ QUA" };
  };
  const printRow = (label: string, r: Row, keep: number) => {
    const { pb, v } = verdictOf(r, keep);
    console.log("  " + label.padEnd(30) + (keep * 100).toFixed(0).padStart(5) + "%" +
      r.sharpe.toFixed(3).padStart(8) + ((r.sharpe - base.sharpe >= 0 ? "+" : "") + (r.sharpe - base.sharpe).toFixed(3)).padStart(7) +
      r.netR.toFixed(0).padStart(8) + r.netDd.toFixed(2).padStart(8) + "  " +
      r.era.map((x) => x.toFixed(2)).join("/").padEnd(20) + pb.toFixed(2).padStart(6) + "  " + v);
    return v;
  };

  // ═══ PHẦN A: 26 chỉ báo MỚI, mỗi cái một bộ lọc ═══
  console.log("\n" + "═".repeat(118));
  console.log(`  A) ${DEFS.length} CHỈ BÁO MỚI — mỗi cái làm bộ lọc riêng`);
  console.log("═".repeat(118));
  console.log(HDR);
  console.log("-".repeat(118));
  const passA: string[] = [];
  let lastFam = "";
  for (let k = 0; k < DEFS.length; k++) {
    if (DEFS[k].family !== lastFam) { console.log("  " + "·".repeat(114) + `  [${DEFS[k].family}]`); lastFam = DEFS[k].family; }
    const f: Filter = (s, t, d) => vote(pre, k, s, t, d) > 0;
    const r = scoreOf(both, admitFilter(f, null), w);
    if (printRow(DEFS[k].name, r, r.pos / basePos) === "★ QUA") passA.push(DEFS[k].name);
  }

  // ═══ PHẦN B: GỘP ═══
  console.log("\n" + "═".repeat(118));
  console.log(`  B) GỘP NHIỀU CHỈ BÁO — trung bình phiếu S ∈ [−1,+1], KHÔNG chọn cái nào, KHÔNG tham số fit`);
  console.log("═".repeat(118));
  const all = DEFS.map((_, k) => k);
  const famIdx = (f: SigDef["family"]) => DEFS.map((d, k) => (d.family === f ? k : -1)).filter((k) => k >= 0);
  const scoreS = (idxs: number[]): Sizer => (s, t, d) => {
    let acc = 0;
    for (const k of idxs) acc += vote(pre, k, s, t, d);
    return acc / idxs.length;
  };

  console.log(`\n  B1) GỘP TẤT CẢ ${DEFS.length} chỉ báo, vào lệnh khi S ≥ ngưỡng`);
  console.log(HDR);
  console.log("-".repeat(118));
  const sAll = scoreS(all);
  const passB: string[] = [];
  for (const thr of [-0.4, -0.2, 0, 0.2, 0.4]) {
    const f: Filter = (s, t, d) => sAll(s, t, d) >= thr;
    const r = scoreOf(both, admitFilter(f, null), w);
    if (printRow(`vote TẤT CẢ, S ≥ ${thr.toFixed(1)}`, r, r.pos / basePos) === "★ QUA") passB.push(`vote≥${thr}`);
  }

  console.log(`\n  B2) GỘP THEO HỌ — nhiễu có độc lập giữa các họ không?`);
  console.log(HDR);
  console.log("-".repeat(118));
  for (const fam of ["momentum", "trendiness", "volume"] as SigDef["family"][]) {
    const idxs = famIdx(fam);
    const sf = scoreS(idxs);
    for (const thr of [0, 0.2]) {
      const f: Filter = (s, t, d) => sf(s, t, d) >= thr;
      const r = scoreOf(both, admitFilter(f, null), w);
      if (printRow(`${fam}(${idxs.length}) S ≥ ${thr.toFixed(1)}`, r, r.pos / basePos) === "★ QUA") passB.push(`${fam}≥${thr}`);
    }
  }

  console.log(`\n  B3) DÙNG LÀM SIZE, KHÔNG CHẶN LỆNH — giữ 100% lệnh, chỉ nhân tỉ trọng (1 + λ·S)`);
  console.log(`      (cách dùng gần tài liệu nhất, và KHÔNG đẩy thêm unit xuống dưới sàn minNotional)`);
  console.log(HDR);
  console.log("-".repeat(118));
  for (const lam of [0.25, 0.5, 0.75, 1.0]) {
    const sizer: Sizer = (s, t, d) => Math.max(0.05, 1 + lam * sAll(s, t, d));
    const r = scoreOf(both, admitFilter(null, sizer), w);
    if (printRow(`size × (1 + ${lam.toFixed(2)}·S)`, r, r.pos / basePos) === "★ QUA") passB.push(`size λ=${lam}`);
  }

  console.log("\n" + "-".repeat(118));
  console.log(`  QUA CỬA — chỉ báo lẻ: ${passA.length ? passA.join(" | ") : "KHÔNG CÓ"}`);
  console.log(`  QUA CỬA — bản gộp   : ${passB.length ? passB.join(" | ") : "KHÔNG CÓ"}`);
  console.log(
    `\n  Tổng số biến thể đã thử trong file này: ${DEFS.length + 5 + 6 + 4}. Cộng 37 của vòng trước = ` +
    `${DEFS.length + 5 + 6 + 4 + 37}.\n  Chạy scripts/exp-reality-check.ts --all để chấm CẢ RỔ bằng White Reality Check + Hansen SPA —\n` +
    `  đó mới là con số quyết định, không phải cột "kết luận" ở trên.`,
  );
}

/**
 * Toàn bộ biến thể của file này dưới dạng danh sách, để `exp-reality-check.ts --all` chấm CHUNG rổ
 * với 37 biến thể của vòng trước. Quan trọng: Reality Check phải nhìn thấy MỌI luật đã từng thử,
 * nếu không thì chính nó lại thành một phép kiểm bị data-snooping.
 */
export function comboVariants(pre: Map<string, Pre>): { label: string; f: Filter | null; sizer: Sizer | null }[] {
  const all = DEFS.map((_, k) => k);
  const famIdx = (fam: SigDef["family"]) => DEFS.map((d, k) => (d.family === fam ? k : -1)).filter((k) => k >= 0);
  const scoreS = (idxs: number[]): Sizer => (s, t, d) => {
    let acc = 0;
    for (const k of idxs) acc += vote(pre, k, s, t, d);
    return acc / idxs.length;
  };
  const out: { label: string; f: Filter | null; sizer: Sizer | null }[] = [];
  for (let k = 0; k < DEFS.length; k++) {
    out.push({ label: DEFS[k].name, f: (s, t, d) => vote(pre, k, s, t, d) > 0, sizer: null });
  }
  const sAll = scoreS(all);
  for (const thr of [-0.4, -0.2, 0, 0.2, 0.4]) {
    out.push({ label: `vote TẤT CẢ ≥ ${thr}`, f: (s, t, d) => sAll(s, t, d) >= thr, sizer: null });
  }
  for (const fam of ["momentum", "trendiness", "volume"] as SigDef["family"][]) {
    const sf = scoreS(famIdx(fam));
    for (const thr of [0, 0.2]) {
      out.push({ label: `${fam} ≥ ${thr}`, f: (s, t, d) => sf(s, t, d) >= thr, sizer: null });
    }
  }
  for (const lam of [0.25, 0.5, 0.75, 1.0]) {
    out.push({ label: `size × (1+${lam}·S)`, f: null, sizer: (s, t, d) => Math.max(0.05, 1 + lam * sAll(s, t, d)) });
  }
  return out;
}

export { DEFS, buildPre as buildComboPre, vote, type SigDef, type Filter as ComboFilter, type Sizer as ComboSizer };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
