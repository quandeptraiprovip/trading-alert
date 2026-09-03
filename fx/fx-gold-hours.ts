/**
 * fx-gold-hours.ts — họ CUỐI chưa đo trên vàng: DRIFT THEO GIỜ TRONG NGÀY.
 *
 * VÌ SAO HỌ NÀY, sau khi phá-vỡ-phiên đã rớt: bài phá vỡ phiên (fx-session.ts trên XAUUSD) cho
 * gross +207R t=2,95 nhưng NET −25R, và phân rã theo năm cho thấy gross suy giảm (9,5 → 14,7 → 4,1
 * R/năm qua ba era) đúng lúc spread nén xuống. Chẩn đoán: R của nó = bề rộng biên độ Á (~0,3% giá)
 * nên chi phí chiếm 0,03–0,16 R/lệnh. Muốn cùng một tín hiệu mà chi phí nhẹ đi thì phải NỚI mẫu số,
 * tức giữ vị thế qua một đoạn giá lớn hơn, không phải lọc tín hiệu kỹ hơn.
 *
 * Drift theo giờ là dạng rẻ nhất của việc đó: MỘT lệnh/ngày, vào và ra ở hai mốc giờ cố định, mẫu số
 * là biến động cả đoạn giữ. Cấu trúc này cũng ĐỘC LẬP với trend/breakout — nó hỏi "tiền của vàng
 * sinh ra vào KHUNG GIỜ nào", câu hỏi mà cả bốn họ đã đo trước đây đều không chạm tới.
 *
 * KỶ LUẬT (khai báo trước khi nhìn số):
 *   - Đo lợi suất trung bình từng giờ UTC trên TOÀN mẫu, kèm t-stat. Không chọn giờ rồi mới test.
 *   - Chia BA ERA bằng nhau. Ứng viên phải cùng dấu ở cả ba — một giờ chỉ dương ở một era là nhiễu.
 *   - In BIÊN PHÁT HIỆN: chi phí một vòng (spread + trượt) quy ra bps, đặt cạnh biên độ drift.
 *   - Đối chứng MUA-VÀ-GIỮ: vàng tăng 2004→2026 nên MỌI khung giờ đều thừa hưởng drift nền. Số phải
 *     đọc là phần VƯỢT drift nền theo giờ, không phải mức tuyệt đối.
 *
 * Chạy: npx ts-node fx/fx-gold-hours.ts [SYMBOL]
 */

import { FxCandle, loadH1 } from "./fx-data";

const SYMBOL = process.argv[2] ?? "XAUUSD";
const SLIP_PCT = 0.002;

interface HourStat { hour: number; n: number; meanBps: number; t: number; eraBps: number[] }

function tStat(v: number[]): number {
  const n = v.length;
  if (n < 2) return 0;
  const mu = v.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / (n - 1));
  return sd > 0 ? mu / (sd / Math.sqrt(n)) : 0;
}
const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);

function main() {
  const bars: FxCandle[] = loadH1(SYMBOL);
  const t0 = bars[0].openTime, t1 = bars[bars.length - 1].openTime;
  const edge1 = t0 + (t1 - t0) / 3, edge2 = t0 + (2 * (t1 - t0)) / 3;

  // Lợi suất của TỪNG nến H1, gom theo giờ UTC. Dùng close→close để khớp cách vào/ra ở mốc giờ.
  const byHour = new Map<number, number[]>();
  const byHourEra: Map<number, number[][]> = new Map();
  for (let i = 1; i < bars.length; i++) {
    const r = (bars[i].close - bars[i - 1].close) / bars[i - 1].close * 1e4; // bps
    if (!Number.isFinite(r)) continue;
    const h = new Date(bars[i].openTime).getUTCHours();
    if (!byHour.has(h)) { byHour.set(h, []); byHourEra.set(h, [[], [], []]); }
    byHour.get(h)!.push(r);
    const e = bars[i].openTime < edge1 ? 0 : bars[i].openTime < edge2 ? 1 : 2;
    byHourEra.get(h)![e].push(r);
  }

  const all = [...byHour.values()].flat();
  const baseBps = mean(all);

  console.log(`═══ DRIFT THEO GIỜ — ${SYMBOL}, ${bars.length} nến H1, ` +
    `${new Date(t0).toISOString().slice(0, 7)} → ${new Date(t1).toISOString().slice(0, 7)} ═══`);
  console.log(`Drift nền (mọi giờ) = ${baseBps.toFixed(3)} bps/giờ. Cột "vượt nền" mới là thứ đáng đọc.\n`);

  const stats: HourStat[] = [];
  for (const h of [...byHour.keys()].sort((a, b) => a - b)) {
    const v = byHour.get(h)!;
    stats.push({ hour: h, n: v.length, meanBps: mean(v), t: tStat(v), eraBps: byHourEra.get(h)!.map(mean) });
  }

  console.log("giờ UTC".padEnd(9) + "n".padStart(7) + "bps/giờ".padStart(10) + "vượt nền".padStart(10) +
    "t".padStart(7) + "   era1 / era2 / era3 (bps)" + "   3 era cùng dấu?");
  for (const s of stats) {
    const same = s.eraBps.every((x) => x > 0) || s.eraBps.every((x) => x < 0);
    console.log(
      `${String(s.hour).padStart(2, "0")}:00`.padEnd(9) + String(s.n).padStart(7) +
      s.meanBps.toFixed(3).padStart(10) + (s.meanBps - baseBps).toFixed(3).padStart(10) +
      s.t.toFixed(2).padStart(7) + "   " +
      s.eraBps.map((x) => x.toFixed(2).padStart(6)).join(" /") +
      (same ? "   ✅" : "   —"),
    );
  }

  // ── BIÊN PHÁT HIỆN ──
  // Một chiến lược "giữ từ giờ A đến giờ B" trả chi phí MỘT vòng. So biên độ drift tích luỹ được
  // với chi phí đó; nếu drift < chi phí thì kết quả dương trên giấy vẫn không giao dịch được.
  const spreadBps = mean(bars.map((b) => (b.spread / b.close) * 1e4));
  const spreadBpsRecent = mean(bars.filter((b) => b.openTime >= edge2).map((b) => (b.spread / b.close) * 1e4));
  const roundTrip = spreadBpsRecent + 2 * SLIP_PCT * 100;
  console.log(`\n─── BIÊN PHÁT HIỆN ───`);
  console.log(`spread TB toàn mẫu ${spreadBps.toFixed(2)} bps · era3 ${spreadBpsRecent.toFixed(2)} bps ` +
    `· trượt ${(2 * SLIP_PCT * 100).toFixed(2)} bps ⇒ MỘT VÒNG ≈ ${roundTrip.toFixed(2)} bps`);

  // Khối giờ liên tiếp tốt nhất (chỉ để BÁO CÁO độ lớn, KHÔNG phải đề xuất — chọn hậu nghiệm).
  let best = { from: 0, to: 0, bps: -Infinity, allEra: false };
  for (let a = 0; a < 24; a++) {
    for (let len = 1; len <= 12; len++) {
      const hs = Array.from({ length: len }, (_, i) => (a + i) % 24);
      const sel = hs.map((h) => stats.find((s) => s.hour === h)!);
      const bps = sel.reduce((s, x) => s + x.meanBps, 0);
      const eras = [0, 1, 2].map((e) => sel.reduce((s, x) => s + x.eraBps[e], 0));
      if (bps > best.bps) best = { from: a, to: (a + len) % 24, bps, allEra: eras.every((x) => x > 0) };
    }
  }
  console.log(`Khối giờ tốt nhất (HẬU NGHIỆM, chỉ để so độ lớn): ${String(best.from).padStart(2, "0")}:00→` +
    `${String(best.to).padStart(2, "0")}:00 = ${best.bps.toFixed(2)} bps/ngày · 3 era cùng dương: ${best.allEra ? "có" : "KHÔNG"}`);
  console.log(`⇒ tỉ lệ drift/chi phí = ${(best.bps / roundTrip).toFixed(2)}× ` +
    `${best.bps / roundTrip < 2 ? "(dưới 2× ⇒ không đủ biên an toàn để giao dịch)" : ""}`);

  console.log(`\n─── ĐỐI CHỨNG MUA-VÀ-GIỮ ───`);
  const days = (t1 - t0) / 86400e3;
  const bhTotal = (bars[bars.length - 1].close / bars[0].close - 1) * 100;
  console.log(`Mua-và-giữ ${SYMBOL}: +${bhTotal.toFixed(0)}% trong ${(days / 365).toFixed(1)} năm ` +
    `= ${(baseBps * 24 * 365 / 100).toFixed(1)}%/năm drift nền, chi phí MỘT lần.`);
  console.log(`Chiến lược theo giờ trả ${roundTrip.toFixed(2)} bps × ~252 vòng/năm = ` +
    `${(roundTrip * 252 / 100).toFixed(1)}%/năm chi phí.`);

  // ── BACKTEST THẬT ──
  // Bảng bps ở trên KHÔNG phải chiến lược: nó bỏ qua ghép lãi, phương sai, và trả chi phí đúng
  // từng vòng. Dựng "long từ giờ A đến giờ B mỗi ngày", chi phí = spread ĐO ĐƯỢC ở nến vào + trượt.
  // Đối chứng bắt buộc là MUA-VÀ-GIỮ — đây chính là phép đã giết nhánh vàng lần trước.
  const idxByTime = bars.map((b, i) => ({ i, h: new Date(b.openTime).getUTCHours(), t: b.openTime }));
  const holdWindow = (from: number, to: number) => {
    const rets: { t: number; r: number }[] = [];
    let entryI = -1;
    for (const { i, h } of idxByTime) {
      if (entryI < 0 && h === from) { entryI = i; continue; }
      if (entryI >= 0 && h === to) {
        const e = bars[entryI], x = bars[i];
        const cost = (e.spread / e.close) + 2 * (SLIP_PCT / 100);
        rets.push({ t: e.openTime, r: (x.close - e.close) / e.close - cost });
        entryI = -1;
      }
    }
    return rets;
  };
  const perf = (rets: { t: number; r: number }[], perYear: number) => {
    const v = rets.map((x) => x.r);
    const mu = mean(v);
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / (v.length - 1));
    let eq = 1, peak = 1, dd = 0;
    for (const x of v) { eq *= 1 + x; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
    return { n: v.length, cagr: (eq ** (perYear / v.length) - 1) * 100, vol: sd * Math.sqrt(perYear) * 100,
      sharpe: sd > 0 ? (mu / sd) * Math.sqrt(perYear) : 0, dd: dd * 100 };
  };
  const eraOf = (t: number) => (t < edge1 ? 0 : t < edge2 ? 1 : 2);

  console.log(`\n═══ BACKTEST — long theo khối giờ vs MUA-VÀ-GIỮ (đã trừ spread đo được + trượt) ═══`);
  console.log("chiến lược".padEnd(30) + "lệnh".padStart(7) + "CAGR".padStart(9) + "vol".padStart(8) +
    "Sharpe".padStart(8) + "maxDD".padStart(8) + "   Sharpe era1/2/3");

  // Mua-và-giữ: chuỗi lợi suất NGÀY, chi phí một lần (bỏ qua, có lợi cho đối chứng).
  const dayClose = new Map<number, FxCandle>();
  for (const b of bars) dayClose.set(Math.floor((b.openTime - 22 * 3600e3) / 86400e3), b);
  const dks = [...dayClose.keys()].sort((a, b) => a - b);
  const bh = dks.slice(1).map((d, i) => ({ t: dayClose.get(d)!.openTime,
    r: (dayClose.get(d)!.close - dayClose.get(dks[i])!.close) / dayClose.get(dks[i])!.close }));

  const cands: [string, { t: number; r: number }[]][] = [
    ["MUA-VÀ-GIỮ (đối chứng)", bh],
    [`khối hậu nghiệm ${best.from}h→${best.to}h`, holdWindow(best.from, best.to)],
    ["22h→00h (t cao nhất, 3 era +)", holdWindow(22, 0)],
    ["22h→04h", holdWindow(22, 4)],
  ];
  for (const [label, rets] of cands) {
    if (!rets.length) continue;
    const p = perf(rets, 252);
    const eras = [0, 1, 2].map((e) => {
      const sub = rets.filter((x) => eraOf(x.t) === e);
      return sub.length > 30 ? perf(sub, 252).sharpe : NaN;
    });
    console.log(
      label.padEnd(30) + String(p.n).padStart(7) + `${p.cagr.toFixed(1)}%`.padStart(9) +
      `${p.vol.toFixed(1)}%`.padStart(8) + p.sharpe.toFixed(2).padStart(8) + `${p.dd.toFixed(0)}%`.padStart(8) +
      "   " + eras.map((x) => (Number.isNaN(x) ? "  n/a" : x.toFixed(2).padStart(5))).join(" /"));
  }
}

if (require.main === module) main();
