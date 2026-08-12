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
import { ExitFillAudit, computeExitFillAudit } from "./exit-fill-audit";

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
  async open(
    symbol: string,
    entry: number,
    pos: PosInfo,
    openRiskFrac: number,
    opts?: {
      noTp?: boolean; // chiến lược trailing thuần (Turtle) — không đặt TP
      // Nâng qty lên SÀN minNotional/minQty của sàn thay vì bỏ lệnh (cho equity nhỏ vs BTC
      // min 100 USDT). Risk hiệu dụng có thể > riskPct danh nghĩa → caller giới hạn bằng
      // maxRiskFrac (ngân sách risk cho lệnh này); trần danh mục check theo risk HIỆU DỤNG.
      minQtyFloor?: boolean;
      maxRiskFrac?: number;
    }
  ): Promise<OpenResult> {
    const riskFrac = this.riskFracOf(pos);
    if (!opts?.minQtyFloor && openRiskFrac + riskFrac > this.cfg.maxPortfolioRiskPct + 1e-9) {
      return { placed: false, reason: `trần danh mục (${((openRiskFrac + riskFrac) * 100).toFixed(0)}% > ${(this.cfg.maxPortfolioRiskPct * 100).toFixed(0)}%)` };
    }

    const equity = (await this.api.getEquity()).walletBalance;
    let riskUsd = equity * riskFrac;
    // Tính slDist theo GIÁ SL ĐÃ LÀM TRÒN (đúng giá sẽ đặt lên sàn) → risk khớp cấu hình.
    const slPrice = this.api.roundPrice(symbol, pos.initialSL);
    const slDist = Math.abs(entry - slPrice);
    if (slDist <= 0) return { placed: false, reason: "khoảng cách SL = 0" };

    let qty = this.api.roundQty(symbol, riskUsd / slDist);
    const f = this.api.getFilters(symbol);
    if (opts?.minQtyFloor) {
      const needQty = Math.max(f.minQty, (f.minNotional * 1.01) / entry); // +1% đệm giá khớp lệch
      if (qty < needQty) {
        qty = parseFloat((Math.ceil(needQty / f.stepSize) * f.stepSize).toFixed(f.qtyPrecision));
        riskUsd = qty * slDist; // risk HIỆU DỤNG sau khi nâng sàn
      }
      const effFrac = riskUsd / equity;
      if (opts.maxRiskFrac != null && effFrac > opts.maxRiskFrac + 1e-9) {
        return { placed: false, reason: `risk sàn-min ${(effFrac * 100).toFixed(1)}% > ngân sách ${(opts.maxRiskFrac * 100).toFixed(1)}% (equity quá nhỏ cho ${symbol.toUpperCase()})` };
      }
      if (openRiskFrac + effFrac > this.cfg.maxPortfolioRiskPct + 1e-9) {
        return { placed: false, reason: `trần danh mục (${((openRiskFrac + effFrac) * 100).toFixed(0)}% > ${(this.cfg.maxPortfolioRiskPct * 100).toFixed(0)}%)` };
      }
    }
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
    if (!opts?.noTp) {
      try {
        await this.retry(() => this.api.takeProfitMarketClose(symbol, closeSide, pos.target));
      } catch {
        tpPlaced = false;
      }
    }

    return { placed: true, qty: fill.executedQty, avgPrice, riskUsd, equity, tpPlaced };
  }

  /**
   * Dời SL (trail/breakeven): Binance không cho tồn tại hai STOP_MARKET closePosition cùng phía,
   * nên phải hủy stop cũ rồi đặt stop mới. Nếu đặt mới lỗi, khôi phục stop cũ; nếu cả khôi phục
   * cũng lỗi thì đóng khẩn cấp để không để vị thế trần.
   */
  async syncStops(symbol: string, pos: PosInfo, opts?: { noTp?: boolean }): Promise<void> {
    const closeSide = sideToClose(pos.dir);
    const orders = await this.api.getOpenAlgoOrders(symbol);
    const stops = orders.filter((o) => o.orderType === "STOP_MARKET");
    if (stops.length > 1) {
      throw new Error(`${symbol}: có ${stops.length} STOP_MARKET; không tự thay khi ownership không rõ`);
    }

    const oldStop = stops[0];
    const desired = this.api.roundPrice(symbol, pos.sl);
    const oldPrice = oldStop ? parseFloat(oldStop.triggerPrice) : null;
    if (oldStop && oldPrice !== desired) {
      const venuePos = await this.api.getPosition(symbol);
      const fallbackQty = this.api.roundQty(symbol, Math.abs(venuePos.positionAmt));
      try {
        await this.api.cancelAlgoOrder(oldStop.algoId);
      } catch {
        // Cancel may have reached Binance before the connection failed; the create/read-back below
        // determines whether the old stop still exists.
      }
      try {
        await this.api.stopMarketClose(symbol, closeSide, desired);
      } catch (newStopError) {
        let activeAfter: any[] | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            activeAfter = (await this.api.getOpenAlgoOrders(symbol))
              .filter((o) => o.orderType === "STOP_MARKET");
            break;
          } catch {
            if (attempt < 2) await sleep(150);
          }
        }
        if (activeAfter?.length === 1 && parseFloat(activeAfter[0].triggerPrice) === desired) {
          // POST response was ambiguous but read-back proves the desired stop is active.
        } else if (activeAfter?.length) {
          throw new Error(`${symbol}: đặt SL mới lỗi (${errMsg(newStopError)}); SL cũ vẫn active $${oldPrice}`);
        } else {
          try {
            await this.api.stopMarketClose(symbol, closeSide, oldPrice!);
          } catch (restoreError) {
            try {
              await this.emergencyClose(symbol, pos.dir, fallbackQty);
            } catch (closeError) {
              throw new Error(
                `${symbol}: đặt SL mới lỗi (${errMsg(newStopError)}), khôi phục SL cũ lỗi ` +
                `(${errMsg(restoreError)}), đóng khẩn cấp lỗi (${errMsg(closeError)})`,
              );
            }
            throw new Error(
              `${symbol}: đặt SL mới lỗi (${errMsg(newStopError)}), khôi phục SL cũ lỗi ` +
              `(${errMsg(restoreError)}) → ĐÃ ĐÓNG KHẨN CẤP`,
            );
          }
          throw new Error(`${symbol}: đặt SL mới lỗi (${errMsg(newStopError)}); đã khôi phục SL cũ $${oldPrice}`);
        }
      }
    } else if (!oldStop) {
      await this.api.stopMarketClose(symbol, closeSide, desired);
    }

    const hasTp = orders.some((o) => o.orderType === "TAKE_PROFIT_MARKET");
    if (!hasTp && !opts?.noTp) {
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

  /**
   * CHỈ ĐỌC — đo trượt giá thật ở chiều thoát. Không gửi lệnh nào, không đổi state nào.
   * Lấy các fill có `realizedPnl ≠ 0` (fill ĐÓNG vị thế) kể từ `sinceMs`. Dùng được cho CẢ hai đường:
   * bot tự đóng bằng MARKET, và STOP_MARKET tự bắn trên sàn (trường hợp chiếm ~97% số lệnh thoát).
   * Trả `null` nếu không đọc được — người gọi phải coi phép đo là tuỳ chọn.
   */
  async realizedExit(
    symbol: string,
    dir: "long" | "short",
    assumedExit: number,
    sinceMs: number,
    atrNow?: number
  ): Promise<ExitFillAudit | null> {
    try {
      const trades = await this.api.getUserTrades(symbol, sinceMs);
      const closing = trades
        .filter((t) => t.realizedPnl !== 0)
        .map((t) => ({ price: t.price, qty: t.qty, realizedUsd: t.realizedPnl, commissionUsd: t.commission }));
      return computeExitFillAudit({ venue: "binance", dir, assumedExit, fills: closing, atrNow });
    } catch {
      return null; // phép đo không bao giờ được làm hỏng việc thoát lệnh
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
