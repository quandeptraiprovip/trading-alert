/** Current MEXC USDT-M Futures REST adapter (2026 API). */
import crypto from "crypto";
import https from "https";
import axios, { AxiosInstance } from "axios";

export interface MexcContractInfo {
  symbol: string;
  contractType: number;
  positionOpenType: number;
  baseCoin: string;
  quoteCoin: string;
  futureType: number;
  contractSize: number;
  minLeverage: number;
  maxLeverage: number;
  countryConfigContractMaxLeverage: number;
  priceScale: number;
  volScale: number;
  priceUnit: number;
  volUnit: number;
  minVol: number;
  maxVol: number;
  state: number;
  appraisal: number;
  apiAllowed: boolean;
  stopOnlyFair: boolean;
}

export interface MexcTicker {
  symbol: string;
  lastPrice: number;
  bid1: number;
  ask1: number;
  fairPrice: number;
  indexPrice: number;
  fundingRate: number;
  timestamp: number;
}

export interface MexcAsset {
  currency: string;
  positionMargin: number;
  frozenBalance: number;
  availableBalance: number;
  cashBalance: number;
  equity: number;
  unrealized: number;
  availableOpen: number;
}

export interface MexcPosition {
  positionId: string;
  symbol: string;
  holdVol: number;
  positionType: 1 | 2;
  openType: 1 | 2;
  state: number;
  frozenVol: number;
  holdAvgPrice: number;
  liquidatePrice: number;
  leverage: number;
  unRealizedPnl: number;
}

export interface MexcOrder {
  orderId: string;
  positionId?: string;
  symbol: string;
  vol: number;
  side: number;
  dealAvgPrice: number;
  dealVol: number;
  state: number;
  externalOid: string;
  takerFee: number;
  makerFee: number;
}

export interface MexcStopOrder {
  id: string;
  symbol: string;
  positionId: string;
  stopLossPrice: number;
  state: number;
  positionType: number;
  vol: number;
  realityVol: number;
  volType: number;
  isFinished: number;
  errorCode: number;
}

type Envelope<T> = { success: boolean; code: number; message?: string; msg?: string; data: T };

export class MexcApiError extends Error {
  constructor(public readonly code: number, message: string) {
    super(`MEXC ${code}: ${message || "request failed"}`);
    this.name = "MexcApiError";
  }
}

export function toMexcSymbol(symbol: string): string {
  const compact = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!compact.endsWith("USDT")) throw new Error(`MEXC chỉ hỗ trợ symbol USDT-M trong bot: ${symbol}`);
  return `${compact.slice(0, -4)}_USDT`;
}

export function mexcQueryString(params: Record<string, unknown>): string {
  const pairs = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return pairs.join("&");
}

export function signMexcRequest(
  apiKey: string,
  apiSecret: string,
  timestampMs: number,
  parameterString: string,
): string {
  return crypto
    .createHmac("sha256", apiSecret)
    .update(apiKey + String(timestampMs) + parameterString)
    .digest("hex");
}

const decimals = (n: number): number => {
  const s = String(n).toLowerCase();
  if (s.includes("e-")) return parseInt(s.split("e-")[1], 10);
  return (s.split(".")[1] ?? "").length;
};

function floorToStep(value: number, step: number, scale: number): number {
  const floored = Math.floor((value + 1e-12) / step) * step;
  return Number(floored.toFixed(Math.max(scale, decimals(step))));
}

export function calculateMexcContracts(
  contract: MexcContractInfo,
  riskUsd: number,
  entryPrice: number,
  stopPrice: number,
): { contracts: number; actualRiskUsd: number; baseQty: number } {
  const distance = Math.abs(entryPrice - stopPrice);
  if (!(riskUsd > 0 && distance > 0 && contract.contractSize > 0)) {
    return { contracts: 0, actualRiskUsd: 0, baseQty: 0 };
  }
  const baseQty = riskUsd / distance;
  const contracts = Math.min(
    contract.maxVol,
    floorToStep(baseQty / contract.contractSize, contract.volUnit, contract.volScale),
  );
  if (contracts < contract.minVol) return { contracts: 0, actualRiskUsd: 0, baseQty };
  return {
    contracts,
    actualRiskUsd: contracts * contract.contractSize * distance,
    baseQty,
  };
}

const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000 });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MexcFutures {
  private readonly http: AxiosInstance;
  private timeOffset = 0;
  private readonly contracts = new Map<string, MexcContractInfo>();

  constructor(
    private readonly opts: { apiKey: string; apiSecret: string; baseUrl: string; recvWindowMs?: number },
  ) {
    this.http = axios.create({
      baseURL: opts.baseUrl.replace(/\/$/, ""),
      httpsAgent,
      timeout: 15_000,
    });
  }

  private unwrap<T>(payload: Envelope<T>): T {
    if (!payload || payload.success !== true || payload.code !== 0) {
      throw new MexcApiError(payload?.code ?? -1, payload?.message ?? payload?.msg ?? "invalid response");
    }
    return payload.data;
  }

  private async pub<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await this.http.get<Envelope<T>>(path, { params });
    return this.unwrap(response.data);
  }

  private async signed<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const timestamp = Date.now() + this.timeOffset;
      const parameterString = method === "POST" ? JSON.stringify(params) : mexcQueryString(params);
      const signature = signMexcRequest(this.opts.apiKey, this.opts.apiSecret, timestamp, parameterString);
      const headers = {
        ApiKey: this.opts.apiKey,
        "Request-Time": String(timestamp),
        Signature: signature,
        "Recv-Window": String(Math.min(30_000, Math.max(1_000, this.opts.recvWindowMs ?? 10_000))),
        "Content-Type": "application/json",
      };
      try {
        const url = method === "POST" || !parameterString ? path : `${path}?${parameterString}`;
        const response = await this.http.request<Envelope<T>>({
          method,
          url,
          headers,
          data: method === "POST" ? parameterString : undefined,
        });
        return this.unwrap(response.data);
      } catch (error) {
        const code = error instanceof MexcApiError ? error.code : (error as any)?.response?.data?.code;
        if (attempt === 0 && code === 602) {
          await this.syncTime();
          continue;
        }
        throw error;
      }
    }
    throw new Error("unreachable");
  }

  async syncTime(): Promise<void> {
    const data = await this.pub<number | { serverTime?: number; timestamp?: number }>("/api/v1/contract/ping");
    const serverTime = typeof data === "number" ? data : Number(data.serverTime ?? data.timestamp);
    if (!Number.isFinite(serverTime)) throw new Error("MEXC ping không trả server time hợp lệ");
    this.timeOffset = serverTime - Date.now();
  }

  async loadContracts(symbols: string[]): Promise<void> {
    for (const symbol of symbols) {
      const venueSymbol = toMexcSymbol(symbol);
      const raw = await this.pub<any>("/api/v1/contract/detail/country", { symbol: venueSymbol });
      const item = Array.isArray(raw) ? raw.find((x) => x.symbol === venueSymbol) : raw;
      if (!item) throw new Error(`MEXC không trả metadata cho ${venueSymbol}`);
      this.contracts.set(venueSymbol, {
        symbol: venueSymbol,
        contractType: Number(item.type),
        positionOpenType: Number(item.positionOpenType),
        baseCoin: String(item.baseCoin),
        quoteCoin: String(item.quoteCoin),
        futureType: Number(item.futureType),
        contractSize: Number(item.contractSize),
        minLeverage: Number(item.minLeverage),
        maxLeverage: Number(item.maxLeverage),
        countryConfigContractMaxLeverage: Number(item.countryConfigContractMaxLeverage ?? 0),
        priceScale: Number(item.priceScale),
        volScale: Number(item.volScale),
        priceUnit: Number(item.priceUnit),
        volUnit: Number(item.volUnit),
        minVol: Number(item.minVol),
        maxVol: Number(item.maxVol),
        state: Number(item.state),
        appraisal: Number(item.appraisal ?? 0),
        apiAllowed: item.apiAllowed === true,
        stopOnlyFair: item.stopOnlyFair === true,
      });
    }
  }

  getContract(symbol: string): MexcContractInfo {
    const venueSymbol = toMexcSymbol(symbol);
    const contract = this.contracts.get(venueSymbol);
    if (!contract) throw new Error(`Chưa load MEXC contract ${venueSymbol}`);
    return contract;
  }

  roundPrice(symbol: string, price: number): number {
    const c = this.getContract(symbol);
    return Number((Math.round(price / c.priceUnit) * c.priceUnit).toFixed(c.priceScale));
  }

  roundStop(symbol: string, price: number, dir: "long" | "short"): number {
    const c = this.getContract(symbol);
    const units = price / c.priceUnit;
    const rounded = (dir === "long" ? Math.ceil(units - 1e-12) : Math.floor(units + 1e-12)) * c.priceUnit;
    return Number(rounded.toFixed(c.priceScale));
  }

  async getTicker(symbol: string): Promise<MexcTicker> {
    const item = await this.pub<any>("/api/v1/contract/ticker", { symbol: toMexcSymbol(symbol) });
    return {
      symbol: String(item.symbol),
      lastPrice: Number(item.lastPrice),
      bid1: Number(item.bid1),
      ask1: Number(item.ask1),
      fairPrice: Number(item.fairPrice),
      indexPrice: Number(item.indexPrice),
      fundingRate: Number(item.fundingRate),
      timestamp: Number(item.timestamp),
    };
  }

  async getEquity(): Promise<MexcAsset> {
    const assets = await this.signed<any[]>("GET", "/api/v1/private/account/assets");
    const item = assets.find((asset) => String(asset.currency).toUpperCase() === "USDT");
    if (!item) throw new Error("MEXC Futures không có asset USDT");
    return {
      currency: "USDT",
      positionMargin: Number(item.positionMargin),
      frozenBalance: Number(item.frozenBalance),
      availableBalance: Number(item.availableBalance),
      cashBalance: Number(item.cashBalance),
      equity: Number(item.equity),
      unrealized: Number(item.unrealized),
      availableOpen: Number(item.availableOpen),
    };
  }

  async getPositionMode(): Promise<number> {
    const data = await this.signed<any>("GET", "/api/v1/private/position/position_mode");
    const mode = Number(typeof data === "number" ? data : data?.positionMode);
    if (mode !== 1 && mode !== 2) {
      throw new Error("MEXC position_mode trả schema không hợp lệ; không thể xác minh One-way mode");
    }
    return mode;
  }

  async getOpenPositions(symbol?: string): Promise<MexcPosition[]> {
    const data = await this.signed<any[]>("GET", "/api/v1/private/position/open_positions", {
      symbol: symbol ? toMexcSymbol(symbol) : undefined,
    });
    return (data ?? []).map((item) => ({
      positionId: String(item.positionId),
      symbol: String(item.symbol),
      holdVol: Number(item.holdVol),
      positionType: Number(item.positionType) as 1 | 2,
      openType: Number(item.openType) as 1 | 2,
      state: Number(item.state),
      frozenVol: Number(item.frozenVol),
      holdAvgPrice: Number(item.holdAvgPrice),
      liquidatePrice: Number(item.liquidatePrice),
      leverage: Number(item.leverage),
      unRealizedPnl: Number(item.unRealizedPnl ?? 0),
    }));
  }

  async getOpenPosition(symbol: string): Promise<MexcPosition | null> {
    const positions = await this.getOpenPositions(symbol);
    const venueSymbol = toMexcSymbol(symbol);
    return positions.find((p) => p.symbol === venueSymbol && p.state !== 3 && p.holdVol > 0) ?? null;
  }

  private normalizeOrder(item: any): MexcOrder {
    return {
      orderId: String(item.orderId),
      positionId: item.positionId == null ? undefined : String(item.positionId),
      symbol: String(item.symbol),
      vol: Number(item.vol),
      side: Number(item.side),
      dealAvgPrice: Number(item.dealAvgPrice),
      dealVol: Number(item.dealVol),
      state: Number(item.state),
      externalOid: String(item.externalOid ?? ""),
      takerFee: Number(item.takerFee ?? 0),
      makerFee: Number(item.makerFee ?? 0),
    };
  }

  /**
   * Vị thế ĐÃ ĐÓNG của symbol — CHỈ ĐỌC. Dùng để đo trượt giá thật ở chiều thoát: khi stop trên sàn
   * tự bắn thì bot không tạo lệnh nào nên không có `dealAvgPrice` nào để bắt, và id lệnh stop không
   * trở thành id order. Endpoint này trả `closeAvgPrice` + `realised` của chính vị thế vừa đóng.
   */
  async getHistoryPositions(symbol: string, pageSize = 20): Promise<
    { positionId: number; closeAvgPrice: number; closeVol: number; realised: number; updateTime: number }[]
  > {
    const data = await this.signed<any[]>("GET", "/api/v1/private/position/list/history_positions", {
      symbol: toMexcSymbol(symbol),
      page_num: 1,
      page_size: pageSize,
    });
    return (data ?? []).map((p) => ({
      positionId: Number(p.positionId),
      closeAvgPrice: Number(p.closeAvgPrice ?? 0),
      closeVol: Number(p.closeVol ?? 0),
      realised: Number(p.realised ?? 0),
      updateTime: Number(p.updateTime ?? 0),
    }));
  }

  async getOrderById(orderId: string): Promise<MexcOrder> {
    return this.normalizeOrder(await this.signed<any>("GET", `/api/v1/private/order/get/${encodeURIComponent(orderId)}`));
  }

  async getOrderByExternalId(symbol: string, externalOid: string): Promise<MexcOrder> {
    const path = `/api/v1/private/order/external/${encodeURIComponent(toMexcSymbol(symbol))}/${encodeURIComponent(externalOid)}`;
    return this.normalizeOrder(await this.signed<any>("GET", path));
  }

  async tryGetOrderByExternalId(symbol: string, externalOid: string): Promise<MexcOrder | null> {
    try {
      return await this.getOrderByExternalId(symbol, externalOid);
    } catch (error) {
      const code = error instanceof MexcApiError ? error.code : (error as any)?.response?.data?.code;
      const status = (error as any)?.response?.status;
      if (status === 404 || code === 2008 || code === 2011 || code === 3002) return null;
      throw error;
    }
  }

  private async waitForOrder(orderId: string): Promise<MexcOrder> {
    let last: MexcOrder | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      last = await this.getOrderById(orderId);
      if ([3, 4, 5].includes(last.state)) return last;
      await sleep(350);
    }
    if (last) return last;
    throw new Error(`MEXC không đọc được order ${orderId}`);
  }

  async createMarketOrder(input: {
    symbol: string;
    price: number;
    contracts: number;
    leverage: number;
    side: 1 | 2 | 3 | 4;
    openType: 1 | 2;
    externalOid: string;
    positionId?: string;
    reduceOnly?: boolean;
  }): Promise<MexcOrder> {
    const body = {
      symbol: toMexcSymbol(input.symbol),
      price: this.roundPrice(input.symbol, input.price),
      vol: input.contracts,
      leverage: input.leverage,
      side: input.side,
      type: 5,
      openType: input.openType,
      externalOid: input.externalOid,
      positionId: input.positionId,
      positionMode: 2,
      reduceOnly: input.reduceOnly,
    };
    try {
      const created = await this.signed<any>("POST", "/api/v1/private/order/create", body);
      const orderId = String(created?.orderId ?? created);
      if (!orderId || orderId === "undefined") throw new Error("MEXC create order không trả orderId");
      return await this.waitForOrder(orderId);
    } catch (error) {
      // Unknown write outcome: reconcile by deterministic externalOid before returning/throwing.
      try {
        const recovered = await this.tryGetOrderByExternalId(input.symbol, input.externalOid);
        if (recovered) return recovered;
      } catch {
        // Preserve the original mutation error; caller keeps the operation pending/quarantined.
      }
      throw error;
    }
  }

  async getOpenStopOrders(symbol: string): Promise<MexcStopOrder[]> {
    const data = await this.signed<any[]>("GET", "/api/v1/private/stoporder/open_orders", {
      symbol: toMexcSymbol(symbol),
    });
    return (data ?? []).map((item) => ({
      id: String(item.id),
      symbol: String(item.symbol),
      positionId: String(item.positionId),
      stopLossPrice: Number(item.stopLossPrice),
      state: Number(item.state),
      positionType: Number(item.positionType),
      vol: Number(item.vol),
      realityVol: Number(item.realityVol ?? item.vol),
      volType: Number(item.volType ?? 0),
      isFinished: Number(item.isFinished ?? 0),
      errorCode: Number(item.errorCode ?? 0),
    }));
  }

  async placePositionStop(position: MexcPosition, stopPrice: number): Promise<string> {
    const data = await this.signed<any>("POST", "/api/v1/private/stoporder/place", {
      lossTrend: 2,
      profitTrend: 2,
      positionId: position.positionId,
      vol: position.holdVol,
      stopLossPrice: stopPrice,
      priceProtect: 0,
      profitLossVolType: "SAME",
      volType: 2,
      takeProfitType: 0,
      takeProfitOrderPrice: 0,
      stopLossType: 0,
      stopLossOrderPrice: 0,
      takeProfitReverse: 2,
      stopLossReverse: 2,
    });
    const first = Array.isArray(data) ? data[0] : data;
    const id = String(first?.id ?? first);
    if (!id || id === "undefined") throw new Error("MEXC place stop không trả stop id");
    return id;
  }

  async modifyStopPrice(stopPlanOrderId: string, stopLossPrice: number): Promise<void> {
    await this.signed("POST", "/api/v1/private/stoporder/change_plan_price", {
      stopPlanOrderId,
      lossTrend: 2,
      stopLossPrice,
      stopLossReverse: 2,
    });
  }

  async cancelStop(stopPlanOrderId: string): Promise<void> {
    await this.signed("POST", "/api/v1/private/stoporder/cancel", {
      orders: [{ stopPlanOrderId }],
    });
  }
}

export function createMexcFromEnv(): MexcFutures | null {
  const apiKey = process.env.MEXC_API_KEY?.trim();
  const apiSecret = process.env.MEXC_API_SECRET?.trim();
  if (!apiKey || !apiSecret) return null;
  return new MexcFutures({
    apiKey,
    apiSecret,
    baseUrl: process.env.MEXC_BASE_URL?.trim() || "https://api.mexc.com",
    recvWindowMs: Number(process.env.MEXC_RECV_WINDOW_MS ?? 10_000),
  });
}
