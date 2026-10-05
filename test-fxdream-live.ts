/**
 * test-fxdream-live.ts — Luồng bot FX Dream có hỏi ý, chạy trên SÀN GIẢ và nến giả lập.
 *
 * KHÔNG import load-env: env sạch, Telegram tắt, không đụng key thật. State ghi vào thư mục tạm.
 * Run: npm run test:fxdream-live
 */
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { FxDreamLive, FxVenue, isNightVn, parseEditText, parsePrice } from "./fxdream-live";
import { KEY_VOLUME_CONFIG } from "./key-volume";
import { buildProposalSvg, renderPng } from "./fxdream-image";
import { Candle, TF_MS } from "./strategy";

type Bar = { open: number; high: number; low: number; close: number; volume?: number };
const M15 = TF_MS["15m"];
const BELOW: Bar = { open: 99.3, high: 99.5, low: 99.1, close: 99.4 };

/**
 * Cùng hình với fixture nhánh 4 của test-key-volume.ts: key 100 ở nến 100, nến 701 râu chạm key
 * thành đỉnh phản ứng 100,3, nến xanh 704 lên đỉnh thấp hơn 99,75, nến 705 xác nhận.
 */
function fixture(base: number, tail: Bar[]): Candle[] {
  const bars: Bar[] = [];
  for (let i = 0; i < 700; i++) {
    bars.push(i === 100 ? { open: 100.0, high: 100.1, low: 99.0, close: 99.2, volume: 2000 } : BELOW);
  }
  bars.push(
    { open: 99.4, high: 99.9, low: 99.35, close: 99.85 },
    { open: 99.85, high: 100.3, low: 99.8, close: 99.95 },
    { open: 99.95, high: 100.0, low: 99.4, close: 99.45 },
    { open: 99.45, high: 99.5, low: 99.2, close: 99.3 },
    { open: 99.3, high: 99.75, low: 99.25, close: 99.7 },
    { open: 99.7, high: 99.72, low: 99.1, close: 99.15 },
    ...tail,
  );
  return bars.map((b, i) => ({
    openTime: base + i * M15, open: b.open, high: b.high, low: b.low, close: b.close,
    volume: b.volume ?? 100, quoteVolume: b.volume ?? 100, takerBuyVolume: (b.volume ?? 100) / 2,
  }));
}
const CONFIRM = 705;

const PARAMS = {
  ...KEY_VOLUME_CONFIG,
  minRR: 0,
  requireStructuralTarget: false,
  requireKeyMaturation: false,
  enableSweepBranch: false,
  enableVolumeReversalBranch: false,
  enableKeyTrapBranch: false,
};

class FakeVenue implements FxVenue {
  cur!: Candle;
  pos = 0;
  entry = 0;
  orders: any[] = [];
  done = new Map<number, any>();
  algos: any[] = [];
  fills: any[] = [];
  private id = 1;
  getFilters() {
    return { symbol: "TEST", stepSize: 0.001, qtyPrecision: 3, tickSize: 0.01, pricePrecision: 2, minQty: 0.001, minNotional: 5 };
  }
  roundQty(_s: string, q: number) { return Math.floor(q * 1000 + 1e-9) / 1000; }
  roundPrice(_s: string, p: number) { return Math.round(p * 100) / 100; }
  async getEquity() { return { walletBalance: 1000, available: 1000 }; }
  async getPosition() {
    return { symbol: "TEST", positionAmt: this.pos, entryPrice: this.entry, markPrice: this.cur.close, unrealizedProfit: 0, liquidationPrice: 0, leverage: 10 };
  }
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

/** Chạy bot từ nến `startAt` tới hết `candles`; `onPending` quyết định từng đề nghị. */
async function replay(
  candles: Candle[],
  startAt: number,
  onPending: (fx: FxDreamLive, id: string) => Promise<void>,
  setup?: (venue: FakeVenue) => void,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxdream-test-"));
  const venue = new FakeVenue();
  let idx = startAt;
  let clock = candles[idx].openTime + M15 + 5000;
  venue.cur = candles[idx];
  setup?.(venue);
  const fx = new FxDreamLive({
    symbol: "test", venue, telegram: { enabled: false, botToken: "", chatId: "" }, riskUsd: 5, leverage: 10,
    dataDir: dir, isTradingReady: () => true, params: PARAMS, now: () => clock,
    fetchClosed: async (n) => candles.slice(Math.max(0, idx + 1 - n), idx + 1),
  });
  const log = console.log;
  console.log = () => {};
  try {
    await fx.start();
    for (idx = startAt + 1; idx < candles.length; idx++) {
      venue.step(candles[idx]);
      clock = candles[idx].openTime + M15 + 5000;
      await fx.tick();
      for (const p of fx.snapshot().proposals.filter((x) => x.status === "pending")) await onPending(fx, p.id);
    }
  } finally {
    console.log = log;
  }
  const journal = fs.existsSync(path.join(dir, "fxdream-trades.jsonl"))
    ? fs.readFileSync(path.join(dir, "fxdream-trades.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
  return { fx, venue, journal };
}

// Giờ VN ban ngày: nến 0 mở lúc 07:00 VN ⇒ nến xác nhận đóng 15:30 VN.
const DAY = 0;
// Dịch 9h30 ⇒ nến xác nhận đóng 01:00 VN.
const NIGHT = 9.5 * 3600_000;

const TAIL: Bar[] = [
  { open: 99.15, high: 99.35, low: 99.1, close: 99.2 }, // hồi chạm mép 99,3 → khớp
  { open: 99.2, high: 99.25, low: 98.1, close: 98.3 }, // chạm +1R → chốt 33%
  { open: 98.3, high: 99.4, low: 98.2, close: 99.35 }, // quay lên chạm SL đã dời về giá vào
  BELOW,
];

async function testApproveFillPartialBreakeven(): Promise<void> {
  const candles = fixture(DAY, TAIL);
  assert.equal(isNightVn(candles[CONFIRM].openTime + M15), false);
  const { fx, venue, journal } = await replay(candles, CONFIRM - 1, (f, id) => f.decide(id, true));
  const p = fx.snapshot().proposals[0];
  assert.ok(p, "nến xác nhận đỉnh thấp hơn phải sinh đề nghị");
  assert.equal(p.kind, "limit");
  assert.equal(p.dir, "short");
  assert.equal(p.branch, "key-lower-high");
  assert.equal(p.entry, 99.3, "LIMIT ở mép dưới thân nến xanh");
  assert.equal(p.auto, false, "ban ngày phải hỏi");
  assert.equal(p.status, "approved");
  const opened = journal.find((e) => e.event === "opened");
  assert.ok(opened, "LIMIT phải khớp và mở vị thế");
  assert.equal(opened.entry, 99.3);
  assert.ok(opened.stop > 100.3, "SL ngoài đỉnh phản ứng");
  assert.ok(opened.riskUsd > 4.5 && opened.riskUsd < 5.1, `lệnh bạn duyệt: rủi ro đủ $5, được ${opened.riskUsd}`);
  const closed = journal.find((e) => e.event === "closed");
  assert.ok(closed, "vị thế phải đóng");
  assert.equal(closed.reason, "SL về giá vào sau khi chốt 33%");
  assert.ok(closed.grossR > 0.3 && closed.grossR < 0.36, `chốt 33% ở 1R rồi hoà phần còn lại ≈ +0,33R, được ${closed.grossR}`);
  assert.equal(venue.pos, 0);
  assert.equal(fx.snapshot().position, null);
}

async function testRejectPlacesNothing(): Promise<void> {
  const { fx, venue, journal } = await replay(fixture(DAY, TAIL), CONFIRM - 1, (f, id) => f.decide(id, false));
  assert.equal(fx.snapshot().proposals[0].status, "rejected");
  assert.equal(venue.fills.length, 0, "bỏ qua thì không có lệnh nào");
  assert.equal(journal.length, 0);
}

async function testNightAutoEnters(): Promise<void> {
  const candles = fixture(NIGHT, TAIL);
  assert.equal(isNightVn(candles[CONFIRM].openTime + M15), true);
  let asked = 0;
  const { fx, journal } = await replay(candles, CONFIRM - 1, async () => { asked++; });
  assert.equal(asked, 0, "00:00–06:00 không hỏi");
  const p = fx.snapshot().proposals[0];
  assert.equal(p.auto, true);
  assert.equal(p.status, "approved");
  const opened = journal.find((e) => e.event === "opened");
  assert.ok(opened, "tự vào lệnh");
  assert.ok(opened.riskUsd > 2 && opened.riskUsd < 2.6, `tự vào ban đêm: nửa rủi ro $2,5, được ${opened.riskUsd}`);
}

async function testForeignPositionBlocks(): Promise<void> {
  const { fx, venue } = await replay(fixture(DAY, TAIL), CONFIRM - 1, (f, id) => f.decide(id, true), (v) => {
    v.pos = 0.5;
    v.entry = 99;
  });
  assert.ok(fx.blocked, "vị thế lạ trên sàn phải khoá bot");
  assert.equal(fx.snapshot().proposals[0].status, "skipped");
  assert.equal(venue.orders.length + venue.fills.length, 0, "không đụng vào vị thế lạ");
}

async function testUnansweredProposalExpires(): Promise<void> {
  // Đề nghị không được trả lời thì hết hạn, không vào.
  const { fx, venue } = await replay(fixture(DAY, [...TAIL, BELOW, BELOW, BELOW, ...Array(16).fill(BELOW)]), CONFIRM - 1, async () => {});
  assert.equal(fx.snapshot().proposals[0].status, "expired");
  assert.equal(venue.fills.length, 0);
}

function testParsePrice(): void {
  assert.equal(parsePrice("78900"), 78900);
  assert.equal(parsePrice("78,900.5"), 78900.5);
  assert.equal(parsePrice("78.900,5"), 78900.5);
  assert.equal(parsePrice("78900,5"), 78900.5);
  assert.equal(parsePrice("78.900"), 78900, "một dấu chấm + đúng 3 số = phân cách nghìn");
  assert.equal(parsePrice("99.35"), 99.35);
  assert.equal(parsePrice("abc"), null);
  assert.deepEqual(parseEditText("sl 79400 tp 78300"), { stop: 79400, target: 78300 });
  assert.deepEqual(parseEditText("Vào: 78.850,5"), { entry: 78850.5 });
  assert.deepEqual(parseEditText("entry=78850 SL=79,400"), { entry: 78850, stop: 79400 });
  assert.equal(parseEditText("ok"), null);
}

/** ✏️ Sửa SL/TP rồi ✅: lệnh vào đúng giá đã sửa, chốt 33% tính lại theo R mới. */
async function testEditThenApprove(): Promise<void> {
  let step = 0;
  const { fx, journal } = await replay(fixture(DAY, TAIL), CONFIRM - 1, async (f, id) => {
    if (step++ > 0) return;
    await f.startEdit(id);
    assert.equal(await f.handleText("sl 99.1 tp 97"), true);
    const bad = f.snapshot().proposals.find((x) => x.id === id)!;
    assert.equal(bad.stop, f.snapshot().proposals[0].stop, "SL dưới entry của lệnh SHORT bị từ chối, giữ nguyên");
    assert.equal(bad.edited, undefined);
    assert.equal(await f.handleText("sl 100,5 tp 97"), true);
    await f.decide(id, true);
  });
  const p = fx.snapshot().proposals[0];
  assert.equal(p.stop, 100.5);
  assert.equal(p.target, 97);
  assert.deepEqual(p.edited, ["sl", "tp"]);
  assert.ok(Math.abs(p.partial! - 98.1) < 1e-9, "1R tính lại từ SL mới: 99,3 − 1,2");
  assert.equal(fx.snapshot().editingId, null);
  const opened = journal.find((e) => e.event === "opened");
  assert.ok(opened, "duyệt sau khi sửa phải vào lệnh");
  assert.equal(opened.stop, 100.5);
  assert.equal(opened.target, 97);
}

/** Không ở chế độ sửa thì tin nhắn chữ không bị FX Dream nuốt. */
async function testTextIgnoredWhenNotEditing(): Promise<void> {
  let used: boolean | null = null;
  await replay(fixture(DAY, TAIL), CONFIRM - 1, async (f, id) => {
    if (used !== null) return;
    used = await f.handleText("sl 100");
    await f.decide(id, false);
  });
  assert.equal(used, false);
}

/** Sàn báo lỗi lúc đặt LIMIT → đề nghị "failed" nhưng còn thử lại được; ✅ lần hai đặt lệnh bình thường. */
async function testRetryAfterVenueError(): Promise<void> {
  let calls = 0;
  const { fx, journal } = await replay(fixture(DAY, TAIL), CONFIRM - 1, async (f, id) => {
    await f.decide(id, true);
    const p = f.snapshot().proposals.find((x) => x.id === id)!;
    assert.equal(p.status, "failed");
    assert.equal(p.retryable, true, "lỗi sàn phải cho thử lại");
    assert.match(p.note!, /lỗi sàn: Timestamp/);
    await f.decide(id, true);
  }, (v) => {
    const orig = v.limitOrder.bind(v);
    v.limitOrder = async (...args: Parameters<FakeVenue["limitOrder"]>) => {
      if (calls++ === 0) throw new Error("Timestamp for this request is outside of the recvWindow");
      return orig(...args);
    };
  });
  assert.equal(calls, 2);
  const p = fx.snapshot().proposals[0];
  assert.equal(p.status, "approved");
  assert.ok(journal.some((e) => e.event === "opened"), "thử lại phải vào lệnh");
}

/** Báo lỗi nhưng lệnh THẬT ra đã lên sàn (timeout): thử lại phải khoá, không đặt lệnh thứ hai. */
async function testRetryDoesNotDoubleOrder(): Promise<void> {
  let calls = 0;
  const { fx, venue } = await replay(fixture(DAY, TAIL), CONFIRM - 1, async (f, id) => {
    await f.decide(id, true);
    await f.decide(id, true);
  }, (v) => {
    const orig = v.limitOrder.bind(v);
    v.limitOrder = async (...args: Parameters<FakeVenue["limitOrder"]>) => {
      calls++;
      await orig(...args);
      throw new Error("timeout of 10000ms exceeded");
    };
  });
  assert.equal(calls, 1, "không được gửi lệnh lần hai");
  assert.ok(fx.blocked, "lệnh lạ trên sàn phải khoá bot");
  const p = fx.snapshot().proposals[0];
  assert.equal(p.status, "failed");
  assert.equal(p.retryable, false);
  assert.ok(venue.orders.length + venue.fills.length <= 1);
}

/** Lỗi sàn mà không thử lại: quá hạn đề nghị thì mất quyền thử lại, bấm nút cũ không đặt lệnh. */
async function testRetryExpires(): Promise<void> {
  let first = true;
  const { fx } = await replay(fixture(DAY, Array(21).fill(BELOW)), CONFIRM - 1, async (f, id) => {
    if (!first) return;
    first = false;
    await f.decide(id, true);
  }, (v) => {
    v.limitOrder = async () => { throw new Error("Service unavailable"); };
  });
  const p = fx.snapshot().proposals[0];
  assert.equal(p.status, "failed");
  assert.equal(p.retryable, false, "quá hạn đề nghị thì hết thử lại");
  await fx.decide(p.id, true);
  assert.equal(fx.snapshot().proposals[0].status, "failed", "bấm nút cũ sau hạn không đặt lệnh");
}

function testImageRenders(): void {
  const candles = fixture(DAY, TAIL).slice(-96);
  const svg = buildProposalSvg({
    candles, dir: "short", title: "SHORT TEST · Đỉnh thấp dần sau key", subtitle: "thử",
    keyPrice: 100, otherKeys: [], box: { low: 99.3, high: 99.7, startTime: candles[90].openTime, endTime: candles[90].openTime },
    entry: 99.3, stop: 100.36, target: 94, partial: 98.24, marks: [], signalTime: candles[91].openTime, footer: ["a", "b"],
  });
  assert.ok(svg.startsWith("<svg") && svg.includes("Đỉnh thấp dần"));
  const png = renderPng(svg);
  assert.ok(png && png.length > 1000 && png.subarray(1, 4).toString() === "PNG", "resvg phải ra PNG");
}

(async () => {
  await testApproveFillPartialBreakeven();
  await testRejectPlacesNothing();
  await testNightAutoEnters();
  await testForeignPositionBlocks();
  await testUnansweredProposalExpires();
  testParsePrice();
  await testEditThenApprove();
  await testTextIgnoredWhenNotEditing();
  await testRetryAfterVenueError();
  await testRetryDoesNotDoubleOrder();
  await testRetryExpires();
  testImageRenders();
  console.log("FX Dream live tests: OK");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
