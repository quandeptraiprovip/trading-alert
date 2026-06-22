/**
 * coin-fit.ts — "Phương pháp có hợp riêng một số coin?" → signal hay noise?
 *
 * Với mỗi coin: chia lịch sử dài thành nửa CŨ vs nửa MỚI, chạy baseline mỗi nửa.
 *  - Dấu NET NHẤT QUÁN qua 2 nửa (đều + hoặc đều −) ⇒ tính chất coin THẬT.
 *  - Dấu LẬT giữa 2 nửa ⇒ chênh lệch cross-coin chủ yếu là NHIỄU mẫu nhỏ.
 *
 * Run: npx ts-node scripts/coin-fit.ts [longDays=500]
 */
import { Candle, CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest, Trade } from "../backtest";

const net = (ts: Trade[]) => ts.reduce((s, t) => s + t.netR, 0);
const wr = (ts: Trade[]) => (ts.length ? (ts.filter((t) => t.netR > 0).length / ts.length) * 100 : 0);
const fmt = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1) + "R";

const COINS = [
  "btcusdt", "solusdt", "xrpusdt", "dogeusdt", // rổ hiện tại
  "ethusdt", "bnbusdt", "adausdt", "avaxusdt", "linkusdt", "ltcusdt", "trxusdt", "dotusdt",
];

async function main() {
  const longDays = parseInt(process.argv[2] ?? "500", 10);
  const bars = Math.ceil((longDays * TF_MS["1d"]) / TF_MS[CONFIG.entryTf]) + 400;
  const inBasket = new Set(CONFIG.symbols);

  console.log(`Tải ${COINS.length} coin × ~${longDays}d...\n`);
  const rows: { sym: string; oldN: number; oldC: number; newN: number; newC: number; cls: string }[] = [];
  for (const sym of COINS) {
    const ltf = await fetchKlinesPaged(sym, CONFIG.entryTf, bars);
    if (ltf.length < 1000) { console.log(`[${sym}] thiếu data`); continue; }
    const mid = Math.floor(ltf.length / 2);
    const older = runBacktest(sym, ltf.slice(0, mid));
    const newer = runBacktest(sym, ltf.slice(Math.max(0, mid - 400)));
    const o = net(older), n = net(newer);
    let cls: string;
    if (o > 0 && n > 0) cls = "good (đều +) ✅";
    else if (o <= 0 && n <= 0) cls = "bad (đều −) ❌";
    else cls = "NHIỄU (lật dấu) ⚠️";
    rows.push({ sym, oldN: o, oldC: older.length, newN: n, newC: newer.length, cls });
  }
  console.log();

  console.log("=".repeat(82));
  console.log(`  NHẤT QUÁN THEO COIN — nửa CŨ vs nửa MỚI (~${longDays}d), [r]ổ = trong rổ hiện tại`);
  console.log("=".repeat(82));
  console.log(`${"coin".padEnd(12)} ${"nửa CŨ (lệnh)".padStart(18)} ${"nửa MỚI (lệnh)".padStart(18)}   phân loại`);
  console.log("-".repeat(82));
  for (const r of rows) {
    const tag = inBasket.has(r.sym) ? "[r]" : "   ";
    console.log(
      `${tag}${r.sym.toUpperCase().replace("USDT", "").padEnd(9)} ${(fmt(r.oldN) + " (" + r.oldC + ")").padStart(18)} ${(fmt(r.newN) + " (" + r.newC + ")").padStart(18)}   ${r.cls}`
    );
  }
  console.log("-".repeat(82));

  const good = rows.filter((r) => r.cls.startsWith("good"));
  const bad = rows.filter((r) => r.cls.startsWith("bad"));
  const noisy = rows.filter((r) => r.cls.startsWith("NHIỄU"));
  console.log(`\nTổng: ${good.length} good / ${bad.length} bad / ${noisy.length} nhiễu (trên ${rows.length} coin)`);
  console.log(`Coin GOOD (đều +): ${good.map((r) => r.sym.replace("usdt", "").toUpperCase()).join(", ") || "—"}`);
  console.log(`Coin BAD  (đều −): ${bad.map((r) => r.sym.replace("usdt", "").toUpperCase()).join(", ") || "—"}`);
  console.log(`Coin NHIỄU (lật) : ${noisy.map((r) => r.sym.replace("usdt", "").toUpperCase()).join(", ") || "—"}`);

  const basketRows = rows.filter((r) => inBasket.has(r.sym));
  const basketAllGood = basketRows.every((r) => r.cls.startsWith("good"));
  const consistent = good.length + bad.length;
  console.log("\nDIỄN GIẢI:");
  if (noisy.length > rows.length / 2) {
    console.log("→ Đa số coin LẬT DẤU giữa 2 nửa ⇒ chênh lệch cross-coin chủ yếu là NHIỄU.");
    console.log("  Rổ thắng nhiều khả năng là MAY (overfit chọn coin), không phải tính chất coin.");
  } else if (consistent >= Math.ceil((rows.length * 2) / 3) && basketAllGood) {
    console.log(`→ ${consistent}/${rows.length} coin NHẤT QUÁN dấu qua 2 giai đoạn (>2/3) và rổ hiện tại ĐỀU good ⇒`);
    console.log("  'phương pháp hợp một số coin' là THẬT, không phải nhiễu mẫu nhỏ.");
    console.log("  Việc cần làm: tìm đặc trưng BIẾT TRƯỚC (volatility/trendiness/beta/volume) phân biệt");
    console.log("  good vs bad → chọn coin theo TÍNH CHẤT, không phải peek P&L in-sample (hết overfit chọn rổ).");
  } else {
    console.log("→ Tín hiệu pha trộn — cần thêm dữ liệu/nhiều coin hơn để kết luận.");
  }
  console.log();
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
