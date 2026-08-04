/**
 * fast-trend-live.ts — Sleeve trend NHANH chạy long breakout 10d và short breakout chậm hơn
 * để giảm false-break, trên venue thực thi riêng (MEXC khi được cấu hình).
 * trên venue thực thi riêng (MEXC khi được cấu hình), tách khỏi Turtle/Binance.
 *
 * An toàn theo thiết kế:
 *   - KHÔNG đụng state/journal của turtle (turtle-state.json) hay SMC (bot-state.json).
 *     Dùng file RIÊNG: fast-trend-mexc-state.json + fast-trend-mexc-trades.jsonl.
 *   - LONG: close phá high 10d. SHORT: close phá close-low 30d, rồi nến 4h kế tiếp phải tiếp
 *     tục đóng dưới mức breakout đã đóng băng mới vào. Exit vẫn Chandelier 3×ATR hai hướng.
 *   - Cold-start: replay IM LẶNG lịch sử để dựng lại vị thế hiện tại, KHÔNG spam alert quá khứ.
 */
import fs from "fs";
import path from "path";
import { fetchKlinesPaged } from "./backtest";
import { Candle, TF_MS } from "./strategy";
import { T, buildBtcGateLongs, ema, atrSeries } from "./turtle";
import { FastExecution, FastExecutionPositionIntent } from "./fast-trend-execution";
import { TelegramConfig, sendTelegram, formatSymbol, fmtPrice, formatTimeVn, escapeMarkdown } from "./telegram";

const DATA_DIR = path.resolve(process.env.FAST_TREND_DATA_DIR?.trim() || process.cwd());
const STATE_FILE = path.join(DATA_DIR, "fast-trend-mexc-state.json");
const JOURNAL_FILE = path.join(DATA_DIR, "fast-trend-mexc-trades.jsonl");

/** Temp + fsync + same-directory rename. The target must not itself be a bind-mount point. */
export function atomicWriteFileSync(
  target: string,
  data: string,
  renameFile: typeof fs.renameSync = fs.renameSync,
): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data);
  const fd = fs.openSync(tmp, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  renameFile(tmp, target);
  let dirFd: number | undefined;
  try {
    dirFd = fs.openSync(path.dirname(target), "r");
    fs.fsyncSync(dirFd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(code)) throw error;
  } finally {
    if (dirFd != null) fs.closeSync(dirFd);
  }
}

const TF = T.tf; // 4h — cùng khung turtle
const tfMs = TF_MS[TF];
const BARS_PER_DAY = TF_MS["1d"] / tfMs;
const FETCH_BARS = 1100; // warmup gate SMA100d (600) + đủ replay
const SETTLE_MS = 90_000; // đợi nến 4h chốt hẳn trên sàn
const CHECK_MS = 60_000;
const RECONCILE_MS = 10 * 60_000; // lưới an toàn: đối soát vị thế thật với sàn

export const FAST_SHORT_ENTRY_DAYS = 30;
export const FAST_SHORT_CONFIRM_BARS = 1;
/**
 * Trần unit RIÊNG của Fast — GHIM 4, không dùng `FAST_MAX_UNITS`.
 * Turtle hạ 4→3 ngày 2026-08-04 dựa trên audit CỦA TURTLE (planning/portfolio-risk-and-exit-2026-08.md);
 * audit của Fast (planning/trend-method-remediation-research-2026-08.md) là một bảng khác
 * (NET +85/+162/+211/+244R theo 1/2/3/4 unit). Không để thay đổi của sleeve này trôi sang sleeve kia.
 */
const FAST_MAX_UNITS = 4;
const FAST_SHORT_ENTRY_BARS = Math.max(2, Math.round(FAST_SHORT_ENTRY_DAYS * BARS_PER_DAY));

export type FastShortEntrySetup = {
  breakoutLevel: number;
  signalBarTime: number;
};

export function decideFastShortConfirmation(
  setup: FastShortEntrySetup,
  bar: Pick<Candle, "openTime" | "close">,
  downtrend: boolean,
  gateOk: boolean,
): "wait" | "enter" | "cancel" {
  if (bar.openTime <= setup.signalBarTime) return "wait";
  if (bar.openTime !== setup.signalBarTime + FAST_SHORT_CONFIRM_BARS * tfMs) return "cancel";
  return downtrend && gateOk && bar.close < setup.breakoutLevel ? "enter" : "cancel";
}

export function priorFastShortCloseLow(candles: Candle[], index: number): number {
  if (index < FAST_SHORT_ENTRY_BARS) return Infinity;
  let closeLow = Infinity;
  for (let k = index - FAST_SHORT_ENTRY_BARS; k < index; k++) closeLow = Math.min(closeLow, candles[k].close);
  return closeLow;
}

type Unit = {
  entry: number;
  initialSL: number;
  entryTime: number;
  qty?: number; // khối lượng thật đã khớp (undefined = giấy)
  realEntry?: number;
  riskUsd?: number;
  riskFrac?: number; // risk hiệu dụng/equity lúc fill (có thể > riskPct danh nghĩa do sàn minNotional)
};
type Pos = {
  dir: "long" | "short";
  units: Unit[];
  sl: number;
  extreme: number;
  real: boolean;
  positionId?: string;
  protectionId?: string;
  venueScale?: number;
  confirmedVenueSl?: number;
};
type PendingAction = {
  kind: "entry" | "add" | "stop" | "exit";
  key: string;
  startedAt: number;
  unit?: Unit;
  exitPrice?: number;
  exitReason?: "trail" | "time" | "reconcile";
  exitTime?: number;
};
type SymState = {
  symbol: string;
  lastBarTime: number;
  pos: Pos | null;
  shortEntrySetup?: FastShortEntrySetup;
  pending?: PendingAction;
  quarantined?: string;
};

export interface FastTrendOpts {
  symbols: string[];
  entryDays: number; // breakout lookback (ngày) — 10 mặc định
  telegram: TelegramConfig;
  execution: FastExecution | null; // null → alert-only
  riskPct: number; // frac equity / unit
  maxPortfolioRiskPct: number; // trần riêng của tài khoản MEXC
  leverage: number; // để guard SL rộng hơn vùng thanh lý
  /** Tổng risk frac lớp khác cùng venue/account (hiện tại luôn 0 vì MEXC dành riêng cho Fast). */
  otherOpenRiskFrac: () => number;
  /** MEXC đã preflight OK chưa. Chỉ chặn entry/add; quản lý vị thế vẫn luôn thử. */
  isTradingReady: () => boolean;
}

export class FastTrendLive {
  private readonly states = new Map<string, SymState>();
  private lastBoundary = 0;
  private cycling = false;
  private persistenceHealthy = true;
  private persistenceError?: string;
  private readonly dcEntry: number;
  private readonly maxHoldBars: number;
  private readonly warmupBars: number;

  constructor(private readonly o: FastTrendOpts) {
    this.dcEntry = Math.max(2, Math.round(o.entryDays * BARS_PER_DAY));
    this.maxHoldBars = Math.round(T.maxHoldDays * BARS_PER_DAY);
    this.warmupBars = Math.max(this.dcEntry, FAST_SHORT_ENTRY_BARS, T.trendLen, T.atrPeriod, T.btcGateSlow) + 1;
  }

  // ── State & journal (RIÊNG, không đụng turtle/SMC) ──────────────────────────
  private persist(): boolean {
    try {
      atomicWriteFileSync(STATE_FILE, JSON.stringify([...this.states.values()], null, 2));
      if (!this.persistenceHealthy) console.log("[Fast] ✅ Ghi state MEXC đã phục hồi; cho phép entry/add mới.");
      this.persistenceHealthy = true;
      this.persistenceError = undefined;
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (this.persistenceHealthy || message !== this.persistenceError) {
        console.error("[Fast] ghi fast-trend-mexc-state.json lỗi — khóa entry/add mới:", message);
      }
      this.persistenceHealthy = false;
      this.persistenceError = message;
      return false;
    }
  }
  private journal(rec: Record<string, unknown>): void {
    try { fs.appendFileSync(JOURNAL_FILE, JSON.stringify({ strategy: "fast-trend", entryDays: this.o.entryDays, shortEntryDays: FAST_SHORT_ENTRY_DAYS, shortConfirmBars: FAST_SHORT_CONFIRM_BARS, ...rec }) + "\n"); }
    catch (e) { console.error("[Fast] ghi fast-trend-mexc-trades.jsonl lỗi:", e instanceof Error ? e.message : e); }
  }
  private loadState(): void {
    let saved: SymState[] = [];
    let loadError: string | undefined;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, "utf8").trim();
        if (raw) saved = JSON.parse(raw);
      }
    }
    catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      this.persistenceHealthy = false;
      this.persistenceError = loadError;
      console.error("[Fast] đọc fast-trend-mexc-state.json lỗi — quarantine toàn bộ Fast:", loadError);
    }
    const bySym = new Map(saved.map((s) => [s.symbol, s]));
    for (const sym of this.o.symbols) {
      const s = bySym.get(sym);
      this.states.set(
        sym,
        s
          ? { ...s, pos: s.pos ? { ...s.pos, units: [...s.pos.units] } : null, shortEntrySetup: s.pos ? undefined : s.shortEntrySetup }
          : { symbol: sym, lastBarTime: 0, pos: null, quarantined: loadError ? `state lỗi: ${loadError}` : undefined },
      );
    }
  }

  statusLines(): string[] {
    const lines: string[] = [];
    for (const st of this.states.values()) {
      if (!st.pos) {
        if (st.quarantined || st.pending || st.shortEntrySetup) {
          const detail = st.quarantined
            ?? (st.pending ? `pending ${st.pending.kind}` : `armed SHORT close-${FAST_SHORT_ENTRY_DAYS}d @ ${fmtPrice(st.shortEntrySetup!.breakoutLevel)}; chờ 1 nến 4h`);
          lines.push(`⚡🟠 *${formatSymbol(st.symbol)}* MEXC — ${escapeMarkdown(detail)}`);
        }
        continue;
      }
      const p = st.pos;
      const icon = p.dir === "long" ? "⚡🟢 LONG" : "⚡🔴 SHORT";
      const heldD = ((Date.now() - p.units[0].entryTime) / TF_MS["1d"]).toFixed(1);
      const venue = p.real ? this.o.execution?.venueLabel ?? "LIVE" : "giấy";
      const state = st.quarantined ? ` · ⚠️ ${escapeMarkdown(st.quarantined)}` : st.pending ? ` · pending ${st.pending.kind}` : "";
      lines.push(`${icon} *${formatSymbol(st.symbol)}* (fast-${this.o.entryDays}d, ${venue}) — ${p.units.length}/${FAST_MAX_UNITS} unit · Entry₁ $${fmtPrice(p.units[0].entry)} · SL tín hiệu $${fmtPrice(p.sl)}${p.confirmedVenueSl ? ` · SL MEXC $${fmtPrice(p.confirmedVenueSl)}` : ""} · giữ ${heldD}d${state}`);
    }
    return lines;
  }

  runtimeSummary(): { real: number; paper: number; armed: number; pending: number; quarantined: number; persistenceHealthy: boolean; persistenceError?: string } {
    let real = 0, paper = 0, armed = 0, pending = 0, quarantined = 0;
    for (const st of this.states.values()) {
      if (st.pos?.real) real++;
      else if (st.pos) paper++;
      if (st.shortEntrySetup) armed++;
      if (st.pending) pending++;
      if (st.quarantined) quarantined++;
    }
    return { real, paper, armed, pending, quarantined, persistenceHealthy: this.persistenceHealthy, persistenceError: this.persistenceError };
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
    return FAST_MAX_UNITS * this.o.riskPct;
  }

  /** Tổng risk frac hiệu dụng các unit thật của một vị thế. */
  private positionRiskFrac(pos: Pos): number {
    let n = 0;
    for (const u of pos.units) if (u.qty != null) n += u.riskFrac ?? this.o.riskPct;
    return n;
  }

  private tradingLive(): boolean {
    return !!this.o.execution && this.o.isTradingReady() && this.persistenceHealthy;
  }

  private canManageLive(): boolean {
    return !!this.o.execution;
  }

  private totalOpenRiskFrac(): number {
    return this.o.otherOpenRiskFrac() + this.openRiskFrac();
  }

  /** Đảm bảo trên sàn có đúng 1 STOP_MARKET tại pos.sl (sau add / sau adopt). */
  private async ensureStop(symbol: string, pos: Pos): Promise<void> {
    if (!this.o.execution) return;
    const protection = await this.o.execution.syncStops(symbol, this.executionIntent(pos));
    pos.protectionId = protection.protectionId;
    pos.confirmedVenueSl = protection.stopPrice;
  }

  private executionIntent(pos: Pos): FastExecutionPositionIntent {
    const u0 = pos.units[0];
    return {
      dir: pos.dir,
      signalEntry: u0.entry,
      initialSL: u0.initialSL,
      signalStop: pos.sl,
      venueScale: pos.venueScale,
      positionId: pos.positionId,
      protectionId: pos.protectionId,
    };
  }

  private operationKey(st: SymState, kind: PendingAction["kind"], time: number, unit: number): string {
    return `fast:mexc:${st.symbol}:${kind}:${time}:${unit}`;
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

    if (st.quarantined || st.pending) {
      console.warn(`[Fast] ${formatSymbol(st.symbol)} bỏ entry — ${st.quarantined ?? `pending ${st.pending!.kind}`}`);
      return;
    }
    if (this.o.execution && !this.persistenceHealthy) {
      console.warn(`[Fast] ${formatSymbol(st.symbol)} bỏ entry — state storage chưa sẵn sàng`);
      return;
    }

    if (this.tradingLive()) {
      const slFrac = Math.abs(entry - initialSL) / entry;
      if (slFrac > 0.8 / this.o.leverage) {
        await this.tg(`⚡⏭️ *Fast bỏ entry* ${formatSymbol(st.symbol)} ${dir.toUpperCase()} — SL ${(slFrac * 100).toFixed(1)}% quá gần vùng thanh lý (${this.o.leverage}x).`);
        return;
      }
      const key = this.operationKey(st, "entry", bar.openTime, 1);
      st.pos = pos; // persist strategy intent before the venue mutation
      st.pending = { kind: "entry", key, startedAt: Date.now() };
      if (!this.persist()) {
        st.pos = null;
        st.pending = undefined;
        await this.tg(`⚡🚨 *Fast/MEXC khóa entry* ${formatSymbol(st.symbol)} — không ghi được state bền vững; không gửi lệnh lên sàn.`);
        return;
      }
      let res;
      try {
        res = await this.o.execution!.open(
          st.symbol,
          this.executionIntent(pos),
          this.totalOpenRiskFrac(),
          key,
          this.positionRiskBudget(),
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        st.quarantined = `entry chưa rõ kết quả: ${m}`;
        this.persist();
        console.error(`[Fast] ${formatSymbol(st.symbol)} LỖI mở lệnh:`, m);
        await this.tg(`⚡❌ *Lỗi đặt lệnh Fast/MEXC* ${formatSymbol(st.symbol)} — ${escapeMarkdown(m)}\nĐã quarantine symbol; bot không retry mù.`);
        return;
      }
      if (!res.placed) {
        st.pos = null;
        st.pending = undefined;
        this.persist();
        await this.tg(`⚡⏭️ *Fast bỏ lệnh* ${formatSymbol(st.symbol)} ${dir.toUpperCase()} — ${res.reason ?? "không rõ"}`);
        return;
      }
      unit.qty = res.qty;
      unit.realEntry = res.avgPrice;
      unit.riskUsd = res.riskUsd;
      unit.riskFrac = res.equity ? (res.riskUsd ?? 0) / res.equity : this.o.riskPct;
      pos.real = true;
      pos.positionId = res.positionId;
      pos.protectionId = res.protectionId;
      pos.venueScale = res.venueScale;
      pos.confirmedVenueSl = res.confirmedVenueSl;
      st.pending = undefined;
      st.quarantined = undefined;
    }

    st.pos = pos;
    this.persist();
    this.journal({ event: "entry", venue: pos.real ? this.o.execution?.venueLabel : "paper", real: pos.real, symbol: st.symbol, dir, time: bar.openTime, timeVn: formatTimeVn(bar.openTime), entry, initialSL, unit: 1, qty: unit.qty, realEntry: unit.realEntry, riskUsd: unit.riskUsd, positionId: pos.positionId, protectionId: pos.protectionId, confirmedVenueSl: pos.confirmedVenueSl });
    console.log(`[Fast] ENTRY ${formatSymbol(st.symbol)} ${dir.toUpperCase()} @ $${fmtPrice(entry)}${unit.qty != null ? ` · qty ${unit.qty}` : " (giấy)"}`);
    const entryRule = dir === "short"
      ? `Close-low ${FAST_SHORT_ENTRY_DAYS}d + ${FAST_SHORT_CONFIRM_BARS} nến 4h xác nhận`
      : `High breakout ${this.o.entryDays}d`;
    let msg = `⚡${dir === "long" ? "🟢" : "🔴"} *FAST-${this.o.entryDays}d ${dir.toUpperCase()}* ${formatSymbol(st.symbol)} @ $${fmtPrice(entry)}\n` +
      `${entryRule} · SL $${fmtPrice(initialSL)} (${T.chandelierMult}×ATR trail) · unit 1/${FAST_MAX_UNITS}`;
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

    if (pos.real && (!this.tradingLive() || st.quarantined || st.pending)) return;

    if (pos.real && this.tradingLive()) {
      const slFrac = Math.abs(entry - initialSL) / entry;
      if (slFrac > 0.8 / this.o.leverage) return; // vol spike — bỏ add trong im lặng
      const key = this.operationKey(st, "add", bar.openTime, pos.units.length + 1);
      st.pending = { kind: "add", key, startedAt: Date.now(), unit };
      if (!this.persist()) {
        st.pending = undefined;
        await this.tg(`⚡🚨 *Fast/MEXC khóa ADD* ${formatSymbol(st.symbol)} — không ghi được state bền vững; không gửi lệnh lên sàn.`);
        return;
      }
      try {
        const res = await this.o.execution!.add(
          st.symbol,
          { ...this.executionIntent(pos), signalEntry: entry, initialSL },
          this.totalOpenRiskFrac(),
          this.positionRiskFrac(pos),
          key,
          this.positionRiskBudget(),
        );
        if (!res.placed) {
          st.pending = undefined;
          this.persist();
          if (res.reason) console.log(`[Fast] ${formatSymbol(st.symbol)} ADD bỏ qua — ${res.reason}`);
          return;
        }
        unit.qty = res.qty;
        unit.realEntry = res.avgPrice || entry;
        unit.riskUsd = res.riskUsd;
        unit.riskFrac = res.equity ? (res.riskUsd ?? 0) / res.equity : this.o.riskPct;
        pos.positionId = res.positionId ?? pos.positionId;
        pos.units.push(unit); // persist fill before protection resize
        st.pending = { kind: "stop", key: `${key}:stop`, startedAt: Date.now() };
        this.persist();
        await this.ensureStop(st.symbol, pos);
        st.pending = undefined;
        this.persist();
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        st.quarantined = `ADD/stop chưa rõ kết quả: ${m}`;
        this.persist();
        console.error(`[Fast] ${formatSymbol(st.symbol)} LỖI add unit:`, m);
        await this.tg(`⚡⚠️ *Lỗi ADD Fast/MEXC* ${formatSymbol(st.symbol)} — ${escapeMarkdown(m)}\nĐã lưu pending và quarantine; kiểm tra protection trên MEXC.`);
        return;
      }
    } else {
      pos.units.push(unit);
    }

    this.journal({ event: "add", venue: unit.qty != null ? this.o.execution?.venueLabel : "paper", real: unit.qty != null, symbol: st.symbol, dir: pos.dir, time: bar.openTime, timeVn: formatTimeVn(bar.openTime), entry, initialSL, unit: pos.units.length, qty: unit.qty, realEntry: unit.realEntry, riskUsd: unit.riskUsd, positionId: pos.positionId, protectionId: pos.protectionId, confirmedVenueSl: pos.confirmedVenueSl });
    console.log(`[Fast] ADD ${formatSymbol(st.symbol)} unit ${pos.units.length}/${FAST_MAX_UNITS} @ $${fmtPrice(entry)}${unit.qty != null ? ` · qty ${unit.qty}` : ""}`);
    await this.tg(`⚡➕ *FAST-${this.o.entryDays}d ADD* ${formatSymbol(st.symbol)} ${pos.dir.toUpperCase()} unit ${pos.units.length}/${FAST_MAX_UNITS} @ $${fmtPrice(entry)} · SL chung $${fmtPrice(pos.sl)}${unit.qty != null ? ` · qty ${unit.qty}${unit.riskUsd != null ? ` · risk $${unit.riskUsd.toFixed(2)}` : ""}` : " · (giấy)"}`);
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
    if (!silent && pos.real && opts?.flatten !== false) {
      if (!this.o.execution) {
        st.quarantined = "không có MEXC executor để đóng vị thế thật";
        this.persist();
        await this.tg(`⚡🚨 *Fast không thể đóng* ${formatSymbol(st.symbol)} — thiếu MEXC executor; state được giữ nguyên.`);
        return;
      }
      const key = this.operationKey(st, "exit", exitTime, pos.units.length);
      st.pending = { kind: "exit", key, startedAt: Date.now(), exitPrice, exitReason: reason, exitTime };
      this.persist();
      try {
        await this.o.execution.flatten(st.symbol, pos.dir, key);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        st.quarantined = `exit chưa xác nhận: ${m}`;
        this.persist();
        console.error(`[Fast] ${formatSymbol(st.symbol)} LỖI đóng vị thế:`, m);
        await this.tg(`⚡🚨 *Lỗi đóng Fast/MEXC* ${formatSymbol(st.symbol)} — ${escapeMarkdown(m)}\nState/pending exit vẫn được giữ; kiểm tra vị thế trên sàn.`);
        return;
      }
    }

    const rs = pos.units.map((u) => { const risk = Math.abs(u.entry - u.initialSL); const pnl = pos.dir === "long" ? exitPrice - u.entry : u.entry - exitPrice; return risk > 0 ? pnl / risk : 0; });
    const totalR = rs.reduce((a, b) => a + b, 0);
    const heldDays = (exitTime - pos.units[0].entryTime) / TF_MS["1d"];
    st.pos = null;
    st.pending = undefined;
    st.quarantined = undefined;
    this.persist();
    if (silent) return;
    this.journal({ event: "exit", venue: pos.real ? this.o.execution?.venueLabel : "paper", real: pos.real, symbol: st.symbol, dir: pos.dir, time: exitTime, timeVn: formatTimeVn(exitTime), exitPrice, reason, units: pos.units.length, unitR: rs.map((r) => +r.toFixed(3)), totalR: +totalR.toFixed(3), heldDays: +heldDays.toFixed(2), positionId: pos.positionId });
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
      if (st.pending?.kind === "exit") return; // reconciliation owns an ambiguous exit
      const heldBars = Math.round((bar.openTime - pos.units[0].entryTime) / tfMs);
      const hitStop = pos.dir === "long" ? bar.low <= pos.sl : bar.high >= pos.sl;
      if (hitStop) { await this.exitPosition(st, pos, pos.sl, "trail", bar.openTime, silent); return; }
      if (heldBars >= this.maxHoldBars) { await this.exitPosition(st, pos, bar.close, "time", bar.openTime, silent); return; }
      // chandelier trail (ratchet)
      const oldSl = pos.sl;
      if (pos.dir === "long") { pos.extreme = Math.max(pos.extreme, bar.high); const t = pos.extreme - T.chandelierMult * atr[i]; if (t > pos.sl) pos.sl = t; }
      else { pos.extreme = Math.min(pos.extreme, bar.low); const t = pos.extreme + T.chandelierMult * atr[i]; if (t < pos.sl) pos.sl = t; }
      if (!silent && pos.real && pos.sl !== oldSl) {
        if (!this.canManageLive()) {
          pos.sl = oldSl;
          st.quarantined = "mất MEXC executor khi cần dời stop";
          this.persist();
        } else {
          const key = this.operationKey(st, "stop", bar.openTime, pos.units.length);
          st.pending = { kind: "stop", key, startedAt: Date.now() };
          this.persist();
          try {
            await this.ensureStop(st.symbol, pos);
            st.pending = undefined;
            this.persist();
          } catch (err) {
            pos.sl = oldSl; // local state must remain at the last exchange-confirmed stop
            const m = err instanceof Error ? err.message : String(err);
            console.error(`[Fast] ${formatSymbol(st.symbol)} LỖI dời SL:`, m);
            this.persist();
            await this.tg(`⚡⚠️ *Lỗi dời SL Fast/MEXC* ${formatSymbol(st.symbol)} — ${escapeMarkdown(m)}\nGiữ SL đã xác nhận trước đó; pending sẽ được đối soát lại.`);
          }
        }
      }
      // pyramiding
      if (T.pyramidStepAtr > 0 && pos.units.length < FAST_MAX_UNITS && atr[i] > 0) {
        const last = pos.units[pos.units.length - 1];
        const trig = pos.dir === "long" ? bar.close >= last.entry + T.pyramidStepAtr * atr[i] : bar.close <= last.entry - T.pyramidStepAtr * atr[i];
        if (trig) await this.addUnit(st, pos, bar, atr[i], silent);
      }
      return;
    }
    if (st.quarantined || st.pending) return;

    // LONG giữ high-breakout nhanh. SHORT dùng close-low 30d rồi chờ đúng nến 4h kế tiếp
    // tiếp tục đóng dưới mức breakout đã đóng băng; thất bại hoặc thiếu nến thì hủy setup.
    const uptrend = bar.close > emaArr[i], downtrend = bar.close < emaArr[i];
    if (st.shortEntrySetup) {
      const setup = st.shortEntrySetup;
      const decision = decideFastShortConfirmation(setup, bar, downtrend, gate(bar.openTime, "short"));
      if (decision === "wait") return;
      st.shortEntrySetup = undefined;
      if (!silent) {
        this.journal({ event: decision === "enter" ? "entry_confirm" : "entry_cancel", symbol: st.symbol, dir: "short", signalTime: setup.signalBarTime, time: bar.openTime, timeVn: formatTimeVn(bar.openTime), breakoutLevel: setup.breakoutLevel, close: bar.close, downtrend });
        console.log(`[Fast] ${formatSymbol(st.symbol)} SHORT close-${FAST_SHORT_ENTRY_DAYS}d ${decision === "enter" ? "CONFIRM" : "CANCEL"} @ $${fmtPrice(bar.close)} (mức $${fmtPrice(setup.breakoutLevel)})`);
        this.persist();
      }
      if (decision === "enter") {
        await this.openPosition(st, bar, "short", atr[i], silent);
        return;
      }
    }

    let longHigh = -Infinity;
    for (let k = i - this.dcEntry; k < i; k++) longHigh = Math.max(longHigh, c[k].high);
    if (uptrend && gate(bar.openTime, "long") && bar.close > longHigh) {
      await this.openPosition(st, bar, "long", atr[i], silent);
      return;
    }

    if (!T.allowShort || !downtrend || !gate(bar.openTime, "short")) return;
    const shortCloseLow = priorFastShortCloseLow(c, i);
    if (bar.close < shortCloseLow) {
      st.shortEntrySetup = { breakoutLevel: shortCloseLow, signalBarTime: bar.openTime };
      if (!silent) {
        this.journal({ event: "entry_arm", symbol: st.symbol, dir: "short", time: bar.openTime, timeVn: formatTimeVn(bar.openTime), breakoutLevel: shortCloseLow, close: bar.close });
        console.log(`[Fast] ${formatSymbol(st.symbol)} ARM SHORT close-${FAST_SHORT_ENTRY_DAYS}d @ $${fmtPrice(bar.close)} — chờ nến 4h kế tiếp giữ dưới $${fmtPrice(shortCloseLow)}`);
        this.persist();
      }
    }
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
    if (!this.canManageLive() || this.cycling) return;
    await this.reconcileStartup(); // also resolves pending entry/add without requiring a restart
    for (const st of this.states.values()) {
      const pos = st.pos;
      if (!pos?.real) continue;
      if (st.pending?.kind === "exit") {
        try {
          await this.o.execution!.flatten(st.symbol, pos.dir, st.pending.key);
        } catch {
          continue;
        }
      }
      let p;
      try {
        p = await this.o.execution!.reconcile(st.symbol);
      } catch {
        continue;
      }
      if (st.pos !== pos) continue; // cycle vừa xử lý xong vị thế này trong lúc await
      if (Math.abs(p.positionAmt) > 0) {
        if (st.pending?.kind === "stop") {
          try {
            await this.ensureStop(st.symbol, pos);
            st.pending = undefined;
            st.quarantined = undefined;
            this.persist();
          } catch {
            /* giữ pending để chu kỳ sau thử lại */
          }
        }
        continue;
      }
      const pendingExit = st.pending?.kind === "exit" ? st.pending : undefined;
      console.log(`[Fast] ${formatSymbol(st.symbol)} sàn đã FLAT — chốt sổ tại SL $${fmtPrice(pos.sl)}`);
      await this.exitPosition(
        st,
        pos,
        pendingExit?.exitPrice ?? pos.sl,
        pendingExit?.exitReason ?? "reconcile",
        pendingExit?.exitTime ?? Date.now(),
        false,
        { flatten: false },
      );
    }
  }

  /**
   * Cold-start: chỉ recover vị thế khi durable operation key chứng minh ownership. Không blind-adopt
   * vị thế MEXC thủ công chỉ vì cùng hướng với replay.
   */
  private async reconcileStartup(): Promise<void> {
    if (!this.canManageLive()) return;
    for (const st of this.states.values()) {
      let p;
      try {
        p = await this.o.execution!.reconcile(st.symbol);
      } catch (e) {
        console.warn(`[Fast] ${formatSymbol(st.symbol)} không đọc được vị thế: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      const exHas = Math.abs(p.positionAmt) > 0;
      const exDir: "long" | "short" = p.positionAmt > 0 ? "long" : "short";
      const pos = st.pos;

      if (pos && st.pending?.kind === "entry" && !pos.real) {
        try {
          const recovered = await this.o.execution!.recoverOrder(st.symbol, st.pending.key);
          if (!recovered || !exHas || exDir !== pos.dir) {
            st.quarantined = "pending entry không khớp order/position MEXC";
            continue;
          }
          pos.real = true;
          pos.positionId = recovered.positionId ?? p.positionId;
          pos.venueScale = recovered.avgPrice / pos.units[0].entry;
          pos.units[0].qty = recovered.filledQty;
          pos.units[0].realEntry = recovered.avgPrice;
          pos.units[0].riskFrac = pos.units[0].riskFrac ?? this.o.riskPct;
          await this.ensureStop(st.symbol, pos);
          st.pending = undefined;
          st.quarantined = undefined;
          await this.tg(`⚡🔁 *Fast recover entry MEXC* ${formatSymbol(st.symbol)} ${exDir.toUpperCase()} qty ${recovered.filledQty} — ownership xác nhận bằng externalOid.`);
        } catch (e) {
          st.quarantined = `recover entry lỗi: ${e instanceof Error ? e.message : e}`;
        }
      } else if (pos?.real && st.pending?.kind === "add") {
        try {
          const recovered = await this.o.execution!.recoverOrder(st.symbol, st.pending.key);
          if (recovered && st.pending.unit && !pos.units.some((u) => u.entryTime === st.pending!.unit!.entryTime)) {
            st.pending.unit.qty = recovered.filledQty;
            st.pending.unit.realEntry = recovered.avgPrice;
            st.pending.unit.riskFrac = st.pending.unit.riskFrac ?? this.o.riskPct;
            pos.units.push(st.pending.unit);
            pos.positionId = recovered.positionId ?? pos.positionId;
          }
          if (recovered) {
            st.pending = { kind: "stop", key: `${st.pending.key}:stop`, startedAt: Date.now() };
            await this.ensureStop(st.symbol, pos);
            st.pending = undefined;
            st.quarantined = undefined;
          } else {
            st.quarantined = "không xác minh được pending ADD MEXC";
          }
        } catch (e) {
          st.quarantined = `recover ADD lỗi: ${e instanceof Error ? e.message : e}`;
        }
      } else if (pos?.real && !exHas) {
        console.log(`[Fast] ${formatSymbol(st.symbol)} state giữ nhưng sàn flat — chốt sổ.`);
        await this.exitPosition(st, pos, pos.sl, "reconcile", Date.now(), false, { flatten: false });
      } else if (pos?.real && exHas) {
        if (exDir !== pos.dir || (pos.positionId && p.positionId !== pos.positionId)) {
          st.quarantined = "position MEXC không khớp direction/positionId đã lưu";
        } else {
          try {
            await this.ensureStop(st.symbol, pos);
            if (st.pending?.kind === "stop") st.pending = undefined;
          } catch (e) {
            st.quarantined = `protection MEXC lỗi: ${e instanceof Error ? e.message : e}`;
          }
        }
      } else if (exHas) {
        const reason = "vị thế MEXC lạ — không có durable ownership";
        if (st.quarantined !== reason) {
          st.quarantined = reason;
          await this.tg(`⚡❓ *Vị thế lạ trên MEXC* ${formatSymbol(st.symbol)} ${exDir.toUpperCase()} qty ${Math.abs(p.positionAmt)} — Fast KHÔNG tự nhận/đóng. Kiểm tra thủ công.`);
        }
      } else if (st.quarantined && !pos?.real) {
        // State và sàn CÙNG flat: cờ quarantine cũ không còn đối tượng nào để kiểm tra. Phải xoá ở
        // đây, vì mọi đường tự khỏi khác đều đi qua một entry/exit thành công — mà entry lại bị
        // chính cờ này chặn (:316). Không xoá = symbol bị loại khỏi rổ vĩnh viễn, trong im lặng.
        console.log(`[Fast] ${formatSymbol(st.symbol)} state+sàn đều flat — gỡ quarantine cũ: ${st.quarantined}`);
        await this.tg(`⚡✅ *Gỡ quarantine* ${formatSymbol(st.symbol)} — state và MEXC đều flat, không còn gì để đối chiếu.\nLý do cũ: ${escapeMarkdown(st.quarantined)}`);
        st.quarantined = undefined;
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

    console.log(`[Fast] ⚡ Khởi động — ${this.o.symbols.length} symbol @ ${TF} | LONG high-${this.o.entryDays}d | SHORT close-${FAST_SHORT_ENTRY_DAYS}d + ${FAST_SHORT_CONFIRM_BARS} nến xác nhận | EMA${T.trendLen} | BTC gate ${T.btcGateFast / BARS_PER_DAY}/${T.btcGateSlow / BARS_PER_DAY}d | ${this.o.execution ? `${this.o.execution.venueLabel} risk ${(this.o.riskPct * 100).toFixed(2)}%/unit` : "ALERT-ONLY"}`);
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
