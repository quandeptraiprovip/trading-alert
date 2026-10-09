/**
 * fxdream-fake-venue.ts — Sàn giả cho FxDreamLive: khớp lệnh chờ/SL/TP theo từng nến M15.
 * Dùng chung cho test-fxdream-live.ts và scripts/check-fxdream-replay.ts. Không gọi mạng.
 */
import type { FxVenue } from "./fxdream-live";
import type { Candle } from "./types";

export class FakeVenue implements FxVenue {
  cur!: Candle;
  pos = 0;
  entry = 0;
  orders: any[] = [];
  done = new Map<number, any>();
  algos: any[] = [];
  fills: any[] = [];
  leverage = 10;
  private id = 1;
  getFilters() {
    return { symbol: "TEST", stepSize: 0.001, qtyPrecision: 3, tickSize: 0.01, pricePrecision: 2, minQty: 0.001, minNotional: 5 };
  }
  roundQty(_s: string, q: number) { return Math.floor(q * 1000 + 1e-9) / 1000; }
  roundPrice(_s: string, p: number) { return Math.round(p * 100) / 100; }
  async getEquity() { return { walletBalance: 1000, available: 1000 }; }
  async getPosition() {
    return { symbol: "TEST", positionAmt: this.pos, entryPrice: this.entry, markPrice: this.cur.close, unrealizedProfit: 0, liquidationPrice: 0, leverage: this.leverage };
  }
  async setLeverage(_s: string, lev: number) { this.leverage = lev; }
  private fill(side: string, qty: number, price: number, reduce: boolean) {
    const realized = reduce ? (this.pos > 0 ? (price - this.entry) * qty : (this.entry - price) * qty) : 0;
    if (!reduce) this.entry = price;
    this.pos = Math.round((this.pos + (side === "BUY" ? qty : -qty)) * 1000) / 1000;
    this.fills.push({ time: this.cur.openTime, price, qty, realizedPnl: realized, commission: 0, side });
  }
  async marketOrder(_s: string, side: any, qty: number) {
    this.fill(side, qty, this.cur.close, false);
    return { orderId: this.id++, clientOrderId: "", status: "FILLED", avgPrice: this.cur.close, executedQty: qty };
  }
  async marketClose(_s: string, side: any, qty: number) {
    this.fill(side, qty, this.cur.close, true);
    return { orderId: this.id++, clientOrderId: "", status: "FILLED", avgPrice: this.cur.close, executedQty: qty };
  }
  async limitOrder(_s: string, side: any, qty: number, price: number) {
    const o = { orderId: this.id++, side, qty, price, status: "NEW", executedQty: 0, avgPrice: 0 };
    this.orders.push(o);
    return { ...o, clientOrderId: "" };
  }
  async getOrder(_s: string, id: number) {
    const o = this.orders.find((x) => x.orderId === id) ?? this.done.get(id);
    return { orderId: id, clientOrderId: "", status: o.status, avgPrice: o.avgPrice, executedQty: o.executedQty };
  }
  async cancelOrder(_s: string, id: number) {
    const o = this.orders.find((x) => x.orderId === id);
    if (!o) return;
    o.status = "CANCELED";
    this.done.set(id, o);
    this.orders = this.orders.filter((x) => x !== o);
  }
  private algo(orderType: string, side: any, p: number, qty?: number) {
    const algoId = this.id++;
    this.algos.push({ algoId, orderType, side, triggerPrice: String(p), qty, close: qty == null });
    return algoId;
  }
  async stopMarketClose(_s: string, side: any, p: number) { return this.algo("STOP_MARKET", side, p); }
  async takeProfitMarketClose(_s: string, side: any, p: number) { return this.algo("TAKE_PROFIT_MARKET", side, p); }
  async takeProfitMarketReduce(_s: string, side: any, p: number, qty: number) { return this.algo("TAKE_PROFIT_MARKET", side, p, qty); }
  async cancelAlgoOrder(id: number) { this.algos = this.algos.filter((a) => a.algoId !== id); }
  async cancelAllOpenOrders() { this.orders = []; }
  async cancelAllAlgoOpenOrders() { this.algos = []; }
  async getOpenOrders() { return this.orders; }
  async getOpenAlgoOrders() { return this.algos; }
  async getUserTrades(_s: string, since: number) { return this.fills.filter((f) => f.time >= since); }
  /** Giá chạy trong một nến: lệnh chờ khớp, rồi SL trước (bi quan), rồi TP. */
  step(c: Candle) {
    this.cur = c;
    for (const o of [...this.orders]) {
      if (!(o.side === "SELL" ? c.high >= o.price : c.low <= o.price)) continue;
      const px = o.side === "SELL" ? Math.max(o.price, c.open) : Math.min(o.price, c.open);
      this.fill(o.side, o.qty, px, false);
      Object.assign(o, { status: "FILLED", executedQty: o.qty, avgPrice: px });
      this.done.set(o.orderId, o);
      this.orders = this.orders.filter((x) => x !== o);
    }
    if (this.pos === 0) return;
    const long = this.pos > 0;
    for (const type of ["STOP_MARKET", "TAKE_PROFIT_MARKET"]) {
      for (const a of this.algos.filter((x) => x.orderType === type).sort((x, y) => Number(x.close) - Number(y.close))) {
        const p = +a.triggerPrice;
        const hit = type === "STOP_MARKET" ? (long ? c.low <= p : c.high >= p) : (long ? c.high >= p : c.low <= p);
        if (this.pos === 0 || !hit) continue;
        this.fill(a.side, a.close ? Math.abs(this.pos) : a.qty, p, true);
        this.algos = this.algos.filter((x) => x !== a);
      }
    }
    if (this.pos === 0) this.algos = [];
  }
}
