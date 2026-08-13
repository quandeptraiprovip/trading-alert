/**
 * turtle-live-order.ts — chứng minh TRỰC TIẾP rằng lớp LIVE đã bất biến thứ tự symbol.
 *
 * `turtle-live-parity.ts` chứng minh live khớp engine ở MỘT thứ tự symbol. Đó là điều kiện cần
 * nhưng chưa đủ: thứ đang sửa (2026-08-13) chính là sự phụ thuộc vào thứ tự, nên phải chạy live hai
 * lần với hai thứ tự khác nhau và đối chiếu TỈ TRỌNG RISK từng unit. Trước khi sửa, `heatWeight` đọc
 * sổ tức thời nên symbol đứng trước gặp sổ vắng hơn ⇒ hai lần chạy phải cho weight khác nhau. Sau
 * khi sửa (ảnh chụp heat đầu nến) hai lần chạy phải TRÙNG KHÍT.
 *
 * AN TOÀN: giống parity — không import `load-env`, không key, api/trader = null, telegram tắt,
 * state/journal ghi vào thư mục tạm (chdir TRƯỚC khi import turtle-live).
 *
 * Run: ./node_modules/.bin/ts-node scripts/turtle-live-order.ts [soNếnKiểmTra]
 */
import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "turtle-order-"));
process.chdir(SANDBOX);

/* eslint-disable @typescript-eslint/no-var-requires */
const { TurtleLive } = require(path.join(REPO, "turtle-live")) as typeof import("../turtle-live");
const { T } = require(path.join(REPO, "turtle")) as typeof import("../turtle");
const { fetchKlinesPaged } = require(path.join(REPO, "kline-fetch")) as typeof import("../kline-fetch");
const { BASKET } = require(path.join(REPO, "scripts", "portfolio-equivalence")) as typeof import("./portfolio-equivalence");
/* eslint-enable */

type Candle = import("../strategy").Candle;

/** Chạy live ở chế độ giấy với một thứ tự symbol; trả về weight từng unit theo khoá symbol|dir|time. */
async function runOrder(symbols: string[], data: Map<string, Candle[]>, minLen: number, steps: number) {
  const start = minLen - steps;
  // MỖI LẦN CHẠY PHẢI BẮT ĐẦU SẠCH. `TurtleLive` persist state vào cwd; nếu không xoá thì lần chạy
  // thứ hai nạp lại state của lần đầu (lastBarTime đã ở cuối) và sinh ra 0 unit — đúng cái bẫy đã
  // ghi trong oracle-deployment: state cũ làm replay hiểu sai lịch sử.
  for (const f of ["turtle-state.json", "turtle-trades.jsonl"]) {
    try { fs.unlinkSync(path.join(process.cwd(), f)); } catch { /* chưa có thì thôi */ }
  }
  const live: any = new TurtleLive({
    symbols,
    api: null,
    trader: null,
    telegram: { enabled: false, botToken: "", chatId: "" },
    riskPct: 0.01,
    maxPortfolioRiskPct: 0.2,
    leverage: 10,
    isTradingReady: () => false,
    otherHoldsSymbol: () => false,
    otherOpenRiskFrac: () => 0,
  } as any);
  live.loadState();

  const seen = new Map<string, number>();
  const origOpen = live.openPosition.bind(live);
  const origAdd = live.addUnit.bind(live);
  live.openPosition = async (st: any, candles: Candle[], i: number, dir: string, ...rest: any[]) => {
    const before = st.pos;
    const r = await origOpen(st, candles, i, dir, ...rest);
    if (!before && st.pos) seen.set(`${st.symbol}|${dir}|${candles[i].openTime}`, st.pos.units[0].weight ?? 1);
    return r;
  };
  // Chữ ký THẬT là (st, pos, candles, i, …) — thiếu `pos` sẽ làm lệch mọi tham số một bậc.
  live.addUnit = async (st: any, pos: any, candles: Candle[], i: number, ...rest: any[]) => {
    const n = pos.units.length;
    const r = await origAdd(st, pos, candles, i, ...rest);
    if (pos.units.length > n) {
      const u = pos.units[pos.units.length - 1];
      seen.set(`${st.symbol}|${pos.dir}|${candles[i].openTime}|u${pos.units.length}`, u.weight ?? 1);
    }
    return r;
  };

  let cursor = start;
  live.fetchClosed = async (symbol: string) => data.get(symbol)!.slice(0, cursor);
  await live.cycle(true);
  seen.clear(); // bỏ phần replay im lặng, giống parity
  for (cursor = start + 1; cursor <= minLen; cursor++) await live.cycle(false);
  return seen;
}

async function main() {
  const steps = parseInt(process.argv[2] ?? "600", 10);
  const bars = 700 + steps + Math.round(T.btcGateSlow);
  const data = new Map<string, Candle[]>();
  for (const s of BASKET) data.set(s, await fetchKlinesPaged(s, T.tf, bars));
  const minLen = Math.min(...[...data.values()].map((c) => c.length));
  if (minLen - steps < 700) throw new Error(`không đủ nến (minLen=${minLen})`);

  const orders: [string, string[]][] = [
    ["gốc", [...BASKET]],
    ["đảo", [...BASKET].reverse()],
    ["abc", [...BASKET].sort((a, b) => a.localeCompare(b))],
  ];

  const runs: [string, Map<string, number>][] = [];
  for (const [tag, syms] of orders) {
    // console.log của live rất dài; nuốt bớt cho bảng dễ đọc.
    const log = console.log;
    console.log = () => {};
    const r = await runOrder(syms, data, minLen, steps);
    console.log = log;
    runs.push([tag, r]);
    console.log(`thứ tự ${tag.padEnd(5)} → ${r.size} unit`);
  }

  const base = runs[0][1];
  let worstDiff = 0, mismatch = 0, missing = 0;
  for (const [tag, r] of runs.slice(1)) {
    for (const [k, w] of base) {
      if (!r.has(k)) { if (missing < 5) console.log(`  ✗ thứ tự ${tag} thiếu ${k}`); missing++; continue; }
      const d = Math.abs(r.get(k)! - w);
      if (d > 1e-9) {
        if (mismatch < 5) console.log(`  ✗ ${tag} lệch weight ${k}: ${r.get(k)!.toFixed(6)} vs ${w.toFixed(6)}`);
        mismatch++;
      }
      worstDiff = Math.max(worstDiff, d);
    }
    for (const k of r.keys()) if (!base.has(k)) { if (missing < 5) console.log(`  ✗ thứ tự ${tag} thừa ${k}`); missing++; }
  }

  console.log(`\nlệch weight ${mismatch} · thiếu/thừa ${missing} · sai số lớn nhất ${worstDiff.toExponential(2)}`);
  console.log(
    mismatch === 0 && missing === 0
      ? "✅ LIVE BẤT BIẾN THỨ TỰ SYMBOL — tỉ trọng risk trùng khít ở cả 3 thứ tự."
      : "❌ live VẪN phụ thuộc thứ tự symbol.",
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
