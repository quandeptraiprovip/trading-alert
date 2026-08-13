/**
 * exp-floor-policy.ts — khi unit rơi DƯỚI sàn minNotional: TỪ CHỐI hay VÀO Ở SÀN?
 *
 * VÌ SAO ĐÂY LÀ HƯỚNG DUY NHẤT TẠO TIỀN MÀ KHÔNG CẦN THÊM VỐN: mọi đề xuất trước đều chờ người
 * dùng chuyển tiền giữa sàn hoặc nâng risk/unit. Cái này không — nó dùng đúng $192,68 đang có, và
 * chỉ đổi MỘT quyết định mà `live-trade.ts` đang làm theo một hướng: khi risk hiệu dụng sau khi nâng
 * qty vượt ngân sách thì nó TỪ CHỐI lệnh. Nhưng "vào ở sàn, chịu risk cao hơn dự định" là một lựa
 * chọn hợp lệ chưa từng được đo. Ở $193 nó quyết định số phận của 18% số unit — và gần như toàn bộ
 * BTC/ETH.
 *
 * MÔ HÌNH: unit bị nâng lên sàn mang risk lớn hơn dự định đúng hệ số
 *      lift = floor ÷ notional_dự_định        (lift > 1)
 * `weight` trong engine CHÍNH LÀ bội số risk, nên trả `w × lift` là mô hình hoá đúng cả phần lãi
 * thêm LẪN phần rủi ro thêm — không phải chỉ đếm phần được. (Trần weight ≤ 1 của `askAdmit` đã được
 * bỏ để biểu diễn được điều này; no-op với mọi AdmitFn cũ.)
 *
 * BIẾN QUÉT: `maxLift` — chấp nhận nâng tới mấy lần risk dự định, quá thì vẫn từ chối.
 *   maxLift = 1   ⇔ HÀNH VI HIỆN TẠI (từ chối mọi unit dưới sàn)
 *   maxLift = ∞   ⇔ luôn vào ở sàn, bất kể risk đội lên bao nhiêu
 * Kỳ vọng có cực trị bên trong: nâng nhẹ thì đáng (lấy lại lệnh bị mất), nâng mạnh thì một unit BTC
 * có thể ngốn 3× ngân sách risk và phá hình dạng danh mục.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-floor-policy.ts [days]
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
 * LUẬT LIVE THẬT (`live-trade.ts:181-193` + `turtle-live.ts:313-317`): live KHÔNG từ chối unit dưới
 * sàn — nó bật `minQtyFloor` để NÂNG qty lên sàn, rồi chỉ từ chối nếu risk hiệu dụng vượt
 * `maxRiskFrac = positionRiskBudget() = pyramidMaxUnits × riskPct`. `weight` chính là bội số riskPct
 * nên ngân sách đó = weight 3,0 cho CẢ vị thế, trừ đi phần các unit đang mở của chính symbol đó.
 *
 * ⇒ Mô hình "đang chạy = maxLift 1×" ở bản trước SAI (quá bi quan). Hàm này là bản đúng.
 */
function admitLiveRule(k: number, equity: number, riskPct: number, floors: Map<string, number>): AdmitFn {
  return (c: AdmitCtx) => {
    const w = k > 0 ? 1 / (1 + c.sameDirHeat / k) : 1;
    if (c.entryPrice == null || c.initialSL == null) return w;
    const stopFrac = Math.abs(c.entryPrice - c.initialSL) / c.entryPrice;
    const floor = floors.get(c.symbol.toLowerCase()) ?? 0;
    if (!(stopFrac > 0) || floor <= 0) return w;
    const notional = (equity * riskPct * w) / stopFrac;
    if (notional >= floor) return w;
    const lifted = w * (floor / notional);
    const used = c.open.filter((u) => u.symbol.toLowerCase() === c.symbol.toLowerCase())
      .reduce((s, u) => s + u.weight, 0);
    return lifted <= T.pyramidMaxUnits - used ? lifted : 0;
  };
}

function admitFloorPolicy(k: number, equity: number, riskPct: number, maxLift: number, floors: Map<string, number>): AdmitFn {
  return (c: AdmitCtx) => {
    const w = k > 0 ? 1 / (1 + c.sameDirHeat / k) : 1;
    if (c.entryPrice == null || c.initialSL == null) return w;
    const stopFrac = Math.abs(c.entryPrice - c.initialSL) / c.entryPrice;
    const floor = floors.get(c.symbol.toLowerCase()) ?? 0;
    if (!(stopFrac > 0) || floor <= 0) return w;
    const notional = (equity * riskPct * w) / stopFrac;
    if (notional >= floor) return w;
    const lift = floor / notional;
    return lift <= maxLift ? w * lift : 0;
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
  const snap: Partial<ExtParams> = { admitBarSnapshot: true };
  const books = (): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p: { ...turtle, ...snap } }));

  console.log(
    `Cửa sổ ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)} · ` +
    `${data.size} coin · sổ TURTLE · phân bổ ĐẦU NẾN\n` +
    "lãi/sụt %vốn ≈ (NetR / maxDD_R) × risk/unit — quy về cùng đơn vị để so được giữa các chính sách.\n",
  );

  const LIFTS = [1, 1.25, 1.5, 2, 3, 5, Infinity];
  const SCEN: [string, number, number, number][] = [
    ["ĐANG CHẠY  k=4 · $193 · 0,5%", 4, 192.68, 0.005],
    ["k=0,5 · $193 · 0,5%", 0.5, 192.68, 0.005],
    ["k=0,5 · $513 · 1,0%", 0.5, 513, 0.01],
  ];
  const YEAR = 365 * 86400e3;

  for (const [label, k, eq, rp] of SCEN) {
    console.log(`═══ ${label} ═══`);
    console.log("maxLift".padEnd(10) + "lệnh".padStart(7) + "BTC".padStart(6) + "Sharpe".padStart(8) +
      "lãi %vốn".padStart(10) + "sụt %vốn".padStart(10) + "lãi/sụt".padStart(9) + "365d lãi/sụt".padStart(14));
    for (const L of LIFTS) {
      const res = runBooks(books(), admitFloorPolicy(k, eq, rp, L, floors));
      const ts = res.trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);
      const m = riskMetrics(res.equity);
      const gain = contrib(ts) * rp * 100, dd = m.maxDD * rp * 100;
      const rTs = res.trades.filter((t) => t.entryTime >= w.to - YEAR);
      const rEq = res.equity.filter((e) => e.time >= w.to - YEAR);
      let peak = -Infinity, rdd = 0;
      for (const e of rEq) { peak = Math.max(peak, e.mtm); rdd = Math.max(rdd, peak - e.mtm); }
      const rGain = contrib(rTs) * rp * 100, rDd = rdd * rp * 100;
      console.log(
        (L === Infinity ? "∞" : `${L}×`).padEnd(10) + String(ts.length).padStart(7) +
        String(ts.filter((t) => t.symbol.toLowerCase() === "btcusdt").length).padStart(6) +
        m.sharpe.toFixed(2).padStart(8) + `${gain.toFixed(0)}%`.padStart(10) + `${dd.toFixed(0)}%`.padStart(10) +
        (dd > 0 ? (gain / dd).toFixed(2) : "—").padStart(9) +
        (rDd > 0 ? (rGain / rDd).toFixed(2) : "—").padStart(14),
      );
    }
    console.log();
  }

  // ── LUẬT LIVE THẬT so với các mô hình giả định ───────────────────────────
  console.log("═══ LUẬT LIVE THẬT (minQtyFloor + trần 3×riskPct) vs các mô hình ═══");
  console.log("mô hình".padEnd(48) + "lệnh".padStart(7) + "BTC".padStart(6) + "Sharpe".padStart(8) +
    "lãi %vốn".padStart(10) + "sụt %vốn".padStart(10) + "lãi/sụt".padStart(9) + "365d".padStart(9));
  const YEAR2 = 365 * 86400e3;
  const variants: [string, AdmitFn, number][] = [
    ["TỪ CHỐI (mô hình cũ của tôi — SAI)", admitFloorPolicy(4, 192.68, 0.005, 1, floors), 0.005],
    ["ĐANG CHẠY: luật live, k=4 · $193 · 0,5%", admitLiveRule(4, 192.68, 0.005, floors), 0.005],
    ["không có sàn (lý thuyết)", admitFloorPolicy(4, 1e12, 1, 1, floors), 0.005],
    ["ĐỀ XUẤT: luật live, k=0,5 · $513 · 1,0%", admitLiveRule(0.5, 513, 0.01, floors), 0.01],
    ["ĐỀ XUẤT nhưng vốn hiện tại: k=0,5 · $193 · 1,0%", admitLiveRule(0.5, 192.68, 0.01, floors), 0.01],
  ];
  for (const [label, fn, rp] of variants) {
    const res = runBooks(books(), fn);
    const ts = res.trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);
    const m = riskMetrics(res.equity);
    const gain = contrib(ts) * rp * 100, dd = m.maxDD * rp * 100;
    const rTs = res.trades.filter((t) => t.entryTime >= w.to - YEAR2);
    const rEq = res.equity.filter((e) => e.time >= w.to - YEAR2);
    let pk = -Infinity, rdd = 0;
    for (const e of rEq) { pk = Math.max(pk, e.mtm); rdd = Math.max(rdd, pk - e.mtm); }
    const r365 = rdd > 0 ? (contrib(rTs) * rp * 100) / (rdd * rp * 100) : 0;
    console.log(
      label.padEnd(48) + String(ts.length).padStart(7) +
      String(ts.filter((t) => t.symbol.toLowerCase() === "btcusdt").length).padStart(6) +
      m.sharpe.toFixed(2).padStart(8) + `${gain.toFixed(0)}%`.padStart(10) +
      `${dd.toFixed(0)}%`.padStart(10) + (dd > 0 ? (gain / dd).toFixed(2) : "—").padStart(9) + r365.toFixed(2).padStart(9),
    );
  }
  console.log();

  // ── CỬA TẬP TRUNG ────────────────────────────────────────────────────────
  // Toàn bộ phần tăng đến từ việc BTC/ETH được vào lệnh trở lại (BTC 6 → 102). Câu hỏi bắt buộc:
  // lợi nhuận có dồn vào đúng mấy symbol vừa mở khoá, hay trải đều? Đây chính là cửa đã bắt được
  // thứ mà perturbation/leave-one-out/holdout/era đều bỏ lọt.
  console.log("═══ CỬA TẬP TRUNG — k=4 · $193 · 0,5%, maxLift 1× vs 3× ═══");
  for (const L of [1, 3]) {
    const res = runBooks(books(), admitFloorPolicy(4, 192.68, 0.005, L, floors));
    const ts = res.trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);
    const total = contrib(ts);
    const bySym = new Map<string, number>();
    const byYear = new Map<number, number>();
    for (const t of ts) {
      const s = t.symbol.toLowerCase();
      bySym.set(s, (bySym.get(s) ?? 0) + t.netR * t.weight);
      const y = new Date(t.exitTime).getUTCFullYear();
      byYear.set(y, (byYear.get(y) ?? 0) + t.netR * t.weight);
    }
    const topS = [...bySym.entries()].sort((a, b) => b[1] - a[1])[0];
    const topY = [...byYear.entries()].sort((a, b) => b[1] - a[1])[0];
    console.log(
      `maxLift ${L}×`.padEnd(12) + `tổng ${total.toFixed(0)}R`.padStart(12) +
      `  công cụ lớn nhất ${topS[0].replace("usdt", "").toUpperCase()} ${((topS[1] / total) * 100).toFixed(0)}%` +
      `  ·  năm lớn nhất ${topY[0]} ${((topY[1] / total) * 100).toFixed(0)}%` +
      `  ·  ${(topS[1] / total) < 0.5 && (topY[1] / total) < 0.5 ? "✅ ĐẬU" : "❌ RỚT"}`,
    );
    console.log("   " + [...bySym.entries()].sort((a, b) => b[1] - a[1])
      .map(([s, v]) => `${s.replace("usdt", "").toUpperCase()} ${((v / total) * 100).toFixed(0)}%`).join(" · "));
  }

  console.log(
    "\n═══ CÁCH ĐỌC ═══\n" +
    "• Hàng maxLift=1 LÀ hành vi đang chạy. Mọi hàng dưới là thay đổi CHỈ CẦN SỬA CODE, không cần\n" +
    "  thêm một đồng vốn nào và không cần đổi khẩu vị rủi ro đã chọn.\n" +
    "• Cột quyết định là lãi/sụt, không phải lãi. Nâng risk lên sàn thì lãi tăng NHƯNG sụt cũng tăng.\n" +
    "• Cột 365d là cửa chặn: cải thiện phải còn đúng ở cửa sổ gần nhất mới dùng được.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
