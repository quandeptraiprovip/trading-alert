/**
 * exp-execution-risk.ts — BA TRỤC CHƯA TỪNG ĐO của Turtle/Fast, tìm thấy bằng đọc code chứ không
 * bằng quét tham số. Cả ba đều KHÔNG đụng một luật vào/ra nào.
 *
 * Vì sao ba trục này chưa có trong `turtle-fast-deep-audit-2026-08-12.md` (12 trục, không trục nào
 * sống): mười hai trục đó đều hỏi "luật nào tốt hơn". Ba trục dưới đây hỏi thứ khác —
 * "con số đo được có THẬT không, và chính sách rủi ro có nhìn đúng cái đang phơi nhiễm không".
 *
 *   W1  ĐỘ MONG MANH TRƯỚC TRƯỢT GIÁ. `runBooks` cho khớp ĐÚNG BẰNG `pos.sl` mỗi khi
 *       `bar.low <= pos.sl` (portfolio-engine.ts, nhánh `reason="trail"`), và `mid`/`time` khớp
 *       đúng giá close dù live thức dậy 90s SAU khi nến đóng (`SETTLE_MS`). `slippagePct` = 0,02%
 *       là hằng số không phụ thuộc biên độ nên không mô hình hoá được cả hai điều đó.
 *       Câu hỏi: bao nhiêu trượt giá thì edge chết? = biên an toàn của TOÀN BỘ chuỗi đo.
 *
 *   W2  HEAT MÙ TƯƠNG QUAN CHÉO SLEEVE. `decayH` đọc `sameDirHeat` từ `snapshotOpen()`, mà
 *       snapshot chỉ thấy các sổ TRONG CÙNG một lời gọi `runBooks`. `exp-allocation.ts` chạy hai
 *       lời gọi riêng ⇒ kể cả bản "Fast + heat k=4" chưa ship thì mỗi sleeve vẫn chỉ thấy heat của
 *       CHÍNH NÓ. Với corr P&L ngày 0,954 và 91% unit trùng symbol+hướng, heat thật của danh mục
 *       gần GẤP ĐÔI cái mà chính sách đang nhìn.
 *       ĐỐI CHỨNG BẮT BUỘC: pool chung ở k cũng chính là "siết mạnh hơn" (heat ~2× ⇔ k/2). Nên mọi
 *       cấu hình joint ở k đều được so với separate ở k/2 — nếu không tách được hai thứ đó thì
 *       kết luận vô giá trị (đúng cái bẫy §5.2 của audit).
 *
 *   W3  PYRAMID SIẾT STOP CHUNG. Khi thêm unit ở nhánh `longExitMode="mid"`, engine kéo hard stop
 *       chung lên `max(pos.sl, initialSL_unit_mới)`. Nghĩa là add unit làm CHẶT stop của cả vị thế,
 *       kể cả unit đầu đang có đệm dày. Chỉ ảnh hưởng LONG (short dùng chandelier) — tức đúng nhánh
 *       chứa toàn bộ edge lịch sử (+1,27R/unit). Chưa từng được đo tách bạch.
 *
 * Chấm điểm: VỐN CUỐI KỲ khi mọi cấu hình bị ép về cùng maxDD (cách duy nhất công bằng — xem
 * exp-allocation.ts), kèm Sharpe, ba era, và 56 cửa sổ 365d trượt.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-execution-risk.ts [w1|w2|w3|all] [days] [targetDDpct]
 */
import { TF_MS } from "../strategy";
import { T, buildBtcGateLongs, atrSeries } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, UnitTrade, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { decayH, Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];

/** P&L NGÀY theo R từ chuỗi mark-to-market. */
function dailyR(res: PortfolioResult): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 1; i < res.equity.length; i++) {
    const d = Math.floor(res.equity[i].time / DAY);
    m.set(d, (m.get(d) ?? 0) + (res.equity[i].mtm - res.equity[i - 1].mtm));
  }
  return m;
}

function mix(parts: { s: Map<number, number>; w: number }[], from: number, to: number): number[] {
  const d0 = Math.floor(from / DAY), d1 = Math.floor(to / DAY);
  const out: number[] = [];
  for (let d = d0; d <= d1; d++) out.push(parts.reduce((acc, p) => acc + p.w * (p.s.get(d) ?? 0), 0));
  return out;
}

/** Nhân đòn bẩy ρ sao cho maxDD compounding = target. */
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

function sharpeOf(series: number[]): number {
  if (series.length < 3) return 0;
  const mean = series.reduce((s, x) => s + x, 0) / series.length;
  const sd = Math.sqrt(series.reduce((s, x) => s + (x - mean) ** 2, 0) / (series.length - 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
}

type Win = ReturnType<typeof coreWindow>;

/** Một dòng kết quả: vốn @DD mục tiêu, Sharpe, ba era, walk-forward. */
function scoreRow(parts: { s: Map<number, number>; w: number }[], w: Win, targetDD: number) {
  const full = mix(parts, w.from, w.to);
  const rho = riskForDD(full, targetDD);
  const grow = (series: number[]) => {
    let e = 1;
    for (const r of series) e *= 1 + rho * r;
    return e;
  };
  const eras = w.eras.map((e) => grow(mix(parts, e.from, e.to)));
  const sh: number[] = [];
  for (let end = w.from + 365 * DAY; end <= w.to; end += 30 * DAY) sh.push(sharpeOf(mix(parts, end - 365 * DAY, end)));
  return {
    mult: grow(full),
    sharpe: sharpeOf(full),
    netR: full.reduce((s, x) => s + x, 0),
    eras,
    d365: grow(mix(parts, w.to - 365 * DAY, w.to)),
    wfMean: sh.reduce((s, x) => s + x, 0) / sh.length,
    wfNeg: sh.filter((x) => x < 0).length,
    wfWorst: Math.min(...sh),
  };
}

const HDR =
  "cấu hình".padEnd(44) + "vốn(×)".padStart(8) + "Sharpe".padStart(8) + "  era A/B/C".padEnd(22) +
  "365d".padStart(6) + "WF TB".padStart(7) + "WF âm".padStart(7) + "  vs mốc";

function printRow(label: string, r: ReturnType<typeof scoreRow>, base?: number) {
  const vs = base ? `${r.mult >= base ? "+" : ""}${(((r.mult - base) / base) * 100).toFixed(0)}%` : "";
  console.log(
    label.padEnd(44) + r.mult.toFixed(2).padStart(8) + r.sharpe.toFixed(2).padStart(8) + "  " +
      r.eras.map((e) => e.toFixed(2)).join(" / ").padEnd(20) +
      r.d365.toFixed(2).padStart(6) + r.wfMean.toFixed(2).padStart(7) +
      `${r.wfNeg}/56`.padStart(7) + "  " + vs.padStart(6),
  );
}

/** Phân bố lý do thoát theo TỈ TRỌNG risk (không theo số lệnh) — cho biết hệ phơi nhiễm bao nhiêu vào stop. */
function exitMix(res: PortfolioResult, from: number, to: number): string {
  const ts = res.trades.filter((t: UnitTrade) => t.entryTime >= from && t.entryTime <= to);
  const tot = ts.reduce((s, t) => s + t.weight, 0);
  const share = (r: string) => (tot ? (ts.filter((t) => t.exitReason === r).reduce((s, t) => s + t.weight, 0) / tot) * 100 : 0);
  return `trail ${share("trail").toFixed(0)}% · mid ${share("mid").toFixed(0)}% · time ${share("time").toFixed(0)}%`;
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

  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · ${data.size} coin · maxDD ép về ${(targetDD * 100).toFixed(0)}%`);

  // Biên độ trung bình của rổ — để dịch "0,1×ATR" thành điểm cơ bản (bps) đọc được.
  let atrPctSum = 0, atrPctN = 0;
  for (const [, c] of data) {
    const a = atrSeries(c, T.atrPeriod);
    for (let i = T.atrPeriod; i < c.length; i++) {
      if (c[i].openTime < w.from || c[i].openTime > w.to) continue;
      if (a[i] > 0 && c[i].close > 0) { atrPctSum += a[i] / c[i].close; atrPctN++; }
    }
  }
  const atrPct = atrPctSum / atrPctN;
  console.log(`ATR20 trung bình rổ = ${(atrPct * 100).toFixed(2)}% giá ⇒ trượt 0,10×ATR ≈ ${(atrPct * 0.1 * 1e4).toFixed(0)} bps ≈ ${(0.1 / T.chandelierMult).toFixed(3)}R\n`);

  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));

  /** Danh mục ĐANG CHẠY: Turtle(heat k4) + Fast(không heat), hai sổ riêng, ½+½. */
  const livePortfolio = (patch: Partial<ExtParams> = {}, tag = "") => {
    const t = dailyR(runBooks(bk({ ...turtle, ...patch }, `t${tag}`), heat));
    const f = dailyR(runBooks(bk({ ...fast, ...patch }, `f${tag}`), undefined));
    return [{ s: t, w: 0.5 }, { s: f, w: 0.5 }];
  };

  // ─────────────────────────────────────────────────────────────────────────
  if (part === "w1" || part === "all") {
    console.log("=".repeat(122));
    console.log("  W1 — ĐỘ MONG MANH TRƯỚC TRƯỢT GIÁ: engine giả định khớp ĐÚNG stop và ĐÚNG giá close");
    console.log("=".repeat(122));
    const tRes = runBooks(bk(turtle, "tx"), heat);
    const fRes = runBooks(bk(fast, "fx"), undefined);
    console.log(`Phơi nhiễm theo tỉ trọng risk — TURTLE: ${exitMix(tRes, w.from, w.to)}`);
    console.log(`Phơi nhiễm theo tỉ trọng risk — FAST  : ${exitMix(fRes, w.from, w.to)}\n`);

    console.log("── W1a: trượt giá khi thoát bằng STOP (nhánh `trail`) ─────────────────────────────────");
    console.log(HDR);
    console.log("-".repeat(122));
    const base = scoreRow(livePortfolio({}, "b"), w, targetDD);
    printRow("mốc: không trượt thêm (số đang công bố)", base);
    for (const s of [0.05, 0.1, 0.15, 0.2, 0.3, 0.5]) {
      printRow(`  slip trail ${s.toFixed(2)}×ATR ≈ ${(atrPct * s * 1e4).toFixed(0)} bps`, scoreRow(livePortfolio({ slipTrailAtr: s }, `st${s}`), w, targetDD), base.mult);
    }

    console.log("\n── W1b: trượt giá khi thoát bằng GIÁ ĐÓNG NẾN (`mid`/`time`, live trễ 90s) ─────────────");
    console.log(HDR);
    console.log("-".repeat(122));
    printRow("mốc: không trượt thêm", base);
    for (const s of [0.05, 0.1, 0.2, 0.3]) {
      printRow(`  slip close ${s.toFixed(2)}×ATR ≈ ${(atrPct * s * 1e4).toFixed(0)} bps`, scoreRow(livePortfolio({ slipCloseAtr: s }, `sc${s}`), w, targetDD), base.mult);
    }

    console.log("\n── W1c: CẢ HAI cùng lúc (kịch bản thực tế) ─────────────────────────────────────────────");
    console.log(HDR);
    console.log("-".repeat(122));
    printRow("mốc: không trượt thêm", base);
    for (const s of [0.05, 0.1, 0.15, 0.2, 0.3]) {
      printRow(`  slip cả hai ${s.toFixed(2)}×ATR ≈ ${(atrPct * s * 1e4).toFixed(0)} bps`, scoreRow(livePortfolio({ slipTrailAtr: s, slipCloseAtr: s }, `sb${s}`), w, targetDD), base.mult);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  if (part === "w2" || part === "all") {
    console.log("\n" + "=".repeat(122));
    console.log("  W2 — HEAT POOL CHUNG hai sleeve (corr 0,954 ⇒ heat thật gần gấp đôi cái chính sách nhìn)");
    console.log("=".repeat(122));
    console.log(HDR);
    console.log("-".repeat(122));

    const sep = (kT: number | null, kF: number | null, tag: string) => {
      const t = dailyR(runBooks(bk(turtle, `t${tag}`), kT ? decayH(kT) : undefined));
      const f = dailyR(runBooks(bk(fast, `f${tag}`), kF ? decayH(kF) : undefined));
      return [{ s: t, w: 0.5 }, { s: f, w: 0.5 }];
    };
    /** Pool CHUNG: cả hai sleeve trong MỘT lời gọi runBooks ⇒ snapshotOpen() thấy cả hai. */
    const joint = (k: number, tag: string) => {
      const res = runBooks([...bk(turtle, `jt${tag}`), ...bk(fast, `jf${tag}`)], decayH(k));
      return [{ s: dailyR(res), w: 1 }];
    };

    const base = scoreRow(sep(T.heatDecayK, null, "cur"), w, targetDD);
    printRow("ĐANG CHẠY: Turtle heat k4 · Fast KHÔNG heat", base);
    const shipCand = scoreRow(sep(T.heatDecayK, T.heatDecayK, "ship"), w, targetDD);
    printRow("ứng viên đã chốt: mỗi sleeve heat k4 RIÊNG", shipCand, base.mult);
    console.log("-".repeat(122));
    for (const k of [2, 4, 6, 8, 12]) {
      printRow(`  POOL CHUNG k=${k}`, scoreRow(joint(k, `${k}`), w, targetDD), base.mult);
    }
    console.log("-".repeat(122));
    console.log("ĐỐI CHỨNG — pool chung ở k ≈ 'siết mạnh gấp đôi'; phải so với separate ở k/2:");
    for (const k of [1, 2, 3, 4, 6]) {
      printRow(`  separate k=${k} (cả hai sleeve)`, scoreRow(sep(k, k, `s${k}`), w, targetDD), base.mult);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  if (part === "w3" || part === "all") {
    console.log("\n" + "=".repeat(122));
    console.log("  W3 — PYRAMID CÓ NÊN SIẾT HARD STOP CHUNG? (chỉ ảnh hưởng LONG — nhánh chứa toàn bộ edge)");
    console.log("=".repeat(122));
    console.log(HDR);
    console.log("-".repeat(122));
    const base = scoreRow(livePortfolio({}, "p0"), w, targetDD);
    printRow("ĐANG CHẠY: add kéo hard stop lên", base);
    printRow("  add KHÔNG kéo hard stop", scoreRow(livePortfolio({ pyramidTightensStop: false }, "p1"), w, targetDD), base.mult);

    console.log("\n— tách từng sleeve (một sổ, risk 1,0) —");
    console.log(HDR);
    console.log("-".repeat(122));
    for (const [name, p, adm] of [["TURTLE", turtle, heat], ["FAST", fast, undefined]] as [string, ExtParams, AdmitFn | undefined][]) {
      const b = scoreRow([{ s: dailyR(runBooks(bk(p, `${name}a`), adm)), w: 1 }], w, targetDD);
      printRow(`${name}: add kéo stop (đang chạy)`, b);
      const r = runBooks(bk({ ...p, pyramidTightensStop: false }, `${name}b`), adm);
      printRow(`  ${name}: add KHÔNG kéo stop`, scoreRow([{ s: dailyR(r), w: 1 }], w, targetDD), b.mult);
      const rBase = runBooks(bk(p, `${name}c`), adm);
      console.log(`      lý do thoát — đang chạy: ${exitMix(rBase, w.from, w.to)}`);
      console.log(`      lý do thoát — không siết: ${exitMix(r, w.from, w.to)}`);
    }
  }
}

if (require.main === module && /exp-execution-risk\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error("Lỗi:", e?.message ?? e);
    process.exit(1);
  });
}
