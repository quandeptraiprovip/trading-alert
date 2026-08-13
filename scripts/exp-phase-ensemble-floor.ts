/**
 * exp-phase-ensemble-floor.ts — ENSEMBLE 4 PHA NẾN có sống nổi sàn minNotional ở vốn thật không?
 *
 * VÌ SAO ĐÂY LÀ ỨNG VIÊN "KHÔNG THỂ OVERFIT": ensemble pha không thêm MỘT tham số nào, không CHỌN
 * gì cả — nó chỉ trung bình hoá một quy ước tuỳ tiện (lưới nến 4h căn 00:00 UTC). Kỳ vọng giữ
 * nguyên, phương sai giảm. Đây là họ cải tiến duy nhất mà câu hỏi "có overfit không" không áp dụng
 * được, vì không có bậc tự do nào để fit.
 *
 * `exp-bar-phase.ts` đã đo P2 và cho con số then chốt:
 *   - so PHA 0h ĐANG CHẠY: vốn 17,89× → 12,72× (−29%)   ← pha 0h là pha MAY nhất trong 4
 *   - so PHA TRUNG BÌNH:   vốn 12,06× → 12,72× (+5%)    ← kỳ vọng trung thực nếu mốc nến là ngẫu nhiên
 * Tức ưu thế của cấu hình hiện tại phần lớn là MAY MẮN CHỌN MỐC NẾN, và ensemble biến may mắn đó
 * thành một phần lợi nhỏ hơn nhưng THẬT.
 *
 * NHƯNG `exp-bar-phase.ts` giả định size chính xác. Ensemble chia risk làm 4 ⇒ mỗi unit nhỏ đi 4 lần
 * ⇒ đâm thẳng vào sàn minNotional. Ở $193 với 0,5%/4 = 0,125%/unit thì phần lớn lệnh có thể không
 * đặt được. File này là phép kiểm quyết định: **phần +5% có sống sót ở vốn thật không?**
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-phase-ensemble-floor.ts [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import {
  AdmitCtx, AdmitFn, Book, EquityPoint, ExtParams, compoundedEquity, runBooks,
} from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8 } from "./exp-breadth";
import { fetchFuturesKlinesPaged } from "../kline-fetch";

const H = TF_MS["1h"];

/** Gộp 1h → 4h lệch pha `offsetH`. Chỉ giữ nhóm ĐỦ 4 nến (không đoán phần thiếu). */
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
      openTime: k * TF_MS["4h"] + offsetH * H,
      open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)),
      close: g[3].close, volume: g.reduce((s, x) => s + x.volume, 0),
      quoteVolume: g.reduce((s, x) => s + x.quoteVolume, 0),
      takerBuyVolume: g.reduce((s, x) => s + x.takerBuyVolume, 0),
    });
  }
  return out;
}

async function minNotionals(): Promise<Map<string, number>> {
  const r = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo");
  if (!r.ok) throw new Error(`Binance exchangeInfo HTTP ${r.status}`);
  const j: any = await r.json();
  const out = new Map<string, number>();
  for (const s of j.symbols ?? []) {
    const n = (s.filters ?? []).find((f: any) => f.filterType === "MIN_NOTIONAL");
    out.set(String(s.symbol).toLowerCase(), parseFloat(n?.notional ?? n?.minNotional ?? "0"));
  }
  return out;
}

/** Luật sàn ĐÚNG như live. `riskPct` ở đây là risk MỖI PHA (đã chia cho số pha). */
function admitLiveRule(k: number, equity: number, riskPct: number, floors: Map<string, number> | null): AdmitFn {
  return (c: AdmitCtx) => {
    const w = k > 0 ? 1 / (1 + c.sameDirHeat / k) : 1;
    if (!floors || c.entryPrice == null || c.initialSL == null) return w;
    const stopFrac = Math.abs(c.entryPrice - c.initialSL) / c.entryPrice;
    const floor = floors.get(c.symbol.toLowerCase()) ?? 0;
    if (!(stopFrac > 0) || floor <= 0) return w;
    const notional = (equity * riskPct * w) / stopFrac;
    if (notional >= floor) return w;
    const lifted = w * (floor / notional);
    const used = c.open.filter((u) => u.symbol.toLowerCase() === c.symbol.toLowerCase())
      .reduce((s, u) => s + u.weight, 0);
    return lifted <= T.pyramidMaxUnits - used ? lifted : 0;
  };
}

/** Cộng nhiều chuỗi equity (mỗi pha) thành một chuỗi danh mục theo mốc thời gian. */
function mergeEquity(series: EquityPoint[][]): EquityPoint[] {
  const times = [...new Set(series.flat().map((e) => e.time))].sort((a, b) => a - b);
  const idx = series.map(() => 0);
  const last = series.map(() => 0);
  const out: EquityPoint[] = [];
  for (const t of times) {
    let sum = 0;
    for (let s = 0; s < series.length; s++) {
      while (idx[s] < series[s].length && series[s][idx[s]].time <= t) last[s] = series[s][idx[s]++].mtm;
      sum += last[s];
    }
    out.push({ time: t, realized: 0, mtm: sum, openUnits: 0, longUnits: 0, shortUnits: 0 });
  }
  return out;
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const floors = await minNotionals();
  const h1 = new Map<string, Candle[]>();
  for (const s of CORE8) {
    const c = await fetchFuturesKlinesPaged(s, "1h", days * 24 + 3000);
    if (c.length > 5000) h1.set(s, c);
  }
  const PHASES = [0, 1, 2, 3];
  const phaseData = new Map<number, Map<string, Candle[]>>();
  for (const ph of PHASES) {
    const m = new Map<string, Candle[]>();
    for (const [s, c] of h1) m.set(s, aggregatePhase(c, ph));
    phaseData.set(ph, m);
  }
  const p0 = phaseData.get(0)!;
  const from = Math.max(...[...p0.values()].map((c) => c[0].openTime)) + T.btcGateSlow * TF_MS["4h"];
  const to = Math.min(...[...p0.values()].map((c) => c[c.length - 1].openTime));
  const years = (to - from) / (365.25 * 86400e3);
  console.log(`Cửa sổ ${new Date(from).toISOString().slice(0, 10)} → ${new Date(to).toISOString().slice(0, 10)} (${years.toFixed(1)} năm) · ${h1.size} coin\n`);

  const snap: Partial<ExtParams> = { admitBarSnapshot: true };

  /** Chạy một pha, trả chuỗi equity trong cửa sổ chung. */
  function runPhase(ph: number, k: number, equity: number, riskPerPhase: number, floorsOrNull: Map<string, number> | null) {
    const d = phaseData.get(ph)!;
    const gate = buildBtcGateLongs(d.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
    const { turtle } = liveSleeves(gate);
    const books: Book[] = [...d.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p: { ...turtle, ...snap } }));
    return runBooks(books, admitLiveRule(k, equity, riskPerPhase, floorsOrNull)).equity.filter((e) => e.time >= from && e.time <= to);
  }

  const RISKS = [0.005, 0.01, 0.02];
  for (const [cfgName, k, equity] of [["k=4 · $193", 4, 192.68], ["k=0,5 · $513", 0.5, 513]] as [string, number, number][]) {
    console.log(`═══ ${cfgName} ═══`);
    console.log("risk TỔNG".padEnd(12) + "biến thể".padEnd(28) + "vốn ×".padStart(9) + "CAGR".padStart(8) + "sụt".padStart(8) + "CAGR/sụt".padStart(10));
    for (const rp of RISKS) {
      const cagrOf = (eq: EquityPoint[], scale: number) => {
        const { mult, maxDD } = compoundedEquity(eq, scale);
        return { cagr: mult > 0 ? (Math.pow(mult, 1 / years) - 1) * 100 : -100, maxDD, mult };
      };
      // HAI LỖI ĐÃ SỬA ở bản trước:
      //  (1) "trung bình 4 pha" bị dựng bằng cách GỘP equity 4 pha chạy full risk — đó là một DANH
      //      MỤC (đã đa dạng hoá), không phải kỳ vọng của việc rút ngẫu nhiên MỘT pha. Đúng phải là
      //      trung bình CAGR của bốn lần chạy RIÊNG.
      //  (2) Ensemble ¼ risk bị sàn NÂNG gần như mọi unit lên mức tối thiểu, nên risk thật vọt lên
      //      xa ¼ — bảng cũ ra 101.015× là hiện vật của việc đó, không phải lợi nhuận. Vẫn in ra
      //      nhưng kèm cột SỤT để thấy nó chạy ở đòn bẩy khác hẳn, không so trực tiếp được.
      const solo = PHASES.map((p) => cagrOf(runPhase(p, k, equity, rp, floors), rp));
      const rows: [string, { cagr: number; maxDD: number; mult: number }][] = [
        ["pha 0h (đang chạy)", solo[0]],
        ["TB 4 pha chạy RIÊNG", {
          cagr: solo.reduce((s, x) => s + x.cagr, 0) / 4,
          maxDD: solo.reduce((s, x) => s + x.maxDD, 0) / 4,
          mult: solo.reduce((s, x) => s + x.mult, 0) / 4,
        }],
        ["ENSEMBLE ¼ risk (có sàn)", cagrOf(mergeEquity(PHASES.map((p) => runPhase(p, k, equity, rp / 4, floors))), rp / 4)],
        ["ENSEMBLE ¼ risk, KHÔNG sàn", cagrOf(mergeEquity(PHASES.map((p) => runPhase(p, k, equity, rp / 4, null))), rp / 4)],
      ];
      for (const [name, r] of rows) {
        console.log(
          (name === rows[0][0] ? `${(rp * 100).toFixed(1)}%` : "").padEnd(12) + name.padEnd(28) +
          (r.mult > 0 ? r.mult.toFixed(1) : "0").padStart(9) + `${r.cagr.toFixed(0)}%`.padStart(8) +
          `${(r.maxDD * 100).toFixed(0)}%`.padStart(8) +
          (r.maxDD > 0 ? (r.cagr / (r.maxDD * 100)).toFixed(2) : "—").padStart(10),
        );
      }
      console.log("-".repeat(73));
    }
    console.log();
  }

  console.log("═══ NGƯỠNG VỐN để ensemble chạy ĐÚNG ý đồ (risk tổng 1,0%, k=0,5) ═══");
  console.log("equity".padStart(9) + "CAGR".padStart(9) + "sụt".padStart(8) + "CAGR/sụt".padStart(10) + "   (mốc KHÔNG sàn: sụt 27%, ratio 4,05)");
  for (const eq of EQS) {
    const e2 = mergeEquity(PHASES.map((p) => runPhase(p, 0.5, eq, 0.0025, floors)));
    const { mult, maxDD } = compoundedEquity(e2, 0.0025);
    const cagr = mult > 0 ? (Math.pow(mult, 1 / years) - 1) * 100 : -100;
    console.log(`$${eq}`.padStart(9) + `${cagr.toFixed(0)}%`.padStart(9) + `${(maxDD * 100).toFixed(0)}%`.padStart(8) + (maxDD > 0 ? (cagr / (maxDD * 100)).toFixed(2) : "—").padStart(10));
  }
  console.log();

  console.log(
    "═══ CÁCH ĐỌC ═══\n" +
    "• Phép so ĐÚNG là ENSEMBLE với hàng \"TRUNG BÌNH 4 pha\", KHÔNG phải với pha 0h. Pha 0h là pha\n" +
    "  may nhất trong 4 — so với nó là tự so với một lần rút thăm trúng, tức chính là overfit.\n" +
    "• So ENSEMBLE (có sàn) với ENSEMBLE (không sàn) để biết sàn minNotional nuốt mất bao nhiêu phần\n" +
    "  lợi. Chia ¼ risk làm mỗi unit nhỏ đi 4 lần, nên đây là chỗ ensemble dễ chết nhất ở vốn nhỏ.",
  );
}

const EQS = [513, 1000, 2000, 5000, 10000, 20000];
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
