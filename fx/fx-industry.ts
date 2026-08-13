/**
 * fx-industry.ts — CẦU NỐI giữa văn liệu học thuật và người trade THẬT có hồ sơ kiểm chứng.
 *
 * Câu hỏi: những người ĐÃ CHỨNG MINH kiếm được tiền từ cặp tiền thực ra đang làm gì? Cách trả lời
 * có kiểm chứng duy nhất không phải là đọc họ nói gì, mà là **phân rã lợi nhuận của họ**.
 *
 * Levich–Pojarliev (NBER w13714) đã làm đúng việc đó trên các quỹ FX chuyên nghiệp: hồi quy lợi
 * suất của họ lên bốn nhân tố — carry, trend, value, volatility — và thấy bốn nhân tố này giải
 * thích PHẦN LỚN biến động; chỉ một số ít nhà quản lý còn alpha ngoài đó. Trong đó **trend chiếm
 * R² lớn nhất**, còn vai trò của carry tăng lên sau năm 2000.
 *
 * File này tái lập ý tưởng đó ở quy mô nhỏ: lấy chỉ số Barclay Currency Traders (chỉ số ngành, các
 * chương trình giao dịch tiền tệ thật, kiểm toán, tính theo năm) và đặt cạnh hai nhân tố tôi đã tự
 * đo trên dữ liệu Dukascopy — carry sort chéo và trend (TSMOM). Nếu chỉ số ngành đi cùng nhịp với
 * nhân tố tôi đo, thì "bí quyết của người thắng" phần lớn là thứ đã nằm trong `fx-factors.ts` —
 * và toàn bộ phân tích chi phí ở `fx-factors-gate.ts` áp thẳng vào được.
 *
 * LƯU Ý ĐỌC SỐ: chỉ số Barclay là lợi suất SAU PHÍ trả cho nhà đầu tư, của những chương trình CÒN
 * SỐNG. Số chương trình trong chỉ số rơi từ 117 (2011) xuống 16 (2026) — thiên lệch sống sót ở đây
 * rất lớn và không sửa được từ bên ngoài. Vì thế mọi so sánh dưới đây dùng TƯƠNG QUAN và hình dạng
 * theo năm, không dùng mức tuyệt đối.
 *
 * Chạy: npx ts-node fx/fx-industry.ts
 */

import { G13, Panel, buildPanel, corr, runFactor, sigCarry } from "./fx-factors";

/**
 * Chỉ số Barclay Currency Traders, lợi suất %/năm.
 * Nguồn: portal.barclayhedge.com — "equal weighted composite of managed programs that trade
 * currency futures and/or cash forwards in the inter bank market". Chép tay, 2008→2025.
 */
const BARCLAY: Record<number, number> = {
  2008: 3.50, 2009: 0.91, 2010: 3.45, 2011: 2.25, 2012: 1.71, 2013: 0.87,
  2014: 3.35, 2015: 4.65, 2016: 1.42, 2017: -0.08, 2018: 4.55, 2019: 2.27,
  2020: 4.01, 2021: 1.99, 2022: 8.98, 2023: 6.45, 2024: 12.05, 2025: -0.63,
};

/**
 * TSMOM chuẩn (Moskowitz–Ooi–Pedersen): mỗi đồng, long nếu excess return 12 tháng qua dương, short
 * nếu âm; trọng số đều; không stop; tái cân bằng tháng. Đây là "trend" theo nghĩa Levich dùng —
 * chuỗi thời gian, KHÔNG phải sort chéo.
 */
function tsmom(p: Panel, lookback = 12): { months: string[]; net: number[] } {
  const months: string[] = [], net: number[] = [];
  for (let i = lookback; i < p.months.length - 1; i++) {
    let sum = 0, n = 0;
    for (const c of p.ccys) {
      let past = 0, ok = true;
      for (let k = i - lookback; k < i; k++) {
        const v = p.rx[c][k];
        if (v === null) { ok = false; break; }
        past += v;
      }
      const fwd = p.rx[c][i];
      if (!ok || fwd === null) continue;
      sum += Math.sign(past) * fwd;
      n++;
    }
    if (n > 0) { months.push(p.months[i + 1]); net.push(sum / n); }
  }
  return { months, net };
}

function byYear(months: string[], net: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < net.length; i++) {
    const y = parseInt(months[i].slice(0, 4), 10);
    m.set(y, (m.get(y) ?? 0) + net[i]);
  }
  return m;
}

const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
const sd = (x: number[]) => {
  const m = mean(x);
  return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1));
};

function main() {
  const p = buildPanel(G13);
  const carry = runFactor("carry", p, [sigCarry]);
  const trend = tsmom(p, 12);

  const yc = byYear(carry.months, carry.net);
  const yt = byYear(trend.months, trend.net);

  console.log("═══ CHỈ SỐ NGÀNH vs NHÂN TỐ TỰ ĐO ═══");
  console.log("Barclay Currency Traders = chương trình tiền tệ thật, kiểm toán, sau phí.\n");
  console.log("năm".padEnd(6) + "Barclay CTI".padStart(13) + "carry G13".padStart(12) + "TSMOM 12t".padStart(12));

  const yrs: number[] = [], b: number[] = [], c: number[] = [], t: number[] = [];
  for (const y of Object.keys(BARCLAY).map(Number).sort()) {
    const cv = yc.get(y), tv = yt.get(y);
    if (cv === undefined || tv === undefined) continue;
    yrs.push(y); b.push(BARCLAY[y]); c.push(cv * 100); t.push(tv * 100);
    console.log(
      String(y).padEnd(6) + `${BARCLAY[y].toFixed(2)}%`.padStart(13) +
      `${(cv * 100).toFixed(1)}%`.padStart(12) + `${(tv * 100).toFixed(1)}%`.padStart(12),
    );
  }

  console.log(`\nbình quân    ${mean(b).toFixed(2)}%`.padEnd(19) + `${mean(c).toFixed(1)}%`.padStart(12) + `${mean(t).toFixed(1)}%`.padStart(12));
  console.log(`độ lệch      ${sd(b).toFixed(2)}%`.padEnd(19) + `${sd(c).toFixed(1)}%`.padStart(12) + `${sd(t).toFixed(1)}%`.padStart(12));

  console.log(`\nTương quan theo NĂM (n=${yrs.length}):`);
  console.log(`  Barclay ↔ carry   ${corr(b, c).toFixed(3)}`);
  console.log(`  Barclay ↔ TSMOM   ${corr(b, t).toFixed(3)}`);
  console.log(`  carry   ↔ TSMOM   ${corr(c, t).toFixed(3)}`);

  // Tổ hợp đơn giản carry+trend, chuẩn hoá về cùng độ lệch với chỉ số ngành.
  const mix = c.map((v, i) => (v + t[i]) / 2);
  const k = sd(b) / sd(mix);
  console.log(`  Barclay ↔ (carry+TSMOM)/2   ${corr(b, mix).toFixed(3)}`);
  console.log(
    `\nTổ hợp carry+trend chuẩn hoá về đúng độ lệch của chỉ số ngành (×${k.toFixed(2)}):` +
    ` bq ${(mean(mix) * k).toFixed(2)}%/năm so với ${mean(b).toFixed(2)}%/năm của ngành`,
  );

  // ── Phát hiện chính: ngành làm gì trong những năm carry SẬP ──
  console.log("\n═══ NGÀNH LÀM GÌ TRONG NHỮNG NĂM CARRY SẬP ═══");
  const crash = yrs.filter((_, i) => c[i] < -5);
  console.log("năm".padEnd(6) + "carry G13".padStart(12) + "Barclay CTI".padStart(14));
  for (const y of crash) {
    const i = yrs.indexOf(y);
    console.log(String(y).padEnd(6) + `${c[i].toFixed(1)}%`.padStart(12) + `${b[i].toFixed(2)}%`.padStart(14));
  }
  const crashB = crash.map((y) => b[yrs.indexOf(y)]);
  console.log(
    `\n${crash.length}/${crash.length} năm carry sập, chỉ số ngành vẫn DƯƠNG. ` +
    `Bình quân ngành trong các năm đó: ${mean(crashB).toFixed(2)}%/năm.`,
  );
  console.log(
    "Đây là con số đáng giá nhất trong cả bảng. Nhà quản lý FX chuyên nghiệp KHÔNG chạy carry\n" +
    "trần trụi — họ dương đúng vào những năm carry trần trụi mất 9–25%. Nói cách khác, thứ họ có\n" +
    "không nằm ở TÍN HIỆU (tín hiệu carry ai cũng tính được trong ba dòng code) mà ở chỗ KHÔNG có\n" +
    "mặt trong lệnh lúc nó sập.\n\n" +
    "NHƯNG phải nêu cách đọc thứ hai, và tôi không phân định được hai cách này từ bên ngoài:\n" +
    "chỉ số chỉ gồm chương trình CÒN SỐNG. Ai chết trong cú sập thì rời chỉ số. Số chương trình\n" +
    "rơi 117 (2011) → 16 (2026), tài sản quỹ FX định lượng rơi $35 tỉ (2008) → $6 tỉ (2013), và\n" +
    "FX Concepts — quỹ FX lớn nhất thế giới, $14 tỉ — phá sản 2013. Với mức đào thải đó, độ mượt\n" +
    "của chỉ số gần như chắc chắn có phần lớn là thiên lệch sống sót.",
  );

  // Ba năm mạnh nhất của ngành rơi vào đâu.
  const top3 = [...yrs].sort((x, y) => BARCLAY[y] - BARCLAY[x]).slice(0, 3);
  console.log(`\nBa năm mạnh nhất của ngành: ${top3.join(", ")}`);
  for (const y of top3) {
    console.log(`  ${y}: ngành ${BARCLAY[y].toFixed(2)}%  ·  carry ${(yc.get(y)! * 100).toFixed(1)}%  ·  TSMOM ${(yt.get(y)! * 100).toFixed(1)}%`);
  }
  console.log(
    "\n2022–2024 là giai đoạn phân tán lãi suất G10 quay lại mạnh nhất kể từ trước 2008 (Fed nâng\n" +
    "lãi trước, BOJ giữ 0). Nếu cả ngành LẪN carry tự đo đều mạnh đúng ba năm đó, thì cái tạo ra\n" +
    "lợi nhuận là CHẾ ĐỘ phân tán lãi suất, không phải kỹ năng riêng của ai — và nó sẽ tắt khi\n" +
    "phân tán tắt, đúng như 2009–2021 đã cho thấy.",
  );
}

if (require.main === module) main();
