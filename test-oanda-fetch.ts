import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "oanda-cache-"));
process.env.OANDA_CACHE_DIR = cacheDir;
process.env.OANDA_API_TOKEN = "test-token";
process.env.OANDA_ACCOUNT_ID = "test-account";
process.env.OANDA_ENV = "practice";

const axiosModule = require("axios") as typeof import("axios") & { default?: typeof import("axios").default };
const axios = axiosModule.default ?? axiosModule;
const originalGet = axios.get;
const originalNow = Date.now;
const now = 1_700_000_000_000;
const m15 = 15 * 60_000;
const olderTime = now - 4 * 24 * 60 * 60_000;
const recentTime = Math.floor((now - m15) / m15) * m15;

function raw(time: number, close: number, complete = true) {
  return {
    time: new Date(time).toISOString(),
    complete,
    volume: 321,
    mid: { o: String(close - 1), h: String(close + 2), l: String(close - 2), c: String(close) },
  };
}

async function main(): Promise<void> {
  Date.now = () => now;
  let calls = 0;
  axios.get = (async (url: string, request?: { headers?: Record<string, string>; params?: Record<string, unknown> }) => {
    calls += 1;
    assert.ok(url.includes("/v3/accounts/test-account/instruments/XAU_USD/candles"));
    assert.equal(request?.headers?.Authorization, "Bearer test-token");
    assert.equal(request?.params?.granularity, "M15");
    if (request?.params?.to) {
      return { data: { candles: [raw(olderTime, 1_990)] } } as never;
    }
    return { data: { candles: [raw(recentTime, 2_000), raw(now, 2_001, false)] } } as never;
  }) as typeof axios.get;

  const { fetchOandaGoldM15, oandaCacheFilePath } = require("./oanda-fetch") as typeof import("./oanda-fetch");
  const first = await fetchOandaGoldM15(3);
  assert.equal(first.length, 1);
  assert.equal(first.at(-1)?.close, 2_000);
  assert.equal(first.at(-1)?.volume, 321);
  assert.equal(first.at(-1)?.quoteVolume, 321, "Chart phải giữ tick volume, không nhân với giá vàng");
  assert.ok(fs.existsSync(oandaCacheFilePath()));
  const callsAfterFirst = calls;
  const cached = await fetchOandaGoldM15(3);
  assert.equal(cached.length, 1);
  assert.equal(calls, callsAfterFirst, "Lần tải lại gần nhau phải dùng cache OANDA");
  const { buildChartPayload } = require("./chart-payload") as typeof import("./chart-payload");
  const payload = await buildChartPayload(3, "xauusd") as {
    venue: string;
    volumeUnit: string;
    candles: Array<{ q: number }>;
    botUniverse: Array<{ symbol: string; strategies: string[] }>;
    strategyAudit: { methods: string[] };
  };
  assert.equal(payload.venue, "OANDA");
  assert.equal(payload.volumeUnit, "ticks");
  assert.equal(payload.candles[0].q, 321);
  assert.deepEqual(payload.strategyAudit.methods, [], "XAUUSD không được tự đưa vào bot Turtle/Fast");
  assert.deepEqual(payload.botUniverse.find((item) => item.symbol === "XAUUSD")?.strategies, []);
  console.log(`OANDA candle/cache/tick-volume tests: OK (${calls} calls)`);
}

main().finally(() => {
  axios.get = originalGet;
  Date.now = originalNow;
  fs.rmSync(cacheDir, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
