/**
 * fx-gold-majors.ts — "tập trung vào các cặp PHỔ BIẾN và VÀNG thì sao?"
 *
 * Câu hỏi này nhắm đúng hai chỗ hợp lý nhất còn lại:
 *   - cặp phổ biến = spread chặt nhất (EURUSD 0,9 bps so với NOK/SEK 15 bps). Nếu chi phí là thứ
 *     giết mọi kết quả FX thì thu hẹp về nhóm rẻ nhất là hướng đúng để thử.
 *   - vàng = công cụ DUY NHẤT trong toàn bộ nghiên cứu FX/CFD liên tục cho kết quả dương, và là
 *     đối chứng dương ở phép lệch pha nến (dương 6/6 mốc).
 *
 * NHƯNG vàng cũng chính là thứ làm rổ hàng hoá RỚT phép kiểm tập trung: XAUUSD chiếm 92–115% tổng
 * lợi nhuận của rổ kim loại và rổ 10 công cụ. Nghĩa là mọi kết quả dương trước đây của "rổ hàng
 * hoá" thực chất LÀ vàng. Nên vàng xứng đáng được đo đứng riêng, thay vì núp trong một rổ.
 *
 * BA CÂU HỎI, xếp theo cái nào quyết định nhất:
 *   §2 Có phải chỉ là MUA-VÀ-GIỮ vàng đội lốt chiến lược không? (vàng 2004→2025 tăng rất mạnh)
 *   §3 Lợi nhuận có dồn vào một vài năm không? (2025 là năm vàng bùng nổ)
 *   §5 Thêm vào hệ crypto đang chạy thì danh mục TỐT LÊN hay chỉ THÊM PHƯƠNG SAI?
 *
 * §5 mới là câu hỏi thật. "Vàng có ăn không" là câu hỏi sai; câu đúng là "thêm vàng vào cái đang
 * chạy thì tổng thể có khá hơn không".
 *
 * Chạy: npx ts-node fx/fx-gold-majors.ts
 */

import { CONFIG, Candle } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, runBooks } from "../scripts/portfolio-engine";
import { HEADER, decayH, evaluate, windowOf } from "../scripts/rx-lab";
import { concentration } from "../scripts/exp-concentration";
import { liveSleeves } from "../scripts/chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "../scripts/exp-breadth";
import { FX_SWAP_PER_8H_PCT, FX_TURTLE, fxBooks, fxCostParams, loadUniverse } from "./fx-transfer";
import { aggregateFx, loadH1 } from "./fx-data";
import { atSpeed } from "./fx-speed";
import { buyHold, corr, dailySeries, run, sharpeOf } from "./fx-validate";

// ─────────────────────────────────────────────
// RỔ — theo mức PHỔ BIẾN/thanh khoản, khai báo trước khi nhìn kết quả
// ─────────────────────────────────────────────
/** Bốn cặp bán lẻ giao dịch nhiều nhất. */
const POPULAR4 = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD"];
/** Bộ major cổ điển. */
const MAJORS6 = [...POPULAR4, "USDCHF", "USDCAD"];
const GOLD = ["XAUUSD"];
const GOLD_SILVER = ["XAUUSD", "XAGUSD"];
const POPULAR_GOLD = [...POPULAR4, "XAUUSD"];

const heat = decayH(T.heatDecayK);

/** Chuỗi P&L NGÀY của một rổ FX, để ghép ở tầng danh mục với hệ crypto. */
function fxDaily(syms: string[], p: ExtParams, tag: string): Map<number, number> {
  const r = evaluate("x", fxBooks(syms, p, tag), heat, windowOf(loadUniverse(syms), 60));
  return dailySeries(r.res);
}

function stat(m: Map<number, number>) {
  const days = [...m.keys()].sort((a, b) => a - b);
  const v = days.map((d) => m.get(d)!);
  const mu = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / (v.length - 1));
  let cum = 0, peak = 0, maxDD = 0;
  const byYear = new Map<number, number>();
  for (let i = 0; i < v.length; i++) {
    cum += v[i]; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum);
    const y = new Date(days[i] * 86400e3).getUTCFullYear();
    byYear.set(y, (byYear.get(y) ?? 0) + v[i]);
  }
  const yrs = [...byYear.values()];
  const total = yrs.reduce((s, x) => s + x, 0);
  const best = Math.max(...yrs);
  const restPerYear = yrs.length > 1 ? (total - best) / (yrs.length - 1) : 0;
  return {
    net: total, sharpe: sd > 0 ? (mu / sd) * Math.sqrt(252) : 0, maxDD,
    bestPct: total > 0 ? (best / total) * 100 : 0,
    recovery: maxDD > 0 ? restPerYear / maxDD : 0,
    posYears: yrs.filter((x) => x > 0).length, nYears: yrs.length,
  };
}

async function main() {
  CONFIG.costs.fundingPer8hPct = FX_SWAP_PER_8H_PCT;
  console.log("Cấu hình: production Turtle, KHÔNG chỉnh tham số (s=1); kèm bản chậm s=4 vì nghiên");
  console.log("cứu trước cho thấy công cụ khung NGÀY cần tốc độ chậm hơn lịch crypto.\n");

  // ── §1 ──
  console.log("═══ §1. RỔ PHỔ BIẾN vs VÀNG ═══");
  console.log(HEADER);
  run("4 cặp phổ biến nhất", POPULAR4, FX_TURTLE, "p4");
  run("6 major", MAJORS6, FX_TURTLE, "m6");
  run("4 phổ biến, chậm s=4", POPULAR4, atSpeed(4), "p4s");
  run("6 major, chậm s=4", MAJORS6, atSpeed(4), "m6s");
  console.log("  ── vàng ──");
  const g1 = run("VÀNG một mình (s=1)", GOLD, FX_TURTLE, "g1");
  const g4 = run("VÀNG một mình (chậm s=4)", GOLD, atSpeed(4), "g4");
  run("vàng+bạc (s=1)", GOLD_SILVER, FX_TURTLE, "gs1");
  run("vàng+bạc (chậm s=4)", GOLD_SILVER, atSpeed(4), "gs4");
  run("4 phổ biến + vàng (s=1)", POPULAR_GOLD, FX_TURTLE, "pg1");

  // ── §2. Câu hỏi nguy hiểm nhất ──
  console.log("\n═══ §2. VÀNG: CÓ PHẢI CHỈ LÀ MUA-VÀ-GIỮ ĐỘI LỐT KHÔNG? ═══");
  console.log("Vàng 2004→2025 tăng nhiều lần. Một luật long-biased trên tài sản như thế sẽ dương");
  console.log("mà không cần có edge nào. Mốc so sánh: mua-và-giữ vol-target.\n");
  const wG = windowOf(loadUniverse(GOLD), 60);
  const bh = buyHold(GOLD, wG.from, wG.to);
  for (const [label, r] of [["vàng s=1", g1], ["vàng s=4", g4]] as [string, typeof g1][]) {
    const st = dailySeries(r.res);
    const longs = r.res.trades.filter((t) => t.dir === "long");
    const shorts = r.res.trades.filter((t) => t.dir === "short");
    const sum = (a: typeof longs) => a.reduce((s, t) => s + t.netR * t.weight, 0);
    console.log(
      `${label.padEnd(12)} Sharpe chiến lược ${(r.sharpe * Math.sqrt(252 / 365)).toFixed(2).padStart(6)}` +
      ` · mua-và-giữ ${sharpeOf(bh).toFixed(2).padStart(6)} · tương quan ${corr(st, bh).toFixed(2).padStart(6)}`,
    );
    console.log(
      `${" ".repeat(12)} LONG ${sum(longs).toFixed(0).padStart(5)}R (${longs.length} unit)` +
      ` · SHORT ${sum(shorts).toFixed(0).padStart(5)}R (${shorts.length} unit)`,
    );
  }
  console.log("Nếu SHORT âm nặng và LONG gánh tất cả ⇒ đây là beta vàng, không phải luật trend.");

  // ── §3. Tập trung ──
  console.log("\n═══ §3. TẬP TRUNG — cùng ngưỡng và cùng thước với hệ crypto ═══");
  concentration("VÀNG một mình, s=1", g1.res, wG.from, wG.to);
  concentration("VÀNG một mình, s=4", g4.res, wG.from, wG.to);

  // ── §4. Lệch pha cho vàng đứng riêng ──
  console.log("\n═══ §4. LỆCH PHA NẾN (vàng đứng riêng) ═══");
  console.log("Dựng lại nến ngày từ H1 ở 6 mốc đóng khác nhau. Dấu phải giữ nguyên qua cả 6.");
  console.log("mốc UTC".padEnd(12) + [0, 4, 8, 12, 18, 22].map((h) => `${h}h`.padStart(9)).join(""));
  for (const [label, p] of [["s=1", FX_TURTLE], ["s=4", atSpeed(4)]] as [string, ExtParams][]) {
    const nets: number[] = [];
    for (const h of [0, 4, 8, 12, 18, 22]) {
      const candles = aggregateFx(loadH1("XAUUSD"), "1d", h);
      const bs: Book[] = [{
        key: `XAUUSD@${h}`, symbol: "XAUUSD", candles: candles as Candle[],
        p: { ...p, ...fxCostParams(candles) },
      }];
      const r = evaluate("x", bs, heat, windowOf(new Map([[`XAUUSD@${h}`, candles as Candle[]]]), 60 * 8));
      nets.push(r.net);
    }
    const lo = Math.min(...nets), hi = Math.max(...nets);
    console.log(
      label.padEnd(12) + nets.map((n) => `${n.toFixed(0)}R`.padStart(9)).join("") +
      `   biên độ ${lo.toFixed(0)}…${hi.toFixed(0)}R` + (lo < 0 && hi > 0 ? "  ← ĐỔI DẤU" : "  (giữ dấu)"),
    );
  }

  // ── §5. CÂU HỎI THẬT: thêm vào hệ đang chạy thì sao ──
  console.log("\n═══ §5. THÊM VÀO HỆ CRYPTO ĐANG CHẠY — câu hỏi thật ═══");
  const data = await loadPool(2000, CORE8);
  if (data.size < CORE8.length) {
    console.log(`⚠️  chỉ nạp được ${data.size}/${CORE8.length} symbol — bỏ qua §5`);
    return;
  }
  const btc = data.get("btcusdt")!;
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle } = liveSleeves(gate);
  const admit: AdmitFn = decayH(T.heatDecayK);
  const bk: Book[] = [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@t`, symbol, candles, p: turtle }));
  const wC = coreWindow(data, T.btcGateSlow + 200);
  const cryptoRes = runBooks(bk, admit);
  const crypto = new Map<number, number>();
  for (const [d, v] of dailySeries(cryptoRes)) {
    if (d * 86400e3 >= wC.from && d * 86400e3 <= wC.to) crypto.set(d, v);
  }

  const candidates: [string, Map<number, number>][] = [
    ["vàng s=1", fxDaily(GOLD, FX_TURTLE, "x1")],
    ["vàng s=4", fxDaily(GOLD, atSpeed(4), "x4")],
    ["vàng+bạc s=4", fxDaily(GOLD_SILVER, atSpeed(4), "x5")],
    ["4 cặp phổ biến s=1", fxDaily(POPULAR4, FX_TURTLE, "x6")],
  ];

  const base = stat(crypto);
  console.log(
    `\nNỀN — Turtle CORE8 (tiền thật): NET ${base.net.toFixed(0)}R · Sharpe ${base.sharpe.toFixed(2)}` +
    ` · maxDD ${base.maxDD.toFixed(0)}R · hồi phục ${base.recovery.toFixed(2)} · ${base.posYears}/${base.nYears} năm dương`,
  );
  console.log(
    "\n" + "thêm vào".padEnd(22) + "corr".padStart(7) + "Sharpe nhánh".padStart(14) +
    "Sharpe TỔNG".padStart(13) + "hồi phục TỔNG".padStart(15) + "  đánh giá",
  );
  for (const [label, series] of candidates) {
    const overlap = new Map<number, number>();
    for (const [d, v] of series) if (crypto.has(d)) overlap.set(d, v);
    const c = corr(crypto, series);
    const solo = stat(overlap);
    // Ghép 1:1 theo R — cùng đơn vị rủi ro nên cộng thẳng là đúng.
    const mix = new Map<number, number>();
    for (const [d, v] of crypto) mix.set(d, v + (series.get(d) ?? 0));
    const m = stat(mix);
    const better = m.sharpe > base.sharpe && m.recovery > base.recovery;
    console.log(
      label.padEnd(22) + c.toFixed(2).padStart(7) + solo.sharpe.toFixed(2).padStart(14) +
      m.sharpe.toFixed(2).padStart(13) + m.recovery.toFixed(2).padStart(15) +
      (better ? "  ✅ tốt lên" : "  ❌ không tốt lên"),
    );
  }
  console.log(
    `\nSo với nền: Sharpe ${base.sharpe.toFixed(2)} · hồi phục ${base.recovery.toFixed(2)}.\n` +
    "Một nhánh chỉ đáng thêm nếu nó nâng ĐỒNG THỜI Sharpe và hồi phục của TỔNG danh mục.\n" +
    "Tương quan thấp một mình không đủ — thêm một nhánh kỳ vọng ~0 vào danh mục chỉ pha loãng.",
  );

  // ── §6. HAI PHÉP KIỂM BẮT BUỘC trước khi tin §5 ──
  console.log("\n═══ §6. §5 DƯƠNG — nhưng phải loại hai cách giải thích tầm thường ═══");

  // (a) Phần đóng góp của vàng TRONG cửa sổ crypto có dồn vào một năm không?
  console.log("\n(a) Đóng góp của vàng THEO NĂM, chỉ trong cửa sổ chồng lấn với crypto:");
  for (const [label, series] of candidates.slice(0, 2)) {
    const byYear = new Map<number, number>();
    for (const [d, v] of series) {
      if (!crypto.has(d)) continue;
      byYear.set(new Date(d * 86400e3).getUTCFullYear(), (byYear.get(new Date(d * 86400e3).getUTCFullYear()) ?? 0) + v);
    }
    const yrs = [...byYear.entries()].sort((a, b) => a[0] - b[0]);
    const tot = yrs.reduce((s, x) => s + x[1], 0);
    const best = Math.max(...yrs.map((x) => x[1]));
    console.log(
      `  ${label.padEnd(12)} ` + yrs.map(([y, v]) => `${y}:${v >= 0 ? "+" : ""}${v.toFixed(0)}R`).join("  "),
    );
    console.log(
      `  ${" ".repeat(12)} tổng ${tot.toFixed(0)}R · năm tốt nhất chiếm ` +
      `${tot > 0 ? ((best / tot) * 100).toFixed(0) : "—"}%` +
      `${tot > 0 && best / tot > 0.5 ? "  ⚠️ MỘT NĂM gánh hơn nửa" : ""}`,
    );
  }

  // (b) Mua-và-giữ vàng, chuẩn hoá về cùng rủi ro, có làm tốt hơn LUẬT không?
  console.log("\n(b) Nếu chỉ MUA-VÀ-GIỮ vàng thay vì chạy luật trend lên nó:");
  const goldTrend = candidates[1][1]; // vàng s=4
  const sdOf = (m: Map<number, number>) => {
    const v = [...m.values()];
    const mu = v.reduce((s, x) => s + x, 0) / v.length;
    return Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / (v.length - 1));
  };
  const bhAll = buyHold(GOLD, wG.from, wG.to);
  // Chuẩn hoá mua-và-giữ về đúng độ lệch ngày của nhánh luật ⇒ so cùng mức rủi ro.
  const k = sdOf(goldTrend) / sdOf(bhAll);
  const bhScaled = new Map([...bhAll].map(([d, v]) => [d, v * k] as [number, number]));
  for (const [label, series] of [["luật trend s=4", goldTrend], ["mua-và-giữ (cùng rủi ro)", bhScaled]] as [string, Map<number, number>][]) {
    const mix = new Map<number, number>();
    for (const [d, v] of crypto) mix.set(d, v + (series.get(d) ?? 0));
    const m = stat(mix);
    console.log(
      `  ${label.padEnd(26)} Sharpe TỔNG ${m.sharpe.toFixed(2)} · hồi phục ${m.recovery.toFixed(2)}` +
      ` · maxDD ${m.maxDD.toFixed(0)}R`,
    );
  }
  console.log(
    "\nNếu mua-và-giữ cho kết quả ngang hoặc hơn, thì luật trend trên vàng KHÔNG đóng góp gì —\n" +
    "cái đang giúp danh mục chỉ là việc CÓ MẶT ở vàng, và cách đơn giản nhất để có mặt là mua.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
