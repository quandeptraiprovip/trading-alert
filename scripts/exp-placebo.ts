/**
 * exp-placebo.ts — "Có overfit không?" trả lời bằng THỰC NGHIỆM, không bằng lập luận.
 *
 * Vấn đề: nghiên cứu 2026-08 đã thử ~100 biến thể. Với ngần ấy lần bốc, một biến thể có
 * ΔSharpe = +0,25 hoàn toàn có thể chỉ là con may mắn nhất. Sai số chuẩn của ΔSharpe (paired
 * bootstrap) ≈ 0,145 — nghĩa là max của ~100 lần bốc dưới giả thuyết KHÔNG-CÓ-EDGE cũng cỡ +0,3.
 * Bootstrap một mình KHÔNG phân biệt được hai khả năng đó.
 *
 * Ba phép placebo dưới đây phân biệt được, vì chúng đo TRỰC TIẾP phân phối ΔSharpe dưới null:
 *
 *  P1. CHÍNH SÁCH RISK GIẢ. Vẫn nhỏ size y hệt (cùng phân phối biên của tỉ trọng), nhưng gán
 *      NGẪU NHIÊN — không phụ thuộc mức đông đúc. Nếu P1 cũng cải thiện thì lợi ích chỉ đến từ
 *      "size dao động", không phải từ việc ổn định rủi ro danh mục.
 *      (Lưu ý: nhỏ size ĐỀU thì Sharpe bất biến, nên phép này không thể ăn gian bằng giảm đòn bẩy.)
 *  P2. HEAT SAI CHIỀU. Dùng heat của chiều NGƯỢC LẠI. Cùng công thức, cùng độ dao động, sai biến số.
 *  P3. THAM SỐ BỐC NGẪU NHIÊN. longExitDays ~ U{8..60}, maxUnits ~ U{1..6}, 60 lần bốc.
 *      Bao nhiêu % lần bốc bừa cũng đạt ΔSharpe ≥ bản đang ship? Đây chính là p-value đã tính cả
 *      chi phí tìm kiếm — thứ mà CI của bootstrap không tính.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-placebo.ts [days]
 */
import { TF_MS } from "../strategy";
import { T, TurtleParams } from "../turtle";
import { AdmitFn, EquityPoint, riskMetrics, runTurtlePortfolio } from "./portfolio-engine";
import { buildGate, loadBasket } from "./portfolio-equivalence";

const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** PRNG tất định để kết quả tái lập được. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  const data = await loadBasket(days);
  const gate = await buildGate(data, days);

  const BEFORE: TurtleParams = { ...T, gate, longExitDays: 0, pyramidMaxUnits: 4 };
  const SHIPPED: TurtleParams = { ...T, gate };
  const heatDecay: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / T.heatDecayK);

  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const warmup = Math.max(Math.round(T.shortEntryDays * bpd), Math.round(60 * bpd), T.trendLen, T.atrPeriod) + 1;
  let from = -Infinity, to = Infinity;
  for (const c of data.values()) {
    from = Math.max(from, c[Math.min(warmup, c.length - 1)].openTime);
    to = Math.min(to, c[c.length - 1].openTime);
  }
  console.log(`Cửa sổ ${fmtD(from)} → ${fmtD(to)}\n`);

  const sharpeOf = (eq: EquityPoint[]) => riskMetrics(eq.filter((e) => e.time >= from && e.time <= to)).sharpe;
  const run = (p: TurtleParams, a?: AdmitFn) => sharpeOf(runTurtlePortfolio(data, p, a).equity);

  const base = run(BEFORE);
  const shipped = run(SHIPPED, heatDecay);
  const shippedDelta = shipped - base;
  console.log(`TRƯỚC          : Sharpe ${base.toFixed(3)}`);
  console.log(`ĐANG SHIP      : Sharpe ${shipped.toFixed(3)}  → ΔSharpe ${shippedDelta.toFixed(3)}\n`);

  // ── P1: chính sách risk GIẢ (cùng phân phối tỉ trọng, gán ngẫu nhiên) ──
  // Thu thập phân phối heat thật, rồi phát lại theo thứ tự XÁO TRỘN.
  const observed: number[] = [];
  runTurtlePortfolio(data, SHIPPED, (c) => {
    observed.push(c.sameDirHeat);
    return 1 / (1 + c.sameDirHeat / T.heatDecayK);
  });
  console.log(`── P1. CHÍNH SÁCH RISK GIẢ (n=${observed.length} tỉ trọng, cùng phân phối, gán ngẫu nhiên) ──`);
  const p1: number[] = [];
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed * 7919);
    const shuffled = [...observed];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let k = 0;
    p1.push(run(SHIPPED, () => 1 / (1 + shuffled[k++ % shuffled.length] / T.heatDecayK)) - base);
  }
  p1.sort((a, b) => a - b);
  console.log(`   [kèm exit20+u3] ΔSharpe: median ${p1[20].toFixed(3)} · p05 ${p1[2].toFixed(3)} · p95 ${p1[37].toFixed(3)} · max ${p1[39].toFixed(3)}`);
  console.log(`   ≥ bản ship (${shippedDelta.toFixed(3)}): ${p1.filter((d) => d >= shippedDelta).length}/40`);

  // P1b — TÁCH BẠCH: chỉ chính sách risk, KHÔNG kèm exit20/u3. So "giảm size ngẫu nhiên" với
  // "giảm size theo heat" trên cùng một bộ tham số. Đây mới là phép phân biệt sạch.
  const policyOnly = run(BEFORE, heatDecay) - base;
  const p1b: number[] = [];
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed * 104729);
    const shuffled = [...observed];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let k = 0;
    p1b.push(run(BEFORE, () => 1 / (1 + shuffled[k++ % shuffled.length] / T.heatDecayK)) - base);
  }
  p1b.sort((a, b) => a - b);
  console.log(`   [CHỈ policy]    ΔSharpe: median ${p1b[20].toFixed(3)} · p05 ${p1b[2].toFixed(3)} · p95 ${p1b[37].toFixed(3)} · max ${p1b[39].toFixed(3)}`);
  console.log(`   ≥ heat thật (${policyOnly.toFixed(3)}): ${p1b.filter((d) => d >= policyOnly).length}/40\n`);

  // ── P2: heat SAI CHIỀU ──
  const p2 = run(SHIPPED, (c) => 1 / (1 + (c.totalHeat - c.sameDirHeat) / T.heatDecayK)) - base;
  const p2b = run({ ...BEFORE }, (c) => 1 / (1 + (c.totalHeat - c.sameDirHeat) / T.heatDecayK)) - base;
  console.log("── P2. HEAT SAI CHIỀU (dùng heat chiều ngược lại) ──");
  console.log(`   kèm exit20+u3 : ΔSharpe ${p2.toFixed(3)}   (bản đúng chiều: ${shippedDelta.toFixed(3)})`);
  console.log(`   chỉ policy    : ΔSharpe ${p2b.toFixed(3)}   (bản đúng chiều: ${(run(BEFORE, heatDecay) - base).toFixed(3)})\n`);

  // ── P3: tham số BỐC NGẪU NHIÊN ──
  console.log("── P3. THAM SỐ BỐC NGẪU NHIÊN — longExitDays ~ U{8..60}, maxUnits ~ U{1..6}, 60 lần bốc ──");
  const r3 = rng(20260804);
  const p3: { d: number; ex: number; mu: number }[] = [];
  for (let i = 0; i < 60; i++) {
    const ex = 8 + Math.floor(r3() * 53);
    const mu = 1 + Math.floor(r3() * 6);
    p3.push({ d: run({ ...SHIPPED, longExitDays: ex, pyramidMaxUnits: mu }, heatDecay) - base, ex, mu });
  }
  const ds = p3.map((x) => x.d).sort((a, b) => a - b);
  const beat = p3.filter((x) => x.d >= shippedDelta).length;
  console.log(`   ΔSharpe: median ${ds[30].toFixed(3)} · p05 ${ds[3].toFixed(3)} · p95 ${ds[57].toFixed(3)} · max ${ds[59].toFixed(3)}`);
  console.log(`   ≥ bản ship (${shippedDelta.toFixed(3)}): ${beat}/60  →  p ≈ ${((beat + 1) / 61).toFixed(3)} (đã tính chi phí tìm kiếm)`);
  console.log(`   Top 3 lần bốc: ${p3.sort((a, b) => b.d - a.d).slice(0, 3).map((x) => `exit${x.ex}d/u${x.mu} ${x.d.toFixed(3)}`).join(" · ")}`);

  console.log("\n── ĐỌC KẾT QUẢ ──");
  console.log("P1/P2 gần 0  ⇒ lợi ích đến từ ĐÚNG biến số (mức đông đúc cùng hướng), không phải từ việc size dao động.");
  console.log("P3 p nhỏ     ⇒ không phải cứ bốc bừa tham số cũng ra được mức cải thiện này.");
  console.log("P3 p lớn     ⇒ CẢNH BÁO: mức cải thiện nằm trong tầm với của tìm kiếm mù ⇒ coi như overfit.");
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
