/**
 * portfolio-engine.ts — chạy engine Turtle trên NHIỀU symbol theo THỜI GIAN THỰC (lockstep),
 * để có thể áp ràng buộc CẤP DANH MỤC (trần risk cùng hướng, breadth gate, …) tại đúng thời điểm
 * mỗi unit được mở.
 *
 * VÌ SAO CẦN: `runTurtle` chạy từng symbol độc lập nên không thể biết "lúc này cả rổ đang giữ bao
 * nhiêu risk cùng hướng". Mọi câu hỏi về tương quan/đòn bẩy danh mục đều cần bước theo thời gian.
 *
 * BẤT BIẾN: khi `admit` luôn true, chuỗi trade sinh ra phải TRÙNG KHỚP 100% với việc gọi
 * `runTurtle` cho từng symbol (xem scripts/portfolio-equivalence.ts). Đây là chốt chặn chống
 * "engine thí nghiệm lệch engine production".
 */

import { Candle, CONFIG, TF_MS } from "../strategy";
import { T, TurtleParams, atrSeries, ema, priorDonchian, turtleInitialStop } from "../turtle";

const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

/** Bản sao chính xác của tradeCostR trong turtle.ts (file đó không export). */
export function tradeCostR(entry: number, initialSL: number, entryTime: number, exitTime: number): number {
  if (!CONFIG.costs.enabled) return 0;
  const riskFrac = Math.abs(entry - initialSL) / entry;
  if (riskFrac <= 0) return 0;
  const feeFrac = ((CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100) * 2;
  const periods = Math.max(
    0,
    Math.floor(exitTime / FUNDING_INTERVAL_MS) - Math.floor(entryTime / FUNDING_INTERVAL_MS),
  );
  const fundingFrac = (periods * CONFIG.costs.fundingPer8hPct) / 100;
  return (feeFrac + fundingFrac) / riskFrac;
}

export interface UnitTrade {
  /** Định danh sổ (symbol hoặc symbol@sleeve khi chạy nhiều tốc độ). */
  book: string;
  symbol: string;
  dir: "long" | "short";
  positionId: number;
  unitIndex: number; // 0 = unit khởi tạo vị thế
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "trail" | "mid" | "time";
  grossR: number;
  costR: number;
  netR: number;
  holdBars: number;
  /** Tỉ trọng risk của unit này (1 = full risk). Đóng góp danh mục = netR × weight. */
  weight: number;
}

/** Ảnh chụp một unit đang mở, dùng cho hàm admit và mark-to-market. */
export interface OpenUnit {
  book: string;
  symbol: string;
  dir: "long" | "short";
  positionId: number;
  unitIndex: number;
  entryTime: number;
  entry: number;
  initialSL: number;
  weight: number;
}

export interface AdmitCtx {
  time: number;
  symbol: string;
  dir: "long" | "short";
  kind: "entry" | "add";
  /** Các unit đang mở TRƯỚC khi unit này được thêm (toàn danh mục). */
  open: OpenUnit[];
  /** Số unit đang mở cùng hướng (toàn danh mục). */
  sameDirUnits: number;
  /** Số unit đang mở ngược hướng. */
  oppDirUnits: number;
  /** Tổng tỉ trọng risk đang mở cùng hướng / toàn bộ. */
  sameDirHeat: number;
  totalHeat: number;
}

/** Trả 0 = từ chối unit; 1 = full risk; 0<w<1 = vào với size nhỏ hơn. */
export type AdmitFn = (ctx: AdmitCtx) => number;

/** Chuỗi equity mark-to-market theo R (mỗi unit = 1R risk), lấy mẫu mỗi bar. */
export interface EquityPoint {
  time: number;
  realized: number; // tổng netR đã đóng
  mtm: number; // realized + unrealized (gross, chưa trừ phí phần chưa đóng)
  openUnits: number;
  longUnits: number;
  shortUnits: number;
}

export interface PortfolioResult {
  trades: UnitTrade[];
  equity: EquityPoint[];
  /** Số unit bị admit từ chối (chẩn đoán). */
  rejectedEntries: number;
  rejectedAdds: number;
}

type Unit = { entryIndex: number; entry: number; initialSL: number; unitIndex: number; weight: number };
type Pos = {
  dir: "long" | "short";
  positionId: number;
  units: Unit[];
  sl: number;
  extreme: number;
  midTrail: number | null;
};

/**
 * Chạy Turtle trên cả rổ theo lockstep thời gian.
 * Thứ tự trong mỗi bar: (1) quản lý vị thế đang mở của MỌI symbol (exit → trail → pyramid add),
 * (2) tìm lệnh mới của MỌI symbol. Nhờ vậy capacity được giải phóng bởi exit dùng được ngay,
 * và pyramid add (unit của trend đang chạy) được ưu tiên hơn entry mới — đúng thứ tự vốn có
 * trong `runTurtle`, không phải một luật ưu tiên mới.
 */
/**
 * Tham số mở rộng CHỈ DÙNG CHO THÍ NGHIỆM (`longExitDays` đã lên production trong `T`).
 * `0`/undefined = giữ nguyên hành vi production.
 */
export type ExtParams = TurtleParams & { shortExitDays?: number };

/** Một "sổ" độc lập = (symbol, bộ tham số). Nhiều sổ trên cùng symbol = nhiều tốc độ tín hiệu. */
export interface Book {
  key: string;
  symbol: string;
  candles: Candle[];
  p: ExtParams;
}

export function runTurtlePortfolio(
  data: Map<string, Candle[]>,
  p: TurtleParams = T,
  admit?: AdmitFn,
): PortfolioResult {
  return runBooks(
    [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p })),
    admit,
  );
}

export function runBooks(books: Book[], admit?: AdmitFn): PortfolioResult {
  // Tiền xử lý chỉ báo + index theo thời gian cho từng sổ
  type Ctx = {
    book: Book;
    c: Candle[];
    p: ExtParams;
    dcEntry: number;
    dcShortEntry: number;
    dcLongExit: number;
    dcShortExit: number;
    maxHoldBars: number;
    warmup: number;
    emaArr: number[];
    ema2Arr: number[] | null;
    atr: number[];
    volSma: number[] | null;
    idxOf: Map<number, number>;
    pos: Pos | null;
    cooldownUntil: number;
  };
  const ctxs = new Map<string, Ctx>();
  const allTimes = new Set<number>();
  for (const book of books) {
    const { p } = book;
    const c = book.candles;
    const barsPerDay = TF_MS["1d"] / TF_MS[p.tf];
    const dcEntry = Math.max(2, Math.round(p.entryDays * barsPerDay));
    const dcShortEntry = p.shortEntryDays > 0 ? Math.max(2, Math.round(p.shortEntryDays * barsPerDay)) : dcEntry;
    const dcLongExit = p.longExitDays && p.longExitDays > 0 ? Math.max(2, Math.round(p.longExitDays * barsPerDay)) : dcEntry;
    const dcShortExit = p.shortExitDays && p.shortExitDays > 0 ? Math.max(2, Math.round(p.shortExitDays * barsPerDay)) : dcShortEntry;
    const warmup = Math.max(dcEntry, dcShortEntry, dcLongExit, dcShortExit, p.trendLen, p.trendLen2, p.atrPeriod) + 1;
    const closes = c.map((x) => x.close);
    let volSma: number[] | null = null;
    if (p.confirmVolMult > 0) {
      volSma = new Array(c.length).fill(0);
      let s = 0;
      for (let i = 0; i < c.length; i++) {
        s += c[i].volume;
        if (i >= 20) s -= c[i - 20].volume;
        volSma[i] = s / Math.min(i + 1, 20);
      }
    }
    const idxOf = new Map<number, number>();
    for (let i = 0; i < c.length; i++) {
      idxOf.set(c[i].openTime, i);
      if (i >= warmup) allTimes.add(c[i].openTime);
    }
    ctxs.set(book.key, {
      book,
      c,
      p,
      dcEntry,
      dcShortEntry,
      dcLongExit,
      dcShortExit,
      maxHoldBars: Math.round(p.maxHoldDays * barsPerDay),
      warmup,
      emaArr: ema(closes, p.trendLen),
      ema2Arr: p.trendLen2 > 0 ? ema(closes, p.trendLen2) : null,
      atr: atrSeries(c, p.atrPeriod),
      volSma,
      idxOf,
      pos: null,
      cooldownUntil: -1,
    });
  }
  const symbols = books.map((b) => b.key);

  const times = [...allTimes].sort((a, b) => a - b);
  const trades: UnitTrade[] = [];
  const equity: EquityPoint[] = [];
  let realized = 0;
  let nextPositionId = 1;
  let rejectedEntries = 0;
  let rejectedAdds = 0;

  const snapshotOpen = (): OpenUnit[] => {
    const out: OpenUnit[] = [];
    for (const sym of symbols) {
      const ctx = ctxs.get(sym)!;
      if (!ctx.pos) continue;
      for (const u of ctx.pos.units) {
        out.push({
          book: sym,
          symbol: ctx.book.symbol,
          dir: ctx.pos.dir,
          positionId: ctx.pos.positionId,
          unitIndex: u.unitIndex,
          entryTime: ctx.c[u.entryIndex].openTime,
          entry: u.entry,
          initialSL: u.initialSL,
          weight: u.weight,
        });
      }
    }
    return out;
  };

  /** Trả tỉ trọng risk cho unit sắp mở (0 = bỏ). */
  const askAdmit = (kind: "entry" | "add", time: number, symbol: string, dir: "long" | "short"): number => {
    if (!admit) return 1;
    const open = snapshotOpen();
    let same = 0,
      sameHeat = 0,
      totalHeat = 0;
    for (const u of open) {
      totalHeat += u.weight;
      if (u.dir === dir) {
        same++;
        sameHeat += u.weight;
      }
    }
    const w = admit({
      time,
      symbol,
      dir,
      kind,
      open,
      sameDirUnits: same,
      oppDirUnits: open.length - same,
      sameDirHeat: sameHeat,
      totalHeat,
    });
    return Math.max(0, Math.min(1, w));
  };

  for (const t of times) {
    // Symbol vừa exit trong bar này KHÔNG được vào lệnh mới cùng bar (giữ đúng `continue` của runTurtle).
    const exitedThisBar = new Set<string>();

    // ── Bước 1/2 cho MỖI symbol: quản lý vị thế đang mở (exit → trail → pyramid add) ──
    // Hai vòng lặp dưới đây LỒNG NHAU theo symbol trong `stepSymbol` để khớp ĐÚNG thứ tự của
    // `TurtleLive.step()` (live xử lý trọn vẹn từng symbol rồi mới sang symbol kế) — quan trọng khi
    // `admit` phụ thuộc trạng thái danh mục: thứ tự khác ⇒ tỉ trọng risk khác.
    for (const sym of symbols) {
      manageOpen(sym);
      tryEntry(sym);
    }

    function manageOpen(sym: string) {
      const ctx = ctxs.get(sym)!;
      const i = ctx.idxOf.get(t);
      if (i === undefined || i < ctx.warmup || !ctx.pos) return;
      const { p, dcLongExit, dcShortExit, maxHoldBars } = ctx;
      const c = ctx.c;
      const bar = c[i];
      const pos = ctx.pos;
      const longExitCh = priorDonchian(c, i, dcLongExit);
      const shortExitCh = dcShortExit === dcLongExit ? longExitCh : priorDonchian(c, i, dcShortExit);
      const longMidClose = (longExitCh.closeHigh + longExitCh.closeLow) / 2;
      const shortMidClose = (shortExitCh.closeHigh + shortExitCh.closeLow) / 2;

      const held = i - pos.units[0].entryIndex;
      let exitPrice: number | null = null;
      let reason: UnitTrade["exitReason"] | null = null;

      if (pos.dir === "long") {
        if (bar.low <= pos.sl) {
          exitPrice = pos.sl;
          reason = "trail";
        } else if (p.longExitMode === "mid" && pos.midTrail !== null && bar.close <= pos.midTrail) {
          exitPrice = bar.close;
          reason = "mid";
        } else if (held >= maxHoldBars) {
          exitPrice = bar.close;
          reason = "time";
        }
      } else {
        if (bar.high >= pos.sl) {
          exitPrice = pos.sl;
          reason = "trail";
        } else if (p.shortExitMode === "mid" && pos.midTrail !== null && bar.close >= pos.midTrail) {
          exitPrice = bar.close;
          reason = "mid";
        } else if (held >= maxHoldBars) {
          exitPrice = bar.close;
          reason = "time";
        }
      }

      if (exitPrice !== null && reason !== null) {
        for (const u of pos.units) {
          const risk = Math.abs(u.entry - u.initialSL);
          const pnl = pos.dir === "long" ? exitPrice - u.entry : u.entry - exitPrice;
          const grossR = risk > 0 ? pnl / risk : 0;
          const entryTime = c[u.entryIndex].openTime;
          const costR = tradeCostR(u.entry, u.initialSL, entryTime, t);
          const netR = grossR - costR;
          realized += netR * u.weight;
          trades.push({
            book: sym,
            symbol: ctx.book.symbol,
            dir: pos.dir,
            positionId: pos.positionId,
            unitIndex: u.unitIndex,
            entryTime,
            entryPrice: u.entry,
            initialSL: u.initialSL,
            exitTime: t,
            exitPrice,
            exitReason: reason,
            grossR,
            costR,
            netR,
            holdBars: i - u.entryIndex,
            weight: u.weight,
          });
        }
        ctx.cooldownUntil = i + p.cooldownBars;
        ctx.pos = null;
        exitedThisBar.add(sym);
        return;
      }

      // Trailing ratchet
      if (pos.dir === "long") {
        if (p.longExitMode === "mid") pos.midTrail = Math.max(pos.midTrail ?? pos.sl, longMidClose);
        else {
          pos.extreme = Math.max(pos.extreme, bar.high);
          const trail = pos.extreme - p.chandelierMult * ctx.atr[i];
          if (trail > pos.sl) pos.sl = trail;
        }
      } else {
        if (p.shortExitMode === "mid") pos.midTrail = Math.min(pos.midTrail ?? pos.sl, shortMidClose);
        else {
          pos.extreme = Math.min(pos.extreme, bar.low);
          const trail = pos.extreme + p.chandelierMult * ctx.atr[i];
          if (trail < pos.sl) pos.sl = trail;
        }
      }

      // Pyramid add
      if (p.pyramidStepAtr > 0 && pos.units.length < p.pyramidMaxUnits && ctx.atr[i] > 0) {
        const last = pos.units[pos.units.length - 1];
        if (pos.dir === "long" && bar.close >= last.entry + p.pyramidStepAtr * ctx.atr[i]) {
          const initialSL = turtleInitialStop(c, i, "long", bar.close, ctx.atr[i], p).price;
          if (initialSL > 0) {
            const w = askAdmit("add", t, sym, "long");
            if (w > 0) {
              pos.units.push({ entryIndex: i, entry: bar.close, initialSL, unitIndex: pos.units.length, weight: w });
              if (p.longExitMode === "mid") pos.sl = Math.max(pos.sl, initialSL);
            } else rejectedAdds++;
          }
        } else if (pos.dir === "short" && bar.close <= last.entry - p.pyramidStepAtr * ctx.atr[i]) {
          const initialSL = turtleInitialStop(c, i, "short", bar.close, ctx.atr[i], p).price;
          const w = askAdmit("add", t, sym, "short");
          if (w > 0) {
            pos.units.push({ entryIndex: i, entry: bar.close, initialSL, unitIndex: pos.units.length, weight: w });
            if (p.shortExitMode === "mid") pos.sl = Math.min(pos.sl, initialSL);
          } else rejectedAdds++;
        }
      }
    }

    // ── Bước 2/2 cho MỖI symbol: tìm lệnh mới ──
    function tryEntry(sym: string) {
      const ctx = ctxs.get(sym)!;
      const i = ctx.idxOf.get(t);
      if (i === undefined || i < ctx.warmup || ctx.pos || i < ctx.cooldownUntil || exitedThisBar.has(sym)) return;
      const { p, dcEntry, dcShortEntry, dcLongExit, dcShortExit } = ctx;
      const c = ctx.c;
      const bar = c[i];
      const longChannel = priorDonchian(c, i, dcEntry);
      const shortChannel = dcShortEntry === dcEntry ? longChannel : priorDonchian(c, i, dcShortEntry);
      const longExitCh = dcLongExit === dcEntry ? longChannel : priorDonchian(c, i, dcLongExit);
      const shortExitCh = dcShortExit === dcShortEntry ? shortChannel : priorDonchian(c, i, dcShortExit);
      const longMidClose = (longExitCh.closeHigh + longExitCh.closeLow) / 2;
      const shortMidClose = (shortExitCh.closeHigh + shortExitCh.closeLow) / 2;

      const uptrend = bar.close > ctx.emaArr[i] && (!ctx.ema2Arr || bar.close > ctx.ema2Arr[i]);
      const downtrend = bar.close < ctx.emaArr[i] && (!ctx.ema2Arr || bar.close < ctx.ema2Arr[i]);
      const buf = p.entryBufferAtr > 0 ? p.entryBufferAtr * ctx.atr[i] : 0;
      const volOk =
        !ctx.volSma || (i > 0 && ctx.volSma[i - 1] > 0 && bar.volume >= p.confirmVolMult * ctx.volSma[i - 1]);
      const longBreakout = p.longEntrySource === "close" ? longChannel.closeHigh : longChannel.high;
      const shortBreakout = p.shortEntrySource === "close" ? shortChannel.closeLow : shortChannel.low;

      if (uptrend && volOk && (!p.gate || p.gate(bar.openTime, "long")) && bar.close > longBreakout + buf) {
        const entry = bar.close;
        const initialSL = turtleInitialStop(c, i, "long", entry, ctx.atr[i], p).price;
        if (initialSL > 0 && initialSL < entry) {
          const w = askAdmit("entry", t, sym, "long");
          if (w > 0) {
            ctx.pos = {
              dir: "long",
              positionId: nextPositionId++,
              units: [{ entryIndex: i, entry, initialSL, unitIndex: 0, weight: w }],
              sl: initialSL,
              extreme: bar.high,
              midTrail: p.longExitMode === "mid" ? Math.max(initialSL, longMidClose) : null,
            };
          } else rejectedEntries++;
        }
      } else if (
        p.allowShort &&
        downtrend &&
        volOk &&
        (!p.gate || p.gate(bar.openTime, "short")) &&
        bar.close < shortBreakout - buf
      ) {
        const entry = bar.close;
        const initialSL = turtleInitialStop(c, i, "short", entry, ctx.atr[i], p).price;
        if (initialSL > entry) {
          const w = askAdmit("entry", t, sym, "short");
          if (w > 0) {
            ctx.pos = {
              dir: "short",
              positionId: nextPositionId++,
              units: [{ entryIndex: i, entry, initialSL, unitIndex: 0, weight: w }],
              sl: initialSL,
              extreme: bar.low,
              midTrail: p.shortExitMode === "mid" ? Math.min(initialSL, shortMidClose) : null,
            };
          } else rejectedEntries++;
        }
      }
    }

    // ── Mark-to-market cuối bar ──
    let unreal = 0;
    let openCount = 0;
    let longUnits = 0;
    let shortUnits = 0;
    for (const sym of symbols) {
      const ctx = ctxs.get(sym)!;
      const i = ctx.idxOf.get(t);
      if (i === undefined || !ctx.pos) continue;
      const px = ctx.c[i].close;
      for (const u of ctx.pos.units) {
        const risk = Math.abs(u.entry - u.initialSL);
        if (risk <= 0) continue;
        unreal += ((ctx.pos.dir === "long" ? px - u.entry : u.entry - px) / risk) * u.weight;
        openCount++;
        if (ctx.pos.dir === "long") longUnits += u.weight;
        else shortUnits += u.weight;
      }
    }
    equity.push({ time: t, realized, mtm: realized + unreal, openUnits: openCount, longUnits, shortUnits });
  }

  return { trades, equity, rejectedEntries, rejectedAdds };
}

// ─────────────────────────────────────────────
// METRICS cấp danh mục
// ─────────────────────────────────────────────
export interface PortfolioStats {
  n: number;
  positions: number;
  net: number;
  exp: number;
  wr: number;
  ddRealized: number;
  ddMtm: number;
  netOverDd: number; // NET / maxDD(MTM) — bất biến với đòn bẩy → metric so sánh chính
  peakUnits: number;
  peakSameDir: number;
  avgOpenUnits: number;
}

/**
 * Equity compounding từ chuỗi mark-to-market R với `risk` phần trăm equity mỗi unit.
 * Dùng để so sánh CÔNG BẰNG giữa các chính sách: một chính sách giảm DD có thể chạy đòn bẩy cao
 * hơn để về đúng mức DD cũ — chỉ khi đó "NET R cao hơn" mới có ý nghĩa kinh tế.
 */
export function compoundedEquity(equity: EquityPoint[], riskPerUnit: number): { mult: number; maxDD: number } {
  let e = 1,
    peak = 1,
    dd = 0;
  for (let i = 1; i < equity.length; i++) {
    const d = equity[i].mtm - equity[i - 1].mtm;
    e *= 1 + d * riskPerUnit;
    if (e <= 0) return { mult: 0, maxDD: 1 };
    peak = Math.max(peak, e);
    dd = Math.max(dd, (peak - e) / peak);
  }
  return { mult: e, maxDD: dd };
}

/** Tìm risk/unit sao cho maxDD compounding = targetDD (bisection). */
export function riskForTargetDD(equity: EquityPoint[], targetDD: number): number {
  let lo = 0.0001,
    hi = 0.2;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (compoundedEquity(equity, mid).maxDD > targetDD) hi = mid;
    else lo = mid;
  }
  return lo;
}

/**
 * Chỉ số rủi ro trên chuỗi P&L NGÀY (R) — dùng thay/kèm maxDD vì maxDD chỉ là MỘT quan sát cực trị
 * nên rất nhiễu khi so sánh nhiều biến thể. Sharpe & Ulcer dùng toàn bộ dữ liệu và bất biến đòn bẩy.
 */
export interface RiskMetrics {
  days: number;
  netR: number;
  sharpe: number; // annualized, trên P&L ngày (R)
  sortino: number;
  ulcer: number; // RMS drawdown (R)
  netOverUlcer: number;
  maxDD: number;
  netOverMaxDD: number;
  skew: number;
  worstMonthR: number;
}

export function riskMetrics(equity: EquityPoint[]): RiskMetrics {
  if (equity.length < 3) {
    return { days: 0, netR: 0, sharpe: 0, sortino: 0, ulcer: 0, netOverUlcer: 0, maxDD: 0, netOverMaxDD: 0, skew: 0, worstMonthR: 0 };
  }
  const DAY = 24 * 3600 * 1000;
  // gộp về P&L theo ngày lịch
  const perDay = new Map<number, number>();
  for (let i = 1; i < equity.length; i++) {
    const d = Math.floor(equity[i].time / DAY);
    perDay.set(d, (perDay.get(d) ?? 0) + (equity[i].mtm - equity[i - 1].mtm));
  }
  const days = [...perDay.keys()].sort((a, b) => a - b);
  const r = days.map((d) => perDay.get(d)!);
  const n = r.length;
  const mean = r.reduce((s, x) => s + x, 0) / n;
  const varr = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(varr);
  const down = r.filter((x) => x < 0);
  const dsd = down.length ? Math.sqrt(down.reduce((s, x) => s + x * x, 0) / down.length) : 0;
  const m3 = r.reduce((s, x) => s + (x - mean) ** 3, 0) / n;
  const skew = sd > 0 ? m3 / sd ** 3 : 0;

  let cum = 0,
    peak = 0,
    maxDD = 0,
    sumSq = 0;
  for (const x of r) {
    cum += x;
    peak = Math.max(peak, cum);
    const dd = peak - cum;
    maxDD = Math.max(maxDD, dd);
    sumSq += dd * dd;
  }
  const ulcer = Math.sqrt(sumSq / n);

  // tháng tệ nhất
  const perMonth = new Map<string, number>();
  for (let i = 0; i < days.length; i++) {
    const k = new Date(days[i] * DAY).toISOString().slice(0, 7);
    perMonth.set(k, (perMonth.get(k) ?? 0) + r[i]);
  }
  const worstMonthR = Math.min(...perMonth.values());

  const netR = cum;
  return {
    days: n,
    netR,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    sortino: dsd > 0 ? (mean / dsd) * Math.sqrt(365) : 0,
    ulcer,
    netOverUlcer: ulcer > 0 ? netR / ulcer : 0,
    maxDD,
    netOverMaxDD: maxDD > 0 ? netR / maxDD : 0,
    skew,
    worstMonthR,
  };
}

export function portfolioStats(res: PortfolioResult, opts?: { from?: number; to?: number }): PortfolioStats {
  const from = opts?.from ?? -Infinity;
  const to = opts?.to ?? Infinity;
  const trades = res.trades.filter((t) => t.entryTime >= from && t.entryTime <= to);
  const eq = res.equity.filter((e) => e.time >= from && e.time <= to);
  const n = trades.length;
  const net = trades.reduce((s, t) => s + t.netR * t.weight, 0);
  const totalWeight = trades.reduce((s, t) => s + t.weight, 0);
  const wins = trades.filter((t) => t.netR > 0).length;

  // maxDD realized: theo thứ tự đóng lệnh
  const byExit = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let cum = 0,
    peak = 0,
    ddR = 0;
  for (const t of byExit) {
    cum += t.netR * t.weight;
    peak = Math.max(peak, cum);
    ddR = Math.max(ddR, peak - cum);
  }
  // maxDD mark-to-market
  let peakM = -Infinity,
    ddM = 0,
    peakUnits = 0,
    peakSame = 0,
    sumUnits = 0;
  const base = eq.length ? eq[0].mtm : 0;
  for (const e of eq) {
    const v = e.mtm - base;
    peakM = Math.max(peakM, v);
    ddM = Math.max(ddM, peakM - v);
    peakUnits = Math.max(peakUnits, e.openUnits);
    peakSame = Math.max(peakSame, e.longUnits, e.shortUnits);
    sumUnits += e.openUnits;
  }
  const positions = new Set(trades.map((t) => `${t.symbol}#${t.positionId}`)).size;
  return {
    n,
    positions,
    net,
    exp: totalWeight ? net / totalWeight : 0,
    wr: n ? (wins / n) * 100 : 0,
    ddRealized: ddR,
    ddMtm: ddM,
    netOverDd: ddM > 0 ? net / ddM : 0,
    peakUnits,
    peakSameDir: peakSame,
    avgOpenUnits: eq.length ? sumUnits / eq.length : 0,
  };
}
