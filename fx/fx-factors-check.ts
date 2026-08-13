/**
 * fx-factors-check.ts — KIỂM CHỨNG ENGINE TRƯỚC KHI TIN BẤT KỲ KẾT LUẬN NÀO.
 *
 * fx-factors.ts cho momentum ÂM cả ở mức gộp, trong khi Menkhoff et al. (JFE 2012) báo +10%/năm
 * gộp; và tương quan value/momentum ra ≈0 trong khi AMP 2013 báo −0,42 cho ĐÚNG lớp cặp tiền. Hai
 * lệch đó có thể là (a) thị trường đã đổi, hoặc (b) tôi cài sai. Không được viết báo cáo khi chưa
 * phân định được, vì hai khả năng dẫn tới hai kết luận trái ngược.
 *
 * Bốn phép kiểm, mỗi phép có một kỳ vọng ĐỘC LẬP với kết quả chiến lược:
 *   §1 Lịch sử từng đồng phải khớp thực tế đã biết (AUD/NZD lãi cao, JPY/CHF lãi ~0).
 *   §2 Tương quan ở TẦNG TÍN HIỆU — tách "cơ chế mất rồi" khỏi "danh mục quá thô".
 *   §3 Nhân tố đô-la và đối chứng ngẫu nhiên — engine có bịa ra alpha từ hư không không.
 *   §4 Rổ mở rộng 13 đồng: văn liệu nói momentum nằm ở đồng rủi ro cao, không phải G10.
 *
 * Chạy: npx ts-node fx/fx-factors-check.ts
 */

import {
  G9, G13, HDR, Panel, Signal, buildPanel, corr, runFactor, show,
  sigCarry, sigMom, sigValue, slicePeriod, stats,
} from "./fx-factors";

/** Hệ số tương quan hạng Spearman — đúng thứ mà một chiến lược sort quan tâm. */
function spearman(a: number[], b: number[]): number {
  const rank = (x: number[]) => {
    const order = x.map((v, i) => [v, i] as [number, number]).sort((p, q) => p[0] - q[0]);
    const r = new Array(x.length).fill(0);
    order.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  return corr(rank(a), rank(b));
}

/** Tương quan hạng trung bình giữa hai tín hiệu, tính theo từng tháng rồi lấy bình quân. */
function signalCorr(p: Panel, s1: Signal, s2: Signal): { mean: number; n: number } {
  let sum = 0, n = 0;
  for (let i = 0; i < p.months.length - 1; i++) {
    const a: number[] = [], b: number[] = [];
    for (const c of p.ccys) {
      const x = s1(p, c, i), y = s2(p, c, i);
      if (x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y)) { a.push(x); b.push(y); }
    }
    if (a.length >= 5) { sum += spearman(a, b); n++; }
  }
  return { mean: n > 0 ? sum / n : 0, n };
}

function main() {
  const p = buildPanel(G9);

  // ── §1. Từng đồng: số phải khớp lịch sử đã biết ──
  console.log("═══ §1. KIỂM TRA BẢNG DỮ LIỆU — so với lịch sử đã biết ═══");
  console.log("đồng".padEnd(6) + "chênh lãi suất".padStart(16) + "biến động giá".padStart(15) +
    "excess return".padStart(15) + "  (tất cả %/năm, so với USD)");
  for (const c of G9) {
    const car = p.carry[c].filter((v): v is number => v !== null);
    const sr = p.spotRet[c].filter((v): v is number => v !== null);
    const rx = p.rx[c].filter((v): v is number => v !== null);
    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    console.log(
      c.padEnd(6) +
      `${avg(car).toFixed(2)}%`.padStart(16) +
      `${(avg(sr) * 12 * 100).toFixed(2)}%`.padStart(15) +
      `${(avg(rx) * 12 * 100).toFixed(2)}%`.padStart(15),
    );
  }
  console.log(
    "Kỳ vọng độc lập: AUD/NZD phải có chênh lãi suất DƯƠNG rõ (2–3%), JPY/CHF ÂM rõ (−1…−2%).\n" +
    "Nếu sai dấu ở đây thì mọi thứ phía sau vô nghĩa.",
  );

  // ── §2. Tương quan tầng tín hiệu ──
  console.log("\n═══ §2. TƯƠNG QUAN TẦNG TÍN HIỆU (hạng Spearman, bình quân theo tháng) ═══");
  const pairs: [string, Signal, Signal][] = [
    ["value ↔ mom12", sigValue, sigMom(12)],
    ["value ↔ mom1", sigValue, sigMom(1)],
    ["value ↔ carry", sigValue, sigCarry],
    ["carry ↔ mom12", sigCarry, sigMom(12)],
  ];
  for (const [label, a, b] of pairs) {
    const r = signalCorr(p, a, b);
    console.log(`  ${label.padEnd(18)} ${r.mean.toFixed(3).padStart(7)}   (${r.n} tháng)`);
  }
  console.log(
    "AMP 2013 báo tương quan LỢI SUẤT value/mom trên cặp tiền = −0,42.\n" +
    "Nếu tín hiệu value↔mom12 âm mạnh ở đây nhưng lợi suất chiến lược lại ≈0, nguyên nhân là\n" +
    "danh mục 3/3 trên 9 đồng quá thô. Nếu chính TÍN HIỆU cũng ≈0 thì cơ chế đã mất thật.",
  );

  // ── §3. Đối chứng: nhân tố đô-la và tín hiệu ngẫu nhiên ──
  console.log("\n═══ §3. ĐỐI CHỨNG ═══");
  console.log(HDR);
  // Nhân tố đô-la: long đều cả rổ. Không phải long-short nên dựng riêng.
  {
    const net: number[] = [], months: string[] = [];
    for (let i = 0; i < p.months.length - 1; i++) {
      const vs = p.ccys.map((c) => p.rx[c][i]).filter((v): v is number => v !== null);
      if (vs.length === p.ccys.length) {
        net.push(vs.reduce((s, x) => s + x, 0) / vs.length);
        months.push(p.months[i + 1]);
      }
    }
    show("đô-la (long đều cả rổ)", stats(net, months));
  }
  // Tín hiệu ngẫu nhiên, hạt cố định — engine PHẢI trả về ≈0. Nếu dương đáng kể thì có lỗi.
  {
    let seed = 12345;
    const rnd = (c: string, i: number) => {
      let h = seed + i * 2654435761 + c.charCodeAt(0) * 40503 + c.charCodeAt(1) * 2246822519;
      h = (h ^ (h >>> 13)) >>> 0;
      return (h % 100000) / 100000 - 0.5;
    };
    const sr: Signal = (_p, c, i) => rnd(c, i);
    const accum: number[] = [];
    for (let trial = 0; trial < 5; trial++) {
      seed = 12345 + trial * 7919;
      const r = runFactor("ngẫu nhiên", p, [sr]);
      accum.push(stats(r.net, r.months).sharpe);
    }
    console.log(
      "ngẫu nhiên (5 hạt)".padEnd(30) +
      `Sharpe ${accum.map((x) => x.toFixed(2)).join(" ")}   ⇒ phải quanh 0`,
    );
  }

  // ── §4. Rổ mở rộng 13 đồng ──
  console.log("\n═══ §4. RỔ 13 ĐỒNG (thêm MXN PLN TRY ZAR) ═══");
  console.log("Văn liệu: momentum FX tập trung ở đồng RỦI RO CAO/khó kinh doanh chênh lệch, không");
  console.log("phải G10. Nếu hiệu ứng còn tồn tại thì phải thấy ở đây rõ hơn ở §2 của fx-factors.\n");
  const p13 = buildPanel(G13);
  console.log(`Tháng: ${p13.months[0]} → ${p13.months[p13.months.length - 1]} (${p13.months.length})`);
  console.log(HDR);
  const defs: [string, Signal[]][] = [
    ["carry", [sigCarry]],
    ["mom 1 tháng", [sigMom(1)]],
    ["mom 3 tháng", [sigMom(3)]],
    ["mom 12 tháng", [sigMom(12)]],
    ["value (PPP 5 năm)", [sigValue]],
    ["value + mom12", [sigValue, sigMom(12)]],
    ["carry + value + mom12", [sigCarry, sigValue, sigMom(12)]],
  ];
  const res13 = new Map<string, ReturnType<typeof runFactor>>();
  for (const [label, sigs] of defs) {
    const r = runFactor(label, p13, sigs);
    res13.set(label, r);
    show(label, stats(r.net, r.months));
  }
  console.log("\n  ── tách mẫu ──");
  console.log("nhân tố".padEnd(30) + "  ≤2011 Sharpe      ≥2012 Sharpe");
  for (const [label, r] of res13) {
    const a = slicePeriod(r, 0, 2011), b = slicePeriod(r, 2012, 9999);
    console.log(
      label.padEnd(30) + stats(a.net, a.months).sharpe.toFixed(2).padStart(10) +
      stats(b.net, b.months).sharpe.toFixed(2).padStart(18),
    );
  }
  console.log("\n  ── tương quan tín hiệu trên rổ 13 ──");
  for (const [label, a, b] of pairs) {
    const r = signalCorr(p13, a, b);
    console.log(`  ${label.padEnd(18)} ${r.mean.toFixed(3).padStart(7)}   (${r.n} tháng)`);
  }
}

if (require.main === module) main();
