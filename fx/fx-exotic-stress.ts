/**
 * fx-exotic-stress.ts — sau khi tính đúng carry, ngoại vi còn Sharpe ~0,3. Trước khi coi đó là một
 * ứng viên, phải tra tấn nó bằng đúng những thứ đã giết mọi ứng viên trước, cộng ba thứ chỉ riêng
 * nhóm ngoại vi mới có:
 *
 *   1. TẬP TRUNG. Cùng phép kiểm đã giết rổ hàng hoá (ở đó 66% lợi nhuận nằm trong một năm).
 *      Ở đây thêm chiều thứ hai: bao nhiêu phần là USDTRY, tức một lệnh "short lira" duy nhất
 *      kéo dài 22 năm?
 *   2. MARKUP SWAP THẬT. 1%/năm là mức của G10. Broker bán lẻ tính swap ngoại vi đắt hơn nhiều;
 *      quét 1 / 3 / 5%/năm mỗi chiều.
 *   3. SPREAD KHỦNG HOẢNG. Spread trung vị đo được (0,07% với USDTRY) là spread ngày thường. Đúng
 *      những ngày luật này kiếm tiền — 08/2018, 11–12/2021 — spread giãn nhiều lần, margin bị nâng,
 *      và một số broker NGỪNG nhận lệnh. Quét spread ×1 / ×3 / ×5.
 *
 * Chạy: npx ts-node fx/fx-exotic-stress.ts
 */

import fs from "fs";
import path from "path";
import { CONFIG, Candle } from "../strategy";
import { T } from "../turtle";
import { PortfolioResult } from "../scripts/portfolio-engine";
import { books, decayH, evaluate, windowOf } from "../scripts/rx-lab";
import { fxCostParams, loadDaily, loadUniverse } from "./fx-transfer";
import { atSpeed } from "./fx-speed";
import { EXOTICS, EXOTICS6 } from "./fx-exotic";

const rates: Record<string, Record<string, number>> =
  JSON.parse(fs.readFileSync(path.join(process.cwd(), ".cache", "fx", "rates.json"), "utf8"));

const SPEED = 5.33; // tốc độ TỐT NHẤT sau hiệu chỉnh carry — cố tình chọn mức có lợi nhất cho ứng viên
const heat = decayH(T.heatDecayK);

function rateAt(ccy: string, ms: number): number | undefined {
  const m = rates[ccy];
  if (!m) return undefined;
  const d = new Date(ms);
  for (let k = 0; k < 6; k++) {
    const key = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)).toISOString().slice(0, 7);
    if (m[key] !== undefined) return m[key];
  }
  return undefined;
}

/** netR đã hiệu chỉnh carry, theo TỪNG lệnh. */
function withCarry(res: PortfolioResult, markup: number) {
  return res.trades.map((t) => {
    const rb = rateAt(t.symbol.slice(0, 3), t.entryTime), rq = rateAt(t.symbol.slice(3, 6), t.entryTime);
    let c = 0;
    if (rb !== undefined && rq !== undefined) {
      const net = (t.dir === "long" ? rb - rq : rq - rb) - markup;
      const days = (t.exitTime - t.entryTime) / 86400e3;
      c = (net / 100) * (days / 365) * (t.entryPrice / Math.abs(t.entryPrice - t.initialSL));
    }
    return { ...t, adjR: (t.netR + c) * t.weight };
  });
}

function build(spreadMult: number) {
  return EXOTICS.flatMap((s) => {
    const candles = loadDaily(s);
    const c = fxCostParams(candles);
    return books(new Map([[s, candles as Candle[]]]), {
      ...atSpeed(SPEED), takerFeePct: c.takerFeePct * spreadMult, slippagePct: c.slippagePct * spreadMult,
    }, `sp${spreadMult}`);
  });
}

async function main() {
  CONFIG.costs.fundingPer8hPct = 0; // carry được tính riêng, không để engine tính hằng số
  const w = windowOf(loadUniverse(EXOTICS), 60 * 8);
  const res = evaluate("base", build(1), heat, w).res;

  // ── 1. Tập trung ──
  console.log(`═══ §1. TẬP TRUNG (s=${SPEED}, markup 1%/năm) ═══`);
  const tr = withCarry(res, 1);
  const tot = tr.reduce((s, t) => s + t.adjR, 0);
  const bySym = new Map<string, number>(), byYear = new Map<number, number>();
  for (const t of tr) {
    bySym.set(t.symbol, (bySym.get(t.symbol) ?? 0) + t.adjR);
    const y = new Date(t.exitTime).getUTCFullYear();
    byYear.set(y, (byYear.get(y) ?? 0) + t.adjR);
  }
  console.log(`Tổng sau carry: ${tot.toFixed(0)}R`);
  for (const [s, v] of [...bySym.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${v.toFixed(0).padStart(5)}R = ${(v / tot * 100).toFixed(0)}% tổng`);
  }
  const yrs = [...byYear.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  Năm tốt nhất ${yrs[0][0]}: ${yrs[0][1].toFixed(0)}R = ${(yrs[0][1] / tot * 100).toFixed(0)}% tổng`);
  console.log(`  Hai năm tốt nhất: ${((yrs[0][1] + yrs[1][1]) / tot * 100).toFixed(0)}% tổng`);
  console.log(`  BỎ năm tốt nhất → ${(tot - yrs[0][1]).toFixed(0)}R trên ${yrs.length - 1} năm`);
  console.log(`  Chuỗi năm: ${[...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([y, v]) => `${y}:${v.toFixed(0)}`).join(" ")}`);

  // ── 1b. Cả 6 đồng ngoại vi: hiệu ứng LỚP tài sản hay chỉ Thổ Nhĩ Kỳ? ──
  console.log(`\n═══ §1b. MỞ RỘNG 6 ĐỒNG NGOẠI VI — đóng góp của TỪNG công cụ ═══`);
  const w6 = windowOf(loadUniverse(EXOTICS6), 60 * 8);
  const r6 = evaluate("ex6", EXOTICS6.flatMap((s) => {
    const candles = loadDaily(s);
    return books(new Map([[s, candles as Candle[]]]), { ...atSpeed(SPEED), ...fxCostParams(candles) }, "e6");
  }), heat, w6);
  const t6 = withCarry(r6.res, 1);
  const tot6 = t6.reduce((s, t) => s + t.adjR, 0);
  const by6 = new Map<string, number>();
  for (const t of t6) by6.set(t.symbol, (by6.get(t.symbol) ?? 0) + t.adjR);
  console.log(`Tổng sau carry: ${tot6.toFixed(0)}R`);
  for (const [s, v] of [...by6.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${v.toFixed(0).padStart(5)}R = ${(v / tot6 * 100).toFixed(0)}% tổng`);
  }
  const noTry6 = [...by6.entries()].filter(([s]) => s !== "USDTRY").reduce((s, [, v]) => s + v, 0);
  console.log(`  → 5 đồng ngoại vi KHÔNG phải lira cộng lại: ${noTry6.toFixed(0)}R`);

  // ── 2. Chỉ USDZAR + USDMXN (bỏ lira) ──
  console.log(`\n═══ §2. BỎ USDTRY — còn gì khi không có cú sập lira? ═══`);
  const w2 = windowOf(loadUniverse(["USDZAR", "USDMXN"]), 60 * 8);
  const r2 = evaluate("zar+mxn", EXOTICS.filter((s) => s !== "USDTRY").flatMap((s) => {
    const candles = loadDaily(s);
    return books(new Map([[s, candles as Candle[]]]), { ...atSpeed(SPEED), ...fxCostParams(candles) }, "nt");
  }), heat, w2);
  const t2 = withCarry(r2.res, 1);
  console.log(`  NET sau carry: ${t2.reduce((s, t) => s + t.adjR, 0).toFixed(0)}R trên ${t2.length} unit`);

  // ── 3. Markup × spread ──
  console.log(`\n═══ §3. CHI PHÍ THỰC TẾ CỦA NHÓM NGOẠI VI (s=${SPEED}) ═══`);
  console.log("markup swap ↓ / spread →".padEnd(26) + "×1".padStart(9) + "×3".padStart(9) + "×5".padStart(9));
  for (const markup of [1, 3, 5]) {
    const row = [1, 3, 5].map((sm) => {
      const r = evaluate(`m${markup}s${sm}`, build(sm), heat, w).res;
      return withCarry(r, markup).reduce((s, t) => s + t.adjR, 0);
    });
    console.log(`${markup}%/năm mỗi chiều`.padEnd(26) + row.map((v) => v.toFixed(0).padStart(9)).join(""));
  }
  console.log("\nSpread trung vị đo được là spread NGÀY THƯỜNG. Đúng những ngày luật này kiếm tiền");
  console.log("(08/2018, 11–12/2021) spread giãn nhiều lần và một số broker ngừng nhận lệnh ngoại vi.");
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
