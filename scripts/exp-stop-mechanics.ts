/**
 * exp-stop-mechanics.ts — VÒNG HAI, xuất phát từ phát hiện W1 của `exp-execution-risk.ts`:
 * 81-88% tỉ trọng risk của cả hai sleeve thoát qua nhánh STOP, và chỉ 14 bps trượt giá thêm ở nhánh
 * đó đã lấy đi 13% vốn cuối kỳ. Nghĩa là con số lớn nhất trong hệ không phải một tham số luật —
 * nó là một GIẢ ĐỊNH KHỚP LỆNH chưa từng được kiểm tra.
 *
 *   R1  TRƯỢT GIÁ THUỘC SÀN NÀO? Turtle chạy Binance, Fast chạy MEXC (sổ mỏng hơn). Audit 12/08 kết
 *       luận "tách sàn chỉ tốn ~3% vốn" — nhưng con số đó chỉ tính PHÍ (0,08 vs 0,05), không tính
 *       trượt giá. Nếu stop trên MEXC trượt gấp đôi Binance thì câu hỏi sàn KHÔNG hề đóng.
 *
 *   R2  ỨNG VIÊN CẢI TIẾN: hard stop XÁC NHẬN BẰNG CLOSE thay vì kích hoạt trong nến.
 *       Đổi một fill KHÔNG đo được (STOP_MARKET xuyên qua stop giữa cú giảm nhanh) thành một market
 *       order tại thời điểm biết trước — đúng cơ chế nhánh `mid` đang chạy live. Cái được: không bị
 *       RÂU NẾN quét. Cái mất: có nến ăn hết phần còn lại của cú giảm, và mất chốt chặn trong nến.
 *       ĐIỂM QUAN TRỌNG: dưới giả định fill hoàn hảo thì stop-trong-nến LUÔN thắng (nó thoát sớm hơn
 *       ở giá tốt hơn). Nên trục này chỉ đo được khi BẬT trượt giá thực tế — một backtest mù trượt
 *       giá không bao giờ tìm ra nó. Kịch bản: stop trượt gấp 2× market-order-tại-close.
 *
 *   R3  HEAT k: đường vốn đơn điệu tới k=1 (W2). Quét xuống dưới 1 để tìm ĐỈNH THẬT, kèm risk/unit
 *       (k nhỏ ⇒ size nhỏ ⇒ phải chạy đòn bẩy cao hơn để về cùng maxDD — có giới hạn thực thi), và
 *       kiểm tra lựa chọn k có đổi khi bật trượt giá không.
 *
 *   R4  CỬA GIẢ-OOS 4 PHA NẾN cho ứng viên nào sống — thước đo overfit tốt nhất repo có (audit §5c).
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-stop-mechanics.ts [r1|r2|r3|r4|all] [days] [targetDDpct]
 */
import { Candle, TF_MS } from "../strategy";
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { T, buildBtcGateLongs, atrSeries as atrSeriesLocal } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, UnitTrade, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { decayH, Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];
const H = TF_MS["1h"];

function dailyR(res: PortfolioResult): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 1; i < res.equity.length; i++) {
    const d = Math.floor(res.equity[i].time / DAY);
    m.set(d, (m.get(d) ?? 0) + (res.equity[i].mtm - res.equity[i - 1].mtm));
  }
  return m;
}

function mix(parts: { s: Map<number, number>; w: number }[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let d = Math.floor(from / DAY); d <= Math.floor(to / DAY); d++) {
    out.push(parts.reduce((acc, p) => acc + p.w * (p.s.get(d) ?? 0), 0));
  }
  return out;
}

function ddAt(series: number[], rho: number): number {
  let e = 1, peak = 1, m = 0;
  for (const r of series) {
    e *= 1 + rho * r;
    if (e <= 0) return 1;
    peak = Math.max(peak, e);
    m = Math.max(m, (peak - e) / peak);
  }
  return m;
}

function riskForDD(series: number[], target: number): number {
  let lo = 1e-5, hi = 0.5;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (ddAt(series, mid) > target) hi = mid;
    else lo = mid;
  }
  return lo;
}

const sharpeOf = (s: number[]) => {
  if (s.length < 3) return 0;
  const mean = s.reduce((a, x) => a + x, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / (s.length - 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
};

type Win = ReturnType<typeof coreWindow>;

function scoreRow(parts: { s: Map<number, number>; w: number }[], w: Win, targetDD: number) {
  const full = mix(parts, w.from, w.to);
  const rho = riskForDD(full, targetDD);
  const grow = (series: number[]) => {
    let e = 1;
    for (const r of series) e *= 1 + rho * r;
    return e;
  };
  const sh: number[] = [];
  for (let end = w.from + 365 * DAY; end <= w.to; end += 30 * DAY) sh.push(sharpeOf(mix(parts, end - 365 * DAY, end)));
  return {
    rho,
    mult: grow(full),
    sharpe: sharpeOf(full),
    eras: w.eras.map((e) => grow(mix(parts, e.from, e.to))),
    d365: grow(mix(parts, w.to - 365 * DAY, w.to)),
    wfMean: sh.reduce((s, x) => s + x, 0) / sh.length,
    wfNeg: sh.filter((x) => x < 0).length,
  };
}

const HDR =
  "cấu hình".padEnd(42) + "risk/u".padStart(7) + "vốn(×)".padStart(8) + "Sharpe".padStart(8) +
  "  era A/B/C".padEnd(22) + "365d".padStart(6) + "WF TB".padStart(7) + "WFâm".padStart(6) + "  vs mốc";

function printRow(label: string, r: ReturnType<typeof scoreRow>, base?: number) {
  const vs = base ? `${r.mult >= base ? "+" : ""}${(((r.mult - base) / base) * 100).toFixed(0)}%` : "";
  console.log(
    label.padEnd(42) + `${(r.rho * 100).toFixed(2)}%`.padStart(7) + r.mult.toFixed(2).padStart(8) +
      r.sharpe.toFixed(2).padStart(8) + "  " + r.eras.map((e) => e.toFixed(2)).join(" / ").padEnd(20) +
      r.d365.toFixed(2).padStart(6) + r.wfMean.toFixed(2).padStart(7) + `${r.wfNeg}/56`.padStart(6) +
      "  " + vs.padStart(6),
  );
}

/** Tỉ trọng risk thoát qua nhánh stop, tách theo HƯỚNG — cho biết phơi nhiễm nằm ở đâu. */
function trailShareByDir(res: PortfolioResult, from: number, to: number): string {
  const ts = res.trades.filter((t: UnitTrade) => t.entryTime >= from && t.entryTime <= to);
  const f = (dir: string) => {
    const xs = ts.filter((t) => t.dir === dir);
    const tot = xs.reduce((s, t) => s + t.weight, 0);
    const tr = xs.filter((t) => t.exitReason === "trail").reduce((s, t) => s + t.weight, 0);
    return tot ? `${((tr / tot) * 100).toFixed(0)}%` : "—";
  };
  return `LONG ${f("long")} · SHORT ${f("short")}`;
}

/** Lỗ tệ nhất của MỘT vị thế (tổng netR×weight theo positionId) — đo rủi ro đuôi khi bỏ stop trong nến. */
function worstPosition(res: PortfolioResult, from: number, to: number): number {
  const m = new Map<string, number>();
  for (const t of res.trades) {
    if (t.entryTime < from || t.entryTime > to) continue;
    const k = `${t.book}#${t.positionId}`;
    m.set(k, (m.get(k) ?? 0) + t.netR * t.weight);
  }
  return Math.min(0, ...m.values());
}

async function main() {
  const part = (process.argv[2] ?? "all").toLowerCase();
  const days = parseInt(process.argv[3] ?? "2300", 10);
  const targetDD = parseFloat(process.argv[4] ?? "30") / 100;
  const data = await loadPool(days, CORE8);
  const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  const heat: AdmitFn = decayH(T.heatDecayK);
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · ${data.size} coin · maxDD ép về ${(targetDD * 100).toFixed(0)}%\n`);

  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));

  /** Danh mục ½ Turtle(heat) + ½ Fast, patch riêng cho từng sleeve. */
  const port = (pt: Partial<ExtParams>, pf: Partial<ExtParams>, tag: string, kT = T.heatDecayK, kF = 0) => [
    { s: dailyR(runBooks(bk({ ...turtle, ...pt }, `t${tag}`), kT ? decayH(kT) : undefined)), w: 0.5 },
    { s: dailyR(runBooks(bk({ ...fast, ...pf }, `f${tag}`), kF ? decayH(kF) : undefined)), w: 0.5 },
  ];

  // ─── R1: trượt giá thuộc sàn nào ────────────────────────────────────────────
  if (part === "r1" || part === "all") {
    console.log("=".repeat(130));
    console.log("  R1 — TRƯỢT GIÁ THUỘC SÀN NÀO? (audit 12/08 chấm câu hỏi sàn chỉ bằng PHÍ, bỏ qua trượt giá)");
    console.log("=".repeat(130));
    console.log(`Tỉ trọng risk thoát qua STOP, theo hướng — TURTLE: ${trailShareByDir(runBooks(bk(turtle, "d1"), heat), w.from, w.to)}`);
    console.log(`Tỉ trọng risk thoát qua STOP, theo hướng — FAST  : ${trailShareByDir(runBooks(bk(fast, "d2"), undefined), w.from, w.to)}\n`);
    console.log(HDR);
    console.log("-".repeat(130));
    const base = scoreRow(port({}, {}, "r1b"), w, targetDD);
    printRow("mốc: không trượt thêm", base);
    const S = 0.1;
    printRow(`  chỉ TURTLE trượt ${S}×ATR (Binance)`, scoreRow(port({ slipTrailAtr: S }, {}, "r1t"), w, targetDD), base.mult);
    printRow(`  chỉ FAST trượt ${S}×ATR (MEXC)`, scoreRow(port({}, { slipTrailAtr: S }, "r1f"), w, targetDD), base.mult);
    printRow(`  cả hai trượt ${S}×ATR`, scoreRow(port({ slipTrailAtr: S }, { slipTrailAtr: S }, "r1a"), w, targetDD), base.mult);
    console.log("-".repeat(130));
    console.log("Kịch bản thực tế: MEXC sổ mỏng hơn ⇒ trượt gấp đôi Binance");
    printRow(`  Turtle ${S}×ATR · Fast ${(S * 2).toFixed(2)}×ATR`, scoreRow(port({ slipTrailAtr: S }, { slipTrailAtr: S * 2 }, "r1x"), w, targetDD), base.mult);
    printRow(`  ↑ + Fast dời sang phí Binance`, scoreRow(port({ slipTrailAtr: S }, { slipTrailAtr: S, takerFeePct: 0.05 }, "r1y"), w, targetDD), base.mult);
  }

  // ─── R2: hard stop xác nhận bằng close ──────────────────────────────────────
  if (part === "r2" || part === "all") {
    console.log("\n" + "=".repeat(130));
    console.log("  R2 — HARD STOP XÁC NHẬN BẰNG CLOSE vs KÍCH HOẠT TRONG NẾN, ở từng mức trượt giá");
    console.log("=".repeat(130));
    console.log("Giả định: fill của STOP_MARKET xấu gấp 2× market order hẹn trước tại giá đóng nến.\n");
    console.log("kịch bản trượt giá".padEnd(30) + "stop TRONG NẾN (đang chạy)".padStart(28) + "stop XÁC NHẬN CLOSE".padStart(24) + "  chênh   Sharpe cả hai   lỗ vị thế tệ nhất");
    console.log("-".repeat(130));
    for (const [st, sc] of [[0, 0], [0.05, 0.025], [0.1, 0.05], [0.2, 0.1], [0.3, 0.15], [0.5, 0.25]] as [number, number][]) {
      const slip = { slipTrailAtr: st || undefined, slipCloseAtr: sc || undefined };
      const a = scoreRow(port(slip, slip, `r2a${st}`), w, targetDD);
      const b = scoreRow(port({ ...slip, stopOnCloseOnly: true }, { ...slip, stopOnCloseOnly: true }, `r2b${st}`), w, targetDD);
      const wa = worstPosition(runBooks(bk({ ...turtle, ...slip }, `r2wa${st}`), heat), w.from, w.to);
      const wb = worstPosition(runBooks(bk({ ...turtle, ...slip, stopOnCloseOnly: true }, `r2wb${st}`), heat), w.from, w.to);
      const d = ((b.mult - a.mult) / a.mult) * 100;
      console.log(
        `stop ${st.toFixed(2)}×ATR / close ${sc.toFixed(3)}×ATR`.padEnd(30) +
          `${a.mult.toFixed(2)}×`.padStart(28) + `${b.mult.toFixed(2)}×`.padStart(24) +
          `  ${d >= 0 ? "+" : ""}${d.toFixed(0)}%`.padStart(8) +
          `   ${a.sharpe.toFixed(2)} → ${b.sharpe.toFixed(2)}`.padStart(16) +
          `   ${wa.toFixed(1)}R → ${wb.toFixed(1)}R`.padStart(20),
      );
    }
    console.log("\n— chi tiết ở kịch bản giữa (stop 0,10×ATR / close 0,05×ATR) —");
    console.log(HDR);
    console.log("-".repeat(130));
    const slip = { slipTrailAtr: 0.1, slipCloseAtr: 0.05 };
    const a = scoreRow(port(slip, slip, "r2da"), w, targetDD);
    printRow("stop trong nến (đang chạy)", a);
    printRow("  stop xác nhận bằng close", scoreRow(port({ ...slip, stopOnCloseOnly: true }, { ...slip, stopOnCloseOnly: true }, "r2db"), w, targetDD), a.mult);
    printRow("  chỉ TURTLE xác nhận close", scoreRow(port({ ...slip, stopOnCloseOnly: true }, slip, "r2dc"), w, targetDD), a.mult);
    printRow("  chỉ FAST xác nhận close", scoreRow(port(slip, { ...slip, stopOnCloseOnly: true }, "r2dd"), w, targetDD), a.mult);
  }

  // ─── R3: đỉnh thật của heat k ───────────────────────────────────────────────
  if (part === "r3" || part === "all") {
    console.log("\n" + "=".repeat(130));
    console.log("  R3 — ĐỈNH THẬT CỦA HEAT k (W2 cho thấy đơn điệu tới k=1; quét xuống dưới)");
    console.log("=".repeat(130));
    console.log(HDR);
    console.log("-".repeat(130));
    const base = scoreRow(port({}, {}, "r3b"), w, targetDD);
    printRow("ĐANG CHẠY: Turtle k4 · Fast KHÔNG heat", base);
    for (const k of [0.05, 0.1, 0.15, 0.25, 0.5, 1, 2, 4]) {
      printRow(`  cả hai sleeve heat k=${k}`, scoreRow(port({}, {}, `r3k${k}`, k, k), w, targetDD), base.mult);
    }
    console.log("\n— lựa chọn k có đổi khi BẬT trượt giá thực tế? (stop 0,10 / close 0,05×ATR) —");
    console.log(HDR);
    console.log("-".repeat(130));
    const slip = { slipTrailAtr: 0.1, slipCloseAtr: 0.05 };
    const sb = scoreRow(port(slip, slip, "r3sb"), w, targetDD);
    printRow("ĐANG CHẠY + trượt giá", sb);
    for (const k of [0.5, 1, 2, 4]) {
      printRow(`  heat k=${k} + trượt giá`, scoreRow(port(slip, slip, `r3sk${k}`, k, k), w, targetDD), sb.mult);
    }
  }

  // ─── R5: heat k nhỏ có đang ăn nhờ THỨ TỰ SYMBOL không? ─────────────────────
  // `runBooks` duyệt symbol theo thứ tự mảng CORE8. Khi nhiều symbol phá vỡ CÙNG một nến, symbol
  // đứng trước lấy heat=0 (size đầy) và symbol đứng sau lấy phần còn lại. Ở k=4 chênh lệch đó nhẹ
  // (1,00/0,80/0,69) nhưng ở k=0,1 nó cực đoan (1,00/0,09/0,08) ⇒ toàn bộ vốn dồn vào symbol may mắn
  // đứng đầu mảng. Đó là một chi tiết CÀI ĐẶT, không phải một luật. Nếu ưu thế của k nhỏ biến mất khi
  // đảo thứ tự thì nó là hiện vật, không phải cơ chế.
  if (part === "r5" || part === "all") {
    console.log("\n" + "=".repeat(130));
    console.log("  R5 — ĐỐI CHỨNG THỨ TỰ SYMBOL: heat k nhỏ dồn size vào symbol đứng đầu mảng CORE8");
    console.log("=".repeat(130));
    const ladder = (k: number) => {
      let heat = 0;
      const ws: number[] = [];
      for (let n = 0; n < 4; n++) { const wt = 1 / (1 + heat / k); ws.push(wt); heat += wt; }
      return ws.map((x) => x.toFixed(2)).join(" / ");
    };
    console.log("Thang size cho 4 unit CÙNG HƯỚNG liên tiếp (bất kể symbol nào):");
    for (const k of [4, 2, 1, 0.5, 0.25, 0.1]) console.log(`  k=${String(k).padEnd(5)} → ${ladder(k)}`);
    console.log("\nVốn cuối kỳ theo THỨ TỰ duyệt symbol (cùng luật, cùng k, chỉ đổi thứ tự mảng):");
    console.log("k".padEnd(8) + "CORE8 gốc".padStart(12) + "đảo ngược".padStart(12) + "xoay 4".padStart(12) + "abc".padStart(12) + "   biên độ");
    console.log("-".repeat(130));
    const ents = [...data.entries()];
    const orders: [string, [string, Candle[]][]][] = [
      ["goc", ents],
      ["rev", [...ents].reverse()],
      ["rot", [...ents.slice(4), ...ents.slice(0, 4)]],
      ["abc", [...ents].sort((a, b) => a[0].localeCompare(b[0]))],
    ];
    for (const k of [4, 2, 1, 0.5, 0.25, 0.1]) {
      const vals = orders.map(([tag, e]) => {
        const mk = (p: ExtParams, t: string): Book[] => e.map(([symbol, candles]) => ({ key: `${symbol}@${t}`, symbol, candles, p }));
        const parts = [
          { s: dailyR(runBooks(mk(turtle, `t${tag}${k}`), decayH(k))), w: 0.5 },
          { s: dailyR(runBooks(mk(fast, `f${tag}${k}`), decayH(k))), w: 0.5 },
        ];
        return scoreRow(parts, w, targetDD).mult;
      });
      const spread = ((Math.max(...vals) - Math.min(...vals)) / Math.min(...vals)) * 100;
      console.log(
        `k=${k}`.padEnd(8) + vals.map((v) => v.toFixed(2).padStart(12)).join("") + `   ${spread.toFixed(0)}%`.padStart(10),
      );
    }
  }

  // ─── R6: stop bị RÂU NẾN quét bao nhiêu lần? (cơ chế đứng sau giao điểm ở R2) ───
  // Mỗi lệnh thoát `trail` khớp tại đúng `pos.sl`, nên `exitPrice` của nó CHÍNH LÀ mức stop. Tra lại
  // nến tại `exitTime`: nếu nến đó ĐÓNG về phía có lợi so với stop thì vị thế đã bị quét bởi râu nến
  // — stop trong nến đã trả tiền cho nhiễu. Đây là đại lượng giải thích vì sao xác nhận-bằng-close
  // thắng khi trượt giá đủ lớn, và nó KHÔNG cần biết trượt giá thật là bao nhiêu.
  if (part === "r6" || part === "all") {
    console.log("\n" + "=".repeat(130));
    console.log("  R6 — STOP BỊ RÂU NẾN QUÉT: nến kích hoạt stop có ĐÓNG về phía có lợi không?");
    console.log("=".repeat(130));
    console.log("sleeve/hướng".padEnd(22) + "lệnh trail".padStart(12) + "bị râu quét".padStart(14) + "tỉ lệ".padStart(9) +
      "  vượt stop TB (×ATR)   vượt stop p90");
    console.log("-".repeat(130));
    for (const [name, p, adm] of [["TURTLE", turtle, heat], ["FAST", fast, undefined]] as [string, ExtParams, AdmitFn | undefined][]) {
      const res = runBooks(bk(p, `r6${name}`), adm);
      const atrOf = new Map<string, number[]>();
      for (const [sym, c] of data) atrOf.set(sym, atrSeriesLocal(c, T.atrPeriod));
      for (const dir of ["long", "short"] as const) {
        const ts = res.trades.filter((t) => t.exitReason === "trail" && t.dir === dir && t.entryTime >= w.from && t.entryTime <= w.to);
        // Gộp theo vị thế: mọi unit của một vị thế thoát cùng nến, cùng giá.
        const seen = new Set<string>();
        let n = 0, wick = 0;
        const excursions: number[] = [];
        for (const t of ts) {
          const k = `${t.book}#${t.positionId}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const c = data.get(t.symbol)!;
          const idx = c.findIndex((x) => x.openTime === t.exitTime);
          if (idx < 0) continue;
          const a = atrOf.get(t.symbol)![idx];
          if (!(a > 0)) continue;
          n++;
          const recovered = dir === "long" ? c[idx].close > t.exitPrice : c[idx].close < t.exitPrice;
          if (recovered) wick++;
          const beyond = dir === "long" ? t.exitPrice - c[idx].low : c[idx].high - t.exitPrice;
          excursions.push(beyond / a);
        }
        excursions.sort((x, y) => x - y);
        const mean = excursions.length ? excursions.reduce((s, x) => s + x, 0) / excursions.length : 0;
        const p90 = excursions.length ? excursions[Math.floor(excursions.length * 0.9)] : 0;
        console.log(
          `${name} ${dir.toUpperCase()}`.padEnd(22) + String(n).padStart(12) + String(wick).padStart(14) +
            `${n ? ((wick / n) * 100).toFixed(0) : 0}%`.padStart(9) + `${mean.toFixed(2)}`.padStart(22) + `${p90.toFixed(2)}`.padStart(16),
        );
      }
    }
    console.log("\n'vượt stop' = khoảng cách từ mức stop tới cực trị của nến kích hoạt, đo bằng ATR.");
    console.log("Đó là TRẦN TRÊN của trượt giá có thể xảy ra trong nến đó — không phải trượt giá thật,");
    console.log("nhưng nó cho biết những nến này bạo lực tới mức nào.");
  }

  // ─── R4: cửa giả-OOS 4 pha nến ──────────────────────────────────────────────
  if (part === "r4") {
    console.log("=".repeat(130));
    console.log("  R4 — CỬA GIẢ-OOS: chạy ứng viên trên lưới nến 4h lệch 0h/1h/2h/3h (audit §5c)");
    console.log("=".repeat(130));
    const aggregatePhase = (h1: Candle[], offsetH: number): Candle[] => {
      const buckets = new Map<number, Candle[]>();
      for (const b of h1) {
        const k = Math.floor((b.openTime - offsetH * H) / TF_MS["4h"]);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k)!.push(b);
      }
      const out: Candle[] = [];
      for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
        const g = buckets.get(k)!.sort((a, b) => a.openTime - b.openTime);
        if (g.length !== 4) continue;
        out.push({
          openTime: k * TF_MS["4h"] + offsetH * H,
          open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)),
          close: g[3].close, volume: g.reduce((s, x) => s + x.volume, 0),
          quoteVolume: g.reduce((s, x) => s + x.quoteVolume, 0),
          takerBuyVolume: g.reduce((s, x) => s + x.takerBuyVolume, 0),
        });
      }
      return out;
    };

    const bars1h = Math.ceil(days * 24) + 700;
    const h1 = new Map<string, Candle[]>();
    for (const s of CORE8) h1.set(s, await fetchFuturesKlinesPaged(s, "1h", bars1h));

    const slip = { slipTrailAtr: 0.1, slipCloseAtr: 0.05 };
    console.log("\npha".padEnd(6) + "ĐANG CHẠY".padStart(12) + "heat k=1".padStart(12) + "stop-close".padStart(12) + "k=1+stop-close".padStart(16) + "   (vốn ×, ép cùng maxDD, ĐÃ bật trượt giá)");
    console.log("-".repeat(130));
    const acc: Record<string, number[]> = { base: [], k1: [], sc: [], both: [] };
    for (const ph of [0, 1, 2, 3]) {
      const dp = new Map<string, Candle[]>();
      for (const s of CORE8) dp.set(s, aggregatePhase(h1.get(s)!, ph));
      const gp: Gate = buildBtcGateLongs(dp.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
      const sl = liveSleeves(gp);
      const wp = coreWindow(dp, T.btcGateSlow + 130);
      const bkp = (p: ExtParams, tag: string): Book[] =>
        [...dp.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));
      const pp = (pt: Partial<ExtParams>, tag: string, kT: number, kF: number) => [
        { s: dailyR(runBooks(bkp({ ...sl.turtle, ...pt }, `t${tag}`), kT ? decayH(kT) : undefined)), w: 0.5 },
        { s: dailyR(runBooks(bkp({ ...sl.fast, ...pt }, `f${tag}`), kF ? decayH(kF) : undefined)), w: 0.5 },
      ];
      const r = {
        base: scoreRow(pp(slip, `p${ph}b`, T.heatDecayK, 0), wp, targetDD).mult,
        k1: scoreRow(pp(slip, `p${ph}k`, 1, 1), wp, targetDD).mult,
        sc: scoreRow(pp({ ...slip, stopOnCloseOnly: true }, `p${ph}s`, T.heatDecayK, 0), wp, targetDD).mult,
        both: scoreRow(pp({ ...slip, stopOnCloseOnly: true }, `p${ph}x`, 1, 1), wp, targetDD).mult,
      };
      for (const key of Object.keys(acc)) acc[key].push(r[key as keyof typeof r]);
      console.log(
        `${ph}h`.padEnd(6) + r.base.toFixed(2).padStart(12) + r.k1.toFixed(2).padStart(12) +
          r.sc.toFixed(2).padStart(12) + r.both.toFixed(2).padStart(16),
      );
    }
    console.log("-".repeat(130));
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    console.log("TB".padEnd(6) + mean(acc.base).toFixed(2).padStart(12) + mean(acc.k1).toFixed(2).padStart(12) +
      mean(acc.sc).toFixed(2).padStart(12) + mean(acc.both).toFixed(2).padStart(16));
    for (const [k, label] of [["k1", "heat k=1"], ["sc", "stop-close"], ["both", "k=1 + stop-close"]] as [string, string][]) {
      const wins = acc[k].filter((v, i) => v > acc.base[i]).length;
      console.log(`  ${label.padEnd(20)} thắng mốc ở ${wins}/4 pha`);
    }
  }
}

if (require.main === module && /exp-stop-mechanics\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error("Lỗi:", e?.message ?? e);
    process.exit(1);
  });
}
