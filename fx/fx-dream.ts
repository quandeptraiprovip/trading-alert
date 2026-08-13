/**
 * fx-dream.ts — áp phương pháp Key + Volume (FX Dream) lên CẶP TIỀN và VÀNG.
 *
 * VÌ SAO ĐÁNG THỬ: phương pháp này đang được dùng trên crypto, nhưng tên của nó và toàn bộ từ vựng
 * (key, sweep, SFP, trap) đến từ thế giới FX. Ba vòng nghiên cứu trước đã loại trend và nhân tố
 * trên cặp tiền, nhưng CHƯA từng thử họ phương pháp phản ứng-tại-mức-giá. Đó là một cơ chế khác
 * hẳn: không dự đoán xu hướng, mà chờ giá quay lại một vùng đã có dấu vết và giao dịch cú phản ứng.
 *
 * ─── HAI ĐIỀU PHẢI NÓI TRƯỚC KHI ĐỌC BẤT KỲ SỐ NÀO ───
 *
 * 1. VOLUME Ở FX KHÔNG PHẢI KHỐI LƯỢNG KHỚP THẬT. Thị trường ngoại hối phi tập trung, không có sổ
 *    lệnh trung tâm nên KHÔNG TỒN TẠI khối lượng giao dịch thật. Con số `volume` trong dữ liệu
 *    Dukascopy là volume theo TICK (số lần giá cập nhật) của riêng nguồn cấp giá đó. Với một
 *    phương pháp mà "volume đột biến" là điều kiện SINH ra Key, đây là một sự thay thế căn bản chứ
 *    không phải sai số nhỏ. Vàng (XAUUSD) cũng vậy — nó là CFD, không phải hợp đồng sàn.
 *    ⇒ Mọi kết quả dưới đây phải đọc như "phương pháp chạy trên proxy hoạt động giá", không phải
 *      "phương pháp chạy đúng như trên crypto".
 *
 * 2. DỊCH THANG THỜI GIAN. Phương pháp gốc chạy nền 5m (thang 5m/15m/1h/4h). Dữ liệu FX ở đây chỉ
 *    có H1 và ngày. Thang được dịch LÊN MỘT BẬC giữ nguyên tỉ lệ: 1h/4h/1d/1w. Mọi tham số khác
 *    GIỮ NGUYÊN — đây là bản zero-tuning, cùng nguyên tắc đã dùng cho fx-transfer.ts.
 *    Lý do dịch thay vì tải nến 5m: nghiên cứu trước cho thấy FX trong ngày là nơi chi phí giết
 *    tất cả (fx-session.ts: 12.453 lệnh, expectancy −0,0016R). Chạy nền 5m trên EURUSD nghĩa là
 *    biên độ nến ~2–4 bps so với spread 0,9 bps — tỉ lệ vô vọng.
 *
 * ─── NỢ KỸ THUẬT ĐÃ BIẾT, ÁP DỤNG NGUYÊN VÀO ĐÂY ───
 * `minRR: 3` trong cấu hình mặc định là một BỘ LỌC CHỌN STOP SUY BIẾN (13 lệnh so với 787 khi bỏ).
 * Vì thế mọi bảng dưới đây in kèm SỐ LỆNH, và một kết quả "Sharpe đẹp trên 15 lệnh" phải bị coi là
 * hiện vật của bộ lọc chứ không phải bằng chứng.
 *
 * Chạy: npx ts-node fx/fx-dream.ts
 */

import { CONFIG } from "../strategy";
import {
  KEY_VOLUME_CONFIG, KeyVolumeParams, KeyVolumeTrade, runKeyVolume,
} from "../key-volume";
import { fxCostParams } from "./fx-transfer";
import { loadH1, medianSpreadPct } from "./fx-data";

/** Vàng + bạc + các cặp có nến giờ. Khai báo trước, không chọn theo kết quả. */
const GOLD = ["XAUUSD", "XAGUSD"];
const MAJORS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const CROSSES = ["EURJPY", "GBPJPY", "EURGBP", "AUDJPY"];

/**
 * Thang dịch lên một bậc. Ép kiểu vì các trường TF được khai báo bằng literal type của thang gốc,
 * nhưng runtime chỉ tra bảng TF_MS nên mọi khung đều chạy được. KHÔNG sửa key-volume.ts — đó là
 * file đã audit, và một nghiên cứu không được phép đổi thứ nó đang đo.
 */
function shifted(over: Partial<KeyVolumeParams> = {}): KeyVolumeParams {
  return {
    ...KEY_VOLUME_CONFIG,
    baseTf: "1h", confirmTf: "4h", keyTf: "1d", confluenceTf: "1w",
    dailyTf: "1d", weeklyTf: "1w",
    ...over,
  } as unknown as KeyVolumeParams;
}

interface Row {
  label: string; n: number; wr: number; net: number; exp: number;
  gross: number; cost: number; maxDD: number; bestYearPct: number; nYears: number; posYears: number;
}

function score(label: string, trades: KeyVolumeTrade[]): Row {
  if (trades.length === 0) {
    return { label, n: 0, wr: 0, net: 0, exp: 0, gross: 0, cost: 0, maxDD: 0, bestYearPct: 0, nYears: 0, posYears: 0 };
  }
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let cum = 0, peak = 0, maxDD = 0;
  const byYear = new Map<number, number>();
  for (const t of sorted) {
    cum += t.netR; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum);
    const y = new Date(t.exitTime).getUTCFullYear();
    byYear.set(y, (byYear.get(y) ?? 0) + t.netR);
  }
  const yrs = [...byYear.values()];
  const total = yrs.reduce((s, x) => s + x, 0);
  return {
    label, n: trades.length,
    wr: trades.filter((t) => t.netR > 0).length / trades.length * 100,
    net: cum, exp: cum / trades.length,
    gross: trades.reduce((s, t) => s + t.grossR, 0),
    cost: trades.reduce((s, t) => s + t.costR, 0),
    maxDD,
    bestYearPct: total > 0 ? (Math.max(...yrs) / total) * 100 : 0,
    nYears: yrs.length, posYears: yrs.filter((x) => x > 0).length,
  };
}

const HDR = "rổ / cấu hình".padEnd(30) + "lệnh".padStart(7) + "WR%".padStart(7) +
  "NET R".padStart(9) + "exp/lệnh".padStart(10) + "gộp R".padStart(9) + "phí R".padStart(9) +
  "maxDD".padStart(8) + "năm+".padStart(8);

function show(r: Row, warn = true) {
  const flag = warn && r.n > 0 && r.n < 30 ? "  ⚠️ quá ít lệnh" : "";
  console.log(
    r.label.padEnd(30) + String(r.n).padStart(7) + r.wr.toFixed(0).padStart(7) +
    r.net.toFixed(1).padStart(9) + r.exp.toFixed(3).padStart(10) +
    r.gross.toFixed(1).padStart(9) + r.cost.toFixed(1).padStart(9) +
    r.maxDD.toFixed(1).padStart(8) + `${r.posYears}/${r.nYears}`.padStart(8) + flag,
  );
}

/** Chạy một rổ; chi phí đặt theo TỪNG cặp vì spread lệch nhau nhiều lần. */
function runSet(symbols: string[], params: KeyVolumeParams): KeyVolumeTrade[] {
  const out: KeyVolumeTrade[] = [];
  for (const s of symbols) {
    const candles = loadH1(s);
    const c = fxCostParams(candles);
    CONFIG.costs.takerFeePct = c.takerFeePct;
    CONFIG.costs.slippagePct = c.slippagePct;
    out.push(...runKeyVolume(s, candles, params).trades);
  }
  return out;
}

function main() {
  CONFIG.costs.enabled = true;
  CONFIG.costs.fundingPer8hPct = 0.0014; // swap qua đêm, như các nghiên cứu FX trước

  console.log("═══ §0. DỮ LIỆU — spread và volume ═══");
  for (const s of [...GOLD, ...MAJORS.slice(0, 3)]) {
    const c = loadH1(s);
    const vols = c.slice(-2000).map((x) => x.volume);
    const mv = vols.reduce((a, b) => a + b, 0) / vols.length;
    console.log(
      `${s.padEnd(9)} ${String(c.length).padStart(6)} nến H1 · spread ${medianSpreadPct(c).toFixed(4)}%` +
      ` · volume tick bq ${mv.toFixed(0)} (KHÔNG phải khối lượng khớp thật)`,
    );
  }

  const base = shifted();
  console.log("\n═══ §1. ZERO-TUNING — thang dịch lên một bậc, mọi tham số khác GIỮ NGUYÊN ═══");
  console.log(`Thang: nền ${base.baseTf} · xác nhận ${base.confirmTf} · key ${base.keyTf} · hợp lưu ${base.confluenceTf}`);
  console.log(`minRR ${base.minRR} · stop ${base.stopMode} · trigger ${base.entryTrigger} · maxStopPct ${base.maxStopPct}\n`);
  console.log(HDR);
  const goldT = runSet(GOLD, base);
  const majT = runSet(MAJORS, base);
  const crossT = runSet(CROSSES, base);
  show(score("vàng+bạc", goldT));
  show(score("7 major", majT));
  show(score("4 cross", crossT));
  show(score("TẤT CẢ 13", [...goldT, ...majT, ...crossT]));

  // ── §2. Bỏ bộ lọc minRR — nợ kỹ thuật đã biết ──
  console.log("\n═══ §2. BỎ minRR=3 — bộ lọc này CHỌN stop suy biến (nợ kỹ thuật đã ghi nhận) ═══");
  console.log(HDR);
  const noRR = shifted({ minRR: 0, requireStructuralTarget: false });
  const g2 = runSet(GOLD, noRR), m2 = runSet(MAJORS, noRR), c2 = runSet(CROSSES, noRR);
  show(score("vàng+bạc, minRR=0", g2));
  show(score("7 major, minRR=0", m2));
  show(score("4 cross, minRR=0", c2));
  show(score("TẤT CẢ 13, minRR=0", [...g2, ...m2, ...c2]));

  // ── §3. Từng công cụ — kết quả có do một cái gánh không ──
  console.log("\n═══ §3. TỪNG CÔNG CỤ (cấu hình §2, nhiều lệnh hơn nên đọc được) ═══");
  console.log(HDR);
  for (const s of [...GOLD, ...MAJORS, ...CROSSES]) {
    show(score(s, runSet([s], noRR)));
  }

  // ── §4. Chi phí có phải thứ giết không ──
  console.log("\n═══ §4. NGƯỠNG CHI PHÍ — nếu GỘP đã âm thì chi phí không phải nguyên nhân ═══");
  const all2 = [...g2, ...m2, ...c2];
  const s4 = score("tất cả", all2);
  console.log(
    `Toàn rổ, minRR=0: gộp ${s4.gross.toFixed(1)}R · phí ${s4.cost.toFixed(1)}R · ròng ${s4.net.toFixed(1)}R` +
    ` trên ${s4.n} lệnh (${(s4.cost / Math.max(1, s4.n)).toFixed(3)}R phí/lệnh)`,
  );
  console.log(
    s4.gross > 0
      ? "GỘP DƯƠNG ⇒ có tín hiệu, câu hỏi chuyển sang chi phí có nuốt hết không."
      : "GỘP ÂM ⇒ không có tín hiệu để chi phí giết. Chi phí không phải nguyên nhân.",
  );

  // ── §5. Đối chứng: cùng cấu hình trên crypto ──
  console.log(
    "\n═══ §5. ĐỌC KẾT QUẢ ═══\n" +
    "Phép so đúng KHÔNG phải với crypto ở thang gốc (khác cả thang lẫn loại volume), mà là hai\n" +
    "câu hỏi trong chính bảng trên:\n" +
    "  (a) GỘP có dương không — nếu âm thì không có gì để tối ưu.\n" +
    "  (b) Vàng có khác các cặp tiền không — vàng là công cụ duy nhất có tín hiệu trend thật ở\n" +
    "      các vòng trước, nên nếu FX Dream có chỗ đứng thì nhiều khả năng ở đó.",
  );
}

if (require.main === module) main();
