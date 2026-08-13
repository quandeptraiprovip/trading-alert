/**
 * exp-floor-k.ts — SÀN minNotional ĂN MẤT BAO NHIÊU của bước siết k, và từ mức vốn nào thì hết?
 *
 * LỖ HỔNG MÔ HÌNH ĐANG BỊT: mọi bảng đo trước (kể cả con số "+95% vốn" của cấu hình đầu-nến + k=0,5)
 * đều giả định size ĐÚNG TUYỆT ĐỐI. Ở equity thật, unit nào có notional dưới sàn của sàn giao dịch
 * sẽ bị `live-trade.ts` nâng qty lên sàn rồi TỪ CHỐI nếu risk hiệu dụng vượt ngân sách. Siết k làm
 * unit nhỏ đi (k=0,5 → thang 1,00/0,33/0,27, rổ đông ≈0,17) nên nó ĐẶC BIỆT nhạy với sàn này.
 *   ⇒ Con số +95% là trần lý thuyết. Câu hỏi thật: ở $513 thì lấy được bao nhiêu, và cần bao nhiêu
 *     vốn thì lấy được hết.
 *
 * CÁCH ĐO: chạy engine bình thường rồi lọc SAU. Với mỗi unit đã có `entryPrice`, `initialSL`,
 * `weight` nên tính được CHÍNH XÁC:
 *      risk$ = equity × riskPct × weight
 *      notional = risk$ / (|entry − initialSL| / entry)
 * Unit nào notional < minNotional của symbol thì áp một trong hai chính sách:
 *      BỎ   — không vào lệnh (đúng hành vi từ chối khi risk hiệu dụng vượt ngân sách)
 *      NÂNG — vẫn vào nhưng ở đúng sàn, tức risk THẬT lớn hơn dự định ⇒ netR nhân hệ số nâng
 *
 * GIỚI HẠN PHẢI NÓI TRƯỚC: lọc sau bỏ qua hiệu ứng bậc hai — bỏ một unit làm heat giảm nên unit sau
 * đáng lẽ to hơn. Vì thế cột "BỎ" là ước lượng THẬN TRỌNG (bi quan) chứ không phải chính xác. Nó đủ
 * để trả lời câu hỏi quyết định (có đáng siết k ở vốn này không) mà không phải sửa engine đã audit.
 *
 * ⚠️ ĐÃ ĐƯỢC THAY THẾ MỘT PHẦN bởi `exp-floor-exact.ts` (áp sàn TRONG vòng lặp). Ước lượng "giữ 65%
 * Net R" ở đây là BI QUAN — số đúng là **82%**, vì bỏ một unit làm heat giảm nên unit sau to hơn và
 * tự vượt sàn. Giữ file này vì nó có hai thứ bản kia không có: phân rã CHẶN THEO SYMBOL, và phép
 * bác bỏ giả thuyết "sàn là bộ lọc chọn ngược".
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-floor-k.ts [days]
 */
import { T, buildBtcGateLongs } from "../turtle";
import { Book, ExtParams, UnitTrade, runBooks } from "./portfolio-engine";
import { decayH } from "./rx-lab";
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

interface Outcome { n: number; blocked: number; netIdeal: number; netSkip: number; netLift: number }

/**
 * Áp sàn lên một tập unit. `weight` đã gồm heat, nên notional dự định phản ánh đúng chính sách k.
 * Đóng góp danh mục của một unit = netR × weight (xem chú thích `UnitTrade.weight`).
 */
function applyFloor(trades: UnitTrade[], equity: number, riskPct: number, floors: Map<string, number>): Outcome {
  const o: Outcome = { n: 0, blocked: 0, netIdeal: 0, netSkip: 0, netLift: 0 };
  for (const t of trades) {
    const stopFrac = Math.abs(t.entryPrice - t.initialSL) / t.entryPrice;
    if (!(stopFrac > 0)) continue;
    const contrib = t.netR * t.weight;
    const risk$ = equity * riskPct * t.weight;
    const notional = risk$ / stopFrac;
    const floor = floors.get(t.symbol.toLowerCase()) ?? 0;
    o.n++;
    o.netIdeal += contrib;
    if (notional >= floor || floor <= 0) {
      o.netSkip += contrib;
      o.netLift += contrib;
    } else {
      o.blocked++;
      // BỎ: không đóng góp gì. NÂNG: risk thật bị đội lên đúng tỉ lệ sàn/notional.
      o.netLift += contrib * (floor / notional);
    }
  }
  return o;
}

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
    `${data.size} coin · sổ TURTLE · sàn minNotional lấy trực tiếp từ Binance fapi\n`,
  );

  const snap: Partial<ExtParams> = { admitBarSnapshot: true };
  const KS = [4, 1, 0.5];
  const EQUITIES = [192.68, 513, 1000, 2000, 5000, 10000];

  // Chạy engine MỘT LẦN cho mỗi k (sàn chỉ ảnh hưởng lúc lọc sau, không ảnh hưởng chuỗi lệnh).
  const byK = new Map<number, UnitTrade[]>();
  for (const k of KS) {
    const books: Book[] = [...data.entries()].map(([symbol, candles]) => ({
      key: `${symbol}@k${k}`, symbol, candles, p: { ...turtle, ...snap },
    }));
    byK.set(k, runBooks(books, decayH(k)).trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to));
  }

  // Sàn thật, in ra để kiểm — một MIN_NOTIONAL parse hụt thành 0 sẽ làm cả bảng sai mà không báo lỗi.
  console.log("sàn minNotional: " + CORE8.map((s) => `${s.replace("usdt", "").toUpperCase()} $${floors.get(s) ?? "?"}`).join(" · ") + "\n");

  for (const riskPct of [0.005, 0.01]) {
    console.log(`═══ risk/unit = ${(riskPct * 100).toFixed(1)}% (tất cả đều bật phân bổ ĐẦU NẾN) ═══`);
    console.log(
      "equity".padStart(9) + KS.map((k) => `k=${k}`.padStart(23)).join("") +
      "   [% unit bị chặn · Net R sau khi BỎ (so với lý thuyết)]",
    );
    for (const eq of EQUITIES) {
      let line = `$${eq.toFixed(0)}`.padStart(9);
      for (const k of KS) {
        const o = applyFloor(byK.get(k)!, eq, riskPct, floors);
        const pct = (o.blocked / o.n) * 100;
        const keep = (o.netSkip / o.netIdeal) * 100;
        line += `${pct.toFixed(0)}% · ${o.netSkip.toFixed(0)}R (${keep.toFixed(0)}%)`.padStart(23);
      }
      console.log(line);
    }
    // Net R lý thuyết để đối chiếu — đây là con số mọi bảng trước đang dùng.
    const ideal = KS.map((k) => applyFloor(byK.get(k)!, 1e9, riskPct, floors).netIdeal);
    console.log(
      "lý thuyết".padStart(9) + ideal.map((v) => `${v.toFixed(0)}R`.padStart(23)).join(""),
    );
    console.log();
  }

  // ── ATR HÔM NAY vs TRUNG BÌNH 5,5 NĂM ────────────────────────────────────
  // Bảng trên gộp cả 2021-2022 khi ATR cao gấp nhiều lần: stop rộng ⇒ notional NHỎ ⇒ bị chặn nhiều.
  // Quyết định ship là quyết định cho HÔM NAY, nên phải tách riêng cửa sổ gần đây, nếu không sẽ
  // phóng đại mức chặn. (Cùng cảnh báo đã ghi trong min-notional-feasibility: kết luận phụ thuộc
  // ATR đáy chu kỳ; vol tăng gấp đôi thì ngưỡng vốn nhân đôi.)
  const YEAR = 365 * 86400e3;
  const recentFrom = w.to - YEAR;
  console.log("═══ CHỈ 365 NGÀY GẦN NHẤT — mức chặn ở chế độ vol HIỆN TẠI ═══");
  console.log("equity".padStart(9) + KS.map((k) => `k=${k}`.padStart(23)).join("") + "   [risk/unit 0,5%]");
  for (const eq of [192.68, 513, 1000, 2000]) {
    let line = `$${eq.toFixed(0)}`.padStart(9);
    for (const k of KS) {
      const recent = byK.get(k)!.filter((t) => t.entryTime >= recentFrom);
      const o = applyFloor(recent, eq, 0.005, floors);
      line += (o.n === 0 ? "—" : `${((o.blocked / o.n) * 100).toFixed(0)}% · ${o.netSkip.toFixed(0)}R (${((o.netSkip / o.netIdeal) * 100).toFixed(0)}%)`).padStart(23);
    }
    console.log(line);
  }
  console.log(`(n = ${byK.get(4)!.filter((t) => t.entryTime >= recentFrom).length} unit trong 365 ngày)\n`);

  // ── CHẶN THEO SYMBOL ở đúng cấu hình ĐANG CHẠY ───────────────────────────
  // Một tỉ lệ gộp "37% bị chặn" không nói được điều quan trọng nhất: nếu nó dồn vào MỘT symbol thì
  // sổ đang thiếu hẳn một cấu phần chứ không phải bị hao đều.
  console.log("═══ CHẶN THEO SYMBOL — cấu hình ĐANG CHẠY (k=4, risk 0,5%, equity $192,68) ═══");
  const cur = byK.get(4)!;
  for (const sym of CORE8) {
    const ts = cur.filter((t) => t.symbol.toLowerCase() === sym);
    if (!ts.length) continue;
    const o = applyFloor(ts, 192.68, 0.005, floors);
    const recent = ts.filter((t) => t.entryTime >= recentFrom);
    const oR = applyFloor(recent, 192.68, 0.005, floors);
    console.log(
      sym.replace("usdt", "").toUpperCase().padEnd(6) + `sàn $${floors.get(sym)}`.padStart(9) +
      `${((o.blocked / o.n) * 100).toFixed(0)}% chặn (5,5 năm)`.padStart(22) +
      (oR.n ? `${((oR.blocked / oR.n) * 100).toFixed(0)}% chặn (365 ngày)` : "—").padStart(23) +
      `  Net R mất: ${(o.netIdeal - o.netSkip).toFixed(0)}R / ${o.netIdeal.toFixed(0)}R`,
    );
  }

  // ── VÌ SAO BTC LẬT DẤU: sàn là một bộ lọc CHỌN NGƯỢC ─────────────────────
  // notional = risk$ / stopFrac ⇒ unit có stop HẸP thì notional LỚN nên LỌT sàn, unit stop RỘNG bị
  // chặn. Trong hệ trend, stop hẹp là loại dễ bị quét nhất. Nghĩa là sàn không lấy ngẫu nhiên một
  // phần lệnh — nó lấy đúng phần tệ nhất. Kiểm bằng cách so netR trung bình của hai nhóm.
  console.log("\n═══ SÀN LÀ BỘ LỌC CHỌN NGƯỢC? — netR trung bình của unit LỌT vs BỊ CHẶN ═══");
  console.log("symbol".padEnd(7) + "stopFrac lọt".padStart(14) + "stopFrac chặn".padStart(15) +
    "netR lọt".padStart(11) + "netR chặn".padStart(11) + "n lọt/chặn".padStart(13));
  for (const sym of [...CORE8, "TỔNG"]) {
    const ts = sym === "TỔNG" ? cur : cur.filter((t) => t.symbol.toLowerCase() === sym);
    const pass: UnitTrade[] = [], block: UnitTrade[] = [];
    for (const t of ts) {
      const sf = Math.abs(t.entryPrice - t.initialSL) / t.entryPrice;
      if (!(sf > 0)) continue;
      const notional = (192.68 * 0.005 * t.weight) / sf;
      ((notional >= (floors.get(t.symbol.toLowerCase()) ?? 0)) ? pass : block).push(t);
    }
    if (!pass.length || !block.length) continue;
    const sf = (a: UnitTrade[]) => a.reduce((s, t) => s + Math.abs(t.entryPrice - t.initialSL) / t.entryPrice, 0) / a.length;
    const nr = (a: UnitTrade[]) => a.reduce((s, t) => s + t.netR, 0) / a.length;
    console.log(
      (sym === "TỔNG" ? sym : sym.replace("usdt", "").toUpperCase()).padEnd(7) +
      `${(sf(pass) * 100).toFixed(2)}%`.padStart(14) + `${(sf(block) * 100).toFixed(2)}%`.padStart(15) +
      nr(pass).toFixed(3).padStart(11) + nr(block).toFixed(3).padStart(11) +
      `${pass.length}/${block.length}`.padStart(13),
    );
  }

  // ── GỠ THẾ NÀO: BTC/ETH cần bao nhiêu để được giao dịch trở lại ──────────
  console.log("\n═══ GỠ CHẶN BTC/ETH — % unit LỌT sàn (k=4, phân bổ đầu nến) ═══");
  console.log("cấu hình".padEnd(30) + "BTC".padStart(10) + "ETH".padStart(10) + "cả rổ".padStart(10));
  for (const [label, eq, rp] of [
    ["ĐANG CHẠY: $193 · risk 0,5%", 192.68, 0.005],
    ["$193 · risk 1,0%", 192.68, 0.01],
    ["gộp sổ $513 · risk 0,5%", 513, 0.005],
    ["gộp sổ $513 · risk 1,0%", 513, 0.01],
    ["$1000 · risk 1,0%", 1000, 0.01],
  ] as [string, number, number][]) {
    const pass = (sym?: string) => {
      const ts = sym ? cur.filter((t) => t.symbol.toLowerCase() === sym) : cur;
      const o = applyFloor(ts, eq, rp, floors);
      return o.n ? `${(100 - (o.blocked / o.n) * 100).toFixed(0)}%` : "—";
    };
    console.log(label.padEnd(30) + pass("btcusdt").padStart(10) + pass("ethusdt").padStart(10) + pass().padStart(10));
  }

  console.log(
    "\n═══ CÁCH ĐỌC ═══\n" +
    "• Net R ở đây là đóng góp danh mục (netR × weight) nên KHÔNG so được trực tiếp giữa các k —\n" +
    "  k nhỏ nạp ít risk hơn nên Net R thô nhỏ hơn. So theo CỘT: cùng một k, vốn tăng thì giữ được\n" +
    "  bao nhiêu phần Net R lý thuyết.\n" +
    "• Mức vốn mà cột \"(%)\" chạm ~100% chính là ngưỡng siết k trở nên lấy được trọn vẹn.\n" +
    "• Cột BỎ là ước lượng THẬN TRỌNG: bỏ một unit làm heat giảm nên unit sau đáng lẽ to hơn.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
