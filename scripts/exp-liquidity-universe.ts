/**
 * exp-liquidity-universe.ts — rổ coin chọn bằng LUẬT QUAN SÁT ĐƯỢC TẠI THỜI ĐIỂM (point-in-time),
 * không phải bằng danh sách chọn tay sau khi đã biết ai thắng.
 *
 * VẤN ĐỀ mà script này giải: `exp-breadth.ts` cho thấy rổ CORE8 đang chạy có Sharpe ~1,58 còn rổ
 * 8 coin BỐC NGẪU NHIÊN từ cùng pool chỉ ~0,88. Chênh lệch đó trộn HAI thứ khác hẳn nhau:
 *   (1) survivorship/selection bias — CORE8 là 8 coin ta BIẾT đã sống tốt 2021→2026;
 *   (2) chất lượng thật — coin thanh khoản lớn trend sạch hơn, ít nhiễu hơn.
 * Chỉ (2) mới dùng được cho tương lai. Cách tách: xếp hạng theo THANH KHOẢN QUÁ KHỨ (biết được tại
 * thời điểm ra quyết định) rồi lấy top-N, tái cân bằng định kỳ. Nếu "top-N theo thanh khoản" đạt
 * gần CORE8 ⇒ phần lớn là chất lượng; nếu thua xa ⇒ CORE8 chủ yếu là may mắn nhìn lại.
 *
 * LUẬT RỔ: mỗi `REBALANCE_DAYS` ngày, xếp hạng mọi symbol theo TRUNG VỊ quoteVolume (USDT) của
 * `LOOKBACK_DAYS` ngày ĐÃ ĐÓNG gần nhất, lấy top-N. Chỉ chặn VÀO LỆNH MỚI ngoài top-N; vị thế đang
 * mở vẫn chạy tiếp theo luật thoát của nó (giống thực tế: không ép đóng khi coin rớt hạng).
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-liquidity-universe.ts [days] [sleeve=both]
 */
import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { ExtParams, riskMetrics, runBooks, Book } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { decayH, Gate, fmtD } from "./rx-lab";
import { CORE8, POOL46, loadPool, coreWindow } from "./exp-breadth";

const REBALANCE_DAYS = 30;
const LOOKBACK_DAYS = 90;

export type UniverseFn = (symbol: string, time: number) => boolean;

/**
 * Xếp hạng thanh khoản point-in-time. Trả hàm (symbol, time) → có nằm trong top-N không.
 * Chỉ dùng nến ĐÃ ĐÓNG trước mốc tái cân bằng ⇒ không lookahead.
 */
export function buildLiquidityUniverse(
  data: Map<string, Candle[]>,
  topN: number,
  from: number,
  to: number,
): { inTop: UniverseFn; log: { time: number; syms: string[] }[] } {
  const step = REBALANCE_DAYS * TF_MS["1d"];
  const lookMs = LOOKBACK_DAYS * TF_MS["1d"];
  const stamps: number[] = [];
  for (let t = from; t <= to + step; t += step) stamps.push(t);

  const sets: Set<string>[] = [];
  const log: { time: number; syms: string[] }[] = [];
  for (const t of stamps) {
    const scored: { sym: string; v: number }[] = [];
    for (const [sym, c] of data) {
      const vols: number[] = [];
      for (let i = c.length - 1; i >= 0; i--) {
        const bt = c[i].openTime;
        if (bt >= t) continue; // chỉ nến đã đóng trước mốc
        if (bt < t - lookMs) break;
        vols.push(c[i].quoteVolume);
      }
      // đòi đủ ~80% số nến của cửa sổ nhìn lại → coin mới niêm yết/đã ngừng giao dịch bị loại
      if (vols.length < (LOOKBACK_DAYS * 6) * 0.8) continue;
      vols.sort((a, b) => a - b);
      scored.push({ sym, v: vols[Math.floor(vols.length / 2)] });
    }
    scored.sort((a, b) => b.v - a.v);
    const set = new Set(scored.slice(0, topN).map((x) => x.sym));
    sets.push(set);
    log.push({ time: t, syms: [...set] });
  }

  const inTop: UniverseFn = (symbol, time) => {
    let idx = Math.floor((time - from) / step);
    if (idx < 0) idx = 0;
    if (idx >= sets.length) idx = sets.length - 1;
    return sets[idx].has(symbol);
  };
  return { inTop, log };
}

function evalUniverse(
  data: Map<string, Candle[]>,
  p: ExtParams,
  baseGate: Gate,
  inTop: UniverseFn | null,
  syms: string[],
  w: ReturnType<typeof coreWindow>,
) {
  const bs: Book[] = syms
    .filter((s) => data.has(s))
    .map((s) => ({
      key: s,
      symbol: s,
      candles: data.get(s)!,
      // gate của TỪNG sổ = gate regime BTC ∧ "symbol này đang trong rổ tại thời điểm đó"
      p: { ...p, gate: (t: number, dir: "long" | "short") => baseGate(t, dir) && (!inTop || inTop(s, t)) },
    }));
  const res = runBooks(bs, decayH(T.heatDecayK));
  const eq = res.equity.filter((e) => e.time >= w.from && e.time <= w.to);
  const m = riskMetrics(eq);
  const eras = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
  const l365 = riskMetrics(res.equity.filter((x) => x.time >= w.to - 365 * TF_MS["1d"]));
  const l730 = riskMetrics(res.equity.filter((x) => x.time >= w.to - 730 * TF_MS["1d"]));
  const positions = new Set(res.trades.map((t) => `${t.book}#${t.positionId}`)).size;
  return { m, eras, l365, l730, positions, units: res.trades.length };
}

function row(label: string, r: ReturnType<typeof evalUniverse>) {
  console.log(
    `${label.padEnd(26)} ${String(r.positions).padStart(5)} ${r.m.sharpe.toFixed(2).padStart(7)} ` +
      `${r.m.netR.toFixed(0).padStart(7)} ${r.m.maxDD.toFixed(1).padStart(7)} ${r.m.netOverMaxDD.toFixed(2).padStart(6)} ` +
      `${r.m.netOverUlcer.toFixed(1).padStart(6)}   ${r.eras.map((e) => e.sharpe.toFixed(2)).join("/")}   ` +
      `${r.l730.sharpe.toFixed(2)}|${r.l730.netR.toFixed(0)}   ${r.l365.sharpe.toFixed(2)}|${r.l365.netR.toFixed(0)}`,
  );
}

const HEADER =
  "cấu hình                    vịthế  Sharpe   NET R   maxDD   N/DD  N/Ulc   era A/B/C        730d       365d";

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  console.log(`Tải ${POOL46.length} symbol × ${days} ngày...`);
  const data = await loadPool(days, POOL46);
  const btc = data.get("btcusdt")!;
  const baseGate: Gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(baseGate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · ${data.size} symbol · heat k=${T.heatDecayK}`);
  console.log(`Luật rổ: top-N theo TRUNG VỊ quoteVolume ${LOOKBACK_DAYS}d, tái cân bằng ${REBALANCE_DAYS}d\n`);

  // Nhật ký thành phần rổ — để mắt người kiểm chứng luật chọn có hợp lý không
  const { log } = buildLiquidityUniverse(data, 8, w.from, w.to);
  console.log("Thành phần TOP-8 theo thanh khoản, mẫu mỗi 12 tháng:");
  for (let i = 0; i < log.length; i += 12) {
    console.log(`  ${fmtD(log[i].time)}  ${log[i].syms.join(" ")}`);
  }
  const last = log[log.length - 1];
  console.log(`  ${fmtD(last.time)}  ${last.syms.join(" ")}  ← hôm nay`);
  console.log(`  CORE8 đang chạy      ${CORE8.join(" ")}\n`);

  for (const [name, p] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
    console.log("=".repeat(118));
    console.log(`  ${name}`);
    console.log("=".repeat(118));
    console.log(HEADER);
    console.log("-".repeat(118));
    row("CORE8 cố định (đang chạy)", evalUniverse(data, p, baseGate, null, CORE8, w));
    console.log("-".repeat(118));
    for (const N of [4, 6, 8, 10, 12, 16, 20, 24, 32, 46]) {
      const { inTop } = buildLiquidityUniverse(data, N, w.from, w.to);
      row(`top-${N} thanh khoản`, evalUniverse(data, p, baseGate, inTop, POOL46, w));
    }
    console.log();
  }
}

if (require.main === module && /exp-liquidity-universe\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error("Lỗi:", e?.message ?? e);
    process.exit(1);
  });
}
