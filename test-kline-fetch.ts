import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "kline-source-cache-"));
process.env.KLINE_CACHE_DIR = cacheDir;

const axiosModule = require("axios") as typeof import("axios") & { default?: typeof import("axios").default };
const axios = axiosModule.default ?? axiosModule;
const originalGet = axios.get;
const originalNow = Date.now;

const TF = 15 * 60_000;
const t0 = Math.floor(1_700_000_000_000 / TF) * TF;
const t1 = t0 + TF;
const t2 = t1 + TF;
const t3 = t2 + TF;

const candle = (openTime: number, close: number) => ({
  openTime,
  open: 100,
  high: 110,
  low: 90,
  close,
  volume: 10,
  quoteVolume: 1_000,
  takerBuyVolume: 4,
});
const raw = (openTime: number, close: number) => [
  openTime, "100", "110", "90", String(close), "10", openTime + TF - 1,
  "1000", 10, "4", "400", "0",
];

async function main(): Promise<void> {
  Date.now = () => t3 + TF / 2;
  const {
    fetchKlinesPaged,
    fetchSpotKlinesPaged,
    klineCacheFilePath,
  } = require("./kline-fetch") as typeof import("./kline-fetch");

  const futuresCache = klineCacheFilePath("btcusdt", "15m", "futures");
  const spotCache = klineCacheFilePath("btcusdt", "15m", "spot");
  assert.notEqual(futuresCache, spotCache, "Futures và Spot phải dùng cache khác nhau");
  fs.mkdirSync(path.dirname(futuresCache), { recursive: true });
  fs.writeFileSync(futuresCache, JSON.stringify([candle(t0, 100), candle(t1, 999)]));

  let futuresCalls = 0;
  let spotCalls = 0;
  axios.get = (async (url: string, config?: { params?: Record<string, number | string> }) => {
    if (url.includes("/fapi/")) {
      futuresCalls++;
      if (config?.params?.startTime != null) {
        assert.equal(config.params.startTime, t1, "refresh phải refetch nến cuối để sửa snapshot dở");
      }
      return { data: [raw(t1, 101), raw(t2, 102), raw(t3, 103)] } as never;
    }
    spotCalls++;
    return { data: [raw(t0, 200)] } as never;
  }) as typeof axios.get;

  const refreshed = await fetchKlinesPaged("btcusdt", "15m", 2);
  assert.deepEqual(refreshed.map((c) => [c.openTime, c.close]), [[t1, 101], [t2, 102]]);
  const durable = JSON.parse(fs.readFileSync(futuresCache, "utf8"));
  assert.equal(durable.find((c: { openTime: number }) => c.openTime === t1).close, 101);
  assert.equal(durable.some((c: { openTime: number }) => c.openTime === t3), false, "không cache nến chưa đóng");
  assert.equal(spotCalls, 0, "Futures không được âm thầm gọi Spot");

  axios.get = (async (url: string) => {
    if (url.includes("/fapi/")) {
      futuresCalls++;
      throw new Error("futures unavailable");
    }
    spotCalls++;
    return { data: [raw(t0, 200)] } as never;
  }) as typeof axios.get;
  await assert.rejects(fetchKlinesPaged("failclosedusdt", "15m", 1), /futures unavailable/);
  assert.equal(spotCalls, 0, "Futures lỗi phải fail-closed, không fallback Spot");
  const { fetchKlinesPaged: fetchBacktestKlines } = require("./backtest") as typeof import("./backtest");
  await assert.rejects(fetchBacktestKlines("failclosedusdt", "15m", 1), /futures unavailable/);
  assert.equal(spotCalls, 0, "backtest/live Futures lỗi cũng phải fail-closed");

  const spot = await fetchSpotKlinesPaged("btcusdt", "15m", 1);
  assert.equal(spot[0].close, 200);
  assert.equal(spotCalls, 1, "Spot chỉ được gọi qua API explicit");
  assert.ok(fs.existsSync(klineCacheFilePath("btcusdt", "15m", "spot")));

  console.log(`Kline source/cache/closed-candle tests: OK (${futuresCalls} Futures calls, ${spotCalls} Spot call)`);
}

main().finally(() => {
  axios.get = originalGet;
  Date.now = originalNow;
  fs.rmSync(cacheDir, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
