/**
 * fx-gold-drivers.ts — CƠ CHẾ trước, luật sau. "Cái gì làm vàng tăng, động lực có bền không?"
 *
 * VÌ SAO FILE NÀY TỒN TẠI: ba họ luật đã thử trên vàng (trend chậm, phá vỡ phiên, drift theo giờ)
 * đều rớt, nhưng cả ba đều là thử-từ-trên-xuống — áp một hình dạng luật có sẵn rồi xem có ăn không.
 * Cách đó không nói được vàng CHUYỂN ĐỘNG vì cái gì, nên cũng không nói được hình dạng luật nào hợp.
 *
 * BIẾN GIẢI THÍCH — chọn theo lý thuyết định giá vàng, khai báo trước khi chạy:
 *   · LÃI SUẤT THỰC (DFII10, TIPS 10 năm). Biến số một. Vàng không trả lợi tức ⇒ chi phí cơ hội của
 *     việc giữ vàng CHÍNH LÀ lãi suất thực. Dấu kỳ vọng ÂM.
 *   · ĐÔ LA (DXY dựng từ 6 cặp theo trọng số chính thức). Vàng yết bằng USD. Dấu kỳ vọng ÂM.
 *   · KỲ VỌNG LẠM PHÁT (T10YIE breakeven 10 năm). Vàng là hàng rào lạm phát. Dấu kỳ vọng DƯƠNG.
 *   · RỦI RO (VIX). Cầu trú ẩn. Dấu kỳ vọng DƯƠNG.
 *   · CỔ PHIẾU (S&P 500). Đối chứng: nếu vàng chỉ là beta thị trường thì không có gì riêng để khai thác.
 *
 * KỶ LUẬT: chạy hồi quy trên TOÀN mẫu VÀ theo era. Một động lực chỉ đáng gọi là động lực nếu hệ số
 * giữ dấu qua các era. Hệ số đổi dấu giữa chừng = mối quan hệ đã gãy, và mọi luật fit trên mẫu cũ
 * sẽ hỏng ở phía trước — đây đúng là thứ đã xảy ra với vàng sau 2022 theo tài liệu ngành.
 *
 * Chạy: npx ts-node fx/fx-gold-drivers.ts
 */

import fs from "fs";
import path from "path";
import { FxCandle, loadH1 } from "./fx-data";

const MACRO_DIR = path.join(process.cwd(), ".cache", "fx", "macro");
const DAY_CLOSE_H = 22;

// ── nạp dữ liệu ───────────────────────────────────────────────────────────────

/** FRED CSV → Map<"YYYY-MM-DD", số>. Giá trị "." = ngày nghỉ, bỏ. */
function loadFred(id: string): Map<string, number> {
  const raw = fs.readFileSync(path.join(MACRO_DIR, `${id}.csv`), "utf8").trim().split("\n").slice(1);
  const m = new Map<string, number>();
  for (const line of raw) {
    const [d, v] = line.split(",");
    const x = parseFloat(v);
    if (Number.isFinite(x)) m.set(d, x);
  }
  return m;
}

/** H1 → chuỗi đóng cửa NGÀY GIAO DỊCH (mốc 22:00 UTC), khoá theo ngày lịch của mốc đóng. */
function dailyClose(sym: string): Map<string, number> {
  const bars: FxCandle[] = loadH1(sym);
  const byDay = new Map<number, FxCandle>();
  for (const b of bars) {
    const d = Math.floor((b.openTime - DAY_CLOSE_H * 3600e3) / 86400e3);
    const prev = byDay.get(d);
    if (!prev || b.openTime > prev.openTime) byDay.set(d, b);
  }
  const out = new Map<string, number>();
  for (const [d, b] of byDay) {
    // mốc đóng = 22:00 UTC của ngày d ⇒ quy về ngày lịch đó
    out.set(new Date(d * 86400e3 + DAY_CLOSE_H * 3600e3).toISOString().slice(0, 10), b.close);
  }
  return out;
}

/** DXY theo công thức ICE chính thức (trọng số hình học). */
function buildDxy(): Map<string, number> {
  const s = {
    EURUSD: dailyClose("EURUSD"), USDJPY: dailyClose("USDJPY"), GBPUSD: dailyClose("GBPUSD"),
    USDCAD: dailyClose("USDCAD"), USDCHF: dailyClose("USDCHF"),
  };
  // SEK chỉ có nến ngày trong cache; đọc trực tiếp file _day.
  const sek = new Map<string, number>();
  const rows = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".cache", "fx", "USDSEK_day.json"), "utf8"));
  for (const r of rows) sek.set(new Date(r.openTime).toISOString().slice(0, 10), r.close);

  const out = new Map<string, number>();
  for (const [d, eur] of s.EURUSD) {
    const jpy = s.USDJPY.get(d), gbp = s.GBPUSD.get(d), cad = s.USDCAD.get(d), chf = s.USDCHF.get(d);
    const sk = sek.get(d);
    if (!jpy || !gbp || !cad || !chf || !sk) continue;
    out.set(d, 50.14348112 * eur ** -0.576 * jpy ** 0.136 * gbp ** -0.119 * cad ** 0.091 * sk ** 0.042 * chf ** 0.036);
  }
  return out;
}

// ── OLS ───────────────────────────────────────────────────────────────────────

interface Ols { beta: number[]; t: number[]; r2: number; n: number }

function ols(y: number[], X: number[][]): Ols {
  const n = y.length, k = X[0].length;
  const xtx = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) xtx[a][b] += X[i][a] * X[i][b];
    }
  }
  // nghịch đảo Gauss-Jordan
  const inv = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));
  const M = xtx.map((r) => [...r]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    [inv[c], inv[piv]] = [inv[piv], inv[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let j = 0; j < k; j++) { M[c][j] /= d; inv[c][j] /= d; }
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let j = 0; j < k; j++) { M[r][j] -= f * M[c][j]; inv[r][j] -= f * inv[c][j]; }
    }
  }
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));
  const yBar = y.reduce((s, x) => s + x, 0) / n;
  let ssr = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    const fit = X[i].reduce((s, v, j) => s + v * beta[j], 0);
    ssr += (y[i] - fit) ** 2;
    sst += (y[i] - yBar) ** 2;
  }
  const s2 = ssr / (n - k);
  const t = beta.map((b, j) => (inv[j][j] > 0 ? b / Math.sqrt(s2 * inv[j][j]) : 0));
  return { beta, t, r2: 1 - ssr / sst, n };
}

// ── xây bảng tuần ─────────────────────────────────────────────────────────────

interface Row { date: string; gold: number; dReal: number; dxy: number; dBe: number; dVix: number; spx: number }

function weekly(): Row[] {
  const gold = dailyClose("XAUUSD");
  const dxy = buildDxy();
  const real = loadFred("DFII10"), be = loadFred("T10YIE"), vix = loadFred("VIXCLS");
  const spxRows = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".cache", "fx", "USA500IDXUSD_day.json"), "utf8"));
  const spx = new Map<string, number>();
  for (const r of spxRows) spx.set(new Date(r.openTime).toISOString().slice(0, 10), r.close);

  // giữ ngày có ĐỦ mọi biến, rồi lấy quan sát CUỐI mỗi tuần ISO
  const dates = [...gold.keys()].filter((d) => dxy.has(d) && real.has(d) && be.has(d) && vix.has(d) && spx.has(d)).sort();
  const lastOfWeek = new Map<string, string>();
  for (const d of dates) {
    const t = new Date(d + "T00:00:00Z");
    const wk = new Date(t); wk.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); // thứ Hai
    lastOfWeek.set(wk.toISOString().slice(0, 10), d);
  }
  const picks = [...lastOfWeek.values()].sort();

  const out: Row[] = [];
  for (let i = 1; i < picks.length; i++) {
    const a = picks[i - 1], b = picks[i];
    out.push({
      date: b,
      gold: (gold.get(b)! / gold.get(a)! - 1) * 100,
      dReal: real.get(b)! - real.get(a)!,          // điểm phần trăm
      dxy: (dxy.get(b)! / dxy.get(a)! - 1) * 100,
      dBe: be.get(b)! - be.get(a)!,
      dVix: vix.get(b)! - vix.get(a)!,
      spx: (spx.get(b)! / spx.get(a)! - 1) * 100,
    });
  }
  return out;
}

const NAMES = ["hằng số", "Δlãi suất thực", "DXY %", "Δkỳ vọng LP", "ΔVIX", "S&P500 %"];
const design = (r: Row) => [1, r.dReal, r.dxy, r.dBe, r.dVix, r.spx];

function report(label: string, rows: Row[]) {
  if (rows.length < 40) { console.log(`${label}: quá ít quan sát (${rows.length})`); return; }
  const m = ols(rows.map((r) => r.gold), rows.map(design));
  console.log(`\n${label}  (n = ${m.n} tuần · R² = ${(m.r2 * 100).toFixed(1)}%)`);
  console.log("  " + "biến".padEnd(18) + "hệ số".padStart(10) + "t".padStart(9));
  for (let i = 1; i < NAMES.length; i++) {
    console.log("  " + NAMES[i].padEnd(18) + m.beta[i].toFixed(3).padStart(10) + m.t[i].toFixed(2).padStart(9) +
      (Math.abs(m.t[i]) >= 2 ? "  ✅" : ""));
  }
}

function main() {
  const rows = weekly();
  console.log(`═══ ĐỘNG LỰC CỦA VÀNG — hồi quy TUẦN, ${rows[0].date} → ${rows[rows.length - 1].date} ═══`);
  console.log("Biến phụ thuộc: lợi suất tuần XAUUSD (%). |t| ≥ 2 mới coi là phân biệt được với 0.");

  report("TOÀN MẪU", rows);

  // ── theo era: động lực có BỀN không? ──
  const n = rows.length, e1 = Math.floor(n / 3), e2 = Math.floor((2 * n) / 3);
  report(`ERA 1  ${rows[0].date} → ${rows[e1 - 1].date}`, rows.slice(0, e1));
  report(`ERA 2  ${rows[e1].date} → ${rows[e2 - 1].date}`, rows.slice(e1, e2));
  report(`ERA 3  ${rows[e2].date} → ${rows[n - 1].date}`, rows.slice(e2));

  // ── cắt riêng 2022+ : tài liệu ngành nói quan hệ lãi suất thực GÃY từ đây ──
  const cut = rows.findIndex((r) => r.date >= "2022-01-01");
  report("TRƯỚC 2022", rows.slice(0, cut));
  report("TỪ 2022", rows.slice(cut));

  // ── beta trượt với lãi suất thực (hồi quy đơn) ──
  console.log("\n═══ BETA TRƯỢT 104 TUẦN — vàng vs Δlãi suất thực (hồi quy ĐƠN) ═══");
  console.log("Nếu đây là động lực bền, beta phải ở yên một phía. Đổi dấu = quan hệ gãy.");
  const W = 104;
  const marks: string[] = [];
  for (let i = W; i < rows.length; i += 26) {
    const sub = rows.slice(i - W, i);
    const m = ols(sub.map((r) => r.gold), sub.map((r) => [1, r.dReal]));
    marks.push(`${sub[sub.length - 1].date.slice(0, 7)} ${m.beta[1].toFixed(2).padStart(6)}${Math.abs(m.t[1]) >= 2 ? "*" : " "}`);
  }
  for (let i = 0; i < marks.length; i += 5) console.log("  " + marks.slice(i, i + 5).join("  │"));
  console.log("  (* = |t| ≥ 2)");

  // ── vàng còn lại gì sau khi trừ hết động lực? ──
  const m = ols(rows.map((r) => r.gold), rows.map(design));
  const resid = rows.map((r, i) => ({ date: r.date, e: r.gold - design(r).reduce((s, v, j) => s + v * m.beta[j], 0) }));
  const byYear = new Map<string, number>();
  for (const r of resid) byYear.set(r.date.slice(0, 4), (byYear.get(r.date.slice(0, 4)) ?? 0) + r.e);
  console.log("\n═══ PHẦN DƯ THEO NĂM — vàng tăng NGOÀI mọi động lực trên (%/năm) ═══");
  console.log("Hằng số hồi quy = " + m.beta[0].toFixed(3) + "%/tuần (t " + m.t[0].toFixed(2) + ")");
  const ys = [...byYear.keys()].sort();
  for (let i = 0; i < ys.length; i += 6) {
    console.log("  " + ys.slice(i, i + 6).map((y) => `${y} ${byYear.get(y)!.toFixed(1).padStart(6)}%`).join("  │"));
  }
}

if (require.main === module) main();
