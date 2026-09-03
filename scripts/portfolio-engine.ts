/**
 * portfolio-engine.ts — chạy engine Turtle trên NHIỀU symbol theo THỜI GIAN THỰC (lockstep),
 * để có thể áp ràng buộc CẤP DANH MỤC (trần risk cùng hướng, breadth gate, …) tại đúng thời điểm
 * mỗi unit được mở.
 *
 * VÌ SAO CẦN: `runTurtle` chạy từng symbol độc lập nên không thể biết "lúc này cả rổ đang giữ bao
 * nhiêu risk cùng hướng". Mọi câu hỏi về tương quan/đòn bẩy danh mục đều cần bước theo thời gian.
 *
 * BẤT BIẾN: khi `admit` luôn true, chuỗi trade sinh ra phải TRÙNG KHỚP 100% với việc gọi
 * `runTurtle` cho từng symbol (xem scripts/portfolio-equivalence.ts). Đây là chốt chặn chống
 * "engine thí nghiệm lệch engine production".
 */

import { Candle, CONFIG, TF_MS } from "../strategy";
import { T, TurtleParams, atrSeries, ema, priorDonchian, turtleInitialStop } from "../turtle";

const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

/** Bản sao chính xác của tradeCostR trong turtle.ts (file đó không export). */
export function tradeCostR(entry: number, initialSL: number, entryTime: number, exitTime: number): number {
  if (!CONFIG.costs.enabled) return 0;
  const riskFrac = Math.abs(entry - initialSL) / entry;
  if (riskFrac <= 0) return 0;
  const feeFrac = ((CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100) * 2;
  const periods = Math.max(
    0,
    Math.floor(exitTime / FUNDING_INTERVAL_MS) - Math.floor(entryTime / FUNDING_INTERVAL_MS),
  );
  const fundingFrac = (periods * CONFIG.costs.fundingPer8hPct) / 100;
  return (feeFrac + fundingFrac) / riskFrac;
}

export interface UnitTrade {
  /** Định danh sổ (symbol hoặc symbol@sleeve khi chạy nhiều tốc độ). */
  book: string;
  symbol: string;
  dir: "long" | "short";
  positionId: number;
  unitIndex: number; // 0 = unit khởi tạo vị thế
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "trail" | "mid" | "time";
  grossR: number;
  costR: number;
  netR: number;
  holdBars: number;
  /** Tỉ trọng risk của unit này (1 = full risk). Đóng góp danh mục = netR × weight. */
  weight: number;
}

/** Ảnh chụp một unit đang mở, dùng cho hàm admit và mark-to-market. */
export interface OpenUnit {
  book: string;
  symbol: string;
  dir: "long" | "short";
  positionId: number;
  unitIndex: number;
  entryTime: number;
  entry: number;
  initialSL: number;
  weight: number;
}

export interface AdmitCtx {
  time: number;
  /**
   * ⚠️ ĐÂY LÀ KHOÁ SỔ (`Book.key`), KHÔNG phải mã coin. Chạy nhiều sleeve thì nó là `"btcusdt@t"`.
   * Trong khi đó `OpenUnit.symbol` (mảng `open` bên dưới) LÀ mã coin thô.
   *
   * Tra bảng theo mã coin bằng trường này sẽ trượt hết về nhánh mặc định, LẶNG LẼ, và cho ra một
   * kết quả "không có gì thay đổi" trông y hệt một kết quả null thật. Bẫy này đã cắn ít nhất hai
   * lần trong repo (xem exp-floor-exact.ts và exp-corr-heat.ts). Dùng `rawSymbol` bên dưới.
   */
  symbol: string;
  /** Mã coin thô, đã bóc hậu tố sleeve — luôn khớp với `OpenUnit.symbol`. */
  rawSymbol: string;
  dir: "long" | "short";
  kind: "entry" | "add";
  /** Các unit đang mở TRƯỚC khi unit này được thêm (toàn danh mục). */
  open: OpenUnit[];
  /** Số unit đang mở cùng hướng (toàn danh mục). */
  sameDirUnits: number;
  /** Số unit đang mở ngược hướng. */
  oppDirUnits: number;
  /** Tổng tỉ trọng risk đang mở cùng hướng / toàn bộ. */
  sameDirHeat: number;
  totalHeat: number;
  /**
   * Giá vào và stop ban đầu của chính unit đang xin vào. Có để `AdmitFn` dựng được RÀNG BUỘC THỰC
   * THI, thứ chỉ tính được khi biết khoảng stop:
   *     notional = equity × risk% × weight ÷ (|entry − initialSL| / entry)
   * Dùng cho sàn `minNotional` của sàn giao dịch. Optional để mọi `AdmitFn` cũ chạy y nguyên.
   */
  entryPrice?: number;
  initialSL?: number;
}

/** Trả 0 = từ chối unit; 1 = full risk; 0<w<1 = vào với size nhỏ hơn. */
export type AdmitFn = (ctx: AdmitCtx) => number;

/** Chuỗi equity mark-to-market theo R (mỗi unit = 1R risk), lấy mẫu mỗi bar. */
export interface EquityPoint {
  time: number;
  realized: number; // tổng netR đã đóng
  mtm: number; // realized + unrealized (gross, chưa trừ phí phần chưa đóng)
  openUnits: number;
  longUnits: number;
  shortUnits: number;
}

export interface PortfolioResult {
  trades: UnitTrade[];
  equity: EquityPoint[];
  /** Số unit bị admit từ chối (chẩn đoán). */
  rejectedEntries: number;
  rejectedAdds: number;
  /**
   * Unit CÒN MỞ ở nến cuối. `trades` chỉ sinh ra lúc thoát, nên nếu thiếu danh sách này thì mọi
   * so sánh "engine vs live" sẽ báo nhầm là live thừa lệnh (xem scripts/fast-live-parity.ts).
   */
  openAtEnd: OpenUnit[];
}

type Unit = { entryIndex: number; entry: number; initialSL: number; unitIndex: number; weight: number };
type Pos = {
  dir: "long" | "short";
  positionId: number;
  units: Unit[];
  sl: number;
  extreme: number;
  midTrail: number | null;
};

/**
 * Chạy Turtle trên cả rổ theo lockstep thời gian.
 * Thứ tự trong mỗi bar: (1) quản lý vị thế đang mở của MỌI symbol (exit → trail → pyramid add),
 * (2) tìm lệnh mới của MỌI symbol. Nhờ vậy capacity được giải phóng bởi exit dùng được ngay,
 * và pyramid add (unit của trend đang chạy) được ưu tiên hơn entry mới — đúng thứ tự vốn có
 * trong `runTurtle`, không phải một luật ưu tiên mới.
 */
/**
 * Tham số mở rộng CHỈ DÙNG CHO THÍ NGHIỆM (`longExitDays` đã lên production trong `T`).
 * `0`/undefined = giữ nguyên hành vi production.
 */
export type ExtParams = TurtleParams & {
  shortExitDays?: number;
  /**
   * Số nến 4h phải TIẾP TỤC đóng dưới mức breakout đã đóng băng trước khi vào SHORT
   * (rule của sleeve Fast — `decideFastShortConfirmation` trong fast-trend-live.ts).
   * 0/undefined = vào ngay tại nến phá vỡ (hành vi Turtle).
   */
  shortConfirmBars?: number;
  /**
   * Phí MỘT CHIỀU của sổ này (%), ghi đè `CONFIG.costs` — cần khi hai sleeve chạy trên hai sàn
   * khác phí trong CÙNG một danh mục (Turtle/Binance 0,05 vs Fast/MEXC 0,08 taker).
   */
  takerFeePct?: number;
  slippagePct?: number;
  /**
   * Hệ số ATR của INITIAL STOP, tách khỏi `chandelierMult`.
   * Trong `turtle.ts` một hằng số duy nhất làm hai việc: mẫu số R lúc vào lệnh (fallback khi stop
   * cấu trúc nằm ngoài envelope) VÀ khoảng trail Chandelier của SHORT. Vì thế mọi lần quét
   * `chandelierMult` trước đây đều đổi cả hai cùng lúc, và ảnh hưởng riêng của MẪU SỐ R chưa bao giờ
   * được đo. undefined = dùng `chandelierMult` ⇒ hành vi không đổi một bit.
   */
  initialStopMult?: number;
  /**
   * ĐỘ TRƯỢT GIÁ BẤT LỢI THÊM khi thoát bằng STOP (`trail`), đo bằng ATR — để stress-test giả định
   * lạc quan nhất của cả chuỗi đo: engine cho khớp ĐÚNG BẰNG `pos.sl` mỗi khi `bar.low <= pos.sl`.
   * Thực tế lệnh STOP_MARKET trên nến 4h xuyên qua stop khớp xấu hơn, và `CONFIG.costs.slippagePct`
   * (0,02%) là một hằng số không phụ thuộc biên độ nên không bao giờ mô hình hoá được việc đó.
   * Chuẩn hoá theo ATR vì mẫu số R = 3×ATR ⇒ trượt 0,1×ATR = đúng 0,033R, so được giữa mọi coin/era.
   * undefined/0 = hành vi không đổi một bit.
   */
  slipTrailAtr?: number;
  /**
   * ĐỘ TRƯỢT GIÁ BẤT LỢI THÊM khi thoát bằng giá ĐÓNG NẾN (`mid`/`time`), đo bằng ATR. Live thức dậy
   * `SETTLE_MS` = 90s SAU khi nến 4h đóng rồi mới gửi market order, nên không bao giờ khớp đúng giá
   * close mà engine dùng. undefined/0 = hành vi không đổi một bit.
   */
  slipCloseAtr?: number;
  /**
   * `false` = unit pyramid KHÔNG kéo hard stop chung lên theo stop ban đầu của chính nó.
   * Mặc định (undefined) = `true` = hành vi production. Chỉ ảnh hưởng nhánh `longExitMode="mid"`
   * (short dùng chandelier nên add không siết stop) — tức đúng nhánh chứa toàn bộ edge lịch sử.
   */
  pyramidTightensStop?: boolean;
  /**
   * `true` = hard stop chỉ kích hoạt khi nến ĐÓNG vượt stop (khớp tại giá close), thay vì kích hoạt
   * ngay khi `low`/`high` chạm stop trong nến (khớp tại đúng giá stop).
   *
   * Vì sao đáng đo: W1 cho thấy 81-88% risk của hệ thoát qua nhánh stop, và đó đúng là nhánh mà giả
   * định "khớp đúng giá stop" sai nhiều nhất — lệnh STOP_MARKET xuyên qua stop trong nến 4h trượt
   * bao nhiêu là điều engine không biết. Đổi sang xác nhận-bằng-close biến một fill KHÔNG đo được
   * thành một market order tại thời điểm biết trước (đúng cơ chế nhánh `mid` đang chạy live). Giá
   * phải trả: có nến ăn hết phần còn lại của cú giảm. Cái được: không bị quét bởi RÂU NẾN.
   * So sánh chỉ có nghĩa khi BẬT trượt giá thực tế — dưới giả định fill hoàn hảo thì stop trong nến
   * luôn thắng vì nó thoát sớm hơn ở giá tốt hơn.
   */
  stopOnCloseOnly?: boolean;
  /**
   * `true` = mọi tín hiệu trong CÙNG một nến chấm heat theo ảnh chụp trạng thái ĐẦU NẾN, nên chúng
   * không nhìn thấy nhau ⇒ tỉ trọng risk KHÔNG còn phụ thuộc thứ tự duyệt symbol.
   *
   * Vì sao cần: `runBooks` duyệt symbol theo thứ tự mảng, nên symbol đứng trước gặp heat thấp hơn và
   * được size lớn hơn. Đo được (`exp-stop-mechanics.ts r5`): đổi thứ tự mảng làm lệch 9% vốn cuối kỳ
   * ở k=4 và tới 68% ở k=0,1. Đó là một chi tiết CÀI ĐẶT đang quyết định phân bổ vốn giữa các symbol
   * phá vỡ cùng lúc — không phải một luật ai từng chọn.
   * undefined/false = hành vi production (tuần tự).
   */
  admitBarSnapshot?: boolean;
  /**
   * ƯỚC LƯỢNG BIẾN ĐỘNG thay cho `atrSeries` (Wilder). Cùng chữ ký, cùng đơn vị GIÁ, cùng cửa sổ —
   * chỉ đổi CÁCH ước lượng, không đổi một luật nào. undefined = `atrSeries` = hành vi không đổi.
   *
   * Vì sao đáng tách ra: ATR là trung bình của True Range, mà TR chỉ dùng 2 trong 4 mốc giá của nến.
   * Các ước lượng dùng cả OHLC (Parkinson, Garman-Klass, Rogers-Satchell) có phương sai nhỏ hơn
   * 5-8 lần ở cùng số nến (Yang & Zhang 2000). ATR ở đây làm MẪU SỐ R, khoảng trail và bước pyramid,
   * nên nhiễu của nó chảy thẳng vào risk thật của từng lệnh.
   */
  volSeries?: (c: Candle[], len: number) => number[];
  /**
   * THAY HẲN TÍN HIỆU VÀO LỆNH bằng một hàm tuỳ ý — để xây CHIẾN LƯỢC KHÁC (chỉ báo làm tín hiệu
   * chính) mà vẫn dùng nguyên bộ máy rủi ro đã audit: stop 3×ATR/cấu trúc, kênh thoát, pyramiding,
   * heat, phí, funding. Nhờ vậy so sánh với Turtle/Fast là so ĐÚNG MỘT thứ — cái cò vào lệnh.
   *
   * Trả "long"/"short"/null tại nến `i` (chỉ được đọc `c[0..i]`). Khi có hàm này, engine BỎ QUA
   * Donchian + bộ lọc EMA + volume; nhưng `gate` (BTC regime) và `allowShort` VẪN áp, để có thể tách
   * riêng phần đóng góp của gate. undefined = hành vi không đổi một bit.
   */
  entrySignal?: (symbol: string, i: number, c: Candle[]) => "long" | "short" | null;
  /**
   * GIÁ KHỚP của tín hiệu `entrySignal` — để mô phỏng LỆNH CHỜ (limit) đặt sẵn tại một mức, thay vì
   * vào ở giá đóng cửa. Chỉ có tác dụng khi `entrySignal` được đặt.
   *
   * Giá trả về BẮT BUỘC nằm trong [low, high] của chính nến i; ngoài khoảng đó là khớp ở mức giá
   * chưa từng giao dịch trong nến ⇒ engine bỏ qua và dùng `close` (không có cách nào "gần đúng" ở
   * đây mà không mở cửa cho lookahead). undefined = hành vi không đổi một bit.
   */
  entryFillPrice?: (symbol: string, i: number, c: Candle[], dir: "long" | "short") => number;
  /**
   * BREAKEVEN: khi giá đã đi thuận ≥ `breakevenAtR` × R (R của unit ĐẦU TIÊN) tính theo cực trị đã
   * đạt, kéo stop cứng về đúng giá vào của unit đầu. Chỉ SIẾT, không bao giờ nới.
   *
   * Đề xuất đến thẳng từ feedback của user trên lệnh `turtle-13-0-1782806400000`: "lệnh này cần dịch
   * SL xuống entry thì sẽ đỡ bị thua hơn". 0/undefined = hành vi không đổi một bit.
   */
  breakevenAtR?: number;
  /** Giới hạn breakeven cho một chiều (note của user là trên lệnh SHORT). undefined = cả hai chiều. */
  breakevenDir?: "long" | "short";
  /**
   * VỊ TRÍ mức thoát trong kênh close, tổng quát hoá `longExitMode="mid"`:
   *     mức thoát = closeLow + pct × (closeHigh − closeLow)
   * pct = 0,5 là ĐANG CHẠY (midpoint). pct = 0 là kênh thoát kiểu Turtle GỐC (thoát ở đáy kênh —
   * để winner chạy lâu hơn). pct = 0,8 thoát rất sớm.
   *
   * Vì sao đáng đo: repo đã quét ĐỘ DÀI kênh thoát (12–30 ngày) nhưng **chưa bao giờ quét VỊ TRÍ**
   * trong kênh — 0,5 là một lựa chọn mặc định chưa từng được kiểm. Và attribution nói 100% lợi nhuận
   * đến từ nhánh thoát này. undefined = 0,5 = hành vi không đổi một bit.
   */
  longExitPct?: number;
  /**
   * SÀN TRAIL cho LONG: ngoài midTrail theo kênh close, giữ thêm một hard stop TRAIL kiểu Chandelier
   * ở `extreme − mult × ATR`, lấy mức cao hơn.
   *
   * Vì sao đáng đo: trong nhánh `longExitMode="mid"` hiện tại, `pos.sl` **KHÔNG hề trail** — nó chỉ
   * nhích lên khi có unit pyramid mới. Nghĩa là một vị thế LONG có thể trả lại rất nhiều lợi nhuận
   * trước khi close cắt được midpoint. Repo đã test mid vs chandelier như hai LỰA CHỌN THAY THẾ,
   * chưa bao giờ test chúng KẾT HỢP. 0/undefined = tắt = hành vi không đổi một bit.
   */
  longTrailMult?: number;
};

/** costR cho một unit, tôn trọng phí riêng của sổ nếu có. */
function unitCostR(p: ExtParams, entry: number, initialSL: number, entryTime: number, exitTime: number): number {
  if (p.takerFeePct === undefined && p.slippagePct === undefined) {
    return tradeCostR(entry, initialSL, entryTime, exitTime);
  }
  if (!CONFIG.costs.enabled) return 0;
  const riskFrac = Math.abs(entry - initialSL) / entry;
  if (riskFrac <= 0) return 0;
  const taker = p.takerFeePct ?? CONFIG.costs.takerFeePct;
  const slip = p.slippagePct ?? CONFIG.costs.slippagePct;
  const feeFrac = ((taker + slip) / 100) * 2;
  const periods = Math.max(
    0,
    Math.floor(exitTime / FUNDING_INTERVAL_MS) - Math.floor(entryTime / FUNDING_INTERVAL_MS),
  );
  const fundingFrac = (periods * CONFIG.costs.fundingPer8hPct) / 100;
  return (feeFrac + fundingFrac) / riskFrac;
}

/** Một "sổ" độc lập = (symbol, bộ tham số). Nhiều sổ trên cùng symbol = nhiều tốc độ tín hiệu. */
export interface Book {
  key: string;
  symbol: string;
  candles: Candle[];
  p: ExtParams;
}

export function runTurtlePortfolio(
  data: Map<string, Candle[]>,
  p: TurtleParams = T,
  admit?: AdmitFn,
): PortfolioResult {
  return runBooks(
    [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p })),
    admit,
  );
}

export function runBooks(books: Book[], admit?: AdmitFn): PortfolioResult {
  // Tiền xử lý chỉ báo + index theo thời gian cho từng sổ
  type Ctx = {
    book: Book;
    c: Candle[];
    p: ExtParams;
    /** `p` với chandelierMult thay bằng initialStopMult — CHỈ dùng cho turtleInitialStop. */
    stopP: ExtParams;
    dcEntry: number;
    dcShortEntry: number;
    dcLongExit: number;
    dcShortExit: number;
    maxHoldBars: number;
    warmup: number;
    emaArr: number[];
    ema2Arr: number[] | null;
    atr: number[];
    volSma: number[] | null;
    idxOf: Map<number, number>;
    pos: Pos | null;
    cooldownUntil: number;
    /** Setup SHORT đã "arm" ở nến phá vỡ, chờ xác nhận (chỉ khi p.shortConfirmBars > 0). */
    shortSetup: { level: number; signalIndex: number } | null;
  };
  const ctxs = new Map<string, Ctx>();
  const allTimes = new Set<number>();
  for (const book of books) {
    const { p } = book;
    const c = book.candles;
    const barsPerDay = TF_MS["1d"] / TF_MS[p.tf];
    const dcEntry = Math.max(2, Math.round(p.entryDays * barsPerDay));
    const dcShortEntry = p.shortEntryDays > 0 ? Math.max(2, Math.round(p.shortEntryDays * barsPerDay)) : dcEntry;
    const dcLongExit = p.longExitDays && p.longExitDays > 0 ? Math.max(2, Math.round(p.longExitDays * barsPerDay)) : dcEntry;
    const dcShortExit = p.shortExitDays && p.shortExitDays > 0 ? Math.max(2, Math.round(p.shortExitDays * barsPerDay)) : dcShortEntry;
    const warmup = Math.max(dcEntry, dcShortEntry, dcLongExit, dcShortExit, p.trendLen, p.trendLen2, p.atrPeriod) + 1;
    const closes = c.map((x) => x.close);
    let volSma: number[] | null = null;
    if (p.confirmVolMult > 0) {
      volSma = new Array(c.length).fill(0);
      let s = 0;
      for (let i = 0; i < c.length; i++) {
        s += c[i].volume;
        if (i >= 20) s -= c[i - 20].volume;
        volSma[i] = s / Math.min(i + 1, 20);
      }
    }
    const idxOf = new Map<number, number>();
    for (let i = 0; i < c.length; i++) {
      idxOf.set(c[i].openTime, i);
      if (i >= warmup) allTimes.add(c[i].openTime);
    }
    ctxs.set(book.key, {
      book,
      c,
      p,
      stopP: p.initialStopMult && p.initialStopMult !== p.chandelierMult
        ? { ...p, chandelierMult: p.initialStopMult }
        : p,
      dcEntry,
      dcShortEntry,
      dcLongExit,
      dcShortExit,
      maxHoldBars: Math.round(p.maxHoldDays * barsPerDay),
      warmup,
      emaArr: ema(closes, p.trendLen),
      ema2Arr: p.trendLen2 > 0 ? ema(closes, p.trendLen2) : null,
      atr: (p.volSeries ?? atrSeries)(c, p.atrPeriod),
      volSma,
      idxOf,
      pos: null,
      cooldownUntil: -1,
      shortSetup: null,
    });
  }
  const symbols = books.map((b) => b.key);

  const times = [...allTimes].sort((a, b) => a - b);
  const trades: UnitTrade[] = [];
  const equity: EquityPoint[] = [];
  let realized = 0;
  let nextPositionId = 1;
  let rejectedEntries = 0;
  let rejectedAdds = 0;

  const snapshotOpen = (): OpenUnit[] => {
    const out: OpenUnit[] = [];
    for (const sym of symbols) {
      const ctx = ctxs.get(sym)!;
      if (!ctx.pos) continue;
      for (const u of ctx.pos.units) {
        out.push({
          book: sym,
          symbol: ctx.book.symbol,
          dir: ctx.pos.dir,
          positionId: ctx.pos.positionId,
          unitIndex: u.unitIndex,
          entryTime: ctx.c[u.entryIndex].openTime,
          entry: u.entry,
          initialSL: u.initialSL,
          weight: u.weight,
        });
      }
    }
    return out;
  };

  /** Trả tỉ trọng risk cho unit sắp mở (0 = bỏ). */
  // Ảnh chụp trạng thái đầu nến, dùng chung cho mọi tín hiệu trong nến đó (xem `admitBarSnapshot`).
  const barSnapshotMode = books.some((b) => b.p.admitBarSnapshot);
  let barSnapshot: OpenUnit[] | null = null;

  const askAdmit = (
    kind: "entry" | "add", time: number, symbol: string, dir: "long" | "short",
    entryPrice?: number, initialSL?: number,
  ): number => {
    if (!admit) return 1;
    const open = barSnapshot ?? snapshotOpen();
    let same = 0,
      sameHeat = 0,
      totalHeat = 0;
    for (const u of open) {
      totalHeat += u.weight;
      if (u.dir === dir) {
        same++;
        sameHeat += u.weight;
      }
    }
    const w = admit({
      time,
      symbol,
      rawSymbol: ctxs.get(symbol)?.book.symbol ?? symbol,
      dir,
      kind,
      open,
      sameDirUnits: same,
      oppDirUnits: open.length - same,
      sameDirHeat: sameHeat,
      totalHeat,
      entryPrice,
      initialSL,
    });
    // Trần 1 đã được BỎ (2026-08-13): cần biểu diễn được unit bị NÂNG LÊN SÀN minNotional của sàn
    // giao dịch, tức unit buộc phải mang risk LỚN HƠN dự định (weight > 1). Mọi `AdmitFn` hiện có
    // đều trả 1/(1+heat/k) ≤ 1 nên đây là no-op với chúng — `portfolio-equivalence.ts` vẫn khớp 100%.
    return Math.max(0, w);
  };

  for (const t of times) {
    // Symbol vừa exit trong bar này KHÔNG được vào lệnh mới cùng bar (giữ đúng `continue` của runTurtle).
    const exitedThisBar = new Set<string>();
    barSnapshot = barSnapshotMode ? snapshotOpen() : null;

    // ── Bước 1/2 cho MỖI symbol: quản lý vị thế đang mở (exit → trail → pyramid add) ──
    // Hai vòng lặp dưới đây LỒNG NHAU theo symbol trong `stepSymbol` để khớp ĐÚNG thứ tự của
    // `TurtleLive.step()` (live xử lý trọn vẹn từng symbol rồi mới sang symbol kế) — quan trọng khi
    // `admit` phụ thuộc trạng thái danh mục: thứ tự khác ⇒ tỉ trọng risk khác.
    for (const sym of symbols) {
      manageOpen(sym);
      tryEntry(sym);
    }

    function manageOpen(sym: string) {
      const ctx = ctxs.get(sym)!;
      const i = ctx.idxOf.get(t);
      if (i === undefined || i < ctx.warmup || !ctx.pos) return;
      const { p, dcLongExit, dcShortExit, maxHoldBars } = ctx;
      const c = ctx.c;
      const bar = c[i];
      const pos = ctx.pos;
      const longExitCh = priorDonchian(c, i, dcLongExit);
      const shortExitCh = dcShortExit === dcLongExit ? longExitCh : priorDonchian(c, i, dcShortExit);
      const xp = p.longExitPct ?? 0.5;
      const longMidClose = longExitCh.closeLow + xp * (longExitCh.closeHigh - longExitCh.closeLow);
      const shortMidClose = shortExitCh.closeLow + (1 - xp) * (shortExitCh.closeHigh - shortExitCh.closeLow);

      const held = i - pos.units[0].entryIndex;
      let exitPrice: number | null = null;
      let reason: UnitTrade["exitReason"] | null = null;

      // Trượt giá phụ thuộc CÁCH khớp, không phụ thuộc nhãn lý do: fill tại giá stop trong nến là
      // đại lượng không đo được (`slipTrailAtr`); fill bằng market order tại giá đóng nến là đại
      // lượng khác hẳn (`slipCloseAtr`).
      let fillKind: "stop" | "close" = "close";
      const stopHit = p.stopOnCloseOnly
        ? (pos.dir === "long" ? bar.close <= pos.sl : bar.close >= pos.sl)
        : (pos.dir === "long" ? bar.low <= pos.sl : bar.high >= pos.sl);

      if (stopHit) {
        exitPrice = p.stopOnCloseOnly ? bar.close : pos.sl;
        reason = "trail";
        fillKind = p.stopOnCloseOnly ? "close" : "stop";
      } else if (pos.dir === "long") {
        if (p.longExitMode === "mid" && pos.midTrail !== null && bar.close <= pos.midTrail) {
          exitPrice = bar.close;
          reason = "mid";
        } else if (held >= maxHoldBars) {
          exitPrice = bar.close;
          reason = "time";
        }
      } else {
        if (p.shortExitMode === "mid" && pos.midTrail !== null && bar.close >= pos.midTrail) {
          exitPrice = bar.close;
          reason = "mid";
        } else if (held >= maxHoldBars) {
          exitPrice = bar.close;
          reason = "time";
        }
      }

      // Trượt giá bất lợi khi khớp lệnh thoát (stress-test giả định fill hoàn hảo của engine).
      if (exitPrice !== null && reason !== null) {
        const slipAtr = fillKind === "stop" ? (p.slipTrailAtr ?? 0) : (p.slipCloseAtr ?? 0);
        if (slipAtr > 0 && ctx.atr[i] > 0) {
          exitPrice += (pos.dir === "long" ? -1 : 1) * slipAtr * ctx.atr[i];
        }
      }

      if (exitPrice !== null && reason !== null) {
        for (const u of pos.units) {
          const risk = Math.abs(u.entry - u.initialSL);
          const pnl = pos.dir === "long" ? exitPrice - u.entry : u.entry - exitPrice;
          const grossR = risk > 0 ? pnl / risk : 0;
          const entryTime = c[u.entryIndex].openTime;
          const costR = unitCostR(p, u.entry, u.initialSL, entryTime, t);
          const netR = grossR - costR;
          realized += netR * u.weight;
          trades.push({
            book: sym,
            symbol: ctx.book.symbol,
            dir: pos.dir,
            positionId: pos.positionId,
            unitIndex: u.unitIndex,
            entryTime,
            entryPrice: u.entry,
            initialSL: u.initialSL,
            exitTime: t,
            exitPrice,
            exitReason: reason,
            grossR,
            costR,
            netR,
            holdBars: i - u.entryIndex,
            weight: u.weight,
          });
        }
        ctx.cooldownUntil = i + p.cooldownBars;
        ctx.pos = null;
        exitedThisBar.add(sym);
        return;
      }

      // Trailing ratchet
      if (pos.dir === "long") {
        if (p.longExitMode === "mid") {
          pos.midTrail = Math.max(pos.midTrail ?? pos.sl, longMidClose);
          // Sàn trail tuỳ chọn: hard stop cũng đi lên theo đỉnh đã đạt (xem `longTrailMult`).
          if (p.longTrailMult && p.longTrailMult > 0 && ctx.atr[i] > 0) {
            pos.extreme = Math.max(pos.extreme, bar.high);
            const floor = pos.extreme - p.longTrailMult * ctx.atr[i];
            if (floor > pos.sl) pos.sl = floor;
          }
        } else {
          pos.extreme = Math.max(pos.extreme, bar.high);
          const trail = pos.extreme - p.chandelierMult * ctx.atr[i];
          if (trail > pos.sl) pos.sl = trail;
        }
      } else {
        if (p.shortExitMode === "mid") pos.midTrail = Math.min(pos.midTrail ?? pos.sl, shortMidClose);
        else {
          pos.extreme = Math.min(pos.extreme, bar.low);
          const trail = pos.extreme + p.chandelierMult * ctx.atr[i];
          if (trail < pos.sl) pos.sl = trail;
        }
      }

      // Breakeven ratchet — chạy SAU trail nên chỉ có thể siết thêm, không nới ra.
      if (p.breakevenAtR && p.breakevenAtR > 0 && (!p.breakevenDir || p.breakevenDir === pos.dir)) {
        const u0 = pos.units[0];
        const risk0 = Math.abs(u0.entry - u0.initialSL);
        if (risk0 > 0) {
          // `extreme` không được cập nhật ở nhánh mid-exit, nên tự cập nhật tại đây.
          pos.extreme = pos.dir === "long" ? Math.max(pos.extreme, bar.high) : Math.min(pos.extreme, bar.low);
          const moved = (pos.dir === "long" ? pos.extreme - u0.entry : u0.entry - pos.extreme) / risk0;
          if (moved >= p.breakevenAtR) {
            pos.sl = pos.dir === "long" ? Math.max(pos.sl, u0.entry) : Math.min(pos.sl, u0.entry);
          }
        }
      }

      // Pyramid add
      if (p.pyramidStepAtr > 0 && pos.units.length < p.pyramidMaxUnits && ctx.atr[i] > 0) {
        const last = pos.units[pos.units.length - 1];
        if (pos.dir === "long" && bar.close >= last.entry + p.pyramidStepAtr * ctx.atr[i]) {
          const initialSL = turtleInitialStop(c, i, "long", bar.close, ctx.atr[i], ctx.stopP).price;
          if (initialSL > 0) {
            const w = askAdmit("add", t, sym, "long", bar.close, initialSL);
            if (w > 0) {
              pos.units.push({ entryIndex: i, entry: bar.close, initialSL, unitIndex: pos.units.length, weight: w });
              if (p.longExitMode === "mid" && p.pyramidTightensStop !== false) pos.sl = Math.max(pos.sl, initialSL);
            } else rejectedAdds++;
          }
        } else if (pos.dir === "short" && bar.close <= last.entry - p.pyramidStepAtr * ctx.atr[i]) {
          const initialSL = turtleInitialStop(c, i, "short", bar.close, ctx.atr[i], ctx.stopP).price;
          const w = askAdmit("add", t, sym, "short", bar.close, initialSL);
          if (w > 0) {
            pos.units.push({ entryIndex: i, entry: bar.close, initialSL, unitIndex: pos.units.length, weight: w });
            if (p.shortExitMode === "mid" && p.pyramidTightensStop !== false) pos.sl = Math.min(pos.sl, initialSL);
          } else rejectedAdds++;
        }
      }
    }

    // ── Bước 2/2 cho MỖI symbol: tìm lệnh mới ──
    function tryEntry(sym: string) {
      const ctx = ctxs.get(sym)!;
      const i = ctx.idxOf.get(t);
      if (i === undefined || i < ctx.warmup || ctx.pos || i < ctx.cooldownUntil || exitedThisBar.has(sym)) return;
      const { p, dcEntry, dcShortEntry, dcLongExit, dcShortExit } = ctx;
      const c = ctx.c;
      const bar = c[i];
      const longChannel = priorDonchian(c, i, dcEntry);
      const shortChannel = dcShortEntry === dcEntry ? longChannel : priorDonchian(c, i, dcShortEntry);
      const longExitCh = dcLongExit === dcEntry ? longChannel : priorDonchian(c, i, dcLongExit);
      const shortExitCh = dcShortExit === dcShortEntry ? shortChannel : priorDonchian(c, i, dcShortExit);
      const xp = p.longExitPct ?? 0.5;
      const longMidClose = longExitCh.closeLow + xp * (longExitCh.closeHigh - longExitCh.closeLow);
      const shortMidClose = shortExitCh.closeLow + (1 - xp) * (shortExitCh.closeHigh - shortExitCh.closeLow);

      const uptrend = bar.close > ctx.emaArr[i] && (!ctx.ema2Arr || bar.close > ctx.ema2Arr[i]);
      const downtrend = bar.close < ctx.emaArr[i] && (!ctx.ema2Arr || bar.close < ctx.ema2Arr[i]);
      const buf = p.entryBufferAtr > 0 ? p.entryBufferAtr * ctx.atr[i] : 0;
      const volOk =
        !ctx.volSma || (i > 0 && ctx.volSma[i - 1] > 0 && bar.volume >= p.confirmVolMult * ctx.volSma[i - 1]);
      const longBreakout = p.longEntrySource === "close" ? longChannel.closeHigh : longChannel.high;
      const shortBreakout = p.shortEntrySource === "close" ? shortChannel.closeLow : shortChannel.low;
      const shortGateOk = p.allowShort && downtrend && volOk && (!p.gate || p.gate(bar.openTime, "short"));

      const openLong = (entry: number, initialSL: number) => {
        if (!(initialSL > 0 && initialSL < entry)) return;
        const w = askAdmit("entry", t, sym, "long", entry, initialSL);
        if (w <= 0) {
          rejectedEntries++;
          return;
        }
        ctx.pos = {
          dir: "long",
          positionId: nextPositionId++,
          units: [{ entryIndex: i, entry, initialSL, unitIndex: 0, weight: w }],
          sl: initialSL,
          extreme: bar.high,
          midTrail: p.longExitMode === "mid" ? Math.max(initialSL, longMidClose) : null,
        };
      };

      const openShort = (entry: number, initialSL: number) => {
        if (!(initialSL > entry)) return;
        const w = askAdmit("entry", t, sym, "short", entry, initialSL);
        if (w <= 0) {
          rejectedEntries++;
          return;
        }
        ctx.pos = {
          dir: "short",
          positionId: nextPositionId++,
          units: [{ entryIndex: i, entry, initialSL, unitIndex: 0, weight: w }],
          sl: initialSL,
          extreme: bar.low,
          midTrail: p.shortExitMode === "mid" ? Math.min(initialSL, shortMidClose) : null,
        };
      };

      // ── TÍN HIỆU VÀO LỆNH THAY THẾ (chiến lược khác dùng chung bộ máy rủi ro) ──
      if (p.entrySignal) {
        const dir = p.entrySignal(ctx.book.symbol, i, c);
        if (!dir) return;
        if (p.gate && !p.gate(bar.openTime, dir)) return;
        if (dir === "short" && !p.allowShort) return;
        const want = p.entryFillPrice?.(ctx.book.symbol, i, c, dir);
        const entry = want !== undefined && want >= bar.low && want <= bar.high ? want : bar.close;
        const initialSL = turtleInitialStop(c, i, dir, entry, ctx.atr[i], ctx.stopP).price;
        if (dir === "long") openLong(entry, initialSL);
        else openShort(entry, initialSL);
        return;
      }

      // ── SHORT có XÁC NHẬN (sleeve Fast): nến phá vỡ chỉ "arm", nến kế tiếp phải giữ dưới mức đã
      //    đóng băng mới vào. Thứ tự trùng `FastTrendLive.step`: xác nhận → breakout LONG → arm mới.
      const sc = p.shortConfirmBars ?? 0;
      if (sc > 0 && ctx.shortSetup) {
        const setup = ctx.shortSetup;
        ctx.shortSetup = null;
        const onConfirmBar = bar.openTime === c[setup.signalIndex].openTime + sc * TF_MS[p.tf];
        if (onConfirmBar && shortGateOk && bar.close < setup.level) {
          openShort(bar.close, turtleInitialStop(c, i, "short", bar.close, ctx.atr[i], ctx.stopP).price);
          if (ctx.pos) return;
        }
        // huỷ setup → rơi xuống nhánh LONG của chính nến này (giống live)
      }

      if (uptrend && volOk && (!p.gate || p.gate(bar.openTime, "long")) && bar.close > longBreakout + buf) {
        const entry = bar.close;
        openLong(entry, turtleInitialStop(c, i, "long", entry, ctx.atr[i], ctx.stopP).price);
      } else if (shortGateOk && bar.close < shortBreakout - buf) {
        if (sc > 0) {
          ctx.shortSetup = { level: shortBreakout, signalIndex: i };
        } else {
          const entry = bar.close;
          openShort(entry, turtleInitialStop(c, i, "short", entry, ctx.atr[i], ctx.stopP).price);
        }
      }
    }

    // ── Mark-to-market cuối bar ──
    let unreal = 0;
    let openCount = 0;
    let longUnits = 0;
    let shortUnits = 0;
    for (const sym of symbols) {
      const ctx = ctxs.get(sym)!;
      const i = ctx.idxOf.get(t);
      if (i === undefined || !ctx.pos) continue;
      const px = ctx.c[i].close;
      for (const u of ctx.pos.units) {
        const risk = Math.abs(u.entry - u.initialSL);
        if (risk <= 0) continue;
        unreal += ((ctx.pos.dir === "long" ? px - u.entry : u.entry - px) / risk) * u.weight;
        openCount++;
        if (ctx.pos.dir === "long") longUnits += u.weight;
        else shortUnits += u.weight;
      }
    }
    equity.push({ time: t, realized, mtm: realized + unreal, openUnits: openCount, longUnits, shortUnits });
  }

  return { trades, equity, rejectedEntries, rejectedAdds, openAtEnd: snapshotOpen() };
}

// ─────────────────────────────────────────────
// METRICS cấp danh mục
// ─────────────────────────────────────────────
export interface PortfolioStats {
  n: number;
  positions: number;
  net: number;
  exp: number;
  wr: number;
  ddRealized: number;
  ddMtm: number;
  netOverDd: number; // NET / maxDD(MTM) — bất biến với đòn bẩy → metric so sánh chính
  peakUnits: number;
  peakSameDir: number;
  avgOpenUnits: number;
}

/**
 * Equity compounding từ chuỗi mark-to-market R với `risk` phần trăm equity mỗi unit.
 * Dùng để so sánh CÔNG BẰNG giữa các chính sách: một chính sách giảm DD có thể chạy đòn bẩy cao
 * hơn để về đúng mức DD cũ — chỉ khi đó "NET R cao hơn" mới có ý nghĩa kinh tế.
 */
export function compoundedEquity(equity: EquityPoint[], riskPerUnit: number): { mult: number; maxDD: number } {
  let e = 1,
    peak = 1,
    dd = 0;
  for (let i = 1; i < equity.length; i++) {
    const d = equity[i].mtm - equity[i - 1].mtm;
    e *= 1 + d * riskPerUnit;
    if (e <= 0) return { mult: 0, maxDD: 1 };
    peak = Math.max(peak, e);
    dd = Math.max(dd, (peak - e) / peak);
  }
  return { mult: e, maxDD: dd };
}

/** Tìm risk/unit sao cho maxDD compounding = targetDD (bisection). */
export function riskForTargetDD(equity: EquityPoint[], targetDD: number): number {
  let lo = 0.0001,
    hi = 0.2;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (compoundedEquity(equity, mid).maxDD > targetDD) hi = mid;
    else lo = mid;
  }
  return lo;
}

/**
 * Chỉ số rủi ro trên chuỗi P&L NGÀY (R) — dùng thay/kèm maxDD vì maxDD chỉ là MỘT quan sát cực trị
 * nên rất nhiễu khi so sánh nhiều biến thể. Sharpe & Ulcer dùng toàn bộ dữ liệu và bất biến đòn bẩy.
 */
export interface RiskMetrics {
  days: number;
  netR: number;
  sharpe: number; // annualized, trên P&L ngày (R)
  sortino: number;
  ulcer: number; // RMS drawdown (R)
  netOverUlcer: number;
  maxDD: number;
  netOverMaxDD: number;
  skew: number;
  worstMonthR: number;
}

export function riskMetrics(equity: EquityPoint[]): RiskMetrics {
  if (equity.length < 3) {
    return { days: 0, netR: 0, sharpe: 0, sortino: 0, ulcer: 0, netOverUlcer: 0, maxDD: 0, netOverMaxDD: 0, skew: 0, worstMonthR: 0 };
  }
  const DAY = 24 * 3600 * 1000;
  // gộp về P&L theo ngày lịch
  const perDay = new Map<number, number>();
  for (let i = 1; i < equity.length; i++) {
    const d = Math.floor(equity[i].time / DAY);
    perDay.set(d, (perDay.get(d) ?? 0) + (equity[i].mtm - equity[i - 1].mtm));
  }
  const days = [...perDay.keys()].sort((a, b) => a - b);
  const r = days.map((d) => perDay.get(d)!);
  const n = r.length;
  const mean = r.reduce((s, x) => s + x, 0) / n;
  const varr = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(varr);
  const down = r.filter((x) => x < 0);
  const dsd = down.length ? Math.sqrt(down.reduce((s, x) => s + x * x, 0) / down.length) : 0;
  const m3 = r.reduce((s, x) => s + (x - mean) ** 3, 0) / n;
  const skew = sd > 0 ? m3 / sd ** 3 : 0;

  let cum = 0,
    peak = 0,
    maxDD = 0,
    sumSq = 0;
  for (const x of r) {
    cum += x;
    peak = Math.max(peak, cum);
    const dd = peak - cum;
    maxDD = Math.max(maxDD, dd);
    sumSq += dd * dd;
  }
  const ulcer = Math.sqrt(sumSq / n);

  // tháng tệ nhất
  const perMonth = new Map<string, number>();
  for (let i = 0; i < days.length; i++) {
    const k = new Date(days[i] * DAY).toISOString().slice(0, 7);
    perMonth.set(k, (perMonth.get(k) ?? 0) + r[i]);
  }
  const worstMonthR = Math.min(...perMonth.values());

  const netR = cum;
  return {
    days: n,
    netR,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    sortino: dsd > 0 ? (mean / dsd) * Math.sqrt(365) : 0,
    ulcer,
    netOverUlcer: ulcer > 0 ? netR / ulcer : 0,
    maxDD,
    netOverMaxDD: maxDD > 0 ? netR / maxDD : 0,
    skew,
    worstMonthR,
  };
}

export function portfolioStats(res: PortfolioResult, opts?: { from?: number; to?: number }): PortfolioStats {
  const from = opts?.from ?? -Infinity;
  const to = opts?.to ?? Infinity;
  const trades = res.trades.filter((t) => t.entryTime >= from && t.entryTime <= to);
  const eq = res.equity.filter((e) => e.time >= from && e.time <= to);
  const n = trades.length;
  const net = trades.reduce((s, t) => s + t.netR * t.weight, 0);
  const totalWeight = trades.reduce((s, t) => s + t.weight, 0);
  const wins = trades.filter((t) => t.netR > 0).length;

  // maxDD realized: theo thứ tự đóng lệnh
  const byExit = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let cum = 0,
    peak = 0,
    ddR = 0;
  for (const t of byExit) {
    cum += t.netR * t.weight;
    peak = Math.max(peak, cum);
    ddR = Math.max(ddR, peak - cum);
  }
  // maxDD mark-to-market
  let peakM = -Infinity,
    ddM = 0,
    peakUnits = 0,
    peakSame = 0,
    sumUnits = 0;
  const base = eq.length ? eq[0].mtm : 0;
  for (const e of eq) {
    const v = e.mtm - base;
    peakM = Math.max(peakM, v);
    ddM = Math.max(ddM, peakM - v);
    peakUnits = Math.max(peakUnits, e.openUnits);
    peakSame = Math.max(peakSame, e.longUnits, e.shortUnits);
    sumUnits += e.openUnits;
  }
  const positions = new Set(trades.map((t) => `${t.symbol}#${t.positionId}`)).size;
  return {
    n,
    positions,
    net,
    exp: totalWeight ? net / totalWeight : 0,
    wr: n ? (wins / n) * 100 : 0,
    ddRealized: ddR,
    ddMtm: ddM,
    netOverDd: ddM > 0 ? net / ddM : 0,
    peakUnits,
    peakSameDir: peakSame,
    avgOpenUnits: eq.length ? sumUnits / eq.length : 0,
  };
}
