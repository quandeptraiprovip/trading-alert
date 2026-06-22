/**
 * liquidity-rule-validate.ts — Validate luật "thanh khoản cao → trade" trên coin MỚI
 *
 * Luật rút ra (từ coin-features.ts): coin volume > ~$700M/ngày = nhóm hợp chiến lược.
 * Test OOS THẬT: chạy trên bộ coin KHÔNG nằm trong 12 coin dùng để rút ra luật.
 *   - Đo volume$/ngày → phân HIGH (>700) / LOW (<700).
 *   - Chạy baseline mỗi coin → NET.
 *   - Luật ĐÚNG nếu: nhóm HIGH net DƯƠNG, nhóm LOW net ÂM/yếu.
 *
 * Run: npx ts-node scripts/liquidity-rule-validate.ts [days=500] [thresholdM=700]
 */
import { Candle, CONFIG, TF_MS, aggregate } from "../strategy";
import { fetchKlinesPaged, runBacktest, Trade } from "../backtest";

// Coin MỚI — không có trong 12 coin trước (btc sol xrp doge eth bnb ada avax link ltc trx dot)
const FRESH = [
  "pepeusdt", "shibusdt", "suiusdt", "wldusdt", "nearusdt", "aptusdt", "arbusdt", "opusdt",
  "atomusdt", "filusdt", "injusdt", "seiusdt", "icpusdt", "tiausdt",
];

const net = (ts: Trade[]) => ts.reduce((s, t) => s + t.netR, 0);
const wr = (ts: Trade[]) => (ts.length ? (ts.filter((t) => t.netR > 0).length / ts.length) * 100 : 0);
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const fmt = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1) + "R";

async function main() {
  const days = parseInt(process.argv[2] ?? "500", 10);
  const thr = parseFloat(process.argv[3] ?? "700");
  const bars = Math.ceil((days * TF_MS["1d"]) / TF_MS[CONFIG.entryTf]) + 400;

  console.log(`Tải ${FRESH.length} coin MỚI × ~${days}d (ngưỡng ${thr}M$/ngày)...\n`);
  const rows: { sym: string; vold: number; tier: "HIGH" | "LOW"; ts: Trade[] }[] = [];
  for (const sym of FRESH) {
    let ltf: Candle[];
    try { ltf = await fetchKlinesPaged(sym, CONFIG.entryTf, bars); }
    catch { console.log(`[${sym}] fetch lỗi, bỏ`); continue; }
    if (ltf.length < 1000) { console.log(`[${sym}] thiếu data (${ltf.length}), bỏ`); continue; }
    const daily = aggregate(ltf, "1d", CONFIG.entryTf);
    const vold = mean(daily.map((d) => d.quoteVolume ?? 0)) / 1e6;
    rows.push({ sym, vold, tier: vold > thr ? "HIGH" : "LOW", ts: runBacktest(sym, ltf) });
  }
  console.log();

  console.log("=".repeat(78));
  console.log(`  VALIDATE LUẬT THANH KHOẢN trên coin MỚI — ~${days}d, ngưỡng ${thr}M$/ngày`);
  console.log("=".repeat(78));
  console.log(`${"coin".padEnd(8)} ${"vol$M/d".padStart(9)} ${"tier".padStart(6)} ${"lệnh".padStart(6)} ${"WR".padStart(5)} ${"NET".padStart(9)}`);
  console.log("-".repeat(78));
  for (const r of [...rows].sort((a, b) => b.vold - a.vold)) {
    console.log(`${r.sym.replace("usdt", "").toUpperCase().padEnd(8)} ${r.vold.toFixed(0).padStart(9)} ${r.tier.padStart(6)} ${String(r.ts.length).padStart(6)} ${wr(r.ts).toFixed(0).padStart(4)}% ${fmt(net(r.ts)).padStart(9)}`);
  }
  console.log("-".repeat(78));

  const high = rows.filter((r) => r.tier === "HIGH");
  const low = rows.filter((r) => r.tier === "LOW");
  const sumT = (g: typeof rows) => g.flatMap((r) => r.ts);
  const hT = sumT(high), lT = sumT(low);
  console.log(`\nNhóm HIGH (>${thr}M): ${high.length} coin | ${hT.length} lệnh | WR ${wr(hT).toFixed(0)}% | NET ${fmt(net(hT))} | TB ${(hT.length ? net(hT) / hT.length : 0).toFixed(3)}R`);
  console.log(`  ${high.map((r) => r.sym.replace("usdt", "").toUpperCase()).join(", ") || "—"}`);
  console.log(`Nhóm LOW  (<${thr}M): ${low.length} coin | ${lT.length} lệnh | WR ${wr(lT).toFixed(0)}% | NET ${fmt(net(lT))} | TB ${(lT.length ? net(lT) / lT.length : 0).toFixed(3)}R`);
  console.log(`  ${low.map((r) => r.sym.replace("usdt", "").toUpperCase()).join(", ") || "—"}`);

  const hPer = hT.length ? net(hT) / hT.length : 0, lPer = lT.length ? net(lT) / lT.length : 0;
  console.log("\nPHÁN QUYẾT:");
  if (hPer > 0.15 && lPer < hPer) {
    console.log(`→ Luật ĐÚNG OOS ✅ — HIGH (${hPer.toFixed(3)}R/lệnh) > LOW (${lPer.toFixed(3)}R/lệnh). Chọn coin theo volume là chính đáng.`);
  } else if (hPer <= lPer) {
    console.log(`→ Luật KHÔNG vững ⚠️ — HIGH (${hPer.toFixed(3)}R) không hơn LOW (${lPer.toFixed(3)}R). Volume KHÔNG phải tiêu chí thật.`);
  } else {
    console.log(`→ Mơ hồ — HIGH ${hPer.toFixed(3)}R vs LOW ${lPer.toFixed(3)}R, chênh nhỏ. Cần thêm coin/dữ liệu.`);
  }
  console.log();
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
