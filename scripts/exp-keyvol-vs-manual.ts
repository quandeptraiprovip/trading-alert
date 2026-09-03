/**
 * CỬA 1 — đối chiếu 6 kế hoạch TAY của user với detector key-volume hiện có.
 *
 * Nguồn nhãn người duy nhất trong repo: `trading-runtime/chart-playbook/btcusdt.json`
 * (`sampleOrders`), do user tự vẽ trên chart M15. Ba phép, mỗi phép trả lời một câu:
 *
 *   (a) 6 kế hoạch đó THẮNG hay THUA khi cho giá chạy thật?
 *       Quy ước bảo thủ: nến chạm CẢ HAI mức ⇒ tính STOP trước (limit-backtest bẫy 2).
 *   (b) Detector có NHÌN THẤY chỗ user vẽ không? Ba tầng, tách riêng để biết hỏng ở đâu:
 *       b1 mức key đang hiệu lực gần giá entry (tách theo khung sinh key — chính là câu
 *          M15 vs H1/H4 mà artifact §11 chốt), b2 có PLAN cùng chiều, b3 có TRADE cùng chiều.
 *   (c) Mẫu số R của code có cùng thang với R tay không?
 *
 * KHÔNG kết luận về lợi nhuận từ n=6 — phép này chỉ đo ĐỘ KHỚP giữa code và người.
 *
 * Chạy: npx ts-node scripts/exp-keyvol-vs-manual.ts [days]
 */
import fs from "fs";
import path from "path";
import {
  KEY_VOLUME_CONFIG,
  KeyVolumeLevel,
  KeyVolumeParams,
  atrSeriesForward,
  isKeyVolumeLevelActive,
  runKeyVolume,
} from "../key-volume";
import { fetchKlinesPaged } from "../kline-fetch";
import { Candle, CONFIG, TF_MS, aggregate } from "../strategy";

const SYMBOL = "btcusdt";
/** Cửa sổ khớp thời gian giữa tín hiệu code và mốc user vẽ: ±48 nến 5m = ±4 giờ. */
const MATCH_BARS = 48;
/** Cửa sổ khớp giá: bội số ATR(M15) tại thời điểm đó. */
const MATCH_ATR = 0.3;
/** Trần giữ lệnh khi cho giá chạy: 7 ngày, đúng `maxHoldBars` của KEY_VOLUME_CONFIG. */
const MAX_HOLD_MS = 7 * 24 * 60 * 60_000;

/**
 * Bàn thử sạch — bỏ sàn RR=3 vì nó CHỌN stop suy biến chứ không lọc chất lượng.
 *
 * ⚠️ HỎNG TỪ 01/09/2026: `targetSourceTfs` đã bị bỏ khỏi key-volume.ts, nên bàn thử này
 * không còn cho target 5R cố định — số chạy lại KHÔNG so được với số đã ghi.
 */
const CLEAN_BENCH: Partial<KeyVolumeParams> = {
  minRR: 0,
  requireStructuralTarget: false,
};

interface ManualPlan {
  index: number;
  side: "long" | "short";
  entryTime: number;
  endTime: number;
  entry: number;
  sl: number;
  tp: number;
  riskPct: number;
}

interface Outcome {
  exitTime: number;
  exitPrice: number;
  reason: "tp" | "sl" | "hết hạn" | "hết dữ liệu";
  grossR: number;
  costR: number;
  netR: number;
  holdHours: number;
  fillWaitHours: number;
}

function loadManualPlans(): ManualPlan[] {
  const file = path.resolve("trading-runtime/chart-playbook", `${SYMBOL}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    sampleOrders?: Record<string, unknown>[];
  };
  const orders = raw.sampleOrders ?? [];
  return orders
    .map((order, index) => ({
      index,
      side: String(order.side) === "short" ? ("short" as const) : ("long" as const),
      entryTime: Number(order.entryTime),
      endTime: Number(order.endTime),
      entry: Number(order.entry),
      sl: Number(order.sl),
      tp: Number(order.tp),
      riskPct: Math.abs(Number(order.entry) - Number(order.sl)) / Number(order.entry) * 100,
    }))
    .filter((plan) => Number.isFinite(plan.entryTime) && plan.riskPct > 0)
    .sort((a, b) => a.entryTime - b.entryTime);
}

/** Cùng công thức phí với `key-volume.ts` (fee+trượt hai chiều + funding theo thời gian giữ). */
function costR(plan: ManualPlan, entryTime: number, exitTime: number): number {
  const riskFraction = Math.abs(plan.entry - plan.sl) / plan.entry;
  const feeFraction = ((CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100) * 2;
  const fundingPeriods = Math.max(
    0,
    Math.floor(exitTime / (8 * 60 * 60_000)) - Math.floor(entryTime / (8 * 60 * 60_000)),
  );
  const fundingFraction = fundingPeriods * (CONFIG.costs.fundingPer8hPct / 100);
  return (feeFraction + fundingFraction) / riskFraction;
}

/**
 * `entry` là mức CHỜ (limit ở vùng OB), không phải giá thị trường — 5/6 kế hoạch có giá entry
 * nằm ngoài biên độ nến tại mốc user vẽ. Nên phải khớp đúng như lệnh chờ:
 *   1. Chờ giá chạm `entry` (trần chờ FILL_WAIT_MS, không thì huỷ như lệnh không khớp).
 *   2. Nến KHỚP chỉ được tính STOP, target phải từ nến sau (bẫy 2 của limit-backtest).
 *   3. Nến chạm cả hai mức ⇒ STOP trước.
 */
const FILL_WAIT_MS = 24 * 60 * 60_000;

function simulate(plan: ManualPlan, base: Candle[], horizonMs: number): Outcome | null {
  const start = base.findIndex((candle) => candle.openTime > plan.entryTime);
  if (start < 0) return null;
  const risk = Math.abs(plan.entry - plan.sl);
  const dir = plan.side === "long" ? 1 : -1;

  let fill = -1;
  for (let i = start; i < base.length; i++) {
    if (base[i].openTime > plan.entryTime + FILL_WAIT_MS) break;
    if (base[i].low <= plan.entry && plan.entry <= base[i].high) {
      fill = i;
      break;
    }
  }
  if (fill < 0) return null;

  const fillTime = base[fill].openTime;
  const deadline = fillTime + horizonMs;
  const finish = (exitTime: number, exitPrice: number, reason: Outcome["reason"]): Outcome => {
    const gross = (dir * (exitPrice - plan.entry)) / risk;
    const cost = costR(plan, fillTime, exitTime);
    return {
      exitTime,
      exitPrice,
      reason,
      grossR: gross,
      costR: cost,
      netR: gross - cost,
      holdHours: (exitTime - fillTime) / 3_600_000,
      fillWaitHours: (fillTime - plan.entryTime) / 3_600_000,
    };
  };

  for (let i = fill; i < base.length; i++) {
    const candle = base[i];
    if (candle.openTime > deadline) return finish(candle.openTime, candle.open, "hết hạn");
    const hitStop = plan.side === "long" ? candle.low <= plan.sl : candle.high >= plan.sl;
    if (hitStop) return finish(candle.openTime + TF_MS["5m"], plan.sl, "sl");
    if (i === fill) continue; // nến khớp không được tính target
    const hitTarget = plan.side === "long" ? candle.high >= plan.tp : candle.low <= plan.tp;
    if (hitTarget) return finish(candle.openTime + TF_MS["5m"], plan.tp, "tp");
  }
  const last = base[base.length - 1];
  return finish(last.openTime + TF_MS["5m"], last.close, "hết dữ liệu");
}

function fmt(value: number, digits = 2): string {
  return (value >= 0 ? "+" : "") + value.toFixed(digits);
}

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? "250", 10);
  const bars = Math.ceil((days * TF_MS["1d"]) / TF_MS["5m"]);
  const manual = loadManualPlans();
  console.log(`Kế hoạch tay: ${manual.length} · tải ${days}d nến 5m ${SYMBOL.toUpperCase()}...`);
  const base = await fetchKlinesPaged(SYMBOL, "5m", bars);
  const first = base[0].openTime;
  const last = base[base.length - 1].openTime;
  console.log(
    `Nến 5m: ${base.length} · ${new Date(first).toISOString().slice(0, 16)}`
    + ` -> ${new Date(last).toISOString().slice(0, 16)}\n`,
  );

  const m15 = aggregate(base, "15m", "5m");
  const m15Atr = atrSeriesForward(m15, 14);
  const atrAt = (time: number): number => {
    let index = -1;
    for (let i = 0; i < m15.length && m15[i].openTime <= time; i++) index = i;
    return index >= 0 ? m15Atr[index] : 0;
  };

  // ── (a) 6 kế hoạch tay chạy thật ────────────────────────────────────────────
  console.log("═══ (a) KẾT QUẢ THẬT CỦA 6 KẾ HOẠCH TAY ═══");
  console.log(
    `${"#".padStart(2)} ${"chiều".padEnd(6)} ${"vào lúc".padEnd(17)}`
    + ` ${"R%".padStart(6)} ${"chờ(h)".padStart(7)} ${"thoát".padEnd(12)}`
    + ` ${"giữ(h)".padStart(7)} ${"gộp R".padStart(7)} ${"phí R".padStart(6)} ${"NET R".padStart(7)}`,
  );
  let netTotal = 0;
  let grossTotal = 0;
  let wins = 0;
  let counted = 0;
  for (const plan of manual) {
    const outcome = simulate(plan, base, MAX_HOLD_MS);
    if (!outcome) {
      console.log(
        `${String(plan.index).padStart(2)} ${plan.side.padEnd(6)}`
        + ` ${new Date(plan.entryTime).toISOString().slice(0, 16).replace("T", " ")}`
        + ` ${plan.riskPct.toFixed(2).padStart(5)}% KHÔNG KHỚP trong ${FILL_WAIT_MS / 3_600_000}h`,
      );
      continue;
    }
    counted += 1;
    grossTotal += outcome.grossR;
    netTotal += outcome.netR;
    if (outcome.netR > 0) wins += 1;
    console.log(
      `${String(plan.index).padStart(2)} ${plan.side.padEnd(6)}`
      + ` ${new Date(plan.entryTime).toISOString().slice(0, 16).replace("T", " ")}`
      + ` ${plan.riskPct.toFixed(2).padStart(5)}%`
      + ` ${outcome.fillWaitHours.toFixed(1).padStart(7)}`
      + ` ${outcome.reason.padEnd(12)}`
      + ` ${outcome.holdHours.toFixed(1).padStart(7)}`
      + ` ${fmt(outcome.grossR).padStart(7)}`
      + ` ${outcome.costR.toFixed(3).padStart(6)}`
      + ` ${fmt(outcome.netR).padStart(7)}`,
    );
  }
  if (counted) {
    console.log(
      `\n   n=${counted} · WR ${((100 * wins) / counted).toFixed(0)}%`
      + ` · gộp ${fmt(grossTotal)}R (${fmt(grossTotal / counted, 3)}/lệnh)`
      + ` · NET ${fmt(netTotal)}R (${fmt(netTotal / counted, 3)}/lệnh)`,
    );
    console.log(
      "   ⚠ n=6 KHÔNG kết luận được về lợi nhuận (SE ước lượng"
      + ` ±${(1.96 * 1.5 / Math.sqrt(counted)).toFixed(2)}R/lệnh nếu sd≈1,5R).`,
    );
  }

  // ── (b) detector có nhìn thấy chỗ user vẽ không ─────────────────────────────
  const runs = [
    { name: "production", params: { ...KEY_VOLUME_CONFIG } },
    { name: "bàn thử sạch", params: { ...KEY_VOLUME_CONFIG, ...CLEAN_BENCH } },
  ];
  for (const run of runs) {
    const result = runKeyVolume(SYMBOL, m15, run.params);
    console.log(`\n═══ (b) DETECTOR "${run.name}" ═══`);
    console.log(
      `   phễu: key 15m ${result.diagnostics.m15Levels} · key 1h ${result.diagnostics.h1Levels}`
      + ` · key 4h ${result.diagnostics.h4Levels} · plan ${result.diagnostics.plans}`
      + ` · vào lệnh ${result.diagnostics.entries}`
      + ` · loại vì risk ${result.diagnostics.rejectedRisk}`
      + ` · loại vì dư địa ${result.diagnostics.rejectedRoom}`,
    );
    console.log(
      `${"#".padStart(2)} ${"chiều".padEnd(6)} ${"ATR15".padStart(8)}`
      + ` ${"key 15m".padStart(8)} ${"key 1h".padStart(7)} ${"key 4h".padStart(7)}`
      + ` ${"PLAN ±4h".padStart(9)} ${"TRADE ±4h".padStart(10)}`,
    );
    let recallLevel15 = 0;
    let recallPlan = 0;
    let recallTrade = 0;
    const nearestPlans: { hours: number; atr: number }[] = [];
    for (const plan of manual) {
      const atr = atrAt(plan.entryTime);
      const tolerance = MATCH_ATR * atr;
      const nearLevel = (tf: KeyVolumeLevel["sourceTf"]): number =>
        result.levels.filter(
          (level) =>
            level.sourceTf === tf
            && isKeyVolumeLevelActive(level, plan.entryTime)
            && Math.min(
              Math.abs(plan.entry - level.zoneLow),
              Math.abs(plan.entry - level.zoneHigh),
              plan.entry >= level.zoneLow && plan.entry <= level.zoneHigh ? 0 : Infinity,
            ) <= tolerance,
        ).length;
      const l15 = nearLevel("15m");
      const l1h = nearLevel("1h");
      const l4h = nearLevel("4h");

      const windowMs = MATCH_BARS * TF_MS["5m"];
      const planHits = result.plans.filter((candidate) => {
        const time = base[candidate.readyIndex]?.openTime ?? 0;
        if (Math.abs(time - plan.entryTime) > windowMs) return false;
        if (candidate.direction !== plan.side) return false;
        const gap = plan.entry >= candidate.obLow && plan.entry <= candidate.obHigh
          ? 0
          : Math.min(Math.abs(plan.entry - candidate.obLow), Math.abs(plan.entry - candidate.obHigh));
        return gap <= tolerance;
      }).length;
      const tradeHits = result.trades.filter(
        (trade) =>
          Math.abs(trade.entryTime - plan.entryTime) <= windowMs && trade.dir === plan.side,
      ).length;

      // BIÊN PHÁT HIỆN cho kết luận 0/6: PLAN gần nhất cùng chiều cách bao xa?
      let nearest = { hours: Infinity, atr: Infinity };
      for (const candidate of result.plans) {
        if (candidate.direction !== plan.side) continue;
        const time = base[candidate.readyIndex]?.openTime ?? 0;
        const hours = Math.abs(time - plan.entryTime) / 3_600_000;
        if (hours > 24) continue;
        const gap = plan.entry >= candidate.obLow && plan.entry <= candidate.obHigh
          ? 0
          : Math.min(Math.abs(plan.entry - candidate.obLow), Math.abs(plan.entry - candidate.obHigh));
        const atrGap = atr > 0 ? gap / atr : Infinity;
        if (atrGap < nearest.atr) nearest = { hours, atr: atrGap };
      }
      nearestPlans.push(nearest);

      if (l15 > 0) recallLevel15 += 1;
      if (planHits > 0) recallPlan += 1;
      if (tradeHits > 0) recallTrade += 1;
      console.log(
        `${String(plan.index).padStart(2)} ${plan.side.padEnd(6)}`
        + ` ${atr.toFixed(1).padStart(8)}`
        + ` ${String(l15).padStart(8)} ${String(l1h).padStart(7)} ${String(l4h).padStart(7)}`
        + ` ${String(planHits).padStart(9)} ${String(tradeHits).padStart(10)}`,
      );
    }
    console.log(
      `   RECALL: mức key 15m ${recallLevel15}/${manual.length}`
      + ` · PLAN ${recallPlan}/${manual.length} · TRADE ${recallTrade}/${manual.length}`
      + ` (dung sai ±${MATCH_ATR}×ATR(M15), ±${MATCH_BARS} nến 5m)`,
    );

    const reachable = nearestPlans.filter((item) => Number.isFinite(item.atr));
    console.log(
      `   BIÊN PHÁT HIỆN cho "0/6": trong ±24h có PLAN cùng chiều ở ${reachable.length}/${manual.length} ca;`
      + ` lệch giá nhỏ nhất ${reachable.length ? `${Math.min(...reachable.map((item) => item.atr)).toFixed(2)}` : "—"} ATR`
      + ` (cần ≤ ${MATCH_ATR} mới tính là khớp)`,
    );

    // ĐỐI CHỨNG GIẢ: cùng phép đo "có key gần không" tại các điểm (thời gian, giá) TUỲ Ý.
    // Không có nó thì "6/6" chỉ đang đo MẬT ĐỘ key chứ không đo vị trí user vẽ.
    const nearCount = (time: number, price: number, tolerance: number): number =>
      result.levels.filter(
        (level) =>
          level.sourceTf === "15m"
          && isKeyVolumeLevelActive(level, time)
          && (price >= level.zoneLow && price <= level.zoneHigh
            ? true
            : Math.min(Math.abs(price - level.zoneLow), Math.abs(price - level.zoneHigh)) <= tolerance),
      ).length;
    let seed = 20260828;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const earliest = manual[0].entryTime;
    const pool = m15.filter((candle) => candle.openTime >= earliest);
    const placebo: number[] = [];
    for (let i = 0; i < 500; i++) {
      const candle = pool[Math.floor(random() * pool.length)];
      const atr = atrAt(candle.openTime);
      if (!(atr > 0)) continue;
      placebo.push(nearCount(candle.openTime, candle.close, MATCH_ATR * atr));
    }
    const realCounts = manual.map((plan) => nearCount(plan.entryTime, plan.entry, MATCH_ATR * atrAt(plan.entryTime)));
    const mid = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
    };
    const hitRate = (values: number[]): number =>
      (100 * values.filter((value) => value > 0).length) / values.length;
    console.log(
      `   ĐỐI CHỨNG GIẢ (${placebo.length} điểm (thời gian, giá) tuỳ ý cùng kỳ):`
      + ` tỉ lệ "có key 15m gần" ${hitRate(placebo).toFixed(1)}%`
      + ` · số key gần trung vị ${mid(placebo)}`,
    );
    console.log(
      `   6 điểm USER VẼ: tỉ lệ ${hitRate(realCounts).toFixed(1)}%`
      + ` · số key gần trung vị ${mid(realCounts)}`
      + ` ⇒ ${mid(realCounts) > mid(placebo) ? "cao hơn" : "KHÔNG cao hơn"} đối chứng`,
    );

    // ── (c) mẫu số R ──────────────────────────────────────────────────────────
    const risks = result.trades
      .map((trade) => (100 * Math.abs(trade.entryPrice - trade.initialSL)) / trade.entryPrice)
      .sort((a, b) => a - b);
    const manualRisks = manual.map((plan) => plan.riskPct).sort((a, b) => a - b);
    const median = (values: number[]): number =>
      values.length ? values[Math.floor(values.length / 2)] : NaN;
    console.log(
      `   (c) R trung vị — code ${risks.length ? `${median(risks).toFixed(3)}% (n=${risks.length})` : "không có lệnh"}`
      + ` vs tay ${median(manualRisks).toFixed(3)}%`
      + (risks.length ? ` ⇒ lệch ${(median(manualRisks) / median(risks)).toFixed(1)}×` : ""),
    );
  }
}

main().catch((error: unknown) => {
  console.error("Lỗi:", error);
  process.exit(1);
});
