/**
 * exp-missed-window.ts — 25 NGÀY TẮT MÁY VỪA RỒI ĐÁNG BAO NHIÊU?
 *
 * State cuối ghi 2026-07-20; hôm nay 2026-08-14. Câu hỏi không phải "trung bình downtime tốn bao
 * nhiêu" (đã có trong exp-downtime.ts) mà là câu cụ thể: **đúng cửa sổ này, hệ đã bỏ lỡ gì.**
 *
 * Lưu ý khi đọc: đây là hiệu suất theo R của engine. Nó KHÔNG tự động thành tiền — ở equity thật
 * sàn minNotional nuốt một phần unit (xem memory min-notional-leak). Con số này là CHẶN TRÊN.
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-missed-window.ts [ngày=400]
 */
import { TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, riskMetrics, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, loadPool } from "./exp-breadth";

const OFF_FROM = Date.UTC(2026, 6, 20, 8, 0, 0); // nến cuối được xử lý (lastBarTime của state)
const decayH = (k: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k);

async function main() {
  const days = parseInt(process.argv[2] ?? "400", 10);
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const heat = decayH(T.heatDecayK);
  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));

  const to = Math.max(...[...data.values()].map((c) => c[c.length - 1].openTime));
  const offDays = (to - OFF_FROM) / TF_MS["1d"];
  console.log(`Cửa sổ TẮT MÁY: ${new Date(OFF_FROM).toISOString().slice(0, 16)} → ${new Date(to).toISOString().slice(0, 16)}  (${offDays.toFixed(1)} ngày)\n`);

  console.log("═".repeat(96));
  console.log("  HỆ ĐÃ BỎ LỠ GÌ TRONG ĐÚNG CỬA SỔ ĐÓ");
  console.log("═".repeat(96));
  console.log("  " + "sổ".padEnd(12) + "NET R".padStart(9) + "unit vào".padStart(10) + "vị thế".padStart(8) +
    "  WR".padStart(6) + "   lệnh đóng trong kỳ (netR)");
  console.log("-".repeat(96));

  for (const [name, bs] of [["TURTLE", bk(turtle, "t")], ["FAST", bk(fast, "f")]] as [string, Book[]][]) {
    const res = runBooks(bs, heat);
    const eq = res.equity.filter((e) => e.time >= OFF_FROM);
    const m = riskMetrics(eq);
    const opened = res.trades.filter((t) => t.entryTime >= OFF_FROM);
    const closed = res.trades.filter((t) => t.exitTime >= OFF_FROM);
    const wins = closed.filter((t) => t.netR > 0).length;
    const pos = new Set(opened.map((t) => `${t.book}#${t.positionId}`)).size;
    const top = [...closed].sort((a, b) => b.netR - a.netR).slice(0, 4)
      .map((t) => `${t.symbol.replace("usdt", "").toUpperCase()} ${t.dir === "long" ? "L" : "S"} ${t.netR >= 0 ? "+" : ""}${t.netR.toFixed(1)}`)
      .join(", ");
    console.log("  " + name.padEnd(12) + ((m.netR >= 0 ? "+" : "") + m.netR.toFixed(1)).padStart(9) +
      String(opened.length).padStart(10) + String(pos).padStart(8) +
      (closed.length ? `${((wins / closed.length) * 100).toFixed(0)}%` : "—").padStart(6) + "   " + top);
  }

  const both = runBooks([...bk(turtle, "t"), ...bk(fast, "f")], heat);
  const mBoth = riskMetrics(both.equity.filter((e) => e.time >= OFF_FROM));
  console.log("-".repeat(96));
  console.log(`  GỘP HAI SỔ: ${mBoth.netR >= 0 ? "+" : ""}${mBoth.netR.toFixed(1)}R trong ${offDays.toFixed(0)} ngày`);

  // So với nhịp bình thường: NET R trung bình mỗi 25 ngày trên toàn mẫu
  const full = riskMetrics(both.equity);
  const perWin = (full.netR / full.days) * offDays;
  console.log(`  Nhịp bình thường cùng độ dài (${days} ngày gần nhất): ${perWin >= 0 ? "+" : ""}${perWin.toFixed(1)}R`);
  console.log(
    `\n  ⚠️  Một cửa sổ 25 ngày KHÔNG nói lên gì về edge — trung vị cửa sổ 24 ngày của hệ là ÂM\n` +
    `      (memory return-concentration-uptime). Con số trên chỉ trả lời "lần tắt NÀY tốn bao nhiêu",\n` +
    `      và lý do phải bật máy là 1% số ngày mang 68% lợi nhuận — không đoán được ngày nào.`,
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
