/**
 * exp-key-identification.ts — "CÓ XÁC ĐỊNH KEY VOLUME CHÍNH XÁC NHƯ MẮT NGƯỜI ĐƯỢC KHÔNG?"
 *
 * Không có nhật ký key do người đánh dấu trong repo (fxdream-journal.ts có sẵn hạ tầng nhưng CHƯA CÓ
 * dữ liệu), nên KHÔNG THỂ đo trực tiếp độ khớp người-máy. Thay vào đó đo ba thứ đo được, và cả ba đều
 * nói về cùng một câu hỏi:
 *
 *   K1 MẬT ĐỘ — định nghĩa hiện tại sinh bao nhiêu key? Tác giả kênh giao dịch ~60 kèo/năm trên toàn
 *      bộ thị trường của mình. Nếu detector sinh hàng trăm key mỗi coin mỗi năm thì nó KHÔNG đang mô
 *      hình hoá cùng một khái niệm, bất kể tinh chỉnh thêm bao nhiêu.
 *
 *   K2 ĐỘ ỔN ĐỊNH — đổi ngưỡng ±25% (2,0 → 2,5) thì bao nhiêu phần trăm key giữ nguyên (Jaccard)?
 *      Một khái niệm sắc nét phải bền với nhiễu tham số. Nếu một thay đổi nhỏ hoán đổi phần lớn tập
 *      key thì "key" chưa phải là một VẬT THỂ xác định — và lúc đó "chính xác như mắt người" là câu
 *      hỏi chưa được đặt đúng, chứ không phải câu hỏi khó.
 *
 *   K3 GIÁ TRỊ THÔNG TIN — ở mỗi mật độ, key có tách được lệnh tốt khỏi lệnh xấu của Turtle không?
 *      Đây là phép thử "key có mang tin" độc lập với việc có giao dịch được hay không.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-key-identification.ts [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, atrSeries, buildBtcGateLongs } from "../turtle";
import { detectKeyVolumeLevels, KEY_VOLUME_CONFIG, KeyVolumeLevel } from "../key-volume";
import { AdmitFn, Book, ExtParams, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];

function detect(data: Map<string, Candle[]>, mult: number, lookback: number): Map<string, KeyVolumeLevel[]> {
  const out = new Map<string, KeyVolumeLevel[]>();
  for (const [sym, c] of data) {
    out.set(sym, detectKeyVolumeLevels(c, "4h", { ...KEY_VOLUME_CONFIG, volumeSpikeMult: mult, volumeLookback: lookback }));
  }
  return out;
}

/** Jaccard trên tập NẾN SỰ KIỆN — hai định nghĩa có chỉ vào cùng những cây nến không. */
function jaccard(a: Map<string, KeyVolumeLevel[]>, b: Map<string, KeyVolumeLevel[]>): number {
  let inter = 0, uni = 0;
  for (const sym of a.keys()) {
    const A = new Set((a.get(sym) ?? []).map((l) => l.eventTime));
    const B = new Set((b.get(sym) ?? []).map((l) => l.eventTime));
    for (const t of A) if (B.has(t)) inter++;
    uni += A.size + B.size;
  }
  return uni > 0 ? inter / (uni - inter) : 0;
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadPool(days, CORE8);
  const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  const years = (w.to - w.from) / (365 * DAY);
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} (${years.toFixed(1)} năm) · ${data.size} coin · nến 4h\n`);

  // ── K1 + K2 ──
  console.log("=".repeat(104));
  console.log("  K1/K2 — MẬT ĐỘ và ĐỘ ỔN ĐỊNH của định nghĩa key (spike ≥ mult × trung vị lookback nến)");
  console.log("=".repeat(104));
  console.log("mult   lookback   tổng key   key/coin/năm   khoảng cách TB giữa 2 key   Jaccard với mult kế tiếp");
  console.log("-".repeat(104));
  const MULTS = [2, 2.5, 3, 4, 5, 6, 8, 10];
  const sets = new Map<number, Map<string, KeyVolumeLevel[]>>();
  for (const m of MULTS) sets.set(m, detect(data, m, KEY_VOLUME_CONFIG.volumeLookback));
  for (let i = 0; i < MULTS.length; i++) {
    const m = MULTS[i];
    const s = sets.get(m)!;
    const total = [...s.values()].reduce((a, v) => a + v.length, 0);
    const perCoinYear = total / data.size / years;
    const gapDays = perCoinYear > 0 ? 365 / perCoinYear : Infinity;
    const j = i + 1 < MULTS.length ? jaccard(s, sets.get(MULTS[i + 1])!) : NaN;
    console.log(
      `${m.toFixed(1).padStart(4)}   ${String(KEY_VOLUME_CONFIG.volumeLookback).padStart(8)}   ${String(total).padStart(8)}   ` +
        `${perCoinYear.toFixed(0).padStart(12)}   ${gapDays.toFixed(1).padStart(24)}d   ` +
        `${Number.isFinite(j) ? `${(j * 100).toFixed(0)}% (→${MULTS[i + 1]})` : "—"}`,
    );
  }

  console.log("\nĐộ nhạy với CỬA SỔ NHÌN LẠI (giữ mult = 2, đổi lookback) — Jaccard so với lookback 96:");
  const base96 = sets.get(2)!;
  for (const lb of [48, 72, 96, 120, 192]) {
    const s = detect(data, 2, lb);
    const total = [...s.values()].reduce((a, v) => a + v.length, 0);
    console.log(
      `  lookback ${String(lb).padStart(3)} nến: ${String(total).padStart(6)} key · ` +
        `${(total / data.size / years).toFixed(0).padStart(3)} key/coin/năm · Jaccard ${lb === 96 ? "100% (chính nó)" : `${(jaccard(s, base96) * 100).toFixed(0)}%`}`,
    );
  }

  // ── K3 ──
  console.log("\n" + "=".repeat(104));
  console.log("  K3 — Ở MỖI MẬT ĐỘ, key có tách được lệnh tốt/xấu của Turtle không?");
  console.log("  (exp/unit của unit vào SÁT key ≤0,25×ATR so với unit vào XA key >1×ATR)");
  console.log("=".repeat(104));
  console.log("mult   key/coin/năm   unit sát key   exp    unit xa key   exp     chênh lệch");
  console.log("-".repeat(104));
  const heat: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / T.heatDecayK);
  const bk = (p: ExtParams): Book[] => [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
  const res = runBooks(bk(turtle), heat);
  const trades = res.trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);
  const atrBySym = new Map<string, { atr: number[]; idx: Map<number, number> }>();
  for (const [sym, c] of data) {
    const idx = new Map<number, number>();
    for (let i = 0; i < c.length; i++) idx.set(c[i].openTime, i);
    atrBySym.set(sym, { atr: atrSeries(c, T.atrPeriod), idx });
  }

  for (const m of MULTS) {
    const s = sets.get(m)!;
    const total = [...s.values()].reduce((a, v) => a + v.length, 0);
    const near: { netR: number; wt: number }[] = [];
    const far: { netR: number; wt: number }[] = [];
    for (const t of trades) {
      const meta = atrBySym.get(t.symbol);
      const i = meta?.idx.get(t.entryTime);
      if (meta === undefined || i === undefined || !(meta.atr[i] > 0)) continue;
      const levels = s.get(t.symbol) ?? [];
      let best = Infinity;
      for (const lv of levels) {
        if (lv.confirmedAt > t.entryTime || lv.expiresAt <= t.entryTime) continue;
        const d = t.dir === "long" ? lv.price - t.entryPrice : t.entryPrice - lv.price;
        if (d > 0) best = Math.min(best, d);
      }
      const roomAtr = best / meta.atr[i];
      if (roomAtr <= 0.25) near.push({ netR: t.netR, wt: t.weight });
      else if (roomAtr > 1) far.push({ netR: t.netR, wt: t.weight });
    }
    const e = (arr: { netR: number; wt: number }[]) => {
      const wt = arr.reduce((a, x) => a + x.wt, 0);
      return wt > 0 ? arr.reduce((a, x) => a + x.netR * x.wt, 0) / wt : NaN;
    };
    const en = e(near), ef = e(far);
    console.log(
      `${m.toFixed(1).padStart(4)}   ${(total / data.size / years).toFixed(0).padStart(12)}   ` +
        `${String(near.length).padStart(12)}   ${en.toFixed(3).padStart(5)}   ${String(far.length).padStart(11)}   ${ef.toFixed(3).padStart(5)}   ` +
        `${(en - ef).toFixed(3).padStart(11)}`,
    );
  }
}

if (require.main === module && /exp-key-identification\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
