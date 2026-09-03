/**
 * exp-exit-winners.ts — HAI ỨNG VIÊN LUẬT THOÁT: tìm CƠ CHẾ trước, rồi mới chạy cửa duyệt.
 *
 * Từ `exp-exit-rules.ts`, hai biến thể qua được holdout ba-cửa-vào (REAL/RANDOM/VOTE):
 *   A. time-stop 30 ngày thay 60   → REAL Sharpe 1,345 → 1,649  (+0,304)
 *   B. trail SHORT 2,0×ATR thay 3,0 → REAL Sharpe 1,345 → 1,432 (+0,087), plateau 2,0 > 2,5 > 3,0
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VÌ SAO PHẢI TÌM CƠ CHẾ TRƯỚC
 *
 * Cắt time-stop từ 60 xuống 30 ngày nghe NGƯỢC hẳn triết lý trend-following: cả hệ này sống nhờ
 * đuôi phải, tức nhờ vài lệnh giữ rất lâu. Một luật cắt ngắn thời gian giữ mà lại làm Sharpe tăng
 * 23% là loại kết quả phải giải thích được bằng cơ chế, nếu không thì gần như chắc chắn là hiện vật.
 *
 * Bảng 1 trả lời trực tiếp: những vị thế bị cắt bởi mốc 30 ngày ĐANG LÃI hay ĐANG LỖ?
 *   · nếu chúng net ÂM ⇒ cơ chế thật: vị thế kéo dài mà chưa chạm kênh thoát là vị thế mắc trong
 *     chop, vừa trả funding vừa chiếm ngân sách heat;
 *   · nếu chúng net DƯƠNG mà Sharpe vẫn tăng ⇒ có gì sai, dừng lại.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CỬA DUYỆT ĐẦY ĐỦ (mỗi bảng là một cửa độc lập)
 *   1. cơ chế: phân rã netR theo ĐỘ DÀI GIỮ LỆNH
 *   2. ba era phải cùng tốt lên (không sống nhờ một era)
 *   3. plateau tham số: 24/26/28/30/32/36/40 ngày; 1,75/2,0/2,25/2,5 ×ATR
 *   4. bật TRƯỢT GIÁ thực tế (time-stop thoát bằng market order tại close ⇒ chịu slipClose)
 *   5. hai ứng viên KẾT HỢP có cộng dồn hay triệt tiêu nhau
 *   6. tách LONG/SHORT: time-stop lợi ở chiều nào
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-exit-winners.ts [days=2000]
 */

import { TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, EquityPoint, ExtParams, UnitTrade, riskMetrics, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";

const DAY = TF_MS["1d"];
const BPD = 6; // nến 4h / ngày
const decayH = (k: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k);

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

  const bk = (ov: Partial<ExtParams>): Book[] => [
    ...[...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@t`, symbol, candles, p: { ...turtle, ...ov } })),
    ...[...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@f`, symbol, candles, p: { ...fast, ...ov } })),
  ];

  const baseRes = runBooks(bk({}), heat);
  const gridSet = new Set<number>();
  for (const e of baseRes.equity) if (e.time >= w.from && e.time <= w.to) gridSet.add(Math.floor(e.time / DAY));
  const grid = [...gridSet].sort((a, b) => a - b);
  const inWin = (ts: UnitTrade[]) => ts.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);

  const score = (ov: Partial<ExtParams>) => {
    const res = runBooks(bk(ov), heat);
    const eq = res.equity.filter((e) => e.time >= w.from && e.time <= w.to);
    const m = riskMetrics(eq);
    const eras = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
    const tr = inWin(res.trades);
    return {
      sh: sharpeOf(dailyOf(res.equity, w.from, w.to, grid)), ndd: m.netOverMaxDD, netR: m.netR,
      maxDD: m.maxDD, era: eras.map((e) => e.sharpe), res,
      pos: new Set(tr.map((t) => `${t.book}#${t.positionId}`)).size,
      holdDaysAvg: tr.length ? (tr.reduce((s, t) => s + t.holdBars, 0) / tr.length) / BPD : 0,
    };
  };
  const base = score({});
  console.log(`Cửa sổ ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)}`);
  console.log(`GỐC: Sharpe ${base.sh.toFixed(3)} · NET ${base.netR.toFixed(0)}R · maxDD ${base.maxDD.toFixed(0)}R · NET/DD ${base.ndd.toFixed(2)} · giữ TB ${base.holdDaysAvg.toFixed(1)} ngày\n`);

  // ═══ 1) CƠ CHẾ: netR theo ĐỘ DÀI GIỮ LỆNH, trên cấu hình GỐC ═══
  console.log("═".repeat(104));
  console.log("  1) CƠ CHẾ — netR theo ĐỘ DÀI GIỮ LỆNH ở cấu hình GỐC (time-stop 60 ngày)");
  console.log("═".repeat(104));
  const BK: [string, number, number][] = [
    ["0-5 ngày", 0, 5], ["5-10", 5, 10], ["10-15", 10, 15], ["15-20", 15, 20],
    ["20-25", 20, 25], ["25-30", 25, 30], ["30-40", 30, 40], ["40-60", 40, 60], [">60", 60, 1e9],
  ];
  console.log("  " + "giữ lệnh".padEnd(12) + "unit".padStart(6) + "%unit".padStart(7) +
    "tổng netR".padStart(11) + "netR/unit".padStart(11) + "  ← mốc 30 ngày cắt từ đây trở xuống");
  console.log("-".repeat(104));
  const trBase = inWin(baseRes.trades);
  let cutN = 0, cutR = 0;
  for (const [lbl, lo, hi] of BK) {
    const seg = trBase.filter((t) => { const d = t.holdBars / BPD; return d >= lo && d < hi; });
    const nr = seg.reduce((s, t) => s + t.netR * t.weight, 0);
    if (lo >= 30) { cutN += seg.length; cutR += nr; }
    console.log("  " + lbl.padEnd(12) + String(seg.length).padStart(6) +
      ((seg.length / trBase.length) * 100).toFixed(1).padStart(6) + "%" +
      ((nr >= 0 ? "+" : "") + nr.toFixed(1)).padStart(11) +
      (seg.length ? ((nr / seg.length >= 0 ? "+" : "") + (nr / seg.length).toFixed(3)) : "—").padStart(11) +
      (lo >= 30 ? "   ← bị cắt" : ""));
  }
  console.log("-".repeat(104));
  console.log(`  Phần giữ ≥30 ngày: ${cutN} unit (${((cutN / trBase.length) * 100).toFixed(1)}%) mang ${cutR >= 0 ? "+" : ""}${cutR.toFixed(1)}R ` +
    `= ${((cutR / base.netR) * 100).toFixed(1)}% tổng NET R  ⇒ ${cutR < 0 ? "ÂM ⇒ cơ chế cắt là HỢP LÝ" : "DƯƠNG ⇒ phải giải thích được vì sao cắt vẫn tốt hơn"}`);
  console.log(`  (Lưu ý: cắt ở 30 ngày KHÔNG xoá những unit này — nó thoát chúng SỚM HƠN, nên số trên là chặn trên của phần bị ảnh hưởng.)\n`);

  // ═══ 2-3) PLATEAU + ERA ═══
  const HDR = "  " + "biến thể".padEnd(28) + "Sharpe".padStart(8) + "Δ".padStart(8) + "NET R".padStart(8) +
    "maxDD".padStart(7) + "NET/DD".padStart(8) + "  era A/B/C".padEnd(20) + "giữ TB".padStart(8);
  const row = (lbl: string, ov: Partial<ExtParams>, b = base) => {
    const r = score(ov);
    const eraOk = r.era.every((x, i) => x >= b.era[i] - 0.02);
    console.log("  " + lbl.padEnd(28) + r.sh.toFixed(3).padStart(8) +
      ((r.sh - b.sh >= 0 ? "+" : "") + (r.sh - b.sh).toFixed(3)).padStart(8) +
      r.netR.toFixed(0).padStart(8) + r.maxDD.toFixed(0).padStart(7) + r.ndd.toFixed(2).padStart(8) + "  " +
      r.era.map((x) => x.toFixed(2)).join("/").padEnd(20) + r.holdDaysAvg.toFixed(1).padStart(8) +
      (eraOk ? "  ✓era" : "  ✗era"));
    return r;
  };

  console.log("═".repeat(104));
  console.log("  2) PLATEAU time-stop + ba era  (era gốc " + base.era.map((x) => x.toFixed(2)).join("/") + ")");
  console.log("═".repeat(104));
  console.log(HDR);
  console.log("-".repeat(104));
  row("60 ngày ĐANG CHẠY", {});
  for (const d of [20, 24, 26, 28, 30, 32, 36, 40, 50]) row(`${d} ngày`, { maxHoldDays: d });

  console.log("\n" + "═".repeat(104));
  console.log("  3) PLATEAU trail SHORT (ghim initialStopMult = 3,0 để không đổi mẫu số R)");
  console.log("═".repeat(104));
  console.log(HDR);
  console.log("-".repeat(104));
  const bPin = row("3,0×ATR ĐANG CHẠY", { initialStopMult: 3.0 });
  for (const m of [1.5, 1.75, 2.0, 2.25, 2.5, 2.75]) row(`${m.toFixed(2)}×ATR`, { initialStopMult: 3.0, chandelierMult: m }, bPin);

  // ═══ 4) TRƯỢT GIÁ THỰC TẾ ═══
  console.log("\n" + "═".repeat(104));
  console.log("  4) BẬT TRƯỢT GIÁ THỰC TẾ (slipTrail 0,10×ATR · slipClose 0,05×ATR)");
  console.log("     Quan trọng cho time-stop: nó thoát bằng MARKET ORDER tại close ⇒ chịu slipClose.");
  console.log("═".repeat(104));
  const slip: Partial<ExtParams> = { slipTrailAtr: 0.1, slipCloseAtr: 0.05 };
  console.log(HDR);
  console.log("-".repeat(104));
  const bSlip = row("GỐC + trượt giá", slip);
  row("time-stop 30 + trượt giá", { ...slip, maxHoldDays: 30 }, bSlip);
  row("trail SHORT 2,0 + trượt giá", { ...slip, initialStopMult: 3.0, chandelierMult: 2.0 }, bSlip);
  row("CẢ HAI + trượt giá", { ...slip, maxHoldDays: 30, initialStopMult: 3.0, chandelierMult: 2.0 }, bSlip);

  // ═══ 5) KẾT HỢP ═══
  console.log("\n" + "═".repeat(104));
  console.log("  5) HAI ỨNG VIÊN KẾT HỢP — cộng dồn hay triệt tiêu?");
  console.log("═".repeat(104));
  console.log(HDR);
  console.log("-".repeat(104));
  row("GỐC", {});
  row("chỉ time-stop 30", { maxHoldDays: 30 });
  row("chỉ trail SHORT 2,0", { initialStopMult: 3.0, chandelierMult: 2.0 });
  row("CẢ HAI", { maxHoldDays: 30, initialStopMult: 3.0, chandelierMult: 2.0 });

  // ═══ 6) TÁCH CHIỀU ═══
  console.log("\n" + "═".repeat(104));
  console.log("  6) TIME-STOP lợi ở CHIỀU NÀO — phân rã netR theo hướng");
  console.log("═".repeat(104));
  console.log("  " + "cấu hình".padEnd(28) + "LONG netR".padStart(11) + "LONG unit".padStart(11) +
    "SHORT netR".padStart(12) + "SHORT unit".padStart(12) + "  lý do thoát");
  console.log("-".repeat(104));
  for (const [lbl, ov] of [["GỐC (60 ngày)", {}], ["time-stop 30", { maxHoldDays: 30 }]] as [string, Partial<ExtParams>][]) {
    const tr = inWin(runBooks(bk(ov), heat).trades);
    const L = tr.filter((t) => t.dir === "long"), S = tr.filter((t) => t.dir === "short");
    const sum = (a: UnitTrade[]) => a.reduce((s, t) => s + t.netR * t.weight, 0);
    const byR: Record<string, number> = {};
    for (const t of tr) byR[t.exitReason] = (byR[t.exitReason] ?? 0) + 1;
    console.log("  " + lbl.padEnd(28) + ((sum(L) >= 0 ? "+" : "") + sum(L).toFixed(1)).padStart(11) +
      String(L.length).padStart(11) + ((sum(S) >= 0 ? "+" : "") + sum(S).toFixed(1)).padStart(12) +
      String(S.length).padStart(12) + "  " + Object.entries(byR).map(([k, v]) => `${k}=${v}`).join(" "));
  }

  console.log(
    "\n" + "═".repeat(104) +
    "\n  CÒN THIẾU trước khi bàn production: lệch pha nến (exp-bar-phase.ts) và tập trung theo năm\n" +
    "  (exp-concentration.ts). Hai cửa đó đã bắt được thứ mà mọi cửa khác bỏ lọt — xem memory.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
