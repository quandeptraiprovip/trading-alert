/**
 * binance-futures.ts — Client REST ký HMAC cho Binance USDⓈ-M Futures (fapi).
 *
 * Chỉ gói những endpoint bot CẦN để giao dịch theo chiến lược baseline:
 *   - đồng bộ giờ server (tránh -1021 timestamp), exchangeInfo (bộ lọc lot/tick/minNotional)
 *   - số dư/tài khoản, vị thế hiện tại
 *   - đặt đòn bẩy / margin isolated
 *   - lệnh MARKET vào lệnh + STOP_MARKET/TAKE_PROFIT_MARKET (closePosition) làm SL/TP TRÊN SÀN
 *   - huỷ lệnh chờ
 *
 * Ký: HMAC-SHA256(secret, <query+body string có timestamp&recvWindow>), header X-MBX-APIKEY.
 * Doc: https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info
 */
import crypto from "crypto";
import https from "https";
import axios, { AxiosInstance } from "axios";

export type OrderSide = "BUY" | "SELL";

export interface SymbolFilters {
  symbol: string;
  stepSize: number; // LOT_SIZE: bội số khối lượng
  qtyPrecision: number; // số chữ số thập phân khối lượng
  tickSize: number; // PRICE_FILTER: bội số giá
  pricePrecision: number;
  minQty: number;
  minNotional: number; // MIN_NOTIONAL: giá * qty tối thiểu
}

export interface PositionRisk {
  symbol: string;
  positionAmt: number; // >0 long, <0 short, 0 flat
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  liquidationPrice: number;
  leverage: number;
}

export interface NewOrderResult {
  orderId: number;
  clientOrderId: string;
  status: string;
  avgPrice: number; // giá khớp TB (0 nếu chưa khớp)
  executedQty: number;
}

/** Một lần khớp thật (fill) từ `/fapi/v1/userTrades` — nguồn DUY NHẤT biết giá khớp của STOP đã bắn. */
export interface UserTrade {
  time: number;
  price: number;
  qty: number;
  realizedPnl: number; // ≠0 ⇒ fill này ĐÓNG (giảm) vị thế
  commission: number;
  side: OrderSide;
}

const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000 });

export class BinanceFutures {
  private readonly http: AxiosInstance;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private timeOffset = 0; // serverTime - Date.now()
  private filters = new Map<string, SymbolFilters>();

  constructor(opts: { apiKey: string; apiSecret: string; baseUrl: string }) {
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.http = axios.create({
      baseURL: opts.baseUrl.replace(/\/$/, ""),
      httpsAgent,
      timeout: 15_000,
      headers: { "X-MBX-APIKEY": this.apiKey },
    });
  }

  // ── Helpers ký + request ──────────────────────────────────────────────────
  private sign(query: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(query).digest("hex");
  }

  /** Endpoint công khai (không ký). */
  private async pub<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await this.http.get(path, { params });
    return res.data as T;
  }

  /** Endpoint ký (TRADE/USER_DATA). Tự thêm timestamp + recvWindow + signature. */
  private async signed<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) clean[k] = String(v);
    }
    clean.recvWindow = clean.recvWindow ?? "10000"; // rộng hơn cho VM mạng chập (giảm -1021)
    for (let attempt = 0; attempt < 2; attempt++) {
      const params = { ...clean, timestamp: String(Date.now() + this.timeOffset) };
      const query = new URLSearchParams(params).toString();
      const url = `${path}?${query}&signature=${this.sign(query)}`;
      try {
        const res = await this.http.request<T>({ method, url });
        return res.data;
      } catch (err: any) {
        // -1021 = timestamp ngoài recvWindow (đồng hồ VM lệch) → đồng bộ lại giờ & thử 1 lần
        if (attempt === 0 && err?.response?.data?.code === -1021) {
          await this.syncTime();
          continue;
        }
        const code = err?.response?.data?.code;
        const message = err?.response?.data?.msg;
        if (err instanceof Error && message) {
          err.message = `Binance ${code ?? (err as any)?.response?.status ?? "API"}: ${message}`;
        }
        throw err;
      }
    }
    throw new Error("unreachable");
  }

  // ── Khởi tạo ───────────────────────────────────────────────────────────────
  /** Đồng bộ lệch giờ với server để tránh lỗi -1021. */
  async syncTime(): Promise<void> {
    const data = await this.pub<{ serverTime: number }>("/fapi/v1/time");
    this.timeOffset = data.serverTime - Date.now();
  }

  /** Tải & cache bộ lọc cho các symbol cần dùng. */
  async loadFilters(symbols: string[]): Promise<void> {
    const info = await this.pub<{ symbols: any[] }>("/fapi/v1/exchangeInfo");
    const want = new Set(symbols.map((s) => s.toUpperCase()));
    for (const s of info.symbols) {
      if (!want.has(s.symbol)) continue;
      const lot = s.filters.find((f: any) => f.filterType === "LOT_SIZE");
      const price = s.filters.find((f: any) => f.filterType === "PRICE_FILTER");
      const notional = s.filters.find(
        (f: any) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL"
      );
      this.filters.set(s.symbol, {
        symbol: s.symbol,
        stepSize: parseFloat(lot?.stepSize ?? "0.001"),
        qtyPrecision: s.quantityPrecision ?? 3,
        tickSize: parseFloat(price?.tickSize ?? "0.01"),
        pricePrecision: s.pricePrecision ?? 2,
        minQty: parseFloat(lot?.minQty ?? "0"),
        minNotional: parseFloat(notional?.notional ?? notional?.minNotional ?? "5"),
      });
    }
  }

  getFilters(symbol: string): SymbolFilters {
    const f = this.filters.get(symbol.toUpperCase());
    if (!f) throw new Error(`Chưa load filter cho ${symbol} (gọi loadFilters trước)`);
    return f;
  }

  /** Làm tròn khối lượng XUỐNG theo stepSize (không vượt risk). */
  roundQty(symbol: string, qty: number): number {
    const { stepSize, qtyPrecision } = this.getFilters(symbol);
    const floored = Math.floor(qty / stepSize) * stepSize;
    return parseFloat(floored.toFixed(qtyPrecision));
  }

  /** Làm tròn giá theo tickSize. */
  roundPrice(symbol: string, price: number): number {
    const { tickSize, pricePrecision } = this.getFilters(symbol);
    const rounded = Math.round(price / tickSize) * tickSize;
    return parseFloat(rounded.toFixed(pricePrecision));
  }

  // ── Tài khoản / vị thế ───────────────────────────────────────────────────
  /** Equity (USDT) dùng để sizing — totalWalletBalance (không gồm unrealized cho ổn định). */
  async getEquity(): Promise<{
    walletBalance: number;
    marginBalance: number;
    available: number;
    unrealized: number;
    initialMargin: number;
    maintMargin: number;
    usdtWallet: number; // số dư ví riêng tài sản USDT
    usdtAvailable: number; // USDT khả dụng (chưa ký quỹ)
  }> {
    const a = await this.signed<any>("GET", "/fapi/v2/account");
    const usdt = (a.assets ?? []).find((x: any) => x.asset === "USDT");
    return {
      walletBalance: parseFloat(a.totalWalletBalance),
      marginBalance: parseFloat(a.totalMarginBalance),
      available: parseFloat(a.availableBalance),
      unrealized: parseFloat(a.totalUnrealizedProfit ?? "0"),
      initialMargin: parseFloat(a.totalPositionInitialMargin ?? "0"),
      maintMargin: parseFloat(a.totalMaintMargin ?? "0"),
      usdtWallet: usdt ? parseFloat(usdt.walletBalance) : parseFloat(a.totalWalletBalance),
      usdtAvailable: usdt ? parseFloat(usdt.availableBalance) : parseFloat(a.availableBalance),
    };
  }

  /** true = Hedge mode (dualSidePosition). Bot CẦN One-way (false) để dùng positionSide BOTH. */
  async getPositionMode(): Promise<boolean> {
    const r = await this.signed<{ dualSidePosition: boolean }>("GET", "/fapi/v1/positionSide/dual");
    return !!r.dualSidePosition;
  }

  async getPosition(symbol: string): Promise<PositionRisk> {
    const arr = await this.signed<any[]>("GET", "/fapi/v2/positionRisk", { symbol: symbol.toUpperCase() });
    const p = arr.find((x) => x.symbol === symbol.toUpperCase()) ?? arr[0];
    return {
      symbol: p.symbol,
      positionAmt: parseFloat(p.positionAmt),
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice ?? "0"),
      unrealizedProfit: parseFloat(p.unRealizedProfit ?? p.unrealizedProfit ?? "0"),
      liquidationPrice: parseFloat(p.liquidationPrice ?? "0"),
      leverage: parseFloat(p.leverage ?? "0"),
    };
  }

  // ── Cấu hình symbol ────────────────────────────────────────────────────────
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.signed("POST", "/fapi/v1/leverage", { symbol: symbol.toUpperCase(), leverage });
  }

  /** Đặt margin ISOLATED/CROSSED. Bỏ qua lỗi "no need to change" (-4046). */
  async setMarginType(symbol: string, type: "ISOLATED" | "CROSSED"): Promise<void> {
    try {
      await this.signed("POST", "/fapi/v1/marginType", { symbol: symbol.toUpperCase(), marginType: type });
    } catch (err: any) {
      if (err?.response?.data?.code === -4046) return; // đã đúng loại margin
      throw err;
    }
  }

  // ── Lệnh ─────────────────────────────────────────────────────────────────
  async marketOrder(symbol: string, side: OrderSide, qty: number, clientId?: string): Promise<NewOrderResult> {
    const r = await this.signed<any>("POST", "/fapi/v1/order", {
      symbol: symbol.toUpperCase(),
      side,
      type: "MARKET",
      quantity: qty,
      newClientOrderId: clientId,
      newOrderRespType: "RESULT",
    });
    return {
      orderId: r.orderId,
      clientOrderId: r.clientOrderId,
      status: r.status,
      avgPrice: parseFloat(r.avgPrice ?? "0"),
      executedQty: parseFloat(r.executedQty ?? "0"),
    };
  }

  /** Đóng vị thế bằng MARKET reduceOnly (dùng cho thoát theo thời gian / logic nến). */
  async marketClose(symbol: string, side: OrderSide, qty: number, clientId?: string): Promise<NewOrderResult> {
    const r = await this.signed<any>("POST", "/fapi/v1/order", {
      symbol: symbol.toUpperCase(),
      side,
      type: "MARKET",
      quantity: qty,
      reduceOnly: "true",
      newClientOrderId: clientId,
      newOrderRespType: "RESULT",
    });
    return {
      orderId: r.orderId,
      clientOrderId: r.clientOrderId,
      status: r.status,
      avgPrice: parseFloat(r.avgPrice ?? "0"),
      executedQty: parseFloat(r.executedQty ?? "0"),
    };
  }

  /**
   * Các lần khớp thật của symbol từ `startTime` — CHỈ ĐỌC (USER_DATA).
   *
   * Đây là cách DUY NHẤT biết giá khớp của một STOP_MARKET đã tự bắn trên sàn: bot không đặt lệnh nào
   * trong tình huống đó nên không có `avgPrice` nào để bắt, và `stopMarketClose` chỉ trả về algoId mà
   * mã hiện tại không lưu. `realizedPnl ≠ 0` đánh dấu fill ĐÓNG vị thế.
   */
  async getUserTrades(symbol: string, startTime: number, limit = 200): Promise<UserTrade[]> {
    const r = await this.signed<any[]>("GET", "/fapi/v1/userTrades", {
      symbol: symbol.toUpperCase(),
      startTime: Math.floor(startTime),
      limit,
    });
    return (r ?? []).map((t) => ({
      time: Number(t.time),
      price: parseFloat(t.price ?? "0"),
      qty: parseFloat(t.qty ?? "0"),
      realizedPnl: parseFloat(t.realizedPnl ?? "0"),
      commission: parseFloat(t.commission ?? "0"),
      side: t.side as OrderSide,
    }));
  }

  /** SL trên sàn: STOP_MARKET algo + closePosition=true (đóng toàn bộ khi chạm). */
  async stopMarketClose(symbol: string, side: OrderSide, stopPrice: number, clientId?: string): Promise<number> {
    const r = await this.signed<any>("POST", "/fapi/v1/algoOrder", {
      algoType: "CONDITIONAL",
      symbol: symbol.toUpperCase(),
      side,
      type: "STOP_MARKET",
      triggerPrice: this.roundPrice(symbol, stopPrice),
      closePosition: "true",
      workingType: "CONTRACT_PRICE",
      clientAlgoId: clientId,
    });
    return r.algoId;
  }

  /** TP trên sàn: TAKE_PROFIT_MARKET algo + closePosition=true. */
  async takeProfitMarketClose(symbol: string, side: OrderSide, stopPrice: number, clientId?: string): Promise<number> {
    const r = await this.signed<any>("POST", "/fapi/v1/algoOrder", {
      algoType: "CONDITIONAL",
      symbol: symbol.toUpperCase(),
      side,
      type: "TAKE_PROFIT_MARKET",
      triggerPrice: this.roundPrice(symbol, stopPrice),
      closePosition: "true",
      workingType: "CONTRACT_PRICE",
      clientAlgoId: clientId,
    });
    return r.algoId;
  }

  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    try {
      await this.signed("DELETE", "/fapi/v1/order", { symbol: symbol.toUpperCase(), orderId });
    } catch (err: any) {
      // -2011 = lệnh không tồn tại (đã khớp/huỷ) → coi như đã xong
      if (err?.response?.data?.code === -2011) return;
      throw err;
    }
  }

  async cancelAlgoOrder(algoId: number): Promise<void> {
    try {
      await this.signed("DELETE", "/fapi/v1/algoOrder", { algoId });
    } catch (err: any) {
      if (err?.response?.data?.code === -2011) return;
      throw err;
    }
  }

  async cancelAllOpenOrders(symbol: string): Promise<void> {
    await this.signed("DELETE", "/fapi/v1/allOpenOrders", { symbol: symbol.toUpperCase() });
  }

  async cancelAllAlgoOpenOrders(symbol: string): Promise<void> {
    await this.signed("DELETE", "/fapi/v1/algoOpenOrders", { symbol: symbol.toUpperCase() });
  }

  async getOpenOrders(symbol: string): Promise<any[]> {
    return this.signed<any[]>("GET", "/fapi/v1/openOrders", { symbol: symbol.toUpperCase() });
  }

  async getOpenAlgoOrders(symbol: string): Promise<any[]> {
    return this.signed<any[]>("GET", "/fapi/v1/openAlgoOrders", { symbol: symbol.toUpperCase() });
  }
}

/** Khởi tạo client từ env. Trả null nếu thiếu key (bot chạy alert-only như cũ). */
export function createBinanceFromEnv(): BinanceFutures | null {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  const testnet = (process.env.BINANCE_TESTNET ?? "true").toLowerCase() !== "false";
  const baseUrl =
    process.env.BINANCE_BASE_URL ??
    (testnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com");
  return new BinanceFutures({ apiKey, apiSecret, baseUrl });
}
