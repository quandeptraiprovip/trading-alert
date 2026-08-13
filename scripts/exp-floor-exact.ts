/**
 * exp-floor-exact.ts — sàn minNotional áp TRONG vòng lặp, không phải lọc sau.
 *
 * VÌ SAO CẦN, và nó sửa gì của `exp-floor-k.ts`: bản trước chạy engine rồi mới loại unit dưới sàn.
 * Cách đó bỏ qua hiệu ứng bậc hai — **bỏ một unit làm heat giảm, nên unit SAU đáng lẽ được size to
 * hơn và có thể tự vượt sàn**. Tức bản trước là ước lượng BI QUAN, và cả quyết định "gộp sổ hay
 * nâng risk" đang tựa lên nó. File này khép sai số đó: hàm `admit` trả 0 ngay tại chỗ, nên phần còn
 * lại của phiên chạy đúng như một tài khoản thật cỡ đó.
 *
 * Làm được nhờ `AdmitCtx` nay mang theo `entryPrice`/`initialSL` (thêm 2026-08-13, optional nên mọi
 * AdmitFn cũ chạy y nguyên; `portfolio-equivalence.ts` vẫn TRÙNG KHỚP 100%).
 *
 * Đọc: cột "chính xác" so với cột "lọc sau" cho biết ước lượng cũ lệch bao nhiêu — và lệch theo
 * hướng nào.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-floor-exact.ts [days]
 */
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitCtx, AdmitFn, Book, ExtParams, UnitTrade, riskMetrics, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";

async function minNotionals(): Promise<Map<string, number>> {
  const r = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo");
  if (!r.ok) throw new Error(`Binance exchangeInfo HTTP ${r.status}`);
  const j: any = await r.json();
  const out = new Map<string, number>();
  for (const s of j.symbols ?? []) {
    const n = (s.filters ?? []).find((f: any) => f.filterType === "MIN_NOTIONAL");
    out.set(String(s.symbol).toLowerCase(), parseFloat(n?.notional ?? n?.minNotional ?? "0"));
  }
  return out;
}

/**
 * heat-decay như production, RỒI áp sàn sàn giao dịch. Trả 0 = không vào lệnh, đúng hành vi
 * `live-trade.ts` khi risk hiệu dụng sau khi nâng qty vượt ngân sách.
 */
function admitWithFloor(k: number, equity: number, riskPct: number, floors: Map<string, number>): AdmitFn {
  return (c: AdmitCtx) => {
    const w = k > 0 ? 1 / (1 + c.sameDirHeat / k) : 1;
    if (c.entryPrice == null || c.initialSL == null) return w;
    const stopFrac = Math.abs(c.entryPrice - c.initialSL) / c.entryPrice;
    if (!(stopFrac > 0)) return w;
    const floor = floors.get(c.symbol.toLowerCase()) ?? 0;
    if (floor <= 0) return w;
    return (equity * riskPct * w) / stopFrac >= floor ? w : 0;
  };
}

const contrib = (ts: UnitTrade[]) => ts.reduce((s, t) => s + t.netR * t.weight, 0);

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const floors = await minNotionals();
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  console.log(
    `Cửa sổ ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)} · ` +
    `${data.size} coin · sổ TURTLE · phân bổ ĐẦU NẾN · sàn áp TRONG vòng lặp\n`,
  );

  const snap: Partial<ExtParams> = { admitBarSnapshot: true };
  // BẪY: `AdmitCtx.symbol` thực ra là BOOK KEY (runBooks tra `ctxs` bằng `b.key`), không phải mã
  // symbol. Đặt key = "btcusdt@tag" làm `floors.get(...)` trượt và sàn im lặng KHÔNG chặn gì —
  // bảng ra 100% ở mọi cỡ vốn, trông như "không có vấn đề gì". Ở đây chỉ chạy một sleeve nên key
  // trùng symbol là đủ và an toàn.
  const books = (): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p: { ...turtle, ...snap } }));
  const inWin = (ts: UnitTrade[]) => ts.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);

  const KS = [4, 1, 0.5];
  const CASES: [string, number, number][] = [
    ["ĐANG CHẠY  $193 · 0,5%", 192.68, 0.005],
    ["$193 · 1,0%", 192.68, 0.01],
    ["gộp sổ $513 · 0,5%", 513, 0.005],
    ["gộp sổ $513 · 1,0%", 513, 0.01],
    ["$1000 · 1,0%", 1000, 0.01],
    ["KHÔNG SÀN (lý thuyết)", 1e12, 1],
  ];

  for (const k of KS) {
    console.log(`═══ k = ${k} ═══`);
    // Net R và maxDD R KHÔNG so được giữa các mức risk/unit — phải quy về % VỐN thì mới cùng đơn vị:
    //   lãi ≈ Net R × risk/unit   ·   sụt ≈ maxDD R × risk/unit
    // (xấp xỉ không cộng dồn; đủ để xếp hạng, và nó là thứ chặn "nâng risk = tự do có thêm tiền".)
    console.log("cấu hình".padEnd(26) + "lệnh".padStart(7) + "Net R".padStart(8) +
      "%lý thuyết".padStart(12) + "Sharpe".padStart(8) + "BTC".padStart(6) +
      "lãi %vốn".padStart(10) + "SỤT %vốn".padStart(10) + "lãi/sụt".padStart(9));
    const base = contrib(inWin(runBooks(books(), admitWithFloor(k, 1e12, 1, floors)).trades));
    for (const [label, eq, rp] of CASES) {
      const res = runBooks(books(), admitWithFloor(k, eq, rp, floors));
      const ts = inWin(res.trades);
      const m = riskMetrics(res.equity);
      const btcN = ts.filter((t) => t.symbol.toLowerCase() === "btcusdt").length;
      const rp2 = rp > 0.5 ? 0.005 : rp; // hàng "KHÔNG SÀN" dùng risk giả 100%, quy về 0,5% để đọc được
      const gain = contrib(ts) * rp2 * 100;
      const dd = m.maxDD * rp2 * 100;
      console.log(
        label.padEnd(26) + String(ts.length).padStart(7) + contrib(ts).toFixed(0).padStart(8) +
        `${((contrib(ts) / base) * 100).toFixed(0)}%`.padStart(12) +
        m.sharpe.toFixed(2).padStart(8) + String(btcN).padStart(6) +
        `${gain.toFixed(0)}%`.padStart(10) + `${dd.toFixed(0)}%`.padStart(10) +
        (dd > 0 ? (gain / dd).toFixed(2) : "—").padStart(9),
      );
    }
    console.log();
  }

  // ── Gói ĐANG CHẠY vs gói ĐỀ XUẤT, tách theo giai đoạn ────────────────────
  // Con số "+21% ở cùng mức sụt" là trung bình 5,5 năm. Chuẩn của repo (upgrades-vs-trailing-year)
  // đòi mọi đề xuất phải tốt hơn CẢ ở cửa sổ 365 ngày gần nhất — chỗ mà cấu hình đang chạy từng
  // thua bản cũ. Không qua cửa này thì "+21%" không dùng được để quyết định.
  console.log("═══ GÓI ĐANG CHẠY vs GÓI ĐỀ XUẤT, theo giai đoạn (lãi %vốn / sụt %vốn) ═══");
  const YEAR = 365 * 86400e3;
  const PKG: [string, number, number, number][] = [
    ["ĐANG CHẠY  k=4 · $193 · 0,5%", 4, 192.68, 0.005],
    ["ĐỀ XUẤT   k=0,5 · $513 · 1,0%", 0.5, 513, 0.01],
  ];
  const SEGS: [string, number, number][] = [
    ["toàn mẫu 5,5 năm", w.from, w.to],
    ["365 ngày gần nhất", w.to - YEAR, w.to],
    ["era A (đầu)", w.from, w.from + (w.to - w.from) / 3],
    ["era B (giữa)", w.from + (w.to - w.from) / 3, w.from + (2 * (w.to - w.from)) / 3],
    ["era C (cuối)", w.from + (2 * (w.to - w.from)) / 3, w.to],
  ];
  console.log("giai đoạn".padEnd(20) + PKG.map(([l]) => l.slice(0, 14).padStart(18)).join("") + "chênh lãi".padStart(12));
  for (const [segName, from, to] of SEGS) {
    const cells = PKG.map(([, k, eq, rp]) => {
      const res = runBooks(books(), admitWithFloor(k, eq, rp, floors));
      const ts = res.trades.filter((t) => t.entryTime >= from && t.entryTime <= to);
      const eq2 = res.equity.filter((e) => e.time >= from && e.time <= to);
      let peak = -Infinity, dd = 0;
      for (const e of eq2) { peak = Math.max(peak, e.mtm); dd = Math.max(dd, peak - e.mtm); }
      return { gain: contrib(ts) * rp * 100, dd: dd * rp * 100 };
    });
    console.log(
      segName.padEnd(20) + cells.map((c) => `${c.gain.toFixed(0)}% / ${c.dd.toFixed(0)}%`.padStart(18)).join("") +
      `${(cells[1].gain - cells[0].gain).toFixed(0)}%`.padStart(12),
    );
  }

  console.log(
    "\n═══ CÁCH ĐỌC ═══\n" +
    "• So cột \"% so lý thuyết\" với bản LỌC SAU (exp-floor-k.ts) để biết ước lượng cũ lệch bao nhiêu.\n" +
    "  Bản mới cao hơn là đúng kỳ vọng: bỏ unit làm heat giảm ⇒ unit sau to hơn ⇒ tự vượt sàn.\n" +
    "• Cột \"BTC lệnh\" là câu hỏi thật: bao nhiêu lệnh BTC thực sự vào được ở cỡ vốn đó.\n" +
    "• maxDD tính bằng R nên KHÔNG so được giữa các mức risk/unit — nhân đôi risk/unit thì maxDD\n" +
    "  theo $ nhân đôi, còn maxDD theo R gần như giữ nguyên. Đừng đọc cột đó như 'nâng risk vẫn an toàn'.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
