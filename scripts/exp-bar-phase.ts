/**
 * exp-bar-phase.ts — LƯỚI NẾN 4h BẮT ĐẦU LÚC 00:00 UTC LÀ MỘT LỰA CHỌN TUỲ TIỆN.
 *
 * Hệ đọc nến 4h căn theo 00/04/08/12/16/20 UTC. Không có lý do kinh tế nào bắt trend phải bắt đầu
 * đúng các mốc đó — đây là quy ước của sàn. Suy ra hai câu hỏi chưa ai hỏi trong repo:
 *
 *   P1 RỦI RO CĂN NẾN — nếu chạy đúng luật đó trên lưới lệch 1h/2h/3h thì kết quả lệch bao nhiêu?
 *      Độ phân tán giữa 4 pha chính là phần backtest đến từ MAY MẮN CĂN NẾN, không phải từ edge.
 *      Con số này chưa từng được đo, và nó là một cảnh báo về mọi số liệu khác trong repo.
 *
 *   P2 ENSEMBLE PHA — chạy cả 4 pha, mỗi pha 1/4 risk. Không thêm một tham số nào, không thêm chỉ
 *      báo nào, không đổi một luật nào: chỉ là trung bình hoá một lựa chọn tuỳ tiện. Kỳ vọng giữ
 *      nguyên, phương sai giảm ⇒ Sharpe tăng ⇒ được phép chạy đòn bẩy cao hơn ở cùng maxDD ⇒ nhiều
 *      tiền hơn. Đây là kiểu cải tiến DUY NHẤT không mang rủi ro overfit, vì nó không chọn gì cả.
 *
 * Nến 4h lệch pha dựng từ nến 1h (không lookahead: mỗi nến 4h chỉ gộp 4 nến 1h đã đóng của nó).
 * Gate BTC cũng dựng trên cùng pha để nhất quán.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-bar-phase.ts [days]
 */
import { Candle, TF_MS } from "../strategy";
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8 } from "./exp-breadth";

const DAY = TF_MS["1d"];
const H = TF_MS["1h"];
const TARGET_DD = 0.3;

/** Gộp nến 1h thành 4h với độ lệch pha `offsetH` giờ. Chỉ giữ nhóm ĐỦ 4 nến 1h. */
function aggregatePhase(h1: Candle[], offsetH: number): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const b of h1) {
    const k = Math.floor((b.openTime - offsetH * H) / TF_MS["4h"]);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(b);
  }
  const out: Candle[] = [];
  for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
    const g = buckets.get(k)!.sort((a, b) => a.openTime - b.openTime);
    if (g.length !== 4) continue; // nhóm thiếu nến ⇒ bỏ, không đoán
    out.push({
      openTime: k * TF_MS["4h"] + offsetH * H,
      open: g[0].open,
      high: Math.max(...g.map((x) => x.high)),
      low: Math.min(...g.map((x) => x.low)),
      close: g[3].close,
      volume: g.reduce((s, x) => s + x.volume, 0),
      quoteVolume: g.reduce((s, x) => s + x.quoteVolume, 0),
      takerBuyVolume: g.reduce((s, x) => s + x.takerBuyVolume, 0),
    });
  }
  return out;
}

function dailySeries(res: PortfolioResult, from: number, to: number): number[] {
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

function score(series: number[], eras: { from: number; to: number }[], from: number) {
  const rho = riskForDD(series, TARGET_DD);
  let e = 1;
  for (const x of series) e *= 1 + rho * x;
  const eraCells = eras.map((era) => {
    const a = Math.floor(era.from / DAY) - Math.floor(from / DAY);
    const b = Math.floor(era.to / DAY) - Math.floor(from / DAY);
    let v = 1;
    for (let i = Math.max(0, a); i < Math.min(series.length, b); i++) v *= 1 + rho * series[i];
    return v;
  });
  let e365 = 1;
  for (let i = Math.max(0, series.length - 365); i < series.length; i++) e365 *= 1 + rho * series[i];
  const wf: number[] = [];
  for (let end = 365; end <= series.length; end += 30) wf.push(sharpeOf(series.slice(end - 365, end)));
  return {
    mult: e, sharpe: sharpeOf(series), netR: series.reduce((a, x) => a + x, 0), eras: eraCells, e365,
    wfAvg: wf.reduce((a, x) => a + x, 0) / wf.length, wfNeg: wf.filter((x) => x < 0).length,
  };
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const bars1h = days * 24 + 3000;
  console.log(`Tải nến 1h cho ${CORE8.length} symbol (~${bars1h} nến mỗi symbol)...`);
  const h1 = new Map<string, Candle[]>();
  for (const s of CORE8) {
    const c = await fetchFuturesKlinesPaged(s, "1h", bars1h);
    if (c.length > 5000) h1.set(s, c);
    else console.log(`⚠️  ${s}: chỉ ${c.length} nến 1h, bỏ qua`);
  }
  console.log(`Có ${h1.size} symbol.\n`);

  const PHASES = [0, 1, 2, 3];
  const phaseData = new Map<number, Map<string, Candle[]>>();
  for (const ph of PHASES) {
    const m = new Map<string, Candle[]>();
    for (const [s, c] of h1) m.set(s, aggregatePhase(c, ph));
    phaseData.set(ph, m);
  }

  // Cửa sổ chung cho MỌI pha (dùng pha 0 làm chuẩn, cắt phần warmup)
  const p0 = phaseData.get(0)!;
  let from = -Infinity, to = -Infinity;
  for (const s of CORE8) {
    const c = p0.get(s);
    if (!c) continue;
    from = Math.max(from, c[Math.min(T.btcGateSlow + 130, c.length - 1)].openTime);
    to = Math.max(to, c[c.length - 1].openTime);
  }
  const eras = [0, 1, 2].map((k) => ({ from: from + ((to - from) * k) / 3, to: from + ((to - from) * (k + 1)) / 3 }));
  console.log(`Cửa sổ ${fmtD(from)} → ${fmtD(to)} (${((to - from) / DAY).toFixed(0)} ngày) · maxDD ép về ${TARGET_DD * 100}%\n`);

  const heat: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / T.heatDecayK);

  for (const sleeve of ["TURTLE", "FAST"] as const) {
    console.log("=".repeat(112));
    console.log(`  ${sleeve} — cùng một bộ luật, chạy trên 4 lưới nến 4h lệch pha`);
    console.log("=".repeat(112));
    console.log("pha            vịthế   Sharpe   VỐN(×)   NET R   era A/B/C (×)         365d(×)   WF TB   WF âm");
    console.log("-".repeat(112));

    const perPhase: number[][] = [];
    const rows: { ph: number; r: ReturnType<typeof score>; pos: number }[] = [];
    for (const ph of PHASES) {
      const data = phaseData.get(ph)!;
      const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
      const params = liveSleeves(gate);
      const p: ExtParams = sleeve === "TURTLE" ? params.turtle : params.fast;
      const bk: Book[] = [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
      const res = runBooks(bk, heat);
      const ser = dailySeries(res, from, to);
      perPhase.push(ser);
      rows.push({ ph, r: score(ser, eras, from), pos: new Set(res.trades.map((t) => `${t.book}#${t.positionId}`)).size });
    }
    for (const { ph, r, pos } of rows) {
      console.log(
        `${(ph === 0 ? "0h (đang chạy)" : `${ph}h`).padEnd(14)} ${String(pos).padStart(5)}   ${r.sharpe.toFixed(2).padStart(6)}   ` +
          `${r.mult.toFixed(2).padStart(6)}   ${r.netR.toFixed(0).padStart(5)}   ${r.eras.map((x) => x.toFixed(2)).join(" / ").padEnd(20)}   ` +
          `${r.e365.toFixed(2).padStart(6)}   ${r.wfAvg.toFixed(2)}   ${String(r.wfNeg).padStart(4)}`,
      );
    }
    const sh = rows.map((x) => x.r.sharpe);
    const mu = rows.map((x) => x.r.mult);
    console.log(
      `\n  P1 RỦI RO CĂN NẾN: Sharpe giữa 4 pha ${Math.min(...sh).toFixed(2)}–${Math.max(...sh).toFixed(2)} ` +
        `(TB ${(sh.reduce((a, b) => a + b, 0) / 4).toFixed(2)}) · vốn ${Math.min(...mu).toFixed(1)}×–${Math.max(...mu).toFixed(1)}× ` +
        `⇒ chênh ${(((Math.max(...mu) - Math.min(...mu)) / Math.min(...mu)) * 100).toFixed(0)}% chỉ do chọn mốc nến`,
    );

    // P2: ensemble 4 pha, mỗi pha 1/4 risk
    const L = Math.min(...perPhase.map((x) => x.length));
    const ens = Array.from({ length: L }, (_, i) => perPhase.reduce((s, x) => s + x[i], 0) / 4);
    const re = score(ens, eras, from);
    console.log("-".repeat(112));
    console.log(
      `${"ENSEMBLE 4 pha".padEnd(14)} ${"".padStart(5)}   ${re.sharpe.toFixed(2).padStart(6)}   ${re.mult.toFixed(2).padStart(6)}   ` +
        `${re.netR.toFixed(0).padStart(5)}   ${re.eras.map((x) => x.toFixed(2)).join(" / ").padEnd(20)}   ${re.e365.toFixed(2).padStart(6)}   ` +
        `${re.wfAvg.toFixed(2)}   ${String(re.wfNeg).padStart(4)}`,
    );
    const base = rows[0].r;
    console.log(
      `  P2 so với pha 0h đang chạy: Sharpe ${base.sharpe.toFixed(2)} → ${re.sharpe.toFixed(2)} · ` +
        `vốn ${base.mult.toFixed(2)}× → ${re.mult.toFixed(2)}× (${(((re.mult - base.mult) / base.mult) * 100 >= 0 ? "+" : "")}${(((re.mult - base.mult) / base.mult) * 100).toFixed(0)}%) · ` +
        `WF ${base.wfAvg.toFixed(2)} → ${re.wfAvg.toFixed(2)} · WF âm ${base.wfNeg} → ${re.wfNeg}`,
    );
    const avgMult = rows.reduce((s, x) => s + x.r.mult, 0) / rows.length;
    const avgSh = rows.reduce((s, x) => s + x.r.sharpe, 0) / rows.length;
    console.log(
      `  ... nhưng so với PHA TRUNG BÌNH (thứ ta thật sự kỳ vọng nếu mốc nến là ngẫu nhiên): ` +
        `Sharpe ${avgSh.toFixed(2)} → ${re.sharpe.toFixed(2)} · vốn ${avgMult.toFixed(2)}× → ${re.mult.toFixed(2)}× ` +
        `(${(((re.mult - avgMult) / avgMult) * 100 >= 0 ? "+" : "")}${(((re.mult - avgMult) / avgMult) * 100).toFixed(0)}%)\n`,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // P3 — DÙNG PHA LỆCH LÀM DỮ LIỆU GIẢ-OOS: heat-decay cho Fast có thắng trên CẢ 4 pha không?
  //
  // Pha 1h/2h/3h chưa từng được dùng để chọn bất kỳ tham số nào của hệ, nên chúng là mẫu độc lập
  // (không hoàn toàn — cùng thị trường, chồng lấn cao — nhưng độc lập với quá trình TINH CHỈNH).
  // Một thay đổi thật phải thắng trên cả bốn; một thay đổi hợp với nhiễu của pha 0 sẽ không.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  console.log("=".repeat(112));
  console.log("  P3 — KIỂM ĐỊNH GIẢ-OOS: heat-decay k=4 cho Fast, đo trên cả 4 pha nến");
  console.log("=".repeat(112));
  console.log("pha            Fast KHÔNG heat: Sharpe/vốn    Fast CÓ heat k=4: Sharpe/vốn     thay đổi vốn");
  console.log("-".repeat(112));
  let winCount = 0;
  for (const ph of PHASES) {
    const data = phaseData.get(ph)!;
    const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
    const p = liveSleeves(gate).fast;
    const bk: Book[] = [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
    const off = score(dailySeries(runBooks(bk, undefined), from, to), eras, from);
    const on = score(dailySeries(runBooks(bk, heat), from, to), eras, from);
    const d = ((on.mult - off.mult) / off.mult) * 100;
    if (d > 0) winCount++;
    console.log(
      `${(ph === 0 ? "0h (đang chạy)" : `${ph}h`).padEnd(14)} ${off.sharpe.toFixed(2)} / ${off.mult.toFixed(2).padStart(6)}×` +
        `                    ${on.sharpe.toFixed(2)} / ${on.mult.toFixed(2).padStart(6)}×` +
        `             ${d >= 0 ? "+" : ""}${d.toFixed(0)}%`,
    );
  }
  console.log(`\n  Kết luận: heat-decay thắng ở ${winCount}/4 pha.\n`);
}

if (require.main === module && /exp-bar-phase\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
