/**
 * fx-session.ts — họ phương pháp CUỐI CÙNG chưa test trên cặp tiền, và là họ mà đa số người trade
 * FX bán lẻ thật sự dùng: INTRADAY THEO PHIÊN. Bốn bài trước đều là phương pháp giữ nhiều ngày;
 * nếu không test cái này thì câu "FX không có edge" là nói quá.
 *
 * LUẬT (bản kinh điển nhất, khai báo trước — "phá vỡ phiên London"):
 *   Biên độ Á = 22:00 UTC hôm trước → 07:00 UTC. Vào lệnh khi nến H1 ĐÓNG vượt biên độ đó trong
 *   cửa sổ 07:00–12:00 UTC. Stop = đầu kia của biên độ (⇒ R = đúng bề rộng biên độ Á).
 *   Thoát: chạm stop, chạm target, hoặc 21:00 UTC cùng ngày. Mỗi ngày tối đa MỘT lệnh.
 *
 * LƯỚI (2 × 3 = 6 tổ hợp, in hết):
 *   lọc biên độ ∈ {không, biên độ Á ≤ 0,8 × ATR20 ngày}  — đúng lập luận "Á im ⇒ London nổ"
 *   target     ∈ {không (giữ tới 21:00), 1R, 2R}
 *
 * Chi phí: spread ĐO ĐƯỢC của đúng nến vào lệnh (không phải trung vị) + trượt 0,002%/chiều.
 * Intraday nhạy chi phí hơn hẳn: R ở đây là bề rộng biên độ Á (~0,3% giá), nhỏ hơn 3×ATR ngày
 * khoảng 4–5 lần, nên cùng một spread ăn vào R nặng gấp mấy lần so với hệ giữ nhiều ngày.
 *
 * Chạy: npx ts-node fx/fx-session.ts
 */

import { FxCandle, loadH1 } from "./fx-data";

/** Mặc định 3 major (bản gốc); truyền symbol qua dòng lệnh để chĩa vào công cụ khác. */
const PAIRS = process.argv.slice(2).length ? process.argv.slice(2) : ["EURUSD", "GBPUSD", "USDJPY"];
const RANGE_START_H = 22, RANGE_END_H = 7, ENTRY_END_H = 12, EXIT_H = 21;
const FILTERS: [string, number][] = [["không lọc", 0], ["Á ≤ 0,8×ATR", 0.8]];
const TARGETS: [string, number][] = [["giữ tới 21h", 0], ["1R", 1], ["2R", 2]];
const SLIP_PCT = 0.002;

const hourOf = (ms: number) => new Date(ms).getUTCHours();
const dayOf = (ms: number) => Math.floor(ms / 86400e3);

interface Trade { netR: number; grossR: number; spreadR: number; slipR: number; dir: "long" | "short"; time: number }

function runSession(bars: FxCandle[], filterMult: number, targetR: number): Trade[] {
  // ATR20 ngày (xấp xỉ bằng biên độ ngày trung bình 20 phiên gần nhất) — chỉ dùng nến ĐÃ ĐÓNG.
  const dayHi = new Map<number, number>(), dayLo = new Map<number, number>();
  for (const b of bars) {
    const d = dayOf(b.openTime);
    dayHi.set(d, Math.max(dayHi.get(d) ?? -Infinity, b.high));
    dayLo.set(d, Math.min(dayLo.get(d) ?? Infinity, b.low));
  }
  const days = [...dayHi.keys()].sort((a, b) => a - b);
  const atr = new Map<number, number>();
  for (let i = 20; i < days.length; i++) {
    let s = 0;
    for (let k = i - 20; k < i; k++) s += dayHi.get(days[k])! - dayLo.get(days[k])!;
    atr.set(days[i], s / 20);
  }

  // Gom nến theo NGÀY GIAO DỊCH: biên độ Á bắt đầu 22:00 hôm trước ⇒ dịch mốc 2 giờ.
  const byDay = new Map<number, FxCandle[]>();
  for (const b of bars) {
    const d = dayOf(b.openTime + 2 * 3600e3);
    let g = byDay.get(d);
    if (!g) byDay.set(d, (g = []));
    g.push(b);
  }

  const trades: Trade[] = [];
  for (const [d, group] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const asia = group.filter((b) => hourOf(b.openTime) >= RANGE_START_H || hourOf(b.openTime) < RANGE_END_H);
    if (asia.length < 6) continue; // phiên Á cụt (nghỉ lễ) → bỏ ngày
    const hi = Math.max(...asia.map((b) => b.high));
    const lo = Math.min(...asia.map((b) => b.low));
    const width = hi - lo;
    if (!(width > 0)) continue;
    const a = atr.get(d);
    if (filterMult > 0 && (a === undefined || width > filterMult * a)) continue;

    const session = group.filter((b) => hourOf(b.openTime) >= RANGE_END_H && hourOf(b.openTime) < ENTRY_END_H);
    let entry: number | null = null, dir: "long" | "short" | null = null, entryIdx = -1;
    for (const b of session) {
      if (b.close > hi) { entry = b.close; dir = "long"; entryIdx = group.indexOf(b); break; }
      if (b.close < lo) { entry = b.close; dir = "short"; entryIdx = group.indexOf(b); break; }
    }
    if (entry === null || dir === null) continue;

    const stop = dir === "long" ? lo : hi;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    const target = targetR > 0 ? (dir === "long" ? entry + targetR * risk : entry - targetR * risk) : null;

    let exit = entry;
    for (let i = entryIdx + 1; i < group.length; i++) {
      const b = group[i];
      if (dir === "long" && b.low <= stop) { exit = stop; break; }
      if (dir === "short" && b.high >= stop) { exit = stop; break; }
      if (target !== null && (dir === "long" ? b.high >= target : b.low <= target)) { exit = target; break; }
      if (hourOf(b.openTime) >= EXIT_H) { exit = b.close; break; }
      if (i === group.length - 1) exit = b.close;
    }

    const gross = (dir === "long" ? exit - entry : entry - exit) / risk;
    const spreadR = group[entryIdx].spread / risk;
    const slipR = (2 * (SLIP_PCT / 100) * entry) / risk;
    trades.push({ netR: gross - spreadR - slipR, grossR: gross, spreadR, slipR, dir, time: group[entryIdx].openTime });
  }
  return trades;
}

function summarize(trades: Trade[]) {
  const n = trades.length;
  if (!n) return null;
  const net = trades.reduce((s, t) => s + t.netR, 0);
  const mean = net / n;
  const sd = Math.sqrt(trades.reduce((s, t) => s + (t.netR - mean) ** 2, 0) / (n - 1));
  const byYear = new Map<number, number>();
  for (const t of trades) {
    const y = new Date(t.time).getUTCFullYear();
    byYear.set(y, (byYear.get(y) ?? 0) + t.netR);
  }
  const yrs = [...byYear.values()];
  // BIÊN PHÁT HIỆN: "net ≈ 0" có hai nghĩa rất khác nhau — (a) không có edge, hoặc (b) có edge
  // nhưng chi phí ăn hết. Chỉ phân biệt được khi in gross và cost riêng ra.
  const gross = trades.reduce((s, t) => s + t.grossR, 0);
  const gMean = gross / n;
  const gSd = Math.sqrt(trades.reduce((s, t) => s + (t.grossR - gMean) ** 2, 0) / (n - 1));
  const spreadR = trades.reduce((s, t) => s + t.spreadR, 0);
  const slipR = trades.reduce((s, t) => s + t.slipR, 0);
  return {
    n, net, exp: mean, gross, spreadR, slipR,
    // Spread hoà vốn = bao nhiêu % spread lịch sử thì net về 0. >100% ⇒ đã lãi ở spread hôm nay;
    // <100% ⇒ cần venue rẻ hơn đúng tỉ lệ đó mới hoà.
    beSpread: spreadR > 0 ? (gross - slipR) / spreadR : 0,
    tGross: gSd > 0 ? gMean / (gSd / Math.sqrt(n)) : 0,
    wr: trades.filter((t) => t.netR > 0).length / n,
    t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    posYears: yrs.filter((v) => v > 0).length, nYears: yrs.length,
  };
}

async function main() {
  console.log(`═══ PHÁ VỠ PHIÊN LONDON — họ intraday, ${PAIRS.join(" ")}, nến H1 ═══`);
  console.log("Đọc cột t-stat: |t| < 2 ⇒ không phân biệt được với 0.\n");
  const data = new Map(PAIRS.map((p) => [p, loadH1(p)]));

  console.log("biến thể".padEnd(30) + "lệnh".padStart(7) + "NET R".padStart(9) + "exp/lệnh".padStart(10) +
    "WR%".padStart(7) + "t-stat".padStart(8) + "năm+".padStart(8));
  for (const [fLabel, fMult] of FILTERS) {
    for (const [tLabel, tR] of TARGETS) {
      const all: Trade[] = [];
      for (const p of PAIRS) all.push(...runSession(data.get(p)!, fMult, tR));
      const s = summarize(all);
      if (!s) continue;
      console.log(
        `${fLabel} · ${tLabel}`.padEnd(30) + String(s.n).padStart(7) + s.net.toFixed(0).padStart(9) +
        s.exp.toFixed(4).padStart(10) + `${(s.wr * 100).toFixed(0)}%`.padStart(7) +
        s.t.toFixed(2).padStart(8) + `${s.posYears}/${s.nYears}`.padStart(8),
      );
    }
  }

  console.log("\n─── Từng cặp, biến thể chuẩn (không lọc · giữ tới 21h) ───");
  for (const p of PAIRS) {
    const s = summarize(runSession(data.get(p)!, 0, 0));
    if (s) console.log(
      `${p.padEnd(10)} ${String(s.n).padStart(6)} lệnh  GROSS ${s.gross.toFixed(0).padStart(6)}R (t ${s.tGross.toFixed(2).padStart(5)})  ` +
      `spread −${s.spreadR.toFixed(0).padStart(4)}R  trượt −${s.slipR.toFixed(0).padStart(4)}R  ` +
      `NET ${s.net.toFixed(0).padStart(6)}R  spread hoà vốn ${(s.beSpread * 100).toFixed(0).padStart(4)}%  năm+ ${s.posYears}/${s.nYears}`);
  }

  // Spread lịch sử 22 năm KHÔNG phải spread hôm nay. Nếu edge chỉ hoà vốn nhờ spread nén lại thì
  // phần dương sẽ dồn hết vào các năm gần đây — đúng cái bẫy đã bắt được ở nhánh vàng lần trước.
  console.log("\n─── THEO NĂM (biến thể chuẩn) — spread nén lại hay edge dồn cuối kỳ? ───");
  for (const p of PAIRS) {
    const ts = runSession(data.get(p)!, 0, 0);
    const years = [...new Set(ts.map((t) => new Date(t.time).getUTCFullYear()))].sort();
    console.log(`${p}:`);
    for (const y of years) {
      const rs = ts.filter((t) => new Date(t.time).getUTCFullYear() === y);
      const g = rs.reduce((s, t) => s + t.grossR, 0), sp = rs.reduce((s, t) => s + t.spreadR, 0);
      const nt = rs.reduce((s, t) => s + t.netR, 0);
      console.log(`  ${y}  ${String(rs.length).padStart(4)} lệnh  gross ${g.toFixed(1).padStart(7)}R  ` +
        `spread ${(sp / rs.length).toFixed(4)}R/lệnh  net ${nt.toFixed(1).padStart(7)}R`);
    }
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
