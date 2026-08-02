/**
 * turtle-overfit-ablation.ts — Turtle production đang lãi nhờ CƠ CHẾ hay nhờ TINH CHỈNH?
 *
 * Logic: nếu bỏ từng thành phần đã được "chọn trên dữ liệu" mà kết quả sụp đổ ⇒ mong manh/overfit.
 * Nếu bản NGÂY THƠ (Donchian 20/20 cổ điển, không gate, không pyramid, không OB stop) cũng lãi rõ
 * ⇒ edge nằm ở trend-following, phần tinh chỉnh chỉ là trang trí và rủi ro overfit bị chặn trên.
 *
 * Cùng cost model production (Binance 0,05% taker + 0,02% slippage/chiều + funding 0,01%/8h).
 *
 * Run: ./node_modules/.bin/ts-node scripts/turtle-overfit-ablation.ts [soNgay]
 */
import { Candle, TF_MS } from "../strategy";
import { fetchKlinesPaged } from "../kline-fetch";
import { T, runTurtle, buildBtcGateLongs, Trade, TurtleParams } from "../turtle";

const PROD_BASKET = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "adausdt", "avaxusdt", "dotusdt"];
const OLD_BASKET = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "adausdt", "avaxusdt", "bnbusdt"];

const net = (ts: Trade[]) => ts.reduce((s, t) => s + t.netR, 0);
const fmt = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(0);

/** Gộp unit thành vị thế để đếm "lệnh" theo nghĩa người dùng. */
function positions(ts: Trade[]): number {
  return new Set(ts.map((t) => `${t.symbol}|${t.dir}|${t.exitTime}`)).size;
}

async function main(): Promise<void> {
  const DAYS = parseInt(process.argv[2] ?? "1050", 10);
  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const totalBars = Math.ceil(DAYS * bpd) + T.btcGateSlow + 50;
  const all = [...new Set([...PROD_BASKET, ...OLD_BASKET])];

  console.log(`Fetch ~${DAYS}d × ${all.length} symbol @ ${T.tf}...`);
  const data = new Map<string, Candle[]>();
  for (const s of all) data.set(s, await fetchKlinesPaged(s, T.tf, totalBars));
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);

  const btc = data.get("btcusdt")!;
  const warmup = Math.max(Math.round(30 * bpd), T.trendLen, T.atrPeriod, T.btcGateSlow) + 1;
  const t0 = btc[warmup].openTime;
  const tEnd = btc[btc.length - 1].openTime;
  const span = tEnd - t0;
  const eraEnd = [t0 + span / 3, t0 + (2 * span) / 3, Infinity];
  const y1 = tEnd - 365 * 86_400_000;
  const d180 = tEnd - 180 * 86_400_000;
  const LIVE_FROM = Date.parse("2026-07-23T00:00:00Z"); // Turtle bắt đầu có lệnh thật trên Binance

  const variants: Array<[string, Partial<TurtleParams>, string[]]> = [
    ["PRODUCTION (đang chạy)", {}, PROD_BASKET],
    ["– bỏ BTC gate", { btcGateSlow: 0 }, PROD_BASKET],
    ["– bỏ pyramid (1 unit)", { pyramidMaxUnits: 1 }, PROD_BASKET],
    ["– bỏ OB stop (3×ATR)", { initialStopObLookback: 0 }, PROD_BASKET],
    ["– long 20d thay vì 15d", { entryDays: 20 }, PROD_BASKET],
    ["– short 20d thay vì 30d", { shortEntryDays: 20 }, PROD_BASKET],
    ["– rổ CŨ (BNB thay DOT)", {}, OLD_BASKET],
    ["NGÂY THƠ Donchian 20/20", {
      entryDays: 20, shortEntryDays: 0,
      longEntrySource: "high", shortEntrySource: "low",
      longExitMode: "chandelier", shortExitMode: "chandelier",
      initialStopObLookback: 0, pyramidMaxUnits: 1, btcGateSlow: 0,
    }, PROD_BASKET],
    ["NGÂY THƠ + bỏ luôn EMA", {
      entryDays: 20, shortEntryDays: 0,
      longEntrySource: "high", shortEntrySource: "low",
      longExitMode: "chandelier", shortExitMode: "chandelier",
      initialStopObLookback: 0, pyramidMaxUnits: 1, btcGateSlow: 0, trendLen: 2,
    }, PROD_BASKET],
  ];

  console.log("\n" + "biến thể".padEnd(26) + "lệnh".padStart(6) + "NET".padStart(8) + "exp".padStart(7)
    + "EraA".padStart(8) + "EraB".padStart(8) + "EraC".padStart(8) + "365d".padStart(8) + "180d".padStart(8) + "live11d".padStart(9));
  console.log("-".repeat(96));

  for (const [name, override, basket] of variants) {
    const p: TurtleParams = { ...T, ...override, gate: (override.btcGateSlow === 0 ? undefined : gate) };
    const ts: Trade[] = [];
    for (const s of basket) ts.push(...runTurtle(s, data.get(s)!, p).filter((t) => t.entryTime >= t0));
    const nPos = positions(ts);
    const eras = [0, 1, 2].map((i) =>
      net(ts.filter((t) => t.entryTime >= (i === 0 ? t0 : eraEnd[i - 1]) && t.entryTime < eraEnd[i])));
    console.log(
      name.padEnd(26)
      + String(nPos).padStart(6)
      + fmt(net(ts)).padStart(8)
      + (net(ts) / nPos).toFixed(2).padStart(7)
      + fmt(eras[0]).padStart(8) + fmt(eras[1]).padStart(8) + fmt(eras[2]).padStart(8)
      + fmt(net(ts.filter((t) => t.entryTime >= y1))).padStart(8)
      + fmt(net(ts.filter((t) => t.entryTime >= d180))).padStart(8)
      + fmt(net(ts.filter((t) => t.entryTime >= LIVE_FROM))).padStart(8));
  }

  console.log("-".repeat(96));
  console.log(`Cửa sổ ${new Date(t0).toISOString().slice(0, 10)} → ${new Date(tEnd).toISOString().slice(0, 10)}`
    + ` · era ≈ ${Math.round(span / 3 / 86_400_000)}d/era · exp = NET R mỗi VỊ THẾ`);
}

main().catch((e) => { console.error(e?.response?.data ?? e.message); process.exit(1); });
