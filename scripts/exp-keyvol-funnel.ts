/**
 * exp-keyvol-funnel.ts — PHỄU của `runKeyVolume`: 4.144 setup nhưng chỉ 13 lệnh. Gate nào giết?
 *
 * VÌ SAO CẦN: `scripts/exp-retest-volume.ts` không kiểm chứng được luật "volume phải xuất hiện hai
 * lần" (rút từ corpus Short) vì engine rơi vào NHÁNH STOP SUY BIẾN — stop trung bình 0,03%, chỉ
 * 1–13 lệnh/năm. Với cỡ mẫu đó mọi con số P&L là nhiễu. Phải biết chính xác chỗ nghẽn trước khi
 * sửa được bất cứ thứ gì.
 *
 * Script này chỉ ĐỌC bộ đếm `KeyVolumeDiagnostics` mà `runKeyVolume` vốn đã trả về, cộng thêm phân
 * phối stop/RR của các lệnh lọt qua. Không sửa engine, không kết luận thay người đọc.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-keyvol-funnel.ts [days] [symbols]
 */
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { TF_MS } from "../strategy";
import { KEY_VOLUME_CONFIG, KeyVolumeParams, runKeyVolume } from "../key-volume";

const DEFAULT_SYMBOLS = ["btcusdt", "solusdt", "xrpusdt", "dogeusdt"];

const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—");

function quantiles(xs: number[]): string {
  if (!xs.length) return "—";
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
  return `p10 ${q(0.1).toFixed(3)} · p50 ${q(0.5).toFixed(3)} · p90 ${q(0.9).toFixed(3)}`;
}

async function main() {
  const days = parseInt(process.argv[2] ?? "365", 10);
  const symbols = (process.argv[3] ? process.argv[3].split(",") : DEFAULT_SYMBOLS).map((s) => s.trim().toLowerCase());
  const bars = Math.ceil((days * TF_MS["1d"]) / TF_MS["5m"]) + 5000;
  const data = new Map<string, Awaited<ReturnType<typeof fetchFuturesKlinesPaged>>>();
  for (const s of symbols) {
    const c = await fetchFuturesKlinesPaged(s, "5m", bars);
    if (c.length > 10000) data.set(s, c);
  }
  console.log(`${data.size} symbol · ${days} ngày · nến gốc 5m\n`);

  const variants: [string, Partial<KeyVolumeParams>][] = [
    ["PRODUCTION (nguyên trạng)", {}],
    ["bỏ trần maxStopPct", { maxStopPct: 1 }],
    ["bỏ sàn RR (minRR=0)", { minRR: 0 }],
    ["target capped-R thay vì structure", { targetMode: "capped-r", requireStructuralTarget: false }],
    ["bỏ RR + target capped-R", { minRR: 0, targetMode: "capped-r", requireStructuralTarget: false }],
    ["bỏ follow-through", { requireFollowThrough: false }],
    ["bỏ RR + capped-R + follow-through", { minRR: 0, targetMode: "capped-r", requireStructuralTarget: false, requireFollowThrough: false }],
  ];

  for (const [label, over] of variants) {
    let d = {
      h1Levels: 0, confluentTouches: 0, touchVolumeConfirmed: 0, sweeps: 0, candlePatterns: 0,
      profileAccepted: 0, plans: 0, entries: 0,
      rejectedRisk: 0, rejectedRoom: 0, rejectedFirstTouch: 0, rejectedDailyTrap: 0, rejectedDouble: 0, rejectedSession: 0,
    };
    const stops: number[] = [];
    const rrs: number[] = [];
    let trades = 0, gross = 0;
    for (const [sym, c] of data) {
      const r = runKeyVolume(sym, c, { ...KEY_VOLUME_CONFIG, ...over });
      for (const k of Object.keys(d) as (keyof typeof d)[]) d[k] += (r.diagnostics as any)[k] ?? 0;
      for (const t of r.trades) {
        trades++;
        gross += t.grossR ?? t.netR;
        const risk = Math.abs(t.entryPrice - t.initialSL);
        stops.push((risk / t.entryPrice) * 100);
        if (risk > 0) rrs.push(Math.abs(t.target - t.entryPrice) / risk);
      }
    }
    console.log("=".repeat(100));
    console.log(`  ${label}`);
    console.log("=".repeat(100));
    console.log(
      `key H1 ${d.h1Levels}  →  chạm hợp lưu ${d.confluentTouches} (${pct(d.confluentTouches, d.h1Levels)})` +
        `  →  volume xác nhận ${d.touchVolumeConfirmed} (${pct(d.touchVolumeConfirmed, d.confluentTouches)})` +
        `  →  sweep ${d.sweeps} (${pct(d.sweeps, d.touchVolumeConfirmed)})`,
    );
    console.log(
      `  →  mô hình nến ${d.candlePatterns} (${pct(d.candlePatterns, d.sweeps)})` +
        `  →  profile nhận ${d.profileAccepted}  →  PLAN ${d.plans}  →  ENTRY ${d.entries} (${pct(d.entries, d.plans)})` +
        `  →  LỆNH ĐÓNG ${trades}`,
    );
    console.log(
      `  bị loại:  risk/stop ${d.rejectedRisk}  ·  dư địa ${d.rejectedRoom}  ·  chạm-lần-đầu ${d.rejectedFirstTouch}` +
        `  ·  trap Daily ${d.rejectedDailyTrap}  ·  hai-đỉnh ${d.rejectedDouble}  ·  phiên ${d.rejectedSession}`,
    );
    console.log(`  stop % giá:  ${quantiles(stops)}   |   RR đạt được: ${quantiles(rrs)}   |   gross ${gross.toFixed(1)}R`);
    console.log();
  }
}

if (require.main === module && /exp-keyvol-funnel\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
