/**
 * Current tradability scanner for the research-only Alt Trend engine.
 *
 * Run:
 *   ./node_modules/.bin/ts-node scripts/alt-universe-scanner.ts [plannedNotionalUsd=100] [maxSymbols=80] [--save]
 *
 * A saved snapshot is forward data. It must not be treated as historical proof.
 */
import axios from "axios";
import fs from "fs";
import path from "path";
import {
  AdlRisk,
  TradabilitySnapshot,
  evaluateTradability,
} from "../alt-trend";

const BASE_URL = "https://fapi.binance.com";
const DEPTH_BPS = 20;
const CONCURRENCY = 5;

type ExchangeSymbol = {
  symbol: string;
  contractType: string;
  status: string;
  quoteAsset: string;
  onboardDate: number;
};

type Ticker = {
  symbol: string;
  quoteVolume: string;
  lastPrice: string;
};

type BookTicker = {
  symbol: string;
  bidPrice: string;
  askPrice: string;
};

type Depth = { bids: [string, string][]; asks: [string, string][] };

async function get<T>(url: string, params: Record<string, string | number> = {}): Promise<T> {
  const response = await axios.get<T>(`${BASE_URL}${url}`, { params, timeout: 20_000 });
  return response.data;
}

function depthUsd(levels: [string, string][], mid: number, side: "bid" | "ask"): number {
  const boundary = side === "bid" ? mid * (1 - DEPTH_BPS / 10_000) : mid * (1 + DEPTH_BPS / 10_000);
  let total = 0;
  for (const [priceRaw, qtyRaw] of levels) {
    const price = Number(priceRaw);
    const qty = Number(qtyRaw);
    if (side === "bid" && price < boundary) continue;
    if (side === "ask" && price > boundary) continue;
    total += price * qty;
  }
  return total;
}

async function adlRisk(symbol: string): Promise<AdlRisk> {
  try {
    const raw = await get<{ adlRisk?: string } | Array<{ symbol: string; adlRisk?: string }>>(
      "/fapi/v1/symbolAdlRisk",
      { symbol },
    );
    const value = Array.isArray(raw) ? raw.find((row) => row.symbol === symbol)?.adlRisk : raw.adlRisk;
    return value === "low" || value === "medium" || value === "high" ? value : "unknown";
  } catch {
    return "unknown";
  }
}

async function inspect(
  symbol: ExchangeSymbol,
  ticker: Ticker,
  book: BookTicker,
  observedAt: number,
): Promise<TradabilitySnapshot> {
  const bid = Number(book.bidPrice);
  const ask = Number(book.askPrice);
  const mid = (bid + ask) / 2;
  const [depth, openInterest, risk] = await Promise.all([
    get<Depth>("/fapi/v1/depth", { symbol: symbol.symbol, limit: 100 }),
    get<{ openInterest: string }>("/fapi/v1/openInterest", { symbol: symbol.symbol }),
    adlRisk(symbol.symbol),
  ]);
  return {
    symbol: symbol.symbol.toLowerCase(),
    onboardDate: symbol.onboardDate,
    observedAt,
    quoteVolume24h: Number(ticker.quoteVolume),
    bid,
    ask,
    bidDepth20Bps: depthUsd(depth.bids, mid, "bid"),
    askDepth20Bps: depthUsd(depth.asks, mid, "ask"),
    openInterestValue: Number(openInterest.openInterest) * Number(ticker.lastPrice),
    adlRisk: risk,
  };
}

async function main(): Promise<void> {
  const plannedNotionalUsd = Number(process.argv[2] ?? 100);
  const maxSymbols = Number(process.argv[3] ?? 80);
  const save = process.argv.includes("--save");
  if (!(plannedNotionalUsd > 0) || !(maxSymbols > 0)) {
    throw new Error("plannedNotionalUsd và maxSymbols phải > 0");
  }

  const observedAt = Date.now();
  const [exchange, tickers, books] = await Promise.all([
    get<{ symbols: ExchangeSymbol[] }>("/fapi/v1/exchangeInfo"),
    get<Ticker[]>("/fapi/v1/ticker/24hr"),
    get<BookTicker[]>("/fapi/v1/ticker/bookTicker"),
  ]);
  const tickerBy = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
  const bookBy = new Map(books.map((book) => [book.symbol, book]));
  const prelim = exchange.symbols
    .filter((symbol) => symbol.contractType === "PERPETUAL")
    .filter((symbol) => symbol.status === "TRADING" && symbol.quoteAsset === "USDT")
    .filter((symbol) => tickerBy.has(symbol.symbol) && bookBy.has(symbol.symbol))
    .sort((a, b) => Number(tickerBy.get(b.symbol)!.quoteVolume) - Number(tickerBy.get(a.symbol)!.quoteVolume))
    .slice(0, maxSymbols);

  const snapshots: TradabilitySnapshot[] = [];
  for (let i = 0; i < prelim.length; i += CONCURRENCY) {
    const batch = prelim.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((symbol) => inspect(
      symbol,
      tickerBy.get(symbol.symbol)!,
      bookBy.get(symbol.symbol)!,
      observedAt,
    )));
    for (const result of results) {
      if (result.status === "fulfilled") snapshots.push(result.value);
      else console.warn(`[Alt scanner] bỏ snapshot lỗi: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
    }
  }

  const rows = snapshots.map((snapshot) => ({
    snapshot,
    result: evaluateTradability(snapshot, plannedNotionalUsd),
  })).sort((a, b) => b.result.capacityUsd - a.result.capacityUsd);
  const eligible = rows.filter((row) => row.result.eligible);

  console.log(`\nALT UNIVERSE SCANNER | notional $${plannedNotionalUsd.toFixed(0)} | ${new Date(observedAt).toISOString()}`);
  console.log("symbol       age    spread   depth20bp       OI$      vol24h$  capacity$  ADL");
  console.log("-".repeat(92));
  for (const { snapshot, result } of eligible) {
    const depth = Math.min(snapshot.bidDepth20Bps, snapshot.askDepth20Bps);
    console.log(
      `${snapshot.symbol.toUpperCase().padEnd(12)}`
      + `${result.listingAgeDays.toFixed(0).padStart(5)}d `
      + `${result.spreadBps.toFixed(2).padStart(8)}bp `
      + `${depth.toFixed(0).padStart(11)} `
      + `${snapshot.openInterestValue.toFixed(0).padStart(10)} `
      + `${snapshot.quoteVolume24h.toFixed(0).padStart(12)} `
      + `${result.capacityUsd.toFixed(0).padStart(9)}  ${snapshot.adlRisk}`,
    );
  }
  console.log("-".repeat(92));
  console.log(`PASS ${eligible.length}/${rows.length} inspected`);
  console.log(`symbols=${eligible.map((row) => row.snapshot.symbol).join(",")}`);

  if (save) {
    const day = new Date(observedAt).toISOString().slice(0, 10);
    const dir = path.join(process.cwd(), ".cache", "alt-trend", "universe");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${day}.json`);
    fs.writeFileSync(target, JSON.stringify({ observedAt, plannedNotionalUsd, rows }, null, 2));
    console.log(`saved=${target}`);
  }
}

main().catch((error) => {
  console.error("Alt scanner lỗi:", error?.response?.data ?? error.message);
  process.exit(1);
});
