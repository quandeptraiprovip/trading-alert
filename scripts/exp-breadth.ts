/**
 * exp-breadth.ts — MỞ RỘNG RỔ có đo bằng metric đúng.
 *
 * VÌ SAO LÀM LẠI: lần loại trước (exp-turtle-levers.ts, 2026-07-04) chấm bằng "exp/lệnh bị pha
 * loãng". Đó là metric SAI cho câu hỏi này: trong trend-following, thêm thị trường LUÔN hạ
 * expectancy/lệnh (thị trường thêm vào kém hơn thị trường đã chọn) nhưng NÂNG Sharpe danh mục nếu
 * tương quan < 1. Đây là kết quả kinh điển của managed futures (quỹ trend chạy 50-100+ thị trường
 * chính vì lý do này, không phải vì mỗi thị trường đều tốt).
 * Ngoài ra hai thứ đã ĐỔI kể từ lần loại đó: heat-decay cấp danh mục (ship 04/08) và kênh thoát
 * mid-20d (ship 04/08 + 09/08) — nên kết luận cũ không còn ràng buộc.
 *
 * CHỐNG OVERFIT — thiết kế đo "BREADTH", không đo "chọn coin nào":
 *   - Với mỗi cỡ rổ N, bốc NGẪU NHIÊN nhiều rổ con (seed cố định) và báo cáo PHÂN PHỐI.
 *     Nếu chỉ rổ tốt nhất mới cải thiện thì đó là chọn lọc; nếu TRUNG VỊ cải thiện thì đó là breadth.
 *   - Ứng viên chọn theo NGÀY NIÊM YẾT (có sẵn trước 2021), không theo vốn hoá/hiệu suất hôm nay.
 *     Rổ gồm cả coin nay đã tụt hạng (EOS, XLM, ALGO, IOST, ONT, ZIL…) để giảm survivorship bias.
 *   - Metric BẤT BIẾN ĐÒN BẨY: Sharpe P&L ngày và NET/maxDD. NET R thô chỉ để tham khảo.
 *   - Tiêu chí nhận (định trước): trung vị Sharpe tăng ĐƠN ĐIỆU/plateau theo N, và KHÔNG era nào tụt.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-breadth.ts [days] [subsets]
 */
import { Candle, TF_MS } from "../strategy";
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { T, buildBtcGateLongs } from "../turtle";
import { ExtParams, riskMetrics, runBooks, Book, AdmitFn } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { decayH, Gate, fmtD } from "./rx-lab";

/** Rổ đang chạy production. */
export const CORE8 = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "adausdt", "avaxusdt", "dotusdt"];

/**
 * Ứng viên = MỌI perp USDT có nến 4h từ trước 2021-01-01 (xem scripts/exp-universe-probe.ts).
 * Danh sách này KHÔNG được lọc theo hiệu suất — đó là điều kiện để kết quả nói về breadth.
 * eosusdt (hết 2025-05) và maticusdt (hết 2024-09) giữ nguyên: chúng là bằng chứng chống
 * survivorship bias; sổ hết dữ liệu thì engine đơn giản ngừng cập nhật sổ đó.
 */
export const POOL46 = [
  "btcusdt", "ethusdt", "xrpusdt", "dogeusdt", "adausdt", "dotusdt", "solusdt", "avaxusdt",
  "linkusdt", "ltcusdt", "bchusdt", "etcusdt", "trxusdt", "xlmusdt", "atomusdt", "algousdt",
  "vetusdt", "neousdt", "iotausdt", "zecusdt", "dashusdt", "xmrusdt", "compusdt", "sushiusdt",
  "yfiusdt", "snxusdt", "crvusdt", "omgusdt", "qtumusdt", "zilusdt", "batusdt", "ontusdt",
  "iostusdt", "thetausdt", "egldusdt", "uniusdt", "ftmusdt", "enjusdt", "ksmusdt", "nearusdt",
  "filusdt", "aaveusdt", "axsusdt", "grtusdt", "eosusdt", "maticusdt",
];

/** PRNG có seed (mulberry32) — để mọi lần chạy cho cùng bộ rổ ngẫu nhiên. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample<X>(arr: X[], n: number, rand: () => number): X[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

export async function loadPool(days: number, symbols: string[]): Promise<Map<string, Candle[]>> {
  const bpd = TF_MS["1d"] / TF_MS["4h"];
  const bars = Math.ceil(days * bpd) + T.btcGateSlow + 200;
  const data = new Map<string, Candle[]>();
  const failed: string[] = [];
  for (const s of symbols) {
    try {
      const c = await fetchFuturesKlinesPaged(s, "4h", bars);
      if (c.length >= 500) data.set(s, c);
      else failed.push(`${s}(${c.length} nến)`);
    } catch (e: any) {
      failed.push(`${s}(${e?.message ?? "lỗi"})`);
    }
  }
  // Im lặng bỏ symbol làm kết quả đổi giữa các lần chạy mà không ai biết — phải báo.
  if (failed.length) console.log(`⚠️  KHÔNG tải được ${failed.length} symbol: ${failed.join(", ")}`);
  return data;
}

/**
 * Cửa sổ đo CỐ ĐỊNH theo rổ lõi (không để coin niêm yết muộn/hết sớm bóp méo khung thời gian —
 * `windowOf` của rx-lab lấy max(from)/min(to) nên một coin hết dữ liệu sẽ cắt cụt cả bài test).
 */
export function coreWindow(data: Map<string, Candle[]>, warmupBars: number) {
  let from = -Infinity;
  let to = -Infinity;
  for (const s of CORE8) {
    const c = data.get(s);
    if (!c) continue;
    from = Math.max(from, c[Math.min(warmupBars, c.length - 1)].openTime);
    to = Math.max(to, c[c.length - 1].openTime);
  }
  const eras = [0, 1, 2].map((k) => ({
    name: ["A", "B", "C"][k],
    from: from + ((to - from) * k) / 3,
    to: from + ((to - from) * (k + 1)) / 3,
  }));
  return { from, to, eras };
}

type Win = ReturnType<typeof coreWindow>;

function evalSubset(syms: string[], data: Map<string, Candle[]>, p: ExtParams, admit: AdmitFn | undefined, w: Win) {
  const bs: Book[] = syms.filter((s) => data.has(s)).map((s) => ({ key: s, symbol: s, candles: data.get(s)!, p }));
  const res = runBooks(bs, admit);
  const eq = res.equity.filter((e) => e.time >= w.from && e.time <= w.to);
  const m = riskMetrics(eq);
  const eras = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
  const last365 = riskMetrics(res.equity.filter((x) => x.time >= w.to - 365 * TF_MS["1d"]));
  const positions = new Set(res.trades.map((t) => `${t.book}#${t.positionId}`)).size;
  return {
    sharpe: m.sharpe,
    netR: m.netR,
    maxDD: m.maxDD,
    nOverDd: m.netOverMaxDD,
    ulcer: m.netOverUlcer,
    eraSharpe: eras.map((e) => e.sharpe),
    eraNet: eras.map((e) => e.netR),
    s365: last365.sharpe,
    n365: last365.netR,
    positions,
    units: res.trades.length,
  };
}

const med = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
};

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const nSub = parseInt(process.argv[3] ?? "16", 10);

  console.log(`Tải ${POOL46.length} symbol × ${days} ngày (nến 4h)...`);
  const data = await loadPool(days, POOL46);
  console.log(`Tải được ${data.size} symbol.`);
  const btc = data.get("btcusdt")!;
  const gate: Gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  console.log(`Cửa sổ: ${fmtD(w.from)} → ${fmtD(w.to)} (${((w.to - w.from) / TF_MS["1d"]).toFixed(0)} ngày)`);
  console.log(`Era A ${fmtD(w.eras[0].from)}→${fmtD(w.eras[0].to)} · B →${fmtD(w.eras[1].to)} · C →${fmtD(w.eras[2].to)}`);
  console.log(`Heat-decay k=${T.heatDecayK} BẬT cho cả hai sleeve (chính sách risk danh mục hiện hành).\n`);

  const SIZES = [8, 12, 16, 24, 32, 46];
  for (const [name, p] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
    console.log("=".repeat(118));
    console.log(`  ${name} — Sharpe & NET/maxDD theo CỠ RỔ (mỗi cỡ: ${nSub} rổ ngẫu nhiên, seed cố định)`);
    console.log("=".repeat(118));
    console.log("N     rổ   vị thế   Sharpe p25/TV/p75      NET R TV   maxDD TV   N/DD TV   era A/B/C (TV Sharpe)   365d TV");
    console.log("-".repeat(118));

    // tham chiếu: đúng rổ đang chạy
    const ref = evalSubset(CORE8, data, p, decayH(T.heatDecayK), w);
    console.log(
      `CORE8 (đang chạy)  ${String(ref.positions).padStart(5)}   ` +
        `      ${ref.sharpe.toFixed(2)}        ${ref.netR.toFixed(0).padStart(7)}   ${ref.maxDD.toFixed(1).padStart(7)}   ` +
        `${ref.nOverDd.toFixed(2).padStart(6)}   ${ref.eraSharpe.map((x) => x.toFixed(2)).join("/")}          ` +
        `${ref.s365.toFixed(2)}|${ref.n365.toFixed(0)}`,
    );
    console.log("-".repeat(118));

    for (const N of SIZES) {
      const rand = rng(20260812 + N);
      const runs = N >= POOL46.length ? [POOL46] : Array.from({ length: nSub }, () => sample(POOL46, N, rand));
      const rs = runs.map((syms) => evalSubset(syms, data, p, decayH(T.heatDecayK), w));
      const sh = rs.map((r) => r.sharpe);
      console.log(
        `${String(N).padStart(3)}  ${String(runs.length).padStart(3)}   ${String(Math.round(med(rs.map((r) => r.positions)))).padStart(5)}   ` +
          `${q(sh, 0.25).toFixed(2)}/${med(sh).toFixed(2)}/${q(sh, 0.75).toFixed(2)}     ` +
          `${med(rs.map((r) => r.netR)).toFixed(0).padStart(7)}   ${med(rs.map((r) => r.maxDD)).toFixed(1).padStart(7)}   ` +
          `${med(rs.map((r) => r.nOverDd)).toFixed(2).padStart(6)}   ` +
          `${[0, 1, 2].map((k) => med(rs.map((r) => r.eraSharpe[k])).toFixed(2)).join("/")}          ` +
          `${med(rs.map((r) => r.s365)).toFixed(2)}|${med(rs.map((r) => r.n365)).toFixed(0)}`,
      );
    }
    console.log();
  }
}

if (require.main === module && /exp-breadth\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error("Lỗi:", e?.message ?? e);
    process.exit(1);
  });
}
