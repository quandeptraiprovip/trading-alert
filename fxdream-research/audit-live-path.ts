/**
 * audit-live-path.ts — 2026-08-10. Kiểm tra ĐÚNG đường chạy LIVE của fxdream-alert.ts
 * (`strategy-engine-v2.ts`), không phải `key-volume.ts` đã được audit ở §13/§14.
 *
 * Trả lời bằng số:
 *   1. Key được XÁC THỰC ở giá nào và ĐƯỢC CÔNG BỐ ở giá nào — có lệch không?
 *   2. "SFP sweep" của code có thật là sweep (xuyên qua key rồi lấy lại) hay chỉ là CHẠM gần?
 *   3. Gate minRR có lọc được gì không, hay là dead code?
 *   4. Gate Daily #31 có đúng "low của nến xanh CUỐI CÙNG" như nguồn hay chỉ so hai nến cuối?
 *
 * KHÔNG import load-env, KHÔNG gửi Telegram.
 *
 * Run: ./node_modules/.bin/ts-node fxdream-research/audit-live-path.ts [days]
 */
import { Candle, TF_MS, aggregate } from "../strategy";
import { fetchKlinesPaged } from "../kline-fetch";
import {
  FXDREAM_V2_CONFIG,
  findKeyVolumeLevelsV2,
  evaluateDailyContextV2,
  detectSFPSignalsV2,
  buildSignalPlanV2,
  calculateATR,
  median,
} from "./strategy-engine-v2";

const SYMBOLS = ["BTCUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"];
const P = FXDREAM_V2_CONFIG;

async function main() {
  const days = parseInt(process.argv[2] ?? "30", 10);
  console.log(`\nKiểm ${days} ngày (đúng lượng dữ liệu fxdream-alert.ts nạp: 30*288 nến 5m)\n`);

  let totKeys = 0, keyPriceMismatch = 0, sumMismatchAtr = 0;
  let totEvents = 0, trueSweep = 0, touchOnly = 0, closeNotReclaimed = 0;
  let totPlans = 0, planRRbelowMin = 0, planNoStructure = 0, planStopFloored = 0;
  let dailyNeutralBothDirs = 0, dailyGateViaBreakout = 0, dailyGateViaWick = 0, dailyWarmup = 0;
  let barsWithEvent = 0, barsScanned = 0;

  for (const sym of SYMBOLS) {
    const c5m = await fetchKlinesPaged(sym, "5m", days * 288);
    const c15m = aggregate(c5m, "15m", "5m");
    const c1h = aggregate(c5m, "1h", "5m");
    const c4h = aggregate(c5m, "4h", "5m");
    const c1d = aggregate(c5m, "1d", "5m");

    // ── (1) Key: giá xác thực vs giá công bố ──
    const keys = findKeyVolumeLevelsV2(c1h, c4h, P);
    const atrH1 = calculateATR(c1h, 14);
    const idxOfH1 = new Map(c1h.map((c, i) => [c.openTime, i]));
    for (const k of keys) {
      totKeys++;
      const i = idxOfH1.get(k.originTime)!;
      const bar = c1h[i];
      const atr = atrH1[i] || bar.high - bar.low;
      const validatedAt = bar.close; // code đo phản ứng & đếm reaction ở CLOSE
      const diff = Math.abs(k.price - validatedAt);
      if (atr > 0 && diff > atr * 0.5) {
        keyPriceMismatch++;
        sumMismatchAtr += diff / atr;
      }
    }

    // ── (2)(3)(4) Đi từng nến M15 như live ──
    const atr15 = calculateATR(c15m, 14);
    let symEvents = 0;
    for (let n = P.sfpLookbackBars + 60; n <= c15m.length; n++) {
      const slice15 = c15m.slice(0, n);
      const nowTime = slice15[n - 1].openTime + TF_MS["15m"];
      const validDaily = c1d.filter((c) => c.openTime + TF_MS["1d"] <= nowTime);
      const ctx = evaluateDailyContextV2(validDaily, nowTime, P);

      // (4) chẩn đoán gate Daily — TÁCH warmup (thiếu nến ngày) khỏi neutral thật
      if (validDaily.length < P.dailyBiasBars + 5) dailyWarmup++;
      else if (ctx.bias === "neutral" && ctx.trapGatePassed) dailyNeutralBothDirs++;
      if (validDaily.length >= 2 && ctx.bias !== "neutral") {
        const prev = validDaily[validDaily.length - 1];
        const ante = validDaily[validDaily.length - 2];
        if (ctx.bias === "long") {
          if (prev.low < ante.low && prev.close > ante.low) dailyGateViaWick++;
          else if (prev.close > ante.high) dailyGateViaBreakout++;
        } else {
          if (prev.high > ante.high && prev.close < ante.high) dailyGateViaWick++;
          else if (prev.close < ante.low) dailyGateViaBreakout++;
        }
      }
      if (!ctx.trapGatePassed) continue;

      const validKeys = keys.filter(
        (k) => k.originTime <= nowTime && nowTime - k.originTime <= P.keyMaxAgeDays * TF_MS["1d"],
      );
      if (!validKeys.length) continue;

      const events = detectSFPSignalsV2(slice15, validKeys, ctx, P);
      barsScanned++;
      if (events.length > 0) barsWithEvent++;
      for (const e of events) {
        totEvents++;
        symEvents++;
        const key = e.keyLevel.price;
        const win = slice15.slice(n - 1 - P.sfpLookbackBars, n);
        const cCurr = slice15[n - 1];
        // sweep THẬT = có nến xuyên QUA key (thấp hơn key cho demand)
        if (e.dir === "long") {
          const pierced = win.some((b) => b.low < key);
          const reclaimed = cCurr.close > key;
          if (pierced) trueSweep++; else touchOnly++;
          if (!reclaimed) closeNotReclaimed++;
        } else {
          const pierced = win.some((b) => b.high > key);
          const reclaimed = cCurr.close < key;
          if (pierced) trueSweep++; else touchOnly++;
          if (!reclaimed) closeNotReclaimed++;
        }

        // (3) plan + gate minRR
        const plan = buildSignalPlanV2(sym, e, null, P);
        if (plan) {
          totPlans++;
          planNoStructure++;
          if (plan.targetR <= P.minRR + 1e-9) planRRbelowMin++;
          const rawStop =
            e.dir === "long"
              ? (plan.entryPrice - e.sweepPrice * 0.999) / plan.entryPrice
              : (e.sweepPrice * 1.001 - plan.entryPrice) / plan.entryPrice;
          if (rawStop < P.minStopPct) planStopFloored++;
        }
      }
    }
    console.log(`${sym.padEnd(9)} key H1 ${String(keys.length).padStart(4)} · sự kiện SFP ${String(symEvents).padStart(5)} · nến M15 quét ${c15m.length}`);
    void median; // giữ import cho rõ nguồn engine
  }

  const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) : "0.0");

  console.log("\n" + "=".repeat(96));
  console.log("  (1) KEY — xác thực ở CLOSE nhưng công bố ở LOW/HIGH");
  console.log("=".repeat(96));
  console.log(`  tổng key H1: ${totKeys}`);
  console.log(`  số key mà giá công bố lệch > 0,5×ATR khỏi giá được xác thực: ${keyPriceMismatch} (${pct(keyPriceMismatch, totKeys)}%)`);
  console.log(`  lệch trung bình của nhóm đó: ${keyPriceMismatch ? (sumMismatchAtr / keyPriceMismatch).toFixed(2) : "—"}×ATR`);

  console.log("\n" + "=".repeat(96));
  console.log("  (2) 'SFP SWEEP' — có thật xuyên qua key không?");
  console.log("=".repeat(96));
  console.log(`  tổng sự kiện: ${totEvents}`);
  console.log(`  có nến XUYÊN QUA key (sweep thật):        ${trueSweep} (${pct(trueSweep, totEvents)}%)`);
  console.log(`  CHỈ chạm gần trong dung sai 0,2% (không sweep): ${touchOnly} (${pct(touchOnly, totEvents)}%)`);
  console.log(`  nến xác nhận KHÔNG lấy lại được key:      ${closeNotReclaimed} (${pct(closeNotReclaimed, totEvents)}%)`);

  console.log("\n" + "=".repeat(96));
  console.log("  (3) GATE minRR — có lọc được gì không?");
  console.log("=".repeat(96));
  console.log(`  plan tạo được (không có cấu trúc đối diện → target = maxTargetR ${P.maxTargetR}R): ${totPlans}`);
  console.log(`  plan có targetR ĐÚNG BẰNG minRR (tức nhánh fallback, không phải cấu trúc thật): ${planRRbelowMin} (${pct(planRRbelowMin, totPlans)}%)`);
  console.log(`  plan bị NỚI stop lên sàn ${(P.minStopPct * 100).toFixed(1)}%: ${planStopFloored} (${pct(planStopFloored, totPlans)}%)`);

  console.log("\n" + "=".repeat(96));
  console.log("  (4) GATE DAILY #31");
  console.log("=".repeat(96));
  console.log(`  nến M15 trong warmup (thiếu nến ngày ⇒ gate PASS vô điều kiện): ${dailyWarmup}`);
  console.log(`  nến M15 bias = neutral SAU warmup ⇒ gate PASS, cho phép CẢ HAI hướng: ${dailyNeutralBothDirs}`);
  console.log(`  gate pass nhờ 'thọt râu' (đúng ý #31):                     ${dailyGateViaWick} (${pct(dailyGateViaWick, dailyGateViaWick + dailyGateViaBreakout)}%)`);
  console.log(`  gate pass nhờ 'đóng nến vượt đỉnh/đáy' (KHÔNG phải trap):  ${dailyGateViaBreakout} (${pct(dailyGateViaBreakout, dailyGateViaWick + dailyGateViaBreakout)}%)`);

  console.log("\n" + "=".repeat(96));
  console.log("  (5) TẦN SUẤT — so với 'chọn lọc 50-80 kèo/năm' của tác giả");
  console.log("=".repeat(96));
  console.log(`  nến M15 (×4 symbol) qua được gate Daily: ${barsScanned}`);
  console.log(`  nến có ≥1 sự kiện SFP ⇒ alert sẽ bắn: ${barsWithEvent} (${pct(barsWithEvent, barsScanned)}% số nến)`);
  console.log(`  quy ra: ~${(barsWithEvent / days).toFixed(1)} alert/ngày trên 4 coin ≈ ${((barsWithEvent / days) * 365).toFixed(0)} alert/năm`);
}

main().catch((e) => {
  console.error("Lỗi:", e?.response?.data ?? e);
  process.exit(1);
});
