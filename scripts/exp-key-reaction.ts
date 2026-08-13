/**
 * exp-key-reaction.ts — Key chỉ thành Key sau khi GIÁ QUAY LẠI CHẠM VÀ BẬT RA.
 *
 * NGUỒN: người dùng, khi được hỏi "đứng được" nghĩa là gì, trả lời rõ: **giá đã quay lại chạm và
 * bật ra**. Đây chặt hơn hẳn cách đọc trước (chỉ cần không bị đóng xuyên) và là điều kiện xác nhận
 * kinh điển: một mức chỉ được chứng minh khi thị trường quay lại tôn trọng nó.
 *
 * TÌNH TRẠNG CODE: `KEY_VOLUME_CONFIG` CÓ cơ chế đếm phản ứng (`minKeyReactions`, `keyReactionAtr`,
 * `keyHistoryDays`) nhưng (a) đang TẮT (`minKeyReactions: 0`) và (b) nó đếm phản ứng LỊCH SỬ TRƯỚC
 * khi key hình thành (`historicalReactions` quét swing có `swing.index < event`) — **ngược chiều**
 * với điều người dùng mô tả. Phản ứng phải xảy ra SAU khi key hình thành.
 *
 * CHU TRÌNH XÁC NHẬN (không lookahead — key chỉ dùng được từ nến hoàn tất bước 3):
 *   1. RỜI ĐI   — sau nến spike, giá phải rời vùng key ≥ `awayAtr` × ATR (nhớ phía rời).
 *   2. QUAY LẠI — giá chạm lại vùng key.
 *   3. BẬT RA   — trong `reactBars` nến sau cú chạm, giá phải bật khỏi vùng ≥ `bounceAtr` × ATR
 *                 VỀ ĐÚNG PHÍA đã rời. Nếu giá đóng xuyên sang phía kia trước ⇒ key CHẾT.
 *
 * ĐO HAI THỨ, đúng như các vòng trước để so sánh được:
 *   Q1 MẬT ĐỘ    — có về thang người không (~60 kèo/năm toàn thị trường)?
 *   Q2 PHÂN TÁCH — exp/unit của lệnh Turtle vào SÁT key so với vào XA key có rộng ra không?
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-key-reaction.ts [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, atrSeries, buildBtcGateLongs } from "../turtle";
import { detectKeyVolumeLevels, KEY_VOLUME_CONFIG, KeyVolumeLevel } from "../key-volume";
import { AdmitFn, Book, ExtParams, runBooks, UnitTrade } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];

export type ConfirmedKey = KeyVolumeLevel & { usableAt: number };

export interface ReactionParams {
  awayAtr: number;    // bước 1: phải rời vùng bao xa
  bounceAtr: number;  // bước 3: phải bật khỏi vùng bao xa
  reactBars: number;  // bước 3: trong bao nhiêu nến kể từ cú chạm
  maxWaitDays: number;
}

/**
 * Áp chu trình rời → chạm lại → bật ra. Trả về key kèm `usableAt` = nến sớm nhất được phép dùng.
 * Key không hoàn tất chu trình trong `maxWaitDays` bị loại.
 */
export function confirmByReaction(c: Candle[], levels: KeyVolumeLevel[], p: ReactionParams): ConfirmedKey[] {
  const atr = atrSeries(c, T.atrPeriod);
  const idx = new Map<number, number>();
  for (let i = 0; i < c.length; i++) idx.set(c[i].openTime, i);
  const tfMs = TF_MS["4h"];
  const maxBars = Math.round((p.maxWaitDays * DAY) / tfMs);
  const out: ConfirmedKey[] = [];

  for (const lv of levels) {
    const e = idx.get(lv.eventTime);
    if (e === undefined) continue;
    const hi = lv.zoneHigh, lo = lv.zoneLow;
    let side = 0;      // +1 = giá rời lên trên vùng, −1 = rời xuống dưới
    let touched = -1;  // chỉ số nến chạm lại
    let done = false;

    for (let i = e + 1; i < Math.min(c.length, e + 1 + maxBars); i++) {
      const a = atr[i];
      if (!(a > 0)) continue;

      if (side === 0) {
        // Bước 1 — rời đi đủ xa
        if (c[i].low > hi + p.awayAtr * a) side = 1;
        else if (c[i].high < lo - p.awayAtr * a) side = -1;
        continue;
      }

      if (touched < 0) {
        // Bước 2 — quay lại chạm vùng
        if (c[i].low <= hi && c[i].high >= lo) touched = i;
        // đóng xuyên hẳn sang phía kia trước khi kịp chạm ⇒ mức đã mất
        else if (side === 1 && c[i].close < lo) break;
        else if (side === -1 && c[i].close > hi) break;
        continue;
      }

      // Bước 3 — bật ra về đúng phía đã rời, trong reactBars nến
      if (i - touched > p.reactBars) break;
      if (side === 1 && c[i].close < lo) break;   // xuyên thủng thay vì bật
      if (side === -1 && c[i].close > hi) break;
      const bounced = side === 1
        ? c[i].close > hi + p.bounceAtr * a
        : c[i].close < lo - p.bounceAtr * a;
      if (bounced) {
        out.push({ ...lv, usableAt: c[i].openTime + tfMs });
        done = true;
        break;
      }
    }
    if (!done) continue;
  }
  return out.filter((k) => k.usableAt < k.expiresAt);
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadPool(days, CORE8);
  const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  const years = (w.to - w.from) / (365 * DAY);
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} (${years.toFixed(1)} năm) · ${data.size} coin · nến 4h\n`);

  const heat: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / T.heatDecayK);
  const bk = (p: ExtParams): Book[] => [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
  const trades: UnitTrade[] = runBooks(bk(turtle), heat).trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);
  const meta = new Map<string, { atr: number[]; idx: Map<number, number> }>();
  for (const [sym, c] of data) {
    const idx = new Map<number, number>();
    for (let i = 0; i < c.length; i++) idx.set(c[i].openTime, i);
    meta.set(sym, { atr: atrSeries(c, T.atrPeriod), idx });
  }

  /** exp/unit của lệnh vào SÁT key (≤0,25 ATR) so với vào XA key (>1 ATR). */
  function separation(bySym: Map<string, ConfirmedKey[]>) {
    const near: { r: number; wt: number }[] = [];
    const far: { r: number; wt: number }[] = [];
    for (const t of trades) {
      const md = meta.get(t.symbol);
      const i = md?.idx.get(t.entryTime);
      if (!md || i === undefined || !(md.atr[i] > 0)) continue;
      let best = Infinity;
      for (const lv of bySym.get(t.symbol) ?? []) {
        if (lv.usableAt > t.entryTime || lv.expiresAt <= t.entryTime) continue;
        const d = t.dir === "long" ? lv.price - t.entryPrice : t.entryPrice - lv.price;
        if (d > 0) best = Math.min(best, d);
      }
      const room = best / md.atr[i];
      if (room <= 0.25) near.push({ r: t.netR, wt: t.weight });
      else if (room > 1) far.push({ r: t.netR, wt: t.weight });
    }
    const e = (a: { r: number; wt: number }[]) => {
      const wt = a.reduce((s, x) => s + x.wt, 0);
      return wt > 0 ? a.reduce((s, x) => s + x.r * x.wt, 0) / wt : NaN;
    };
    return { nNear: near.length, nFar: far.length, eNear: e(near), eFar: e(far) };
  }

  for (const spike of [2, 3, 5]) {
    const raw = new Map<string, KeyVolumeLevel[]>();
    for (const [sym, c] of data) raw.set(sym, detectKeyVolumeLevels(c, "4h", { ...KEY_VOLUME_CONFIG, volumeSpikeMult: spike }));

    console.log("=".repeat(112));
    console.log(`  spike ≥${spike}× — chu trình RỜI → CHẠM LẠI → BẬT RA`);
    console.log("=".repeat(112));
    console.log("rời  bật  nến pư   key còn lại   key/coin/năm   unit sát key   exp    unit xa key   exp    CHÊNH");
    console.log("-".repeat(112));

    // mốc so sánh: key thô, không điều kiện
    {
      const bySym = new Map<string, ConfirmedKey[]>();
      let total = 0;
      for (const [sym] of data) {
        const l = (raw.get(sym) ?? []).map((x) => ({ ...x, usableAt: x.confirmedAt }));
        bySym.set(sym, l);
        total += l.length;
      }
      const s = separation(bySym);
      console.log(
        `  —    —      —      ${String(total).padStart(11)}   ${(total / data.size / years).toFixed(0).padStart(12)}   ` +
          `${String(s.nNear).padStart(12)}   ${s.eNear.toFixed(3).padStart(5)}   ${String(s.nFar).padStart(11)}   ${s.eFar.toFixed(3).padStart(5)}   ` +
          `${(s.eNear - s.eFar).toFixed(3).padStart(6)}   ← key thô (hiện tại)`,
      );
    }

    for (const awayAtr of [0.5, 1.0]) {
      for (const bounceAtr of [0.5, 1.0]) {
        for (const reactBars of [3, 6]) {
          const p: ReactionParams = { awayAtr, bounceAtr, reactBars, maxWaitDays: 60 };
          const bySym = new Map<string, ConfirmedKey[]>();
          let total = 0;
          for (const [sym, c] of data) {
            const k = confirmByReaction(c, raw.get(sym) ?? [], p);
            bySym.set(sym, k);
            total += k.length;
          }
          const s = separation(bySym);
          console.log(
            `${awayAtr.toFixed(1)}  ${bounceAtr.toFixed(1)}  ${String(reactBars).padStart(5)}    ${String(total).padStart(11)}   ` +
              `${(total / data.size / years).toFixed(0).padStart(12)}   ${String(s.nNear).padStart(12)}   ${s.eNear.toFixed(3).padStart(5)}   ` +
              `${String(s.nFar).padStart(11)}   ${s.eFar.toFixed(3).padStart(5)}   ${(s.eNear - s.eFar).toFixed(3).padStart(6)}`,
          );
        }
      }
    }
    console.log();
  }
  console.log("Thang người: tác giả kênh ~60 kèo/năm trên TOÀN BỘ thị trường của họ.");
  console.log("CHÊNH = exp(sát key) − exp(xa key). Điều kiện đúng ⇒ CHÊNH rộng ra VÀ mật độ về thang người.");
  console.log("Cảnh báo đọc số: `unit sát key` tụt quá thấp thì mọi exp đều là nhiễu, đừng đọc cột CHÊNH nữa.");
}

if (require.main === module && /exp-key-reaction\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
