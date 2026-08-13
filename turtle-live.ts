/**
 * turtle-live.ts — Turtle/Donchian (turtle.ts) chạy LIVE trong bot chính, song song lớp SMC.
 *
 * Nguyên tắc:
 *   - Tín hiệu = ĐÚNG engine backtest (turtle.ts) trên nến 4h ĐÃ ĐÓNG. Hybrid LONG phá đỉnh
 *     close 15d, thoát khi close dưới midpoint close-channel đã ratchet; SHORT phá đáy close 30d
 *     + Chandelier 3×ATR. Initial SL dùng opposite-candle OB trong envelope 1.5-4×ATR,
 *     fallback 3×ATR. Cả hai dùng EMA50, BTC gate LONG, pyramid ≤4 unit và time-stop 60d.
 *   - THỰC THI tái dùng LiveTrader: MARKET vào lệnh, SL = STOP_MARKET closePosition trên sàn
 *     (1 stop chung cho mọi unit — khớp thiết kế trail chung), KHÔNG đặt TP (noTp: trailing thuần).
 *   - LOẠI TRỪ THEO SYMBOL với SMC: SL closePosition đóng CẢ vị thế symbol → 2 chiến lược không
 *     được giữ cùng symbol. Turtle bỏ entry khi SMC đang giữ; chiều ngược lại guard trong bot.
 *   - Trần risk danh mục CHUNG với SMC: mỗi unit mở chiếm riskPct; vượt trần → bỏ entry/add.
 *   - State `turtle-state.json` + journal `turtle-trades.jsonl` RIÊNG — không đụng file SMC.
 *   - Restart: replay các nến 4h bị lỡ (kể cả cold-start: dựng lại vị thế bằng silent replay,
 *     rồi đối soát với sàn — giống pattern silent-scan + adopt của bot SMC).
 */
import fs from "fs";
import path from "path";
import { fetchFuturesKlinesPaged } from "./backtest";
import { Candle, TF_MS } from "./strategy";
import { T, buildBtcGateLongs, ema, atrSeries, priorDonchian, turtleInitialStop } from "./turtle";
import { BinanceFutures } from "./binance-futures";
import { LiveTrader, PosInfo } from "./live-trade";
import { ExitFillAudit, formatExitFillAudit } from "./exit-fill-audit";
import { TelegramConfig, sendTelegram, formatSymbol, fmtPrice, formatTimeVn } from "./telegram";
import { atomicWriteFileSync } from "./atomic-file";

const DATA_DIR = path.resolve(process.env.TRADING_DATA_DIR?.trim() || process.cwd());
const STATE_FILE = path.join(DATA_DIR, "turtle-state.json");
const JOURNAL_FILE = path.join(DATA_DIR, "turtle-trades.jsonl");

const TF = T.tf; // 4h
const tfMs = TF_MS[TF];
const BARS_PER_DAY = TF_MS["1d"] / tfMs;
const DC_ENTRY = Math.max(2, Math.round(T.entryDays * BARS_PER_DAY)); // 90 nến
const DC_SHORT_ENTRY = T.shortEntryDays > 0
  ? Math.max(2, Math.round(T.shortEntryDays * BARS_PER_DAY))
  : DC_ENTRY;
/** Kênh THOÁT của LONG (midpoint ratchet) — tách khỏi kênh vào, xem `T.longExitDays`. */
const DC_LONG_EXIT = T.longExitDays > 0 ? Math.max(2, Math.round(T.longExitDays * BARS_PER_DAY)) : DC_ENTRY;
const MAX_HOLD_BARS = Math.round(T.maxHoldDays * BARS_PER_DAY); // 360 nến
// Fetch đủ: warmup gate SMA100d (600) + replay tối đa ~80 ngày (> maxHold 60d) → phát hiện được
// mọi vị thế đang mở kể cả cold-start.
const FETCH_BARS = 1100;
const WARMUP_BARS = Math.max(DC_ENTRY, DC_SHORT_ENTRY, DC_LONG_EXIT, T.trendLen, T.atrPeriod, T.btcGateSlow) + 1;
const SETTLE_MS = 90_000; // đợi nến 4h chốt hẳn trên sàn rồi mới xử lý
const CHECK_MS = 60_000; // nhịp kiểm tra mốc 4h
const RECONCILE_MS = 10 * 60_000; // lưới an toàn: đối soát vị thế thật với sàn

type TurtleUnit = {
  entry: number; // giá tín hiệu (close nến) — dùng cho R, khớp backtest
  initialSL: number; // stop OB+ATR hoặc fallback 3×ATR — mẫu số R của unit
  entryTime: number; // openTime nến vào
  qty?: number; // khối lượng thật đã khớp (undefined = paper)
  realEntry?: number; // giá khớp thật
  riskUsd?: number;
  // risk HIỆU DỤNG/equity lúc fill — có thể > riskPct danh nghĩa khi qty bị nâng lên sàn
  // minNotional (vd BTC min 100 USDT với equity nhỏ). Tổng riskFrac 1 vị thế luôn bị chặn
  // bởi ngân sách maxUnits×riskPct → "giữ nguyên risk" ở cấp vị thế.
  riskFrac?: number;
  // Tỉ trọng risk theo chính sách heat cấp danh mục (xem heatWeight); undefined = 1 (state cũ).
  weight?: number;
};

type TurtleExitReason = "trail" | "mid" | "time" | "reconcile";

type TurtlePos = {
  dir: "long" | "short";
  units: TurtleUnit[];
  sl: number; // hard stop chung đang đặt trên sàn
  midTrail?: number; // close-based exit khi mode midpoint; optional để migrate state engine cũ
  extreme: number; // đỉnh/đáy kể từ entry — cho chandelier
  real: boolean; // true = có lệnh thật trên sàn
  pendingExit?: { exitPrice: number; reason: TurtleExitReason; exitTime: number };
};

type TurtleSymbolState = {
  symbol: string;
  lastBarTime: number; // openTime nến 4h ĐÃ xử lý cuối
  pos: TurtlePos | null;
};

export interface TurtleLiveOpts {
  symbols: string[];
  api: BinanceFutures | null; // null → alert-only
  trader: LiveTrader | null; // LiveTrader riêng với riskPct của turtle
  telegram: TelegramConfig;
  riskPct: number; // frac equity / unit (vd 0.01)
  maxPortfolioRiskPct: number; // trần CHUNG với SMC
  leverage: number; // để guard SL rộng hơn vùng thanh lý
  /** SMC (hoặc lớp khác) đang giữ symbol này? → turtle không vào. */
  otherHoldsSymbol: (symbol: string) => boolean;
  /** Tổng risk frac các vị thế lớp khác đang mở (cho trần chung). */
  otherOpenRiskFrac: () => number;
  /** Lớp thực thi đã preflight OK chưa (cờ tradingReady của bot). */
  isTradingReady: () => boolean;
}

export class TurtleLive {
  private readonly states = new Map<string, TurtleSymbolState>();
  private lastBoundary = 0;
  private cycling = false; // khoá chống 2 cycle chồng nhau
  /**
   * Ảnh chụp heat ĐẦU NẾN theo hướng; null = chấm tức thời (ngoài vòng replay).
   * Xem `heatWeight` — đây là thứ làm tỉ trọng risk KHÔNG phụ thuộc thứ tự symbol.
   */
  private barHeat: Map<"long" | "short", number> | null = null;

  constructor(private readonly o: TurtleLiveOpts) {}

  // ── State & journal ─────────────────────────────────────────────────────
  private persist(): void {
    try {
      atomicWriteFileSync(STATE_FILE, JSON.stringify([...this.states.values()], null, 2));
    } catch (e) {
      console.error("[Turtle] ghi turtle-state.json lỗi:", e instanceof Error ? e.message : e);
    }
  }

  private journal(rec: Record<string, unknown>): void {
    try {
      fs.appendFileSync(JOURNAL_FILE, JSON.stringify({ strategy: "turtle", ...rec }) + "\n");
    } catch (e) {
      console.error("[Turtle] ghi turtle-trades.jsonl lỗi:", e instanceof Error ? e.message : e);
    }
  }

  private loadState(): void {
    let saved: TurtleSymbolState[] = [];
    try {
      if (fs.existsSync(STATE_FILE)) saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch (e) {
      console.error("[Turtle] đọc turtle-state.json lỗi, khởi động sạch:", e instanceof Error ? e.message : e);
    }
    const bySym = new Map(saved.map((s) => [s.symbol, s]));
    for (const sym of this.o.symbols) {
      const s = bySym.get(sym);
      this.states.set(sym, s ? { ...s, pos: s.pos ? { ...s.pos, units: [...s.pos.units] } : null } : { symbol: sym, lastBarTime: 0, pos: null });
    }
  }

  // ── Truy vấn cho lớp SMC (guard + trần risk chung) ──────────────────────
  hasPosition(symbol: string): boolean {
    return !!this.states.get(symbol.toLowerCase())?.pos;
  }

  /** Turtle đang giữ vị thế THẬT trên symbol? (vị thế "giấy" không chặn lớp khác) */
  hasRealPosition(symbol: string): boolean {
    return !!this.states.get(symbol.toLowerCase())?.pos?.real;
  }

  /** Tổng risk frac HIỆU DỤNG các unit THẬT đang mở (paper không chiếm trần). */
  openRiskFrac(): number {
    let n = 0;
    for (const st of this.states.values()) {
      if (!st.pos?.real) continue;
      for (const u of st.pos.units) if (u.qty != null) n += u.riskFrac ?? this.o.riskPct;
    }
    return n;
  }

  /** Ngân sách risk tối đa cho MỘT vị thế (bất biến với sàn minNotional): maxUnits × riskPct. */
  private positionRiskBudget(): number {
    return T.pyramidMaxUnits * this.o.riskPct;
  }

  /**
   * Tỉ trọng risk cho unit SẮP mở, theo mức "đông đúc" cùng hướng của cả sổ turtle:
   *   w = 1 / (1 + heat / T.heatDecayK),  heat = tổng tỉ trọng các unit đang mở cùng hướng.
   *
   * Vì sao: rổ 8 large-cap crypto có tương quan ~0,85 — 24 unit cùng hướng KHÔNG phải 24 cược độc
   * lập. Không có chính sách này, risk danh mục dao động 0→24 đơn vị và chính sự dao động đó (chứ
   * không phải chất lượng lệnh) làm hỏng tỉ số lợi nhuận/rủi ro. Unit vào lúc sổ đông KHÔNG kém hơn
   * (Spearman(heat, netR) = −0,025) nên ta chỉ NHỎ SIZE, KHÔNG BAO GIỜ bỏ lệnh.
   *
   * Đếm cả vị thế "giấy" để live khớp đúng backtest đã audit (backtest không phân biệt giấy/thật).
   *
   * HEAT LẤY TỪ ẢNH CHỤP ĐẦU NẾN, không đọc sổ tức thời. Vì sao: trong một mốc thời gian, `replay`
   * duyệt lần lượt từng symbol; nếu chấm tức thời thì symbol đứng TRƯỚC trong mảng gặp sổ vắng hơn
   * và được size to hơn — một chênh lệch sinh ra từ vị trí trong mảng, không phải từ luật giao dịch.
   * Đo được: đổi thứ tự symbol làm vốn cuối chênh 9% (k=4) đến 40% (k=0,25). Chấm theo ảnh chụp đầu
   * nến đưa biên độ đó về ĐÚNG 0%. Đây chính là `admitBarSnapshot` của engine nghiên cứu
   * (`scripts/portfolio-engine.ts`), nay có mặt ở live để hai bên khớp nhau.
   */
  private heatWeight(dir: "long" | "short"): number {
    if (!(T.heatDecayK > 0)) return 1;
    const heat = this.barHeat?.get(dir) ?? this.currentHeat(dir);
    return 1 / (1 + heat / T.heatDecayK);
  }

  /** Tổng tỉ trọng các unit đang mở cùng hướng, đọc tức thời từ sổ. */
  private currentHeat(dir: "long" | "short"): number {
    let heat = 0;
    for (const st of this.states.values()) {
      if (st.pos?.dir !== dir) continue;
      for (const u of st.pos.units) heat += u.weight ?? 1;
    }
    return heat;
  }

  /** Tổng risk frac hiệu dụng các unit thật của một vị thế. */
  private positionRiskFrac(pos: TurtlePos): number {
    let n = 0;
    for (const u of pos.units) if (u.qty != null) n += u.riskFrac ?? this.o.riskPct;
    return n;
  }

  statusLines(): string[] {
    const lines: string[] = [];
    for (const st of this.states.values()) {
      if (!st.pos) continue;
      const p = st.pos;
      const icon = p.dir === "long" ? "🐢🟢 LONG" : "🐢🔴 SHORT";
      const heldD = ((Date.now() - p.units[0].entryTime) / TF_MS["1d"]).toFixed(1);
      lines.push(
        `${icon} *${formatSymbol(st.symbol)}*${p.real ? "" : " (giấy)"} — ${p.units.length}/${T.pyramidMaxUnits} unit`,
        `Entry₁ $${fmtPrice(p.units[0].entry)} · hard SL $${fmtPrice(p.sl)}${Number.isFinite(p.midTrail) ? ` · mid-close $${fmtPrice(p.midTrail!)}` : ""}${p.pendingExit ? " · ⚠️ chờ đóng" : ""} · giữ ${heldD}d`,
        ``
      );
    }
    return lines;
  }

  // ── Helpers thực thi ─────────────────────────────────────────────────────
  private tradingLive(): boolean {
    return !!this.o.trader && this.o.isTradingReady();
  }

  private async tg(msg: string): Promise<void> {
    await sendTelegram(this.o.telegram, msg);
  }

  private totalOpenRiskFrac(): number {
    return this.o.otherOpenRiskFrac() + this.openRiskFrac();
  }

  /** Đảm bảo trên sàn có đúng 1 STOP_MARKET tại pos.sl (sau add / sau adopt). */
  private async ensureStop(symbol: string, pos: TurtlePos): Promise<void> {
    if (!this.o.trader) return;
    await this.o.trader.syncStops(symbol, this.posInfo(pos), { noTp: true });
  }

  /** `sizeMult` = tỉ trọng risk của unit sắp mở (LiveTrader nhân riskPct với nó). */
  private posInfo(pos: TurtlePos, sizeMult = 1): PosInfo {
    // target không dùng (noTp) — đặt mốc không với tới cho an toàn nếu code khác đọc nhầm
    const u0 = pos.units[0];
    return {
      dir: pos.dir,
      initialSL: u0.initialSL,
      sl: pos.sl,
      target: pos.dir === "long" ? u0.entry * 100 : u0.entry * 0.01,
      sizeMult,
    };
  }

  // ── Sự kiện: entry / add / exit ─────────────────────────────────────────
  private async openPosition(
    st: TurtleSymbolState,
    candles: Candle[],
    i: number,
    dir: "long" | "short",
    atrNow: number,
    midClose: number,
    silent: boolean
  ): Promise<void> {
    const bar = candles[i];
    const entry = bar.close;
    const initialStop = turtleInitialStop(candles, i, dir, entry, atrNow);
    const initialSL = initialStop.price;
    if (dir === "long" && !(initialSL > 0 && initialSL < entry)) return;
    if (dir === "short" && !(initialSL > entry)) return;

    // Tỉ trọng risk theo mức đông đúc cùng hướng — tính TRƯỚC khi gắn vị thế vào state.
    const unit: TurtleUnit = { entry, initialSL, entryTime: bar.openTime, weight: this.heatWeight(dir) };
    const pos: TurtlePos = {
      dir,
      units: [unit],
      sl: initialSL,
      midTrail: dir === "long" && T.longExitMode === "mid"
        ? Math.max(initialSL, midClose)
        : dir === "short" && T.shortExitMode === "mid"
          ? Math.min(initialSL, midClose)
          : undefined,
      extreme: dir === "long" ? bar.high : bar.low,
      real: false,
    };

    if (silent) {
      st.pos = pos; // dựng lại lịch sử (paper) — không lệnh, không alert
      return;
    }

    // Guard loại trừ symbol với SMC — chỉ áp khi turtle sẽ đặt lệnh THẬT (SL closePosition
    // của 2 lớp trên cùng symbol sẽ đóng lẫn nhau). Alert-only thì cứ báo bình thường.
    if (this.tradingLive() && this.o.otherHoldsSymbol(st.symbol)) {
      console.log(`[Turtle] ${formatSymbol(st.symbol)} bỏ entry ${dir.toUpperCase()} — SMC đang giữ symbol`);
      await this.tg(`🐢⏭️ *Turtle bỏ entry* ${formatSymbol(st.symbol)} ${dir.toUpperCase()} — lớp SMC đang giữ symbol này.`);
      return;
    }

    if (this.tradingLive()) {
      // Guard SL rộng hơn vùng thanh lý (OB/ATR stop có thể > 1/leverage khi vol spike)
      const slFrac = Math.abs(entry - initialSL) / entry;
      if (slFrac > 0.8 / this.o.leverage) {
        await this.tg(`🐢⏭️ *Turtle bỏ entry* ${formatSymbol(st.symbol)} ${dir.toUpperCase()} — SL ${(slFrac * 100).toFixed(1)}% quá gần vùng thanh lý (${this.o.leverage}x).`);
        return;
      }
      let res;
      try {
        // minQtyFloor: nâng qty lên sàn minNotional (BTC min 100 USDT) thay vì bỏ lệnh;
        // maxRiskFrac = ngân sách CẢ vị thế → risk hiệu dụng unit đầu không bao giờ vượt nó.
        res = await this.o.trader!.open(st.symbol, entry, this.posInfo(pos, unit.weight ?? 1), this.totalOpenRiskFrac(), {
          noTp: true,
          minQtyFloor: true,
          maxRiskFrac: this.positionRiskBudget(),
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[Turtle] ${formatSymbol(st.symbol)} LỖI mở lệnh:`, m);
        await this.tg(`🐢❌ *Lỗi đặt lệnh Turtle* ${formatSymbol(st.symbol)} — ${m}\nBot KHÔNG vào lệnh này.`);
        return;
      }
      if (!res.placed) {
        await this.tg(`🐢⏭️ *Turtle bỏ lệnh* ${formatSymbol(st.symbol)} ${dir.toUpperCase()} — ${res.reason ?? "không rõ"}`);
        return;
      }
      unit.qty = res.qty;
      unit.realEntry = res.avgPrice;
      unit.riskUsd = res.riskUsd;
      unit.riskFrac = res.equity ? (res.riskUsd ?? 0) / res.equity : this.o.riskPct;
      pos.real = true;
    }

    st.pos = pos;
    this.journal({
      event: "entry", real: pos.real, symbol: st.symbol, dir, time: bar.openTime, timeVn: formatTimeVn(bar.openTime),
      entry, initialSL, initialStopSource: initialStop.source, initialStopAtr: +initialStop.distanceAtr.toFixed(3),
      midTrail: pos.midTrail, unit: 1, qty: unit.qty, riskUsd: unit.riskUsd, weight: unit.weight,
    });
    console.log(`[Turtle] ENTRY ${formatSymbol(st.symbol)} ${dir.toUpperCase()} @ $${fmtPrice(entry)}${unit.qty != null ? ` · qty ${unit.qty}` : " (giấy)"}`);
    let msg = `🐢${dir === "long" ? "🟢" : "🔴"} *TURTLE ${dir.toUpperCase()}* ${formatSymbol(st.symbol)} @ $${fmtPrice(entry)}\n` +
      (dir === "long" && T.longExitMode === "mid"
        ? `Hybrid close-breakout ${T.entryDays}d · hard SL $${fmtPrice(initialSL)} (${initialStop.source === "ob" ? "OB 4h" : `fallback ${T.chandelierMult}×ATR`}) · mid-close ${T.longExitDays || T.entryDays}d $${fmtPrice(pos.midTrail!)} · unit 1/${T.pyramidMaxUnits} · size ×${(unit.weight ?? 1).toFixed(2)}`
        : `Breakout ${dir === "short" ? (T.shortEntryDays || T.entryDays) : T.entryDays}d · SL $${fmtPrice(initialSL)} (${initialStop.source === "ob" ? "OB 4h" : `fallback ${T.chandelierMult}×ATR`}) · unit 1/${T.pyramidMaxUnits} · size ×${(unit.weight ?? 1).toFixed(2)}`);
    if (unit.qty != null) msg += `\n💵 Lệnh thật: ${unit.qty} @ $${fmtPrice(unit.realEntry ?? entry)}${unit.riskUsd != null ? ` · risk $${unit.riskUsd.toFixed(2)}` : ""}`;
    else msg += `\n📋 Alert-only (không đặt lệnh)`;
    await this.tg(msg);
  }

  private async addUnit(st: TurtleSymbolState, pos: TurtlePos, candles: Candle[], i: number, atrNow: number, silent: boolean): Promise<void> {
    const bar = candles[i];
    const entry = bar.close;
    const initialStop = turtleInitialStop(candles, i, pos.dir, entry, atrNow);
    const initialSL = initialStop.price;
    if (pos.dir === "long" && !(initialSL > 0)) return;

    const unit: TurtleUnit = { entry, initialSL, entryTime: bar.openTime, weight: this.heatWeight(pos.dir) };
    const nextSharedSl = pos.dir === "long" && T.longExitMode === "mid"
      ? Math.max(pos.sl, initialSL)
      : pos.dir === "short" && T.shortExitMode === "mid"
        ? Math.min(pos.sl, initialSL)
        : pos.sl;

    if (silent) {
      pos.sl = nextSharedSl;
      pos.units.push(unit);
      return;
    }

    if (pos.real && !this.tradingLive()) {
      console.warn(`[Turtle] ${formatSymbol(st.symbol)} bỏ ADD — lớp thực thi chưa sẵn sàng.`);
      return;
    }

    if (pos.real && this.tradingLive()) {
      const slFrac = Math.abs(entry - initialSL) / entry;
      if (slFrac > 0.8 / this.o.leverage) return; // vol spike — bỏ add trong im lặng có log
      let filled = false;
      const oldSl = pos.sl;
      try {
        const api = this.o.api!;
        const equity = (await api.getEquity()).walletBalance;
        const slPrice = api.roundPrice(st.symbol, initialSL);
        const dist = Math.abs(entry - slPrice);
        if (dist <= 0) return;
        const f = api.getFilters(st.symbol);
        let qty = api.roundQty(st.symbol, (equity * this.o.riskPct * (unit.weight ?? 1)) / dist);
        // Sàn minNotional/minQty (BTC min 100 USDT): nâng qty thay vì bỏ add
        const needQty = Math.max(f.minQty, (f.minNotional * 1.01) / entry);
        if (qty < needQty) qty = parseFloat((Math.ceil(needQty / f.stepSize) * f.stepSize).toFixed(f.qtyPrecision));
        if (qty <= 0) return;
        const effFrac = (qty * dist) / equity; // risk hiệu dụng của unit này
        // Ngân sách risk CẢ vị thế bất biến: maxUnits × riskPct — vượt thì thôi add (giữ nguyên risk)
        if (this.positionRiskFrac(pos) + effFrac > this.positionRiskBudget() + 1e-9) {
          console.log(`[Turtle] ${formatSymbol(st.symbol)} ADD bỏ qua — vị thế đã dùng hết ngân sách risk ${(this.positionRiskBudget() * 100).toFixed(1)}%`);
          return;
        }
        if (this.totalOpenRiskFrac() + effFrac > this.o.maxPortfolioRiskPct + 1e-9) {
          await this.tg(`🐢⏭️ *Turtle bỏ ADD* ${formatSymbol(st.symbol)} — chạm trần risk danh mục.`);
          return;
        }
        const fill = await api.marketOrder(st.symbol, pos.dir === "long" ? "BUY" : "SELL", qty);
        if (!(fill.executedQty > 0)) return;
        filled = true;
        unit.qty = fill.executedQty;
        unit.realEntry = fill.avgPrice || entry;
        unit.riskUsd = qty * dist;
        unit.riskFrac = effFrac;
        // Hybrid LONG siết hard stop lên initialSL của unit mới; không bao giờ nới stop cũ.
        pos.sl = nextSharedSl;
        await this.ensureStop(st.symbol, pos);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[Turtle] ${formatSymbol(st.symbol)} LỖI add unit:`, m);
        await this.tg(`🐢⚠️ *Lỗi ADD Turtle* ${formatSymbol(st.symbol)} — ${m}\nVị thế hiện tại vẫn được SL bảo vệ.`);
        if (!filled) return;
        // MARKET đã khớp nhưng sync stop lỗi: vẫn ghi nhận unit; state giữ stop cũ chắc chắn đã có.
        pos.sl = oldSl;
      }
    } else {
      pos.sl = nextSharedSl;
    }

    pos.units.push(unit);
    this.journal({
      event: "add", real: unit.qty != null, symbol: st.symbol, dir: pos.dir, time: bar.openTime, timeVn: formatTimeVn(bar.openTime),
      entry, initialSL, initialStopSource: initialStop.source, initialStopAtr: +initialStop.distanceAtr.toFixed(3),
      unit: pos.units.length, qty: unit.qty, riskUsd: unit.riskUsd, weight: unit.weight,
    });
    console.log(`[Turtle] ADD ${formatSymbol(st.symbol)} unit ${pos.units.length}/${T.pyramidMaxUnits} @ $${fmtPrice(entry)}${unit.qty != null ? ` · qty ${unit.qty}` : ""}`);
    await this.tg(
      `🐢➕ *TURTLE ADD* ${formatSymbol(st.symbol)} ${pos.dir.toUpperCase()} unit ${pos.units.length}/${T.pyramidMaxUnits} @ $${fmtPrice(entry)}\n` +
        `Initial SL $${fmtPrice(initialSL)} (${initialStop.source === "ob" ? "OB 4h" : `fallback ${T.chandelierMult}×ATR`}) · SL chung $${fmtPrice(pos.sl)} · size ×${(unit.weight ?? 1).toFixed(2)}${unit.qty != null ? ` · qty ${unit.qty}${unit.riskUsd != null ? ` · risk $${unit.riskUsd.toFixed(2)}` : ""}` : " · (giấy)"}`
    );
  }

  private async exitPosition(
    st: TurtleSymbolState,
    pos: TurtlePos,
    exitPrice: number,
    reason: TurtleExitReason,
    exitTime: number,
    silent: boolean,
    opts?: { flatten?: boolean; atrNow?: number }
  ): Promise<void> {
    if (!silent && pos.real && opts?.flatten !== false) {
      if (!this.tradingLive()) {
        if (!pos.pendingExit) {
          await this.tg(`🐢⚠️ *Chưa thể đóng Turtle* ${formatSymbol(st.symbol)} (${reason}) — kết nối/thực thi Binance chưa sẵn sàng. Bot sẽ tự thử lại.`);
        }
        pos.pendingExit = { exitPrice, reason, exitTime };
        return;
      }
      try {
        await this.o.trader!.flatten(st.symbol, pos.dir); // huỷ stop còn sót + đóng phần còn lại (nếu có)
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[Turtle] ${formatSymbol(st.symbol)} LỖI đóng vị thế:`, m);
        if (!pos.pendingExit) {
          await this.tg(`🐢⚠️ *Lỗi đóng lệnh Turtle* ${formatSymbol(st.symbol)} — ${m}\nBot sẽ tự thử lại; nếu lỗi kéo dài, KIỂM TRA vị thế trên sàn!`);
        }
        pos.pendingExit = { exitPrice, reason, exitTime };
        return; // không xoá state khi chưa xác nhận đóng được vị thế thật
      }
    }

    const rs = pos.units.map((u) => {
      const risk = Math.abs(u.entry - u.initialSL);
      const pnl = pos.dir === "long" ? exitPrice - u.entry : u.entry - exitPrice;
      return risk > 0 ? pnl / risk : 0;
    });
    const totalR = rs.reduce((a, b) => a + b, 0);
    const heldDays = (exitTime - pos.units[0].entryTime) / TF_MS["1d"];

    st.pos = null;
    if (silent) return; // replay dựng lại lịch sử — không journal/alert các exit cũ

    // ĐO TRƯỢT GIÁ THẬT (chỉ đọc, không đổi gì). `exitPrice` ở trên là giá TÍN HIỆU; nếu không ghi
    // giá khớp thật thì `totalGrossR` mãi mãi là con số giả định và trượt giá không bao giờ đo được.
    // Xem exit-fill-audit.ts. Lỗi ở đây phải im lặng — phép đo không được ảnh hưởng việc thoát lệnh.
    let fillAudit: ExitFillAudit | null = null;
    if (pos.real && this.o.trader && this.tradingLive()) {
      fillAudit = await this.o.trader.realizedExit(
        st.symbol, pos.dir, exitPrice, pos.units[0].entryTime, opts?.atrNow
      );
      if (fillAudit) console.log(`[Turtle] fill ${formatSymbol(st.symbol)} — ${formatExitFillAudit(fillAudit)}`);
    }

    this.journal({
      event: "exit", real: pos.real, symbol: st.symbol, dir: pos.dir, time: exitTime, timeVn: formatTimeVn(exitTime),
      exitPrice, reason, units: pos.units.length, unitR: rs.map((r) => +r.toFixed(3)), totalGrossR: +totalR.toFixed(3),
      heldDays: +heldDays.toFixed(2),
      // Giá khớp THẬT + trượt giá. Thiếu field này = không đo được (paper, hoặc API lỗi).
      ...(fillAudit
        ? {
            realExitAvg: fillAudit.realExitAvg,
            slipBps: +fillAudit.slipBps.toFixed(2),
            slipAtr: fillAudit.slipAtr === null ? null : +fillAudit.slipAtr.toFixed(4),
            realizedUsd: fillAudit.realizedUsd === null ? null : +fillAudit.realizedUsd.toFixed(4),
            fills: fillAudit.fills,
          }
        : {}),
    });
    console.log(`[Turtle] EXIT ${formatSymbol(st.symbol)} ${pos.dir.toUpperCase()} ${reason} @ $${fmtPrice(exitPrice)} (${totalR >= 0 ? "+" : ""}${totalR.toFixed(2)}R, ${pos.units.length} unit)`);
    await this.tg(
      `🐢🔚 *TURTLE EXIT* ${formatSymbol(st.symbol)} ${pos.dir.toUpperCase()} (${reason}) @ $${fmtPrice(exitPrice)}\n` +
        `${pos.units.length} unit: ${rs.map((r) => (r >= 0 ? "+" : "") + r.toFixed(2)).join(", ")}R → *tổng ${totalR >= 0 ? "+" : ""}${totalR.toFixed(2)}R*\n` +
        `Giữ ${heldDays.toFixed(1)} ngày${pos.real ? "" : " · (giấy)"}`
    );
  }

  // ── Logic 1 nến 4h đã đóng (khớp runTurtle từng bước) ───────────────────
  private async step(
    st: TurtleSymbolState,
    candles: Candle[],
    i: number,
    emaArr: number[],
    atr: number[],
    gate: (t: number, d: "long" | "short") => boolean,
    silent: boolean
  ): Promise<void> {
    const bar = candles[i];
    const longChannel = priorDonchian(candles, i, DC_ENTRY);
    const shortChannel = DC_SHORT_ENTRY === DC_ENTRY ? longChannel : priorDonchian(candles, i, DC_SHORT_ENTRY);
    // midpoint LONG lấy trên kênh THOÁT (rộng hơn kênh vào → winner chạy lâu hơn)
    const longExitCh = DC_LONG_EXIT === DC_ENTRY ? longChannel : priorDonchian(candles, i, DC_LONG_EXIT);
    const longMidClose = (longExitCh.closeHigh + longExitCh.closeLow) / 2;
    const shortMidClose = (shortChannel.closeHigh + shortChannel.closeLow) / 2;
    const pos = st.pos;

    if (pos) {
      const heldBars = Math.round((bar.openTime - pos.units[0].entryTime) / tfMs);

      if (pos.pendingExit) {
        const x = pos.pendingExit;
        await this.exitPosition(st, pos, x.exitPrice, x.reason, x.exitTime, silent, { atrNow: atr[i] });
        return;
      }

      // Migration state cũ: khởi tạo midTrail từ kênh hiện tại nhưng không bao giờ nới hard SL.
      if (pos.dir === "long" && T.longExitMode === "mid" && !Number.isFinite(pos.midTrail)) {
        pos.midTrail = Math.max(pos.sl, longMidClose);
      } else if (pos.dir === "short" && T.shortExitMode === "mid" && !Number.isFinite(pos.midTrail)) {
        pos.midTrail = Math.min(pos.sl, shortMidClose);
      }

      // 1) Exit theo nến (stop sàn đã khớp intra-bar với vị thế thật; giấy thì mô phỏng)
      const hitStop = pos.dir === "long" ? bar.low <= pos.sl : bar.high >= pos.sl;
      if (hitStop) {
        await this.exitPosition(st, pos, pos.sl, "trail", bar.openTime, silent, { atrNow: atr[i] });
        return;
      }
      if (pos.dir === "long" && T.longExitMode === "mid" && bar.close <= pos.midTrail!) {
        await this.exitPosition(st, pos, bar.close, "mid", bar.openTime, silent, { atrNow: atr[i] });
        return;
      }
      if (pos.dir === "short" && T.shortExitMode === "mid" && bar.close >= pos.midTrail!) {
        await this.exitPosition(st, pos, bar.close, "mid", bar.openTime, silent, { atrNow: atr[i] });
        return;
      }
      if (heldBars >= MAX_HOLD_BARS) {
        await this.exitPosition(st, pos, bar.close, "time", bar.openTime, silent, { atrNow: atr[i] });
        return;
      }

      // 2) Hybrid LONG ratchet midpoint close; SHORT/legacy LONG ratchet Chandelier hard stop.
      const oldSl = pos.sl;
      if (pos.dir === "long") {
        if (T.longExitMode === "mid") {
          pos.midTrail = Math.max(pos.midTrail!, longMidClose);
        } else {
          pos.extreme = Math.max(pos.extreme, bar.high);
          const trail = pos.extreme - T.chandelierMult * atr[i];
          if (trail > pos.sl) pos.sl = trail;
        }
      } else {
        if (T.shortExitMode === "mid") {
          pos.midTrail = Math.min(pos.midTrail!, shortMidClose);
        } else {
          pos.extreme = Math.min(pos.extreme, bar.low);
          const trail = pos.extreme + T.chandelierMult * atr[i];
          if (trail < pos.sl) pos.sl = trail;
        }
      }
      if (!silent && pos.real && pos.sl !== oldSl && this.tradingLive()) {
        try {
          await this.o.trader!.syncStops(st.symbol, this.posInfo(pos), { noTp: true });
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          console.error(`[Turtle] ${formatSymbol(st.symbol)} LỖI dời SL:`, m);
          await this.tg(`🐢⚠️ *Lỗi dời SL Turtle* ${formatSymbol(st.symbol)} — ${m}`);
          pos.sl = oldSl; // state phải phản ánh stop cũ vẫn chắc chắn tồn tại trên sàn
        }
      }

      // 3) Pyramiding
      if (T.pyramidStepAtr > 0 && pos.units.length < T.pyramidMaxUnits && atr[i] > 0) {
        const last = pos.units[pos.units.length - 1];
        const trigger =
          pos.dir === "long" ? bar.close >= last.entry + T.pyramidStepAtr * atr[i] : bar.close <= last.entry - T.pyramidStepAtr * atr[i];
        if (trigger) await this.addUnit(st, pos, candles, i, atr[i], silent);
      }
      return;
    }

    // ── Tìm entry mới ──
    const uptrend = bar.close > emaArr[i];
    const downtrend = bar.close < emaArr[i];
    const longBreakout = T.longEntrySource === "close" ? longChannel.closeHigh : longChannel.high;
    const shortBreakout = T.shortEntrySource === "close" ? shortChannel.closeLow : shortChannel.low;

    if (uptrend && gate(bar.openTime, "long") && bar.close > longBreakout) {
      await this.openPosition(st, candles, i, "long", atr[i], longMidClose, silent);
    } else if (T.allowShort && downtrend && gate(bar.openTime, "short") && bar.close < shortBreakout) {
      await this.openPosition(st, candles, i, "short", atr[i], shortMidClose, silent);
    }
  }

  /**
   * Replay mọi nến ĐÃ ĐÓNG còn thiếu, THEO THỜI GIAN (mọi symbol tiến cùng nhịp), không phải
   * chạy hết symbol này rồi tới symbol kia.
   *
   * Vì sao quan trọng: chính sách heat (`heatWeight`) phụ thuộc trạng thái CẢ RỔ tại thời điểm vào
   * lệnh. Replay nối tiếp từng symbol sẽ tính heat theo một trật tự không có thật (toàn bộ lịch sử
   * của BTC trước khi ETH bắt đầu) → tỉ trọng risk lệch khỏi engine đã audit. Ở nhịp bình thường
   * (mỗi chu kỳ đúng 1 nến mới) hai cách là như nhau; khác biệt chỉ xuất hiện khi cold-start hoặc
   * bot offline nhiều nến — đúng lúc dễ sai nhất.
   */
  private async replay(
    feeds: { st: TurtleSymbolState; candles: Candle[]; cold: boolean }[],
    gate: (t: number, d: "long" | "short") => boolean,
  ): Promise<void> {
    const prep = feeds.map((f) => ({
      ...f,
      emaArr: ema(f.candles.map((c) => c.close), T.trendLen),
      atr: atrSeries(f.candles, T.atrPeriod),
      idxOf: new Map(f.candles.map((c, i) => [c.openTime, i])),
    }));
    const times = [...new Set(prep.flatMap((f) => f.candles.slice(WARMUP_BARS).map((c) => c.openTime)))].sort((a, b) => a - b);
    try {
      for (const t of times) {
        // Chốt heat MỘT LẦN cho cả mốc này; mọi symbol trong mốc chấm trên cùng trạng thái sổ.
        this.barHeat = new Map([["long", this.currentHeat("long")], ["short", this.currentHeat("short")]]);
        for (const f of prep) {
          const i = f.idxOf.get(t);
          if (i === undefined || i < WARMUP_BARS || t <= f.st.lastBarTime) continue;
          try {
            await this.step(f.st, f.candles, i, f.emaArr, f.atr, gate, f.cold);
          } catch (err) {
            console.error(`[Turtle] ${formatSymbol(f.st.symbol)} lỗi nến ${new Date(t).toISOString()}:`, err instanceof Error ? err.message : err);
          }
          f.st.lastBarTime = t;
        }
      }
    } finally {
      this.barHeat = null; // ngoài replay phải quay về chấm tức thời
    }
    this.persist();
  }

  // ── Dữ liệu ──────────────────────────────────────────────────────────────
  private async fetchClosed(symbol: string): Promise<Candle[]> {
    const c = await fetchFuturesKlinesPaged(symbol, TF, FETCH_BARS);
    const now = Date.now();
    while (c.length && c[c.length - 1].openTime + tfMs > now) c.pop(); // bỏ nến chưa đóng
    return c;
  }

  // ── Đối soát với sàn ─────────────────────────────────────────────────────
  /** Vị thế thật trong state nhưng sàn đã FLAT (stop khớp/đóng tay) → chốt sổ tại SL. */
  private async reconcileHeld(): Promise<void> {
    if (!this.tradingLive() || this.cycling) return; // không đan xen với cycle (tránh chốt sổ đúp)
    for (const st of this.states.values()) {
      const pos = st.pos;
      if (!pos?.real) continue;
      let p;
      try {
        p = await this.o.trader!.reconcile(st.symbol);
      } catch {
        continue; // lỗi mạng → lần sau
      }
      if (st.pos !== pos) continue; // cycle vừa xử lý xong vị thế này trong lúc await
      if (Math.abs(p.positionAmt) > 0) {
        if (pos.pendingExit) {
          const x = pos.pendingExit;
          await this.exitPosition(st, pos, x.exitPrice, x.reason, x.exitTime, false);
          this.persist();
        }
        continue;
      }
      const x = pos.pendingExit;
      console.log(`[Turtle] ${formatSymbol(st.symbol)} sàn đã FLAT — chốt sổ tại $${fmtPrice(x?.exitPrice ?? pos.sl)}`);
      await this.exitPosition(st, pos, x?.exitPrice ?? pos.sl, x?.reason ?? "reconcile", x?.exitTime ?? Date.now(), false, { flatten: false });
      this.persist();
    }
  }

  /** Cold-start: đối soát vị thế dựng lại từ replay ↔ sàn; adopt orphan trên symbol turtle-riêng. */
  private async reconcileStartup(smcSymbols: Set<string>): Promise<void> {
    if (!this.tradingLive()) return;
    for (const st of this.states.values()) {
      let p;
      try {
        p = await this.o.trader!.reconcile(st.symbol);
      } catch (e) {
        console.warn(`[Turtle] ${formatSymbol(st.symbol)} không đọc được vị thế: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      const exHas = Math.abs(p.positionAmt) > 0;
      const exDir: "long" | "short" = p.positionAmt > 0 ? "long" : "short";
      const pos = st.pos;

      if (pos && exHas && !pos.real) {
        if (this.o.otherHoldsSymbol(st.symbol)) {
          // Vị thế trên sàn là của lớp SMC — turtle giữ paper, KHÔNG adopt.
          continue;
        }
        if (exDir === pos.dir) {
          // Replay nói đang giữ + sàn có vị thế cùng hướng (state file mất / lần đầu bật trade) → ADOPT
          pos.real = true;
          pos.units[0].qty = Math.abs(p.positionAmt);
          pos.units[0].realEntry = p.entryPrice;
          try {
            await this.ensureStop(st.symbol, pos);
          } catch (e) {
            await this.tg(`🐢⚠️ ADOPT ${formatSymbol(st.symbol)} nhưng đặt SL lỗi: ${e instanceof Error ? e.message : e} — KIỂM TRA SÀN!`);
          }
          await this.tg(`🐢🔁 *Turtle ADOPT vị thế sàn* ${formatSymbol(st.symbol)} ${exDir.toUpperCase()} qty ${Math.abs(p.positionAmt)} — khớp replay, SL $${fmtPrice(pos.sl)}`);
        } else {
          await this.tg(`🐢⚠️ *Lệch hướng* ${formatSymbol(st.symbol)}: turtle-replay=${pos.dir.toUpperCase()} nhưng sàn=${exDir.toUpperCase()}. Turtle theo dõi GIẤY, kiểm tra thủ công.`);
        }
      } else if (pos?.real && !exHas) {
        console.log(`[Turtle] ${formatSymbol(st.symbol)} state giữ nhưng sàn flat — chốt sổ.`);
        const x = pos.pendingExit;
        await this.exitPosition(st, pos, x?.exitPrice ?? pos.sl, x?.reason ?? "reconcile", x?.exitTime ?? Date.now(), false, { flatten: false });
      } else if (!pos && exHas && !smcSymbols.has(st.symbol)) {
        // Orphan trên symbol CHỈ turtle quản lý (SMC không adopt) → nhận + SL khẩn cấp nếu thiếu
        const entry = p.entryPrice;
        let sl: number | null = null;
        try {
          sl = (await this.o.trader!.readProtection(st.symbol)).slPrice;
        } catch { /* đọc lỗi → đặt mới */ }
        const newPos: TurtlePos = {
          dir: exDir,
          units: [{ entry, initialSL: sl ?? entry, entryTime: Date.now(), qty: Math.abs(p.positionAmt), realEntry: entry }],
          sl: sl ?? entry,
          extreme: entry,
          real: true,
        };
        if (sl == null) {
          // không có SL trên sàn → dùng 3×ATR từ entry làm SL khẩn cấp
          try {
            const c = await this.fetchClosed(st.symbol);
            const atrNow = atrSeries(c, T.atrPeriod)[c.length - 1];
            const esl = exDir === "long" ? entry - T.chandelierMult * atrNow : entry + T.chandelierMult * atrNow;
            newPos.sl = esl;
            newPos.units[0].initialSL = esl;
            await this.ensureStop(st.symbol, newPos);
          } catch (e) {
            await this.tg(`🐢❌ *ORPHAN KHÔNG SL* ${formatSymbol(st.symbol)} ${exDir.toUpperCase()} — đặt SL khẩn cấp THẤT BẠI (${e instanceof Error ? e.message : e}). ĐÓNG THỦ CÔNG!`);
            continue;
          }
        }
        st.pos = newPos;
        await this.tg(`🐢🔁 *Turtle ADOPT orphan* ${formatSymbol(st.symbol)} ${exDir.toUpperCase()} @ $${fmtPrice(entry)} · SL $${fmtPrice(newPos.sl)} · qty ${Math.abs(p.positionAmt)}`);
      }
    }
    this.persist();
  }

  // ── Vòng đời ─────────────────────────────────────────────────────────────
  /** Chạy 1 chu kỳ: fetch BTC (gate) + từng symbol, xử lý nến mới. silent chỉ dùng cho cold-start. */
  private async cycle(silentColdStart = false): Promise<void> {
    if (this.cycling) return;
    this.cycling = true;
    try {
      const btc = await this.fetchClosed("btcusdt");
      if (btc.length < WARMUP_BARS + 2) {
        console.warn("[Turtle] thiếu nến BTC cho gate — bỏ chu kỳ này.");
        return;
      }
      const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
      const feeds: { st: TurtleSymbolState; candles: Candle[]; cold: boolean }[] = [];
      for (const st of this.states.values()) {
        try {
          const candles = st.symbol === "btcusdt" ? btc : await this.fetchClosed(st.symbol);
          if (candles.length < WARMUP_BARS + 2) continue;
          // `cold` chốt TRƯỚC khi replay (lastBarTime sẽ đổi trong lúc chạy).
          feeds.push({ st, candles, cold: silentColdStart && st.lastBarTime === 0 });
        } catch (err) {
          console.error(`[Turtle] ${formatSymbol(st.symbol)} lỗi tải nến:`, err instanceof Error ? err.message : err);
        }
      }
      await this.replay(feeds, gate);
    } finally {
      this.cycling = false;
    }
  }

  /** Khởi động: rehydrate + cold-start replay + đối soát sàn + đặt lịch 4h. */
  async start(smcSymbols: string[]): Promise<void> {
    this.loadState();
    const held = [...this.states.values()].filter((s) => s.pos);
    if (held.length) {
      console.log(`[Turtle] Khôi phục ${held.length} vị thế: ${held.map((s) => formatSymbol(s.symbol)).join(", ")}`);
    }

    console.log(`[Turtle] 🐢 Khởi động Hybrid — ${this.o.symbols.length} symbol @ ${TF} | initial SL OB${T.initialStopObLookback} +${T.initialStopObPadAtr}ATR trong ${T.initialStopObMinAtr}-${T.initialStopObMaxAtr}ATR, fallback ${T.chandelierMult}ATR | long close ${T.entryDays}d / mid-exit ${T.longExitDays || T.entryDays}d | short close ${T.shortEntryDays || T.entryDays}d/Chandelier | pyramid ${T.pyramidStepAtr}×ATR max${T.pyramidMaxUnits} | heat-decay k=${T.heatDecayK || "TẮT"} | BTC gate ${T.btcGateFast / BARS_PER_DAY}d/${T.btcGateSlow / BARS_PER_DAY}d | ${this.o.trader ? `risk ${(this.o.riskPct * 100).toFixed(1)}%/unit` : "ALERT-ONLY"}`);
    // Thứ tự an toàn: (1) chốt sổ vị thế thật đã bị đóng trong lúc offline → (2) replay nến lỡ
    // trên state đã đúng → (3) đối soát cold-start/orphan với sàn.
    await this.reconcileHeld();
    await this.cycle(true); // cold-start: symbol chưa có state → silent replay dựng vị thế
    await this.reconcileStartup(new Set(smcSymbols.map((s) => s.toLowerCase())));

    const heldNow = [...this.states.values()].filter((s) => s.pos);
    console.log(`[Turtle] ✅ Sẵn sàng — đang giữ ${heldNow.length} vị thế${heldNow.length ? ": " + heldNow.map((s) => `${formatSymbol(s.symbol)} ${s.pos!.dir}${s.pos!.real ? "" : "(giấy)"}`).join(", ") : ""}`);

    this.lastBoundary = Math.floor(Date.now() / tfMs) * tfMs;
    setInterval(() => {
      const now = Date.now();
      const boundary = Math.floor(now / tfMs) * tfMs;
      if (boundary > this.lastBoundary && now - boundary >= SETTLE_MS) {
        this.lastBoundary = boundary;
        void this.cycle().catch((e) => console.error("[Turtle] cycle lỗi:", e instanceof Error ? e.message : e));
      }
    }, CHECK_MS);
    setInterval(() => void this.reconcileHeld().catch(() => {}), RECONCILE_MS);
  }
}
