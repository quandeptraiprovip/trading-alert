/**
 * exp-min-notional.ts — SÀN TỐI THIỂU CỦA SÀN GIAO DỊCH có đang loại symbol ở equity thật không?
 *
 * Nền: `/health` 12/08/2026 cho equity Turtle/Binance $192,68 và Fast/MEXC $320,43. Ở cỡ vốn đó,
 * notional dự định mỗi unit chỉ ~$11-20, tức sát hoặc dưới sàn `minNotional` của sàn. `live-trade.ts`
 * (dòng 180-192) khi đó NÂNG qty lên sàn rồi **từ chối lệnh** nếu risk hiệu dụng vượt ngân sách
 * `pyramidMaxUnits × riskPct`. Nghĩa là có thể cả một symbol đang bị loại im lặng — và nếu đó là BTC
 * thì nó là chỗ rò lớn hơn mọi cải tiến tìm được trong ba vòng nghiên cứu.
 *
 * Script này CHỈ ĐỌC endpoint CÔNG KHAI (không API key, không đặt/hủy lệnh gì):
 *   Binance  GET https://fapi.binance.com/fapi/v1/exchangeInfo   → LOT_SIZE, MIN_NOTIONAL
 *   MEXC     GET https://contract.mexc.com/api/v1/contract/detail → contractSize, minVol, volUnit
 * Giá và ATR(20) lấy từ cache nến 4h đã có (không gọi thêm).
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-min-notional.ts [equityBinance] [equityMexc]
 */
import { T, atrSeries } from "../turtle";
import { CORE8, loadPool } from "./exp-breadth";

const TURTLE_RISK_PCT = 0.005; // .env TURTLE_RISK_PCT=0.5
const FAST_RISK_PCT = 0.005; // .env FAST_TREND_RISK_PCT=0.5
const MAX_UNITS = 3; // T.pyramidMaxUnits — cũng là ngân sách risk: MAX_UNITS × riskPct

type BinFilter = { minQty: number; stepSize: number; minNotional: number };
type MexcFilter = { contractSize: number; minVol: number; volUnit: number };

async function binanceFilters(): Promise<Map<string, BinFilter>> {
  const r = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo");
  if (!r.ok) throw new Error(`Binance exchangeInfo HTTP ${r.status}`);
  const j: any = await r.json();
  const out = new Map<string, BinFilter>();
  for (const s of j.symbols ?? []) {
    const lot = (s.filters ?? []).find((f: any) => f.filterType === "LOT_SIZE");
    const notional = (s.filters ?? []).find((f: any) => f.filterType === "MIN_NOTIONAL");
    if (!lot) continue;
    out.set(String(s.symbol).toLowerCase(), {
      minQty: parseFloat(lot.minQty),
      stepSize: parseFloat(lot.stepSize),
      minNotional: parseFloat(notional?.notional ?? notional?.minNotional ?? "0"),
    });
  }
  return out;
}

async function mexcFilters(): Promise<Map<string, MexcFilter>> {
  const r = await fetch("https://contract.mexc.com/api/v1/contract/detail");
  if (!r.ok) throw new Error(`MEXC contract/detail HTTP ${r.status}`);
  const j: any = await r.json();
  const out = new Map<string, MexcFilter>();
  for (const c of j.data ?? []) {
    // "BTC_USDT" → "btcusdt"
    const key = String(c.symbol).replace("_", "").toLowerCase();
    out.set(key, {
      contractSize: parseFloat(c.contractSize),
      minVol: parseFloat(c.minVol),
      volUnit: parseFloat(c.volUnit ?? "1"),
    });
  }
  return out;
}

/** Thang tỉ trọng của unit thứ n (0-based) trong CÙNG một vị thế, heat chỉ từ vị thế đó. */
function ladder(k: number, n: number): number[] {
  let heat = 0;
  const ws: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = k > 0 ? 1 / (1 + heat / k) : 1;
    ws.push(w);
    heat += w;
  }
  return ws;
}

async function main() {
  const eqBin = parseFloat(process.argv[2] ?? "192.68");
  const eqMexc = parseFloat(process.argv[3] ?? "320.43");

  const data = await loadPool(1200, CORE8);
  const [bf, mf] = await Promise.all([binanceFilters(), mexcFilters()]);

  // giá + ATR20 hiện tại từ nến 4h cuối trong cache
  const mkt = new Map<string, { price: number; atr: number; date: string }>();
  for (const [sym, c] of data) {
    const a = atrSeries(c, T.atrPeriod);
    const i = c.length - 1;
    mkt.set(sym, { price: c[i].close, atr: a[i], date: new Date(c[i].openTime).toISOString().slice(0, 10) });
  }
  const anyDate = [...mkt.values()][0]?.date ?? "?";
  console.log(`Giá & ATR20 từ nến 4h cuối trong cache (${anyDate}). Chỉ đọc endpoint công khai.\n`);

  // ── BINANCE / TURTLE ──────────────────────────────────────────────────────
  console.log("=".repeat(128));
  console.log(`  TURTLE @ BINANCE — equity $${eqBin.toFixed(2)} · risk ${(TURTLE_RISK_PCT * 100).toFixed(2)}%/unit · ngân sách vị thế ${(MAX_UNITS * TURTLE_RISK_PCT * 100).toFixed(1)}% ($${(eqBin * MAX_UNITS * TURTLE_RISK_PCT).toFixed(2)})`);
  console.log("=".repeat(128));
  console.log("symbol".padEnd(10) + "giá".padStart(11) + "ATR%".padStart(7) + "stop%".padStart(7) +
    "minNotional".padStart(12) + "notional dự định".padStart(17) + "risk hiệu dụng".padStart(16) + "  kết quả");
  console.log("-".repeat(128));
  const failBin: string[] = [];
  for (const sym of CORE8) {
    const m = mkt.get(sym), f = bf.get(sym);
    if (!m || !f) { console.log(`${sym.toUpperCase().padEnd(10)}  thiếu dữ liệu (cache ${!!m} · filter ${!!f})`); continue; }
    const stopFrac = (T.chandelierMult * m.atr) / m.price;
    const riskUsd = eqBin * TURTLE_RISK_PCT;
    const wantNotional = riskUsd / stopFrac;
    const needNotional = f.minNotional * 1.01; // đệm +1% như live-trade.ts
    const floored = wantNotional < needNotional;
    const effNotional = floored ? needNotional : wantNotional;
    const effRisk = (effNotional * stopFrac) / eqBin;
    const budget = MAX_UNITS * TURTLE_RISK_PCT;
    const ok = effRisk <= budget + 1e-9;
    if (!ok) failBin.push(sym.toUpperCase());
    console.log(
      sym.toUpperCase().padEnd(10) + m.price.toFixed(m.price < 1 ? 5 : 2).padStart(11) +
        `${((m.atr / m.price) * 100).toFixed(2)}%`.padStart(7) + `${(stopFrac * 100).toFixed(1)}%`.padStart(7) +
        `$${f.minNotional.toFixed(0)}`.padStart(12) + `$${wantNotional.toFixed(2)}`.padStart(17) +
        `${(effRisk * 100).toFixed(2)}%`.padStart(16) +
        `  ${ok ? (floored ? `⚠️ nâng sàn ×${(effNotional / wantNotional).toFixed(1)} — VÀO ĐƯỢC nhưng quá size` : "✅ size đúng") : "❌ BỊ TỪ CHỐI (vượt ngân sách)"}`,
    );
  }
  console.log("-".repeat(128));
  console.log(failBin.length ? `❌ BỊ LOẠI khỏi rổ ở equity này: ${failBin.join(", ")}` : "✅ không symbol nào bị loại");

  // ── MEXC / FAST ───────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(128));
  console.log(`  FAST @ MEXC — equity $${eqMexc.toFixed(2)} · risk ${(FAST_RISK_PCT * 100).toFixed(2)}%/unit · ngân sách vị thế ${(MAX_UNITS * FAST_RISK_PCT * 100).toFixed(1)}% ($${(eqMexc * MAX_UNITS * FAST_RISK_PCT).toFixed(2)})`);
  console.log("=".repeat(128));
  console.log("symbol".padEnd(10) + "contractSize".padStart(14) + "minVol".padStart(8) +
    "min notional".padStart(14) + "notional dự định".padStart(17) + "risk hiệu dụng".padStart(16) + "  kết quả");
  console.log("-".repeat(128));
  const failMexc: string[] = [];
  for (const sym of CORE8) {
    const m = mkt.get(sym), f = mf.get(sym);
    if (!m || !f) { console.log(`${sym.toUpperCase().padEnd(10)}  thiếu dữ liệu (cache ${!!m} · filter ${!!f})`); continue; }
    const stopFrac = (T.chandelierMult * m.atr) / m.price;
    const riskUsd = eqMexc * FAST_RISK_PCT;
    const wantNotional = riskUsd / stopFrac;
    const minNotional = f.minVol * f.contractSize * m.price;
    const floored = wantNotional < minNotional;
    const effNotional = floored ? minNotional : wantNotional;
    const effRisk = (effNotional * stopFrac) / eqMexc;
    const ok = effRisk <= MAX_UNITS * FAST_RISK_PCT + 1e-9;
    if (!ok) failMexc.push(sym.toUpperCase());
    console.log(
      sym.toUpperCase().padEnd(10) + String(f.contractSize).padStart(14) + String(f.minVol).padStart(8) +
        `$${minNotional.toFixed(2)}`.padStart(14) + `$${wantNotional.toFixed(2)}`.padStart(17) +
        `${(effRisk * 100).toFixed(2)}%`.padStart(16) +
        `  ${ok ? (floored ? `⚠️ nâng sàn ×${(effNotional / wantNotional).toFixed(1)}` : "✅ size đúng") : "❌ vượt ngân sách"}`,
    );
  }
  console.log("-".repeat(128));
  console.log(failMexc.length ? `❌ vượt ngân sách ở equity này: ${failMexc.join(", ")}` : "✅ không symbol nào vượt ngân sách");

  // ── NGƯỠNG VỐN ────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(128));
  console.log("  VỐN TỐI THIỂU để size ĐÚNG (không bị nâng sàn) — chính sách hiện tại vs chính sách siết k");
  console.log("=".repeat(128));
  const lad4 = ladder(4, MAX_UNITS);
  const lad05 = ladder(0.5, MAX_UNITS);
  const W_CROWDED = 0.17; // tỉ trọng điển hình của unit thêm khi rổ đã đông cùng hướng, k=0,5
  console.log(`Thang size trong 1 vị thế: k=4 → ${lad4.map((x) => x.toFixed(2)).join(" / ")}` +
    `  ·  k=0,5 → ${lad05.map((x) => x.toFixed(2)).join(" / ")}  ·  rổ đông (k=0,5) ≈ ${W_CROWDED}`);
  console.log("\n" + "symbol".padEnd(10) + "sàn (Binance)".padStart(15) +
    "k=4 unit3".padStart(13) + "k=0,5 unit3".padStart(14) + "k=0,5 rổ đông".padStart(16) + "   (risk/unit 1,05%)");
  console.log("-".repeat(128));
  for (const sym of CORE8) {
    const m = mkt.get(sym), f = bf.get(sym);
    if (!m || !f) continue;
    const stopFrac = (T.chandelierMult * m.atr) / m.price;
    // E sao cho riskPct × w × E / stopFrac ≥ minNotional×1,01
    const need = (w: number, rp: number) => (f.minNotional * 1.01 * stopFrac) / (rp * w);
    console.log(
      sym.toUpperCase().padEnd(10) + `$${f.minNotional.toFixed(0)}`.padStart(15) +
        `$${need(lad4[MAX_UNITS - 1], TURTLE_RISK_PCT).toFixed(0)}`.padStart(13) +
        `$${need(lad05[MAX_UNITS - 1], 0.0105).toFixed(0)}`.padStart(14) +
        `$${need(W_CROWDED, 0.0105).toFixed(0)}`.padStart(16),
    );
  }
  console.log("-".repeat(128));
  console.log("Cột = equity cần trong SỔ ĐÓ để unit tương ứng có notional tự nhiên vượt sàn, không phải nâng.");
}

if (require.main === module && /exp-min-notional\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error("Lỗi:", e?.message ?? e);
    process.exit(1);
  });
}
