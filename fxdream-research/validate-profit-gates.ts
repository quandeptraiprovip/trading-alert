/**
 * Kiểm tra các gate kinh tế đơn giản trên đúng chuỗi lệnh V7 đã audit.
 *
 * Mục tiêu không phải grid-search để làm đẹp in-sample. Các gate dưới đây được
 * đăng ký trước từ hai ràng buộc có lý do:
 *   1. Không sửa/nới structural stop; bỏ lệnh nếu chi phí quy đổi sang R quá lớn.
 *   2. Video ưu tiên phiên có thanh khoản, nên kiểm tra riêng cửa sổ Mỹ 12–22 UTC.
 *
 * Run: ./node_modules/.bin/ts-node fxdream-research/validate-profit-gates.ts [days]
 */
import { median } from "./strategy-engine-v2";
import { Flags, Trade, load, runSymbol } from "./measure-live-path";

const SYMBOLS = (process.env.FXDREAM_VALIDATE_SYMBOLS ?? "BTCUSDT,SOLUSDT,XRPUSDT,DOGEUSDT")
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
const FRICTIONS = [0.0014, 0.0009, 0.0002] as const;

const V7: Flags = {
  label: "V7 audited",
  noLookahead: true,
  keyAtClose: true,
  strictEngulf: true,
  strictSweep: true,
  strictDailyGate: true,
  noStopFloor: true,
  requireHeadroom: true,
  trailH1: false,
  requireSecondTouch: false,
};

interface Candidate {
  label: string;
  accept: (trade: Trade) => boolean;
}

function utcHour(time: number): number {
  return new Date(time).getUTCHours();
}

function costR(trade: Trade, friction: number): number {
  return friction / trade.stopPct;
}

function stats(trades: Trade[], friction: number) {
  const ordered = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const gross = ordered.reduce((sum, trade) => sum + trade.grossR, 0);
  const net = ordered.reduce((sum, trade) => sum + trade.grossR - costR(trade, friction), 0);
  const wins = ordered.filter((trade) => trade.grossR > 0).length;
  const grossWins = ordered.reduce((sum, trade) => sum + Math.max(0, trade.grossR), 0);
  const grossLosses = -ordered.reduce((sum, trade) => sum + Math.min(0, trade.grossR), 0);
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const trade of ordered) {
    equity += trade.grossR - costR(trade, friction);
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }
  return {
    n: ordered.length,
    wr: ordered.length ? wins / ordered.length : 0,
    gross,
    net,
    netPerTrade: ordered.length ? net / ordered.length : 0,
    pf: grossLosses > 0 ? grossWins / grossLosses : 0,
    maxDD,
    medianStop: median(ordered.map((trade) => trade.stopPct)),
  };
}

function fmt(label: string, trades: Trade[], friction: number): string {
  const s = stats(trades, friction);
  return (
    label.padEnd(28) +
    String(s.n).padStart(6) +
    `${(s.wr * 100).toFixed(0)}%`.padStart(6) +
    s.gross.toFixed(1).padStart(9) +
    s.net.toFixed(1).padStart(9) +
    s.netPerTrade.toFixed(3).padStart(9) +
    s.pf.toFixed(2).padStart(7) +
    s.maxDD.toFixed(1).padStart(8) +
    `${(s.medianStop * 100).toFixed(3)}%`.padStart(10)
  );
}

async function main() {
  const days = parseInt(process.argv[2] ?? "730", 10);
  let trades: Trade[] = [];
  for (const symbol of SYMBOLS) {
    const data = await load(symbol, days);
    trades = trades.concat(runSymbol(data, V7).trades);
  }
  trades.sort((a, b) => a.entryTime - b.entryTime);
  if (trades.length < 2) throw new Error("Không đủ lệnh để kiểm định");

  const first = trades[0].entryTime;
  const last = trades[trades.length - 1].entryTime;
  const split = first + (last - first) * 0.5;

  const candidates: Candidate[] = [
    { label: "Không gate", accept: () => true },
    ...SYMBOLS.map((symbol) => ({
      label: symbol.replace("USDT", "") + " only",
      accept: (trade: Trade) => trade.symbol === symbol,
    })),
    { label: "Long only", accept: (trade) => trade.dir === "long" },
    { label: "Short only", accept: (trade) => trade.dir === "short" },
    {
      label: "Chi phí <= 0.20R",
      accept: (trade) => costR(trade, 0.0014) <= 0.2,
    },
    {
      label: "Chi phí <= 0.15R",
      accept: (trade) => costR(trade, 0.0014) <= 0.15,
    },
    {
      label: "Chi phí <= 0.10R",
      accept: (trade) => costR(trade, 0.0014) <= 0.1,
    },
    {
      label: "Phiên Mỹ 12–22 UTC",
      accept: (trade) => utcHour(trade.entryTime) >= 12 && utcHour(trade.entryTime) < 22,
    },
    {
      label: "Mỹ + chi phí <= 0.15R",
      accept: (trade) =>
        utcHour(trade.entryTime) >= 12 &&
        utcHour(trade.entryTime) < 22 &&
        costR(trade, 0.0014) <= 0.15,
    },
  ];

  console.log(`\n${days} ngày · ${trades.length} lệnh V7 · split ${new Date(split).toISOString().slice(0, 10)}`);
  console.log("n, WR và Gross dùng cùng chuỗi lệnh; Net tính lại theo ma sát ghi ở từng bảng.");

  for (const friction of FRICTIONS) {
    console.log(`\nMa sát khứ hồi ${(friction * 100).toFixed(3)}%`);
    console.log(
      "candidate".padEnd(28) +
        "n".padStart(6) +
        "WR".padStart(6) +
        "Gross".padStart(9) +
        "Net".padStart(9) +
        "Net/T".padStart(9) +
        "PF".padStart(7) +
        "maxDD".padStart(8) +
        "SL med".padStart(10),
    );
    for (const candidate of candidates) {
      const accepted = trades.filter(candidate.accept);
      const train = accepted.filter((trade) => trade.entryTime < split);
      const holdout = accepted.filter((trade) => trade.entryTime >= split);
      console.log(fmt(`${candidate.label} train`, train, friction));
      console.log(fmt(`${candidate.label} holdout`, holdout, friction));
    }
  }
}

main().catch((error) => {
  console.error("Lỗi:", error?.response?.data ?? error);
  process.exit(1);
});
