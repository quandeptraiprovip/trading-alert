/**
 * exp-keylevel-room.ts — TẬN DỤNG FX DREAM THEO CÁCH DUY NHẤT CÒN CỬA: không phải làm sleeve riêng,
 * mà làm INPUT CẤU TRÚC cho Turtle/Fast.
 *
 * VÌ SAO KHÔNG LÀM SLEEVE RIÊNG: đã đo hai lần, kết luận trùng nhau. Scanner source-aligned 1 năm:
 * gross −25,5R/341 lệnh (âm CẢ TRƯỚC PHÍ). Bản sửa đủ tốt nhất (`measure-live-path.ts`): 257 lệnh,
 * gross +28,4R, hoà vốn ở ma sát <0,088% ⇒ NET −33R ở phí Binance 0,14%, chỉ dương ở phí Vàng/Forex
 * 0,02%. Ràng buộc là VENUE, không phải luật. Trên rổ perp này nó không thể là sleeve.
 *
 * VÌ SAO LÀM BỘ LỌC THÌ KHÁC HẲN: bộ lọc KHÔNG THÊM MỘT LỆNH NÀO. Nó chỉ bỏ hoặc thu nhỏ lệnh mà
 * Turtle/Fast vốn đã vào. Vì thế ma sát 0,14% — thứ giết fxdream khi đứng riêng — hoàn toàn không áp
 * dụng. Đây là cách duy nhất thông tin của phương pháp có thể trả tiền trên Binance perp.
 *
 * CƠ CHẾ (không phải dò tham số): Turtle/Fast mù hoàn toàn với cấu trúc NGANG — chúng chỉ biết kênh
 * Donchian và EMA. "Dư địa" (room) là khái niệm trung tâm của FX Dream: một cú phá vỡ đâm thẳng vào
 * vùng volume lớn phía trước thì hết chỗ chạy. Đây là thông tin ĐỘC LẬP với mọi thứ hai sleeve đang
 * dùng, nên nếu nó có giá trị thì đó là giá trị THÊM chứ không phải trùng lặp.
 *
 * Key phát hiện bằng `detectKeyVolumeLevels` của `key-volume.ts` — engine ĐÃ QUA HAI VÒNG AUDIT
 * (§13/§14 `planning/fxdream-keyvolume-method.md`), chạy trên chính nến 4h mà hai sleeve dùng.
 * Không lookahead: chỉ nhận key có `confirmedAt <= openTime` của nến đang xét.
 *
 * CỬA DUYỆT: cao nguyên ngưỡng · placebo đảo chiều phải xấu · cả ba era · và (nếu sống) cả 4 pha nến.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-keylevel-room.ts [diag|filter|size|all] [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, atrSeries, buildBtcGateLongs } from "../turtle";
import { detectKeyVolumeLevels, KEY_VOLUME_CONFIG, KeyVolumeLevel } from "../key-volume";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];
const TARGET_DD = 0.3;

/** Dư địa (đơn vị ATR) tới key gần nhất PHÍA TRƯỚC, tra theo (symbol, openTime). */
export type RoomMap = Map<string, Map<number, { long: number; short: number }>>;

export function buildRoomMap(data: Map<string, Candle[]>): { room: RoomMap; keyCount: Map<string, number> } {
  const room: RoomMap = new Map();
  const keyCount = new Map<string, number>();
  for (const [sym, c] of data) {
    const levels: KeyVolumeLevel[] = detectKeyVolumeLevels(c, "4h", KEY_VOLUME_CONFIG);
    keyCount.set(sym, levels.length);
    const atr = atrSeries(c, T.atrPeriod);
    const byTime = new Map<number, { long: number; short: number }>();
    // levels đã theo thứ tự thời gian; con trỏ chạy tới để khỏi quét lại từ đầu
    let head = 0;
    const active: KeyVolumeLevel[] = [];
    for (let i = 0; i < c.length; i++) {
      const t = c[i].openTime;
      while (head < levels.length && levels[head].confirmedAt <= t) active.push(levels[head++]);
      // bỏ key hết hạn
      for (let k = active.length - 1; k >= 0; k--) if (active[k].expiresAt <= t) active.splice(k, 1);
      if (!(atr[i] > 0)) continue;
      const px = c[i].close;
      let up = Infinity, dn = Infinity;
      for (const lv of active) {
        if (lv.price > px) up = Math.min(up, lv.price - px);
        else if (lv.price < px) dn = Math.min(dn, px - lv.price);
      }
      byTime.set(t, { long: up / atr[i], short: dn / atr[i] });
    }
    room.set(sym, byTime);
  }
  return { room, keyCount };
}

const roomAt = (room: RoomMap, sym: string, t: number, dir: "long" | "short"): number => {
  const r = room.get(sym)?.get(t);
  if (!r) return Infinity;
  return dir === "long" ? r.long : r.short;
};

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
    mult: e, sharpe: sharpeOf(s), eras, e365,
    wfAvg: wf.reduce((a, x) => a + x, 0) / wf.length,
    units: res.trades.length,
    positions: new Set(res.trades.map((t) => `${t.book}#${t.positionId}`)).size,
  };
}

const HEADER = "biến thể                       unit  vịthế   Sharpe   VỐN(×)   era A/B/C (×)         365d(×)   WF TB";
function printRow(label: string, r: ReturnType<typeof score>, base?: number) {
  const d = base ? ` ${((r.mult - base) / base) * 100 >= 0 ? "+" : ""}${(((r.mult - base) / base) * 100).toFixed(0)}%` : "";
  console.log(
    `${label.padEnd(30)} ${String(r.units).padStart(5)} ${String(r.positions).padStart(6)}   ${r.sharpe.toFixed(2).padStart(6)}   ` +
      `${r.mult.toFixed(2).padStart(6)}   ${r.eras.map((x) => x.toFixed(2)).join(" / ").padEnd(20)}   ${r.e365.toFixed(2).padStart(6)}   ${r.wfAvg.toFixed(2)}${d}`,
  );
}

async function main() {
  const mode = (process.argv[2] ?? "all").toLowerCase();
  const days = parseInt(process.argv[3] ?? "2300", 10);
  const data = await loadPool(days, CORE8);
  const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  const heat: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / T.heatDecayK);
  const bk = (p: ExtParams): Book[] => [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
  const SLEEVES: [string, ExtParams][] = [["TURTLE", turtle], ["FAST", fast]];

  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · maxDD ép về ${TARGET_DD * 100}% · heat k=${T.heatDecayK}`);
  const { room, keyCount } = buildRoomMap(data);
  const totalKeys = [...keyCount.values()].reduce((a, b) => a + b, 0);
  const years = (w.to - w.from) / (365 * DAY);
  console.log(
    `Key volume 4h (spike ≥${KEY_VOLUME_CONFIG.volumeSpikeMult}× trung vị ${KEY_VOLUME_CONFIG.volumeLookback} nến, hạn ${KEY_VOLUME_CONFIG.keyMaxAgeDays}d): ` +
      `${totalKeys} key / ${data.size} coin / ${years.toFixed(1)} năm = ${(totalKeys / data.size / years).toFixed(0)} key/coin/năm\n`,
  );

  // ── DIAG: phân phối dư địa, và dư địa có LIÊN QUAN tới kết quả lệnh không? ──
  if (mode === "all" || mode === "diag") {
    console.log("=".repeat(104));
    console.log("  DIAG — dư địa tới key gần nhất phía trước, và NET R theo ngũ phân vị dư địa");
    console.log("=".repeat(104));
    for (const [name, p] of SLEEVES) {
      const res = runBooks(bk(p), heat);
      const rows = res.trades
        .filter((t) => t.entryTime >= w.from && t.entryTime <= w.to)
        .map((t) => ({ r: roomAt(room, t.symbol, t.entryTime, t.dir), netR: t.netR, wt: t.weight }))
        .filter((x) => Number.isFinite(x.r));
      rows.sort((a, b) => a.r - b.r);
      const nInf = res.trades.length - rows.length;
      console.log(`\n${name}: ${rows.length} unit có key phía trước · ${nInf} unit KHÔNG có key nào phía trước`);
      const Q = 5;
      console.log("ngũ phân vị   dư địa (ATR)      unit    NET R    exp/unit");
      for (let q = 0; q < Q; q++) {
        const a = Math.floor((rows.length * q) / Q), b = Math.floor((rows.length * (q + 1)) / Q);
        const seg = rows.slice(a, b);
        if (!seg.length) continue;
        const net = seg.reduce((s, x) => s + x.netR * x.wt, 0);
        const wt = seg.reduce((s, x) => s + x.wt, 0);
        console.log(
          `   Q${q + 1}        ${seg[0].r.toFixed(2)}–${seg[seg.length - 1].r.toFixed(2)}`.padEnd(30) +
            `${String(seg.length).padStart(5)}   ${net.toFixed(1).padStart(6)}   ${(net / wt).toFixed(3).padStart(8)}`,
        );
      }
      const infSeg = res.trades.filter((t) => t.entryTime >= w.from && !Number.isFinite(roomAt(room, t.symbol, t.entryTime, t.dir)));
      if (infSeg.length) {
        const net = infSeg.reduce((s, x) => s + x.netR * x.weight, 0);
        const wt = infSeg.reduce((s, x) => s + x.weight, 0);
        console.log(`   TRỐNG      không có key       ${String(infSeg.length).padStart(5)}   ${net.toFixed(1).padStart(6)}   ${(net / wt).toFixed(3).padStart(8)}`);
      }
    }
    console.log();
  }

  // ── FILTER: bỏ lệnh khi dư địa < ngưỡng (kèm PLACEBO đảo chiều) ──
  if (mode === "all" || mode === "filter") {
    for (const [name, p] of SLEEVES) {
      console.log("=".repeat(104));
      console.log(`  ${name} — BỘ LỌC: bỏ unit khi dư địa tới key < ngưỡng`);
      console.log("=".repeat(104));
      console.log(HEADER);
      console.log("-".repeat(104));
      const base = score(runBooks(bk(p), heat), w);
      printRow("không lọc (đang chạy)", base);
      for (const th of [0.5, 1, 1.5, 2, 3]) {
        const admit: AdmitFn = (c) => (roomAt(room, c.symbol, c.time, c.dir) >= th ? heat(c) : 0);
        printRow(`dư địa ≥ ${th}×ATR`, score(runBooks(bk(p), admit), w), base.mult);
      }
      console.log("  ── PLACEBO (đảo chiều: CHỈ lấy lệnh ÍT dư địa — phải xấu) ──");
      for (const th of [1, 2]) {
        const admit: AdmitFn = (c) => (roomAt(room, c.symbol, c.time, c.dir) < th ? heat(c) : 0);
        printRow(`PLACEBO dư địa < ${th}×ATR`, score(runBooks(bk(p), admit), w), base.mult);
      }
      console.log();
    }
  }

  // ── SIZING: tỉ trọng tỉ lệ với dư địa (không bỏ lệnh nào) ──
  if (mode === "all" || mode === "size") {
    for (const [name, p] of SLEEVES) {
      console.log("=".repeat(104));
      console.log(`  ${name} — SIZING: tỉ trọng = min(1, dư địa / s). Không bỏ lệnh nào, chỉ thu nhỏ.`);
      console.log("=".repeat(104));
      console.log(HEADER);
      console.log("-".repeat(104));
      const base = score(runBooks(bk(p), heat), w);
      printRow("tỉ trọng đều (đang chạy)", base);
      for (const s of [1, 2, 3, 4, 6]) {
        const admit: AdmitFn = (c) => {
          const r = roomAt(room, c.symbol, c.time, c.dir);
          return heat(c) * Math.max(0, Math.min(1, r / s));
        };
        printRow(`s = ${s}×ATR`, score(runBooks(bk(p), admit), w), base.mult);
      }
      console.log("  ── PLACEBO (tỉ trọng NGHỊCH với dư địa — phải xấu) ──");
      for (const s of [2, 4]) {
        const admit: AdmitFn = (c) => {
          const r = roomAt(room, c.symbol, c.time, c.dir);
          if (!Number.isFinite(r)) return heat(c) * 0.2;
          return heat(c) * Math.max(0.05, Math.min(1, s / Math.max(0.2, r) / s));
        };
        printRow(`PLACEBO nghịch s=${s}`, score(runBooks(bk(p), admit), w), base.mult);
      }
      console.log();
    }
  }
}

if (require.main === module && /exp-keylevel-room\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
