/**
 * exp-exit-gates.ts — HAI CỬA CUỐI cho ứng viên luật thoát, cộng phần giải thích cơ chế còn thiếu.
 *
 * Trạng thái trước file này: `time-stop 30 ngày` + `trail SHORT 2,0×ATR` cho Sharpe 1,345 → 1,769,
 * qua holdout ba-cửa-vào và có trượt giá. NHƯNG kiểm tra cơ chế RA KẾT QUẢ XẤU:
 *
 *   unit giữ ≥30 ngày = 2,7% số unit nhưng mang **+750,6R = 89,6% tổng NET R**, và netR/unit TĂNG
 *   đơn điệu theo thời gian giữ (0-5 ngày −0,08 → 40-60 ngày +10,3 → >60 ngày +17,3).
 *
 * Tức là time-stop cắt ĐÚNG chỗ toàn bộ tiền nằm. Một luật như thế mà làm Sharpe tăng 23% thì phải
 * bị nghi trước, tin sau. Ba khả năng, file này phân biệt chúng:
 *
 *   H1 TÁI NEO: cắt rồi vào lại ⇒ stop được neo lại ở giá hiện tại. Đây là một trailing stop rất
 *      hung hãn cài đặt bằng đóng-và-mở-lại. Nếu đúng thì phải thấy SỐ VỊ THẾ tăng và phần lớn lệnh
 *      bị cắt được vào lại ngay sau đó.
 *   H2 SHARPE MTM: Sharpe tính trên P&L mark-to-market hằng ngày, nên nó TRỪNG PHẠT phần lãi chưa
 *      thực hiện bị trả lại ở cuối trend. Cắt sớm làm đường MTM mượt hơn mà NET R gần như không đổi.
 *      Nếu đúng thì NET R tăng ít mà Sharpe tăng nhiều — và đây KHÔNG phải "kiếm thêm tiền".
 *   H3 HIỆN VẬT MỘT GIAI ĐOẠN: 2021 có đỉnh blow-off, cắt lệnh long dài đúng lúc đó là may. Nếu
 *      đúng thì lợi ích dồn vào một năm và cửa TẬP TRUNG sẽ bắt được.
 *
 * Bằng chứng đã có, nghiêng về H2/H3: NET R chỉ 838 → 937 (**+12%**) trong khi Sharpe +32%; và era A
 * nhảy 0,69 → 1,48 (**+114%**) còn era B gần như không đổi (1,38 → 1,53).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HAI CỬA CUỐI (memory: hai cửa này đã bắt được thứ MỌI cửa khác bỏ lọt)
 *   G1 LỆCH PHA NẾN — chạy đúng luật trên lưới 4h lệch 1h/2h/3h. Lưới 00:00 UTC là quy ước của sàn,
 *      không phải quy luật thị trường. Ứng viên phải thắng trên CẢ 4 pha.
 *   G2 TẬP TRUNG THEO NĂM — phần cải thiện có dồn vào một năm không.
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-exit-gates.ts [days=2000]
 */

import { Candle, TF_MS } from "../strategy";
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, EquityPoint, ExtParams, UnitTrade, riskMetrics, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, loadPool } from "./exp-breadth";

const DAY = TF_MS["1d"];
const H = TF_MS["1h"];
const BPD = 6;
const decayH = (k: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k);

/** Ba gói được chấm RIÊNG — hai cơ chế khác nhau, có thể chỉ một cái bị nhiễm. */
const CANDS: [string, Partial<ExtParams>][] = [
  ["A) chỉ time-stop 30 ngày", { maxHoldDays: 30 }],
  ["B) chỉ trail SHORT 2,0×ATR", { initialStopMult: 3.0, chandelierMult: 2.0 }],
  ["C) CẢ HAI", { maxHoldDays: 30, initialStopMult: 3.0, chandelierMult: 2.0 }],
];
const CAND: Partial<ExtParams> = CANDS[2][1];

/** Gộp nến 1h thành 4h lệch pha `offsetH` giờ; chỉ giữ nhóm ĐỦ 4 nến (không lookahead). */
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
    if (g.length !== 4) continue;
    out.push({
      openTime: g[0].openTime,
      open: g[0].open,
      high: Math.max(...g.map((x) => x.high)),
      low: Math.min(...g.map((x) => x.low)),
      close: g[3].close,
      volume: g.reduce((s, x) => s + x.volume, 0),
      quoteVolume: g.reduce((s, x) => s + (x.quoteVolume ?? 0), 0),
      takerBuyVolume: g.reduce((s, x) => s + (x.takerBuyVolume ?? 0), 0),
    } as Candle);
  }
  return out;
}

function dailyOf(eq: EquityPoint[], from: number, to: number): Map<number, number> {
  const per = new Map<number, number>();
  for (let i = 1; i < eq.length; i++) {
    if (eq[i].time < from || eq[i].time > to) continue;
    const d = Math.floor(eq[i].time / DAY);
    per.set(d, (per.get(d) ?? 0) + (eq[i].mtm - eq[i - 1].mtm));
  }
  return per;
}
const sharpeOf = (r: number[]): number => {
  const n = r.length;
  if (n < 3) return 0;
  const m = r.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  return sd > 0 ? (m / sd) * Math.sqrt(365) : 0;
};

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  console.log(`Nạp ${CORE8.length} symbol CORE8 nến 4h...`);
  const data4h = await loadPool(days, CORE8);
  const gate4h = buildBtcGateLongs(data4h.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const sl4h = liveSleeves(gate4h);

  // Cửa sổ đánh giá theo rổ lõi
  let from = -Infinity, to = -Infinity;
  for (const s of CORE8) {
    const c = data4h.get(s);
    if (!c) continue;
    from = Math.max(from, c[Math.min(T.btcGateSlow + 200, c.length - 1)].openTime);
    to = Math.max(to, c[c.length - 1].openTime);
  }
  const heat = decayH(T.heatDecayK);

  const runOn = (data: Map<string, Candle[]>, gate: ReturnType<typeof buildBtcGateLongs>, ov: Partial<ExtParams>) => {
    const s = liveSleeves(gate);
    const books: Book[] = [
      ...[...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@t`, symbol, candles, p: { ...s.turtle, ...ov } })),
      ...[...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@f`, symbol, candles, p: { ...s.fast, ...ov } })),
    ];
    return runBooks(books, heat);
  };

  // ═══ H1 vs H2: TÁI NEO hay SHARPE MTM ═══
  console.log("═".repeat(106));
  console.log("  0) PHÂN BIỆT H1 (tái neo) vs H2 (Sharpe mark-to-market) vs H3 (hiện vật giai đoạn)");
  console.log("═".repeat(106));
  const rBase = runOn(data4h, gate4h, {});
  const rCand = runOn(data4h, gate4h, CAND);
  const inW = (ts: UnitTrade[]) => ts.filter((t) => t.entryTime >= from && t.entryTime <= to);
  const posOf = (r: typeof rBase) => new Set(inW(r.trades).map((t) => `${t.book}#${t.positionId}`)).size;
  const mB = riskMetrics(rBase.equity.filter((e) => e.time >= from && e.time <= to));
  const mC = riskMetrics(rCand.equity.filter((e) => e.time >= from && e.time <= to));
  const dB = dailyOf(rBase.equity, from, to), dC = dailyOf(rCand.equity, from, to);
  const gd = [...new Set([...dB.keys(), ...dC.keys()])].sort((a, b) => a - b);
  const sB = gd.map((d) => dB.get(d) ?? 0), sC = gd.map((d) => dC.get(d) ?? 0);
  const sdOf = (r: number[]) => { const m = r.reduce((s, x) => s + x, 0) / r.length; return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)); };

  console.log(`  ${"".padEnd(26)}${"GỐC".padStart(12)}${"ỨNG VIÊN".padStart(12)}   thay đổi`);
  console.log("-".repeat(106));
  const cmp = (lbl: string, a: number, b: number, fmt = 1) => {
    const pct = a !== 0 ? ((b - a) / Math.abs(a)) * 100 : 0;
    console.log(`  ${lbl.padEnd(26)}${a.toFixed(fmt).padStart(12)}${b.toFixed(fmt).padStart(12)}   ${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`);
  };
  cmp("NET R (tiền)", mB.netR, mC.netR);
  cmp("sd P&L ngày (rủi ro)", sdOf(sB), sdOf(sC), 3);
  cmp("Sharpe", sharpeOf(sB), sharpeOf(sC), 3);
  cmp("maxDD (R)", mB.maxDD, mC.maxDD);
  cmp("số VỊ THẾ", posOf(rBase), posOf(rCand), 0);
  cmp("số UNIT", inW(rBase.trades).length, inW(rCand.trades).length, 0);
  console.log("-".repeat(106));
  const dNet = ((mC.netR - mB.netR) / mB.netR) * 100;
  const dSd = ((sdOf(sC) - sdOf(sB)) / sdOf(sB)) * 100;
  console.log(
    `  ⇒ Sharpe tăng đến từ đâu: NET R ${dNet >= 0 ? "+" : ""}${dNet.toFixed(0)}% (tử số) vs sd ${dSd >= 0 ? "+" : ""}${dSd.toFixed(0)}% (mẫu số).\n` +
    `    Nếu phần lớn nằm ở MẪU SỐ thì đây là H2: đường MTM mượt hơn, KHÔNG phải kiếm thêm tiền —\n` +
    `    và lợi ích chỉ thành tiền nếu ta thật sự nâng đòn bẩy lên tương ứng.`,
  );

  // ═══ G2 TẬP TRUNG THEO NĂM — chấm RIÊNG từng gói ═══
  console.log("\n" + "═".repeat(106));
  console.log("  G2) TẬP TRUNG THEO NĂM — phần cải thiện có dồn vào một năm không? (ngưỡng: không năm nào >50%)");
  console.log("═".repeat(106));
  const YEARS = [2021, 2022, 2023, 2024, 2025, 2026];
  for (const [name, ov] of CANDS) {
    const rc = runOn(data4h, gate4h, ov);
    const rows: { y: number; a: number; b: number }[] = [];
    for (const y of YEARS) {
      const lo = Math.max(Date.UTC(y, 0, 1), from), hi = Math.min(Date.UTC(y + 1, 0, 1), to);
      if (hi <= lo) continue;
      const eb = rBase.equity.filter((e) => e.time >= lo && e.time < hi);
      const ec = rc.equity.filter((e) => e.time >= lo && e.time < hi);
      if (eb.length < 3) continue;
      rows.push({ y, a: riskMetrics(eb).netR, b: riskMetrics(ec).netR });
    }
    const totD = rows.reduce((s2, x) => s2 + (x.b - x.a), 0);
    const top = rows.reduce((a, b) => (Math.abs(b.b - b.a) > Math.abs(a.b - a.a) ? b : a));
    const share = totD !== 0 ? ((top.b - top.a) / totD) * 100 : 0;
    const negYears = rows.filter((x) => x.b < x.a).map((x) => x.y);
    console.log(`\n  ${name}   (tổng chênh ${totD >= 0 ? "+" : ""}${totD.toFixed(1)}R)`);
    console.log("  " + "năm".padEnd(8) + rows.map((x) => String(x.y).padStart(9)).join(""));
    console.log("  " + "chênh R".padEnd(8) + rows.map((x) => ((x.b - x.a >= 0 ? "+" : "") + (x.b - x.a).toFixed(1)).padStart(9)).join(""));
    console.log("  " + "%chênh".padEnd(8) + rows.map((x) => (totD !== 0 ? `${(((x.b - x.a) / totD) * 100).toFixed(0)}%` : "—").padStart(9)).join(""));
    console.log(`  → năm lớn nhất ${top.y}: ${share.toFixed(0)}% tổng chênh · năm bị XẤU đi: ${negYears.length ? negYears.join(", ") : "không"}` +
      `  ⇒ ${Math.abs(share) > 50 ? "RỚT" : "ĐẬU"}`);
  }

  // ═══ G1 LỆCH PHA NẾN ═══
  console.log("\n" + "═".repeat(106));
  console.log("  G1) LỆCH PHA NẾN 4h — ứng viên phải thắng trên CẢ 4 pha (0h/1h/2h/3h)");
  console.log("═".repeat(106));
  console.log("  Nạp nến 1h để dựng lưới 4h lệch pha...");
  const h1 = new Map<string, Candle[]>();
  const bars1h = Math.ceil(days * 24) + T.btcGateSlow * 4 + 800;
  for (const s of CORE8) h1.set(s, await fetchFuturesKlinesPaged(s, "1h", bars1h));

  console.log("  " + "pha".padEnd(10) + "GỐC Sharpe".padStart(12) + "ỨV Sharpe".padStart(12) + "Δ".padStart(9) +
    "   GỐC NET".padStart(11) + "ỨV NET".padStart(9) + "   ỨV era A/B/C");
  console.log("-".repeat(106));
  let wins = 0;
  for (const ph of [0, 1, 2, 3]) {
    const dp = new Map<string, Candle[]>();
    for (const s of CORE8) dp.set(s, aggregatePhase(h1.get(s)!, ph));
    const g = buildBtcGateLongs(dp.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
    let f2 = -Infinity, t2 = -Infinity;
    for (const s of CORE8) {
      const c = dp.get(s)!;
      f2 = Math.max(f2, c[Math.min(T.btcGateSlow + 200, c.length - 1)].openTime);
      t2 = Math.max(t2, c[c.length - 1].openTime);
    }
    const rb = runOn(dp, g, {}), rc = runOn(dp, g, CAND);
    const db = dailyOf(rb.equity, f2, t2), dc = dailyOf(rc.equity, f2, t2);
    const gg = [...new Set([...db.keys(), ...dc.keys()])].sort((a, b) => a - b);
    const shB = sharpeOf(gg.map((d) => db.get(d) ?? 0)), shC = sharpeOf(gg.map((d) => dc.get(d) ?? 0));
    const mb = riskMetrics(rb.equity.filter((e) => e.time >= f2 && e.time <= t2));
    const mc = riskMetrics(rc.equity.filter((e) => e.time >= f2 && e.time <= t2));
    const eras = [0, 1, 2].map((k) => {
      const a = f2 + ((t2 - f2) * k) / 3, b = f2 + ((t2 - f2) * (k + 1)) / 3;
      return riskMetrics(rc.equity.filter((x) => x.time >= a && x.time <= b)).sharpe;
    });
    if (shC > shB) wins++;
    console.log("  " + (ph === 0 ? "0h (live)" : `${ph}h`).padEnd(10) + shB.toFixed(3).padStart(12) + shC.toFixed(3).padStart(12) +
      ((shC - shB >= 0 ? "+" : "") + (shC - shB).toFixed(3)).padStart(9) +
      mb.netR.toFixed(0).padStart(11) + mc.netR.toFixed(0).padStart(9) + "   " + eras.map((x) => x.toFixed(2)).join("/"));
  }
  console.log("-".repeat(106));
  console.log(`  Ứng viên thắng ${wins}/4 pha  ⇒ ${wins === 4 ? "ĐẬU" : wins >= 3 ? "sát ngưỡng — CHƯA ĐỦ" : "RỚT"}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
