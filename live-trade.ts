/**
 * live-trade.ts — Lớp THỰC THI: dịch sự kiện chiến lược → lệnh thật trên Binance Futures.
 *
 * Nguyên tắc AN TOÀN TIỀN:
 *   - Sizing theo RỦI RO: risk mỗi lệnh = equity × RISK_PCT × sizeMult. Khối lượng = riskUSD/|entry−SL|.
 *     Trần tổng risk các vị thế mở (MAX_PORTFOLIO_RISK_PCT) chặn lệnh mới nếu vượt.
 *   - KHÔNG BAO GIỜ để vị thế TRẦN (không SL): sau khi MARKET khớp, nếu đặt SL thất bại → ĐÓNG KHẨN CẤP.
 *   - SL/TP đặt TRÊN SÀN (STOP_MARKET/TAKE_PROFIT_MARKET closePosition) → còn hiệu lực kể cả khi bot tắt.
 *   - Trailing: đặt SL MỚI TRƯỚC rồi mới huỷ SL cũ (không có cửa sổ trần), TP giữ nguyên.
 *   - preflight(): kiểm tra kết nối/khoá/chế độ vị thế trước khi cho phép giao dịch.
 */
import { BinanceFutures, OrderSide, PositionRisk } from "./binance-futures";
import { CONFIG } from "./strategy";

export interface ExecConfig {
  riskPct: number; // 0.05 = 5% equity / lệnh (trước sizeMult)
  maxPortfolioRiskPct: number; // 0.20 = trần tổng risk các vị thế mở
  leverage: number;
  marginType: "ISOLATED" | "CROSSED";
}

export interface PosInfo {
  dir: "long" | "short";
  initialSL: number;
  sl: number; // SL hiện tại (có thể đã trail)
  target: number;
  sizeMult?: number;
}

export interface OpenResult {
  placed: boolean;
  reason?: string;
  qty?: number;
  avgPrice?: number;
  riskUsd?: number;
  equity?: number;
  tpPlaced?: boolean; // false nếu TP chưa đặt được (SL vẫn bảo vệ)
}

export interface Preflight {
  ok: boolean;
  equity: number;
  hedgeMode: boolean;
  warnings: string[];
  errors: string[];
}

const sideToClose = (dir: "long" | "short"): OrderSide => (dir === "long" ? "SELL" : "BUY");
const sideToOpen = (dir: "long" | "short"): OrderSide => (dir === "long" ? "BUY" : "SELL");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errCode = (e: unknown): number | undefined => (e as any)?.response?.data?.code;
const errMsg = (e: unknown): string =>
  (e as any)?.response?.data?.msg ?? (e instanceof Error ? e.message : String(e));

export class LiveTrader {
  constructor(private readonly api: BinanceFutures, private readonly cfg: ExecConfig) {}

  /**
   * Kiểm tra trước khi giao dịch: giờ server, bộ lọc symbol, khoá API (đọc số dư), chế độ vị thế,
   * margin + đòn bẩy từng symbol, cảnh báo thanh lý vs SL tối đa. ok=false → bot chạy alert-only.
   */
  async preflight(symbols: string[]): Promise<Preflight> {
    const warnings: string[] = [];
    const errors: string[] = [];

    await this.api.syncTime(); // ném nếu không tới được server
    await this.api.loadFilters(symbols);
    const bal = await this.api.getEquity(); // xác thực khoá + quyền đọc

    let hedgeMode = false;
    try {
      hedgeMode = await this.api.getPositionMode();
    } catch (e) {
      warnings.push(`không đọc được chế độ vị thế (${errMsg(e)})`);
    }
    if (hedgeMode) errors.push("Tài khoản đang HEDGE mode — bot cần One-way. Đổi trên Binance rồi chạy lại.");

    for (const s of symbols) {
      try {
        await this.api.setMarginType(s, this.cfg.marginType);
      } catch (e) {
        warnings.push(`${s}: set margin lỗi (${errMsg(e)})`);
      }
      try {
        await this.api.setLeverage(s, this.cfg.leverage);
      } catch (e) {
        warnings.push(`${s}: set đòn bẩy lỗi (${errMsg(e)})`);
      }
    }

    // Vùng thanh lý xấp xỉ 1/đòn bẩy. Nếu gần SL tối đa → có thể bị thanh lý TRƯỚC khi SL chạm.
    const liqDist = 1 / this.cfg.leverage;
    if (liqDist <= CONFIG.maxStopPct + 0.02) {
      warnings.push(
        `Đòn bẩy ${this.cfg.leverage}x → vùng thanh lý ~${(liqDist * 100).toFixed(1)}% gần SL tối đa ${(CONFIG.maxStopPct * 100).toFixed(1)}%; cân nhắc giảm đòn bẩy để SL luôn chạm trước thanh lý.`
      );
    }
    if (bal.walletBalance <= 0) errors.push("Số dư = 0 (testnet: dùng nút Faucet để nạp USDT).");

    return { ok: errors.length === 0, equity: bal.walletBalance, hedgeMode, warnings, errors };
  }

  riskFracOf(pos: PosInfo): number {
    return this.cfg.riskPct * (pos.sizeMult ?? 1);
  }

  /** Thử lại cho lỗi tạm thời. -2021 (would-immediately-trigger) không retry (vô ích). */
  private async retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 700): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        if (errCode(e) === -2021) throw e;
        if (i < attempts - 1) await sleep(delayMs);
      }
    }
    throw last;
  }

  /** Đóng KHẨN CẤP toàn bộ vị thế symbol (dùng khi không đặt được SL). Ưu tiên đóng theo vị thế thật. */
  private async emergencyClose(symbol: string, dir: "long" | "short", fallbackQty: number): Promise<void> {
    try {
      await this.api.cancelAllOpenOrders(symbol);
    } catch {
      /* vẫn cố đóng */
    }
    try {
      await this.api.cancelAllAlgoOpenOrders(symbol);
    } catch {
      /* vẫn cố đóng */
    }
    try {
      const p = await this.api.getPosition(symbol);
      const amt = Math.abs(p.positionAmt);
      if (amt > 0) {
        await this.api.marketClose(symbol, sideToClose(dir), this.api.roundQty(symbol, amt));
        return;
      }
      return; // sàn đã flat
    } catch {
      // không đọc được vị thế → đóng theo qty đã vào
      await this.api.marketClose(symbol, sideToClose(dir), fallbackQty);
    }
  }

  /**
   * Mở vị thế thật: kiểm tra trần risk → tính khối lượng → MARKET vào lệnh → ĐẶT SL (bắt buộc) → TP.
   * Nếu SL không đặt được sau khi đã khớp MARKET: ĐÓNG KHẨN CẤP, trả placed=false (không để vị thế trần).
   */
  async open(symbol: string, entry: number, pos: PosInfo, openRiskFrac: number): Promise<OpenResult> {
    const riskFrac = this.riskFracOf(pos);
    if (openRiskFrac + riskFrac > this.cfg.maxPortfolioRiskPct + 1e-9) {
      return { placed: false, reason: `trần danh mục (${((openRiskFrac + riskFrac) * 100).toFixed(0)}% > ${(this.cfg.maxPortfolioRiskPct * 100).toFixed(0)}%)` };
    }

    const equity = (await this.api.getEquity()).walletBalance;
    const riskUsd = equity * riskFrac;
    // Tính slDist theo GIÁ SL ĐÃ LÀM TRÒN (đúng giá sẽ đặt lên sàn) → risk khớp cấu hình.
    const slPrice = this.api.roundPrice(symbol, pos.initialSL);
    const slDist = Math.abs(entry - slPrice);
    if (slDist <= 0) return { placed: false, reason: "khoảng cách SL = 0" };

    const qty = this.api.roundQty(symbol, riskUsd / slDist);
    const f = this.api.getFilters(symbol);
    if (qty < f.minQty || qty <= 0) return { placed: false, reason: `qty ${qty} < minQty ${f.minQty}` };
    if (qty * entry < f.minNotional) {
      return { placed: false, reason: `notional ${(qty * entry).toFixed(2)} < min ${f.minNotional}` };
    }

    const closeSide = sideToClose(pos.dir);

    // 1) Vào lệnh MARKET
    const fill = await this.api.marketOrder(symbol, sideToOpen(pos.dir), qty);
    if (!(fill.executedQty > 0)) {
      return { placed: false, reason: `MARKET không khớp (status ${fill.status})` };
    }
    const avgPrice = fill.avgPrice || entry;

    // 2) SL BẮT BUỘC — thử lại; nếu vẫn fail → ĐÓNG KHẨN CẤP (tuyệt đối không để vị thế trần)
    try {
      await this.retry(() => this.api.stopMarketClose(symbol, closeSide, pos.initialSL));
    } catch (e) {
      await this.emergencyClose(symbol, pos.dir, fill.executedQty);
      return { placed: false, reason: `đặt SL thất bại → ĐÃ ĐÓNG KHẨN CẤP (${errMsg(e)})` };
    }

    // 3) TP (không bắt buộc — SL đã bảo vệ; bot/đối soát vẫn chốt target nếu thiếu TP)
    let tpPlaced = true;
    try {
      await this.retry(() => this.api.takeProfitMarketClose(symbol, closeSide, pos.target));
    } catch {
      tpPlaced = false;
    }

    return { placed: true, qty: fill.executedQty, avgPrice, riskUsd, equity, tpPlaced };
  }

  /**
   * Dời SL (trail/breakeven) AN TOÀN: đặt SL MỚI trước → huỷ các SL cũ → đảm bảo còn đúng 1 TP.
   * Không phụ thuộc orderId lưu RAM (đọc openOrders) → đúng cả sau restart.
   */
  async syncStops(symbol: string, pos: PosInfo): Promise<void> {
    const closeSide = sideToClose(pos.dir);
    const newSlId = await this.api.stopMarketClose(symbol, closeSide, pos.sl); // đặt trước, không có cửa sổ trần
    const orders = await this.api.getOpenAlgoOrders(symbol);
    let hasTp = false;
    for (const o of orders) {
      if (o.orderType === "STOP_MARKET" && o.algoId !== newSlId) {
        await this.api.cancelAlgoOrder(o.algoId); // dọn SL cũ
      } else if (o.orderType === "TAKE_PROFIT_MARKET") {
        hasTp = true;
      }
    }
    if (!hasTp) {
      try {
        await this.api.takeProfitMarketClose(symbol, closeSide, pos.target);
      } catch {
        /* SL đã bảo vệ; bỏ qua */
      }
    }
  }

  /** Đảm bảo vị thế (đã có sẵn trên sàn) được bảo vệ: có SL & TP đúng giá. Trả SL hiện có (nếu đọc được). */
  async ensureProtection(symbol: string, pos: PosInfo): Promise<{ slPrice: number | null; tpPrice: number | null }> {
    const orders = await this.api.getOpenAlgoOrders(symbol);
    const sl = orders.find((o) => o.orderType === "STOP_MARKET");
    const tp = orders.find((o) => o.orderType === "TAKE_PROFIT_MARKET");
    const closeSide = sideToClose(pos.dir);
    if (!sl) await this.api.stopMarketClose(symbol, closeSide, pos.sl);
    if (!tp) {
      try {
        await this.api.takeProfitMarketClose(symbol, closeSide, pos.target);
      } catch {
        /* bỏ qua */
      }
    }
    return {
      slPrice: sl ? parseFloat(sl.triggerPrice) : pos.sl,
      tpPrice: tp ? parseFloat(tp.triggerPrice) : null,
    };
  }

  /** Đọc SL/TP đang đặt trên sàn (để ADOPT vị thế orphan sau restart). */
  async readProtection(symbol: string): Promise<{ slPrice: number | null; tpPrice: number | null }> {
    const orders = await this.api.getOpenAlgoOrders(symbol);
    const sl = orders.find((o) => o.orderType === "STOP_MARKET");
    const tp = orders.find((o) => o.orderType === "TAKE_PROFIT_MARKET");
    return {
      slPrice: sl ? parseFloat(sl.triggerPrice) : null,
      tpPrice: tp ? parseFloat(tp.triggerPrice) : null,
    };
  }

  /** Đặt SL khẩn cấp cho vị thế orphan không có SL (tại maxStopPct tính từ entry). Trả giá SL. */
  async placeEmergencyStop(symbol: string, dir: "long" | "short", entryPrice: number): Promise<number> {
    const sl = dir === "long" ? entryPrice * (1 - CONFIG.maxStopPct) : entryPrice * (1 + CONFIG.maxStopPct);
    await this.api.stopMarketClose(symbol, sideToClose(dir), sl);
    return this.api.roundPrice(symbol, sl);
  }

  /** Bot quyết định thoát (time/logic): huỷ SL/TP, đóng phần còn lại bằng MARKET nếu vẫn mở. */
  async flatten(symbol: string, dir: "long" | "short"): Promise<void> {
    await this.api.cancelAllOpenOrders(symbol);
    await this.api.cancelAllAlgoOpenOrders(symbol);
    const p = await this.api.getPosition(symbol);
    const amt = Math.abs(p.positionAmt);
    if (amt > 0) {
      await this.api.marketClose(symbol, sideToClose(dir), this.api.roundQty(symbol, amt));
    }
  }

  /** Lưới an toàn: trạng thái vị thế thật trên sàn. positionAmt = 0 → đã đóng (SL/TP khớp). */
  async reconcile(symbol: string): Promise<PositionRisk> {
    return this.api.getPosition(symbol);
  }

  syncTime(): Promise<void> {
    return this.api.syncTime();
  }
}

export function loadExecConfig(): ExecConfig {
  const num = (v: string | undefined, d: number) => {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? n : d;
  };
  return {
    riskPct: num(process.env.RISK_PCT, 5) / 100,
    maxPortfolioRiskPct: num(process.env.MAX_PORTFOLIO_RISK_PCT, 20) / 100,
    leverage: num(process.env.LEVERAGE, 10),
    marginType: (process.env.MARGIN_TYPE ?? "ISOLATED").toUpperCase() === "CROSSED" ? "CROSSED" : "ISOLATED",
  };
}
