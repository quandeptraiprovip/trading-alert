/**
 * exp-key-maturation.ts — Key phải "ĐỨNG ĐƯỢC MỘT THỜI GIAN" mới tính là Key.
 *
 * NGUỒN: người dùng mô tả cách chọn thật của mình — chọn cột volume to đột biến **khi nó đã xuất
 * hiện một thời gian rồi**, chứ không phải ngay lúc cây nến đó vừa đóng.
 *
 * ĐIỀU KIỆN NÀY ĐANG THIẾU HẲN TRONG CODE. `isKeyVolumeLevelActive` (key-volume.ts:685) chỉ đòi
 * `confirmedAt <= time`, mà `confirmedAt = eventTime + 1 nến` ⇒ key có hiệu lực NGAY khi nến spike
 * đóng. Chỉ có tuổi TỐI ĐA (`keyMaxAgeDays = 180`), không có tuổi TỐI THIỂU.
 *
 * Hai cách đọc "đã xuất hiện một thời gian", cả hai đều đo ở đây vì chúng dẫn tới việc khác nhau:
 *   M1 CHÍN THEO TUỔI  — key chỉ dùng được sau `minAgeDays` ngày kể từ lúc hình thành.
 *   M2 CHÍN + SỐNG SÓT — thêm điều kiện: trong thời gian chờ đó giá KHÔNG được đóng xuyên qua mức
 *                        key. Một mức bị xuyên thủng ngay thì không phải mức đáng nhớ.
 *
 * KHÔNG LOOKAHEAD: key hình thành ở T chỉ được dùng từ T + minAge; điều kiện sống sót cũng chỉ đọc
 * nến trong [T, T+minAge], tức đã đóng hết trước thời điểm sử dụng.
 *
 * HAI CÂU HỎI ĐO:
 *   Q1 MẬT ĐỘ — điều kiện này có kéo số key về thang người không? (đang dày gấp 20–30 lần, xem
 *      `planning/fxdream-as-trend-input-2026-08-12.md` §K1)
 *   Q2 CHẤT LƯỢNG — key đã chín có tách lệnh tốt/xấu của Turtle sắc hơn key thô không? Trước đây
 *      unit vào SÁT key có exp gấp 2–3× unit vào XA key ở mọi ngưỡng; nếu "chín" là điều kiện thật
 *      thì khoảng cách đó phải RỘNG RA, không phải hẹp lại.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-key-maturation.ts [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, atrSeries, buildBtcGateLongs } from "../turtle";
import { detectKeyVolumeLevels, KEY_VOLUME_CONFIG, KeyVolumeLevel } from "../key-volume";
import { AdmitFn, Book, ExtParams, runBooks, UnitTrade } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];

type Matured = KeyVolumeLevel & { matureAt: number };

/**
 * Áp điều kiện chín. Trả về key kèm `matureAt` = thời điểm sớm nhất được phép dùng.
 * `requireSurvive` = true thì loại luôn những key bị giá đóng xuyên trong thời gian chờ.
 */
function matureKeys(c: Candle[], levels: KeyVolumeLevel[], minAgeDays: number, requireSurvive: boolean): Matured[] {
  if (minAgeDays <= 0) return levels.map((l) => ({ ...l, matureAt: l.confirmedAt }));
  const out: Matured[] = [];
  const ageMs = minAgeDays * DAY;
  for (const lv of levels) {
    const matureAt = lv.confirmedAt + ageMs;
    if (matureAt >= lv.expiresAt) continue; // chín xong thì đã hết hạn
    if (requireSurvive) {
      // Phía mà giá đứng lúc key hình thành; đóng xuyên sang phía kia = mức bị phá.
      let side = 0;
      let broken = false;
      for (const bar of c) {
        if (bar.openTime < lv.confirmedAt) continue;
        if (bar.openTime >= matureAt) break;
        const s = Math.sign(bar.close - lv.price);
        if (s === 0) continue;
        if (side === 0) side = s;
        else if (s !== side) { broken = true; break; }
      }
      if (broken) continue;
    }
    out.push({ ...lv, matureAt });
  }
  return out;
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadPool(days, CORE8);
  const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  const years = (w.to - w.from) / (365 * DAY);
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} (${years.toFixed(1)} năm) · ${data.size} coin · nến 4h\n`);

  // Lệnh Turtle production, dùng chung cho mọi biến thể key
  const heat: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / T.heatDecayK);
  const bk = (p: ExtParams): Book[] => [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
  const trades: UnitTrade[] = runBooks(bk(turtle), heat).trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);
  const meta = new Map<string, { atr: number[]; idx: Map<number, number> }>();
  for (const [sym, c] of data) {
    const idx = new Map<number, number>();
    for (let i = 0; i < c.length; i++) idx.set(c[i].openTime, i);
    meta.set(sym, { atr: atrSeries(c, T.atrPeriod), idx });
  }

  const rawBySym = new Map<number, Map<string, KeyVolumeLevel[]>>();
  for (const mult of [2, 3, 5]) {
    const m = new Map<string, KeyVolumeLevel[]>();
    for (const [sym, c] of data) m.set(sym, detectKeyVolumeLevels(c, "4h", { ...KEY_VOLUME_CONFIG, volumeSpikeMult: mult }));
    rawBySym.set(mult, m);
  }

  for (const requireSurvive of [false, true]) {
    console.log("=".repeat(108));
    console.log(`  ${requireSurvive ? "M2 — CHÍN + SỐNG SÓT (không bị đóng xuyên trong lúc chờ)" : "M1 — CHÍN THEO TUỔI"}`);
    console.log("=".repeat(108));
    console.log("spike  tuổi tối thiểu   key còn lại   key/coin/năm   unit sát key   exp    unit xa key   exp    CHÊNH");
    console.log("-".repeat(108));
    for (const mult of [2, 3, 5]) {
      for (const age of [0, 1, 3, 7, 14, 30]) {
        const bySym = new Map<string, Matured[]>();
        let total = 0;
        for (const [sym, c] of data) {
          const km = matureKeys(c, rawBySym.get(mult)!.get(sym) ?? [], age, requireSurvive);
          bySym.set(sym, km);
          total += km.length;
        }
        const near: { r: number; wt: number }[] = [];
        const far: { r: number; wt: number }[] = [];
        for (const t of trades) {
          const md = meta.get(t.symbol);
          const i = md?.idx.get(t.entryTime);
          if (!md || i === undefined || !(md.atr[i] > 0)) continue;
          let best = Infinity;
          for (const lv of bySym.get(t.symbol) ?? []) {
            if (lv.matureAt > t.entryTime || lv.expiresAt <= t.entryTime) continue;
            const d = t.dir === "long" ? lv.price - t.entryPrice : t.entryPrice - lv.price;
            if (d > 0) best = Math.min(best, d);
          }
          const roomAtr = best / md.atr[i];
          if (roomAtr <= 0.25) near.push({ r: t.netR, wt: t.weight });
          else if (roomAtr > 1) far.push({ r: t.netR, wt: t.weight });
        }
        const e = (a: { r: number; wt: number }[]) => {
          const wt = a.reduce((s, x) => s + x.wt, 0);
          return wt > 0 ? a.reduce((s, x) => s + x.r * x.wt, 0) / wt : NaN;
        };
        const en = e(near), ef = e(far);
        console.log(
          `${mult.toFixed(0).padStart(4)}×  ${(age === 0 ? "0 (hiện tại)" : `${age} ngày`).padStart(14)}   ${String(total).padStart(11)}   ` +
            `${(total / data.size / years).toFixed(0).padStart(12)}   ${String(near.length).padStart(12)}   ${en.toFixed(3).padStart(5)}   ` +
            `${String(far.length).padStart(11)}   ${ef.toFixed(3).padStart(5)}   ${(en - ef).toFixed(3).padStart(6)}`,
        );
      }
      console.log("-".repeat(108));
    }
    console.log();
  }
  console.log("Thang người đối chiếu: tác giả kênh ~60 kèo/năm trên TOÀN BỘ thị trường của họ.");
  console.log('CHÊNH = exp(sát key) − exp(xa key). "Chín" là điều kiện thật �⇒ cột CHÊNH phải RỘNG RA khi tăng tuổi.');
}

if (require.main === module && /exp-key-maturation\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
