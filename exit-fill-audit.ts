/**
 * exit-fill-audit.ts — ĐO TRƯỢT GIÁ THẬT Ở CHIỀU THOÁT.
 *
 * VÌ SAO TỒN TẠI: engine backtest cho lệnh stop khớp ĐÚNG BẰNG `pos.sl`, và `mid`/`time` khớp đúng giá
 * đóng nến. Đo được (planning/turtle-fast-execution-weakness-2026-08-12.md): 81-88% tỉ trọng risk của
 * hệ thoát qua nhánh stop — riêng 365 ngày qua là ~97% — và chỉ **14 bps** trượt giá thêm đã lấy đi
 * **13% vốn cuối kỳ**, 57 bps lấy 54%. Nhưng ĐƯỜNG LIVE không ghi giá khớp thật ở chiều thoát:
 * `exitPrice` trong journal luôn là giá TÍN HIỆU, nên `grossR` báo về là con số giả định.
 * Hệ quả: đại lượng có thể lấy đi 13-54% vốn là đại lượng duy nhất hệ không có một điểm dữ liệu nào.
 *
 * Module này KHÔNG đổi một luật vào/ra nào và KHÔNG gửi lệnh nào. Nó chỉ đọc lịch sử khớp rồi ghi
 * journal. Mọi lỗi phải bị nuốt tại chỗ gọi: phép đo TUYỆT ĐỐI không được chặn hay đổi việc thoát lệnh.
 *
 * Sau ~50 exit sẽ có phân phối trượt giá thật, và hai ứng viên đang treo được quyết:
 *   - trượt giá > ~0,07×ATR ⇒ đổi Turtle sang stop máy móc 3×ATR (+17%) và/hoặc stop xác nhận bằng
 *     close (+4…+27%);
 *   - trượt giá ≈ 0,02% ⇒ thiết kế hiện tại đúng và số backtest đáng tin.
 */

/** Một fill đã ĐÓNG (giảm) vị thế, chuẩn hoá giữa các sàn. */
export interface ClosingFill {
  price: number;
  qty: number;
  /** Lãi/lỗ đã thực hiện của fill này (USD). Có thể undefined nếu sàn không trả. */
  realizedUsd?: number;
  /** Phí của fill này (USD, dương = đã trả). */
  commissionUsd?: number;
}

export interface ExitFillAudit {
  venue: string;
  fills: number;
  /** Giá khớp TB có trọng số khối lượng của các fill đóng. */
  realExitAvg: number;
  /** Giá tín hiệu mà engine/journal đang dùng. */
  assumedExit: number;
  /** Trượt giá BẤT LỢI, bps. DƯƠNG = khớp xấu hơn giả định (tiền bị mất thêm). */
  slipBps: number;
  /** Cùng đại lượng nhưng quy theo ATR — so trực tiếp được với ngưỡng lật 0,07×ATR. */
  slipAtr: number | null;
  /** Σ realizedPnl − Σ commission, nếu sàn trả đủ dữ liệu. */
  realizedUsd: number | null;
}

/**
 * Tính trượt giá bất lợi từ các fill đóng.
 * LONG thoát = BÁN ⇒ giá THẤP hơn giả định là xấu. SHORT thoát = MUA ⇒ giá CAO hơn là xấu.
 */
export function computeExitFillAudit(args: {
  venue: string;
  dir: "long" | "short";
  assumedExit: number;
  fills: ClosingFill[];
  atrNow?: number;
}): ExitFillAudit | null {
  const { venue, dir, assumedExit, fills, atrNow } = args;
  const usable = fills.filter((f) => f.qty > 0 && f.price > 0);
  if (!usable.length || !(assumedExit > 0)) return null;

  const qty = usable.reduce((s, f) => s + f.qty, 0);
  const realExitAvg = usable.reduce((s, f) => s + f.price * f.qty, 0) / qty;

  const adverse = dir === "long" ? assumedExit - realExitAvg : realExitAvg - assumedExit;
  const hasPnl = usable.some((f) => f.realizedUsd !== undefined || f.commissionUsd !== undefined);

  return {
    venue,
    fills: usable.length,
    realExitAvg,
    assumedExit,
    slipBps: (adverse / assumedExit) * 1e4,
    slipAtr: atrNow && atrNow > 0 ? adverse / atrNow : null,
    realizedUsd: hasPnl
      ? usable.reduce((s, f) => s + (f.realizedUsd ?? 0) - (f.commissionUsd ?? 0), 0)
      : null,
  };
}

/** Một dòng gọn để in ra console/Telegram. */
export function formatExitFillAudit(a: ExitFillAudit): string {
  const atr = a.slipAtr === null ? "" : ` · ${a.slipAtr >= 0 ? "+" : ""}${a.slipAtr.toFixed(3)}×ATR`;
  const pnl = a.realizedUsd === null ? "" : ` · thực nhận ${a.realizedUsd >= 0 ? "+" : ""}$${a.realizedUsd.toFixed(2)}`;
  return `khớp thật ${a.realExitAvg} vs tín hiệu ${a.assumedExit} · trượt ${a.slipBps >= 0 ? "+" : ""}${a.slipBps.toFixed(1)} bps${atr}${pnl} (${a.fills} fill)`;
}
