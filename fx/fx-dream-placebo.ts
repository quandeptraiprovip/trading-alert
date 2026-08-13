/**
 * fx-dream-placebo.ts — đo THẲNG điều kiện SINH RA Key, tách khỏi mọi thứ khác.
 *
 * VÌ SAO CẦN PHÉP NÀY: hai phép đo trước (fx-dream.ts thang dịch, fx-dream-native.ts nền 5m) đều
 * cho kết quả âm, nhưng cả hai đều chạy TOÀN BỘ cỗ máy — key → hợp lưu → volume lần hai → sweep →
 * mô hình nến → stop/target. Khi cả cỗ máy ra số âm, ta không biết khâu nào hỏng, và luôn còn chỗ
 * để nói "chắc tại tham số/thang/chi phí". Phép dưới đây bỏ hết cỗ máy và hỏi đúng MỘT câu:
 *
 *   Một mức giá sinh ra tại nến VOLUME ĐỘT BIẾN có phản ứng khác một mức giá sinh ra tại nến
 *   VOLUME BÌNH THƯỜNG không?
 *
 * Nếu KHÔNG khác, thì viên gạch đầu tiên của phương pháp rỗng ở thị trường này, và không tham số
 * nào ở các tầng sau cứu được. Câu trả lời này KHÔNG phụ thuộc chi phí (chưa vào lệnh), KHÔNG phụ
 * thuộc minRR (chưa có stop/target), và KHÔNG phụ thuộc thang (chạy cùng H1 cho cả hai thị trường).
 *
 * ĐỐI CHỨNG DƯƠNG: chạy y hệt trên crypto H1. Nếu crypto có chênh lệch spike−đối chứng mà FX không,
 * thì đó chính là hệ quả của việc FX không có khối lượng khớp thật (volume Dukascopy = volume tick
 * của một feed). Nếu crypto CŨNG không chênh, thì vấn đề nằm ở chính giả thuyết, không ở thị trường.
 *
 * Chạy: npx ts-node fx/fx-dream-placebo.ts
 */

import fs from "fs";
import path from "path";
import { Candle } from "../strategy";
import { KEY_VOLUME_CONFIG as P } from "../key-volume";
import { loadH1 } from "./fx-data";

/** Số nến sau cú chạm dùng để đo phản ứng. 12 nến H1 = nửa ngày, cùng thang với reactionBars. */
const FWD = 12;
/** Trần số Key mỗi nhóm/công cụ — giữ hai nhóm cùng cỡ và giữ thời gian chạy hữu hạn. */
const MAX_LEVELS = 4000;

function atr14(c: Candle[]): number[] {
  const out = new Array(c.length).fill(0);
  let prev = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    prev = i === 1 ? tr : prev + (tr - prev) / 14;
    out[i] = prev;
  }
  return out;
}

function medianOf(v: number[], from: number, to: number): number {
  const s = v.slice(from, to).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

interface Group { n: number; sum: number; sumSq: number }
const empty = (): Group => ({ n: 0, sum: 0, sumSq: 0 });
function add(g: Group, x: number) { g.n++; g.sum += x; g.sumSq += x * x; }
function mean(g: Group) { return g.n ? g.sum / g.n : 0; }
function tstat(g: Group) {
  if (g.n < 2) return 0;
  const m = mean(g);
  const sd = Math.sqrt(Math.max(0, g.sumSq / g.n - m * m));
  return sd > 0 ? m / (sd / Math.sqrt(g.n)) : 0;
}

/**
 * Một lần đo cho một công cụ.
 * `wantSpike=true`: chỉ lấy nến có volume ≥ volumeSpikeMult × trung vị 96 nến trước.
 * `wantSpike=false`: chỉ lấy nến volume BÌNH THƯỜNG (0,9–1,1 × trung vị) — đây là placebo.
 *
 * Với mỗi mức, tìm CÚ CHẠM đầu tiên trong hạn keyMaxAgeDays, xác định giá tiếp cận từ trên hay
 * dưới, rồi đo bước giá FWD nến sau đó theo chiều "bật lại", chuẩn hoá bằng ATR TẠI CÚ CHẠM
 * (không phải tại nến sinh key — nến spike có ATR cao hơn, chuẩn hoá sai chỗ sẽ tự tạo ra chênh lệch).
 */
function measure(c: Candle[], tfMs: number, wantSpike: boolean, fwd = FWD): { all: Group; sweep: Group } {
  const vol = c.map((x) => x.volume * x.close);
  const atr = atr14(c);
  const maxAgeBars = Math.ceil((P.keyMaxAgeDays * 86400e3) / tfMs);
  const g = empty();
  const sw = empty();

  const events: number[] = [];
  for (let i = P.volumeLookback; i < c.length - fwd - 1; i++) {
    const base = medianOf(vol, i - P.volumeLookback, i);
    if (!(base > 0) || !(atr[i] > 0)) continue;
    const ratio = vol[i] / base;
    const ok = wantSpike ? ratio >= P.volumeSpikeMult : ratio >= 0.9 && ratio <= 1.1;
    if (ok) events.push(i);
  }
  // Lấy mẫu đều theo thời gian, không cắt đuôi: cắt đuôi sẽ so hai nhóm ở hai giai đoạn khác nhau.
  const stride = Math.max(1, Math.ceil(events.length / MAX_LEVELS));

  for (let k = 0; k < events.length; k += stride) {
    const i = events[k];
    const price = c[i].close;
    const tol = P.keyTouchAtr * atr[i];
    const limit = Math.min(c.length - fwd - 1, i + maxAgeBars);
    for (let j = i + 2; j <= limit; j++) {
      if (c[j].low > price + tol || c[j].high < price - tol) continue;
      const dir = c[j - 1].close >= price ? 1 : -1; // tiếp cận từ trên ⇒ kỳ vọng bật LÊN
      if (atr[j] > 0) {
        const r = (dir * (c[j + fwd].close - c[j].close)) / atr[j];
        add(g, r);
        // SWEEP (SFP): giá XUYÊN QUA mức rồi ĐÓNG LẠI về phía tiếp cận — đây mới là khoảnh khắc
        // phương pháp thật sự vào lệnh, không phải cú chạm trần. Tách riêng để bác bỏ đúng chỗ:
        // nếu chạm trần rỗng nhưng sweep có tín hiệu thì edge nằm ở khâu này chứ không ở Key.
        const poked = dir > 0 ? c[j].low < price - tol : c[j].high > price + tol;
        const closedBack = dir > 0 ? c[j].close > price : c[j].close < price;
        if (poked && closedBack) add(sw, r);
      }
      break;
    }
  }
  return { all: g, sweep: sw };
}

/**
 * Biên phát hiện: một kết quả "≈ 0" chỉ có nghĩa nếu phép đo ĐỦ SỨC thấy hiệu ứng đáng giao dịch.
 * Nửa khoảng tin cậy 95% của trung bình = 1,96 × sai số chuẩn; hiệu ứng lớn hơn ngưỡng này mà tồn
 * tại thì đã lộ ra. Đối chiếu: một lệnh rủi ro ~1 ATR cần hiệu ứng cỡ 0,1–0,3 ATR mới sống nổi phí.
 */
function halfCi95(g: Group): number {
  if (g.n < 2) return Infinity;
  const m = mean(g);
  const sd = Math.sqrt(Math.max(0, g.sumSq / g.n - m * m));
  return (1.96 * sd) / Math.sqrt(g.n);
}

function row(label: string, spike: Group, ctrl: Group) {
  const d = mean(spike) - mean(ctrl);
  console.log(
    label.padEnd(11) +
    String(spike.n).padStart(7) + mean(spike).toFixed(4).padStart(10) + tstat(spike).toFixed(2).padStart(8) +
    String(ctrl.n).padStart(8) + mean(ctrl).toFixed(4).padStart(10) + tstat(ctrl).toFixed(2).padStart(8) +
    d.toFixed(4).padStart(11),
  );
}

const HDR = "công cụ".padEnd(11) + "n spike".padStart(7) + "pứ spike".padStart(10) + "t".padStart(8) +
  "n đ.chứng".padStart(8) + "pứ đ.chứng".padStart(10) + "t".padStart(8) + "chênh".padStart(11);

function loadCrypto(sym: string): Candle[] | null {
  const p = path.join(process.cwd(), ".cache", "klines", "futures", `${sym.toLowerCase()}_1h.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as Candle[];
}

const H1_MS = 3600e3;
const FX = ["XAUUSD", "XAGUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF",
  "EURJPY", "GBPJPY", "EURGBP", "AUDJPY"];
const CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "DOTUSDT"];

function main() {
  console.log(
    "Đơn vị: bước giá FWD=12 nến sau cú chạm, theo chiều BẬT LẠI, chia cho ATR tại cú chạm.\n" +
    "Giả thuyết của phương pháp: cột \"pứ spike\" phải DƯƠNG và cột \"chênh\" phải DƯƠNG RÕ.\n",
  );

  console.log("═══ FX + kim loại (H1 Dukascopy, ~22 năm) ═══");
  console.log(HDR);
  const fxS = empty(), fxC = empty(), fxSw = empty(), fxCw = empty();
  for (const s of FX) {
    const c = loadH1(s) as unknown as Candle[];
    const sp = measure(c, H1_MS, true), ct = measure(c, H1_MS, false);
    row(s, sp.all, ct.all);
    for (const [dst, src] of [[fxS, sp.all], [fxC, ct.all], [fxSw, sp.sweep], [fxCw, ct.sweep]] as [Group, Group][]) {
      dst.n += src.n; dst.sum += src.sum; dst.sumSq += src.sumSq;
    }
  }
  row("GỘP FX", fxS, fxC);

  console.log("\n═══ ĐỐI CHỨNG DƯƠNG: crypto (H1 Binance, cùng code) ═══");
  console.log(HDR);
  const cS = empty(), cC = empty(), cSw = empty(), cCw = empty();
  for (const s of CRYPTO) {
    const c = loadCrypto(s);
    if (!c || c.length < 20000) { console.log(`${s.padEnd(11)}  — chưa có cache 1h, bỏ qua`); continue; }
    const sp = measure(c, H1_MS, true), ct = measure(c, H1_MS, false);
    row(s, sp.all, ct.all);
    for (const [dst, src] of [[cS, sp.all], [cC, ct.all], [cSw, sp.sweep], [cCw, ct.sweep]] as [Group, Group][]) {
      dst.n += src.n; dst.sum += src.sum; dst.sumSq += src.sumSq;
    }
  }
  row("GỘP crypto", cS, cC);

  // Phản bác hợp lệ với bảng trên: phương pháp KHÔNG vào lệnh ở cú chạm trần, nó chờ SWEEP.
  console.log("\n═══ CHỈ CÚ SWEEP (xuyên qua mức rồi đóng lại) — đúng khoảnh khắc vào lệnh ═══");
  console.log(HDR);
  row("FX", fxSw, fxCw);
  row("crypto", cSw, cCw);

  // Phản bác hợp lệ thứ hai: stop của phương pháp rất sát (dưới cú trap), nên một hiệu ứng chỉ
  // sống vài nến có thể bị trung bình 12 nến rửa sạch. Quét thang thời gian để khỏi phải đoán.
  console.log("\n═══ QUÉT ĐỘ DÀI CỬA SỔ ĐO (nhóm spike, gộp) — hiệu ứng ngắn hạn có bị rửa không ═══");
  console.log("cửa sổ".padEnd(11) + "FX pứ".padStart(10) + "t".padStart(8) + "crypto pứ".padStart(12) + "t".padStart(8));
  for (const h of [1, 3, 6, 24]) {
    const f = empty(), k = empty();
    for (const s of FX) {
      const m = measure(loadH1(s) as unknown as Candle[], H1_MS, true, h).all;
      f.n += m.n; f.sum += m.sum; f.sumSq += m.sumSq;
    }
    for (const s of CRYPTO) {
      const c = loadCrypto(s);
      if (!c || c.length < 20000) continue;
      const m = measure(c, H1_MS, true, h).all;
      k.n += m.n; k.sum += m.sum; k.sumSq += m.sumSq;
    }
    console.log(
      `${h} nến`.padEnd(11) + mean(f).toFixed(4).padStart(10) + tstat(f).toFixed(2).padStart(8) +
      mean(k).toFixed(4).padStart(12) + tstat(k).toFixed(2).padStart(8),
    );
  }

  console.log(
    `\n═══ BIÊN PHÁT HIỆN (một số "≈0" chỉ có nghĩa khi phép đo đủ sức) ═══\n` +
    `FX     : loại trừ được mọi hiệu ứng bật lại lớn hơn ±${halfCi95(fxS).toFixed(4)} ATR/cú chạm (n=${fxS.n}).\n` +
    `crypto : loại trừ được mọi hiệu ứng bật lại lớn hơn ±${halfCi95(cS).toFixed(4)} ATR/cú chạm (n=${cS.n}).\n` +
    "Một lệnh rủi ro ~1 ATR cần hiệu ứng cỡ 0,1–0,3 ATR mới sống nổi phí ⇒ phép đo dư sức thấy thứ\n" +
    "đáng giao dịch, nên số 0 ở đây là KẾT LUẬN chứ không phải thiếu dữ liệu.",
  );

  console.log(
    "\n═══ CÁCH ĐỌC ═══\n" +
    "• \"chênh\" ≈ 0 ở FX nhưng > 0 ở crypto ⇒ volume tick không thay được khối lượng khớp; viên gạch\n" +
    "  đầu tiên của phương pháp rỗng ở FX, các tầng sau không cứu được.\n" +
    "• \"chênh\" ≈ 0 ở CẢ HAI ⇒ vấn đề nằm ở giả thuyết chứ không ở thị trường; khi đó kết quả dương\n" +
    "  của bản crypto phải đến từ khâu khác (sweep/stop/target) chứ không từ điều kiện sinh Key.\n" +
    "• \"pứ\" ÂM ở cả hai nhóm ⇒ giá có xu hướng ĐI TIẾP qua mức, không bật lại.",
  );
}

if (require.main === module) main();
