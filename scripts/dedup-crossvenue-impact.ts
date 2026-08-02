/**
 * dedup-crossvenue-impact.ts — Đo tác động của khắc phục A1 (khử trùng lặp XUYÊN SÀN) lên Net R.
 *
 * A1: Fast/MEXC KHÔNG mở vị thế nếu lớp Binance (Turtle) đang giữ cùng symbol + cùng hướng.
 * Câu hỏi: Net R danh mục gộp TRƯỚC và SAU khi áp rule.
 *
 * Giao thức khớp audit 2026-08: 8 symbol 4h, cửa sổ 1.050 ngày, Turtle cost Binance (taker 0,05%),
 * Fast cost MEXC (taker 0,08%), cả hai + slippage 0,02%/chiều và funding 0,01%/8h.
 *
 * XẤP XỈ ĐÃ BIẾT: runTurtle không mô hình được "chờ 1 nến 4h xác nhận" của Fast SHORT, nên nhánh
 * Fast ở đây = biến thể "không chờ xác nhận" (audit đo +246,7R vs +243,7R của bản có xác nhận).
 * Sai lệch này áp DỤNG NHƯ NHAU cho cả trước lẫn sau nên không bóp méo delta.
 *
 * Run: ./node_modules/.bin/ts-node scripts/dedup-crossvenue-impact.ts [soNgay]
 */
import { Candle, CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged } from "../kline-fetch";
import { T, runTurtle, buildBtcGateLongs, Trade, TurtleParams } from "../turtle";

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "adausdt", "avaxusdt", "dotusdt"];

interface Position {
  symbol: string;
  dir: "long" | "short";
  entryTime: number;
  exitTime: number;
  netR: number;
  units: number;
}

/** Gộp unit cùng symbol+exitTime thành 1 vị thế (pyramid units chia chung exit). */
function toPositions(trades: Trade[]): Position[] {
  const map = new Map<string, Position>();
  for (const t of trades) {
    const k = `${t.symbol}|${t.dir}|${t.exitTime}`;
    const cur = map.get(k);
    if (cur) {
      cur.netR += t.netR;
      cur.units += 1;
      cur.entryTime = Math.min(cur.entryTime, t.entryTime);
    } else {
      map.set(k, { symbol: t.symbol, dir: t.dir, entryTime: t.entryTime, exitTime: t.exitTime, netR: t.netR, units: 1 });
    }
  }
  return [...map.values()].sort((a, b) => a.entryTime - b.entryTime);
}

/** maxDD trên đường equity R, xếp theo thời điểm ĐÓNG lệnh. */
function maxDrawdownR(positions: Position[]): number {
  let peak = 0, equity = 0, dd = 0;
  for (const p of [...positions].sort((a, b) => a.exitTime - b.exitTime)) {
    equity += p.netR;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  return dd;
}

const sum = (ps: Position[]) => ps.reduce((s, p) => s + p.netR, 0);
const fmt = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1) + "R";

async function main(): Promise<void> {
  const DAYS = parseInt(process.argv[2] ?? "1050", 10);
  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const totalBars = Math.ceil(DAYS * bpd) + T.btcGateSlow + 50;

  console.log(`Fetch ~${DAYS}d × ${SYMBOLS.length} symbol @ ${T.tf}...`);
  const data = new Map<string, Candle[]>();
  for (const s of SYMBOLS) data.set(s, await fetchKlinesPaged(s, T.tf, totalBars));
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);

  const warmup = Math.max(Math.round(30 * bpd), T.trendLen, T.atrPeriod, T.btcGateSlow) + 1;
  const t0 = data.get("btcusdt")![warmup].openTime;

  const baseTaker = CONFIG.costs.takerFeePct;

  // ── Sleeve TURTLE (Binance) — config production ────────────────────────────
  CONFIG.costs.takerFeePct = 0.05;
  const turtleParams: TurtleParams = { ...T, gate };
  const turtleTrades: Trade[] = [];
  for (const [s, c] of data) turtleTrades.push(...runTurtle(s, c, turtleParams).filter((t) => t.entryTime >= t0));
  const turtlePos = toPositions(turtleTrades);

  // ── Sleeve FAST (MEXC) — long high-10d, short close-30d, Chandelier hai chiều ─
  CONFIG.costs.takerFeePct = 0.08;
  const fastParams: TurtleParams = {
    ...T,
    entryDays: 10,
    longEntrySource: "high",
    longExitMode: "chandelier",
    shortEntryDays: 30,
    shortEntrySource: "close",
    shortExitMode: "chandelier",
    initialStopObLookback: 0, // Fast dùng SL = chandelierMult×ATR, không dùng OB cấu trúc
    gate,
  };
  const fastTrades: Trade[] = [];
  for (const [s, c] of data) fastTrades.push(...runTurtle(s, c, fastParams).filter((t) => t.entryTime >= t0));
  const fastPos = toPositions(fastTrades);
  CONFIG.costs.takerFeePct = baseTaker;

  // ── Áp rule A1: Fast bỏ entry nếu Turtle đang giữ cùng symbol + cùng hướng ──
  const held = new Map<string, Array<[number, number]>>();
  for (const p of turtlePos) {
    const k = `${p.symbol}|${p.dir}`;
    if (!held.has(k)) held.set(k, []);
    held.get(k)!.push([p.entryTime, p.exitTime]);
  }
  const blockedBy = (p: Position, includeSameBar: boolean): boolean =>
    (held.get(`${p.symbol}|${p.dir}`) ?? []).some(([a, b]) =>
      includeSameBar ? p.entryTime >= a && p.entryTime < b : p.entryTime > a && p.entryTime < b);

  for (const sameBar of [true, false]) {
    const kept = fastPos.filter((p) => !blockedBy(p, sameBar));
    const dropped = fastPos.filter((p) => blockedBy(p, sameBar));
    const beforeNet = sum(turtlePos) + sum(fastPos);
    const afterNet = sum(turtlePos) + sum(kept);
    const beforeDD = maxDrawdownR([...turtlePos, ...fastPos]);
    const afterDD = maxDrawdownR([...turtlePos, ...kept]);

    console.log("\n" + "=".repeat(78));
    console.log(`  A1 — trùng cùng NẾN ${sameBar ? "TÍNH LÀ TRÙNG (Turtle ưu tiên)" : "KHÔNG tính là trùng"}`);
    console.log("=".repeat(78));
    console.log(`  Turtle (không đổi) : ${fmt(sum(turtlePos))}  · ${turtlePos.length} vị thế`);
    console.log(`  Fast TRƯỚC A1      : ${fmt(sum(fastPos))}  · ${fastPos.length} vị thế`);
    console.log(`  Fast SAU A1        : ${fmt(sum(kept))}  · ${kept.length} vị thế giữ lại`);
    console.log(`  Fast bị CHẶN       : ${fmt(sum(dropped))}  · ${dropped.length} vị thế (${(dropped.length / fastPos.length * 100).toFixed(1)}% số lệnh Fast)`);
    console.log(`  ─────────────────────────────────────────────`);
    console.log(`  NET R gộp TRƯỚC    : ${fmt(beforeNet)}   · maxDD ${beforeDD.toFixed(1)}R`);
    console.log(`  NET R gộp SAU      : ${fmt(afterNet)}   · maxDD ${afterDD.toFixed(1)}R`);
    console.log(`  Δ NET              : ${fmt(afterNet - beforeNet)} (${((afterNet / beforeNet - 1) * 100).toFixed(1)}%)`);
    console.log(`  Δ maxDD            : ${(afterDD - beforeDD).toFixed(1)}R (${((afterDD / beforeDD - 1) * 100).toFixed(1)}%)`);
    console.log(`  NET/maxDD TRƯỚC    : ${(beforeNet / beforeDD).toFixed(2)}   SAU: ${(afterNet / afterDD).toFixed(2)}`);
  }

  // ── Fast có đáng chạy không: so với việc CHỈ phóng to Turtle cho bằng NET ──
  const turtleNet = sum(turtlePos), turtleDD = maxDrawdownR(turtlePos);
  const combinedNet = turtleNet + sum(fastPos), combinedDD = maxDrawdownR([...turtlePos, ...fastPos]);
  const scale = combinedNet / turtleNet;
  console.log("\n" + "=".repeat(78));
  console.log("  Fast có thêm giá trị gì so với việc CHỈ tăng size Turtle?");
  console.log("=".repeat(78));
  console.log(`  Turtle một mình            : ${fmt(turtleNet)} · maxDD ${turtleDD.toFixed(1)}R · NET/DD ${(turtleNet / turtleDD).toFixed(2)}`);
  console.log(`  Turtle + Fast (hiện tại)   : ${fmt(combinedNet)} · maxDD ${combinedDD.toFixed(1)}R · NET/DD ${(combinedNet / combinedDD).toFixed(2)}`);
  console.log(`  Turtle ×${scale.toFixed(2)} (bằng NET)      : ${fmt(turtleNet * scale)} · maxDD ${(turtleDD * scale).toFixed(1)}R · NET/DD ${(turtleNet / turtleDD).toFixed(2)}`);
  console.log(`  ⇒ để đạt cùng NET, Fast tốn maxDD ${combinedDD.toFixed(1)}R còn phóng to Turtle tốn ${(turtleDD * scale).toFixed(1)}R`);

  console.log(`\n  Cửa sổ: ${new Date(t0).toISOString().slice(0, 10)} → ${new Date(data.get("btcusdt")![data.get("btcusdt")!.length - 1].openTime).toISOString().slice(0, 10)}`);
  console.log("  LƯU Ý: cộng R hai sleeve giả định 1R hai bên bằng nhau. Thực tế 1R Fast ≈ $1,60");
  console.log("  (0,5% × equity MEXC 321) còn 1R Turtle ≈ $0,98 (0,5% × equity Binance 196).");
}

main().catch((e) => { console.error(e?.response?.data ?? e.message); process.exit(1); });
