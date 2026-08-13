/**
 * exp-snap-netr.ts — thay đổi ĐÃ SHIP (ảnh chụp heat đầu nến, k GIỮ 4) làm NET R đổi bao nhiêu?
 *
 * VÌ SAO CẦN ĐO RIÊNG: các bảng trước chấm bằng "vốn ×" (ép cùng maxDD rồi xem ai cho nhiều tiền
 * hơn) — đó là thước đúng để so hai chính sách risk, nhưng nó KHÔNG trả lời thẳng câu "Net R đổi
 * bao nhiêu". Và hai bảng đó cũng gộp cả phần siết k=0,5, thứ CHƯA ship. Ở đây cô lập đúng một
 * thay đổi đã vào code sống: `k = 4` cả hai bên, chỉ khác cách chấm heat.
 *
 * ĐIỂM PHẢI HIỂU ĐÚNG TRƯỚC KHI ĐỌC SỐ: bản TUẦN TỰ không có MỘT giá trị Net R. Nó có một KHOẢNG,
 * vì kết quả phụ thuộc thứ tự symbol trong mảng — thứ không mang nghĩa giao dịch nào. Bản ảnh chụp
 * có đúng một giá trị. Nên phép so đúng là "một điểm so với một khoảng", và cái được lớn nhất là
 * KHOẢNG BIẾN MẤT, chứ không phải điểm giữa dịch lên.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-snap-netr.ts [days]
 */
import { Candle } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { Book, ExtParams, riskMetrics, runBooks } from "./portfolio-engine";
import { decayH } from "./rx-lab";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  const years = (w.to - w.from) / (365 * 86400e3);
  console.log(
    `Cửa sổ ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)}` +
    ` (${years.toFixed(1)} năm) · ${data.size} coin · k = ${T.heatDecayK} ở CẢ HAI cột\n`,
  );

  const ents = [...data.entries()];
  const orders: [string, [string, Candle[]][]][] = [
    ["gốc", ents],
    ["đảo", [...ents].reverse()],
    ["xoay", [...ents.slice(4), ...ents.slice(0, 4)]],
    ["abc", [...ents].sort((a, b) => a[0].localeCompare(b[0]))],
  ];

  /** Net R + Sharpe + maxDD của một sổ, ở một thứ tự symbol, một chế độ chấm heat. */
  function measure(p: ExtParams, e: [string, Candle[]][], snap: boolean, tag: string) {
    const patch: Partial<ExtParams> = snap ? { admitBarSnapshot: true } : {};
    const books: Book[] = e.map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p: { ...p, ...patch } }));
    const m = riskMetrics(runBooks(books, decayH(T.heatDecayK)).equity);
    return { netR: m.netR, sharpe: m.sharpe, maxDD: m.maxDD };
  }

  function block(title: string, mk: (e: [string, Candle[]][], snap: boolean, tag: string) => ReturnType<typeof measure>) {
    console.log(`═══ ${title} ═══`);
    console.log("chế độ".padEnd(12) + orders.map(([t]) => t.padStart(11)).join("") +
      "biên độ".padStart(11) + "Sharpe".padStart(9) + "maxDD R".padStart(10));
    for (const snap of [false, true]) {
      const rs = orders.map(([tag, e], i) => mk(e, snap, `${title[0]}${snap}${i}`));
      const ns = rs.map((r) => r.netR);
      const spread = Math.max(...ns) - Math.min(...ns);
      console.log(
        (snap ? "ĐẦU NẾN" : "tuần tự").padEnd(12) +
        ns.map((n) => n.toFixed(1).padStart(11)).join("") +
        `${spread.toFixed(1)}R`.padStart(11) +
        (rs.reduce((s, r) => s + r.sharpe, 0) / rs.length).toFixed(2).padStart(9) +
        (rs.reduce((s, r) => s + r.maxDD, 0) / rs.length).toFixed(1).padStart(10),
      );
    }
    console.log();
  }

  block("TURTLE — đúng sổ vừa sửa trong turtle-live.ts",
    (e, snap, tag) => measure(turtle, e, snap, tag));

  block("HAI SLEEVE chạy chung (Turtle + Fast)", (e, snap, tag) => {
    const patch: Partial<ExtParams> = snap ? { admitBarSnapshot: true } : {};
    const books: Book[] = [
      ...e.map(([symbol, candles]) => ({ key: `${symbol}@t${tag}`, symbol, candles, p: { ...turtle, ...patch } })),
      ...e.map(([symbol, candles]) => ({ key: `${symbol}@f${tag}`, symbol, candles, p: { ...fast, ...patch } })),
    ];
    const m = riskMetrics(runBooks(books, decayH(T.heatDecayK)).equity);
    return { netR: m.netR, sharpe: m.sharpe, maxDD: m.maxDD };
  });

  console.log(
    "═══ CÁCH ĐỌC ═══\n" +
    "• Cột \"biên độ\" của hàng TUẦN TỰ là phần Net R sinh ra từ VỊ TRÍ SYMBOL TRONG MẢNG — không\n" +
    "  phải từ luật giao dịch. Hàng ĐẦU NẾN có biên độ 0,0R: cùng một con số ở mọi thứ tự.\n" +
    "• So điểm-với-điểm (đầu nến vs trung bình tuần tự) là phần Net R thực sự đổi. Nó NHỎ, và đúng\n" +
    "  như kỳ vọng: thay đổi này sửa một hiện vật, không thêm edge nào.\n" +
    "• Phần lợi lớn (+95% vốn) nằm ở bước SIẾT k — chưa ship, đang vướng min-notional.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
