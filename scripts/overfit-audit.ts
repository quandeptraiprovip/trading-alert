/**
 * overfit-audit.ts — Kiểm định overfit của baseline pipeline
 *
 *   1. OOS THỜI GIAN : chia lịch sử dài thành nửa CŨ vs nửa MỚI (rổ mặc định).
 *   2. OOS SYMBOL    : chạy baseline trên coin NGOÀI rổ (gồm coin từng bị loại).
 *   3. ĐỘ NHẠY THAM SỐ: nhiễu ± các knob đã tune, xem NET có ổn định không.
 *
 * Dùng RAW NET R (độc lập với sizing) để soi thuần edge của entry logic.
 * Run: npx ts-node scripts/overfit-audit.ts [days=250] [longDays=500]
 */
import { Candle, CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest, Trade } from "../backtest";

const net = (ts: Trade[]) => ts.reduce((s, t) => s + t.netR, 0);
const wr = (ts: Trade[]) => (ts.length ? (ts.filter((t) => t.netR > 0).length / ts.length) * 100 : 0);

async function fetchAll(syms: string[], days: number): Promise<Map<string, Candle[]>> {
  const bars = Math.ceil((days * TF_MS["1d"]) / TF_MS[CONFIG.entryTf]) + 400;
  const m = new Map<string, Candle[]>();
  for (const s of syms) {
    const ltf = await fetchKlinesPaged(s, CONFIG.entryTf, bars);
    if (ltf.length >= 500) m.set(s, ltf);
  }
  return m;
}

function fmt(n: number) { return (n >= 0 ? "+" : "") + n.toFixed(1) + "R"; }

async function main() {
  const days = parseInt(process.argv[2] ?? "250", 10);
  const longDays = parseInt(process.argv[3] ?? "500", 10);
  const basket = CONFIG.symbols;
  const unseen = ["ethusdt", "bnbusdt", "adausdt", "avaxusdt", "linkusdt", "ltcusdt", "trxusdt", "dotusdt"];

  console.log(`Tải rổ (${longDays}d) + coin ngoài rổ (${days}d)...\n`);
  const basketLong = await fetchAll(basket, longDays);
  const unseenData = await fetchAll(unseen, days);
  console.log();

  // ── 1. OOS THỜI GIAN ──
  console.log("=".repeat(72));
  console.log(`1) OOS THỜI GIAN — rổ ${basket.map((s) => s.toUpperCase()).join("+")}, lịch sử ~${longDays}d`);
  console.log("=".repeat(72));
  let oldT: Trade[] = [], newT: Trade[] = [];
  for (const [sym, ltf] of basketLong) {
    const mid = Math.floor(ltf.length / 2);
    const older = ltf.slice(0, mid);
    const newer = ltf.slice(Math.max(0, mid - 400)); // chừa warmup HTF
    oldT = oldT.concat(runBacktest(sym, older));
    newT = newT.concat(runBacktest(sym, newer));
  }
  console.log(`Nửa CŨ  : ${String(oldT.length).padStart(3)} lệnh | WR ${wr(oldT).toFixed(0)}% | NET ${fmt(net(oldT))}`);
  console.log(`Nửa MỚI : ${String(newT.length).padStart(3)} lệnh | WR ${wr(newT).toFixed(0)}% | NET ${fmt(net(newT))}`);
  console.log(`→ Edge ${net(oldT) > 0 && net(newT) > 0 ? "DƯƠNG ở CẢ HAI nửa ✅" : "KHÔNG ổn định giữa 2 nửa ⚠️"}`);

  // ── 2. OOS SYMBOL ──
  console.log("\n" + "=".repeat(72));
  console.log(`2) OOS SYMBOL — coin NGOÀI rổ (${days}d). Rổ được chọn in-sample → đây là test thật`);
  console.log("=".repeat(72));
  let allUnseen: Trade[] = [];
  for (const [sym, ltf] of unseenData) {
    const ts = runBacktest(sym, ltf);
    allUnseen = allUnseen.concat(ts);
    console.log(`  ${sym.toUpperCase().padEnd(9)} : ${String(ts.length).padStart(3)} lệnh | WR ${wr(ts).toFixed(0).padStart(3)}% | NET ${fmt(net(ts))}`);
  }
  console.log("-".repeat(72));
  const perTrade = allUnseen.length ? net(allUnseen) / allUnseen.length : 0;
  const negCoins = [...unseenData.keys()].filter((s) => net(runBacktest(s, unseenData.get(s)!)) < 0).length;
  console.log(`  TỔNG ngoài rổ : ${allUnseen.length} lệnh | WR ${wr(allUnseen).toFixed(0)}% | NET ${fmt(net(allUnseen))} | TB ${perTrade.toFixed(3)}R/lệnh`);
  // Generalize THẬT = per-trade đáng kể (>0.2R) VÀ phần lớn coin dương. ~0R / đa số âm = KHÔNG generalize.
  const generalizes = perTrade > 0.2 && negCoins <= unseenData.size / 2;
  console.log(`→ ${generalizes ? "Edge GENERALIZE ✅" : `KHÔNG generalize ⚠️ — per-trade ≈ ${perTrade.toFixed(3)}R, ${negCoins}/${unseenData.size} coin ÂM (nghi cherry-pick rổ in-sample)`}`);

  // ── 3. ĐỘ NHẠY THAM SỐ (trên nửa MỚI của rổ) ──
  console.log("\n" + "=".repeat(72));
  console.log("3) ĐỘ NHẠY THAM SỐ — nhiễu ± quanh giá trị baseline (NET rổ, nửa MỚI)");
  console.log("=".repeat(72));
  const newerData = new Map<string, Candle[]>();
  for (const [sym, ltf] of basketLong) newerData.set(sym, ltf.slice(Math.max(0, Math.floor(ltf.length / 2) - 400)));
  const runNet = () => { let t: Trade[] = []; for (const [s, l] of newerData) t = t.concat(runBacktest(s, l)); return net(t); };

  const baseNet = runNet();
  console.log(`Baseline (nửa MỚI) NET = ${fmt(baseNet)}\n`);
  console.log(`${"tham số".padEnd(20)} ${"thấp".padStart(14)} ${"BASE".padStart(10)} ${"cao".padStart(14)}`);
  console.log("-".repeat(72));

  type Knob = { name: string; key: keyof typeof CONFIG; lo: number; hi: number };
  const knobs: Knob[] = [
    { name: "volSpikeMult", key: "volSpikeMult", lo: 1.7, hi: 2.5 },
    { name: "ltfConfirmVolMult", key: "ltfConfirmVolMult", lo: 1.1, hi: 1.5 },
    { name: "deltaBuyMin", key: "deltaBuyMin", lo: 0.52, hi: 0.60 },
    { name: "trailStartR", key: "trailStartR", lo: 1.5, hi: 2.5 },
    { name: "cooldownBars", key: "cooldownBars", lo: 24, hi: 72 },
    { name: "maxZoneMitigations", key: "maxZoneMitigations", lo: 0, hi: 2 },
    { name: "pivotLeft", key: "pivotLeft", lo: 2, hi: 4 },
    { name: "pivotRight", key: "pivotRight", lo: 2, hi: 4 },
    { name: "setupExpiryBars", key: "setupExpiryBars", lo: 16, hi: 32 },
    { name: "minBarsAfterArm", key: "minBarsAfterArm", lo: 2, hi: 5 },
  ];
  let flips = 0;
  for (const k of knobs) {
    const orig = (CONFIG as any)[k.key];
    (CONFIG as any)[k.key] = k.lo; const lo = runNet();
    (CONFIG as any)[k.key] = k.hi; const hi = runNet();
    (CONFIG as any)[k.key] = orig;
    const bad = lo < 0 || hi < 0 || lo < baseNet * 0.4 || hi < baseNet * 0.4;
    if (lo < 0 || hi < 0) flips++;
    console.log(`${k.name.padEnd(20)} ${(String(k.lo) + ": " + fmt(lo)).padStart(14)} ${fmt(baseNet).padStart(10)} ${(String(k.hi) + ": " + fmt(hi)).padStart(14)}${bad ? "  ⚠️" : ""}`);
  }
  console.log("-".repeat(72));
  console.log(`→ ${flips === 0 ? "Không knob nào làm NET âm khi nhiễu ✅" : `${flips} knob khiến NET ÂM khi nhiễu ⚠️ (fragile)`}`);
  console.log(`\nGhi chú: ${46} lệnh để fit ~10+ tham số ⇒ tỉ lệ quan sát/bậc-tự-do thấp; đọc kết quả thận trọng.`);
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
