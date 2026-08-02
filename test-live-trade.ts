import assert from "assert";
import { BinanceFutures } from "./binance-futures";
import { LiveTrader, PosInfo } from "./live-trade";
import { fmtPrice } from "./telegram";

const cfg = {
  riskPct: 0.01,
  maxPortfolioRiskPct: 0.1,
  leverage: 10,
  marginType: "ISOLATED" as const,
};

const shortPos: PosInfo = {
  dir: "short",
  initialSL: 0.073,
  sl: 0.071,
  target: 0.05,
};

async function testStopReplacementOrder(): Promise<void> {
  const calls: string[] = [];
  let activeStop: { algoId: number; orderType: string; triggerPrice: string } | null = {
    algoId: 10,
    orderType: "STOP_MARKET",
    triggerPrice: "0.073",
  };
  const fake = {
    getOpenAlgoOrders: async () => activeStop ? [activeStop] : [],
    roundPrice: (_symbol: string, price: number) => price,
    roundQty: (_symbol: string, qty: number) => qty,
    getPosition: async () => ({ positionAmt: -100 }),
    cancelAlgoOrder: async (id: number) => {
      calls.push(`cancel:${id}`);
      activeStop = null;
    },
    stopMarketClose: async (_symbol: string, side: string, price: number) => {
      calls.push(`place:${side}:${price}`);
      activeStop = { algoId: 11, orderType: "STOP_MARKET", triggerPrice: String(price) };
      return 11;
    },
  } as unknown as BinanceFutures;

  await new LiveTrader(fake, cfg).syncStops("dogeusdt", shortPos, { noTp: true });
  assert.deepEqual(calls, ["cancel:10", "place:BUY:0.071"]);
}

async function testOldStopRestoredOnFailure(): Promise<void> {
  const calls: string[] = [];
  let placements = 0;
  let activeStop: { algoId: number; orderType: string; triggerPrice: string } | null = {
    algoId: 20,
    orderType: "STOP_MARKET",
    triggerPrice: "0.073",
  };
  const rejected = Object.assign(new Error("Request failed with status code 400"), {
    response: { data: { code: -2021, msg: "Order would immediately trigger." } },
  });
  const fake = {
    getOpenAlgoOrders: async () => activeStop ? [activeStop] : [],
    roundPrice: (_symbol: string, price: number) => price,
    roundQty: (_symbol: string, qty: number) => qty,
    getPosition: async () => ({ positionAmt: -100 }),
    cancelAlgoOrder: async (id: number) => {
      calls.push(`cancel:${id}`);
      activeStop = null;
    },
    stopMarketClose: async (_symbol: string, side: string, price: number) => {
      calls.push(`place:${side}:${price}`);
      if (placements++ === 0) throw rejected;
      activeStop = { algoId: 21, orderType: "STOP_MARKET", triggerPrice: String(price) };
      return 21;
    },
  } as unknown as BinanceFutures;

  await assert.rejects(
    () => new LiveTrader(fake, cfg).syncStops("dogeusdt", shortPos, { noTp: true }),
    /đã khôi phục SL cũ/,
  );
  assert.deepEqual(calls, ["cancel:20", "place:BUY:0.071", "place:BUY:0.073"]);
}

async function testAmbiguousNewStopAccepted(): Promise<void> {
  const calls: string[] = [];
  let activeStop: { algoId: number; orderType: string; triggerPrice: string } | null = {
    algoId: 30,
    orderType: "STOP_MARKET",
    triggerPrice: "0.073",
  };
  const fake = {
    getOpenAlgoOrders: async () => activeStop ? [activeStop] : [],
    roundPrice: (_symbol: string, price: number) => price,
    roundQty: (_symbol: string, qty: number) => qty,
    getPosition: async () => ({ positionAmt: -100 }),
    cancelAlgoOrder: async (id: number) => {
      calls.push(`cancel:${id}`);
      activeStop = null;
    },
    stopMarketClose: async (_symbol: string, side: string, price: number) => {
      calls.push(`place:${side}:${price}`);
      activeStop = { algoId: 31, orderType: "STOP_MARKET", triggerPrice: String(price) };
      throw new Error("connection reset after accept");
    },
  } as unknown as BinanceFutures;

  await new LiveTrader(fake, cfg).syncStops("dogeusdt", shortPos, { noTp: true });
  assert.deepEqual(calls, ["cancel:30", "place:BUY:0.071"]);
}

assert.equal(fmtPrice(0.0694754), "0.0694754");
assert.equal(fmtPrice(6.282), "6.282");
assert.equal(fmtPrice(100_000.123), "100,000.12");

Promise.all([testStopReplacementOrder(), testOldStopRestoredOnFailure(), testAmbiguousNewStopAccepted()])
  .then(() => console.log("Binance stop replacement/price formatting tests: OK"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
