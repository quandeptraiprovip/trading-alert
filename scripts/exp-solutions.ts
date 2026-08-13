/**
 * exp-solutions.ts — VÒNG NĂM: kiểm định ba HƯỚNG GIẢI QUYẾT lấy từ tài liệu, cho ba vấn đề mà
 * `turtle-fast-execution-weakness-2026-08-12.md` để mở.
 *
 *   S1  TRƯỢT GIÁ LÀ VẤN ĐỀ KÍCH THƯỚC hay VẤN ĐỀ THỜI ĐIỂM?
 *       Định luật căn bậc hai của market impact (Bouchaud và cộng sự; đã kiểm chứng trên cả Bitcoin):
 *           I(Q) = Y · σ_ngày · √(Q/V) ,  Y ~ O(1)
 *       Ta có đủ mọi đầu vào trong cache: V = khối lượng quote/ngày thật của từng symbol, σ = độ lệch
 *       chuẩn lợi suất ngày, Q = notional lệnh suy ra từ equity × risk/unit ÷ khoảng stop.
 *       Nếu I(Q) ≪ ngưỡng 0,05×ATR (nơi mất 13% vốn) thì trượt giá KHÔNG đến từ kích thước lệnh, và
 *       mọi giải pháp kiểu "giao dịch nhỏ hơn / chia lệnh" là vô ích. Khi đó thủ phạm là THỜI ĐIỂM
 *       (stop kích hoạt đúng lúc sổ mỏng và giá đang chạy) ⇒ chỉ có đổi CƠ CHẾ THOÁT mới cứu được.
 *       Kèm luôn câu chưa ai hỏi trong repo: CAPACITY — tới cỡ vốn nào thì kích thước mới thành vấn đề.
 *
 *   S2  KAMINSKI & LO (2014): dưới random walk, luật stop-loss LUÔN làm giảm kỳ vọng; nó chỉ tạo giá
 *       trị khi có ĐỘNG LƯỢNG (AR(1) dương), và làm hại khi thị trường quay đầu.
 *       Repo đã ĐO đại lượng đúng bằng variance ratio: VR(20) = 1,01/0,83/1,04/1,39/0,72/0,87 cho
 *       2021→2026. Suy ra một DỰ ĐOÁN CÓ DẤU TRƯỚC KHI XEM SỐ: cơ chế stop ít nhạy nhiễu hơn
 *       (xác nhận bằng close) phải thắng ở những năm VR THẤP và thua ở những năm VR CAO.
 *       Đây là kiểu bằng chứng mạnh hơn một lần quét tham số: lý thuyết cố định dấu trước, dữ liệu
 *       chỉ việc xác nhận hay bác bỏ.
 *
 *   S3  PHÂN BỔ KHÔNG PHỤ THUỘC THỨ TỰ. r5 đo được: đổi thứ tự mảng symbol làm lệch 9-68% vốn, vì
 *       `runBooks` duyệt tuần tự nên symbol đứng trước gặp heat thấp hơn. `admitBarSnapshot` chấm mọi
 *       tín hiệu cùng nến theo trạng thái ĐẦU NẾN ⇒ bất biến thứ tự theo cấu tạo. Câu hỏi: biên độ có
 *       về 0 và có mất tiền không.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-solutions.ts [s1|s2|s3|all] [days] [targetDDpct]
 */
import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs, atrSeries } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { decayH, Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];

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
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (dd(mid) > target) hi = mid;
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

/** Lợi suất NGÀY của rổ (trung bình đều 8 coin) từ nến 4h — dùng cho variance ratio. */
function basketDailyReturns(data: Map<string, Candle[]>, from: number, to: number): number[] {
  const perDay = new Map<number, { s: number; n: number }>();
  for (const [, c] of data) {
    const byDay = new Map<number, Candle[]>();
    for (const b of c) {
      if (b.openTime < from || b.openTime > to) continue;
      const d = Math.floor(b.openTime / DAY);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(b);
    }
    const ds = [...byDay.keys()].sort((a, b) => a - b);
    for (let i = 1; i < ds.length; i++) {
      const prev = byDay.get(ds[i - 1])!;
      const cur = byDay.get(ds[i])!;
      const p0 = prev[prev.length - 1].close, p1 = cur[cur.length - 1].close;
      if (!(p0 > 0 && p1 > 0)) continue;
      const r = Math.log(p1 / p0);
      const e = perDay.get(ds[i]) ?? { s: 0, n: 0 };
      e.s += r; e.n++;
      perDay.set(ds[i], e);
    }
  }
  return [...perDay.keys()].sort((a, b) => a - b).map((d) => {
    const e = perDay.get(d)!;
    return e.s / e.n;
  });
}

/** VR(q) = Var(lợi suất q ngày) / (q × Var(1 ngày)). >1 động lượng, <1 quay đầu. */
function varianceRatio(rets: number[], q: number): number {
  if (rets.length < q * 3) return NaN;
  const v1 = (xs: number[]) => {
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  };
  const agg: number[] = [];
  for (let i = 0; i + q <= rets.length; i += q) agg.push(rets.slice(i, i + q).reduce((s, x) => s + x, 0));
  const a = v1(rets), b = v1(agg);
  return a > 0 ? b / (q * a) : NaN;
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

  const port = (patch: Partial<ExtParams>, tag: string, kT = T.heatDecayK, kF = 0) => [
    { s: dailyR(runBooks(bk({ ...turtle, ...patch }, `t${tag}`), kT ? decayH(kT) : undefined)), w: 0.5 },
    { s: dailyR(runBooks(bk({ ...fast, ...patch }, `f${tag}`), kF ? decayH(kF) : undefined)), w: 0.5 },
  ];

  // ─── S1: kích thước hay thời điểm? + capacity ───────────────────────────────
  if (part === "s1" || part === "all") {
    console.log("=".repeat(126));
    console.log("  S1 — TRƯỢT GIÁ TỪ KÍCH THƯỚC LỆNH: I(Q) = Y·σ·√(Q/V), Y=1 (cạnh bảo thủ), dữ liệu thật");
    console.log("=".repeat(126));
    console.log("symbol".padEnd(10) + "vol quote/ngày (trung vị)".padStart(26) + "σ ngày".padStart(9) +
      "ATR20%".padStart(9) + "   impact @ notional $10k / $100k / $1M (bps)");
    console.log("-".repeat(126));
    const rows: { sym: string; v: number; sd: number; atrPct: number }[] = [];
    for (const [sym, c] of data) {
      const byDay = new Map<number, number>();
      const closesByDay = new Map<number, number>();
      for (const b of c) {
        if (b.openTime < w.from || b.openTime > w.to) continue;
        const d = Math.floor(b.openTime / DAY);
        byDay.set(d, (byDay.get(d) ?? 0) + (b.quoteVolume || 0));
        closesByDay.set(d, b.close);
      }
      const vols = [...byDay.values()].filter((x) => x > 0).sort((a, b) => a - b);
      const v = vols.length ? vols[Math.floor(vols.length / 2)] : NaN;
      const ds = [...closesByDay.keys()].sort((a, b) => a - b);
      const rets: number[] = [];
      for (let i = 1; i < ds.length; i++) {
        const p0 = closesByDay.get(ds[i - 1])!, p1 = closesByDay.get(ds[i])!;
        if (p0 > 0 && p1 > 0) rets.push(Math.log(p1 / p0));
      }
      const m = rets.reduce((s, x) => s + x, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1));
      const a = atrSeries(c, T.atrPeriod);
      let ap = 0, an = 0;
      for (let i = T.atrPeriod; i < c.length; i++) {
        if (c[i].openTime < w.from || c[i].openTime > w.to) continue;
        if (a[i] > 0 && c[i].close > 0) { ap += a[i] / c[i].close; an++; }
      }
      const atrPct = ap / an;
      rows.push({ sym, v, sd, atrPct });
      const imp = (Q: number) => (1 * sd * Math.sqrt(Q / v) * 1e4).toFixed(2);
      console.log(
        sym.toUpperCase().padEnd(10) + `$${(v / 1e6).toFixed(0)}M`.padStart(26) +
          `${(sd * 100).toFixed(2)}%`.padStart(9) + `${(atrPct * 100).toFixed(2)}%`.padStart(9) +
          `   ${imp(1e4).padStart(6)} / ${imp(1e5).padStart(6)} / ${imp(1e6).padStart(6)}`,
      );
    }
    console.log("-".repeat(126));
    // Ngưỡng nguy hiểm đo được ở W1: 0,05×ATR (≈14 bps) làm mất 13% vốn.
    const worst = rows.reduce((a, b) => (a.v < b.v ? a : b));
    console.log(`\nNgưỡng nguy hiểm đo được (W1): trượt 0,05×ATR ⇒ −13% vốn. Với symbol MỎNG NHẤT rổ (${worst.sym.toUpperCase()}):`);
    const thr = 0.05 * worst.atrPct; // ngưỡng dạng phân số giá
    const Qthr = ((thr / (1 * worst.sd)) ** 2) * worst.v;
    console.log(`  ngưỡng = 0,05 × ${(worst.atrPct * 100).toFixed(2)}% = ${(thr * 1e4).toFixed(0)} bps`);
    console.log(`  ⇒ cần notional MỘT LỆNH Q = ${(Qthr / 1e6).toFixed(1)}M USD mới sinh ra impact bằng ngưỡng đó`);
    console.log("\nQuy notional ra CỠ VỐN (một unit, stop 3×ATR ⇒ notional = equity × risk/unit ÷ 3×ATR%):");
    console.log("risk/unit".padEnd(14) + "equity cần để MỘT unit đạt ngưỡng 0,05×ATR".padStart(46));
    for (const r of [0.0032, 0.0093, 0.0124]) {
      const stopFrac = 3 * worst.atrPct;
      const equity = (Qthr * stopFrac) / r;
      console.log(`${(r * 100).toFixed(2)}%`.padEnd(14) + `$${(equity / 1e6).toFixed(0)}M`.padStart(46));
    }
    console.log("\n⇒ Kết luận đọc thẳng từ bảng: xem phần bình luận cuối.");
  }

  // ─── S2: dự đoán của Kaminski & Lo, kiểm bằng variance ratio đã đo ──────────
  if (part === "s2" || part === "all") {
    console.log("\n" + "=".repeat(126));
    console.log("  S2 — DỰ ĐOÁN KAMINSKI & LO: stop nhạy nhiễu chỉ có giá trị khi VR > 1 (động lượng)");
    console.log("=".repeat(126));
    const slip = { slipTrailAtr: 0.1, slipCloseAtr: 0.05 };
    const A = port(slip, "s2a");                              // stop trong nến
    const B = port({ ...slip, stopOnCloseOnly: true }, "s2b"); // stop xác nhận close
    const A0 = port({}, "s2a0");                               // không trượt giá, để tách bạch
    const B0 = port({ stopOnCloseOnly: true }, "s2b0");

    const rhoA = riskForDD(mix(A, w.from, w.to), targetDD);
    console.log("\nTHEO NĂM — Sharpe (bất biến đòn bẩy) của hai cơ chế stop, và VR(20) của rổ trong năm đó:");
    console.log("năm".padEnd(7) + "VR(20)".padStart(8) + "  | CÓ trượt giá: trong nến → close".padEnd(38) +
      "chênh".padStart(8) + "  | KHÔNG trượt: trong nến → close".padEnd(38) + "chênh".padStart(8));
    console.log("-".repeat(126));
    const pts: { vr: number; dSlip: number; dNo: number }[] = [];
    for (const y of [2021, 2022, 2023, 2024, 2025, 2026]) {
      const lo = Math.max(Date.UTC(y, 0, 1), w.from), hi = Math.min(Date.UTC(y + 1, 0, 1), w.to);
      if (hi - lo < 60 * DAY) continue;
      const vr = varianceRatio(basketDailyReturns(data, lo, hi), 20);
      const sa = sharpeOf(mix(A, lo, hi)), sb = sharpeOf(mix(B, lo, hi));
      const sa0 = sharpeOf(mix(A0, lo, hi)), sb0 = sharpeOf(mix(B0, lo, hi));
      pts.push({ vr, dSlip: sb - sa, dNo: sb0 - sa0 });
      console.log(
        String(y).padEnd(7) + vr.toFixed(2).padStart(8) + "  | " +
          `${sa.toFixed(2)} → ${sb.toFixed(2)}`.padEnd(35) + `${(sb - sa >= 0 ? "+" : "") + (sb - sa).toFixed(2)}`.padStart(8) +
          "  | " + `${sa0.toFixed(2)} → ${sb0.toFixed(2)}`.padEnd(35) + `${(sb0 - sa0 >= 0 ? "+" : "") + (sb0 - sa0).toFixed(2)}`.padStart(8),
      );
    }
    const pear = (xs: number[], ys: number[]) => {
      const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
      let c = 0, sx = 0, sy = 0;
      for (let i = 0; i < xs.length; i++) { c += (xs[i] - mx) * (ys[i] - my); sx += (xs[i] - mx) ** 2; sy += (ys[i] - my) ** 2; }
      return sx > 0 && sy > 0 ? c / Math.sqrt(sx * sy) : NaN;
    };
    console.log("-".repeat(126));
    console.log(`corr(VR , lợi thế của stop-xác-nhận-close):  có trượt giá ${pear(pts.map((p) => p.vr), pts.map((p) => p.dSlip)).toFixed(2)}` +
      `   ·   không trượt giá ${pear(pts.map((p) => p.vr), pts.map((p) => p.dNo)).toFixed(2)}`);
    console.log("Dự đoán của lý thuyết: corr ÂM (VR cao ⇒ stop nhạy nhiễu tốt ⇒ lợi thế close nhỏ/âm).");

    console.log("\n56 CỬA SỔ 365 NGÀY TRƯỢT — chia đôi theo VR(20) đo TRONG cửa sổ (kiểm cơ chế):");
    const rows: { vr: number; a: number; b: number }[] = [];
    for (let end = w.from + 365 * DAY; end <= w.to; end += 30 * DAY) {
      const from = end - 365 * DAY;
      const vr = varianceRatio(basketDailyReturns(data, from, end), 20);
      if (!Number.isFinite(vr)) continue;
      rows.push({ vr, a: sharpeOf(mix(A, from, end)), b: sharpeOf(mix(B, from, end)) });
    }
    rows.sort((x, y) => x.vr - y.vr);
    const half = Math.floor(rows.length / 2);
    const rep = (xs: typeof rows, label: string) => {
      const ma = xs.reduce((s, x) => s + x.a, 0) / xs.length, mb = xs.reduce((s, x) => s + x.b, 0) / xs.length;
      const win = xs.filter((x) => x.b > x.a).length;
      console.log(`  ${label.padEnd(34)} VR TB ${(xs.reduce((s, x) => s + x.vr, 0) / xs.length).toFixed(2)}` +
        ` · Sharpe trong-nến ${ma.toFixed(2)} → close ${mb.toFixed(2)} (${mb - ma >= 0 ? "+" : ""}${(mb - ma).toFixed(2)})` +
        ` · close thắng ${win}/${xs.length}`);
    };
    rep(rows.slice(0, half), `VR THẤP (nửa quay đầu, n=${half})`);
    rep(rows.slice(half), `VR CAO (nửa động lượng, n=${rows.length - half})`);
  }

  // ─── S4: stop đặt tại CẤU TRÚC có bị săn nhiều hơn stop đặt máy móc? ────────
  // Tài liệu về stop-hunting/liquidation cascade nói stop bị săn ở những mức HIỂN NHIÊN (đáy/đỉnh
  // swing, mức tâm lý) vì ở đó chúng dồn cục. `turtleInitialStop` đặt stop ĐÚNG NGOÀI wick của nến
  // ngược hướng gần nhất — tức đúng một mức swing hiển nhiên. Fast thì không (nó luôn 3×ATR máy móc,
  // vì `initialStopObLookback: 0`). Nên so được trực tiếp: tắt stop cấu trúc của Turtle.
  if (part === "s4" || part === "all") {
    console.log("\n" + "=".repeat(126));
    console.log("  S4 — STOP TẠI CẤU TRÚC (ngoài wick nến ngược hướng) vs STOP MÁY MÓC 3×ATR — giả thuyết bị săn stop");
    console.log("=".repeat(126));
    console.log("cấu hình".padEnd(46) + "vốn(×)".padStart(9) + "Sharpe".padStart(8) + "  era A/B/C".padEnd(22) +
      "365d".padStart(6) + "  vs mốc");
    console.log("-".repeat(126));
    const show = (label: string, parts: { s: Map<number, number>; w: number }[], base?: number) => {
      const full = mix(parts, w.from, w.to);
      const rho = riskForDD(full, targetDD);
      const grow = (s: number[]) => { let e = 1; for (const r of s) e *= 1 + rho * r; return e; };
      const mult = grow(full);
      const vs = base ? `${mult >= base ? "+" : ""}${(((mult - base) / base) * 100).toFixed(0)}%` : "";
      console.log(
        label.padEnd(46) + mult.toFixed(2).padStart(9) + sharpeOf(full).toFixed(2).padStart(8) + "  " +
          w.eras.map((e) => grow(mix(parts, e.from, e.to)).toFixed(2)).join(" / ").padEnd(20) +
          grow(mix(parts, w.to - 365 * DAY, w.to)).toFixed(2).padStart(6) + "  " + vs.padStart(7),
      );
      return mult;
    };
    for (const slip of [{}, { slipTrailAtr: 0.1, slipCloseAtr: 0.05 }] as Partial<ExtParams>[]) {
      const tag = Object.keys(slip).length ? "slip" : "nos";
      console.log(Object.keys(slip).length ? "— CÓ trượt giá (0,10/0,05×ATR) —" : "— KHÔNG trượt giá —");
      const b = show("  Turtle riêng: stop CẤU TRÚC (đang chạy)",
        [{ s: dailyR(runBooks(bk({ ...turtle, ...slip }, `s4a${tag}`), heat)), w: 1 }]);
      show("    Turtle: stop MÁY MÓC 3×ATR",
        [{ s: dailyR(runBooks(bk({ ...turtle, ...slip, initialStopObLookback: 0 }, `s4b${tag}`), heat)), w: 1 }], b);
      const bp = show("  danh mục: stop CẤU TRÚC (đang chạy)", port(slip, `s4c${tag}`));
      show("    danh mục: Turtle cũng dùng 3×ATR", [
        { s: dailyR(runBooks(bk({ ...turtle, ...slip, initialStopObLookback: 0 }, `s4d${tag}`), heat)), w: 0.5 },
        { s: dailyR(runBooks(bk({ ...fast, ...slip }, `s4e${tag}`), undefined)), w: 0.5 },
      ], bp);
      console.log("-".repeat(126));
    }
  }

  // ─── S3: phân bổ bất biến thứ tự ────────────────────────────────────────────
  if (part === "s3" || part === "all") {
    console.log("\n" + "=".repeat(126));
    console.log("  S3 — PHÂN BỔ BẤT BIẾN THỨ TỰ (`admitBarSnapshot`): tín hiệu cùng nến chấm theo trạng thái đầu nến");
    console.log("=".repeat(126));
    const ents = [...data.entries()];
    const orders: [string, [string, Candle[]][]][] = [
      ["goc", ents], ["rev", [...ents].reverse()],
      ["rot", [...ents.slice(4), ...ents.slice(0, 4)]],
      ["abc", [...ents].sort((a, b) => a[0].localeCompare(b[0]))],
    ];
    const run = (k: number, snap: boolean) => {
      const vals = orders.map(([tag, e]) => {
        const mk = (p: ExtParams, t: string): Book[] =>
          e.map(([symbol, candles]) => ({ key: `${symbol}@${t}`, symbol, candles, p }));
        const patch: Partial<ExtParams> = snap ? { admitBarSnapshot: true } : {};
        const parts = [
          { s: dailyR(runBooks(mk({ ...turtle, ...patch }, `t${tag}${k}${snap}`), decayH(k))), w: 0.5 },
          { s: dailyR(runBooks(mk({ ...fast, ...patch }, `f${tag}${k}${snap}`), decayH(k))), w: 0.5 },
        ];
        const full = mix(parts, w.from, w.to);
        const rho = riskForDD(full, targetDD);
        let e2 = 1;
        for (const r of full) e2 *= 1 + rho * r;
        return e2;
      });
      return { vals, spread: ((Math.max(...vals) - Math.min(...vals)) / Math.min(...vals)) * 100 };
    };
    console.log("k".padEnd(7) + "chế độ".padEnd(14) + "gốc".padStart(9) + "đảo".padStart(9) + "xoay".padStart(9) +
      "abc".padStart(9) + "biên độ".padStart(10) + "worst case".padStart(12));
    console.log("-".repeat(126));
    for (const k of [4, 1, 0.5, 0.25]) {
      for (const snap of [false, true]) {
        const r = run(k, snap);
        console.log(
          `k=${k}`.padEnd(7) + (snap ? "ĐẦU NẾN" : "tuần tự").padEnd(14) +
            r.vals.map((v) => v.toFixed(2).padStart(9)).join("") +
            `${r.spread.toFixed(0)}%`.padStart(10) + Math.min(...r.vals).toFixed(2).padStart(12),
        );
      }
      console.log("-".repeat(126));
    }
  }

  // ─── CMP: bảng so sánh CŨ vs MỚI, cùng điều kiện, hai cách đọc lợi ích ──────
  // Lợi ích của một cấu hình giảm dao động có thể lấy theo HAI cách loại trừ nhau:
  //   (a) giữ nguyên mức đau (maxDD) và nhận nhiều tiền hơn — cần TĂNG risk/unit;
  //   (b) giữ nguyên risk/unit đang chạy và nhận maxDD thấp hơn — tiền gần như không đổi.
  // Bảng in cả hai để khỏi phải chọn hộ.
  if (part === "cmp") {
    const CFG: [string, { s: Map<number, number>; w: number }[]][] = [
      ["1. ĐANG CHẠY (Turtle k4 tuần tự · Fast KHÔNG heat)", port({}, "c1", T.heatDecayK, 0)],
      ["2. Ứng viên audit trước (cả hai k4, tuần tự)", port({}, "c2", T.heatDecayK, T.heatDecayK)],
      ["3. MỚI: đầu nến + k=1", port({ admitBarSnapshot: true }, "c3", 1, 1)],
      ["4. MỚI: đầu nến + k=0,5", port({ admitBarSnapshot: true }, "c4", 0.5, 0.5)],
    ];
    const ddAt = (series: number[], rho: number) => {
      let e = 1, peak = 1, m = 0;
      for (const r of series) { e *= 1 + rho * r; if (e <= 0) return 1; peak = Math.max(peak, e); m = Math.max(m, (peak - e) / peak); }
      return m;
    };
    const grow = (series: number[], rho: number) => { let e = 1; for (const r of series) e *= 1 + rho * r; return e; };

    const full0 = mix(CFG[0][1], w.from, w.to);
    const rho0 = riskForDD(full0, targetDD); // risk/unit đang chạy, dùng cho cách đọc (b)

    console.log("=".repeat(132));
    console.log(`  (a) CÙNG MỨC ĐAU — mọi cấu hình ép về maxDD ${(targetDD * 100).toFixed(0)}%, xem ai cho nhiều tiền hơn`);
    console.log("=".repeat(132));
    console.log("cấu hình".padEnd(50) + "risk/u".padStart(8) + "vốn(×)".padStart(9) + "Sharpe".padStart(8) +
      "  era A/B/C".padEnd(22) + "365d".padStart(6) + "WF TB".padStart(7) + "WFâm".padStart(6) + "WF tệ".padStart(7) + "  vs #1");
    console.log("-".repeat(132));
    let base: number | null = null;
    for (const [label, parts] of CFG) {
      const full = mix(parts, w.from, w.to);
      const rho = riskForDD(full, targetDD);
      const mult = grow(full, rho);
      if (base === null) base = mult;
      const sh: number[] = [];
      for (let end = w.from + 365 * DAY; end <= w.to; end += 30 * DAY) sh.push(sharpeOf(mix(parts, end - 365 * DAY, end)));
      console.log(
        label.padEnd(50) + `${(rho * 100).toFixed(2)}%`.padStart(8) + mult.toFixed(2).padStart(9) +
          sharpeOf(full).toFixed(2).padStart(8) + "  " +
          w.eras.map((e) => grow(mix(parts, e.from, e.to), rho).toFixed(2)).join(" / ").padEnd(20) +
          grow(mix(parts, w.to - 365 * DAY, w.to), rho).toFixed(2).padStart(6) +
          (sh.reduce((s, x) => s + x, 0) / sh.length).toFixed(2).padStart(7) +
          `${sh.filter((x) => x < 0).length}/56`.padStart(6) + Math.min(...sh).toFixed(2).padStart(7) +
          `  ${mult >= base ? "+" : ""}${(((mult - base) / base) * 100).toFixed(0)}%`.padStart(7),
      );
    }

    console.log("\n" + "=".repeat(132));
    console.log(`  (b) CÙNG RISK/UNIT — giữ đúng ${(rho0 * 100).toFixed(2)}%/unit của cấu hình đang chạy, xem maxDD giảm bao nhiêu`);
    console.log("=".repeat(132));
    console.log("cấu hình".padEnd(50) + "risk/u".padStart(8) + "maxDD".padStart(9) + "vốn(×)".padStart(9) + "  vs #1 (maxDD / vốn)");
    console.log("-".repeat(132));
    let bdd: number | null = null, bmu: number | null = null;
    for (const [label, parts] of CFG) {
      const full = mix(parts, w.from, w.to);
      const dd = ddAt(full, rho0), mu = grow(full, rho0);
      if (bdd === null) { bdd = dd; bmu = mu; }
      console.log(
        label.padEnd(50) + `${(rho0 * 100).toFixed(2)}%`.padStart(8) + `${(dd * 100).toFixed(1)}%`.padStart(9) +
          mu.toFixed(2).padStart(9) + `   ${(((dd - bdd) / bdd) * 100).toFixed(0)}% / ${mu >= bmu! ? "+" : ""}${(((mu - bmu!) / bmu!) * 100).toFixed(0)}%`,
      );
    }

    console.log("\n" + "=".repeat(132));
    console.log("  (c) ĐỘ BỀN — bất biến thứ tự symbol, và có trượt giá (0,10/0,05×ATR)");
    console.log("=".repeat(132));
    const ents = [...data.entries()];
    const orders: [string, [string, Candle[]][]][] = [
      ["goc", ents], ["rev", [...ents].reverse()],
      ["rot", [...ents.slice(4), ...ents.slice(0, 4)]],
      ["abc", [...ents].sort((a, b) => a[0].localeCompare(b[0]))],
    ];
    console.log("cấu hình".padEnd(50) + "biên độ thứ tự".padStart(16) + "vốn CÓ trượt giá".padStart(19) + "  giữ được".padStart(11));
    console.log("-".repeat(132));
    const variants: [string, Partial<ExtParams>, number, number][] = [
      ["1. ĐANG CHẠY", {}, T.heatDecayK, 0],
      ["2. Ứng viên audit trước", {}, T.heatDecayK, T.heatDecayK],
      ["3. MỚI: đầu nến + k=1", { admitBarSnapshot: true }, 1, 1],
      ["4. MỚI: đầu nến + k=0,5", { admitBarSnapshot: true }, 0.5, 0.5],
    ];
    const slip: Partial<ExtParams> = { slipTrailAtr: 0.1, slipCloseAtr: 0.05 };
    for (const [label, patch, kT, kF] of variants) {
      const vals = orders.map(([tag, e]) => {
        const mk = (p: ExtParams, t: string): Book[] => e.map(([symbol, candles]) => ({ key: `${symbol}@${t}`, symbol, candles, p }));
        const parts = [
          { s: dailyR(runBooks(mk({ ...turtle, ...patch }, `ct${tag}${label}`), kT ? decayH(kT) : undefined)), w: 0.5 },
          { s: dailyR(runBooks(mk({ ...fast, ...patch }, `cf${tag}${label}`), kF ? decayH(kF) : undefined)), w: 0.5 },
        ];
        const f = mix(parts, w.from, w.to);
        return grow(f, riskForDD(f, targetDD));
      });
      const spread = ((Math.max(...vals) - Math.min(...vals)) / Math.min(...vals)) * 100;
      const ps = port({ ...patch, ...slip }, `cs${label}`, kT, kF);
      const fs = mix(ps, w.from, w.to);
      const withSlip = grow(fs, riskForDD(fs, targetDD));
      const clean = vals[0];
      console.log(
        label.padEnd(50) + `${spread.toFixed(0)}%`.padStart(16) + withSlip.toFixed(2).padStart(19) +
          `  ${((withSlip / clean) * 100).toFixed(0)}%`.padStart(11),
      );
    }
  }

  // ─── NETR: ba nghĩa khác nhau của "Net R", vì con số thô không so được ──────
  // `portfolio-risk-policy` đã đăng ký: NET R thô vô nghĩa khi hai cấu hình chạy risk khác nhau.
  // Ở đây in tách bạch để thấy VÌ SAO, và đâu là con số dùng được:
  //   (1) Σ netR KHÔNG nhân tỉ trọng — chất lượng tín hiệu thô. Heat chỉ đổi SIZE, không bao giờ bỏ
  //       lệnh, nên tập lệnh phải GIỐNG NHAU ở mọi cấu hình ⇒ cột này bất biến. Nếu nó lệch thì có bug.
  //   (2) NET R danh mục = Σ netR × tỉ trọng — cái engine báo. Siết heat làm tỉ trọng nhỏ đi nên cột
  //       này GIẢM, dù cấu hình tốt hơn. Đây chính là cái bẫy.
  //   (3) NET R quy đổi cùng maxDD = ρ(DD30) × (2) — lợi nhuận đơn tại đòn bẩy đã chuẩn hoá. So được.
  if (part === "netr") {
    const VAR: [string, Partial<ExtParams>, number, number][] = [
      ["1. ĐANG CHẠY (T k4 · F không heat)", {}, T.heatDecayK, 0],
      ["2. Ứng viên audit trước (cả hai k4)", {}, T.heatDecayK, T.heatDecayK],
      ["3. MỚI: đầu nến + k=1", { admitBarSnapshot: true }, 1, 1],
      ["4. MỚI: đầu nến + k=0,5", { admitBarSnapshot: true }, 0.5, 0.5],
    ];
    console.log("=".repeat(134));
    console.log("  BA NGHĨA CỦA \"NET R\" — cùng cửa sổ, cùng luật, chỉ khác chính sách tỉ trọng risk");
    console.log("=".repeat(134));
    console.log("cấu hình".padEnd(38) + "n unit".padStart(8) + "ΣnetR THÔ".padStart(11) + "Σtỉ trọng".padStart(11) +
      "NET R d.mục".padStart(12) + "exp/đơn vị".padStart(11) + "risk/u".padStart(8) + "NET R quy đổi".padStart(14) +
      "vốn(×)".padStart(9));
    console.log("-".repeat(134));
    for (const [label, patch, kT, kF] of VAR) {
      let nUnit = 0, rawR = 0, sumW = 0, netPort = 0;
      const parts: { s: Map<number, number>; w: number }[] = [];
      for (const [p, k] of [[turtle, kT], [fast, kF]] as [ExtParams, number][]) {
        const res = runBooks(bk({ ...p, ...patch }, `nr${label}${k}`), k ? decayH(k) : undefined);
        const ts = res.trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);
        nUnit += ts.length;
        rawR += ts.reduce((s, t) => s + t.netR, 0);
        sumW += 0.5 * ts.reduce((s, t) => s + t.weight, 0);
        netPort += 0.5 * ts.reduce((s, t) => s + t.netR * t.weight, 0);
        parts.push({ s: dailyR(res), w: 0.5 });
      }
      const full = mix(parts, w.from, w.to);
      const rho = riskForDD(full, targetDD);
      let e = 1;
      for (const r of full) e *= 1 + rho * r;
      console.log(
        label.padEnd(38) + String(nUnit).padStart(8) + rawR.toFixed(0).padStart(11) + sumW.toFixed(0).padStart(11) +
          netPort.toFixed(0).padStart(12) + (sumW ? netPort / sumW : 0).toFixed(3).padStart(11) +
          `${(rho * 100).toFixed(2)}%`.padStart(8) + (rho * netPort).toFixed(2).padStart(14) +
          e.toFixed(2).padStart(9),
      );
    }
    console.log("-".repeat(134));
    console.log("ΣnetR THÔ  = tổng netR mọi unit, KHÔNG nhân tỉ trọng (chất lượng tín hiệu — phải bất biến)");
    console.log("NET R d.mục = Σ netR × tỉ trọng × ½ mỗi sổ (cái engine báo — GIẢM khi siết heat)");
    console.log("NET R quy đổi = risk/unit × NET R danh mục = lợi nhuận ĐƠN tại đòn bẩy cho cùng maxDD (so được)");
  }

  // ─── LIVE: tách bạch các CÁI NÚM có thật, theo cấu hình đang chạy thật ──────
  // .env.local: TURTLE_TRADING_ENABLED=true · TURTLE_RISK_PCT=0,5 · FAST_TREND_TRADING_ENABLED=false
  // · MEXC_TRADING_ENABLED=false  ⇒ tiền thật CHỈ có Turtle. Mọi bảng "½ Turtle + ½ Fast" ở các vòng
  // trước là danh mục GIẢ ĐỊNH. Ở đây tách: (A) cải tiến phân bổ trên Turtle-một-mình — cái duy nhất
  // áp dụng được NGAY; (B) phần thêm được nếu bật Fast bằng tiền thật.
  if (part === "live") {
    const grow = (series: number[], rho: number) => { let e = 1; for (const r of series) e *= 1 + rho * r; return e; };
    const ddAt = (series: number[], rho: number) => {
      let e = 1, peak = 1, m = 0;
      for (const r of series) { e *= 1 + rho * r; if (e <= 0) return 1; peak = Math.max(peak, e); m = Math.max(m, (peak - e) / peak); }
      return m;
    };
    const row = (label: string, parts: { s: Map<number, number>; w: number }[], base?: number) => {
      const full = mix(parts, w.from, w.to);
      const rho = riskForDD(full, targetDD);
      const mult = grow(full, rho);
      const sh: number[] = [];
      for (let end = w.from + 365 * DAY; end <= w.to; end += 30 * DAY) sh.push(sharpeOf(mix(parts, end - 365 * DAY, end)));
      const vs = base ? `  ${mult >= base ? "+" : ""}${(((mult - base) / base) * 100).toFixed(0)}%` : "";
      console.log(
        label.padEnd(44) + `${(rho * 100).toFixed(2)}%`.padStart(8) + mult.toFixed(2).padStart(9) +
          sharpeOf(full).toFixed(2).padStart(8) +
          `${(ddAt(full, 0.005) * 100).toFixed(0)}%`.padStart(12) + grow(full, 0.005).toFixed(2).padStart(11) +
          (sh.reduce((s, x) => s + x, 0) / sh.length).toFixed(2).padStart(8) + vs.padStart(8),
      );
      return mult;
    };
    const tOnly = (patch: Partial<ExtParams>, tag: string, k: number) =>
      [{ s: dailyR(runBooks(bk({ ...turtle, ...patch }, `lv${tag}`), k ? decayH(k) : undefined)), w: 1 }];

    console.log("=".repeat(130));
    console.log("  A — TURTLE MỘT MÌNH (đúng cấu hình có tiền thật hôm nay). Hai cột cuối: tại risk/unit 0,5% ĐANG ĐẶT");
    console.log("=".repeat(130));
    console.log("cấu hình".padEnd(44) + "risk/u*".padStart(8) + "vốn(×)".padStart(9) + "Sharpe".padStart(8) +
      "maxDD@0,5%".padStart(12) + "vốn@0,5%".padStart(11) + "WF TB".padStart(8) + "  vs mốc");
    console.log("-".repeat(130));
    const a0 = row("ĐANG CHẠY: heat k=4, tuần tự", tOnly({}, "a0", T.heatDecayK));
    row("  k=4 + phân bổ đầu nến", tOnly({ admitBarSnapshot: true }, "a1", 4), a0);
    row("  k=1 + phân bổ đầu nến", tOnly({ admitBarSnapshot: true }, "a2", 1), a0);
    row("  k=0,5 + phân bổ đầu nến", tOnly({ admitBarSnapshot: true }, "a3", 0.5), a0);
    row("  k=0,25 + phân bổ đầu nến", tOnly({ admitBarSnapshot: true }, "a4", 0.25), a0);
    console.log("* risk/u = mức cần để maxDD lịch sử = 30%. Cột maxDD@0,5% = mức đau THẬT ở thiết lập hiện tại.");

    console.log("\n" + "=".repeat(130));
    console.log("  B — PHẦN THÊM ĐƯỢC NẾU BẬT FAST BẰNG TIỀN THẬT (hiện FAST_TREND_TRADING_ENABLED=false)");
    console.log("=".repeat(130));
    console.log("cấu hình".padEnd(44) + "risk/u*".padStart(8) + "vốn(×)".padStart(9) + "Sharpe".padStart(8) +
      "maxDD@0,5%".padStart(12) + "vốn@0,5%".padStart(11) + "WF TB".padStart(8) + "  vs A-mốc");
    console.log("-".repeat(130));
    row("Turtle một mình, đang chạy (mốc A)", tOnly({}, "b0", T.heatDecayK));
    row("+ Fast, cả hai k=4 tuần tự", port({}, "b1", 4, 4), a0);
    row("+ Fast, cả hai k=1 đầu nến", port({ admitBarSnapshot: true }, "b2", 1, 1), a0);
    row("+ Fast, cả hai k=0,5 đầu nến", port({ admitBarSnapshot: true }, "b3", 0.5, 0.5), a0);
  }

  // ─── S5: cửa giả-OOS 4 pha nến cho ứng viên S3 ──────────────────────────────
  if (part === "s5") {
    console.log("=".repeat(126));
    console.log("  S5 — CỬA GIẢ-OOS 4 PHA NẾN cho ứng viên S3 (phân bổ đầu nến + siết k)");
    console.log("=".repeat(126));
    const H = TF_MS["1h"];
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
    const { fetchFuturesKlinesPaged } = await import("../kline-fetch");
    const h1 = new Map<string, Candle[]>();
    for (const s of CORE8) h1.set(s, await fetchFuturesKlinesPaged(s, "1h", Math.ceil(days * 24) + 700));

    console.log("\npha".padEnd(6) + "ĐANG CHẠY".padStart(12) + "snap k=1".padStart(11) + "snap k=0,5".padStart(12) +
      "snap0,5+3ATR".padStart(14) + "   (vốn ×, ép cùng maxDD, ĐÃ bật trượt giá 0,10/0,05)");
    console.log("-".repeat(126));
    const slip: Partial<ExtParams> = { slipTrailAtr: 0.1, slipCloseAtr: 0.05 };
    const acc: Record<string, number[]> = { base: [], k1: [], k05: [], k05m: [] };
    for (const ph of [0, 1, 2, 3]) {
      const dp = new Map<string, Candle[]>();
      for (const s of CORE8) dp.set(s, aggregatePhase(h1.get(s)!, ph));
      const gp: Gate = buildBtcGateLongs(dp.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
      const sl = liveSleeves(gp);
      const wp = coreWindow(dp, T.btcGateSlow + 130);
      const mk = (p: ExtParams, t: string): Book[] =>
        [...dp.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${t}`, symbol, candles, p }));
      const capital = (pt: Partial<ExtParams>, pf: Partial<ExtParams>, tag: string, kT: number, kF: number) => {
        const parts = [
          { s: dailyR(runBooks(mk({ ...sl.turtle, ...pt }, `t${tag}`), kT ? decayH(kT) : undefined)), w: 0.5 },
          { s: dailyR(runBooks(mk({ ...sl.fast, ...pf }, `f${tag}`), kF ? decayH(kF) : undefined)), w: 0.5 },
        ];
        const full = mix(parts, wp.from, wp.to);
        const rho = riskForDD(full, targetDD);
        let e = 1;
        for (const r of full) e *= 1 + rho * r;
        return e;
      };
      const snap = { ...slip, admitBarSnapshot: true };
      const r = {
        base: capital(slip, slip, `p${ph}b`, T.heatDecayK, 0),
        k1: capital(snap, snap, `p${ph}1`, 1, 1),
        k05: capital(snap, snap, `p${ph}5`, 0.5, 0.5),
        k05m: capital({ ...snap, initialStopObLookback: 0 }, snap, `p${ph}m`, 0.5, 0.5),
      };
      for (const key of Object.keys(acc)) acc[key].push(r[key as keyof typeof r]);
      console.log(`${ph}h`.padEnd(6) + r.base.toFixed(2).padStart(12) + r.k1.toFixed(2).padStart(11) +
        r.k05.toFixed(2).padStart(12) + r.k05m.toFixed(2).padStart(14));
    }
    console.log("-".repeat(126));
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    console.log("TB".padEnd(6) + mean(acc.base).toFixed(2).padStart(12) + mean(acc.k1).toFixed(2).padStart(11) +
      mean(acc.k05).toFixed(2).padStart(12) + mean(acc.k05m).toFixed(2).padStart(14));
    for (const [k, label] of [["k1", "snap k=1"], ["k05", "snap k=0,5"], ["k05m", "snap k=0,5 + 3ATR"]] as [string, string][]) {
      console.log(`  ${label.padEnd(22)} thắng mốc ở ${acc[k].filter((v, i) => v > acc.base[i]).length}/4 pha`);
    }
  }
}

if (require.main === module && /exp-solutions\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error("Lỗi:", e?.message ?? e);
    process.exit(1);
  });
}
