/**
 * exp-portfolio-caps.ts — Chính sách RỦI RO CẤP DANH MỤC cho Turtle (mục A3 của remediation plan,
 * nhưng chấm bằng metric đúng).
 *
 * CÂU HỎI: engine hiện tại cho phép tối đa 8 symbol × 4 unit = 32 unit CÙNG HƯỚNG trên một rổ
 * crypto có tương quan ~0,8-0,9. Đó thực chất là MỘT cược lớn chứ không phải 32 cược độc lập.
 * Vậy phân bổ risk theo số unit đang mở cùng hướng có cải thiện được lợi nhuận TẠI CÙNG MỨC RỦI RO?
 *
 * METRIC: risk/unit là env var tự do nên NET R thô không so được. Dùng
 *   - Sharpe (P&L ngày, annualized) — bất biến đòn bẩy, dùng TOÀN BỘ dữ liệu (không phải 1 cực trị)
 *   - NET/Ulcer, NET/maxDD — bất biến đòn bẩy
 *   - "NET tđ" = NET × (maxDD_baseline / maxDD_variant): NET đạt được nếu chỉnh đòn bẩy về cùng DD
 * Gate: phải thắng ở CẢ 3 ERA và tạo plateau, không phải một điểm tham số.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-portfolio-caps.ts [days]
 */
import { TF_MS } from "../strategy";
import { T, TurtleParams } from "../turtle";
import { AdmitFn, portfolioStats, riskMetrics, runTurtlePortfolio } from "./portfolio-engine";
import { buildGate, loadBasket } from "./portfolio-equivalence";

const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface Policy {
  label: string;
  admit?: AdmitFn;
}

/** Trần cứng theo risk cùng hướng (unit thứ K+1 bị bỏ). */
export const hardCap = (k: number): Policy => ({
  label: `hard cap ${k}`,
  admit: (c) => (c.sameDirHeat < k ? 1 : 0),
});

/** Trần "mềm": unit ở biên vào với size lẻ thay vì bị bỏ hẳn. */
export const softCap = (k: number): Policy => ({
  label: `soft cap ${k}`,
  admit: (c) => Math.max(0, Math.min(1, k - c.sameDirHeat)),
});

/** Suy giảm điều hoà: w = 1/(1 + heat/k). Không bao giờ bỏ lệnh → luôn có mặt ở trend lớn. */
export const decayH = (k: number): Policy => ({
  label: `decay 1/(1+h/${k})`,
  admit: (c) => 1 / (1 + c.sameDirHeat / k),
});

/** Suy giảm căn bậc hai (điều chỉnh tương quan cổ điển): w = 1/sqrt(1 + heat/k). */
export const decaySqrt = (k: number): Policy => ({
  label: `decay 1/√(1+h/${k})`,
  admit: (c) => 1 / Math.sqrt(1 + c.sameDirHeat / k),
});

/** Suy giảm theo TỔNG heat hai hướng (long/short không bù trừ). */
export const decayTotal = (k: number): Policy => ({
  label: `decayTot 1/(1+H/${k})`,
  admit: (c) => 1 / (1 + c.totalHeat / k),
});

/**
 * VOL-TARGET CÓ TƯƠNG QUAN — bản "đúng lý thuyết": coi mỗi symbol là một exposure có dấu,
 * rủi ro danh mục = √(xᵀΣx) với Σ tương quan đồng nhất ρ (trong cùng symbol ρ=1).
 *   xᵀΣx = (1−ρ)·Σ x_s² + ρ·(Σ x_s)²
 * Unit mới nhận size lớn nhất trong [0,1] sao cho rủi ro danh mục ≤ target H.
 * → long và short TỰ ĐỘNG bù trừ; nhồi thêm vào symbol đã có vị thế bị phạt nặng hơn coin mới.
 */
export const volTarget = (H: number, rho: number): Policy => ({
  label: `volTarget H=${H} ρ=${rho}`,
  admit: (c) => {
    const x = new Map<string, number>();
    for (const u of c.open) x.set(u.symbol, (x.get(u.symbol) ?? 0) + (u.dir === "long" ? u.weight : -u.weight));
    const sign = c.dir === "long" ? 1 : -1;
    const risk = (w: number) => {
      let sumSq = 0,
        sum = 0;
      const xs = new Map(x);
      xs.set(c.symbol, (xs.get(c.symbol) ?? 0) + sign * w);
      for (const v of xs.values()) {
        sumSq += v * v;
        sum += v;
      }
      return Math.sqrt(Math.max(0, (1 - rho) * sumSq + rho * sum * sum));
    };
    if (risk(1) <= H) return 1;
    if (risk(0) >= H) return 0;
    let lo = 0,
      hi = 1;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (risk(mid) <= H) lo = mid;
      else hi = mid;
    }
    return lo;
  },
});

export async function setupBasket(days: number) {
  const data = await loadBasket(days);
  const gate = await buildGate(data, days);
  const p: TurtleParams = { ...T, gate };
  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const warmup =
    Math.max(Math.round(T.entryDays * bpd), Math.round(T.shortEntryDays * bpd), T.trendLen, T.atrPeriod) + 1;
  let from = -Infinity,
    to = Infinity;
  for (const c of data.values()) {
    from = Math.max(from, c[Math.min(warmup, c.length - 1)].openTime);
    to = Math.min(to, c[c.length - 1].openTime);
  }
  const eras = [0, 1, 2].map((k) => ({
    name: ["A", "B", "C"][k],
    from: from + ((to - from) * k) / 3,
    to: from + ((to - from) * (k + 1)) / 3,
  }));
  return { data, p, from, to, eras };
}

export function evaluate(
  data: Map<string, import("../strategy").Candle[]>,
  p: TurtleParams,
  pol: Policy,
  from: number,
  to: number,
  eras: { name: string; from: number; to: number }[],
) {
  const res = runTurtlePortfolio(data, p, pol.admit);
  const eq = res.equity.filter((e) => e.time >= from && e.time <= to);
  const rm = riskMetrics(eq);
  const st = portfolioStats(res, { from, to });
  const eraRm = eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
  return { res, rm, st, eraRm };
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  const { data, p, from, to, eras } = await setupBasket(days);
  const spanDays = (to - from) / TF_MS["1d"];
  console.log(`Cửa sổ chung: ${fmtD(from)} → ${fmtD(to)} (${spanDays.toFixed(0)} ngày, ${data.size} symbol)`);
  console.log(`Era: A ${fmtD(eras[0].from)}→${fmtD(eras[0].to)} | B ${fmtD(eras[1].from)}→${fmtD(eras[1].to)} | C ${fmtD(eras[2].from)}→${fmtD(eras[2].to)}\n`);

  const policies: Policy[] = [
    { label: "BASELINE" },
    ...[8, 12, 20].map(hardCap),
    ...[0.5, 1, 1.5, 2, 3, 4, 6, 8, 12].map(decayH),
    ...[2, 4, 8].map(decayTotal),
    ...[1, 1.5, 2, 3, 4, 6].map((h) => volTarget(h, 0.8)),
    ...[2, 3, 4].map((h) => volTarget(h, 0.6)),
    ...[2, 3, 4].map((h) => volTarget(h, 0.9)),
  ];

  let base: ReturnType<typeof evaluate> | null = null;
  console.log("Chính sách           unit   NET R  Sharpe  Sort  Ulcer NET/Ulc  maxDD NET/DD   NETtđ  skew wMonth | SharpeA  B     C");
  console.log("-".repeat(126));
  for (const pol of policies) {
    const ev = evaluate(data, p, pol, from, to, eras);
    if (!base) base = ev;
    const equiv = ev.rm.netR * (base.rm.maxDD / ev.rm.maxDD);
    console.log(
      pol.label.padEnd(20) +
        String(ev.st.n).padStart(5) +
        ev.rm.netR.toFixed(0).padStart(8) +
        ev.rm.sharpe.toFixed(2).padStart(8) +
        ev.rm.sortino.toFixed(2).padStart(6) +
        ev.rm.ulcer.toFixed(1).padStart(7) +
        ev.rm.netOverUlcer.toFixed(1).padStart(8) +
        ev.rm.maxDD.toFixed(0).padStart(7) +
        ev.rm.netOverMaxDD.toFixed(2).padStart(7) +
        equiv.toFixed(0).padStart(8) +
        ev.rm.skew.toFixed(2).padStart(6) +
        ev.rm.worstMonthR.toFixed(0).padStart(7) +
        " |" +
        ev.eraRm.map((e) => e.sharpe.toFixed(2).padStart(7)).join(""),
    );
  }
  console.log("-".repeat(126));
  console.log("NETtđ = NET nếu chỉnh đòn bẩy cho maxDD bằng BASELINE. Quyết định theo Sharpe + ổn định 3 era + plateau.");
}

if (require.main === module) main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
