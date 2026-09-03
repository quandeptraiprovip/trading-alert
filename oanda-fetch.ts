/**
 * Nến OANDA v20 cho chart read-only. XAUUSD ánh xạ sang XAU_USD, volume là tick volume.
 */
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import https from "https";
import path from "path";
import { Candle } from "./strategy";

const M15_MS = 15 * 60_000;
const MAX_PAGE = 5_000;
const CACHE_MAX_BARS = 220_000;
const CACHE_FRESH_MS = 5 * 60_000;
const CACHE_ENABLED = process.env.KLINE_CACHE !== "0";
const OANDA_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 2 });
const CACHE_DIR = path.resolve(
  process.env.OANDA_CACHE_DIR?.trim()
    || path.join(process.env.KLINE_CACHE_DIR?.trim() || path.join(process.cwd(), ".cache", "klines"), "oanda"),
);

type OandaMid = { o?: string; h?: string; l?: string; c?: string };
type OandaCandle = { time?: string; complete?: boolean; volume?: number; mid?: OandaMid };
type OandaResponse = { candles?: OandaCandle[]; errorMessage?: string; errorCode?: string };

let fileConfig: Record<string, string> | null = null;

function loadFileConfig(): Record<string, string> {
  if (fileConfig) return fileConfig;
  fileConfig = {};
  for (const name of [".env", ".env.local"]) {
    try {
      Object.assign(fileConfig, dotenv.parse(fs.readFileSync(path.join(process.cwd(), name))));
    } catch {
      /* file cấu hình là tuỳ chọn */
    }
  }
  return fileConfig;
}

function config(name: string): string {
  return String(process.env[name] || loadFileConfig()[name] || "").trim();
}

function connection(): { token: string; accountId: string; baseUrl: string } {
  const token = config("OANDA_API_TOKEN") || config("OANDA_TOKEN");
  const accountId = config("OANDA_ACCOUNT_ID");
  if (!token || !accountId) {
    throw new Error("Thiếu OANDA_API_TOKEN hoặc OANDA_ACCOUNT_ID để tải chart XAUUSD");
  }
  const environment = config("OANDA_ENV").toLowerCase();
  const baseUrl = config("OANDA_API_URL")
    || (environment === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com");
  return { token, accountId, baseUrl: baseUrl.replace(/\/$/, "") };
}

function parseCandles(value: unknown): Candle[] {
  const data = value as OandaResponse;
  if (!Array.isArray(data?.candles)) return [];
  return data.candles.flatMap((item) => {
    const openTime = Date.parse(String(item.time || ""));
    const open = Number(item.mid?.o);
    const high = Number(item.mid?.h);
    const low = Number(item.mid?.l);
    const close = Number(item.mid?.c);
    const volume = Number(item.volume);
    if (!item.complete || ![openTime, open, high, low, close, volume].every(Number.isFinite)) return [];
    return [{ openTime, open, high, low, close, volume, quoteVolume: volume }];
  });
}

function mergeCandles(a: Candle[], b: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const candle of a) byTime.set(candle.openTime, candle);
  for (const candle of b) byTime.set(candle.openTime, candle);
  return [...byTime.values()].sort((left, right) => left.openTime - right.openTime);
}

export function oandaCacheFilePath(): string {
  return path.join(CACHE_DIR, "xauusd_15m.json");
}

function readCache(): { candles: Candle[]; modifiedAt: number } {
  if (!CACHE_ENABLED) return { candles: [], modifiedAt: 0 };
  try {
    const target = oandaCacheFilePath();
    const candles = JSON.parse(fs.readFileSync(target, "utf8"));
    return {
      candles: Array.isArray(candles) ? candles : [],
      modifiedAt: fs.statSync(target).mtimeMs,
    };
  } catch {
    return { candles: [], modifiedAt: 0 };
  }
}

function writeCache(candles: Candle[]): void {
  if (!CACHE_ENABLED || !candles.length) return;
  try {
    const target = oandaCacheFilePath();
    const trimmed = candles.length > CACHE_MAX_BARS ? candles.slice(-CACHE_MAX_BARS) : candles;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(trimmed));
  } catch {
    /* cache best-effort */
  }
}

async function fetchPage(params: Record<string, string | number | boolean>): Promise<Candle[]> {
  const { token, accountId, baseUrl } = connection();
  const url = `${baseUrl}/v3/accounts/${encodeURIComponent(accountId)}/instruments/XAU_USD/candles`;
  try {
    const response = await axios.get<OandaResponse>(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Accept-Datetime-Format": "RFC3339",
      },
      params: { price: "M", granularity: "M15", smooth: false, ...params },
      httpsAgent: OANDA_HTTPS_AGENT,
      timeout: 30_000,
    });
    return parseCandles(response.data);
  } catch (error) {
    const response = (error as { response?: { status?: number; data?: OandaResponse } }).response;
    const detail = response?.data?.errorMessage || response?.data?.errorCode;
    throw new Error(`OANDA${response?.status ? ` HTTP ${response.status}` : ""}${detail ? `: ${detail}` : " không phản hồi"}`);
  }
}

async function fetchForward(candles: Candle[]): Promise<Candle[]> {
  let merged = candles;
  let cursor = candles.at(-1)?.openTime;
  for (let guard = 0; Number.isFinite(cursor) && guard < 100; guard += 1) {
    const batch = await fetchPage({ from: new Date(cursor as number).toISOString(), includeFirst: false, count: MAX_PAGE });
    if (!batch.length) break;
    const previous = cursor as number;
    merged = mergeCandles(merged, batch);
    cursor = batch.at(-1)?.openTime;
    if (!Number.isFinite(cursor) || (cursor as number) <= previous || batch.length < MAX_PAGE) break;
  }
  return merged;
}

export async function fetchOandaGoldM15(days: number): Promise<Candle[]> {
  const oldestNeeded = Date.now() - Math.max(1, days) * 24 * 60 * 60_000;
  const cached = readCache();
  let candles = cached.candles;

  if (candles.length && cached.modifiedAt > Date.now() - CACHE_FRESH_MS && candles[0].openTime <= oldestNeeded) {
    return candles.filter((candle) => candle.openTime >= oldestNeeded);
  }

  if (!candles.length) {
    candles = await fetchPage({ count: MAX_PAGE });
  } else if (Date.now() - Number(candles.at(-1)?.openTime) >= M15_MS * 2) {
    candles = await fetchForward(candles);
  }

  for (let guard = 0; candles.length && candles[0].openTime > oldestNeeded && guard < 100; guard += 1) {
    const previousOldest = candles[0].openTime;
    const older = await fetchPage({ to: new Date(previousOldest).toISOString(), count: MAX_PAGE });
    if (!older.length) break;
    candles = mergeCandles(older, candles);
    if (candles[0].openTime >= previousOldest) break;
  }

  if (!candles.length) throw new Error("OANDA không trả về nến XAU_USD hoàn chỉnh");
  writeCache(candles);
  return candles.filter((candle) => candle.openTime >= oldestNeeded);
}
