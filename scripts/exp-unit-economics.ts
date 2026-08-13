/**
 * exp-unit-economics.ts — bốn trục BÊN TRONG phương pháp mà repo chưa từng quét.
 *
 * Vòng trước chỉ tìm được thay đổi ở tầng phân bổ vốn (heat-decay cho Fast), không tìm được cải tiến
 * LUẬT nào. Bốn trục dưới đây khác các trục đã loại ở chỗ chúng không thêm bộ lọc và không thêm chỉ
 * báo — chúng chỉnh lại kinh tế học của những unit hệ VỐN ĐÃ vào:
 *
 *   E0 CƠ CHẾ   — expectancy theo THỨ TỰ unit. Chẩn đoán 365d cho thấy unit#2 (exp 0,253) tốt hơn
 *                 unit#0 (0,120). Nếu đúng trên toàn kỳ và cả ba era thì tỉ trọng risk đang bị đặt
 *                 SAI CHỖ: Turtle gốc chia đều vì năm 1983 không có cách nào đo, nay thì có.
 *   E1 TỈ TRỌNG THEO UNIT — dồn risk về phía unit sau (giữ TỔNG risk không đổi). Kèm hồ sơ ĐẢO
 *                 (dồn về unit đầu) làm placebo: nếu cả hai chiều cùng tốt thì thứ hoạt động không
 *                 phải là thứ tự unit.
 *   E2 MẪU SỐ R — `chandelierMult` trong turtle.ts làm HAI việc: khoảng stop ban đầu (mẫu số của mọi
 *                 R) và khoảng trail Chandelier của SHORT. Mọi lần quét trước đổi cả hai cùng lúc nên
 *                 ảnh hưởng riêng của MẪU SỐ chưa bao giờ được đo. Nay tách bằng `initialStopMult`.
 *                 Đây là trục tác động THẲNG vào Net R: R nhỏ hơn ⇒ mỗi winner đếm được nhiều R hơn,
 *                 đổi lại nhiều lần bị quét stop hơn và phí chiếm phần lớn hơn mỗi R.
 *   E3 TRẦN UNIT — 4→3 được chốt 04/08 bằng Sharpe. Chấm lại bằng TIỀN ở cùng maxDD.
 *   E4 BƯỚC PYRAMID — trước chỉ quét chiều CHẬM LẠI (0,75–1,5×ATR). Chiều NHANH LÊN chưa ai đo.
 *
 * Chấm điểm: vốn cuối kỳ khi ép mọi biến thể về cùng maxDD + Sharpe + ba era + 56 cửa sổ 365d.
 * Nhận: phải có CAO NGUYÊN, cả ba era không xấu đi, và placebo phải xấu.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-unit-economics.ts [e0|e1|e2|e3|e4|all] [days]
 */
import { TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];
const TARGET_DD = 0.3;

function dailySeries(res: PortfolioResult, from: number, to: number): number[] {
  const m = new Map<number, number>();
  for (let i = 1; i < res.equity.length; i++) {
    const d = Math.floor(res.equity[i].time / DAY);
    m.set(d, (m.get(d) ?? 0) + (res.equity[i].mtm - res.equity[i - 1].mtm));
  }
  const out: number[] = [];
  for (let d = Math.floor(from / DAY); d <= Math.floor(to / DAY); d++) out.push(m.get(d) ?? 0);
  return out;
}

function riskForDD(series: number[], target: number): number {
  const dd = (rho: number) => {
    let e = 1, peak = 1, m = 0;
    for (const r of series) {
      e *= 1 + rho * r;
      if (e <= 0) return 1;
      peak = Math.max(peak, e);
      m = Math.max(m, (peak - e) / peak);
    }
    return m;
  };
  let lo = 1e-5, hi = 0.5;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (dd(mid) > target) hi = mid; else lo = mid; }
  return lo;
}

const sharpeOf = (s: number[]) => {
  const mean = s.reduce((a, x) => a + x, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / (s.length - 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
};

type Win = ReturnType<typeof coreWindow>;

/** Một dòng kết quả chuẩn hoá theo maxDD. */
function score(res: PortfolioResult, w: Win) {
  const s = dailySeries(res, w.from, w.to);
  const rho = riskForDD(s, TARGET_DD);
  let e = 1;
  for (const x of s) e *= 1 + rho * x;
  const eras = w.eras.map((era) => {
    const a = Math.floor(era.from / DAY) - Math.floor(w.from / DAY);
    const b = Math.floor(era.to / DAY) - Math.floor(w.from / DAY);
    let v = 1;
    for (let i = Math.max(0, a); i < Math.min(s.length, b); i++) v *= 1 + rho * s[i];
    return v;
  });
  let e365 = 1;
  for (let i = Math.max(0, s.length - 365); i < s.length; i++) e365 *= 1 + rho * s[i];
  const wf: number[] = [];
  for (let end = 365; end <= s.length; end += 30) wf.push(sharpeOf(s.slice(end - 365, end)));
  return {
    mult: e,
    sharpe: sharpeOf(s),
    netR: s.reduce((a, x) => a + x, 0),
    eras,
    e365,
    wfAvg: wf.reduce((a, x) => a + x, 0) / wf.length,
    wfNeg: wf.filter((x) => x < 0).length,
    units: res.trades.length,
    positions: new Set(res.trades.map((t) => `${t.book}#${t.positionId}`)).size,
  };
}

const HEADER = "biến thể                     unit  vịthế   Sharpe   VỐN(×)   era A/B/C (×)         365d(×)   WF TB   WF âm";
function printRow(label: string, r: ReturnType<typeof score>, baseMult?: number) {
  const delta = baseMult ? ` ${(((r.mult - baseMult) / baseMult) * 100 >= 0 ? "+" : "")}${(((r.mult - baseMult) / baseMult) * 100).toFixed(0)}%` : "";
  console.log(
    `${label.padEnd(28)} ${String(r.units).padStart(5)} ${String(r.positions).padStart(6)}   ${r.sharpe.toFixed(2).padStart(6)}   ` +
      `${r.mult.toFixed(2).padStart(6)}   ${r.eras.map((x) => x.toFixed(2)).join(" / ").padEnd(20)}   ${r.e365.toFixed(2).padStart(6)}   ` +
      `${r.wfAvg.toFixed(2)}   ${String(r.wfNeg).padStart(4)}${delta}`,
  );
}

async function main() {
  const which = (process.argv[2] ?? "all").toLowerCase();
  const days = parseInt(process.argv[3] ?? "2300", 10);
  const data = await loadPool(days, CORE8);
  const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  const heat: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / T.heatDecayK);
  const bk = (p: ExtParams): Book[] => [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
  const SLEEVES: [string, ExtParams][] = [["TURTLE", turtle], ["FAST", fast]];
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · maxDD ép về ${(TARGET_DD * 100).toFixed(0)}% · heat k=${T.heatDecayK}\n`);

  // ───────── E0: expectancy theo thứ tự unit (cơ chế) ─────────
  if (which === "all" || which === "e0") {
    console.log("=".repeat(110));
    console.log("  E0 — EXPECTANCY THEO THỨ TỰ UNIT (toàn kỳ + từng era). Có thật là unit sau tốt hơn?");
    console.log("=".repeat(110));
    for (const [name, p] of SLEEVES) {
      const res = runBooks(bk(p), heat);
      console.log(`\n${name}`);
      console.log("unit#   số unit   NET R    exp/unit   |   exp era A / B / C   |   WR%");
      for (let idx = 0; idx < T.pyramidMaxUnits; idx++) {
        const ts = res.trades.filter((t) => t.unitIndex === idx && t.entryTime >= w.from && t.entryTime <= w.to);
        if (!ts.length) continue;
        const netW = ts.reduce((s, t) => s + t.netR * t.weight, 0);
        const wt = ts.reduce((s, t) => s + t.weight, 0);
        const eraExp = w.eras.map((era) => {
          const e = ts.filter((t) => t.entryTime >= era.from && t.entryTime < era.to);
          const ew = e.reduce((s, t) => s + t.weight, 0);
          return ew ? (e.reduce((s, t) => s + t.netR * t.weight, 0) / ew).toFixed(3) : "—";
        });
        const wr = (ts.filter((t) => t.netR > 0).length / ts.length) * 100;
        console.log(
          `  ${idx}   ${String(ts.length).padStart(6)}   ${netW.toFixed(1).padStart(6)}   ${(netW / wt).toFixed(3).padStart(8)}   |   ` +
            `${eraExp.join(" / ").padEnd(22)}|  ${wr.toFixed(0)}%`,
        );
      }
    }
    console.log();
  }

  // ───────── E1: tỉ trọng risk theo thứ tự unit ─────────
  if (which === "all" || which === "e1") {
    // hồ sơ đã chuẩn hoá tổng = 3 ⇒ TỔNG risk mỗi vị thế đầy đủ không đổi
    const PROFILES: [string, number[]][] = [
      ["đều 1/1/1 (đang chạy)", [1, 1, 1]],
      ["tăng nhẹ 0,8/1,0/1,2", [0.8, 1.0, 1.2]],
      ["tăng mạnh 0,6/1,0/1,4", [0.6, 1.0, 1.4]],
      ["tăng rất mạnh 0,4/1,0/1,6", [0.4, 1.0, 1.6]],
      ["PLACEBO giảm 1,2/1,0/0,8", [1.2, 1.0, 0.8]],
      ["PLACEBO giảm mạnh 1,6/1,0/0,4", [1.6, 1.0, 0.4]],
    ];
    for (const [name, p] of SLEEVES) {
      console.log("=".repeat(110));
      console.log(`  E1 ${name} — TỈ TRỌNG RISK THEO THỨ TỰ UNIT (tổng risc mỗi vị thế giữ nguyên)`);
      console.log("=".repeat(110));
      console.log(HEADER);
      console.log("-".repeat(110));
      let base = 0;
      for (const [label, prof] of PROFILES) {
        const admit: AdmitFn = (c) => {
          const idx = Math.min(prof.length - 1, c.open.filter((u) => u.symbol === c.symbol).length);
          return heat(c) * prof[idx];
        };
        const r = score(runBooks(bk(p), admit), w);
        if (!base) base = r.mult;
        printRow(label, r, base === r.mult ? undefined : base);
      }
      console.log();
    }
  }

  // ───────── E2: mẫu số R (initial stop) tách khỏi chandelier ─────────
  if (which === "all" || which === "e2") {
    for (const [name, p] of SLEEVES) {
      console.log("=".repeat(110));
      console.log(`  E2 ${name} — HỆ SỐ ATR CỦA STOP BAN ĐẦU (mẫu số R), Chandelier SHORT giữ nguyên ${T.chandelierMult}`);
      console.log("=".repeat(110));
      console.log(HEADER);
      console.log("-".repeat(110));
      let base = 0;
      for (const m of [1.5, 2.0, 2.5, 3.0, 3.5, 4.0]) {
        const r = score(runBooks(bk({ ...p, initialStopMult: m }), heat), w);
        if (m === 3.0) base = r.mult;
        printRow(`${m.toFixed(1)}×ATR${m === 3.0 ? " (đang chạy)" : ""}`, r);
      }
      console.log(`(mốc so sánh = 3,0×ATR: ${base.toFixed(2)}×)\n`);
    }
  }

  // ───────── E3: trần unit, chấm bằng tiền ─────────
  if (which === "all" || which === "e3") {
    for (const [name, p] of SLEEVES) {
      console.log("=".repeat(110));
      console.log(`  E3 ${name} — TRẦN UNIT (04/08 chốt 3 bằng Sharpe; đây là chấm lại bằng TIỀN cùng maxDD)`);
      console.log("=".repeat(110));
      console.log(HEADER);
      console.log("-".repeat(110));
      for (const u of [1, 2, 3, 4, 5, 6]) {
        const r = score(runBooks(bk({ ...p, pyramidMaxUnits: u }), heat), w);
        printRow(`tối đa ${u} unit${u === 3 ? " (đang chạy)" : ""}`, r);
      }
      console.log();
    }
  }

  // ───────── E4: bước pyramid, chiều NHANH LÊN ─────────
  if (which === "all" || which === "e4") {
    for (const [name, p] of SLEEVES) {
      console.log("=".repeat(110));
      console.log(`  E4 ${name} — BƯỚC PYRAMID (trước chỉ quét 0,75–1,5; đây thêm chiều nhanh hơn)`);
      console.log("=".repeat(110));
      console.log(HEADER);
      console.log("-".repeat(110));
      for (const st of [0.2, 0.3, 0.4, 0.5, 0.75, 1.0]) {
        const r = score(runBooks(bk({ ...p, pyramidStepAtr: st }), heat), w);
        printRow(`${st.toFixed(2)}×ATR${st === 0.5 ? " (đang chạy)" : ""}`, r);
      }
      console.log();
    }
  }
}

if (require.main === module && /exp-unit-economics\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
