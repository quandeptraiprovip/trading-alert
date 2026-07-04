/**
 * exp-turtle-levers.ts — Thử các đòn bẩy tăng NET R + tần suất + R/lệnh cho Turtle (turtle.ts).
 *
 * Đòn bẩy (ưu tiên theo bằng chứng nghiên cứu + memory):
 *   symbols : mở rộng rổ theo tier large-cap ĐỊNH TRƯỚC theo market-cap (KHÔNG cherry-pick theo backtest)
 *   filters : ATR buffer / EMA trend thứ 2 / volume confirm / entryDays lân cận
 *   pyramid : pyramiding kiểu Turtle (thêm unit mỗi step×ATR có lợi, tối đa maxUnits)
 *   regime  : BTC regime gate (SMA nhanh/chậm trên 4h BTC) — gate long/short/cả hai
 *
 * MỌI variant chấm trên CÙNG cửa sổ phân tích [t0 chung, tEnd] + tách 3 era theo LỊCH
 * (entry-time). Tiêu chí ĐẬU giữ chuẩn repo: NET R > baseline, exp/lệnh không tệ hơn,
 * cả 3 era dương, Era A (OOS cũ nhất) không suy giảm rõ rệt.
 *
 * Run: ./node_modules/.bin/ts-node exp-turtle-levers.ts <symbols|filters|pyramid|regime|combo> [days]
 */
import { Candle, TF_MS } from "./strategy";
import { fetchKlinesPaged } from "./kline-fetch";
import { T, runTurtle, Trade, TurtleParams, buildBtcGateLongs } from "./turtle";

const BASE8 = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "bnbusdt", "adausdt", "avaxusdt"];
// Tier kế tiếp theo market-cap/thanh khoản (thứ tự ĐỊNH TRƯỚC — mở rộng lấy từ đầu danh sách):
const TIER14 = ["linkusdt", "trxusdt", "ltcusdt", "bchusdt", "dotusdt", "suiusdt", "nearusdt", "uniusdt", "aptusdt", "atomusdt", "opusdt", "injusdt", "filusdt", "etcusdt"];

const BPD = TF_MS["1d"] / TF_MS[T.tf]; // 6 nến/ngày
// Warmup CHUNG cho mọi variant (đủ cho dcEntry 25d=150, trendLen2 300, SMA regime 300) → so sánh công bằng
const COMMON_WARMUP = 310;

async function fetchAll(symbols: string[], days: number): Promise<Map<string, Candle[]>> {
  const totalBars = Math.ceil(days * BPD) + T.trendLen + 50;
  const data = new Map<string, Candle[]>();
  for (const s of symbols) {
    const c = await fetchKlinesPaged(s, T.tf, totalBars);
    if (c.length >= COMMON_WARMUP + 100) data.set(s, c);
    else console.log(`  ⚠️ ${s.toUpperCase()} chỉ ${c.length} nến — bỏ.`);
  }
  return data;
}

// ── metrics trên cửa sổ chung + 3 era theo lịch ──
export interface M {
  n: number; net: number; exp: number; wr: number; freq: number; maxDD: number;
  eras: { n: number; net: number; exp: number }[];
  longN: number; shortN: number;
}
function metrics(trades: Trade[], t0: number, t1: number): M {
  const ts = trades.filter((t) => t.entryTime >= t0).sort((a, b) => a.entryTime - b.entryTime);
  const n = ts.length;
  const net = ts.reduce((s, t) => s + t.netR, 0);
  const wins = ts.filter((t) => t.netR > 0).length;
  const periodDays = (t1 - t0) / TF_MS["1d"];
  let eq = 1, peak = 1, maxDD = 0;
  for (const t of ts) { eq *= 1 + t.netR * 0.01; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak); }
  const eras = [0, 1, 2].map((e) => {
    const lo = t0 + ((t1 - t0) * e) / 3, hi = t0 + ((t1 - t0) * (e + 1)) / 3;
    const es = ts.filter((t) => t.entryTime >= lo && t.entryTime < hi);
    const enet = es.reduce((s, t) => s + t.netR, 0);
    return { n: es.length, net: enet, exp: es.length ? enet / es.length : 0 };
  });
  return { n, net, exp: n ? net / n : 0, wr: n ? (wins / n) * 100 : 0, freq: n / periodDays, maxDD, eras, longN: ts.filter((t) => t.dir === "long").length, shortN: n - ts.filter((t) => t.dir === "long").length };
}

function runBasket(data: Map<string, Candle[]>, symbols: string[], p: TurtleParams): Trade[] {
  const all: Trade[] = [];
  for (const s of symbols) { const c = data.get(s); if (c) all.push(...runTurtle(s, c, p)); }
  return all;
}

export function fmtRow(label: string, m: M, base?: M): string {
  const d = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
  const flag = base
    ? (m.net > base.net ? "N✓" : "N✗") + (m.exp >= base.exp ? "E✓" : "E✗") + (m.freq >= base.freq ? "F✓" : "F✗") + (m.eras.every((e) => e.net > 0) ? "O✓" : "O✗")
    : "    ";
  const eras = m.eras.map((e) => `${e.exp.toFixed(2)}(${String(e.n).padStart(3)})`).join(" ");
  return `${label.padEnd(30)} ${String(m.n).padStart(4)} ${m.freq.toFixed(2).padStart(5)} ${m.wr.toFixed(0).padStart(3)}% ${m.exp.toFixed(3).padStart(6)} ${d(m.net).padStart(7)}R ${(m.maxDD * 100).toFixed(1).padStart(5)}% | ${eras} | ${flag}`;
}
export const HDR = "variant".padEnd(30) + "    n  /ngày  WR%    exp     NET   maxDD | eraA-exp(n) eraB      eraC       | đậu?";

async function main() {
  const phase = process.argv[2] ?? "symbols";
  const days = parseInt(process.argv[3] ?? (phase === "audit" ? "1100" : "1050"), 10);
  const warmup = phase === "audit" ? 610 : COMMON_WARMUP; // audit: SMA600 của gate phải ấm từ t0

  const allSyms = [...BASE8, ...TIER14];
  const need = phase === "symbols" || phase === "combo" ? allSyms : BASE8;
  console.log(`Fetch ${need.length} symbol @ ${T.tf} (~${days}d)...`);
  const data = await fetchAll(phase === "regime" ? [...new Set([...need, "btcusdt"])] : need, days);

  const btc = data.get("btcusdt")!;
  const t0 = btc[warmup].openTime;
  const t1 = btc[btc.length - 1].openTime;
  console.log(`Cửa sổ chung: ${new Date(t0).toISOString().slice(0, 10)} → ${new Date(t1).toISOString().slice(0, 10)} (${((t1 - t0) / TF_MS["1d"]).toFixed(0)}d), era ≈ ${((t1 - t0) / TF_MS["1d"] / 3).toFixed(0)}d\n`);

  const runM = (symbols: string[], p: TurtleParams) => metrics(runBasket(data, symbols, p), t0, t1);
  // Baseline GHIM = cấu hình TRƯỚC cải tiến 2026-07-04 (pyramid + BTC gate TẮT) — không trôi theo T mặc định
  const BASE_P: TurtleParams = { ...T, entryBufferAtr: 0, trendLen2: 0, confirmVolMult: 0, pyramidStepAtr: 0, pyramidMaxUnits: 1, btcGateSlow: 0, gate: undefined };
  const base = runM(BASE8, BASE_P);

  console.log(HDR);
  console.log("─".repeat(HDR.length + 10));
  console.log(fmtRow("BASELINE B8 20d/3.0", base));

  if (phase === "symbols") {
    // từng candidate SOLO (thông tin generalization — kiểm tra edge có tồn tại ngoài rổ gốc)
    console.log("\n— Từng candidate SOLO (tham khảo, không phải tiêu chí chọn) —");
    for (const s of TIER14) {
      if (!data.has(s)) continue;
      console.log(fmtRow(`  ${s.toUpperCase()}`, runM([s], BASE_P)));
    }
    console.log("\n— Rổ mở rộng theo tier ĐỊNH TRƯỚC (market-cap order) —");
    console.log(fmtRow("B12 = B8+4 (link,trx,ltc,bch)", runM([...BASE8, ...TIER14.slice(0, 4)], BASE_P), base));
    console.log(fmtRow("B16 = B8+8 (+dot,sui,near,uni)", runM([...BASE8, ...TIER14.slice(0, 8)], BASE_P), base));
    console.log(fmtRow("B18 = B8+10 (+apt,atom)", runM([...BASE8, ...TIER14.slice(0, 10)], BASE_P), base));
    console.log(fmtRow("B22 = B8+14 (tất cả)", runM([...BASE8, ...TIER14], BASE_P), base));
  }

  if (phase === "filters") {
    for (const b of [0.1, 0.25, 0.5]) console.log(fmtRow(`buffer ${b}×ATR`, runM(BASE8, { ...BASE_P, entryBufferAtr: b }), base));
    for (const l of [200, 300]) console.log(fmtRow(`EMA2 ${l} (${(l / 6).toFixed(0)}d)`, runM(BASE8, { ...BASE_P, trendLen2: l }), base));
    for (const v of [1.2, 1.5]) console.log(fmtRow(`vol ≥${v}×SMA20`, runM(BASE8, { ...BASE_P, confirmVolMult: v }), base));
    for (const ed of [15, 25]) console.log(fmtRow(`entryDays ${ed}`, runM(BASE8, { ...BASE_P, entryDays: ed }), base));
  }

  if (phase === "pyramid") {
    for (const step of [0.5, 1.0]) {
      for (const u of [2, 3, 4]) {
        const m = runM(BASE8, { ...BASE_P, pyramidStepAtr: step, pyramidMaxUnits: u });
        console.log(fmtRow(`pyramid step${step} max${u}`, m, base));
      }
    }
  }

  if (phase === "regime") {
    // BTC regime: SMA nhanh vs chậm trên 4h BTC (5d=30, 50d=300 nến) — tra cứu theo openTime
    const sma = (arr: number[], len: number) => {
      const out = new Array(arr.length).fill(NaN);
      let s = 0;
      for (let i = 0; i < arr.length; i++) { s += arr[i]; if (i >= len) s -= arr[i - len]; if (i >= len - 1) out[i] = s / len; }
      return out;
    };
    const closes = btc.map((c) => c.close);
    const idxByTime = new Map<number, number>();
    btc.forEach((c, i) => idxByTime.set(c.openTime, i));
    // regime tại openTime t = trạng thái NẾN BTC TRƯỚC t (đã đóng) → không lookahead
    const mkGate = (fastLen: number, slowLen: number, mode: "shorts" | "longs" | "both") => {
      const fast = sma(closes, fastLen), slow = sma(closes, slowLen);
      return (t: number, dir: "long" | "short") => {
        const i = idxByTime.get(t);
        if (i == null || i < 1) return true; // symbol khác BTC lệch lưới thời gian? 4h chung lưới → luôn có
        const bull = fast[i - 1] > slow[i - 1];
        if (!Number.isFinite(fast[i - 1]) || !Number.isFinite(slow[i - 1])) return true;
        if (mode === "shorts") return dir === "long" ? true : !bull;
        if (mode === "longs") return dir === "short" ? true : bull;
        return dir === "long" ? bull : !bull;
      };
    };
    for (const [f, s] of [[30, 300], [60, 600]] as const) {
      for (const mode of ["shorts", "longs", "both"] as const) {
        const m = runM(BASE8, { ...BASE_P, gate: mkGate(f, s, mode) });
        console.log(fmtRow(`BTC ${f / 6}d/${s / 6}d gate-${mode}`, m, base));
      }
    }
  }

  if (phase === "combo") {
    const sma = (arr: number[], len: number) => {
      const out = new Array(arr.length).fill(NaN);
      let s = 0;
      for (let i = 0; i < arr.length; i++) { s += arr[i]; if (i >= len) s -= arr[i - len]; if (i >= len - 1) out[i] = s / len; }
      return out;
    };
    const closes = btc.map((c) => c.close);
    const idxByTime = new Map<number, number>();
    btc.forEach((c, i) => idxByTime.set(c.openTime, i));
    const gateL = (fastLen: number, slowLen: number) => {
      const fast = sma(closes, fastLen), slow = sma(closes, slowLen);
      return (t: number, dir: "long" | "short") => {
        if (dir === "short") return true;
        const i = idxByTime.get(t);
        if (i == null || i < 1 || !Number.isFinite(fast[i - 1]) || !Number.isFinite(slow[i - 1])) return true;
        return fast[i - 1] > slow[i - 1];
      };
    };
    const pyr = { pyramidStepAtr: 0.5, pyramidMaxUnits: 3 };
    const pyr4 = { pyramidStepAtr: 0.5, pyramidMaxUnits: 4 };
    const g = gateL(60, 600);
    const combos: [string, TurtleParams][] = [
      ["pyr3", { ...BASE_P, ...pyr }],
      ["pyr3+gateL", { ...BASE_P, ...pyr, gate: g }],
      ["pyr3+buf0.1", { ...BASE_P, ...pyr, entryBufferAtr: 0.1 }],
      ["pyr3+ema2-300", { ...BASE_P, ...pyr, trendLen2: 300 }],
      ["pyr3+gateL+buf0.1", { ...BASE_P, ...pyr, gate: g, entryBufferAtr: 0.1 }],
      ["pyr3+gateL+ema2-300", { ...BASE_P, ...pyr, gate: g, trendLen2: 300 }],
      ["pyr3+gateL+buf+ema2", { ...BASE_P, ...pyr, gate: g, entryBufferAtr: 0.1, trendLen2: 300 }],
      ["pyr3+15d", { ...BASE_P, ...pyr, entryDays: 15 }],
      ["pyr3+15d+gateL", { ...BASE_P, ...pyr, entryDays: 15, gate: g }],
      ["pyr3+15d+buf0.1", { ...BASE_P, ...pyr, entryDays: 15, entryBufferAtr: 0.1 }],
      ["pyr3+15d+gateL+buf0.1", { ...BASE_P, ...pyr, entryDays: 15, gate: g, entryBufferAtr: 0.1 }],
      ["pyr4+gateL", { ...BASE_P, ...pyr4, gate: g }],
      ["pyr4+15d+gateL", { ...BASE_P, ...pyr4, entryDays: 15, gate: g }],
      ["pyr3+vol1.5", { ...BASE_P, ...pyr, confirmVolMult: 1.5 }],
    ];
    for (const [label, p] of combos) console.log(fmtRow(label, runM(BASE8, p), base));
  }

  if (phase === "audit") {
    // ── AUDIT 2 ứng viên: pyr3+gateL và pyr4+gateL (gate SMA 10d/100d BTC, warm từ t0) ──
    const g = buildBtcGateLongs(btc, 60, 600);
    const cands: [string, number][] = [["pyr3+gateL", 3], ["pyr4+gateL", 4]];
    for (const [label, maxU] of cands) {
      const p: TurtleParams = { ...BASE_P, pyramidStepAtr: 0.5, pyramidMaxUnits: maxU, gate: g };
      const trades = runBasket(data, BASE8, p).filter((t) => t.entryTime >= t0).sort((a, b) => a.entryTime - b.entryTime);
      const m = metrics(trades, t0, t1);
      console.log("\n" + "═".repeat(80));
      console.log(`  ${label} — long ${m.longN}/short ${m.shortN}`);
      console.log(fmtRow(label, m, base));

      // walk-forward 4 cửa sổ
      const wf = [0, 1, 2, 3].map((w) => {
        const lo = t0 + ((t1 - t0) * w) / 4, hi = t0 + ((t1 - t0) * (w + 1)) / 4;
        const ws = trades.filter((t) => t.entryTime >= lo && t.entryTime < hi);
        return `W${w + 1} ${(ws.reduce((s, t) => s + t.netR, 0)).toFixed(0).padStart(4)}R(${ws.length})`;
      });
      console.log(`  Walk-forward: ${wf.join("  ")}`);

      // per-symbol
      const bySym = BASE8.map((s) => {
        const ts = trades.filter((t) => t.symbol === s);
        return `${s.replace("usdt", "").toUpperCase()} ${ts.reduce((a, t) => a + t.netR, 0).toFixed(0)}R/${ts.length}`;
      });
      console.log(`  Symbol: ${bySym.join("  ")}`);

      // bootstrap 5000 trên tổng NET
      const B = 5000, sums: number[] = [];
      let pos = 0;
      for (let b = 0; b < B; b++) {
        let s = 0;
        for (let k = 0; k < trades.length; k++) s += trades[Math.floor(Math.random() * trades.length)].netR;
        sums.push(s); if (s > 0) pos++;
      }
      sums.sort((a, b) => a - b);
      const qq = (p: number) => sums[Math.floor((sums.length - 1) * p)];
      console.log(`  Bootstrap: 90% CI [${qq(0.05).toFixed(0)}R, ${qq(0.95).toFixed(0)}R], P(>0)=${((pos / B) * 100).toFixed(1)}%`);

      // perturbation 30 seed — jitter MỌI tham số hoạt động (maxUnits ±1 nguyên)
      const SEEDS = 30, jit = 0.15;
      const nets: number[] = [], exps: number[] = [];
      let beatNet = 0, beatExp = 0;
      for (let sd = 0; sd < SEEDS; sd++) {
        const jr = () => 1 + (Math.random() * 2 - 1) * jit;
        const pj: TurtleParams = {
          ...BASE_P,
          entryDays: Math.max(2, Math.round(T.entryDays * jr())),
          chandelierMult: T.chandelierMult * jr(),
          atrPeriod: Math.max(5, Math.round(T.atrPeriod * jr())),
          trendLen: Math.max(10, Math.round(T.trendLen * jr())),
          maxHoldDays: Math.max(5, Math.round(T.maxHoldDays * jr())),
          pyramidStepAtr: 0.5 * jr(),
          pyramidMaxUnits: Math.max(2, maxU + (Math.floor(Math.random() * 3) - 1)),
          gate: buildBtcGateLongs(btc, Math.round(60 * jr()), Math.round(600 * jr())),
        };
        const mj = metrics(runBasket(data, BASE8, pj), t0, t1);
        nets.push(mj.net); exps.push(mj.exp);
        if (mj.net > base.net) beatNet++;
        if (mj.exp > base.exp) beatExp++;
      }
      nets.sort((a, b) => a - b); exps.sort((a, b) => a - b);
      const qn = (arr: number[], p: number) => arr[Math.floor((arr.length - 1) * p)];
      console.log(`  Perturb ±15% ×${SEEDS}: NET min ${nets[0].toFixed(0)} | p25 ${qn(nets, .25).toFixed(0)} | med ${qn(nets, .5).toFixed(0)} | max ${nets[nets.length - 1].toFixed(0)}  (med/cấu-hình: ${(qn(nets, .5) / m.net * 100).toFixed(0)}%)`);
      console.log(`             exp med ${qn(exps, .5).toFixed(3)} | min ${exps[0].toFixed(3)}  | seed thắng BASELINE: NET ${beatNet}/${SEEDS}, exp ${beatExp}/${SEEDS}`);
    }
    // verify: T MẶC ĐỊNH hiện tại + gate (đường áp dụng thật) phải khớp ứng viên đã chọn
    console.log("\n" + fmtRow("T mặc định + gate (áp dụng)", runM(BASE8, { ...T, gate: g }), base));
  }

  console.log("\nĐọc: N=NET>base, E=exp≥base, F=freq≥base, O=cả 3 era dương. eraX-exp(n)=R/lệnh(số lệnh).");
}
main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
