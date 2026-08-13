/**
 * exp-growth-frontier.ts — risk/unit nào cho TĂNG TRƯỞNG CỘNG DỒN cao nhất, và 22%/năm nâng được
 * tới đâu?
 *
 * LỖ HỔNG TRONG MỌI BẢNG TRƯỚC CỦA TÔI: chúng dùng xấp xỉ TUYẾN TÍNH `lãi ≈ NetR × risk/unit`, ngầm
 * giả định gấp đôi risk thì gấp đôi tiền. SAI khi tài khoản cộng dồn: mỗi lệnh nhân vào equity, nên
 * phương sai bào mòn tăng trưởng (volatility drag). Hệ quả là tồn tại một **cực trị**: dưới nó thì
 * tăng risk làm giàu nhanh hơn, trên nó thì tăng risk làm NGHÈO đi dù kỳ vọng từng lệnh không đổi.
 * Chưa ai trong repo đo cực trị đó, mà nó chính là câu "22%/năm nâng lên được bao nhiêu".
 *
 * Dùng `compoundedEquity` (đã có sẵn, nhân từng bước mark-to-market) thay vì nhân R với hằng số.
 *
 * ĐỌC CHO ĐÚNG: đây KHÔNG phải khuyến nghị tăng risk. Cột `sụt %` là mức sụt CỘNG DỒN thật sự phải
 * chịu ở mức risk đó, và nó tăng nhanh hơn cột lãi. Điểm tối ưu tăng trưởng gần như luôn nằm ở mức
 * sụt mà người thật không chịu nổi — nên chọn điểm theo SỤT chịu được, rồi mới đọc lãi tương ứng.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-growth-frontier.ts [days]
 */
import { T, buildBtcGateLongs } from "../turtle";
import {
  AdmitCtx, AdmitFn, Book, ExtParams, compoundedEquity, riskMetrics, runBooks,
} from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";

async function minNotionals(): Promise<Map<string, number>> {
  const r = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo");
  if (!r.ok) throw new Error(`Binance exchangeInfo HTTP ${r.status}`);
  const j: any = await r.json();
  const out = new Map<string, number>();
  for (const s of j.symbols ?? []) {
    const n = (s.filters ?? []).find((f: any) => f.filterType === "MIN_NOTIONAL");
    out.set(String(s.symbol).toLowerCase(), parseFloat(n?.notional ?? n?.minNotional ?? "0"));
  }
  return out;
}

/** Luật sàn ĐÚNG như live (`minQtyFloor` + trần `pyramidMaxUnits × riskPct`). */
function admitLiveRule(k: number, equity: number, riskPct: number, floors: Map<string, number>): AdmitFn {
  return (c: AdmitCtx) => {
    const w = k > 0 ? 1 / (1 + c.sameDirHeat / k) : 1;
    if (c.entryPrice == null || c.initialSL == null) return w;
    const stopFrac = Math.abs(c.entryPrice - c.initialSL) / c.entryPrice;
    const floor = floors.get(c.symbol.toLowerCase()) ?? 0;
    if (!(stopFrac > 0) || floor <= 0) return w;
    const notional = (equity * riskPct * w) / stopFrac;
    if (notional >= floor) return w;
    const lifted = w * (floor / notional);
    const used = c.open.filter((u) => u.symbol.toLowerCase() === c.symbol.toLowerCase())
      .reduce((s, u) => s + u.weight, 0);
    return lifted <= T.pyramidMaxUnits - used ? lifted : 0;
  };
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const floors = await minNotionals();
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  const years = (w.to - w.from) / (365.25 * 86400e3);
  const snap: Partial<ExtParams> = { admitBarSnapshot: true };
  const books = (): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p: { ...turtle, ...snap } }));

  console.log(
    `Cửa sổ ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)}` +
    ` (${years.toFixed(1)} năm) · sổ TURTLE · CỘNG DỒN thật (compoundedEquity)\n`,
  );

  const RISKS = [0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.04, 0.06];
  const CFG: [string, number, number][] = [
    ["ĐANG CHẠY  k=4 · $193", 4, 192.68],
    ["k=0,5 · gộp sổ $513", 0.5, 513],
  ];

  for (const [label, k, eq] of CFG) {
    console.log(`═══ ${label} ═══`);
    console.log("risk/unit".padEnd(11) + "vốn ×".padStart(10) + "CAGR".padStart(9) +
      "SỤT cộng dồn".padStart(15) + "CAGR/sụt".padStart(10) + "Sharpe".padStart(8));
    let best = { r: 0, cagr: -1 };
    for (const rp of RISKS) {
      // Sàn phụ thuộc risk/unit ⇒ phải chạy lại engine cho mỗi mức, không tái dùng một chuỗi equity.
      const res = runBooks(books(), admitLiveRule(k, eq, rp, floors));
      const eqSeries = res.equity.filter((e) => e.time >= w.from && e.time <= w.to);
      const { mult, maxDD } = compoundedEquity(eqSeries, rp);
      const cagr = mult > 0 ? (Math.pow(mult, 1 / years) - 1) * 100 : -100;
      if (cagr > best.cagr) best = { r: rp, cagr };
      console.log(
        `${(rp * 100).toFixed(2)}%`.padEnd(11) + (mult > 0 ? mult.toFixed(1) : "0").padStart(10) +
        `${cagr.toFixed(0)}%`.padStart(9) + `${(maxDD * 100).toFixed(0)}%`.padStart(15) +
        (maxDD > 0 ? (cagr / (maxDD * 100)).toFixed(2) : "—").padStart(10) +
        riskMetrics(eqSeries).sharpe.toFixed(2).padStart(8),
      );
    }
    console.log(`  → tăng trưởng cực đại ở risk/unit ≈ ${(best.r * 100).toFixed(2)}% (CAGR ${best.cagr.toFixed(0)}%)\n`);
  }

  console.log(
    "═══ CÁCH ĐỌC ═══\n" +
    "• Nếu CAGR TĂNG rồi GIẢM khi risk tăng ⇒ có cực trị Kelly, và mức 0,5% đang chạy nằm ở đâu so\n" +
    "  với nó là câu trả lời cho \"22%/năm nâng được bao nhiêu\".\n" +
    "• Nhưng chọn điểm theo cột SỤT, không theo cột CAGR: cực trị tăng trưởng luôn kèm mức sụt mà\n" +
    "  người thật bỏ cuộc trước khi tới đích — và bỏ cuộc giữa chừng thì CAGR đó không tồn tại.\n" +
    "• Toàn bộ bảng dựa trên CORE8 (rổ chọn bằng hindsight) ⇒ CAGR tuyệt đối LẠC QUAN. Phần đáng\n" +
    "  tin là HÌNH DẠNG đường cong và VỊ TRÍ tương đối của mức risk đang chạy.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
