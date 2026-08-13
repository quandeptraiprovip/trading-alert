/**
 * exp-year-cagr.ts — LỢI NHUẬN THEO TỪNG NĂM ở đúng mức risk đang chạy, và nó ĐANG SUY GIẢM?
 *
 * VÌ SAO CẦN, và nó sửa một chỗ dễ hiểu nhầm: con số "22%/năm" tôi đưa ra trước đó KHÔNG phải lợi
 * nhuận thực tế đã kiếm được — nó là BACKTEST của 12 tháng gần nhất (Turtle +31R, Fast +52R quy ra
 * tiền ở risk 0,5%). Trong khi backtest TOÀN MẪU 5,5 năm cho CAGR ~70%. Hai con số chênh 3 lần, và
 * hiệu số đó KHÔNG phải ma sát giao dịch — nó là REGIME. Bảng dưới tách theo năm để thấy rõ.
 *
 * Câu hỏi quyết định cho kỳ vọng tương lai: 70% (trung bình dài hạn) hay 16-22% (năm gần nhất) mới
 * là con số nên dùng? Nếu có XU HƯỚNG GIẢM đơn điệu thì phải dùng số gần đây và phải hỏi vì sao.
 *
 * Đọc cache trực tiếp, KHÔNG gọi API (Binance đang chặn IP sau loạt fetch trước).
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-year-cagr.ts [riskPct]
 */
import fs from "fs";
import path from "path";
import { Candle } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitCtx, AdmitFn, Book, ExtParams, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8 } from "./exp-breadth";

const readCached = (s: string): Candle[] =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), ".cache", "klines", "futures", `${s}_4h.json`), "utf8"));

async function main() {
  const riskPct = parseFloat(process.argv[2] ?? "0.005");
  const data = new Map<string, Candle[]>();
  for (const s of CORE8) data.set(s, readCached(s));
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle } = liveSleeves(gate);
  const snap: Partial<ExtParams> = { admitBarSnapshot: true };
  const heat: AdmitFn = (c: AdmitCtx) => (T.heatDecayK > 0 ? 1 / (1 + c.sameDirHeat / T.heatDecayK) : 1);
  const books: Book[] = [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p: { ...turtle, ...snap } }));
  const res = runBooks(books, heat);

  // Cửa sổ hợp lệ: sau warmup của mọi symbol.
  const from = Math.max(...[...data.values()].map((c) => c[0].openTime)) + (T.btcGateSlow + 200) * 4 * 3600e3;
  const eq = res.equity.filter((e) => e.time >= from);

  console.log(`Sổ TURTLE · CORE8 · risk ${(riskPct * 100).toFixed(2)}%/unit · phân bổ đầu nến · k=${T.heatDecayK}`);
  console.log(`Cửa sổ ${new Date(eq[0].time).toISOString().slice(0, 10)} → ${new Date(eq[eq.length - 1].time).toISOString().slice(0, 10)}\n`);
  console.log("năm".padEnd(8) + "Net R".padStart(9) + "lợi nhuận".padStart(11) + "sụt trong năm".padStart(15) + "lệnh".padStart(7));

  const years = [...new Set(eq.map((e) => new Date(e.time).getUTCFullYear()))].sort();
  const rows: { y: number; ret: number; dd: number }[] = [];
  for (const y of years) {
    const seg = eq.filter((e) => new Date(e.time).getUTCFullYear() === y);
    if (seg.length < 30) continue;
    let e = 1, peak = 1, dd = 0, netR = 0;
    for (let i = 1; i < seg.length; i++) {
      const d = seg[i].mtm - seg[i - 1].mtm;
      netR += d;
      e *= 1 + d * riskPct;
      peak = Math.max(peak, e);
      dd = Math.max(dd, (peak - e) / peak);
    }
    const n = res.trades.filter((t) => new Date(t.exitTime).getUTCFullYear() === y && t.entryTime >= from).length;
    const ret = (e - 1) * 100;
    rows.push({ y, ret, dd });
    console.log(
      String(y).padEnd(8) + netR.toFixed(0).padStart(9) + `${ret.toFixed(0)}%`.padStart(11) +
      `${(dd * 100).toFixed(0)}%`.padStart(15) + String(n).padStart(7),
    );
  }

  const full = rows.slice(0, -1); // bỏ năm chạy dở khi tính xu hướng
  const firstHalf = full.slice(0, Math.ceil(full.length / 2));
  const secondHalf = full.slice(Math.ceil(full.length / 2));
  const avg = (a: { ret: number }[]) => a.reduce((s, x) => s + x.ret, 0) / a.length;
  console.log(
    `\nTB nửa ĐẦU (${firstHalf.map((r) => r.y).join(",")}): ${avg(firstHalf).toFixed(0)}%/năm\n` +
    `TB nửa SAU (${secondHalf.map((r) => r.y).join(",")}): ${avg(secondHalf).toFixed(0)}%/năm`,
  );
  {
    const DAYMS = 86400e3;
    const md = new Map<number, number>();
    for (let i = 1; i < eq.length; i++) {
      const d = Math.floor(eq[i].time / DAYMS);
      md.set(d, (md.get(d) ?? 0) + (eq[i].mtm - eq[i - 1].mtm));
    }
    concentrationInTime([...md.keys()].sort((a, b) => a - b).map((d) => md.get(d)!), 24);
  }

  console.log(
    "\n═══ CÁCH ĐỌC ═══\n" +
    "• Nếu nửa sau THẤP HƠN HẲN nửa đầu thì con số \"CAGR 70%\" của toàn mẫu bị mấy năm đầu kéo lên,\n" +
    "  và kỳ vọng tương lai phải dùng số gần đây — không phải trung bình dài hạn.\n" +
    "• Cột \"sụt trong năm\" cho thấy mức đau PHẢI CHỊU để có lợi nhuận năm đó; năm lãi cao thường\n" +
    "  cũng là năm sụt sâu, nên đừng đọc riêng cột lợi nhuận.\n" +
    "• Số tuyệt đối vẫn LẠC QUAN vì CORE8 là rổ chọn bằng hindsight.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

/**
 * TẬP TRUNG THEO THỜI GIAN — vì sao "luôn bật máy" quan trọng hơn mọi tinh chỉnh.
 * Lợi nhuận trend-following dồn vào ít cửa sổ. Nếu top 5% số ngày mang phần lớn lợi nhuận thì
 * việc TẮT MÁY 24 ngày không phải rủi ro nhỏ — nó là xổ số, và kỳ vọng thì âm.
 */
export function concentrationInTime(daily: number[], windowDays: number): void {
  const total = daily.reduce((a, b) => a + b, 0);
  const sorted = [...daily].sort((a, b) => b - a);
  const topShare = (frac: number) => {
    const n = Math.max(1, Math.round(daily.length * frac));
    return (sorted.slice(0, n).reduce((a, b) => a + b, 0) / total) * 100;
  };
  console.log("\n═══ TẬP TRUNG THEO THỜI GIAN ═══");
  console.log(`Tổng ${total.toFixed(0)}R trên ${daily.length} ngày`);
  for (const f of [0.01, 0.05, 0.1, 0.2]) {
    console.log(`  ${(f * 100).toFixed(0)}% ngày TỐT NHẤT mang ${topShare(f).toFixed(0)}% tổng lợi nhuận`);
  }
  const wins: number[] = [];
  for (let i = 0; i + windowDays <= daily.length; i++) {
    wins.push(daily.slice(i, i + windowDays).reduce((a, b) => a + b, 0));
  }
  wins.sort((a, b) => a - b);
  const q = (p: number) => wins[Math.floor(p * wins.length)];
  const mean = wins.reduce((a, b) => a + b, 0) / wins.length;
  console.log(
    `\nMọi cửa sổ ${windowDays} ngày (n=${wins.length}): TB ${mean.toFixed(1)}R · ` +
    `5% ${q(0.05).toFixed(1)}R · 50% ${q(0.5).toFixed(1)}R · 95% ${q(0.95).toFixed(1)}R · max ${wins[wins.length - 1].toFixed(1)}R`,
  );
  console.log(
    `  ⇒ TẮT MÁY ${windowDays} ngày: kỳ vọng mất ${mean.toFixed(1)}R, nhưng ca xấu (trúng cửa sổ tốt nhất)\n` +
    `    mất tới ${wins[wins.length - 1].toFixed(1)}R — gấp ${(wins[wins.length - 1] / Math.max(0.1, mean)).toFixed(0)} lần kỳ vọng.`,
  );
}
