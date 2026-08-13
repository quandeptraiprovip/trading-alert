/**
 * exp-snap-gate.ts — cửa duyệt TẬP TRUNG cho ứng viên "phân bổ đầu nến + siết k".
 *
 * `exp-concentration.ts` chỉ chạy cấu hình ĐANG CHẠY (k=4, tuần tự). Ứng viên S3 chưa từng qua cửa
 * này, mà đây đúng là cửa đã bắt được thứ mà perturbation + leave-one-out + holdout + era ĐỀU bỏ
 * lọt (xem header của file đó). Không sửa file cũ — chỉ dùng lại hàm `concentration` nó export.
 *
 * Đọc kết quả cho ĐÚNG: ứng viên này KHÔNG đổi một luật vào/ra nào, nó chỉ đổi cách chấm risk khi
 * nhiều tín hiệu rơi vào cùng một nến. Nên kỳ vọng hợp lý là hình dạng tập trung gần như GIỮ NGUYÊN
 * so với bản đang chạy. Điều cần kiểm là nó không LÀM XẤU ĐI — tức không dồn thêm lợi nhuận vào một
 * năm hay một công cụ để đổi lấy con số vốn đẹp hơn.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-snap-gate.ts [days]
 */
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, runBooks } from "./portfolio-engine";
import { decayH } from "./rx-lab";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";
import { concentration } from "./exp-concentration";

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt — không dựng được BTC gate");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  console.log(`Cửa sổ ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)} · ${data.size} coin\n`);

  const snap: Partial<ExtParams> = { admitBarSnapshot: true };
  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));

  const baseHeat: AdmitFn = decayH(T.heatDecayK);
  const newHeat: AdmitFn = decayH(0.5);

  concentration(
    "ĐANG CHẠY — hai sleeve, k=4, tuần tự",
    runBooks([...bk(turtle, "t0"), ...bk(fast, "f0")], baseHeat), w.from, w.to,
  );
  concentration(
    "ỨNG VIÊN — hai sleeve, phân bổ ĐẦU NẾN, k=0,5",
    runBooks([...bk({ ...turtle, ...snap }, "t1"), ...bk({ ...fast, ...snap }, "f1")], newHeat), w.from, w.to,
  );

  console.log(
    "\nSo hai bảng trên theo đúng một câu hỏi: ứng viên có dồn thêm lợi nhuận vào một năm hoặc một\n" +
    "công cụ để đổi lấy con số vốn đẹp hơn không? Nếu hình dạng tập trung giữ nguyên hoặc đều ra thì\n" +
    "phần cải thiện đến từ cách chấm risk, đúng như thiết kế.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
