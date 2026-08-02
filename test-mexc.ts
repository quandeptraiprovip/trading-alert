import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { calculateMexcContracts, MexcContractInfo, MexcFutures, mexcQueryString, signMexcRequest, toMexcSymbol } from "./mexc-futures";
import { makeMexcExternalOid, MexcFastExecution } from "./mexc-fast-execution";
import {
  FAST_SHORT_CONFIRM_BARS,
  FAST_SHORT_ENTRY_DAYS,
  atomicWriteFileSync,
  decideFastShortConfirmation,
  priorFastShortCloseLow,
} from "./fast-trend-live";
import { Candle, TF_MS } from "./strategy";

const contract: MexcContractInfo = {
  symbol: "BTC_USDT",
  contractType: 1,
  positionOpenType: 3,
  baseCoin: "BTC",
  quoteCoin: "USDT",
  futureType: 1,
  contractSize: 0.0001,
  minLeverage: 1,
  maxLeverage: 100,
  countryConfigContractMaxLeverage: 0,
  priceScale: 1,
  volScale: 0,
  priceUnit: 0.1,
  volUnit: 1,
  minVol: 1,
  maxVol: 400_000,
  state: 0,
  appraisal: 0,
  apiAllowed: true,
  stopOnlyFair: false,
};

assert.equal(toMexcSymbol("btcusdt"), "BTC_USDT");
assert.equal(toMexcSymbol("BTC/USDT"), "BTC_USDT");
assert.equal(mexcQueryString({ b: "two", ignored: undefined, a: 1 }), "a=1&b=two");

assert.equal(
  signMexcRequest("key123", "secret456", 1_700_000_000_000, "a=1&b=two"),
  "7982e1ea9e8018bdfa2dc0eb3bf8c12d15f3062066204645a9bbb777f95bdd6d",
);

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-mexc-state-"));
try {
  const target = path.join(stateDir, "state.json");
  fs.writeFileSync(target, "old");
  const busy = Object.assign(new Error("resource busy"), { code: "EBUSY" });
  assert.throws(() => atomicWriteFileSync(target, "new", () => { throw busy; }), /resource busy/);
  assert.equal(fs.readFileSync(target, "utf8"), "old", "failed rename must not truncate durable state");
  assert.equal(fs.readFileSync(`${target}.tmp`, "utf8"), "new", "new snapshot remains recoverable");
  atomicWriteFileSync(target, "new");
  assert.equal(fs.readFileSync(target, "utf8"), "new");
  assert.equal(fs.existsSync(`${target}.tmp`), false);

  const setupSnapshot = [{
    symbol: "btcusdt",
    lastBarTime: 1_700_000_000_000,
    pos: null,
    shortEntrySetup: { breakoutLevel: 99, signalBarTime: 1_700_000_000_000 },
  }];
  atomicWriteFileSync(target, JSON.stringify(setupSnapshot));
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), setupSnapshot, "armed short setup must survive durable state write/reload");
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
}

assert.equal(FAST_SHORT_ENTRY_DAYS, 30);
assert.equal(FAST_SHORT_CONFIRM_BARS, 1);
const signalTime = 1_700_000_000_000;
const shortSetup = { breakoutLevel: 100, signalBarTime: signalTime };
assert.equal(decideFastShortConfirmation(shortSetup, { openTime: signalTime, close: 99 }, true, true), "wait");
assert.equal(decideFastShortConfirmation(shortSetup, { openTime: signalTime + TF_MS["4h"], close: 99 }, true, true), "enter");
assert.equal(decideFastShortConfirmation(shortSetup, { openTime: signalTime + TF_MS["4h"], close: 100 }, true, true), "cancel");
assert.equal(decideFastShortConfirmation(shortSetup, { openTime: signalTime + TF_MS["4h"], close: 99 }, false, true), "cancel");
assert.equal(decideFastShortConfirmation(shortSetup, { openTime: signalTime + TF_MS["4h"], close: 99 }, true, false), "cancel");
assert.equal(decideFastShortConfirmation(shortSetup, { openTime: signalTime + 2 * TF_MS["4h"], close: 99 }, true, true), "cancel", "missing the immediate next closed bar must not enter late");

const closeChannel: Candle[] = Array.from({ length: FAST_SHORT_ENTRY_DAYS * 6 + 1 }, (_, i) => ({
  openTime: i * TF_MS["4h"],
  open: 101,
  high: 110,
  low: 90,
  close: 100,
  volume: 1,
  quoteVolume: 100,
  takerBuyVolume: 0.5,
}));
closeChannel[5].low = 1; // wick phải bị bỏ qua
closeChannel[7].close = 95;
closeChannel[closeChannel.length - 1].close = 1; // nến signal hiện tại không được lọt vào channel
assert.equal(priorFastShortCloseLow(closeChannel, closeChannel.length - 1), 95);

const sized = calculateMexcContracts(contract, 100, 100_000, 95_000);
assert.equal(sized.contracts, 200);
assert.equal(sized.actualRiskUsd, 100);

const tooSmall = calculateMexcContracts({ ...contract, minVol: 10 }, 1, 100_000, 95_000);
assert.equal(tooSmall.contracts, 0, "must reject instead of rounding up above risk budget");

const id = makeMexcExternalOid("fast:mexc:btcusdt:entry:1700000000000:1");
assert.equal(id.length, 32);
assert.equal(id, makeMexcExternalOid("fast:mexc:btcusdt:entry:1700000000000:1"));
assert.notEqual(id, makeMexcExternalOid("fast:mexc:btcusdt:entry:1700000000000:2"));

async function testExecutionFlow(): Promise<void> {
  let createCalls = 0;
  let stopPlaced = false;
  const position = {
    positionId: "pos-1",
    symbol: "BTC_USDT",
    holdVol: 200,
    positionType: 1,
    openType: 1,
    state: 1,
    frozenVol: 0,
    holdAvgPrice: 100_000,
    liquidatePrice: 50_000,
    leverage: 10,
    unRealizedPnl: 0,
  };
  const fake = {
    syncTime: async () => {},
    loadContracts: async () => {},
    getContract: () => contract,
    getEquity: async () => ({ equity: 10_000, availableOpen: 10_000 }),
    getPositionMode: async () => 2,
    getOpenPositions: async () => [],
    getTicker: async () => ({ lastPrice: 100_000, fairPrice: 100_000 }),
    roundStop: (_symbol: string, price: number) => Math.round(price * 10) / 10,
    createMarketOrder: async () => {
      createCalls++;
      return {
        orderId: "order-1",
        positionId: "pos-1",
        symbol: "BTC_USDT",
        vol: 200,
        side: 1,
        dealAvgPrice: 100_000,
        dealVol: 200,
        state: 3,
        externalOid: "owned",
        takerFee: 0,
        makerFee: 0,
      };
    },
    getOpenPosition: async () => position,
    placePositionStop: async () => { stopPlaced = true; return "stop-1"; },
    getOpenStopOrders: async () => stopPlaced ? [{
      id: "stop-1",
      symbol: "BTC_USDT",
      positionId: "pos-1",
      stopLossPrice: 95_000,
      state: 1,
      positionType: 1,
      vol: 0,
      realityVol: 0,
      volType: 2,
      isFinished: 0,
      errorCode: 0,
    }] : [],
  } as unknown as MexcFutures;

  const execution = new MexcFastExecution(fake, {
    riskPct: 0.01,
    maxPortfolioRiskPct: 0.1,
    leverage: 10,
    marginType: "ISOLATED",
    maxBasisPct: 0.003,
  });
  (fake as any).getContract = () => ({ ...contract, contractType: 2 });
  const suspended = await execution.preflight(["btcusdt"]);
  assert.equal(suspended.ok, false);
  assert.match(suspended.errors.join(" | "), /contract type=2/);
  (fake as any).getContract = () => contract;

  const result = await execution.open(
    "btcusdt",
    { dir: "long", signalEntry: 100_000, initialSL: 95_000, signalStop: 95_000 },
    0,
    "entry-1",
    0.04,
  );
  assert.equal(result.placed, true);
  assert.equal(result.qty, 200);
  assert.equal(result.protectionId, "stop-1");
  assert.equal(result.confirmedVenueSl, 95_000);
  assert.equal(createCalls, 1);

  (fake as any).getTicker = async () => ({ lastPrice: 101_000, fairPrice: 101_000 });
  const rejected = await execution.open(
    "btcusdt",
    { dir: "long", signalEntry: 100_000, initialSL: 95_000, signalStop: 95_000 },
    0,
    "entry-2",
    0.04,
  );
  assert.equal(rejected.placed, false);
  assert.match(rejected.reason ?? "", /basis/);
  assert.equal(createCalls, 1, "basis rejection must happen before order mutation");
}

async function testOneWayCloseDirections(): Promise<void> {
  for (const [dir, positionType, expectedSide] of [
    ["long", 1, 3],
    ["short", 2, 1],
  ] as const) {
    let open = true;
    let closeInput: any;
    const fake = {
      getOpenPosition: async () => open ? {
        positionId: `pos-${dir}`,
        symbol: "BTC_USDT",
        holdVol: 2,
        positionType,
        openType: 1,
        state: 1,
        frozenVol: 0,
        holdAvgPrice: 100_000,
        liquidatePrice: 0,
        leverage: 10,
        unRealizedPnl: 0,
      } : null,
      getTicker: async () => ({ lastPrice: 100_000 }),
      createMarketOrder: async (input: any) => {
        closeInput = input;
        open = false;
        return {
          orderId: `close-${dir}`,
          positionId: `pos-${dir}`,
          symbol: "BTC_USDT",
          vol: 2,
          side: input.side,
          dealAvgPrice: 100_000,
          dealVol: 2,
          state: 3,
          externalOid: input.externalOid,
          takerFee: 0,
          makerFee: 0,
        };
      },
      getOpenStopOrders: async () => [],
    } as unknown as MexcFutures;
    const execution = new MexcFastExecution(fake, {
      riskPct: 0.01,
      maxPortfolioRiskPct: 0.1,
      leverage: 10,
      marginType: "ISOLATED",
      maxBasisPct: 0.003,
    });
    await execution.flatten("btcusdt", dir, `close-${dir}`);
    assert.equal(closeInput.side, expectedSide, `${dir} one-way close must use opposite buy/sell side`);
    assert.equal(closeInput.reduceOnly, true);
  }
}

Promise.all([testExecutionFlow(), testOneWayCloseDirections()])
  .then(() => console.log("MEXC signing/sizing/idempotency/execution tests: OK"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
