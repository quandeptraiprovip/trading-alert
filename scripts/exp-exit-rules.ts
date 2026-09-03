/**
 * exp-exit-rules.ts — LUẬT THOÁT: bốn chiều CHƯA TỪNG được quét, cộng một thiết kế xác nhận mới.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VÌ SAO NHẮM VÀO LUẬT THOÁT
 *
 * Đối chứng ở `exp-indicator-strategy.ts` cho kết quả then chốt: **vào lệnh NGẪU NHIÊN** gắn vào bộ
 * máy thoát của hệ này cho Sharpe tới **1,19** (sổ thật 1,345). Nghĩa là phần lớn edge nằm ở luật
 * THOÁT chứ không ở luật VÀO — trong khi bốn vòng nghiên cứu trước, và phần lớn repo, quét luật VÀO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIẾT KẾ XÁC NHẬN MỚI: BA CỬA VÀO ĐỘC LẬP
 *
 * Vấn đề với việc quét luật thoát trên đúng tín hiệu vào đang chạy: một cải thiện có thể chỉ là
 * TƯƠNG TÁC khớp với đặc thù của breakout Donchian trên đúng mẫu này — tức overfit ở dạng khó thấy
 * nhất, vì nó không phải overfit tham số mà là overfit *cặp* (vào, ra).
 *
 * Nên mỗi luật thoát ở đây được chấm trên BA loại tín hiệu vào khác hẳn nhau:
 *   REAL   — chính hai sleeve đang chạy (Donchian close-channel)
 *   RANDOM — vào lệnh ngẫu nhiên p=0,02, ba seed → lấy TRUNG VỊ
 *   VOTE   — gộp 27 chỉ báo làm tín hiệu vào (corr 0,92 với Donchian nhưng vào ở thời điểm khác)
 *
 * Một cải tiến THẬT của luật thoát phải tốt lên ở CẢ BA. Tốt lên chỉ ở REAL = tương tác, loại.
 * Đây là holdout trong KHÔNG GIAN TÍN HIỆU, bổ sung cho holdout theo thời gian và lệch pha nến.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐN CHIỀU CHƯA TỪNG QUÉT (đã kiểm lại planning/: những chiều đã quét thì KHÔNG lặp)
 *
 *   Đã quét rồi, không làm lại: `longExitDays` 12-30d (20 tốt nhất, plateau) · exit-ratio (bác bỏ) ·
 *   mid-cho-SHORT (−71…−92%) · `initialStopMult` 1,5-4,0 (3,0 đỉnh plateau) · maxUnits 1-6 (3) ·
 *   heat k 2-8 (plateau).
 *
 *   E1 VỊ TRÍ mức thoát trong kênh close. Repo quét ĐỘ DÀI kênh nhưng chưa bao giờ quét VỊ TRÍ.
 *      mức = closeLow + pct×(closeHigh−closeLow); pct=0,5 đang chạy, pct=0 là Turtle GỐC (đáy kênh).
 *   E2 KHOẢNG TRAIL Chandelier của SHORT, TÁCH khỏi mẫu số R. Lần quét `initialStopMult` trước đã
 *      tách mẫu số R ra nhưng để `chandelierMult` (= trail SHORT) cố định 3,0 ⇒ trail SHORT vẫn CHƯA
 *      được quét độc lập. Và SHORT thoát 100% qua stop, nên đây là chiều nhạy nhất của sổ short.
 *   E3 SÀN TRAIL cho LONG. Trong nhánh `mid` đang chạy, hard stop **không trail chút nào** — chỉ
 *      nhích khi có unit pyramid. Repo test mid vs chandelier như hai LỰA CHỌN, chưa từng KẾT HỢP.
 *   E4 TIME-STOP `maxHoldDays` = 60. Chưa thấy quét ở đâu.
 *   E5 Stop xác nhận bằng CLOSE thay vì chạm trong nến — chỉ có nghĩa khi BẬT trượt giá thực tế,
 *      nên chạy riêng với `slipTrailAtr 0,1 / slipCloseAtr 0,05`.
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-exit-rules.ts [days=2000]
 */

import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, EquityPoint, ExtParams, riskMetrics, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";
import { DEFS, buildComboPre, vote } from "./exp-indicator-combos";

const DAY = TF_MS["1d"];
const decayH = (k: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k);
type Dir = "long" | "short";
type Signal = (symbol: string, i: number, c: Candle[]) => Dir | null;

function dailyOf(eq: EquityPoint[], from: number, to: number, grid: number[]): number[] {
  const per = new Map<number, number>();
  for (let i = 1; i < eq.length; i++) {
    if (eq[i].time < from || eq[i].time > to) continue;
    const d = Math.floor(eq[i].time / DAY);
    per.set(d, (per.get(d) ?? 0) + (eq[i].mtm - eq[i - 1].mtm));
  }
  return grid.map((d) => per.get(d) ?? 0);
}
const sharpeOf = (r: number[]): number => {
  const n = r.length;
  const m = r.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  return sd > 0 ? (m / sd) * Math.sqrt(365) : 0;
};

function randomSignal(p: number, seed: number): Signal {
  let s = seed;
  const rand = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const cache = new Map<string, Dir | null>();
  return (sym, i, c) => {
    const key = `${sym}|${c[i].openTime}`;
    let v = cache.get(key);
    if (v === undefined) { v = rand() < p ? (rand() < 0.5 ? "long" : "short") : null; cache.set(key, v); }
    return v;
  };
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  console.log(`Nạp ${CORE8.length} symbol CORE8, ${days} ngày nến 4h...`);
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  const heat = decayH(T.heatDecayK);
  const pre = buildComboPre(data);
  const allIdx = DEFS.map((_, k) => k);

  const voteSig: Signal = (sym, i, c) => {
    const t = c[i].openTime;
    let acc = 0;
    for (const k of allIdx) acc += vote(pre, k, sym, t, "long");
    const s = acc / allIdx.length;
    return s >= 0.7 ? "long" : s <= -0.7 ? "short" : null;
  };

  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));

  // Lưới ngày chung
  const ref = runBooks([...bk(turtle, "t"), ...bk(fast, "f")], heat);
  const gridSet = new Set<number>();
  for (const e of ref.equity) if (e.time >= w.from && e.time <= w.to) gridSet.add(Math.floor(e.time / DAY));
  const grid = [...gridSet].sort((a, b) => a - b);

  /** Sharpe + NET/DD cho một cấu hình thoát, trên một loại tín hiệu vào. */
  const evalOn = (ov: Partial<ExtParams>, entry: "real" | "vote" | number): { sh: number; ndd: number; pos: number } => {
    let books: Book[];
    if (entry === "real") books = [...bk({ ...turtle, ...ov }, "t"), ...bk({ ...fast, ...ov }, "f")];
    else if (entry === "vote") books = bk({ ...turtle, ...ov, entrySignal: voteSig }, "v");
    else books = bk({ ...turtle, ...ov, entrySignal: randomSignal(0.02, 900 + entry * 77) }, `r${entry}`);
    const res = runBooks(books, heat);
    const m = riskMetrics(res.equity.filter((e) => e.time >= w.from && e.time <= w.to));
    const pos = new Set(res.trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to).map((t) => `${t.book}#${t.positionId}`)).size;
    return { sh: sharpeOf(dailyOf(res.equity, w.from, w.to, grid)), ndd: m.netOverMaxDD, pos };
  };
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const evalRand = (ov: Partial<ExtParams>) => median([0, 1, 2].map((s) => evalOn(ov, s).sh));

  console.log(`Cửa sổ ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)}\n`);

  const HDR = "  " + "biến thể thoát".padEnd(30) + "REAL Sh".padStart(9) + "Δ".padStart(8) + "NET/DD".padStart(8) +
    "vịthế".padStart(7) + "  │" + "RANDOM Δ".padStart(10) + "VOTE Δ".padStart(9) + "  │ ba cửa";

  async function family(title: string, base: Partial<ExtParams>, variants: [string, Partial<ExtParams>][], note = "") {
    console.log("═".repeat(112));
    console.log(`  ${title}`);
    if (note) console.log(`  ${note}`);
    console.log("═".repeat(112));
    console.log(HDR);
    console.log("-".repeat(112));
    const b = evalOn(base, "real");
    const bR = evalRand(base);
    const bV = evalOn(base, "vote").sh;
    for (const [label, ov] of variants) {
      const o = { ...base, ...ov };
      const r = evalOn(o, "real");
      const dR = evalRand(o) - bR;
      const dV = evalOn(o, "vote").sh - bV;
      const dReal = r.sh - b.sh;
      const isBase = JSON.stringify(ov) === "{}" || label.includes("ĐANG CHẠY");
      const all3 = dReal > 0 && dR > 0 && dV > 0;
      const tag = isBase ? "— gốc —" : all3 ? "★ CẢ BA" : dReal > 0 ? "chỉ REAL ⇒ tương tác" : "thua";
      console.log("  " + label.padEnd(30) + r.sh.toFixed(3).padStart(9) +
        ((dReal >= 0 ? "+" : "") + dReal.toFixed(3)).padStart(8) + r.ndd.toFixed(2).padStart(8) +
        String(r.pos).padStart(7) + "  │" +
        ((dR >= 0 ? "+" : "") + dR.toFixed(3)).padStart(10) + ((dV >= 0 ? "+" : "") + dV.toFixed(3)).padStart(9) +
        "  │ " + tag);
    }
    console.log();
  }

  // E1 — VỊ TRÍ mức thoát trong kênh close
  await family(
    "E1) VỊ TRÍ mức thoát trong kênh close (repo chỉ từng quét ĐỘ DÀI kênh)",
    {},
    [
      ["pct 0,00 (Turtle gốc: đáy)", { longExitPct: 0 }],
      ["pct 0,15", { longExitPct: 0.15 }],
      ["pct 0,30", { longExitPct: 0.3 }],
      ["pct 0,50 ĐANG CHẠY", {}],
      ["pct 0,65", { longExitPct: 0.65 }],
      ["pct 0,80 (thoát sớm)", { longExitPct: 0.8 }],
    ],
    "mức = closeLow + pct×(closeHigh−closeLow); SHORT lấy đối xứng (1−pct)",
  );

  // E2 — trail Chandelier của SHORT, tách khỏi mẫu số R
  await family(
    "E2) KHOẢNG TRAIL CHANDELIER CỦA SHORT — tách khỏi mẫu số R (ghim initialStopMult = 3,0)",
    { initialStopMult: 3.0 },
    [
      ["trail 2,0×ATR", { chandelierMult: 2.0 }],
      ["trail 2,5×ATR", { chandelierMult: 2.5 }],
      ["trail 3,0×ATR ĐANG CHẠY", {}],
      ["trail 3,5×ATR", { chandelierMult: 3.5 }],
      ["trail 4,0×ATR", { chandelierMult: 4.0 }],
      ["trail 5,0×ATR", { chandelierMult: 5.0 }],
      ["trail 6,0×ATR", { chandelierMult: 6.0 }],
    ],
    "SHORT thoát 100% qua stop ⇒ đây là chiều nhạy nhất của sổ short, và chưa từng quét riêng",
  );

  // E3 — sàn trail cho LONG (kết hợp mid + chandelier, chưa từng test)
  await family(
    "E3) SÀN TRAIL CHO LONG — hard stop hiện KHÔNG trail trong nhánh mid",
    {},
    [
      ["TẮT (ĐANG CHẠY)", {}],
      ["sàn 3×ATR", { longTrailMult: 3 }],
      ["sàn 4×ATR", { longTrailMult: 4 }],
      ["sàn 5×ATR", { longTrailMult: 5 }],
      ["sàn 6×ATR", { longTrailMult: 6 }],
      ["sàn 8×ATR", { longTrailMult: 8 }],
      ["sàn 10×ATR", { longTrailMult: 10 }],
    ],
    "mid + chandelier từng được test như hai LỰA CHỌN THAY THẾ, chưa bao giờ KẾT HỢP",
  );

  // E4 — time stop
  await family(
    "E4) TIME-STOP maxHoldDays",
    {},
    [
      ["20 ngày", { maxHoldDays: 20 }],
      ["30 ngày", { maxHoldDays: 30 }],
      ["45 ngày", { maxHoldDays: 45 }],
      ["60 ngày ĐANG CHẠY", {}],
      ["90 ngày", { maxHoldDays: 90 }],
      ["120 ngày", { maxHoldDays: 120 }],
      ["365 ngày (≈ tắt)", { maxHoldDays: 365 }],
    ],
  );

  // E5 — stop xác nhận bằng close, CHỈ có nghĩa khi bật trượt giá thật
  await family(
    "E5) STOP XÁC NHẬN BẰNG CLOSE thay vì chạm trong nến — BẮT BUỘC bật trượt giá",
    { slipTrailAtr: 0.1, slipCloseAtr: 0.05 },
    [
      ["chạm-trong-nến (ĐANG CHẠY)", {}],
      ["xác nhận bằng CLOSE", { stopOnCloseOnly: true }],
    ],
    "53-63% cú stop-out là râu nến quét (memory execution-fill-assumption-risk); dưới giả định fill\n  hoàn hảo thì stop trong nến LUÔN thắng vì thoát sớm hơn ở giá tốt hơn — nên phải bật trượt giá",
  );

  console.log("═".repeat(112));
  console.log("  CÁCH ĐỌC");
  console.log("═".repeat(112));
  console.log(
    "  Cột RANDOM Δ và VOTE Δ là HOLDOUT TRONG KHÔNG GIAN TÍN HIỆU. Một luật thoát tốt hơn thật thì\n" +
    "  tốt hơn bất kể lệnh đến từ đâu. Chỉ tốt ở REAL nghĩa là nó khớp với đặc thù của breakout\n" +
    "  Donchian trên đúng mẫu này — dạng overfit khó thấy nhất vì nó không phải overfit tham số.\n" +
    "  ★ CẢ BA mới là ứng viên; sau đó vẫn phải qua exp-bar-phase.ts và exp-concentration.ts.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
