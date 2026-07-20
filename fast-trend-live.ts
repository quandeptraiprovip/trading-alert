/**
 * fast-trend-live.ts — Sleeve trend NHANH (Donchian breakout ngắn, mặc định 10d) chạy
 * ALERT-ONLY song song turtle 20d, để FORWARD-TEST khả năng "giao dịch cả lúc thị trường đi
 * ngang" (turtle 20d im lúc chop) mà KHÔNG rủi ro tiền thật.
 *
 * An toàn theo thiết kế:
 *   - KHÔNG có LiveTrader / BinanceFutures — TUYỆT ĐỐI không đặt lệnh thật, không đọc số dư.
 *   - KHÔNG đụng state/journal của turtle (turtle-state.json) hay SMC (bot-state.json).
 *     Dùng file RIÊNG: fast-trend-state.json + fast-trend-trades.jsonl.
 *   - Tín hiệu mirror ĐÚNG cơ chế turtle (EMA50 + BTC gate LONG + chandelier 3×ATR trail +
 *     time-stop + pyramiding) nhưng lookback ngắn hơn → alert khớp với những gì một turtle-10d
 *     thật sẽ làm, để so sánh trung thực trước khi (nếu muốn) bật tiền thật ở bước riêng.
 *   - Cold-start: replay IM LẶNG lịch sử để dựng lại vị thế hiện tại, KHÔNG spam alert quá khứ.
 */
import fs from "fs";
import path from "path";
import { fetchKlinesPaged } from "./backtest";
import { Candle, TF_MS } from "./strategy";
import { T, buildBtcGateLongs, ema, atrSeries } from "./turtle";
import { BinanceFutures } from "./binance-futures";
import { LiveTrader, PosInfo } from "./live-trade";
import { TelegramConfig, sendTelegram, formatSymbol, fmtPrice, formatTimeVn } from "./telegram";

const STATE_FILE = path.join(process.cwd(), "fast-trend-state.json");
const JOURNAL_FILE = path.join(process.cwd(), "fast-trend-trades.jsonl");

const TF = T.tf; // 4h — cùng khung turtle
const tfMs = TF_MS[TF];
const BARS_PER_DAY = TF_MS["1d"] / tfMs;
const FETCH_BARS = 1100; // warmup gate SMA100d (600) + đủ replay
const SETTLE_MS = 90_000; // đợi nến 4h chốt hẳn trên sàn
const CHECK_MS = 60_000;
const RECONCILE_MS = 10 * 60_000; // lưới an toàn: đối soát vị thế thật với sàn

type Unit = {
  entry: number;
  initialSL: number;
  entryTime: number;
  qty?: number; // khối lượng thật đã khớp (undefined = giấy)
  realEntry?: number;
  riskUsd?: number;
  riskFrac?: number; // risk hiệu dụng/equity lúc fill (có thể > riskPct danh nghĩa do sàn minNotional)
};
type Pos = { dir: "long" | "short"; units: Unit[]; sl: number; extreme: number; real: boolean };
type SymState = { symbol: string; lastBarTime: number; pos: Pos | null };

export interface FastTrendOpts {
  symbols: string[];
  entryDays: number; // breakout lookback (ngày) — 10 mặc định
  telegram: TelegramConfig;
  api: BinanceFutures | null; // null → alert-only
  trader: LiveTrader | null; // LiveTrader riêng với riskPct của fast
  riskPct: number; // frac equity / unit
  maxPortfolioRiskPct: number; // trần CHUNG với SMC + Turtle
  leverage: number; // để guard SL rộng hơn vùng thanh lý
  /** SMC hoặc Turtle đang giữ THẬT symbol này? → fast không vào (SL closePosition đóng cả symbol). */
  otherHoldsSymbol: (symbol: string) => boolean;
  /** Tổng risk frac các vị thế lớp khác (SMC + Turtle) đang mở (cho trần chung). */
  otherOpenRiskFrac: () => number;
  /** Lớp thực thi đã preflight OK chưa (cờ tradingReady của bot). */
  isTradingReady: () => boolean;
}

export class FastTrendLive {
  private readonly states = new Map<string, SymState>();
  private lastBoundary = 0;
  private cycling = false;
  private readonly dcEntry: number;
  private readonly maxHoldBars: number;
  private readonly warmupBars: number;

  constructor(private readonly o: FastTrendOpts) {
    this.dcEntry = Math.max(2, Math.round(o.entryDays * BARS_PER_DAY));
    this.maxHoldBars = Math.round(T.maxHoldDays * BARS_PER_DAY);
    this.warmupBars = Math.max(this.dcEntry, T.trendLen, T.atrPeriod, T.btcGateSlow) + 1;
  }

  // ── State & journal (RIÊNG, không đụng turtle/SMC) ──────────────────────────
  private persist(): void {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify([...this.states.values()], null, 2)); }
    catch (e) { console.error("[Fast] ghi fast-trend-state.json lỗi:", e instanceof Error ? e.message : e); }
  }
  private journal(rec: Record<string, unknown>): void {
    try { fs.appendFileSync(JOURNAL_FILE, JSON.stringify({ strategy: "fast-trend", entryDays: this.o.entryDays, ...rec }) + "\n"); }
    catch (e) { console.error("[Fast] ghi fast-trend-trades.jsonl lỗi:", e instanceof Error ? e.message : e); }
  }
  private loadState(): void {
    let saved: SymState[] = [];
    try { if (fs.existsSync(STATE_FILE)) saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
    catch (e) { console.error("[Fast] đọc fast-trend-state.json lỗi, khởi động sạch:", e instanceof Error ? e.message : e); }
    const bySym = new Map(saved.map((s) => [s.symbol, s]));
    for (const sym of this.o.symbols) {
      const s = bySym.get(sym);
      this.states.set(sym, s ? { ...s, pos: s.pos ? { ...s.pos, units: [...s.pos.units] } : null } : { symbol: sym, lastBarTime: 0, pos: null });
    }
  }

  statusLines(): string[] {
    const lines: string[] = [];
    for (const st of this.states.values()) {
      if (!st.pos) continue;
      const p = st.pos;
      const icon = p.dir === "long" ? "⚡🟢 LONG" : "⚡🔴 SHORT";
      const heldD = ((Date.now() - p.units[0].entryTime) / TF_MS["1d"]).toFixed(1);
      lines.push(`${icon} *${formatSymbol(st.symbol)}* (fast-${this.o.entryDays}d${p.real ? "" : ", giấy"}) — ${p.units.length}/${T.pyramidMaxUnits} unit · Entry₁ $${fmtPrice(p.units[0].entry)} · SL $${fmtPrice(p.sl)} · giữ ${heldD}d`);
    }
    return lines;
  }

  /** Fast đang giữ vị thế THẬT trên symbol? (vị thế "giấy" không chặn lớp khác) */
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

  /** Tổng risk frac hiệu dụng các unit thật của một vị thế. */
  private positionRiskFrac(pos: Pos): number {
    let n = 0;
    for (const u of pos.units) if (u.qty != null) n += u.riskFrac ?? this.o.riskPct;
    return n;
  }

  private tradingLive(): boolean {
    return !!this.o.trader && this.o.isTradingReady();
  }

  private totalOpenRiskFrac(): number {
    return this.o.otherOpenRiskFrac() + this.openRiskFrac();
  }

  /** Đảm bảo trên sàn có đúng 1 STOP_MARKET tại pos.sl (sau add / sau adopt). */
  private async ensureStop(symbol: string, pos: Pos): Promise<void> {
    if (!this.o.trader) return;
    await this.o.trader.syncStops(symbol, this.posInfo(pos), { noTp: true });
  }

  private posInfo(pos: Pos): PosInfo {
    const u0 = pos.units[0];
    return {
      dir: pos.dir,
      initialSL: u0.initialSL,
      sl: pos.sl,
      target: pos.dir === "long" ? u0.entry * 100 : u0.entry * 0.01, // không dùng (noTp) — mốc không với tới
      sizeMult: 1,
    };
  }

  private async tg(msg: string): Promise<void> { await sendTelegram(this.o.telegram, msg); }

  // ── Sự kiện ──────────────────────────────────────────────────────────────
  private async openPosition(st: SymState, bar: Candle, dir: "long" | "short", atrNow: number, silent: boolean): Promise<void> {
    const entry = bar.close;
    const initialSL = dir === "long" ? entry - T.chandelierMult * atrNow : entry + T.chandelierMult * atrNow;
    if (dir === "long" && !(initialSL > 0 && initialSL < entry)) return;
    if (dir === "short" && !(initialSL > entry)) return;

    const unit: Unit = { entry, initialSL, entryTime: bar.openTime };
    const pos: Pos = { dir, units: [unit], sl: initialSL, extreme: dir === "long" ? bar.high : bar.low, real: false };

    if (silent) {
      st.pos = pos; // cold-start dựng lại lịch sử (paper) — không lệnh, không alert
      return;
    }

    // Loại trừ theo symbol với SMC/Turtle — chỉ áp khi fast sẽ đặt lệnh THẬT (SL closePosition
    // của 2 lớp trên cùng symbol sẽ đóng lẫn nhau).
    if (this.tradingLive() && this.o.otherHoldsSymbol(st.symbol)) {
      console.log(`[Fast] ${formatSymbol(st.symbol)} bỏ entry ${dir.toUpperCase()} — SMC/Turtle đang giữ symbol`);
      await this.tg(`⚡⏭️ *Fast bỏ entry* ${formatSymbol(st.symbol)} ${dir.toUpperCase()} — lớp SMC/Turtle đang giữ symbol này.`);
      return;
    }

    if (this.tradingLive()) {
      const slFrac = Math.abs(entry - initialSL) / entry;
      if (slFrac > 0.8 / this.o.leverage) {
        await this.tg(`⚡⏭️ *Fast bỏ entry* ${formatSymbol(st.symbol)} ${dir.toUpperCase()} — SL ${(slFrac * 100).toFixed(1)}% quá gần vùng thanh lý (${this.o.leverage}x).`);
        return;
      }
      let res;
      try {
        res = await this.o.trader!.open(st.symbol, entry, this.posInfo(pos), this.totalOpenRiskFrac(), {
          noTp: true,
          minQtyFloor: true,
          maxRiskFrac: this.positionRiskBudget(),
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[Fast] ${formatSymbol(st.symbol)} LỖI mở lệnh:`, m);
        await this.tg(`⚡❌ *Lỗi đặt lệnh Fast* ${formatSymbol(st.symbol)} — ${m}\nBot KHÔNG vào lệnh này.`);
        return;
      }
      if (!res.placed) {
        await this.tg(`⚡⏭️ *Fast bỏ lệnh* ${formatSymbol(st.symbol)} ${dir.toUpperCase()} — ${res.reason ?? "không rõ"}`);
        return;
      }
      unit.qty = res.qty;
      unit.realEntry = res.avgPrice;
      unit.riskUsd = res.riskUsd;
      unit.riskFrac = res.equity ? (res.riskUsd ?? 0) / res.equity : this.o.riskPct;
      pos.real = true;
    }

    st.pos = pos;
    this.journal({ event: "entry", real: pos.real, symbol: st.symbol, dir, time: bar.openTime, timeVn: formatTimeVn(bar.openTime), entry, initialSL, unit: 1, qty: unit.qty, riskUsd: unit.riskUsd });
    console.log(`[Fast] ENTRY ${formatSymbol(st.symbol)} ${dir.toUpperCase()} @ $${fmtPrice(entry)}${unit.qty != null ? ` · qty ${unit.qty}` : " (giấy)"}`);
    let msg = `⚡${dir === "long" ? "🟢" : "🔴"} *FAST-${this.o.entryDays}d ${dir.toUpperCase()}* ${formatSymbol(st.symbol)} @ $${fmtPrice(entry)}\n` +
      `Breakout ${this.o.entryDays}d · SL $${fmtPrice(initialSL)} (${T.chandelierMult}×ATR trail) · unit 1/${T.pyramidMaxUnits}`;
    if (unit.qty != null) msg += `\n💵 Lệnh thật: ${unit.qty} @ $${fmtPrice(unit.realEntry ?? entry)}${unit.riskUsd != null ? ` · risk $${unit.riskUsd.toFixed(2)}` : ""}`;
    else msg += `\n📋 Alert-only (không đặt lệnh)`;
    await this.tg(msg);
  }

  private async addUnit(st: SymState, pos: Pos, bar: Candle, atrNow: number, silent: boolean): Promise<void> {
    const entry = bar.close;
    const initialSL = pos.dir === "long" ? entry - T.chandelierMult * atrNow : entry + T.chandelierMult * atrNow;
    if (pos.dir === "long" && !(initialSL > 0)) return;

    const unit: Unit = { entry, initialSL, entryTime: bar.openTime };

    if (silent) {
      pos.units.push(unit);
      return;
    }

    if (pos.real && this.tradingLive()) {
      const slFrac = Math.abs(entry - initialSL) / entry;
      if (slFrac > 0.8 / this.o.leverage) return; // vol spike — bỏ add trong im lặng
      try {
        const api = this.o.api!;
        const equity = (await api.getEquity()).walletBalance;
        const slPrice = api.roundPrice(st.symbol, initialSL);
        const dist = Math.abs(entry - slPrice);
        if (dist <= 0) return;
        const f = api.getFilters(st.symbol);
        let qty = api.roundQty(st.symbol, (equity * this.o.riskPct) / dist);
        const needQty = Math.max(f.minQty, (f.minNotional * 1.01) / entry);
        if (qty < needQty) qty = parseFloat((Math.ceil(needQty / f.stepSize) * f.stepSize).toFixed(f.qtyPrecision));
        if (qty <= 0) return;
        const effFrac = (qty * dist) / equity;
        if (this.positionRiskFrac(pos) + effFrac > this.positionRiskBudget() + 1e-9) {
          console.log(`[Fast] ${formatSymbol(st.symbol)} ADD bỏ qua — vị thế đã dùng hết ngân sách risk ${(this.positionRiskBudget() * 100).toFixed(1)}%`);
          return;
        }
        if (this.totalOpenRiskFrac() + effFrac > this.o.maxPortfolioRiskPct + 1e-9) {
          await this.tg(`⚡⏭️ *Fast bỏ ADD* ${formatSymbol(st.symbol)} — chạm trần risk danh mục.`);
          return;
        }
        const fill = await api.marketOrder(st.symbol, pos.dir === "long" ? "BUY" : "SELL", qty);
        if (!(fill.executedQty > 0)) return;
        unit.qty = fill.executedQty;
        unit.realEntry = fill.avgPrice || entry;
        unit.riskUsd = qty * dist;
        unit.riskFrac = effFrac;
        await this.ensureStop(st.symbol, pos); // stop chung closePosition đã phủ khối lượng mới
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[Fast] ${formatSymbol(st.symbol)} LỖI add unit:`, m);
        await this.tg(`⚡⚠️ *Lỗi ADD Fast* ${formatSymbol(st.symbol)} — ${m}\nVị thế hiện tại vẫn được SL bảo vệ.`);
        return;
      }
    }

    pos.units.push(unit);
    this.journal({ event: "add", real: unit.qty != null, symbol: st.symbol, dir: pos.dir, time: bar.openTime, timeVn: formatTimeVn(bar.openTime), entry, initialSL, unit: pos.units.length, qty: unit.qty, riskUsd: unit.riskUsd });
    console.log(`[Fast] ADD ${formatSymbol(st.symbol)} unit ${pos.units.length}/${T.pyramidMaxUnits} @ $${fmtPrice(entry)}${unit.qty != null ? ` · qty ${unit.qty}` : ""}`);
    await this.tg(`⚡➕ *FAST-${this.o.entryDays}d ADD* ${formatSymbol(st.symbol)} ${pos.dir.toUpperCase()} unit ${pos.units.length}/${T.pyramidMaxUnits} @ $${fmtPrice(entry)} · SL chung $${fmtPrice(pos.sl)}${unit.qty != null ? ` · qty ${unit.qty}${unit.riskUsd != null ? ` · risk $${unit.riskUsd.toFixed(2)}` : ""}` : " · (giấy)"}`);
  }

  private async exitPosition(
    st: SymState,
    pos: Pos,
    exitPrice: number,
    reason: "trail" | "time" | "reconcile",
    exitTime: number,
    silent: boolean,
    opts?: { flatten?: boolean }
  ): Promise<void> {
    if (!silent && pos.real && this.tradingLive() && opts?.flatten !== false) {
      try {
        await this.o.trader!.flatten(st.symbol, pos.dir);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[Fast] ${formatSymbol(st.symbol)} LỖI đóng vị thế:`, m);
        await this.tg(`⚡⚠️ *Lỗi đóng lệnh Fast* ${formatSymbol(st.symbol)} — ${m}\nKIỂM TRA vị thế trên sàn!`);
      }
    }

    const rs = pos.units.map((u) => { const risk = Math.abs(u.entry - u.initialSL); const pnl = pos.dir === "long" ? exitPrice - u.entry : u.entry - exitPrice; return risk > 0 ? pnl / risk : 0; });
    const totalR = rs.reduce((a, b) => a + b, 0);
    const heldDays = (exitTime - pos.units[0].entryTime) / TF_MS["1d"];
    st.pos = null;
    if (silent) return;
    this.journal({ event: "exit", real: pos.real, symbol: st.symbol, dir: pos.dir, time: exitTime, timeVn: formatTimeVn(exitTime), exitPrice, reason, units: pos.units.length, unitR: rs.map((r) => +r.toFixed(3)), totalR: +totalR.toFixed(3), heldDays: +heldDays.toFixed(2) });
    console.log(`[Fast] EXIT ${formatSymbol(st.symbol)} ${pos.dir.toUpperCase()} ${reason} @ $${fmtPrice(exitPrice)} (${totalR >= 0 ? "+" : ""}${totalR.toFixed(2)}R)`);
    await this.tg(
      `⚡🔚 *FAST-${this.o.entryDays}d EXIT* ${formatSymbol(st.symbol)} ${pos.dir.toUpperCase()} (${reason}) @ $${fmtPrice(exitPrice)}\n` +
      `${pos.units.length} unit: ${rs.map((r) => (r >= 0 ? "+" : "") + r.toFixed(2)).join(", ")}R → *tổng ${totalR >= 0 ? "+" : ""}${totalR.toFixed(2)}R* · giữ ${heldDays.toFixed(1)}d${pos.real ? "" : " · (giấy)"}`
    );
  }

  // ── Logic 1 nến 4h đã đóng (mirror turtle-live.step, alert-only) ─────────────
  private async step(st: SymState, c: Candle[], i: number, emaArr: number[], atr: number[], gate: (t: number, d: "long" | "short") => boolean, silent: boolean): Promise<void> {
    const bar = c[i];
    const pos = st.pos;
    if (pos) {
      const heldBars = Math.round((bar.openTime - pos.units[0].entryTime) / tfMs);
      const hitStop = pos.dir === "long" ? bar.low <= pos.sl : bar.high >= pos.sl;
      if (hitStop) { await this.exitPosition(st, pos, pos.sl, "trail", bar.openTime, silent); return; }
      if (heldBars >= this.maxHoldBars) { await this.exitPosition(st, pos, bar.close, "time", bar.openTime, silent); return; }
      // chandelier trail (ratchet)
      const oldSl = pos.sl;
      if (pos.dir === "long") { pos.extreme = Math.max(pos.extreme, bar.high); const t = pos.extreme - T.chandelierMult * atr[i]; if (t > pos.sl) pos.sl = t; }
      else { pos.extreme = Math.min(pos.extreme, bar.low); const t = pos.extreme + T.chandelierMult * atr[i]; if (t < pos.sl) pos.sl = t; }
      if (!silent && pos.real && pos.sl !== oldSl && this.tradingLive()) {
        try {
          await this.o.trader!.syncStops(st.symbol, this.posInfo(pos), { noTp: true });
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          console.error(`[Fast] ${formatSymbol(st.symbol)} LỖI dời SL:`, m);
          await this.tg(`⚡⚠️ *Lỗi dời SL Fast* ${formatSymbol(st.symbol)} — ${m}`);
        }
      }
      // pyramiding
      if (T.pyramidStepAtr > 0 && pos.units.length < T.pyramidMaxUnits && atr[i] > 0) {
        const last = pos.units[pos.units.length - 1];
        const trig = pos.dir === "long" ? bar.close >= last.entry + T.pyramidStepAtr * atr[i] : bar.close <= last.entry - T.pyramidStepAtr * atr[i];
        if (trig) await this.addUnit(st, pos, bar, atr[i], silent);
      }
      return;
    }
    // entry mới — Donchian breakout ngắn + EMA50 + BTC gate (như turtle)
    let hh = -Infinity, ll = Infinity;
    for (let k = i - this.dcEntry; k < i; k++) { hh = Math.max(hh, c[k].high); ll = Math.min(ll, c[k].low); }
    const uptrend = bar.close > emaArr[i], downtrend = bar.close < emaArr[i];
    if (uptrend && gate(bar.openTime, "long") && bar.close > hh) await this.openPosition(st, bar, "long", atr[i], silent);
    else if (T.allowShort && downtrend && gate(bar.openTime, "short") && bar.close < ll) await this.openPosition(st, bar, "short", atr[i], silent);
  }

  private async processSymbol(st: SymState, c: Candle[], gate: (t: number, d: "long" | "short") => boolean, silent: boolean): Promise<void> {
    const closes = c.map((x) => x.close);
    const emaArr = ema(closes, T.trendLen);
    const atr = atrSeries(c, T.atrPeriod);
    for (let i = this.warmupBars; i < c.length; i++) {
      if (c[i].openTime <= st.lastBarTime) continue;
      await this.step(st, c, i, emaArr, atr, gate, silent);
      st.lastBarTime = c[i].openTime;
    }
    this.persist();
  }

  private async fetchClosed(symbol: string): Promise<Candle[]> {
    const c = await fetchKlinesPaged(symbol, TF, FETCH_BARS);
    const now = Date.now();
    while (c.length && c[c.length - 1].openTime + tfMs > now) c.pop(); // bỏ nến chưa đóng
    return c;
  }

  // ── Đối soát với sàn ─────────────────────────────────────────────────────
  /** Vị thế thật trong state nhưng sàn đã FLAT (stop khớp/đóng tay) → chốt sổ tại SL. */
  private async reconcileHeld(): Promise<void> {
    if (!this.tradingLive() || this.cycling) return;
    for (const st of this.states.values()) {
      const pos = st.pos;
      if (!pos?.real) continue;
      let p;
      try {
        p = await this.o.trader!.reconcile(st.symbol);
      } catch {
        continue;
      }
      if (st.pos !== pos) continue; // cycle vừa xử lý xong vị thế này trong lúc await
      if (Math.abs(p.positionAmt) > 0) continue;
      console.log(`[Fast] ${formatSymbol(st.symbol)} sàn đã FLAT — chốt sổ tại SL $${fmtPrice(pos.sl)}`);
      await this.exitPosition(st, pos, pos.sl, "reconcile", Date.now(), false, { flatten: true });
    }
  }

  /**
   * Cold-start: đối soát vị thế dựng lại từ replay ↔ sàn. KHÔNG blind-adopt orphan không rõ chủ —
   * rổ symbol fast trùng cả SMC lẫn Turtle nên 1 vị thế lạ trên sàn có thể thuộc về lớp khác đang
   * xử lý chậm; an toàn hơn là báo thủ công thay vì tự nhận nhầm.
   */
  private async reconcileStartup(): Promise<void> {
    if (!this.tradingLive()) return;
    for (const st of this.states.values()) {
      let p;
      try {
        p = await this.o.trader!.reconcile(st.symbol);
      } catch (e) {
        console.warn(`[Fast] ${formatSymbol(st.symbol)} không đọc được vị thế: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      const exHas = Math.abs(p.positionAmt) > 0;
      const exDir: "long" | "short" = p.positionAmt > 0 ? "long" : "short";
      const pos = st.pos;

      if (pos && exHas && !pos.real) {
        if (this.o.otherHoldsSymbol(st.symbol)) continue; // vị thế sàn là của SMC/Turtle — fast giữ giấy
        if (exDir === pos.dir) {
          pos.real = true;
          pos.units[0].qty = Math.abs(p.positionAmt);
          pos.units[0].realEntry = p.entryPrice;
          try {
            await this.ensureStop(st.symbol, pos);
          } catch (e) {
            await this.tg(`⚡⚠️ ADOPT ${formatSymbol(st.symbol)} nhưng đặt SL lỗi: ${e instanceof Error ? e.message : e} — KIỂM TRA SÀN!`);
          }
          await this.tg(`⚡🔁 *Fast ADOPT vị thế sàn* ${formatSymbol(st.symbol)} ${exDir.toUpperCase()} qty ${Math.abs(p.positionAmt)} — khớp replay, SL $${fmtPrice(pos.sl)}`);
        } else {
          await this.tg(`⚡⚠️ *Lệch hướng* ${formatSymbol(st.symbol)}: fast-replay=${pos.dir.toUpperCase()} nhưng sàn=${exDir.toUpperCase()}. Fast theo dõi GIẤY, kiểm tra thủ công.`);
        }
      } else if (pos?.real && !exHas) {
        console.log(`[Fast] ${formatSymbol(st.symbol)} state giữ nhưng sàn flat — chốt sổ.`);
        await this.exitPosition(st, pos, pos.sl, "reconcile", Date.now(), false);
      } else if (!pos && exHas && !this.o.otherHoldsSymbol(st.symbol)) {
        await this.tg(`⚡❓ *Vị thế lạ trên sàn* ${formatSymbol(st.symbol)} ${exDir.toUpperCase()} qty ${Math.abs(p.positionAmt)} — không khớp replay Fast, không do SMC/Turtle giữ. KIỂM TRA THỦ CÔNG (fast KHÔNG tự nhận).`);
      }
    }
    this.persist();
  }

  private async cycle(silentColdStart = false): Promise<void> {
    if (this.cycling) return;
    this.cycling = true;
    try {
      const btc = await this.fetchClosed("btcusdt");
      if (btc.length < this.warmupBars + 2) { console.warn("[Fast] thiếu nến BTC cho gate — bỏ chu kỳ."); return; }
      const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
      for (const st of this.states.values()) {
        try {
          const c = st.symbol === "btcusdt" ? btc : await this.fetchClosed(st.symbol);
          if (c.length < this.warmupBars + 2) continue;
          const isCold = silentColdStart && st.lastBarTime === 0;
          await this.processSymbol(st, c, gate, isCold);
        } catch (err) { console.error(`[Fast] ${formatSymbol(st.symbol)} lỗi chu kỳ:`, err instanceof Error ? err.message : err); }
      }
    } finally { this.cycling = false; }
  }

  async start(): Promise<void> {
    this.loadState();
    const held = [...this.states.values()].filter((s) => s.pos);
    if (held.length) {
      console.log(`[Fast] Khôi phục ${held.length} vị thế: ${held.map((s) => formatSymbol(s.symbol)).join(", ")}`);
    }

    console.log(`[Fast] ⚡ Khởi động — ${this.o.symbols.length} symbol @ ${TF} | breakout ${this.o.entryDays}d | EMA${T.trendLen} | BTC gate ${T.btcGateFast / BARS_PER_DAY}/${T.btcGateSlow / BARS_PER_DAY}d | ${this.o.trader ? `risk ${(this.o.riskPct * 100).toFixed(2)}%/unit` : "ALERT-ONLY"}`);
    // Thứ tự an toàn giống Turtle: (1) chốt sổ vị thế thật đã đóng lúc offline → (2) replay nến lỡ
    // trên state đã đúng → (3) đối soát cold-start với sàn.
    await this.reconcileHeld();
    await this.cycle(true); // cold-start: symbol chưa có state → silent replay dựng vị thế
    await this.reconcileStartup();

    const heldNow = [...this.states.values()].filter((s) => s.pos);
    console.log(`[Fast] ✅ Sẵn sàng — đang giữ ${heldNow.length} vị thế${heldNow.length ? ": " + heldNow.map((s) => `${formatSymbol(s.symbol)} ${s.pos!.dir}${s.pos!.real ? "" : "(giấy)"}`).join(", ") : ""}`);

    this.lastBoundary = Math.floor(Date.now() / tfMs) * tfMs;
    setInterval(() => {
      const now = Date.now();
      const boundary = Math.floor(now / tfMs) * tfMs;
      if (boundary > this.lastBoundary && now - boundary >= SETTLE_MS) {
        this.lastBoundary = boundary;
        void this.cycle().catch((e) => console.error("[Fast] cycle lỗi:", e instanceof Error ? e.message : e));
      }
    }, CHECK_MS);
    setInterval(() => void this.reconcileHeld().catch(() => {}), RECONCILE_MS);
  }
}
