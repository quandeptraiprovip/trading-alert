const fs = require("fs");

const cache = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const raw = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const api = new Map(raw.map((k) => [Number(k[0]), {
  open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
  volume: Number(k[5]), quoteVolume: Number(k[7]), takerBuyVolume: Number(k[9]),
}]));

const fields = ["open", "high", "low", "close", "volume", "quoteVolume", "takerBuyVolume"];
const compared = cache.filter((c) => api.has(c.openTime));
const mismatches = compared.filter((c) => fields.some((f) => Math.abs(c[f] - api.get(c.openTime)[f]) > 1e-9));
const ohlcMismatch = compared.filter((c) => ["open", "high", "low", "close"].some((f) => Math.abs(c[f] - api.get(c.openTime)[f]) > 1e-9));
const volumeOnly = mismatches.filter((c) => !ohlcMismatch.includes(c));

console.log(JSON.stringify({
  compared: compared.length,
  exact: compared.length - mismatches.length,
  mismatches: mismatches.length,
  ohlcMismatch: ohlcMismatch.length,
  volumeOnly: volumeOnly.length,
  mismatchTimes: mismatches.slice(0, 30).map((c) => new Date(c.openTime).toISOString()),
  lastMismatch: mismatches.length ? new Date(mismatches[mismatches.length - 1].openTime).toISOString() : null,
}, null, 2));
