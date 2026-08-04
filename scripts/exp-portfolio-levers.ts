/**
 * exp-portfolio-levers.ts — Ba đòn bẩy CẤU TRÚC được đo ở cấp danh mục (không phải thêm indicator):
 *
 *   L1. MỞ RỘNG RỔ. Audit cũ loại vì "pha loãng expectancy/lệnh" — nhưng expectancy/lệnh là metric
 *       SAI cho danh mục. Câu hỏi đúng: thêm coin có nâng Sharpe (lợi nhuận trên rủi ro) không?
 *       Đo lại bằng TOÀN BỘ 14 coin tier-2 có sẵn (không chọn lọc hậu nghiệm).
 *   L2. ĐA TỐC ĐỘ. Chạy thêm sleeve breakout CHẬM hơn trên cùng rổ, chung một sổ rủi ro.
 *       Lý thuyết trend-following (Hurst/Ooi/Pedersen) khuyến nghị trộn nhiều tốc độ để bớt phụ thuộc
 *       một lookback. Đây là chống-overfit theo cấu trúc: bớt bậc tự do "chọn lookback".
 *   L3. KHUNG THỜI GIAN LỚN HƠN. Repo đã test 2h/1h/15m (đều kém). Chiều NGƯỢC LẠI (8h/12h/1d)
 *       chưa từng test, dù Turtle gốc là hệ daily.
 *
 * Mọi biến thể chấm bằng Sharpe P&L ngày (bất biến đòn bẩy) + ổn định 3 era.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-portfolio-levers.ts [l1|l2|l3|all] [days]
 */
import { Candle, TF_MS, aggregate } from "../strategy";
import { fetchKlinesPaged } from "../kline-fetch";
import { T, TurtleParams, buildBtcGateLongs } from "../turtle";
import { Book, portfolioStats, riskMetrics, runBooks } from "./portfolio-engine";
import { Policy, decayH } from "./exp-portfolio-caps";
import { BASKET } from "./portfolio-equivalence";

// Khung trung gian chỉ dùng cho thí nghiệm L3 (không đụng production).
TF_MS["8h"] = 8 * 60 * 60_000;
TF_MS["12h"] = 12 * 60 * 60_000;

const TIER2 = ["linkusdt", "trxusdt", "ltcusdt", "bchusdt", "suiusdt", "nearusdt", "uniusdt", "aptusdt",
  "atomusdt", "opusdt", "injusdt", "filusdt", "etcusdt", "bnbusdt"];

const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function load(symbols: string[], tf: string, days: number): Promise<Map<string, Candle[]>> {
  const bpd = TF_MS["1d"] / TF_MS["4h"];
  const bars4h = Math.ceil(days * bpd) + T.btcGateSlow + 200;
  const out = new Map<string, Candle[]>();
  for (const s of symbols) {
    const c4h = await fetchKlinesPaged(s, "4h", bars4h);
    const c = tf === "4h" ? c4h : aggregate(c4h, tf, "4h");
    if (c.length >= 400) out.set(s, c);
  }
  return out;
}

interface Window { from: number; to: number; eras: { name: string; from: number; to: number }[] }

function windowOf(data: Map<string, Candle[]>, p: TurtleParams, core: string[]): Window {
  const bpd = TF_MS["1d"] / TF_MS[p.tf];
  const warmup = Math.max(Math.round(p.entryDays * bpd), Math.round(p.shortEntryDays * bpd), p.trendLen, p.atrPeriod) + 1;
  let from = -Infinity, to = Infinity;
  for (const s of core) {
    const c = data.get(s);
    if (!c) continue;
    from = Math.max(from, c[Math.min(warmup, c.length - 1)].openTime);
    to = Math.min(to, c[c.length - 1].openTime);
  }
  const eras = [0, 1, 2].map((k) => ({
    name: ["A", "B", "C"][k],
    from: from + ((to - from) * k) / 3,
    to: from + ((to - from) * (k + 1)) / 3,
  }));
  return { from, to, eras };
}

function show(label: string, books: Book[], pol: Policy, w: Window) {
  const res = runBooks(books, pol.admit);
  const eq = res.equity.filter((e) => e.time >= w.from && e.time <= w.to);
  const rm = riskMetrics(eq);
  const st = portfolioStats(res, { from: w.from, to: w.to });
  const era = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
  console.log(
    label.padEnd(30) +
      String(st.n).padStart(6) +
      rm.netR.toFixed(0).padStart(8) +
      rm.sharpe.toFixed(2).padStart(8) +
      rm.netOverUlcer.toFixed(1).padStart(8) +
      rm.netOverMaxDD.toFixed(2).padStart(8) +
      st.exp.toFixed(3).padStart(8) +
      " |" +
      era.map((e) => e.sharpe.toFixed(2).padStart(7)).join(""),
  );
  return rm;
}

const HEADER = "biến thể".padEnd(30) + "unit".padStart(6) + "NET R".padStart(8) + "Sharpe".padStart(8) +
  "NET/Ulc".padStart(8) + "NET/DD".padStart(8) + "exp/u".padStart(8) + " | SharpeA      B      C";

async function l1(days: number) {
  console.log("\n" + "=".repeat(100));
  console.log("  L1 — MỞ RỘNG RỔ (chấm bằng Sharpe danh mục, không phải expectancy/lệnh)");
  console.log("=".repeat(100));
  const all = await load([...BASKET, ...TIER2], "4h", days);
  const gate = buildBtcGateLongs(all.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const p: TurtleParams = { ...T, gate };
  const w = windowOf(all, p, BASKET);
  console.log(`Cửa sổ: ${fmtD(w.from)} → ${fmtD(w.to)}  (rổ tier-2 nào chưa niêm yết thì tự vắng mặt)\n`);

  const sets: [string, string[]][] = [
    ["U8 (rổ hiện tại)", BASKET],
    ["U22 (8 + toàn bộ tier-2)", [...BASKET, ...TIER2]],
    ["U14 (tier-2 một mình)", TIER2],
  ];
  for (const pol of [{ label: "BASELINE" } as Policy, decayH(2)]) {
    console.log(`\n— chính sách risk: ${pol.label} —`);
    console.log(HEADER);
    console.log("-".repeat(100));
    for (const [name, syms] of sets) {
      const books: Book[] = syms.filter((s) => all.has(s)).map((s) => ({ key: s, symbol: s, candles: all.get(s)!, p }));
      show(name, books, pol, w);
    }
  }

  // Từng coin tier-2 chạy riêng — để thấy coin nào thực sự hợp engine (chẩn đoán, KHÔNG dùng để chọn rổ)
  console.log("\n— chẩn đoán solo từng coin tier-2 (KHÔNG dùng để cherry-pick) —");
  console.log(HEADER);
  console.log("-".repeat(100));
  for (const s of TIER2) {
    if (!all.has(s)) continue;
    show(s, [{ key: s, symbol: s, candles: all.get(s)!, p }], { label: "BASELINE" }, w);
  }
}

async function l2(days: number) {
  console.log("\n" + "=".repeat(100));
  console.log("  L2 — ĐA TỐC ĐỘ (nhiều lookback cùng một sổ rủi ro)");
  console.log("=".repeat(100));
  const data = await load(BASKET, "4h", days);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const base: TurtleParams = { ...T, gate };
  const w = windowOf(data, { ...base, entryDays: 60, shortEntryDays: 120 }, BASKET);
  console.log(`Cửa sổ: ${fmtD(w.from)} → ${fmtD(w.to)}\n`);

  const speed = (mult: number): TurtleParams => ({
    ...base,
    entryDays: Math.round(T.entryDays * mult),
    shortEntryDays: Math.round(T.shortEntryDays * mult),
  });
  const combos: [string, number[]][] = [
    ["×1 (hiện tại 15/30d)", [1]],
    ["×2 (30/60d)", [2]],
    ["×4 (60/120d)", [4]],
    ["×0.5 (8/15d)", [0.5]],
    ["ens ×1+×2", [1, 2]],
    ["ens ×1+×4", [1, 4]],
    ["ens ×0.5+×1+×2", [0.5, 1, 2]],
    ["ens ×1+×2+×4", [1, 2, 4]],
  ];
  for (const pol of [{ label: "BASELINE" } as Policy, decayH(2)]) {
    console.log(`\n— chính sách risk: ${pol.label} —`);
    console.log(HEADER);
    console.log("-".repeat(100));
    for (const [name, mults] of combos) {
      const books: Book[] = [];
      for (const m of mults)
        for (const s of BASKET)
          if (data.has(s)) books.push({ key: `${s}@${m}`, symbol: s, candles: data.get(s)!, p: speed(m) });
      show(name, books, pol, w);
    }
  }
}

async function l3(days: number) {
  console.log("\n" + "=".repeat(100));
  console.log("  L3 — KHUNG THỜI GIAN LỚN HƠN (giữ NGUYÊN cửa sổ thời gian thực của mọi tham số)");
  console.log("=".repeat(100));
  for (const pol of [{ label: "BASELINE" } as Policy, decayH(2)]) {
    console.log(`\n— chính sách risk: ${pol.label} —`);
    console.log(HEADER);
    console.log("-".repeat(100));
    for (const tf of ["4h", "8h", "12h", "1d"]) {
      const data = await load(BASKET, tf, days);
      const bpd = TF_MS["1d"] / TF_MS[tf];
      const scale = (barsAt4h: number) => Math.max(2, Math.round((barsAt4h / 6) * bpd));
      const btc4h = await fetchKlinesPaged("btcusdt", "4h", Math.ceil(days * 6) + T.btcGateSlow + 200);
      const btc = tf === "4h" ? btc4h : aggregate(btc4h, tf, "4h");
      const p: TurtleParams = {
        ...T,
        tf,
        trendLen: scale(T.trendLen),
        atrPeriod: scale(T.atrPeriod),
        btcGateFast: scale(T.btcGateFast),
        btcGateSlow: scale(T.btcGateSlow),
        gate: buildBtcGateLongs(btc, scale(T.btcGateFast), scale(T.btcGateSlow)),
      };
      const w = windowOf(data, p, BASKET);
      const books: Book[] = BASKET.filter((s) => data.has(s)).map((s) => ({ key: s, symbol: s, candles: data.get(s)!, p }));
      show(`${tf} (EMA${p.trendLen}/ATR${p.atrPeriod})`, books, pol, w);
    }
  }
}

async function main() {
  const which = (process.argv[2] ?? "all").toLowerCase();
  const days = parseInt(process.argv[3] ?? "2000", 10);
  if (which === "l1" || which === "all") await l1(days);
  if (which === "l2" || which === "all") await l2(days);
  if (which === "l3" || which === "all") await l3(days);
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
