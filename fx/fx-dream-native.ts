/**
 * fx-dream-native.ts — FX Dream ở ĐÚNG THANG GỐC (nền 5m), không dịch gì.
 *
 * `fx-dream.ts` chạy thang đã dịch lên một bậc (1h/4h/1d/1w) vì đó là dữ liệu sẵn có, và cho kết
 * quả GỘP ≈ 0. Nhưng phản bác hợp lệ là: phương pháp này nói về phản ứng TRONG NGÀY tại một mức
 * giá, nên dịch lên thang ngày có thể đã phá mất chính thứ đang đo. File này khép phản bác đó bằng
 * cách tải nến 5m thật (fx/fetch-dukascopy-m5.py) và chạy cấu hình production KHÔNG sửa một chữ.
 *
 * Ở thang này chi phí trở thành câu hỏi trung tâm, nên phải nói trước bằng số:
 *   XAUUSD spread ~2,5 bps, biên độ nến 5m ~7 bps  ⇒ spread/biên độ ≈ 36%
 *   EURUSD spread ~0,4 bps, biên độ nến 5m ~3,5 bps ⇒ spread/biên độ ≈ 12%
 * Với stop đặt dưới cú trap (vài nến), khứ hồi ăn khoảng 0,3R (vàng) và 0,15R (EURUSD) mỗi lệnh.
 * Vì thế bảng dưới in GỘP tách khỏi PHÍ: nếu gộp âm thì chi phí không phải nguyên nhân và không
 * broker nào cứu được; nếu gộp dương thì mới có việc để bàn.
 *
 * NHẮC LẠI GIỚI HẠN KHÔNG THỂ GỠ: FX/vàng CFD không có khối lượng khớp thật. `volume` ở đây là
 * volume theo tick của riêng feed Dukascopy. Điều kiện SINH ra Key của phương pháp là "volume đột
 * biến", nên ở thị trường này nó đang đo tần suất cập nhật giá chứ không phải quy mô giao dịch.
 *
 * Chạy: npx ts-node fx/fx-dream-native.ts
 */

import fs from "fs";
import path from "path";
import { CONFIG, Candle } from "../strategy";
import { KEY_VOLUME_CONFIG, KeyVolumeParams, KeyVolumeTrade, runKeyVolume } from "../key-volume";
import { medianSpreadPct } from "./fx-data";

const CACHE = path.join(process.cwd(), ".cache", "fx");
const FX_SLIP_PCT = 0.002;

interface M5 extends Candle { spread: number }

function loadM5(symbol: string): M5[] | null {
  const p = path.join(CACHE, `${symbol}_m5.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as M5[];
}

function score(label: string, trades: KeyVolumeTrade[], years: number) {
  if (trades.length === 0) {
    console.log(`${label.padEnd(28)}${"0".padStart(7)}` + "  — không có lệnh nào");
    return;
  }
  const net = trades.reduce((s, t) => s + t.netR, 0);
  const gross = trades.reduce((s, t) => s + t.grossR, 0);
  const cost = trades.reduce((s, t) => s + t.costR, 0);
  const wr = trades.filter((t) => t.netR > 0).length / trades.length * 100;
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) { cum += t.netR; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  console.log(
    label.padEnd(28) + String(trades.length).padStart(7) + wr.toFixed(0).padStart(6) +
    gross.toFixed(1).padStart(10) + cost.toFixed(1).padStart(9) + net.toFixed(1).padStart(9) +
    (gross / trades.length).toFixed(4).padStart(11) + (net / trades.length).toFixed(4).padStart(11) +
    maxDD.toFixed(1).padStart(8) + (trades.length / years).toFixed(0).padStart(9),
  );
}

const HDR = "cấu hình".padEnd(28) + "lệnh".padStart(7) + "WR%".padStart(6) +
  "gộp R".padStart(10) + "phí R".padStart(9) + "ròng R".padStart(9) +
  "gộp/lệnh".padStart(11) + "ròng/lệnh".padStart(11) + "maxDD".padStart(8) + "lệnh/năm".padStart(9);

function main() {
  CONFIG.costs.enabled = true;
  CONFIG.costs.fundingPer8hPct = 0.0014;

  const symbols = ["XAUUSD", "EURUSD", "GBPUSD"];
  const variants: [string, Partial<KeyVolumeParams>][] = [
    ["production (minRR=3)", {}],
    ["bỏ minRR", { minRR: 0, requireStructuralTarget: false }],
    ["bỏ minRR + BOS trigger", { minRR: 0, requireStructuralTarget: false, entryTrigger: "bos" }],
  ];

  for (const s of symbols) {
    const candles = loadM5(s);
    if (!candles || candles.length < 5000) {
      console.log(`\n${s}: chưa có dữ liệu 5m (chạy fx/fetch-dukascopy-m5.py trước) — bỏ qua`);
      continue;
    }
    const years = (candles[candles.length - 1].openTime - candles[0].openTime) / (365.25 * 86400e3);
    const spreadPct = medianSpreadPct(candles as never);
    const rangePct = candles.slice(-20000).reduce((a, c) => a + (c.high - c.low) / c.close, 0) / 20000 * 100;
    CONFIG.costs.takerFeePct = spreadPct / 2;
    CONFIG.costs.slippagePct = FX_SLIP_PCT;

    console.log(
      `\n═══ ${s} — ${candles.length} nến 5m, ${years.toFixed(1)} năm ` +
      `(${new Date(candles[0].openTime).toISOString().slice(0, 10)}→${new Date(candles[candles.length - 1].openTime).toISOString().slice(0, 10)}) ═══`,
    );
    console.log(
      `spread ${spreadPct.toFixed(4)}% · biên độ nến 5m ${rangePct.toFixed(4)}%` +
      ` · spread/biên độ ${(spreadPct / rangePct * 100).toFixed(0)}%`,
    );
    console.log(HDR);
    for (const [label, over] of variants) {
      const params = { ...KEY_VOLUME_CONFIG, ...over } as KeyVolumeParams;
      const r = runKeyVolume(s, candles as Candle[], params);
      score(label, r.trades, years);
      if (label === "bỏ minRR") {
        const d = r.diagnostics;
        console.log(
          `${" ".repeat(4)}phễu: key 1h ${d.h1Levels} · key 4h ${d.h4Levels} · chạm hợp lưu ${d.confluentTouches}` +
          ` · volume xác nhận ${d.touchVolumeConfirmed} · sweep ${d.sweeps} · mô hình nến ${d.candlePatterns}` +
          ` · kế hoạch ${d.plans} · vào lệnh ${d.entries}`,
        );
      }
    }
  }

  console.log(
    "\n═══ CÁCH ĐỌC ═══\n" +
    "Cột quyết định là GỘP/LỆNH. Nếu nó âm hoặc ≈0 thì phương pháp không có edge ở thị trường này\n" +
    "và mọi tinh chỉnh chi phí/broker đều vô nghĩa. Nếu nó dương rõ mà RÒNG/lệnh âm, thì đây là bài\n" +
    "toán chi phí và mới đáng bàn tiếp về thang thời gian chậm hơn hoặc công cụ spread hẹp hơn.",
  );
}

if (require.main === module) main();
