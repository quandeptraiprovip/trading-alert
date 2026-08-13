/**
 * exp-regime-sizing.ts — BTC gate cho LONG: nhị phân (bật/tắt) hay LIÊN TỤC (to/nhỏ dần)?
 *
 * VÌ SAO ĐÁNG THỬ dù "gate chặt hơn/bỏ gate" đã bị loại: hai lần repo này thắng đều là đổi SIZING
 * chứ không đổi BỘ LỌC (heat-decay 04/08; và exp-risk-policy vừa rồi). Gate hiện tại là bộ lọc nhị
 * phân: SMA60 > SMA600 thì cho lệnh full size, kém một chút thì cấm hẳn. Bản liên tục giữ nguyên
 * chiều của tín hiệu nhưng bỏ vách đứng ở biên.
 *
 * THIẾT KẾ CHỐNG OVERFIT — bản liên tục là TỔNG QUÁT HOÁ ĐÚNG của bản đang chạy:
 *     w_long(t) = clamp( (SMA_fast/SMA_slow − 1) / s , 0, 1 )
 * s → 0 cho lại CHÍNH XÁC gate nhị phân hiện tại (0 hoặc 1). Nên đây không phải "luật mới cạnh tranh
 * luật cũ" mà là một trục tham số chứa luật cũ ở gốc toạ độ: nếu không có cao nguyên cải thiện khi
 * s tăng thì kết luận là "giữ nguyên", đọc thẳng từ chính bảng.
 * Tỉ trọng 0 ⇒ engine từ chối unit (giống hệt bị gate chặn), không phải mở lệnh cỡ 0.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-regime-sizing.ts [days] [targetDDpct]
 */
import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];

/** Tỉ số SMA_fast/SMA_slow của BTC tại nến đã đóng gần nhất trước t (căn đúng buildBtcGateLongs). */
function btcRatio(btc: Candle[], fastLen: number, slowLen: number): (t: number) => number | null {
  const sma = (len: number) => {
    const out = new Array(btc.length).fill(NaN);
    let s = 0;
    for (let i = 0; i < btc.length; i++) {
      s += btc[i].close;
      if (i >= len) s -= btc[i - len].close;
      if (i >= len - 1) out[i] = s / len;
    }
    return out;
  };
  const f = sma(fastLen), sl = sma(slowLen);
  const times = btc.map((c) => c.openTime);
  return (t: number) => {
    let lo = 0, hi = times.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx < 0 || !Number.isFinite(f[idx]) || !Number.isFinite(sl[idx]) || sl[idx] <= 0) return null;
    return f[idx] / sl[idx];
  };
}

function dailyR(res: PortfolioResult, from: number, to: number): number[] {
  const m = new Map<number, number>();
  for (let i = 1; i < res.equity.length; i++) {
    const d = Math.floor(res.equity[i].time / DAY);
    m.set(d, (m.get(d) ?? 0) + (res.equity[i].mtm - res.equity[i - 1].mtm));
  }
  const out: number[] = [];
  for (let d = Math.floor(from / DAY); d <= Math.floor(to / DAY); d++) out.push(m.get(d) ?? 0);
  return out;
}

function riskForDD(series: number[], target: number): number {
  const dd = (rho: number) => {
    let e = 1, peak = 1, m = 0;
    for (const r of series) {
      e *= 1 + rho * r;
      if (e <= 0) return 1;
      peak = Math.max(peak, e);
      m = Math.max(m, (peak - e) / peak);
    }
    return m;
  };
  let lo = 1e-5, hi = 0.5;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (dd(mid) > target) hi = mid; else lo = mid; }
  return lo;
}

const sharpeOf = (s: number[]) => {
  const mean = s.reduce((a, x) => a + x, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / (s.length - 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
};

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const targetDD = parseFloat(process.argv[3] ?? "30") / 100;
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt")!;
  const hardGate: Gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const ratio = btcRatio(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(hardGate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · maxDD ép về ${(targetDD * 100).toFixed(0)}%`);
  console.log(`s = 0 chính là gate nhị phân ĐANG CHẠY (mốc so sánh).\n`);

  // Bỏ gate cứng khỏi params: toàn bộ quyết định LONG chuyển sang tầng sizing
  const openGate: Gate = (_t, _d) => true;

  for (const [name, base] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
    console.log("=".repeat(112));
    console.log(`  ${name} — độ rộng vùng chuyển tiếp s của gate LONG`);
    console.log("=".repeat(112));
    console.log("   s      vịthế   long/short   Sharpe   VỐN(×)   era A/B/C (×)         365d(×)   WF TB   WF âm");
    console.log("-".repeat(112));
    for (const s of [0, 0.02, 0.05, 0.1, 0.2, 0.4]) {
      const p: ExtParams = { ...base, gate: s === 0 ? hardGate : openGate };
      const bk: Book[] = [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
      const admit: AdmitFn = (c) => {
        const heat = 1 / (1 + c.sameDirHeat / T.heatDecayK);
        if (c.dir === "short" || s === 0) return heat;
        const r = ratio(c.time);
        if (r === null) return heat; // chưa đủ lịch sử ⇒ cho qua, giống buildBtcGateLongs
        return heat * Math.max(0, Math.min(1, (r - 1) / s));
      };
      const res = runBooks(bk, admit);
      const ser = dailyR(res, w.from, w.to);
      const rho = riskForDD(ser, targetDD);
      let e = 1;
      for (const x of ser) e *= 1 + rho * x;
      const eraCells = w.eras.map((era) => {
        const a = Math.floor(era.from / DAY) - Math.floor(w.from / DAY);
        const b = Math.floor(era.to / DAY) - Math.floor(w.from / DAY);
        let v = 1;
        for (let i = Math.max(0, a); i < Math.min(ser.length, b); i++) v *= 1 + rho * ser[i];
        return v.toFixed(2);
      });
      let e365 = 1;
      for (let i = Math.max(0, ser.length - 365); i < ser.length; i++) e365 *= 1 + rho * ser[i];
      const wf: number[] = [];
      for (let end = 365; end <= ser.length; end += 30) wf.push(sharpeOf(ser.slice(end - 365, end)));
      const pos = new Set(res.trades.map((t) => `${t.book}#${t.positionId}`)).size;
      const nl = res.trades.filter((t) => t.dir === "long").length;
      const ns = res.trades.filter((t) => t.dir === "short").length;
      console.log(
        `${(s === 0 ? "0 (gate)" : s.toFixed(2)).padStart(8)}   ${String(pos).padStart(5)}   ${String(nl).padStart(4)}/${String(ns).padEnd(5)}   ` +
          `${sharpeOf(ser).toFixed(2).padStart(6)}   ${e.toFixed(2).padStart(6)}   ${eraCells.join(" / ").padEnd(20)}   ` +
          `${e365.toFixed(2).padStart(6)}   ${(wf.reduce((a, x) => a + x, 0) / wf.length).toFixed(2)}   ${String(wf.filter((x) => x < 0).length).padStart(4)}`,
      );
    }
    console.log();
  }
}

if (require.main === module && /exp-regime-sizing\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
