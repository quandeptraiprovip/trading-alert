/**
 * FX Dream (key-volume.ts): LÚC NÀO NÊN CHỐT LỜI?
 *
 * Quan sát của user (04/10/26): nhiều lệnh đi được một quãng rất dài rồi quay về
 * đúng SL ở entry. Script này giữ NGUYÊN tập điểm vào của engine và chỉ thay luật
 * thoát, để tách tác động của luật thoát khỏi mọi thứ khác.
 *
 * LUẬT THOÁT CHỐT TRƯỚC KHI CHẠY (không thêm/bớt sau khi thấy kết quả). Mỗi họ
 * một đại diện, tham số là số tròn trade tay được:
 *   R0  hiện tại: chốt 33% ở 1R, dời SL về entry, phần còn lại tới mục tiêu cấu trúc
 *   R1  gồng thẳng tới mục tiêu cấu trúc, không chốt, không dời SL
 *   R2  dời SL về entry ở 1R, không chốt, tới mục tiêu cấu trúc
 *   TPk chốt HẾT ở k R (k = 1; 1,5; 2; 3), SL giữ nguyên — đọc như một ĐƯỜNG CONG,
 *       không chọn k đỉnh
 *   R3  như R0 nhưng phần còn lại bám đáy/đỉnh swing M15 (pivot 2/2) sau 1R
 *   R4  như R0 nhưng bám đáy/đỉnh swing H1 (pivot 2/2) sau 1R
 *   R5  như R0 nhưng thoát khi nến M15 ĐÓNG ngược qua EMA20 sau 1R
 *   R6  như R0 nhưng đóng lệnh ở giá đóng sau 1 ngày (96 nến M15)
 *
 * Ba phép chống kết luận sai (scripts/… null-result-toolkit):
 *   1. Phát lại R0 phải khớp grossR của engine từng lệnh (bộ đếm lệch in ra).
 *   2. NHÓM GIẢ: điểm vào NGẪU NHIÊN cùng chiều, cùng khoảng SL theo ATR, cùng R
 *      mục tiêu, chạy qua đúng các luật thoát trên — đo xem luật thoát tự nó tạo ra
 *      bao nhiêu khác biệt khi không có edge vào lệnh.
 *   3. Mốc random walk cho câu "đi xa rồi quay về": P(chạm k+1 R | đã chạm k R)
 *      trước SL gốc −1R; bước ngẫu nhiên không trôi cho (k+1)/(k+2).
 *
 * Chạy: npx ts-node scripts/exp-keyvol-exit.ts [days] [symbols...]
 */
import { KEY_VOLUME_CONFIG, KeyVolumeTrade, atrSeriesForward, runKeyVolume } from "../key-volume";
import { fetchKlinesPaged } from "../kline-fetch";
import { Candle, Swing, TF_MS, aggregate, findSwings } from "../types";

const DEFAULT_SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "adausdt"];
const WARMUP_BARS = 480 + 96 + 200;
const FAKES_PER_TRADE = 5;
const MFE_HORIZON = 30 * 96;

type Ctx = {
  c: Candle[];
  ema20: number[];
  /** Swing M15 / H1 xếp theo index nến M15 mà từ đó swing đã được xác nhận. */
  m15SwingsAt: Map<number, Swing[]>;
  h1SwingsAt: Map<number, Swing[]>;
};

type Entry = {
  symbol: string;
  time: number;
  e: number;
  viaLimit: boolean;
  dir: "long" | "short";
  entry: number;
  stop: number;
  risk: number;
  targetR: number;
  branch: string;
  engineR?: number;
};

type Rule = {
  name: string;
  label: string;
  tpR?: number;
  partial?: { atR: number; frac: number };
  beAtR?: number;
  trail?: "m15" | "h1";
  emaExit?: boolean;
  maxBars?: number;
};

const RULES: Rule[] = [
  { name: "R0", label: "hiện tại: 33% ở 1R + SL về entry", partial: { atR: 1, frac: 0.33 } },
  { name: "R1", label: "gồng thẳng tới mục tiêu" },
  { name: "R2", label: "SL về entry ở 1R, không chốt", beAtR: 1 },
  { name: "TP1", label: "chốt hết ở 1R", tpR: 1 },
  { name: "TP1.5", label: "chốt hết ở 1,5R", tpR: 1.5 },
  { name: "TP2", label: "chốt hết ở 2R", tpR: 2 },
  { name: "TP3", label: "chốt hết ở 3R", tpR: 3 },
  { name: "R3", label: "R0 + bám swing M15", partial: { atR: 1, frac: 0.33 }, trail: "m15" },
  { name: "R4", label: "R0 + bám swing H1", partial: { atR: 1, frac: 0.33 }, trail: "h1" },
  { name: "R5", label: "R0 + đóng ngược EMA20", partial: { atR: 1, frac: 0.33 }, emaExit: true },
  { name: "R6", label: "R0 + đóng sau 1 ngày", partial: { atR: 1, frac: 0.33 }, maxBars: 96 },
];

function emaSeries(c: Candle[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let value = c[0].close;
  for (const candle of c) {
    value = candle.close * k + value * (1 - k);
    out.push(value);
  }
  return out;
}

function buildCtx(c: Candle[]): Ctx {
  const m15SwingsAt = new Map<number, Swing[]>();
  for (const s of findSwings(c, 2, 2)) {
    const list = m15SwingsAt.get(s.confirmIndex) ?? [];
    list.push(s);
    m15SwingsAt.set(s.confirmIndex, list);
  }
  // Swing H1 dùng được từ nến M15 CUỐI CÙNG của cây H1 xác nhận (cây đó đóng cùng lúc).
  const h1 = aggregate(c, "1h", "15m");
  const indexByTime = new Map<number, number>();
  c.forEach((candle, i) => indexByTime.set(candle.openTime, i));
  const h1SwingsAt = new Map<number, Swing[]>();
  for (const s of findSwings(h1, 2, 2)) {
    const lastM15 = indexByTime.get(h1[s.confirmIndex].openTime + TF_MS["1h"] - TF_MS["15m"]);
    if (lastM15 == null) continue;
    const list = h1SwingsAt.get(lastM15) ?? [];
    list.push(s);
    h1SwingsAt.set(lastM15, list);
  }
  return { c, ema20: emaSeries(c, 20), m15SwingsAt, h1SwingsAt };
}

/** Phát lại một lệnh theo luật thoát. Quy ước nến giống hệt engine. */
function simulate(ctx: Ctx, t: Entry, rule: Rule, out?: { mfe: number }): number {
  const { c } = ctx;
  const long = t.dir === "long";
  const sign = long ? 1 : -1;
  const toR = (price: number) => sign * (price - t.entry) / t.risk;
  if (t.viaLimit && (long ? c[t.e].low <= t.stop : c[t.e].high >= t.stop)) return -1;
  const tpR = rule.tpR == null ? t.targetR : Math.min(rule.tpR, t.targetR);
  const tp = t.entry + sign * tpR * t.risk;
  let stop = t.stop;
  let remaining = 1;
  let realized = 0;
  let partialDone = false;
  let mfe = 0;
  const takePartial = () => {
    realized += rule.partial!.frac * rule.partial!.atR;
    remaining -= rule.partial!.frac;
    partialDone = true;
    stop = long ? Math.max(stop, t.entry) : Math.min(stop, t.entry);
  };
  for (let i = t.e + 1; i < c.length; i++) {
    const k = c[i];
    if (long ? k.low <= stop : k.high >= stop) return realized + remaining * toR(stop);
    if (long ? k.high >= tp : k.low <= tp) {
      if (rule.partial && !partialDone && tpR > rule.partial.atR) takePartial();
      return realized + remaining * tpR;
    }
    mfe = Math.max(mfe, toR(long ? k.high : k.low));
    if (out) out.mfe = mfe;
    if (rule.partial && !partialDone && mfe >= rule.partial.atR) takePartial();
    if (rule.beAtR != null && mfe >= rule.beAtR) stop = long ? Math.max(stop, t.entry) : Math.min(stop, t.entry);
    const armed = mfe >= 1;
    if (armed && rule.trail) {
      const swings = (rule.trail === "m15" ? ctx.m15SwingsAt : ctx.h1SwingsAt).get(i) ?? [];
      for (const s of swings) {
        // Swing H1 có index theo khung H1; điều kiện "nằm phía lãi so với entry" đủ lọc.
        if (rule.trail === "m15" && s.index <= t.e) continue;
        const ok = long ? s.type === "low" && s.price > t.entry && s.price < k.close
          : s.type === "high" && s.price < t.entry && s.price > k.close;
        if (ok) stop = long ? Math.max(stop, s.price) : Math.min(stop, s.price);
      }
    }
    if (armed && rule.emaExit && (long ? k.close < ctx.ema20[i] : k.close > ctx.ema20[i])) {
      return realized + remaining * toR(k.close);
    }
    if (rule.maxBars != null && i - t.e >= rule.maxBars) return realized + remaining * toR(k.close);
  }
  return realized + remaining * toR(c[c.length - 1].close);
}

/**
 * MFE trước khi chạm SL gốc (không mục tiêu, không dời SL), trong tối đa 30 ngày.
 * Nến chạm SL không được tính phần lãi (không biết cái nào tới trước) — giống engine.
 */
function mfeBeforeStop(ctx: Ctx, t: Entry): number {
  const { c } = ctx;
  const long = t.dir === "long";
  if (t.viaLimit && (long ? c[t.e].low <= t.stop : c[t.e].high >= t.stop)) return 0;
  let mfe = 0;
  for (let i = t.e + 1; i < Math.min(c.length, t.e + 1 + MFE_HORIZON); i++) {
    const k = c[i];
    if (long ? k.low <= t.stop : k.high >= t.stop) break;
    mfe = Math.max(mfe, (long ? k.high - t.entry : t.entry - k.low) / t.risk);
  }
  return mfe;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function pairedCi(diffs: number[], random: () => number): [number, number] {
  if (diffs.length < 2) return [NaN, NaN];
  const means: number[] = [];
  for (let b = 0; b < 2000; b++) {
    let sum = 0;
    for (let j = 0; j < diffs.length; j++) sum += diffs[Math.floor(random() * diffs.length)];
    means.push(sum / diffs.length);
  }
  means.sort((a, b) => a - b);
  return [means[49], means[1949]];
}

function fmt(x: number, d = 3): string {
  return (x >= 0 ? "+" : "") + x.toFixed(d);
}

function report(title: string, rows: { ctx: Ctx; t: Entry }[], random: () => number): void {
  console.log(`\n── ${title} · ${rows.length} lệnh ──`);
  if (!rows.length) return;
  const base = rows.map((r) => simulate(r.ctx, r.t, RULES[0]));
  console.log("luật    R/lệnh   tổng R   thắng%   Δ vs R0 (CI 95% ghép cặp)");
  for (const rule of RULES) {
    const rs = rows.map((r) => simulate(r.ctx, r.t, rule));
    const diffs = rs.map((x, j) => x - base[j]);
    const [lo, hi] = rule === RULES[0] ? [0, 0] : pairedCi(diffs, random);
    const wr = 100 * rs.filter((x) => x > 1e-9).length / rs.length;
    console.log(`${rule.name.padEnd(6)} ${fmt(mean(rs)).padStart(7)} ${fmt(rs.reduce((a, b) => a + b, 0), 1).padStart(8)}`
      + ` ${wr.toFixed(1).padStart(7)}   ${rule === RULES[0] ? "—" : `${fmt(mean(diffs))} [${fmt(lo)}; ${fmt(hi)}]`}`
      + `   ${rule.label}`);
  }
}

/** Đúng hiện tượng user thấy: dưới luật R0, lệnh đã lãi ≥ k R rồi vẫn chỉ ra ở entry (+0,33R). */
function givebackTable(title: string, rows: { ctx: Ctx; t: Entry }[]): void {
  const res = rows.map((r) => {
    const out = { mfe: 0 };
    const x = simulate(r.ctx, r.t, RULES[0], out);
    return { x, mfe: out.mfe };
  });
  const cells = [1.5, 2, 3].map((k) => {
    const reached = res.filter((r) => r.mfe >= k);
    const back = reached.filter((r) => r.x <= 0.33 + 1e-9).length;
    return `lãi ≥${k}R: ${reached.length} lệnh (${(100 * reached.length / res.length).toFixed(1)}%), về entry ${back} (${reached.length ? (100 * back / reached.length).toFixed(0) : "-"}%)`;
  });
  console.log(`  ${title.padEnd(16)} ${cells.join(" · ")}`);
}

function mfeTable(title: string, rows: { ctx: Ctx; t: Entry }[]): void {
  const mfes = rows.map((r) => mfeBeforeStop(r.ctx, r.t));
  const reach = (k: number) => mfes.filter((m) => m >= k).length;
  const cells = [0.5, 1, 1.5, 2, 3, 4, 5].map((k) => `≥${k}R ${(100 * reach(k) / mfes.length).toFixed(1)}%`);
  const cond = [1, 2, 3, 4].map((k) => {
    const n = reach(k);
    return `${k}→${k + 1}R ${n ? (100 * reach(k + 1) / n).toFixed(0) : "-"}% (rw ${(100 * (k + 1) / (k + 2)).toFixed(0)}%, n=${n})`;
  });
  console.log(`  ${title.padEnd(16)} n=${mfes.length} · ${cells.join(" · ")}`);
  console.log(`  ${"".padEnd(16)} có điều kiện: ${cond.join(" · ")}`);
}

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 500);
  const symbols = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_SYMBOLS;
  const bars = Math.ceil(days * TF_MS["1d"] / TF_MS["15m"]) + WARMUP_BARS;
  const random = rng(20261004);
  const real: { ctx: Ctx; t: Entry }[] = [];
  const fake: { ctx: Ctx; t: Entry }[] = [];
  let mismatched = 0;

  for (const symbol of symbols) {
    const raw = await fetchKlinesPaged(symbol, "15m", bars);
    const result = runKeyVolume(symbol, raw, KEY_VOLUME_CONFIG);
    const c = raw
      .filter((k) => Number.isFinite(k.open) && Number.isFinite(k.high) && Number.isFinite(k.low)
        && Number.isFinite(k.close) && k.high >= k.low)
      .sort((a, b) => a.openTime - b.openTime);
    const ctx = buildCtx(c);
    const atr = atrSeriesForward(c);
    const indexByTime = new Map<number, number>();
    c.forEach((k, i) => indexByTime.set(k.openTime, i));
    const firstEval = c.length - Math.ceil(days * TF_MS["1d"] / TF_MS["15m"]);

    for (const tr of result.trades as KeyVolumeTrade[]) {
      const e = indexByTime.get(tr.entryTime)!;
      const risk = Math.abs(tr.entryPrice - tr.initialSL);
      const t: Entry = {
        symbol, time: tr.entryTime, e,
        viaLimit: tr.branch === "key-lower-high" || tr.branch === "sweep-reclaim",
        dir: tr.dir, entry: tr.entryPrice, stop: tr.initialSL, risk,
        targetR: Math.abs(tr.target - tr.entryPrice) / risk, branch: tr.branch, engineR: tr.grossR,
      };
      if (Math.abs(simulate(ctx, t, RULES[0]) - tr.grossR) > 1e-6) mismatched++;
      real.push({ ctx, t });
      const riskAtr = risk / atr[e];
      for (let f = 0; f < FAKES_PER_TRADE; f++) {
        const fe = firstEval + Math.floor(random() * (c.length - firstEval - 1));
        const fr = riskAtr * atr[fe];
        const entry = c[fe].close;
        fake.push({
          ctx,
          t: {
            symbol, time: c[fe].openTime, e: fe, viaLimit: false, dir: tr.dir, entry,
            stop: tr.dir === "long" ? entry - fr : entry + fr, risk: fr, targetR: t.targetR, branch: "fake",
          },
        });
      }
    }
    console.log(`${symbol}: ${result.trades.length} lệnh`);
  }

  console.log(`\nPhát lại R0 lệch grossR engine: ${mismatched}/${real.length} lệnh`);
  const times = real.map((r) => r.t.time).sort((a, b) => a - b);
  const mid = times[Math.floor(times.length / 2)];
  const targetRs = real.map((r) => r.t.targetR).sort((a, b) => a - b);
  console.log(`Mục tiêu cấu trúc (R): trung vị ${targetRs[Math.floor(targetRs.length / 2)].toFixed(2)}`
    + ` · p25 ${targetRs[Math.floor(targetRs.length / 4)].toFixed(2)} · p75 ${targetRs[Math.floor(targetRs.length * 3 / 4)].toFixed(2)}`);

  console.log("\nMFE TRƯỚC KHI CHẠM SL GỐC (không mục tiêu, không dời SL, tối đa 30 ngày)");
  mfeTable("THẬT", real);
  mfeTable("GIẢ (ngẫu nhiên)", fake);
  for (const branch of [...new Set(real.map((r) => r.t.branch))]) {
    mfeTable(`thật · ${branch}`, real.filter((r) => r.t.branch === branch));
  }

  mfeTable("thật · BTC", real.filter((r) => r.t.symbol === "btcusdt"));

  console.log("\nLUẬT R0: ĐÃ LÃI XA RỒI VẪN VỀ ENTRY (MFE tính tới lúc thoát)");
  givebackTable("THẬT", real);
  givebackTable("GIẢ (ngẫu nhiên)", fake);
  givebackTable("thật · BTC", real.filter((r) => r.t.symbol === "btcusdt"));

  report("THẬT · tất cả", real, random);
  report("THẬT · nửa đầu", real.filter((r) => r.t.time < mid), random);
  report("THẬT · nửa sau", real.filter((r) => r.t.time >= mid), random);
  report("THẬT · BTC", real.filter((r) => r.t.symbol === "btcusdt"), random);
  report("THẬT · không BTC", real.filter((r) => r.t.symbol !== "btcusdt"), random);
  for (const branch of [...new Set(real.map((r) => r.t.branch))]) {
    report(`THẬT · nhánh ${branch}`, real.filter((r) => r.t.branch === branch), random);
  }
  report(`GIẢ · điểm vào ngẫu nhiên ×${FAKES_PER_TRADE}`, fake, random);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
