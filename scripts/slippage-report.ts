/**
 * slippage-report.ts — ĐỌC phân phối trượt giá thật từ journal, và trả lời câu hỏi đang treo:
 * trượt giá thật nằm TRÊN hay DƯỚI ngưỡng lật ~0,07×ATR?
 *
 * Nguồn: các dòng `event:"exit"` có field `slipBps`/`slipAtr` do `exit-fill-audit.ts` ghi.
 * Journal cũ (trước khi có instrumentation) KHÔNG có field này và sẽ được đếm riêng.
 *
 * Ý nghĩa ngưỡng (planning/turtle-fast-execution-weakness-2026-08-12.md §3):
 *   trượt < 0,07×ATR ⇒ stop-trong-nến đang là thiết kế đúng, số backtest đáng tin
 *   trượt > 0,07×ATR ⇒ bật hai ứng viên: Turtle stop máy móc 3×ATR (+17%) và stop xác nhận close
 *
 * Run: ./node_modules/.bin/ts-node scripts/slippage-report.ts [đường-dẫn-journal ...]
 *      (mặc định: turtle-trades.jsonl + fast-trend-mexc-trades.jsonl trong cwd và trading-runtime/)
 */
import fs from "fs";
import path from "path";

const THRESHOLD_ATR = 0.07;

type Row = {
  src: string;
  symbol: string;
  dir: string;
  reason: string;
  slipBps: number;
  slipAtr: number | null;
  realizedUsd: number | null;
};

function readJournal(file: string): { rows: Row[]; exitsTotal: number; exitsNoAudit: number } {
  const rows: Row[] = [];
  let exitsTotal = 0, exitsNoAudit = 0;
  if (!fs.existsSync(file)) return { rows, exitsTotal, exitsNoAudit };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.event !== "exit") continue;
    exitsTotal++;
    if (typeof j.slipBps !== "number") { exitsNoAudit++; continue; }
    rows.push({
      src: path.basename(file), symbol: j.symbol, dir: j.dir, reason: j.reason,
      slipBps: j.slipBps, slipAtr: typeof j.slipAtr === "number" ? j.slipAtr : null,
      realizedUsd: typeof j.realizedUsd === "number" ? j.realizedUsd : null,
    });
  }
  return { rows, exitsTotal, exitsNoAudit };
}

const q = (sorted: number[], p: number) => {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

function describe(label: string, rows: Row[]) {
  if (!rows.length) { console.log(`${label.padEnd(26)} — chưa có dữ liệu`); return; }
  const bps = rows.map((r) => r.slipBps).sort((a, b) => a - b);
  const atr = rows.filter((r) => r.slipAtr !== null).map((r) => r.slipAtr!).sort((a, b) => a - b);
  const mean = bps.reduce((s, x) => s + x, 0) / bps.length;
  const meanAtr = atr.length ? atr.reduce((s, x) => s + x, 0) / atr.length : NaN;
  const over = atr.filter((x) => x > THRESHOLD_ATR).length;
  console.log(
    `${label.padEnd(26)} n=${String(rows.length).padStart(4)} · bps TB ${mean.toFixed(1).padStart(7)}` +
      ` · p50 ${q(bps, 0.5).toFixed(1).padStart(7)} · p90 ${q(bps, 0.9).toFixed(1).padStart(7)}` +
      (atr.length
        ? ` · ×ATR TB ${meanAtr.toFixed(3)} · vượt ngưỡng ${over}/${atr.length} (${((over / atr.length) * 100).toFixed(0)}%)`
        : " · (chưa có slipAtr)"),
  );
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length
    ? args
    : ["turtle-trades.jsonl", "fast-trend-mexc-trades.jsonl", "fast-trend-trades.jsonl",
       "trading-runtime/turtle-trades.jsonl", "trading-runtime/trades-live.jsonl"]
        .map((f) => path.resolve(process.cwd(), f));

  const all: Row[] = [];
  let total = 0, noAudit = 0;
  console.log("Nguồn:");
  for (const f of files) {
    const r = readJournal(f);
    total += r.exitsTotal; noAudit += r.exitsNoAudit;
    all.push(...r.rows);
    console.log(`  ${path.basename(f).padEnd(30)} exit ${String(r.exitsTotal).padStart(4)} · có đo ${String(r.rows.length).padStart(4)}${fs.existsSync(f) ? "" : "  (không có file)"}`);
  }

  console.log(`\nTổng exit ${total} · đã đo ${all.length} · chưa đo ${noAudit} (journal ghi trước khi có instrumentation)`);
  if (!all.length) {
    console.log("\nChưa có điểm dữ liệu nào. Instrumentation cần được DEPLOY rồi chờ lệnh thoát thật.");
    console.log("Với ~55 unit/tháng trên hai sổ, khoảng một tháng là đủ mẫu để quyết.");
    return;
  }

  console.log("\n" + "=".repeat(112));
  console.log(`  TRƯỢT GIÁ THẬT (dương = khớp XẤU hơn giá tín hiệu). Ngưỡng lật quyết định: ${THRESHOLD_ATR}×ATR`);
  console.log("=".repeat(112));
  describe("TẤT CẢ", all);
  console.log("— theo nhánh thoát (nhánh `trail` là chỗ chiếm ~97% risk) —");
  for (const r of ["trail", "mid", "time", "reconcile"]) describe(`  ${r}`, all.filter((x) => x.reason === r));
  console.log("— theo hướng —");
  for (const d of ["long", "short"]) describe(`  ${d}`, all.filter((x) => x.dir === d));
  console.log("— theo sổ —");
  for (const s of [...new Set(all.map((x) => x.src))]) describe(`  ${s}`, all.filter((x) => x.src === s));
  console.log("— theo symbol —");
  for (const s of [...new Set(all.map((x) => x.symbol))].sort()) describe(`  ${s}`, all.filter((x) => x.symbol === s));

  const atrRows = all.filter((r) => r.slipAtr !== null);
  if (atrRows.length >= 20) {
    const meanAtr = atrRows.reduce((s, r) => s + r.slipAtr!, 0) / atrRows.length;
    console.log("\n" + "=".repeat(112));
    console.log(`  KẾT LUẬN (n=${atrRows.length}) — trượt giá TB ${meanAtr.toFixed(3)}×ATR vs ngưỡng ${THRESHOLD_ATR}`);
    console.log("=".repeat(112));
    if (meanAtr > THRESHOLD_ATR) {
      console.log("→ TRÊN ngưỡng: bật hai ứng viên — Turtle stop máy móc 3×ATR (initialStopObLookback=0)");
      console.log("  và stop xác nhận bằng close. Chạy lại exp-stop-mechanics.ts r2 với mức trượt ĐO ĐƯỢC.");
    } else {
      console.log("→ DƯỚI ngưỡng: giữ nguyên cơ chế stop hiện tại; số backtest đáng tin hơn tưởng.");
    }
  } else {
    console.log(`\nChưa đủ mẫu để kết luận (cần ≥20 exit có slipAtr, hiện có ${atrRows.length}).`);
  }
}

if (require.main === module && /slippage-report\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main();
}
