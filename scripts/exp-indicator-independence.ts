/**
 * exp-indicator-independence.ts — CÓ BAO NHIÊU TÍN HIỆU ĐỘC LẬP TRONG 27 CHỈ BÁO?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VÌ SAO ĐÂY LÀ CÂU HỎI QUYẾT ĐỊNH CHO VIỆC "GỘP NHIỀU CHỈ BÁO"
 *
 * Cả logic gộp chỉ báo dựa trên MỘT giả định: nhiễu của các chỉ báo ĐỘC LẬP nhau. Nếu đúng, trung
 * bình N chỉ báo làm nhiễu giảm theo √N còn tín hiệu chung giữ nguyên ⇒ tỉ lệ tín hiệu/nhiễu tăng.
 * Đó chính là lý do Neely, Rapach, Tu & Zhou (2014) gộp 14 chỉ báo thay vì chọn một cái.
 *
 * Nếu giả định SAI — nếu 27 chỉ báo chỉ là 27 cách đọc lại CÙNG MỘT chuyển động giá — thì trung bình
 * chúng cho lại đúng con số ban đầu, không giảm nhiễu gì cả. Và khi đó việc gộp thất bại KHÔNG phải
 * vì làm chưa đúng cách, mà vì **không có gì để gộp**. Đó là hai kết luận rất khác nhau, và chỉ có
 * phép đo này phân biệt được.
 *
 * Số cần đo:
 *   ρ̄      = tương quan cặp TRUNG BÌNH giữa các phiếu chỉ báo, tại đúng thời điểm hệ vào lệnh
 *   N_eff  = N / (1 + (N−1)·ρ̄)   ← số tín hiệu ĐỘC LẬP tương đương
 *   PC90   = số thành phần chính cần để giải thích 90% phương sai (đúng thước Neely et al. dùng)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ĐỐI CHỨNG QUAN TRỌNG: đo trên NẾN NGẪU NHIÊN, không chỉ nến vào lệnh
 *
 * Nếu các chỉ báo đồng ý 95% ở nến breakout nhưng chỉ 60% ở nến bất kỳ, thì kết luận đúng KHÔNG phải
 * "các chỉ báo này trùng nhau" mà là "**chúng trùng nhau ĐÚNG LÚC luật vào lệnh đã kích hoạt**" — tức
 * chính cú breakout làm chúng đồng pha. Đó là phát biểu chính xác, và nó mạnh hơn: nó nói rằng thông
 * tin của chúng đã bị luật Donchian hấp thụ hết, chứ không phải chúng vô dụng nói chung.
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-indicator-independence.ts [days=2000]
 */

import { Candle } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitCtx, AdmitFn, Book, ExtParams, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";
import { DEFS, buildComboPre, vote } from "./exp-indicator-combos";

/**
 * Trị riêng của ma trận đối xứng bằng phép quay Jacobi. Chỉ cần trị riêng (không cần vector), và
 * n = 27 nên thuật toán đơn giản này thừa đủ.
 */
function eigenvaluesSym(Ain: number[][]): number[] {
  const n = Ain.length;
  const A = Ain.map((r) => [...r]);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2;
    if (off < 1e-12) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-15) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
      }
    }
  }
  return Array.from({ length: n }, (_, i) => A[i][i]).sort((a, b) => b - a);
}

function corrMatrix(rows: number[][]): { M: number[][]; avgPair: number } {
  const n = rows.length;
  const mean = rows.map((r) => r.reduce((s, x) => s + x, 0) / r.length);
  const sd = rows.map((r, i) => Math.sqrt(r.reduce((s, x) => s + (x - mean[i]) ** 2, 0) / (r.length - 1)));
  const M: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    M[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      let cov = 0;
      for (let k = 0; k < rows[i].length; k++) cov += (rows[i][k] - mean[i]) * (rows[j][k] - mean[j]);
      cov /= rows[i].length - 1;
      const r = sd[i] > 0 && sd[j] > 0 ? cov / (sd[i] * sd[j]) : 0;
      M[i][j] = r; M[j][i] = r;
      sum += r; cnt++;
    }
  }
  return { M, avgPair: cnt ? sum / cnt : 0 };
}

function report(title: string, rows: number[][], note: string) {
  const N = rows.length;
  const { M, avgPair } = corrMatrix(rows);
  const nEff = N / (1 + (N - 1) * avgPair);
  const ev = eigenvaluesSym(M);
  const tot = ev.reduce((s, x) => s + Math.max(0, x), 0);
  let acc = 0, pc90 = 0, pc50 = 0;
  for (let i = 0; i < ev.length; i++) {
    acc += Math.max(0, ev[i]);
    if (!pc50 && acc / tot >= 0.5) pc50 = i + 1;
    if (!pc90 && acc / tot >= 0.9) { pc90 = i + 1; break; }
  }
  const agree = rows.map((r) => r.filter((x) => x > 0).length / r.length);
  const meanAgree = agree.reduce((s, x) => s + x, 0) / agree.length;

  console.log("═".repeat(96));
  console.log(`  ${title}   (${rows[0].length.toLocaleString()} quan sát × ${N} chỉ báo)`);
  console.log("═".repeat(96));
  console.log(`  Tỉ lệ chỉ báo ỦNG HỘ hướng lệnh, trung bình : ${(meanAgree * 100).toFixed(1)}%`);
  console.log(`  Tương quan cặp TRUNG BÌNH giữa các phiếu ρ̄  : ${avgPair.toFixed(3)}`);
  console.log(`  SỐ TÍN HIỆU ĐỘC LẬP TƯƠNG ĐƯƠNG  N_eff      : ${nEff.toFixed(2)}  trên ${N} chỉ báo`);
  console.log(`  Thành phần chính cần cho 50% / 90% phương sai: ${pc50} / ${pc90}`);
  console.log(`  Thành phần chính ĐẦU TIÊN giải thích         : ${((Math.max(0, ev[0]) / tot) * 100).toFixed(1)}% phương sai`);
  console.log(`  ${note}\n`);
  return { avgPair, nEff, pc90, meanAgree };
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  console.log(`Nạp ${CORE8.length} symbol CORE8, ${days} ngày nến 4h...\n`);
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  const pre = buildComboPre(data);
  const N = DEFS.length;

  // ── (1) TẠI NẾN VÀO LỆNH THẬT ──
  const entryVotes: number[][] = Array.from({ length: N }, () => []);
  const heat = decayHeat(T.heatDecayK);
  const rec: AdmitFn = (c: AdmitCtx) => {
    if (c.kind === "entry" && c.time >= w.from && c.time <= w.to) {
      for (let k = 0; k < N; k++) entryVotes[k].push(vote(pre, k, c.rawSymbol, c.time, c.dir));
    }
    return heat(c);
  };
  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));
  runBooks([...bk(turtle, "t"), ...bk(fast, "f")], rec);

  const rEntry = report(
    "1) TẠI ĐÚNG NẾN HỆ VÀO LỆNH (breakout Donchian đã kích hoạt)",
    entryVotes,
    "→ đây là tình huống thật: 27 chỉ báo được hỏi ý kiến ở đúng lúc cần quyết định.",
  );

  // ── (2) ĐỐI CHỨNG: nến NGẪU NHIÊN, cùng số lượng, cùng phân bố symbol ──
  let seed = 4242;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const syms = [...data.keys()];
  const randVotes: number[][] = Array.from({ length: N }, () => []);
  const nSample = entryVotes[0].length;
  let guard = 0;
  while (randVotes[0].length < nSample && guard++ < nSample * 50) {
    const s = syms[Math.floor(rnd() * syms.length)];
    const c = data.get(s)!;
    const i = 700 + Math.floor(rnd() * (c.length - 700));
    const t = c[i].openTime;
    if (t < w.from || t > w.to) continue;
    const dir = rnd() < 0.5 ? "long" : "short";
    for (let k = 0; k < N; k++) randVotes[k].push(vote(pre, k, s, t, dir));
  }
  const rRand = report(
    "2) ĐỐI CHỨNG — nến NGẪU NHIÊN, hướng ngẫu nhiên (luật vào lệnh CHƯA kích hoạt)",
    randVotes,
    "→ nếu số ở đây thấp hơn hẳn bảng 1 thì chính CÚ BREAKOUT làm các chỉ báo đồng pha.",
  );

  // ── Kết luận số học ──
  console.log("═".repeat(96));
  console.log("  KẾT LUẬN");
  console.log("═".repeat(96));
  console.log(`  N_eff tại nến vào lệnh : ${rEntry.nEff.toFixed(2)} / ${N}   ·   tại nến ngẫu nhiên: ${rRand.nEff.toFixed(2)} / ${N}`);
  console.log(`  ρ̄     tại nến vào lệnh : ${rEntry.avgPair.toFixed(3)}        ·   tại nến ngẫu nhiên: ${rRand.avgPair.toFixed(3)}`);
  const gain = Math.sqrt(rEntry.nEff);
  console.log(
    `\n  Lợi ích LÝ THUYẾT TỐI ĐA của việc gộp = √N_eff = ${gain.toFixed(2)}× giảm nhiễu.\n` +
    `  Nếu gộp 27 chỉ báo mà chỉ tương đương ${rEntry.nEff.toFixed(1)} tín hiệu độc lập thì trần lợi ích là ${gain.toFixed(2)}×,\n` +
    `  không phải √27 = 5,20×. Và toàn bộ tiền đề "gộp để giảm nhiễu" mất phần lớn ý nghĩa.`,
  );
}

function decayHeat(k: number): AdmitFn {
  return (c) => 1 / (1 + c.sameDirHeat / k);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
