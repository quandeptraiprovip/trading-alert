/**
 * symbol-correlation.ts — Đo tính ĐỘC LẬP của breadth (Fundamental Law: IR=IC·√breadth).
 *
 * Ý tưởng: tăng số lệnh TỐT = thêm symbol có cược độc lập, KHÔNG nới filter.
 * Lợi ích √breadth chỉ thật khi các symbol ít tương quan. Script này:
 *   1. Tải nến cho danh sách symbol, gộp lên return NGÀY (robust hơn corr P&L lệnh thưa).
 *   2. Tính ma trận tương quan Pearson của return ngày.
 *   3. Chạy backtest từng symbol (CONFIG hiện tại) -> NET R + số lệnh độc lập.
 *   4. Đề xuất rổ NET dương + tương quan thấp, kèm "breadth hiệu dụng" N_eff.
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/symbol-correlation.ts [soNgay] [sym1,sym2,...]
 */
import { CONFIG, TF_MS, aggregate, Candle } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";

const DAYS = parseInt(process.argv[2] ?? "250", 10);
const SYMBOLS = (process.argv[3]
  ? process.argv[3].split(",")
  : ["btcusdt", "ethusdt", "solusdt", "bnbusdt", "xrpusdt", "dogeusdt", "avaxusdt", "linkusdt"]
).map((s) => s.trim().toLowerCase());

/** Return ngày theo openTime: Map<openTimeNgày, ret>. */
function dailyReturns(ltf: Candle[]): Map<number, number> {
  const daily = aggregate(ltf, "1d", CONFIG.entryTf);
  const out = new Map<number, number>();
  for (let i = 1; i < daily.length; i++) {
    const prev = daily[i - 1].close;
    if (prev > 0) out.set(daily[i].openTime, daily[i].close / prev - 1);
  }
  return out;
}

/** Pearson trên các openTime ngày CHUNG của 2 chuỗi. */
function pearson(a: Map<number, number>, b: Map<number, number>): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [t, va] of a) {
    const vb = b.get(t);
    if (vb !== undefined) {
      xs.push(va);
      ys.push(vb);
    }
  }
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return NaN;
  return cov / Math.sqrt(vx * vy);
}

/** Tương quan trung bình giữa các thành viên rổ (chỉ cặp i<j). */
function avgPairCorr(syms: string[], corr: Map<string, number>): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      const r = corr.get(`${syms[i]}|${syms[j]}`);
      if (r !== undefined && Number.isFinite(r)) {
        sum += r;
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}

async function main() {
  const barsPerDay = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const totalBars = Math.ceil(DAYS * barsPerDay) + 400;

  console.log("=".repeat(74));
  console.log(`  BREADTH ĐỘC LẬP — ${DAYS} ngày — corr return NGÀY + NET R từng symbol`);
  console.log(`  delta=${CONFIG.deltaBuyMin} | maxMitig=${CONFIG.maxZoneMitigations} | trail@${CONFIG.trailStartR}R`);
  console.log("=".repeat(74));

  const rets = new Map<string, Map<number, number>>();
  const net = new Map<string, number>();
  const ntrades = new Map<string, number>();
  const loaded: string[] = [];

  for (const sym of SYMBOLS) {
    console.log(`\nTải ${sym.toUpperCase()}…`);
    const ltf = await fetchKlinesPaged(sym, CONFIG.entryTf, totalBars);
    if (ltf.length < 500) {
      console.log(`  ⚠️  Không đủ nến (${ltf.length}), bỏ qua.`);
      continue;
    }
    rets.set(sym, dailyReturns(ltf));
    const trades = runBacktest(sym, ltf);
    net.set(sym, trades.reduce((s, t) => s + t.netR, 0));
    ntrades.set(sym, trades.length);
    loaded.push(sym);
    console.log(`  ${sym.toUpperCase().padEnd(8)} : ${trades.length} lệnh | NET ${net.get(sym)! >= 0 ? "+" : ""}${net.get(sym)!.toFixed(2)}R`);
  }

  // Ma trận tương quan
  const corr = new Map<string, number>();
  for (let i = 0; i < loaded.length; i++) {
    for (let j = i + 1; j < loaded.length; j++) {
      const r = pearson(rets.get(loaded[i])!, rets.get(loaded[j])!);
      corr.set(`${loaded[i]}|${loaded[j]}`, r);
      corr.set(`${loaded[j]}|${loaded[i]}`, r);
    }
  }

  console.log("\n" + "─".repeat(74));
  console.log("MA TRẬN TƯƠNG QUAN (return ngày, Pearson):\n");
  const head = "        " + loaded.map((s) => s.replace("usdt", "").toUpperCase().padStart(6)).join("");
  console.log(head);
  for (let i = 0; i < loaded.length; i++) {
    let row = loaded[i].replace("usdt", "").toUpperCase().padEnd(8);
    for (let j = 0; j < loaded.length; j++) {
      if (i === j) row += "  1.00";
      else {
        const r = corr.get(`${loaded[i]}|${loaded[j]}`);
        row += (r === undefined || !Number.isFinite(r) ? "   —" : r.toFixed(2)).padStart(6);
      }
    }
    console.log(row);
  }

  // Tương quan trung bình tới BTC + tới phần còn lại
  console.log("\n" + "─".repeat(74));
  console.log("ĐỘC LẬP TƯƠNG ĐỐI (corr thấp = bet độc lập hơn = breadth thật hơn):\n");
  console.log("Symbol   | NET R     | Lệnh | corr→BTC | corr TB→rổ còn lại");
  const btc = "btcusdt";
  const stats = loaded.map((s) => {
    let sum = 0;
    let cnt = 0;
    for (const o of loaded) {
      if (o === s) continue;
      const r = corr.get(`${s}|${o}`);
      if (r !== undefined && Number.isFinite(r)) { sum += r; cnt++; }
    }
    const avgOther = cnt ? sum / cnt : 0;
    const cb = s === btc ? 1 : corr.get(`${s}|${btc}`) ?? NaN;
    return { s, net: net.get(s)!, n: ntrades.get(s)!, cb, avgOther };
  });
  for (const r of stats) {
    console.log(
      `${r.s.toUpperCase().padEnd(8)} | ${(r.net >= 0 ? "+" : "") + r.net.toFixed(2).padStart(6)}R | ${String(r.n).padStart(4)} | ${(Number.isFinite(r.cb) ? r.cb.toFixed(2) : "—").padStart(8)} | ${r.avgOther.toFixed(2).padStart(6)}`,
    );
  }

  // Đề xuất rổ: NET dương, ưu tiên corr→BTC thấp
  console.log("\n" + "─".repeat(74));
  console.log("ĐỀ XUẤT RỔ (NET dương, xếp theo corr→BTC tăng dần):\n");
  const basket = stats
    .filter((r) => r.net > 0)
    .sort((a, b) => (Number.isFinite(a.cb) ? a.cb : 9) - (Number.isFinite(b.cb) ? b.cb : 9));

  const basketSyms = basket.map((r) => r.s);
  const basketNet = basket.reduce((s, r) => s + r.net, 0);
  const basketN = basket.reduce((s, r) => s + r.n, 0);
  const rho = avgPairCorr(basketSyms, corr);
  const N = basketSyms.length;
  const nEff = N / (1 + (N - 1) * Math.max(0, rho)); // breadth hiệu dụng (heuristic avg-corr)

  for (const r of basket) {
    console.log(`  ${r.s.toUpperCase().padEnd(8)} corr→BTC ${(Number.isFinite(r.cb) ? r.cb.toFixed(2) : "—").padStart(5)} | NET +${r.net.toFixed(2)}R | ${r.n} lệnh`);
  }
  console.log(
    `\n  Rổ NET dương: ${basketSyms.map((s) => s.replace("usdt", "").toUpperCase()).join("+")}` +
      `\n  Tổng lệnh   : ${basketN}  (vs BTC-only ${ntrades.get(btc) ?? 0})` +
      `\n  Tổng NET R  : +${basketNet.toFixed(2)}R (cộng R, không compounding chéo)` +
      `\n  Corr TB rổ  : ${rho.toFixed(2)}` +
      `\n  Breadth     : ${N} symbol → N_eff ≈ ${nEff.toFixed(2)} bet độc lập` +
      `\n                (corr cao → N_eff << N → lợi ích √breadth bị chiết khấu)`,
  );

  console.log(
    `\n⚠️  Đây là corr giá (proxy độc lập), chưa phải corr P&L lệnh. Symbol corr→BTC thấp` +
      `\n   nhất + NET dương là ứng viên forward-test tiếp theo.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
