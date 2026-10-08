/**
 * Key Volume — bản số hoá phương pháp FX Dream Trading, chạy TRỌN VẸN trên M15.
 *
 * Engine nhận thẳng nến M15 và không dùng khung nào khác. Không còn Daily,
 * Weekly, H4, H1, và cũng không còn M5: nến M15 vừa là khung luật vừa là khung
 * mô phỏng. Hệ quả bắt buộc của việc bỏ M5: khi một nến chạm CẢ SL lẫn mục tiêu
 * thì không biết cái nào trước, nên tính STOP trước — quy ước bi quan, giống
 * mọi backtest lệnh chờ khác của repo.
 *
 * BỐN NHÁNH VÀO LỆNH ĐỘC LẬP NHAU, không chia sẻ một điều kiện nào:
 *
 *   NHÁNH 1 — `sweep-reclaim`, THUẦN SĂN THANH KHOẢN, không đụng tới key.
 *     · Bóp cò: nến M15 thủng đỉnh/đáy của `sweepLookback` nến ngay trước nó
 *       (480 nến = năm ngày, cuộn liên tục, kể cả đỉnh/đáy vừa tạo; chỗ đọng
 *       stop của người khác) rồi giá trở lại trong biên, theo một trong hai kiểu:
 *       RÚT RÂU — chính nến thủng đóng lại trong biên; hoặc CHẠY TỪ TỪ LẠI — nến
 *       thủng đóng ngoài mức, giá nằm ngoài tối đa `sweepMaxOutsideBars` nến (16
 *       = 4 giờ, tính cả nến thủng) rồi một nến đóng trở lại vào trong. Nến đóng
 *       lại là nến bóp cò. Mức đã bị quét mà bị thủng lần nữa thì vẫn tính.
 *     · Mức bị quét phải NỔI BẬT: đi ngược về trước `sweepProminenceBars` nến
 *       (96 = một ngày) tính từ chính cây tạo ra cực trị, không nến nào được
 *       vượt qua nó. Mức đã là cực trị của cả cửa sổ nên lọc này CHỈ có tác dụng
 *       khi cây cực trị nằm trong 96 nến đầu cửa sổ (đo 250 ngày: gạt 0,8%).
 *     · Hướng: quét đáy -> LONG, quét đỉnh -> SHORT. Không cần key, không cần
 *       nến chạm key, không cần volume.
 *     · THẤY RÚT RÂU CHƯA VÀO (`sweepEntry: "order-block"`). Trong
 *       `sweepObWaitBars` nến (16 = 4 giờ) kể từ nến đóng lại, chờ CỤM NẾN ĐẢO
 *       CHIỀU (xem dưới) mà nến ĐÁY (mũi nhọn) là một nến SAU cú quét quay lại
 *       CHẠM mức bị quét — chính cây râu quét không tính. Giá vượt qua râu quét
 *       thì cú quét chết. Có cụm thì đặt LỆNH CHỜ ở mép thuận chiều của order
 *       block (long: `obHigh`, short: `obLow`), sống `obLimitBars` nến. SL ngay
 *       ngoài râu quét. Luật cũ `reclaim-close` (vào ngay ở giá ĐÓNG nến đóng lại)
 *       và `box-retest` (hộp là thân cây nến quét, đi ba bước) giữ để ablation.
 *     · TP: cụm thanh khoản ĐỐI DIỆN — đỉnh/đáy của đúng cửa sổ `sweepLookback`
 *       đó ở phía bên kia. Quét bên này thì chạy sang bên kia.
 *
 *   NHÁNH 2 — `volume-reversal`, nhánh dùng key:
 *     · KEY — nến M15 có volume >= `volumeSpikeMult` lần (×4) TRUNG VỊ của
 *       `volumeLookback` nến XUNG QUANH nó (chia đều hai bên, đúng cách mắt
 *       người chấm trên chart). Vì cửa sổ có tâm, key chỉ BIẾT ĐƯỢC sau khi nến
 *       cuối cửa sổ đóng; `confirmedAt` ghi đúng mốc đó nên replay không nhìn
 *       trước. Key là MỘT ĐƯỜNG THẲNG đặt tại giá MỞ CỬA của cây nến đó — không
 *       còn vùng dày bằng biên độ nến, nên `zoneLow === zoneHigh === price`.
 *     · KEY PHẢI CHÍN (`requireKeyMaturation`) — key mới sinh CHƯA dùng được. Nó
 *       chỉ có hiệu lực sau một lần được giá tôn trọng: giá RỜI key >=
 *       `keyMatureAwayAtr` ATR, QUAY LẠI chạm key, rồi trong `keyMatureBars` nến
 *       ĐÓNG bật ra >= `keyMatureBounceAtr` ATR về đúng phía đã rời. Giá đóng
 *       xuyên sang phía kia trước khi bật, hoặc chạm mà không bật kịp, thì key
 *       chết hẳn. `maturedAt` là mốc key bắt đầu dùng được, nên cú chạm ĐẦU TIÊN
 *       (cú làm key chín) không bao giờ là lệnh — "cái phát đầu tiên là không
 *       thể nào mà tray được" (#22).
 *     · HƯỚNG — giá đang ở TRÊN key thì key là đỡ -> LONG; ở DƯỚI thì key là
 *       cản -> SHORT.
 *     · QUAY VỀ: nến chạm key chỉ tính khi giá đã TỪNG rời hẳn key —
 *       `keyDepartureLookback` nến trước đó phải có ít nhất một nến nằm ngoài
 *       dải `±keyDepartureAtr × ATR`. Giá đi ngang đè lên key không phải quay về.
 *       Phía của lần rời GẦN NHẤT gắn nhãn `approach`: rời cùng phía với hướng
 *       lệnh (long mà giá về từ trên) là `bounce`; về từ phía bên kia — nến chạm
 *       vừa xuyên qua key — là `breakout`. Nhãn chỉ để báo cáo tách riêng, không
 *       chặn kiểu nào.
 *     · Bóp cò: CỤM NẾN ĐẢO CHIỀU ngay tại key (xem dưới), miễn cây nến đảo
 *       chiều có volume >= `reversalVolumeMult` lần trung vị các nến liền trước
 *       — nhỏ hơn hẳn ngưỡng chọn key, chỉ cần nhỉnh hơn xung quanh — VÀ đường
 *       key phải nằm TRONG thân hộp order block của cụm (`requireKeyInsideBlock`).
 *     · TP là key đối diện gần nhất.
 *
 *   NHÁNH 3 — `key-trap`, TRAP QUA KEY (user 03/10/26):
 *     · Giá ĐÓNG qua bên kia một key đã chín (nến trước còn đóng ở phía cũ), rồi
 *       trong `keyTrapMaxBars` nến (16 = 4 giờ, tính từ nến phá) một nến ĐÓNG quay
 *       về phía cũ, cách key ít nhất `keyTrapCloseAtr` ATR (0,5). Nến đóng sát key
 *       chưa tính, cũng không huỷ trap. Hết hạn mà chưa quay về thì cú phá là thật.
 *     · Phá lên rồi quay về -> SHORT; phá xuống rồi quay về -> LONG. Vào ở GIÁ
 *       ĐÓNG của nến quay về. Không cần volume, cụm nến hay hộp.
 *     · SL ngay ngoài cực trị của đoạn trap — từ cây ĐẦU TIÊN thò qua key (kể cả
 *       cây chỉ thò bằng râu ngay trước nến phá) tới nến quay về — đệm
 *       `stopBufferAtr` ATR. TP là key đối diện gần nhất, như nhánh 2.
 *
 *   NHÁNH 4 — `key-lower-high`, ĐỈNH THẤP DẦN SAU PHẢN ỨNG TẠI KEY (user 04/10/26):
 *     · ĐỈNH PHẢN ỨNG: một đỉnh swing (pivot `lowerHighPivotBars` mỗi bên) mà trong
 *       `lowerHighTouchBars` nến tính tới nó có nến chạm key đã chín. Nó mở chuỗi.
 *     · ĐỈNH THẤP HƠN: mỗi đỉnh swing sau đó thấp hơn đỉnh liền trước của chuỗi —
 *       chỉ cần MỘT — cho một order block: THÂN cây nến xanh cuối cùng của nhịp
 *       hồi lên đỉnh đó. Đỉnh xác nhận xong (nến bên phải đóng) thì đặt LỆNH CHỜ
 *       SHORT ở mép dưới thân, sống `obLimitBars` nến. Mép phải nằm dưới key và
 *       TRÊN giá lúc đặt (limit thật). Đỉnh cao hơn làm gãy chuỗi, trừ khi chính
 *       nó vừa chạm key (thành đỉnh phản ứng mới).
 *     · SL trên đỉnh LIỀN TRƯỚC (đỉnh cao hơn) + `stopBufferAtr` ATR. TP là key
 *       đối diện gần nhất nhưng KHÔNG đòi `minRR`. LONG là gương: đáy cao dần.
 *     · Ví dụ chuẩn BTC: 31/08 đỉnh 23:45 → đỉnh thấp hơn 00:45, khớp 01:15;
 *       01/09 đỉnh 04:30 → đỉnh thấp hơn 07:15 (giờ UTC+7).
 *
 * CỤM NẾN ĐẢO CHIỀU — một MŨI NHỌN: giá lao nhanh về một phía rồi bật ngược lại
 * cũng nhanh. Ba hình dạng, xét tại nến đảo chiều (nến cuối cụm), hình nào khớp
 * trước thì dùng theo thứ tự V -> hai nến -> râu dài. Mọi ngưỡng đo bằng ATR của
 * chính nến đảo chiều. Ví dụ LONG, SHORT là gương:
 *   · V — nến đảo chiều xanh; trong `vLegBars` nến liền trước có một nến ĐÁY (râu
 *       thấp nhất cả cụm). Chân xuống (từ đỉnh cao nhất trước đáy trong
 *       `vLegBars` nến, tới râu đáy) và chân lên (từ râu đáy tới giá đóng của nến
 *       đảo chiều) đều >= `vLegAtr` ATR.
 *   · Hai nến — nến đỏ thân dài rồi ngay nến sau là nến xanh thân dài; mỗi thân
 *       >= `twoBodyAtr` ATR và nến xanh lấy lại >= `twoRetrace` thân nến đỏ.
 *   · Râu dài — MỘT nến đâm râu dưới >= `pinWickAtr` ATR và >= 60% biên độ nến,
 *       giá đóng nằm trong 1/3 trên của nến. Không bắt buộc đúng màu.
 * Nến ĐÁY (nến mũi nhọn) quyết định hộp: hộp là THÂN các nến kết thúc ở nến đáy
 * (râu không tính) — 2 nến, hoặc 3 nếu thân nến thứ 3 chồng lên vùng thân của 2
 * nến kia (đang tích luỹ). Nhấn chìm, in3 và 3-bar reversal đã bị bỏ. Nhánh quét
 * dùng đúng ba hình này, chỉ thay cửa "key trong hộp" bằng "mũi nhọn chạm lại mức
 * bị quét" và không đòi volume.
 *
 * TÍN HIỆU A — HAI ĐÁY/ĐỈNH + RSI PHÂN KỲ, cách bóp cò thứ hai chạy SONG SONG
 * với cụm mũi nhọn trên cùng một setup key: cụm hợp lệ thì dùng cụm, không thì
 * thử A. A đo "ngay tại key" bằng phép đo riêng nên KHÔNG qua cửa "key trong
 * thân hộp" và cửa volume `reversalVolumeMult` của cụm. Đáy 2 là swing (pivot
 * 2/2) đã xác nhận, trong `structureKeyAtr` ATR quanh đường key, nằm từ nến liền
 * trước nến chạm key trở đi. Đáy 1 là swing tại key LIỀN TRƯỚC đáy 2 (cách ít
 * nhất 3 nến, không quá `divergenceLookbackBars` nến) — không được bỏ qua swing
 * ở giữa để dò cho ra phân kỳ. Đáy 2 không cao hơn đáy 1 quá
 * `divergencePriceTolAtr` ATR (mặc định 0: đáy 2 ngang hoặc thấp hơn — đáy 2 cao
 * hơn mà RSI cũng cao hơn là giá XÁC NHẬN, không phải phân kỳ) VÀ RSI
 * (`rsiPeriod`) tại đáy 2 cao hơn tại đáy 1. SHORT là gương. Swing đáy 2 dựng
 * hộp theo đúng luật hộp của cụm, rồi vào lệnh qua cùng cổng ba bước.
 *
 * XÁC NHẬN CẤU TRÚC (`requireSwingConfirmation`) — "hai higher high / lower low
 * trên M15 rồi mới entry" (#22) là bước CUỐI, không phải cò. Ở bước 3 của nhánh
 * key, kể từ sau nến đáy phải có hai đỉnh swing (pivot 2/2) đã xác nhận LIỀN
 * NHAU mà đỉnh sau cao hơn đỉnh trước (LONG); SHORT là hai đáy swing, đáy sau
 * thấp hơn. Chưa đủ thì hộp vẫn được canh tiếp.
 *
 * ORDER BLOCK — nhánh key VÀO và THOÁT bằng cùng một hộp, râu KHÔNG tính (nhánh
 * quét VÀO bằng lệnh chờ ở mép hộp — hoặc ba bước ở luật cũ `box-retest` — nhưng
 * THOÁT ngoài râu quét):
 *   · LONG  vào ở giá đóng nến bật lên trên `obHigh`, SL ở `obLow  - stopBufferAtr × ATR`
 *   · SHORT vào ở giá đóng nến bật xuống dưới `obLow`, SL ở `obHigh + stopBufferAtr × ATR`
 * Nhánh quét đặt SL ngay ngoài CÁI RÂU vừa quét (đệm `stopBufferAtr` ATR), không
 * ở mép thân: mép thân nằm trong râu, tức trong vùng giá vừa bị quét.
 * Giá vào lùi xa mép hộp hơn luật lệnh chờ cũ, nên R của mỗi lệnh TO hơn — đây
 * là chỗ luật mới mua thêm biên trên sàn chi phí.
 *
 * VÀO LỆNH NHÁNH KEY — BA BƯỚC, không có lệnh chờ nào nằm sẵn trên sổ (nhánh
 * quét chỉ đi ba bước này ở luật cũ `sweepEntry: "box-retest"`):
 *
 *   BƯỚC 1 · RỜI HỘP. Dựng hộp xong KHÔNG vào ngay. Đúng `obDepartBars` nến kế
 *     tiếp đều phải có GIÁ ĐÓNG nằm ngoài hộp, ĐÚNG CHIỀU lệnh (long: `close`
 *     trên `obHigh`; short: `close` dưới `obLow`). Râu được phép thò lại vào
 *     hộp. Chỉ một cây đóng lại trong hộp — hoặc đóng thủng ngược qua hộp — là
 *     bỏ hộp đó.
 *
 *   BƯỚC 2 · QUAY LẠI HỘP. Hộp qua cửa trên thì được TRANG BỊ và canh giá về.
 *     Chỉ cần một nến có biên độ chạm vào hộp là tính "đã quay lại". Hộp được
 *     canh đúng `boxWaitBars` nến (192 = HAI ngày) rồi bỏ, và chết sớm hơn nếu
 *     giá ĐÓNG xuyên qua nó ngược chiều lệnh (long: `close < obLow`) hoặc key
 *     của nó bị phá. Một đồng hồ duy nhất cho cả bước 2 và bước 3: quay lại
 *     rồi cũng không được thêm giờ.
 *
 *   BƯỚC 3 · NẾN BẬT RA KHỎI HỘP. Ở một nến SAU nến quay lại, cần đủ ba thứ:
 *     còn dính hộp, đúng màu thuận chiều (long xanh / short đỏ), và ĐÓNG CỬA ra
 *     ngoài hộp đúng chiều. Vào ngay ở GIÁ ĐÓNG của chính nến đó — nến xanh mà
 *     vẫn đóng trong hộp thì chưa vào.
 *
 * Vì giá vào chỉ biết được ở bước 3, hai cửa cuối cũng chỉ chấm được ở đó: SL
 * từ `minStopPct` tới `maxStopPct` giá, và dư địa tới mục tiêu >= `minRR`. Nến vào lệnh
 * đã đóng trọn nên KHÔNG được chấm SL/TP trên chính nó; 15 phút rủi ro đầu tiên
 * là cây kế tiếp.
 *
 * KHÔNG có trần thời gian giữ lệnh. Mọi nhánh chỉ ra bằng SL hoặc mục tiêu (user
 * bỏ luật "vào xong giá không chạy" 03/10/26). Key bị phá chỉ huỷ setup/hộp TRƯỚC
 * khi vào lệnh; đang giữ lệnh thì không thoát vì key (user bỏ luật đó 03/10/26).
 *
 * CHỐT MỘT PHẦN — mọi nhánh: giá chạm +`partialAtR` R (1R) thì chốt
 * `partialFraction` (0,33) khối lượng và dời SL phần còn lại về đúng giá vào;
 * phần còn lại gồng tới mục tiêu. Cùng nến chạm cả SL lẫn 1R vẫn tính SL trước.
 *
 * Binance kline không có volume-at-price thật, và việc chấm "key đẹp" trên kênh
 * vẫn là discretionary — model này không phải bản sao 100% của phương pháp tay.
 */
import { Candle, CONFIG, TF_MS, findSwings, Swing } from "./strategy";

export type KeyVolumeDirection = "long" | "short";
export type KeyVolumeSourceTf = "15m" | "1h" | "4h";
export type KeyVolumeTargetMode = "nearest-structure" | "capped-r";
/**
 * Mode SL của NHÁNH 2. Nhánh quét KHÔNG theo mode nào: SL luôn ngay ngoài cái
 * râu vừa quét, đệm `stopBufferAtr`.
 *
 * `order-block` là luật ĐANG CHẠY: SL ngay ngoài mép ĐỐI DIỆN của chính hộp
 * order block đã quyết định giá vào, đệm `stopBufferAtr`. Vào ở mép này thì
 * thoát ở mép kia — một hộp, hai đầu.
 *
 * Ba mode dưới là luật CŨ, chỉ còn để ablation so sánh.
 *
 * `sweep-window`: SL ở cực trị cả cửa sổ chạm key -> bóp cò trên M15.
 * `confirmation`: SL ngay sau nến xác nhận — "stop rất là ngắn... sau cái mô
 * hình đó".
 * `key`: SL ngay ngoài vùng key — "stop l ở dưới ky này thôi, không cần quá
 * xa" (#22).
 */
/**
 * "Nằm ở NGOÀI hộp" đo bằng gì. `close` là luật ĐANG CHẠY: chỉ GIÁ ĐÓNG phải ra
 * ngoài hộp, râu được phép thò lại vào trong. `candle` là luật cũ đòi CẢ CÂY
 * nến ra ngoài — giữ để ablation, giống cách `stopMode` giữ ba mode cũ.
 *
 * Cả hai mode đều đo THEO CHIỀU LỆNH: long đòi ở TRÊN `obHigh`, short đòi ở
 * DƯỚI `obLow`. Một nến đóng thủng ngược qua hộp là setup chết, không phải
 * "đã ra ngoài hộp".
 */
export type KeyVolumeDepartMode = "candle" | "close";

export type KeyVolumeStopMode =
  | "order-block"
  | "sweep-window"
  | "confirmation"
  | "key";
/**
 * `deeper-sweep`: chỉ vào lại sau stop dương + cú quét sâu hơn (từ `#26`).
 * `volume-retouch`: vào lại khi giá chạm key lần nữa và kích volume lần nữa —
 * `#23` và `#43` mô tả đây là thao tác thường quy sau stop dương.
 */
export type KeyVolumeReentryMode = "deeper-sweep" | "volume-retouch";
/** Nhánh nào đã bóp cò lệnh này. */
export type KeyVolumeEntryBranch = "sweep-reclaim" | "volume-reversal" | "key-trap" | "key-lower-high";
/**
 * Giá về key từ phía nào, so với hướng lệnh. `bounce`: về từ đúng phía key đang
 * làm đỡ/cản. `breakout`: về từ phía bên kia, nến chạm đã xuyên qua key.
 */
export type KeyVolumeApproach = "bounce" | "breakout";
export type KeyVolumeSweepEntry = "reclaim-close" | "box-retest" | "order-block";

export interface KeyVolumeParams {
  /** Khung DUY NHẤT: key, hướng, quét, mô hình nến, entry, stop và mô phỏng. */
  confirmTf: "15m";
  /** Tổng số nến XUNG QUANH dùng làm trung vị volume, chia đều hai bên. */
  volumeLookback: number;
  volumeSpikeMult: number;
  /**
   * Key chỉ có hiệu lực sau chu trình RỜI -> CHẠM LẠI -> BẬT RA (xem đầu file).
   * Rời >= `keyMatureAwayAtr` ATR, bật (giá đóng) >= `keyMatureBounceAtr` ATR
   * trong `keyMatureBars` nến kể từ nến chạm. "Chạm" dùng cùng dung sai
   * `keyTouchAtr` với setup để cả engine hiểu chữ chạm một nghĩa.
   */
  requireKeyMaturation: boolean;
  keyMatureAwayAtr: number;
  keyMatureBounceAtr: number;
  keyMatureBars: number;
  keyHistoryDays: number;
  minKeyReactions: number;
  keyReactionAtr: number;
  keyMaxAgeDays: number;
  /**
   * Số key ĐÃ CHÍN được sống cùng lúc. Key thứ `maxActiveKeys + 1` chín thì key
   * chín sớm nhất còn sống bị đẩy ra (hết hạn ngay trước mốc đó). Key chưa chín
   * không chiếm chỗ.
   */
  maxActiveKeys: number;
  /**
   * Key bị CHẠM quá nhiều thì bỏ: sau lần chạm thứ `keyMaxTouches` (vẫn dùng
   * được) key hết hạn. Nến chạm trong `keyTouchWindowMinutes` phút kể từ nến mở
   * lần chạm vẫn tính là cùng một lần. Đếm từ lúc key sinh ra.
   */
  keyMaxTouches: number;
  keyTouchWindowMinutes: number;
  keyTouchAtr: number;
  /** Cửa sổ trung vị volume cho nến chạm key và nến bóp cò (chỉ nhìn về trước). */
  touchVolumeLookback: number;
  touchVolumeSpikeMult: number;
  /**
   * Ngưỡng volume của NHÁNH 2. Cố ý thấp hơn hẳn `volumeSpikeMult`: nguồn chỉ
   * đòi cây nến đảo chiều nhỉnh hơn vài cây quanh nó, không đòi một cú đột biến
   * cỡ lúc sinh key.
   */
  reversalVolumeMult: number;
  /**
   * Ngưỡng của ba hình cụm đảo chiều (xem đầu file), đo bằng ATR của nến đảo
   * chiều. `vLegAtr`/`vLegBars`: mỗi chân của chữ V phải dài ít nhất chừng đó
   * ATR, và chân xuống tính trong `vLegBars` nến trước đáy.
   */
  vLegAtr: number;
  vLegBars: number;
  /** Râu dài: độ dài râu tối thiểu, tính bằng ATR. */
  pinWickAtr: number;
  /** Hai nến: thân mỗi nến tối thiểu (ATR) và phần thân nến đỏ phải lấy lại. */
  twoBodyAtr: number;
  twoRetrace: number;
  /**
   * Tín hiệu A chạy song song với cụm (xem đầu file). `rsiPeriod` là chu kỳ RSI
   * Wilder; `structureKeyAtr` là dung sai "ngay tại key" của hai đáy;
   * `divergencePriceTolAtr` là mức đáy 2 được phép CAO hơn đáy 1 mà vẫn tính là
   * hai đáy; `divergenceLookbackBars` là khoảng nhìn lại tìm đáy 1.
   */
  enableDivergenceSignal: boolean;
  /** Hai đỉnh (đáy) swing liền nhau tăng (giảm) dần sau nến đáy, trước khi vào. */
  requireSwingConfirmation: boolean;
  rsiPeriod: number;
  structureKeyAtr: number;
  divergencePriceTolAtr: number;
  divergenceLookbackBars: number;
  enableSweepBranch: boolean;
  enableVolumeReversalBranch: boolean;
  /**
   * NHÁNH 3 — trap qua key (xem đầu file). `keyTrapMaxBars`: giá được đóng bên
   * kia key tối đa bấy nhiêu nến, đếm từ nến phá. `keyTrapCloseAtr`: nến quay về
   * phải đóng cách key ít nhất chừng đó ATR mới tính.
   */
  enableKeyTrapBranch: boolean;
  keyTrapMaxBars: number;
  keyTrapCloseAtr: number;
  /**
   * NHÁNH 4 — đỉnh thấp dần (đáy cao dần) sau phản ứng tại key (xem đầu file).
   * `lowerHighPivotBars`: số nến mỗi bên của một đỉnh/đáy swing.
   * `lowerHighTouchBars`: đỉnh phản ứng phải có nến chạm key trong chừng ấy nến
   * tính tới chính nó.
   */
  enableLowerHighBranch: boolean;
  lowerHighPivotBars: number;
  lowerHighTouchBars: number;
  /**
   * Cửa sổ M15 của NHÁNH 1, dùng cho cả hai đầu: đỉnh/đáy bị quét, và cụm
   * thanh khoản đối diện làm mục tiêu. 480 nến = NĂM ngày.
   */
  sweepLookback: number;
  /**
   * Từ chính cây nến tạo ra cực trị của cửa sổ quét, đi NGƯỢC về trước bấy
   * nhiêu nến thì không nến nào được vượt qua mức đó. 96 nến = một ngày.
   * Ràng buộc chỉ ở phía TRÁI — phía phải nằm trong cửa sổ quét, nơi mức đó đã
   * là cực trị theo định nghĩa. Đặt 0 để tắt.
   */
  sweepProminenceBars: number;
  /**
   * Cú quét "chạy từ từ lại": nến thủng mức ĐÓNG ngoài mức, rồi giá được nằm
   * ngoài tối đa bấy nhiêu nến (tính cả nến thủng) trước khi một nến đóng trở
   * lại vào trong. 16 nến = 4 giờ. Đặt 0 thì chỉ còn kiểu rút râu trong một nến.
   */
  sweepMaxOutsideBars: number;
  /**
   * Nhánh quét vào lệnh lúc nào. `order-block` là luật ĐANG CHẠY: thấy rút râu
   * chưa vào; chờ một CỤM NẾN ĐẢO CHIỀU mà mũi nhọn là một nến SAU cú quét chạm
   * lại mức bị quét, rồi đặt LỆNH CHỜ ở mép thuận chiều của order block. Hai luật
   * cũ giữ để ablation: `reclaim-close` vào ngay ở giá ĐÓNG của nến rút râu / nến
   * đóng trở lại vào trong; `box-retest` lấy thân cây nến quét làm hộp rồi đi ba
   * bước, không cần cụm.
   */
  sweepEntry: KeyVolumeSweepEntry;
  /**
   * `order-block`: cụm phải xong trong bấy nhiêu nến kể từ nến đóng lại của cú
   * quét. 16 nến = 4 giờ. Giá vượt qua râu quét trước đó thì cú quét chết luôn.
   */
  sweepObWaitBars: number;
  /** `order-block`: lệnh chờ ở mép order block sống bấy nhiêu nến rồi huỷ. */
  obLimitBars: number;
  /** Số nến M15 NHÁNH 2 được phép chờ từ lúc chạm key tới mô hình nến. */
  sweepWaitBars: number;
  /**
   * Đường key phải nằm TRONG thân hộp order block của cụm đảo chiều. Cụm hình
   * thành gần key nhưng hộp nằm hẳn một bên KHÔNG tính: đảo chiều phải xảy ra
   * NGAY TẠI key chứ không phải quanh quẩn cạnh nó.
   */
  requireKeyInsideBlock: boolean;
  /**
   * "Quay về" phải có thật. Trong `keyDepartureLookback` nến TRƯỚC nến chạm
   * key, ít nhất một nến phải nằm CÁCH key hơn `keyDepartureAtr` × ATR. Không
   * có cửa này thì một đoạn đi ngang đè lên key đẻ ra cụm liên tục mà chẳng có
   * cú quay về nào. Đặt lookback 0 để tắt.
   */
  keyDepartureLookback: number;
  keyDepartureAtr: number;
  swingPivotLeft: number;
  swingPivotRight: number;
  stopBufferAtr: number;
  /** SL gần hơn tỉ lệ này của giá vào thì không vào (user 08/10/26: dưới 0,2%). */
  minStopPct: number;
  maxStopPct: number;
  minRR: number;
  targetMode: KeyVolumeTargetMode;
  /**
   * `true`: không có mục tiêu cấu trúc thì bỏ setup, không tự tạo TP 5R. Video
   * #10/#22 đặt TP theo vùng cản/volume quan trọng. Nhánh 1 đo tới cụm thanh
   * khoản đối diện, nhánh 2 đo tới key đối diện.
   */
  requireStructuralTarget: boolean;
  stopMode: KeyVolumeStopMode;
  /**
   * Số nến M15 phải nằm TRỌN ngoài hộp ngay sau khi dựng hộp. Không đủ thì bỏ
   * hộp. Lệnh chờ chỉ được đặt sau khi cửa này qua.
   */
  obDepartBars: number;
  obDepartMode: KeyVolumeDepartMode;
  /**
   * Số nến M15 một hộp được canh retest kể từ lúc trang bị, rồi hết hạn. MỘT
   * đồng hồ duy nhất cho cả hai bước quay-lại và bật-ra: giá quay lại rồi cũng
   * không được thêm giờ. 192 nến = HAI ngày.
   */
  boxWaitBars: number;
  finalTargetR: number;
  /**
   * Chốt một phần: giá đi được `partialAtR` R (râu chạm là đủ) thì chốt
   * `partialFraction` khối lượng và dời SL phần còn lại về đúng giá vào; phần còn
   * lại vẫn gồng tới mục tiêu. `partialFraction` 0 là tắt.
   */
  partialAtR: number;
  partialFraction: number;
  /**
   * Kênh dời stop "đúng cấu trúc của nó" (#23) và gồng phần còn lại. Bám swing
   * M15 siết chặt hơn phát biểu đó nên để mặc định tắt.
   */
  trailMode: "swing" | "none";
  cooldownBars: number;
  allowKeyReentry: boolean;
  reentryMode: KeyVolumeReentryMode;
  /** `#22`: "cái phát đầu tiên là không thể nào mà tray được". */
  requireSecondTouch: boolean;
  /** `#22`/`#23`: chờ mô hình hai đỉnh / hai đáy tại key. */
  requireDoubleTopBottom: boolean;
  doubleTolAtr: number;
  doubleLookbackBars: number;
  /** `Q&A 006`: ưu tiên phiên Mỹ. `null` = không lọc phiên. */
  sessionHoursUtc: [number, number] | null;
}

export const KEY_VOLUME_CONFIG: KeyVolumeParams = {
  confirmTf: "15m",
  // 12 nến quanh nến sự kiện = 6 trước + 6 sau.
  volumeLookback: 12,
  // ×4 thay vì ×2: ở ×2 máy dò ra 12,25 key/ngày/coin trong khi user vẽ tay
  // 0,10 — dày 122 lần, 2.247 key sống cùng lúc, và 93% điểm (thời gian, giá)
  // TUỲ Ý cũng "có key ở gần". ×4 kéo về 2,28 key/ngày và sàn nhiễu 59,2%.
  volumeSpikeMult: 4,
  // Luật "chín" của user: rời 1 ATR -> chạm lại -> đóng bật 1 ATR trong 6 nến,
  // đúng bộ số đã đo ở scripts/exp-key-reaction.ts.
  requireKeyMaturation: true,
  keyMatureAwayAtr: 1,
  keyMatureBounceAtr: 1,
  keyMatureBars: 6,
  keyHistoryDays: 90,
  // Chọn Key chỉ cần một nến volume đột biến. Lịch sử phản ứng là context để
  // trader chấm chất lượng, không phải điều kiện sinh Key tự động.
  minKeyReactions: 0,
  keyReactionAtr: 0.5,
  // User 04/10/26: key sống 15 ngày, tối đa 4 key cùng lúc, key mới chín đẩy
  // key cũ nhất ra. Ở 180 ngày không giới hạn, BTC có ~84 key chín sống cùng lúc.
  keyMaxAgeDays: 15,
  maxActiveKeys: 4,
  // User 08/10/26: chạm 7 lần thì bỏ key, mỗi lần chạm gộp trong 45 phút.
  keyMaxTouches: 7,
  keyTouchWindowMinutes: 45,
  keyTouchAtr: 0.2,
  touchVolumeLookback: 12,
  touchVolumeSpikeMult: 1,
  reversalVolumeMult: 1.2,
  // "Siêu nhọn": đo 250 ngày M15 (BTC/ETH/SOL/ADA) cho ~3,3 cụm/coin/ngày/chiều
  // (luật nhấn chìm cũ ~10), với V đóng góp ~2,0, râu dài ~0,7, hai nến ~0,6.
  vLegAtr: 2,
  vLegBars: 3,
  pinWickAtr: 1,
  twoBodyAtr: 0.8,
  twoRetrace: 0.7,
  // Tín hiệu A: dung sai tại key 0,5 ATR (gấp đôi dung sai chạm key), nhìn lại 96
  // nến (một ngày) tìm đáy 1. Dung sai giá 0: ở 0,5 ATR cũ, 38% tín hiệu có đáy 2
  // CAO hơn đáy 1 — giá và RSI cùng lên, tức không có phân kỳ nào.
  enableDivergenceSignal: true,
  requireSwingConfirmation: true,
  rsiPeriod: 14,
  structureKeyAtr: 0.5,
  divergencePriceTolAtr: 0,
  divergenceLookbackBars: 96,
  enableSweepBranch: true,
  enableVolumeReversalBranch: true,
  // User 03/10/26: phá qua key rồi quay về trong tối đa 16 nến (4 giờ), đóng dưới
  // (trên) key "một đoạn" thì vào. "Một đoạn" = 0,5 ATR: ví dụ BTC 23/09 nến 12:30
  // đóng sát key 0,2 giá chưa tính, nến 12:45 cách 1,09 ATR mới vào.
  enableKeyTrapBranch: true,
  keyTrapMaxBars: 16,
  keyTrapCloseAtr: 0.5,
  // User 04/10/26: chạm key, rồi chỉ cần MỘT đỉnh thấp hơn là đặt lệnh chờ ở mép
  // order block của đỉnh đó. Pivot 1/1 chứ không 2/2: ví dụ BTC 31/08 đỉnh thấp hơn
  // 00:45 có nến 00:15 cao hơn ở hai cây bên trái, pivot 2/2 bỏ lỡ nó.
  enableLowerHighBranch: true,
  lowerHighPivotBars: 1,
  lowerHighTouchBars: 4,
  // 5 ngày M15 = 480 nến; mức bị quét phải sạch 1 ngày (96 nến) về phía trước.
  sweepLookback: 480,
  sweepProminenceBars: 96,
  // User 03/10/26: thủng rồi "rút râu lại hoặc chạy từ từ lại", nằm ngoài tối đa 4 giờ.
  sweepMaxOutsideBars: 16,
  // User 03/10/26: thấy rút râu chưa vào vội; chờ order block có mũi nhọn chạm
  // lại mức bị quét trong 4 giờ, rồi vào ở mép order block.
  sweepEntry: "order-block",
  sweepObWaitBars: 16,
  obLimitBars: 16,
  sweepWaitBars: 4,
  // Cụm đảo chiều chỉ tính khi đường key chạy XUYÊN thân hộp của nó.
  requireKeyInsideBlock: true,
  // 20 nến M15 = 5 giờ nhìn lại; phải có nến cách key hơn 1 ATR mới gọi là đã rời.
  keyDepartureLookback: 20,
  keyDepartureAtr: 1,
  swingPivotLeft: 2,
  swingPivotRight: 2,
  stopBufferAtr: 0.15,
  minStopPct: 0.002,
  maxStopPct: 0.03,
  minRR: 3,
  targetMode: "nearest-structure",
  requireStructuralTarget: true,
  // Nhánh key: vào ở mép thuận chiều của order block thì thoát ngay ngoài mép
  // đối diện của CHÍNH hộp đó. Nhánh quét luôn đặt SL ngoài râu quét.
  stopMode: "order-block",
  // Giá phải rời hộp trọn 3 nến M15 rồi hộp mới được trang bị chờ retest.
  obDepartBars: 3,
  // Đo bằng GIÁ ĐÓNG: 3 nến sau khi dựng hộp đều phải đóng NGOÀI hộp, đúng
  // chiều lệnh. Râu được phép thò lại vào hộp.
  obDepartMode: "close",
  // 192 nến M15 = HAI ngày canh hộp rồi bỏ.
  boxWaitBars: 2 * 96,
  finalTargetR: 5,
  // User 03/10/26: chạy được 1R thì chốt 0,33 khối lượng, dời SL về entry, phần
  // còn lại gồng tới mục tiêu.
  partialAtR: 1,
  partialFraction: 0.33,
  trailMode: "none",
  // 4 nến M15 = 1 giờ, đúng cửa sổ cũ khi còn đếm bằng 12 nến M5.
  cooldownBars: 4,
  allowKeyReentry: true,
  reentryMode: "volume-retouch",
  // Hai luật dưới có nguồn rõ nhưng ablation cho thấy không cải thiện; bật được
  // qua tham số, không bật mặc định.
  requireSecondTouch: false,
  requireDoubleTopBottom: false,
  doubleTolAtr: 0.5,
  doubleLookbackBars: 40,
  sessionHoursUtc: null,
};

/**
 * Tham số theo mã. Vàng (XAUUSDT, XAUUSD) tạm CHƯA áp cận dưới SL 0,2% — user
 * 08/10/26 sẽ xem xét sau, vì ở vàng các lệnh SL hẹp mang R thuần dương.
 */
export function keyVolumeParamsFor(symbol: string, base: KeyVolumeParams = KEY_VOLUME_CONFIG): KeyVolumeParams {
  return /^XAU/i.test(symbol) ? { ...base, minStopPct: 0 } : base;
}

export interface KeyVolumeLevel {
  id: string;
  sourceTf: KeyVolumeSourceTf;
  price: number;
  zoneLow: number;
  zoneHigh: number;
  eventTime: number;
  /** Mốc nến CUỐI của cửa sổ có tâm đóng — trước mốc này key chưa biết được. */
  confirmedAt: number;
  /**
   * Mốc key bắt đầu DÙNG ĐƯỢC: lúc nến bật ra của chu trình chín đóng (không
   * sớm hơn `confirmedAt`). Bằng `confirmedAt` khi không đòi key chín.
   */
  maturedAt: number;
  expiresAt: number;
  volumeRatio: number;
}

export interface KeyVolumeEntryPlan {
  id: string;
  branch: KeyVolumeEntryBranch;
  direction: KeyVolumeDirection;
  /**
   * Index ENGINE của nến bắt đầu được vào lệnh. Hộp (nhánh key, nhánh quét
   * `box-retest`): nến đầu tiên sau cửa rời hộp, chỗ hộp được trang bị. Nhánh quét
   * `order-block`: nến ngay sau cụm, cây đầu tiên lệnh chờ ở mép hộp khớp được.
   * Nhánh quét `reclaim-close`: chính nến đóng lại — vào ở giá ĐÓNG của nó.
   */
  readyIndex: number;
  /**
   * `openTime` của nến BÓP CÒ (nến cuối của cụm). Dùng MỐC THỜI GIAN chứ không
   * dùng `readyIndex` vì `runKeyVolume` lọc bỏ nến lỗi trước khi chạy, nên index
   * của engine không đảm bảo trùng index của mảng nến mà chart đang giữ.
   */
  triggerTime: number;
  /** `null` ở nhánh quét: nhánh đó không dùng key ở bất kỳ khâu nào. */
  key: KeyVolumeLevel | null;
  /** `null` ở nhánh quét, hoặc khi cửa "đã rời key" bị tắt nên không biết phía về. */
  approach: KeyVolumeApproach | null;
  /**
   * Index ENGINE của nến đáy (mũi nhọn) — mốc bắt đầu đếm hai swing xác nhận.
   * Nhánh quét `order-block`: nến sau cú quét chạm lại mức bị quét; luật cũ: cây có
   * râu xa nhất của cú quét. Chỉ engine dùng, giống `readyIndex`.
   */
  tipIndex: number;
  /**
   * Số nến từ nến ĐẦU của hộp tới nến bóp cò, tính cả hai đầu: 2 hoặc 3 nến hộp
   * cộng thêm các nến từ đáy tới nến đảo chiều; hoặc 1 ở nhánh quét luật cũ
   * (chính cây nến quét). Chart dùng nó để vẽ hộp bắt đầu từ đúng nến đầu tiên.
   */
  clusterBars: number;
  /**
   * Cách đã bóp cò: ba hình cụm mũi nhọn hoặc tín hiệu A; `null` ở nhánh quét
   * luật cũ (`reclaim-close`, `box-retest`) vì luật đó không có cụm.
   */
  clusterShape: KeyVolumeTriggerShape | null;
  /** Hai đáy/đỉnh và RSI của chúng khi bóp cò bằng tín hiệu A; còn lại `null`. */
  divergence: RsiDivergenceFacts | null;
  /** Mép THÂN NẾN dưới của cả cụm — min(open, close), râu không tính. */
  obLow: number;
  /** Mép THÂN NẾN trên của cả cụm — max(open, close), râu không tính. */
  obHigh: number;
  /**
   * Mép THUẬN CHIỀU của hộp: `obHigh` với long, `obLow` với short. Nhánh quét
   * `order-block` đặt LỆNH CHỜ ở đúng mức này. Các luật còn lại vào ở giá ĐÓNG của
   * nến bật ra khỏi hộp; với chúng mép này chỉ để chart/journal vẽ.
   */
  obEntryEdge: number;
  /**
   * Gốc của SL. Nhánh quét: điểm XA NHẤT giá đi ngoài mức bị quét, từ nến thủng
   * tới nến đóng lại (kiểu rút râu: chính cái râu). Nhánh 2: cực trị cửa sổ
   * chạm key -> nến bóp cò.
   */
  structuralStop: number;
  /** Cực trị nến bóp cò — cơ sở cho SL "ngay sau mô hình". */
  patternStop: number;
  /**
   * Cụm thanh khoản ĐỐI DIỆN của nhánh quét: đỉnh/đáy đúng cửa sổ
   * `sweepLookback` ở phía bên kia. `null` ở nhánh 2 (nhánh đó đo tới key).
   */
  sweepTarget: number | null;
  /**
   * `openTime` của nến ĐẦU TIÊN thủng mức. Mức bị quét là đỉnh/đáy của
   * `sweepLookback` nến ngay trước nến này. Bằng `triggerTime` khi giá rút râu
   * ngay trong một nến; sớm hơn khi giá "chạy từ từ lại". Nhánh trap: nến đầu
   * tiên ĐÓNG qua key. `null` ở nhánh 2.
   */
  sweepBreakTime: number | null;
  /** Nhánh 4: `openTime` của đỉnh (đáy) liền trước — gốc của SL. */
  priorExtremeTime?: number;
  triggerVolumeRatio: number;
  score: number;
}

export type KeyVolumeExitReason =
  | "stop"
  | "positive-stop"
  | "target"
  | "entry-invalid"
  /** Chưa thoát. Chỉ có ở `openTrade`: giá "thoát" là giá đóng nến cuối, R tạm tính. */
  | "open";

export interface KeyVolumeTrade {
  symbol: string;
  /**
   * Id của `KeyVolumeEntryPlan` sinh ra lệnh này. Có trường này thì chart/journal
   * chỉ cần TRA CỨU chứ không phải dựng lại bộ lọc của cây entry — dựng lại luôn
   * sai kể từ luật order block, vì giá vào là giá ĐÓNG của nến retest xác nhận
   * nên bar vào lệnh luôn muộn hơn `plan.readyIndex`.
   */
  planId: string;
  dir: KeyVolumeDirection;
  branch: KeyVolumeEntryBranch;
  approach: KeyVolumeApproach | null;
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  target: number;
  exitTime: number;
  exitPrice: number;
  exitReason: KeyVolumeExitReason;
  grossR: number;
  costR: number;
  netR: number;
  /** Số nến M15 đã giữ lệnh. */
  holdBars: number;
  /**
   * Mốc nến quay lại hộp (bước 2) và mức lãi CAO NHẤT từng chạm, tính bằng R.
   * Hai số này KHÔNG tham gia luật nào — chỉ để tầng UI kể lại chuyện đã xảy ra
   * mà không phải dựng lại bộ lọc của engine.
   */
  retouchTime: number | null;
  maxFavorableR: number;
  partialTaken: boolean;
  /** `null` khi lệnh đến từ nhánh quét — nhánh đó không có key. */
  keyPrice: number | null;
  keyVolumeRatio: number | null;
  triggerVolumeRatio: number;
}

export interface KeyVolumeDiagnostics {
  /** Key dò được từ volume, TRƯỚC luật chín. */
  m15Levels: number;
  /** Key đã chín — chỉ chúng được chạm, làm mục tiêu và làm vật cản dư địa. */
  keysMatured: number;
  keyTouches: number;
  touchVolumeConfirmed: number;
  /** Số nến quét-và-giành-lại phát hiện được, kể cả nến quét cả hai đầu. */
  sweeps: number;
  /** Trong số đó, bao nhiêu cú "chạy từ từ lại" (nến thủng đóng ngoài mức). */
  sweepsSlow: number;
  /**
   * Tín hiệu bóp cò HỢP LỆ của nhánh key: cụm đã qua cửa "key trong hộp" và volume,
   * hoặc một tín hiệu cấu trúc.
   */
  candlePatterns: number;
  /** Trong số `candlePatterns`, bao nhiêu là tín hiệu A (hai đáy/đỉnh + RSI phân kỳ). */
  structureSignals: number;
  /** Lượt nến bật ra khỏi hộp nhánh key bị gạt vì chưa có hai swing xác nhận. */
  rejectedNoStructure: number;
  /** Cụm dựng được nhưng đường key nằm NGOÀI thân hộp -> bỏ. */
  rejectedKeyOutsideBlock: number;
  /** Nến chạm key hợp lệ nhưng trước đó giá chưa từng RỜI key -> không mở setup. */
  rejectedNoDeparture: number;
  plans: number;
  sweepBranchPlans: number;
  volumeBranchPlans: number;
  /** Trap qua key đã quay về đủ xa trong hạn — mỗi cái là một ứng viên vào ngay. */
  keyTrapPlans: number;
  /** Đỉnh thấp hơn (đáy cao hơn) sau phản ứng tại key — mỗi cái là một lệnh chờ ở mép OB. */
  lowerHighPlans: number;
  entries: number;
  /** Hộp dựng được nhưng giá không rời hộp đủ `obDepartBars` nến -> bỏ. */
  rejectedDepart: number;
  /** Số hộp được TRANG BỊ chờ retest (đã qua cửa rời hộp, đang canh giá về). */
  boxesArmed: number;
  /** Trong số đó, bao nhiêu hộp thấy giá QUAY LẠI chạm hộp ít nhất một lần. */
  boxesRetouched: number;
  /** Hộp chết trước khi vào lệnh: giá ĐÓNG xuyên hộp ngược chiều, hoặc key bị phá. */
  boxesBroken: number;
  /** Hộp hết `boxWaitBars` nến mà chưa vào được lệnh -> bỏ. */
  boxesExpired: number;
  /** Hộp còn sống nhưng hết dữ liệu — không kết luận được. */
  boxesUnresolved: number;
  /**
   * Lệnh chờ ở mép order block (nhánh quét `order-block` và nhánh 4). Phân hoạch: khớp
   * thành lệnh + bị loại ở cửa risk/dư địa lúc khớp + hết hạn + còn treo lúc hết dữ liệu.
   */
  limitsPlaced: number;
  limitsExpired: number;
  limitsUnresolved: number;
  rejectedRisk: number;
  rejectedRoom: number;
  rejectedFirstTouch: number;
  rejectedDouble: number;
  rejectedSession: number;
}

export interface KeyVolumeResult {
  trades: KeyVolumeTrade[];
  /**
   * Vị thế còn mở lúc hết dữ liệu, chấm theo giá đóng nến cuối. Tách khỏi `trades`
   * để mọi phép đếm/cộng R của backtest chỉ thấy lệnh đã đóng; engine giữ một vị
   * thế mỗi lúc, nên lệnh này là thứ đang chặn mọi setup phía sau nó.
   */
  openTrade: KeyVolumeTrade | null;
  plans: KeyVolumeEntryPlan[];
  levels: KeyVolumeLevel[];
  diagnostics: KeyVolumeDiagnostics;
}

interface KeyTouchSetup {
  direction: KeyVolumeDirection;
  key: KeyVolumeLevel;
  touchIndex: number;
  approach: KeyVolumeApproach | null;
}

/**
 * Hộp order block đã qua cửa rời hộp và đang CANH GIÁ QUAY LẠI. Không còn lệnh
 * chờ nào nằm sẵn trên sổ: giá vào chỉ được biết ở GIÁ ĐÓNG của nến xác nhận,
 * nên mọi cửa (risk, dư địa, mục tiêu) cũng chỉ chấm được ở đúng nến đó.
 *
 * Hộp chết theo ba cách: giá ĐÓNG xuyên qua hộp ngược chiều lệnh (long:
 * `close < obLow`), key của nó bị phá, hoặc hết `boxWaitBars` nến canh.
 */
interface ArmedBox {
  plan: KeyVolumeEntryPlan;
  /** Giá đã quay lại chạm hộp ít nhất một nến kể từ lúc trang bị. */
  retouched: boolean;
  /** Nến ĐẦU TIÊN chạm lại hộp. Chỉ để kể lại, không tham gia luật nào. */
  retouchIndex: number | null;
  /** Index nến ĐẦU TIÊN mà hộp đã hết hạn (không còn vào lệnh được). */
  expiresAtIndex: number;
}

interface OpenPosition {
  plan: KeyVolumeEntryPlan;
  entryIndex: number;
  /** Nến quay lại hộp của bước 2, mang theo từ `ArmedBox` để kể lại. */
  retouchIndex: number | null;
  entry: number;
  initialStop: number;
  stop: number;
  target: number;
  risk: number;
  partialPrice: number;
  partialR: number;
  remaining: number;
  realizedR: number;
  partialIndex?: number;
  maxFavorable: number;
}

const FUNDING_INTERVAL_MS = 8 * TF_MS["1h"];

function quoteVolume(candle: Candle): number {
  return candle.quoteVolume != null && candle.quoteVolume > 0
    ? candle.quoteVolume
    : candle.volume * candle.close;
}

function rangeMax(candles: Candle[], start: number, endExclusive: number, field: "high" | "close"): number {
  let value = -Infinity;
  for (let i = start; i < endExclusive; i++) value = Math.max(value, candles[i][field]);
  return value;
}

function rangeMin(candles: Candle[], start: number, endExclusive: number, field: "low" | "close"): number {
  let value = Infinity;
  for (let i = start; i < endExclusive; i++) value = Math.min(value, candles[i][field]);
  return value;
}

/** Index của cây tạo ra cực trị trong `[start, endExclusive)`; hoà thì lấy cây SỚM nhất. */
function rangeExtremeIndex(
  candles: Candle[],
  start: number,
  endExclusive: number,
  field: "high" | "low",
): number {
  let best = start;
  for (let i = start + 1; i < endExclusive; i++) {
    const better = field === "high"
      ? candles[i].high > candles[best].high
      : candles[i].low < candles[best].low;
    if (better) best = i;
  }
  return best;
}

function median(sample: number[]): number {
  if (!sample.length) return 0;
  const sorted = [...sample].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Trung vị của `lookback` giá trị NGAY TRƯỚC `endExclusive`. Không nhìn trước. */
export function medianPrior(values: number[], endExclusive: number, lookback: number): number {
  const start = endExclusive - lookback;
  if (start < 0 || lookback <= 0) return 0;
  return median(values.slice(start, endExclusive));
}

/**
 * Trung vị của `lookback` giá trị XUNG QUANH `index`, chia đều hai bên và BỎ
 * chính nó. Đây là cách mắt người chấm một cây volume trên chart, và cũng là lý
 * do key phải chờ nến cuối cửa sổ đóng mới được coi là biết được.
 */
export function medianAround(values: number[], index: number, lookback: number): number {
  const half = Math.floor(lookback / 2);
  if (half < 1 || index - half < 0 || index + half >= values.length) return 0;
  return median([
    ...values.slice(index - half, index),
    ...values.slice(index + 1, index + half + 1),
  ]);
}

export function atrSeriesForward(candles: Candle[], period = 20): number[] {
  const out = Array<number>(candles.length).fill(0);
  let smoothed = 0;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const previousClose = i > 0 ? candles[i - 1].close : candle.open;
    const tr = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    if (i < period) {
      smoothed += tr;
      out[i] = smoothed / (i + 1);
      if (i === period - 1) smoothed = out[i];
    } else {
      smoothed = (smoothed * (period - 1) + tr) / period;
      out[i] = smoothed;
    }
  }
  return out;
}

/**
 * Key = nến volume đột biến so với các nến XUNG QUANH. Key trung tính: vai đỡ
 * hay cản do vị trí giá lúc chạm quyết định, không gán sẵn lúc sinh.
 *
 * Key là MỘT ĐƯỜNG THẲNG tại giá MỞ CỬA của cây nến đó. `zoneLow`/`zoneHigh`
 * vẫn còn để chart và journal đọc được, nhưng cả hai bằng đúng `price` — dung
 * sai chạm giờ hoàn toàn do `keyTouchAtr` quyết định, không còn cộng thêm biên
 * độ ngẫu nhiên của cây nến sinh key.
 *
 * `confirmedAt` là lúc nến CUỐI của cửa sổ có tâm đóng. Mọi nơi tra key đều đi
 * qua `isKeyVolumeLevelActive`, nên nửa sau cửa sổ không rò vào quá khứ.
 */
export function detectKeyVolumeLevels(
  candles: Candle[],
  sourceTf: KeyVolumeSourceTf,
  params: KeyVolumeParams = KEY_VOLUME_CONFIG,
): KeyVolumeLevel[] {
  const tfMs = TF_MS[sourceTf];
  const half = Math.floor(params.volumeLookback / 2);
  if (half < 1) return [];
  const volumes = candles.map(quoteVolume);
  const atr = atrSeriesForward(candles);
  const swings = findSwings(candles, params.swingPivotLeft, params.swingPivotRight);
  const historyBars = Math.ceil(params.keyHistoryDays * TF_MS["1d"] / tfMs);
  const levels: KeyVolumeLevel[] = [];

  for (let event = half; event + half < candles.length; event++) {
    const baseline = medianAround(volumes, event, params.volumeLookback);
    if (!(baseline > 0)) continue;
    const volumeRatio = volumes[event] / baseline;
    if (volumeRatio < params.volumeSpikeMult || !(atr[event] > 0)) continue;

    const price = candles[event].open;
    const historicalReactions = swings.filter((swing) =>
      swing.index < event
      && swing.index >= event - historyBars
      && swing.confirmIndex <= event
      && Math.abs(swing.price - price) <= params.keyReactionAtr * atr[event],
    ).length;
    if (historicalReactions < params.minKeyReactions) continue;

    const confirmedAt = candles[event + half].openTime + tfMs;
    levels.push({
      id: `${sourceTf}:${candles[event].openTime}`,
      sourceTf,
      price,
      zoneLow: price,
      zoneHigh: price,
      eventTime: candles[event].openTime,
      confirmedAt,
      maturedAt: confirmedAt,
      expiresAt: confirmedAt + params.keyMaxAgeDays * TF_MS["1d"],
      volumeRatio,
    });
  }
  return levels;
}

/**
 * Luật CHÍN: chỉ giữ key đã đi trọn RỜI -> CHẠM LẠI -> BẬT RA trước khi hết
 * hạn, và gắn `maturedAt` = lúc nến bật ra đóng (không sớm hơn `confirmedAt`).
 *
 * Chu trình chạy từ nến ngay sau nến sinh key. Phần trước `confirmedAt` vẫn
 * được dùng vì tới `confirmedAt` nó đã là quá khứ; chỉ mốc dùng được mới bị
 * kéo về sau `confirmedAt`, nên không nhìn trước.
 *   1. RỜI — nến đầu tiên nằm trọn ngoài dải ±`keyMatureAwayAtr` ATR, nhớ phía.
 *   2. CHẠM LẠI — nến chạm key (dung sai `keyTouchAtr`). Giá ĐÓNG sang phía kia
 *      trước khi chạm thì key chết.
 *   3. BẬT RA — trong `keyMatureBars` nến sau nến chạm, một nến ĐÓNG cách key >=
 *      `keyMatureBounceAtr` ATR về đúng phía đã rời. Đóng xuyên sang phía kia,
 *      hoặc hết số nến mà chưa bật, thì key chết.
 */
export function matureKeyLevels(
  candles: Candle[],
  levels: KeyVolumeLevel[],
  params: Pick<
    KeyVolumeParams,
    "confirmTf" | "keyMatureAwayAtr" | "keyMatureBounceAtr" | "keyMatureBars" | "keyTouchAtr"
  >,
): KeyVolumeLevel[] {
  const atr = atrSeriesForward(candles);
  const indexOf = new Map<number, number>();
  candles.forEach((candle, i) => indexOf.set(candle.openTime, i));
  const tfMs = TF_MS[params.confirmTf];
  const matured: KeyVolumeLevel[] = [];

  for (const level of levels) {
    const event = indexOf.get(level.eventTime);
    if (event == null) continue;
    const price = level.price;
    let side = 0;
    let touched = -1;
    for (let i = event + 1; i < candles.length; i++) {
      const candle = candles[i];
      if (candle.openTime > level.expiresAt) break;
      const a = atr[i];
      if (!(a > 0)) continue;
      if (side === 0) {
        if (candle.low > price + params.keyMatureAwayAtr * a) side = 1;
        else if (candle.high < price - params.keyMatureAwayAtr * a) side = -1;
        continue;
      }
      if (touched < 0) {
        const tolerance = params.keyTouchAtr * a;
        if (candle.low <= price + tolerance && candle.high >= price - tolerance) touched = i;
        else if (side === 1 ? candle.close < price : candle.close > price) break;
        continue;
      }
      if (i - touched > params.keyMatureBars) break;
      if (side === 1 ? candle.close < price : candle.close > price) break;
      const bounced = side === 1
        ? candle.close > price + params.keyMatureBounceAtr * a
        : candle.close < price - params.keyMatureBounceAtr * a;
      if (bounced) {
        matured.push({ ...level, maturedAt: Math.max(level.confirmedAt, candle.openTime + tfMs) });
        break;
      }
    }
  }
  return matured;
}

/**
 * Giới hạn `maxActive` key sống cùng lúc theo kiểu vào trước ra trước: duyệt
 * theo `maturedAt`, key mới chín khi đã đủ chỗ thì kéo `expiresAt` của key chín
 * sớm nhất còn sống về ngay trước mốc đó. Chỉ dùng mốc đã qua nên không nhìn trước.
 */
export function capActiveKeyLevels(levels: KeyVolumeLevel[], maxActive: number): KeyVolumeLevel[] {
  const ordered = levels
    .map((level) => ({ ...level }))
    .sort((a, b) => a.maturedAt - b.maturedAt || a.eventTime - b.eventTime);
  let alive: KeyVolumeLevel[] = [];
  for (const level of ordered) {
    alive = alive.filter((other) => other.expiresAt >= level.maturedAt);
    if (alive.length >= maxActive) {
      const evicted = alive.shift()!;
      evicted.expiresAt = level.maturedAt - 1;
    }
    alive.push(level);
  }
  return ordered;
}

/**
 * Luật CHẠM QUÁ NHIỀU (user 08/10/26): đếm từ nến ngay sau nến sinh key. Nến chạm
 * key (dung sai `keyTouchAtr`) mở một LẦN CHẠM; mọi nến trong `keyTouchWindowMinutes`
 * phút kể từ đó thuộc lần ấy. Key sống trọn cửa sổ của lần chạm thứ `keyMaxTouches`
 * — lần đó vẫn vào lệnh được — rồi hết hạn. Chạm trước `confirmedAt` vẫn tính vì
 * tới lúc key biết được thì chúng đã là quá khứ; hạn mới chỉ có hiệu lực sau khi
 * cửa sổ lần chạm cuối đã qua, nên không nhìn trước.
 */
export function limitKeyTouches(
  candles: Candle[],
  levels: KeyVolumeLevel[],
  params: Pick<KeyVolumeParams, "keyTouchAtr" | "keyMaxTouches" | "keyTouchWindowMinutes">,
): KeyVolumeLevel[] {
  const atr = atrSeriesForward(candles);
  const indexOf = new Map<number, number>();
  candles.forEach((candle, i) => indexOf.set(candle.openTime, i));
  const windowMs = params.keyTouchWindowMinutes * 60_000;

  return levels.map((level) => {
    const event = indexOf.get(level.eventTime);
    if (event == null) return level;
    let touches = 0;
    let windowEnd = -Infinity;
    for (let i = event + 1; i < candles.length; i++) {
      const candle = candles[i];
      if (candle.openTime > level.expiresAt) break;
      if (candle.openTime < windowEnd || !(atr[i] > 0)) continue;
      if (!touchesLevel(candle, level, params.keyTouchAtr * atr[i])) continue;
      touches++;
      windowEnd = candle.openTime + windowMs;
      if (touches >= params.keyMaxTouches) {
        return { ...level, expiresAt: Math.min(level.expiresAt, windowEnd - 1) };
      }
    }
    return level;
  });
}

export function isKeyVolumeLevelActive(level: KeyVolumeLevel, time: number): boolean {
  return level.maturedAt <= time && time <= level.expiresAt;
}

function touchesLevel(candle: Candle, level: KeyVolumeLevel, tolerance: number): boolean {
  return candle.low <= level.zoneHigh + tolerance && candle.high >= level.zoneLow - tolerance;
}

/**
 * "Nến đang ở TRÊN key thì long, ở dưới thì short": key là đỡ khi giá đứng trên
 * nó và là cản khi giá nằm dưới. Mốc so sánh là giữa vùng key, không phải một
 * biên — dùng biên sẽ để trống hẳn trường hợp nến đóng bên trong vùng.
 */
export function directionAgainstKey(close: number, level: KeyVolumeLevel): KeyVolumeDirection {
  return close >= (level.zoneLow + level.zoneHigh) / 2 ? "long" : "short";
}

function selectKeyTouch(
  candle: Candle,
  time: number,
  atr: number,
  levels: KeyVolumeLevel[],
  used: Set<string>,
  params: KeyVolumeParams,
): { key: KeyVolumeLevel; direction: KeyVolumeDirection } | null {
  const touchTolerance = params.keyTouchAtr * atr;
  let best: KeyVolumeLevel | null = null;
  for (const key of levels) {
    if (used.has(key.id) || !isKeyVolumeLevelActive(key, time)) continue;
    if (!touchesLevel(candle, key, touchTolerance)) continue;
    if (!best || key.volumeRatio > best.volumeRatio) best = key;
  }
  return best ? { key: best, direction: directionAgainstKey(candle.close, best) } : null;
}

/**
 * ORDER BLOCK = hộp THÂN NẾN bao trọn `bars` nến kết thúc ở `endIndex`, RÂU
 * KHÔNG TÍNH:
 *   obHigh = max(open, close) của mọi nến trong khoảng
 *   obLow  = min(open, close) của mọi nến trong khoảng
 *
 * Bỏ râu làm hộp hẹp lại nên R nhỏ hơn, đổi lại SL nằm TRONG vùng râu đã từng
 * bị chạm — đây là đánh đổi đã biết của luật này, không phải sơ suất.
 */
export function orderBlockFromCluster(
  candles: Candle[],
  endIndex: number,
  bars: number,
): { obLow: number; obHigh: number } {
  const start = Math.max(0, endIndex - Math.max(1, bars) + 1);
  let obLow = Infinity;
  let obHigh = -Infinity;
  for (let i = start; i <= endIndex; i++) {
    obLow = Math.min(obLow, candles[i].open, candles[i].close);
    obHigh = Math.max(obHigh, candles[i].open, candles[i].close);
  }
  return { obLow, obHigh };
}

/**
 * CỤM NẾN ĐẢO CHIỀU + ORDER BLOCK: một MŨI NHỌN, giá lao nhanh rồi bật ngược
 * lại. Ba hình (V, hai nến, râu dài), mô tả đầy đủ ở đầu file. Hình khớp trước
 * theo thứ tự đó quyết định nến ĐÁY; hộp là thân các nến kết thúc ở nến đáy.
 *
 * Mọi so sánh chạy trên bản "LONG hoá" của nến (SHORT lật dấu giá) nên chỉ viết
 * một lần cho cả hai chiều; mép hộp được lật lại về giá thật ở cuối hàm.
 */
export type ReversalShape = "v-spike" | "two-candle" | "long-wick";
/** Mọi cách bóp cò của nhánh key: ba hình cụm mũi nhọn và tín hiệu A. */
export type KeyVolumeTriggerShape = ReversalShape | "rsi-divergence";

/** Hai đáy (hoặc đỉnh) và RSI của chúng ở tín hiệu A, để chart kể lại được. */
export interface RsiDivergenceFacts {
  firstTime: number;
  firstPrice: number;
  firstRsi: number;
  secondTime: number;
  secondPrice: number;
  secondRsi: number;
}

export interface ReversalOrderBlock {
  obLow: number;
  obHigh: number;
  shape: KeyVolumeTriggerShape;
  /** Index nến ĐÁY (mũi nhọn): nến cuối cùng của hộp. */
  tipIndex: number;
  /** Số nến cấu thành hộp: 2, hoặc 3 khi nến thứ 3 chồng lên vùng thân. */
  boxBars: number;
  /** Số nến từ nến đầu của hộp tới nến đảo chiều, tính cả hai đầu. */
  clusterBars: number;
  /** Chỉ có ở tín hiệu A (`rsi-divergence`). */
  divergence?: RsiDivergenceFacts;
}

/** Râu dài chiếm tối thiểu bấy nhiêu biên độ nến, và giá đóng phải trong 1/3 trên. */
const LONG_WICK_RANGE_FRACTION = 0.6;
const LONG_WICK_CLOSE_FRACTION = 2 / 3;

/** Nến ở góc nhìn LONG: SHORT lật dấu giá nên đỉnh thành đáy và ngược lại. */
function longView(candle: Candle, direction: KeyVolumeDirection): {
  open: number; high: number; low: number; close: number;
} {
  return direction === "long"
    ? { open: candle.open, high: candle.high, low: candle.low, close: candle.close }
    : { open: -candle.open, high: -candle.low, low: -candle.high, close: -candle.close };
}

export function reversalOrderBlock(
  candles: Candle[],
  index: number,
  direction: KeyVolumeDirection,
  atr: number,
  params: Pick<
    KeyVolumeParams,
    "vLegAtr" | "vLegBars" | "pinWickAtr" | "twoBodyAtr" | "twoRetrace"
  > = KEY_VOLUME_CONFIG,
): ReversalOrderBlock | null {
  if (index < 2 || !(atr > 0)) return null;
  const at = (j: number) => longView(candles[j], direction);
  const trigger = at(index);
  const bullish = trigger.close > trigger.open;

  let shape: ReversalShape | null = null;
  let tip = index;

  // ── V: lao xuống rồi lao lên, đáy nằm trong `vLegBars` nến trước nến đảo chiều.
  if (bullish) {
    let candidate = index - 1;
    for (let j = index - 2; j >= Math.max(0, index - params.vLegBars); j--) {
      if (at(j).low < at(candidate).low) candidate = j;
    }
    const bottom = at(candidate).low;
    let top = -Infinity;
    for (let j = Math.max(0, candidate - params.vLegBars); j < candidate; j++) {
      top = Math.max(top, at(j).high);
    }
    if (
      bottom <= trigger.low
      && top - bottom >= params.vLegAtr * atr
      && trigger.close - bottom >= params.vLegAtr * atr
    ) {
      shape = "v-spike";
      tip = candidate;
    }
  }

  // ── Hai nến: nến đỏ thân dài, ngay sau là nến xanh thân dài lấy lại gần hết.
  if (!shape && bullish) {
    const previous = at(index - 1);
    const downBody = previous.open - previous.close;
    const upBody = trigger.close - trigger.open;
    if (
      downBody >= params.twoBodyAtr * atr
      && upBody >= params.twoBodyAtr * atr
      && (trigger.close - previous.close) / downBody >= params.twoRetrace
    ) {
      shape = "two-candle";
      tip = trigger.low < previous.low ? index : index - 1;
    }
  }

  // ── Râu dài: một nến đâm râu rất sâu rồi bị kéo ngược lại. Không đòi đúng màu.
  if (!shape) {
    const range = trigger.high - trigger.low;
    const wick = Math.min(trigger.open, trigger.close) - trigger.low;
    if (
      range > 0
      && wick >= LONG_WICK_RANGE_FRACTION * range
      && wick >= params.pinWickAtr * atr
      && trigger.close - trigger.low >= LONG_WICK_CLOSE_FRACTION * range
    ) {
      shape = "long-wick";
      tip = index;
    }
  }

  if (!shape || tip < 1) return null;

  const block = blockEndingAt(candles, tip, direction);
  return {
    obLow: block.obLow,
    obHigh: block.obHigh,
    shape,
    tipIndex: tip,
    boxBars: block.boxBars,
    clusterBars: index - (tip - (block.boxBars - 1)) + 1,
  };
}

/**
 * Hộp order block của một mũi nhọn: THÂN của 2 nến kết thúc ở nến đáy `tip`, thêm
 * nến thứ 3 nếu thân nó chồng lên vùng thân của 2 nến kia (giá đang tích luỹ).
 * Râu không tính. Trả về GIÁ THẬT, không phải góc nhìn LONG. Dùng chung cho cụm
 * và hai tín hiệu cấu trúc để cả ba dựng hộp đúng một kiểu.
 */
function blockEndingAt(
  candles: Candle[],
  tip: number,
  direction: KeyVolumeDirection,
): { obLow: number; obHigh: number; boxBars: number } {
  let boxLow = Infinity;
  let boxHigh = -Infinity;
  for (const j of [tip - 1, tip]) {
    const bar = longView(candles[j], direction);
    boxLow = Math.min(boxLow, bar.open, bar.close);
    boxHigh = Math.max(boxHigh, bar.open, bar.close);
  }
  let boxBars = 2;
  if (tip >= 2) {
    const third = longView(candles[tip - 2], direction);
    if (Math.min(third.open, third.close) <= boxHigh && Math.max(third.open, third.close) >= boxLow) {
      boxLow = Math.min(boxLow, third.open, third.close);
      boxHigh = Math.max(boxHigh, third.open, third.close);
      boxBars = 3;
    }
  }
  return {
    obLow: direction === "long" ? boxLow : -boxHigh,
    obHigh: direction === "long" ? boxHigh : -boxLow,
    boxBars,
  };
}

/**
 * RSI Wilder (làm mượt RMA) giống mặc định của TradingView. `NaN` ở `period` nến
 * đầu. Giá trị tại `i` chỉ dùng nến <= `i` nên không nhìn trước. Chuỗi hội tụ về
 * giá trị TradingView sau khoảng 100 nến đầu — cần nạp dư nến lịch sử.
 */
export function rsiSeries(candles: Candle[], period = 14): number[] {
  const out = Array<number>(candles.length).fill(NaN);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i < period) continue;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    out[i] = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * TÍN HIỆU A — hai đáy (LONG) hoặc hai đỉnh (SHORT) tại key + RSI phân kỳ, xét
 * tại nến `index` của một setup đã chạm key ở `touchIndex`.
 *
 * Đáy 2 phải là swing ĐÃ XÁC NHẬN ở `index` (`confirmIndex <= index`) nên không
 * nhìn trước; vì pivot cần 2 nến bên phải, tín hiệu chỉ bật sau đáy 2 hai nến.
 * Trả về `null` khi không đủ điều kiện, còn không thì hộp dựng ở nến đáy 2.
 */
export function rsiDivergenceAtKey(
  candles: Candle[],
  swings: Swing[],
  rsi: number[],
  atr: number,
  index: number,
  touchIndex: number,
  direction: KeyVolumeDirection,
  keyPrice: number,
  params: Pick<KeyVolumeParams, "structureKeyAtr" | "divergencePriceTolAtr" | "divergenceLookbackBars">,
): ReversalOrderBlock | null {
  if (!(atr > 0)) return null;
  const long = direction === "long";
  const type = long ? "low" : "high";
  const nearKey = (price: number) => Math.abs(price - keyPrice) <= params.structureKeyAtr * atr;
  const known = swings
    .filter((swing) => swing.type === type && swing.confirmIndex <= index && nearKey(swing.price))
    .sort((a, b) => b.index - a.index);

  const second = known.find((swing) => swing.index >= touchIndex - 1);
  if (!second || second.index < 1) return null;
  const secondRsi = rsi[second.index];
  if (!Number.isFinite(secondRsi)) return null;

  // Đáy 1 là swing tại key LIỀN TRƯỚC đáy 2. Lấy nó rồi mới chấm điều kiện — dò
  // ngược tìm bất kỳ đáy nào cho ra phân kỳ là thử nhiều lần tới khi trúng.
  const priceTol = params.divergencePriceTolAtr * atr;
  const first = known.find((swing) =>
    swing.index <= second.index - 3
    && swing.index >= second.index - params.divergenceLookbackBars);
  if (
    !first
    || !(long ? second.price <= first.price + priceTol : second.price >= first.price - priceTol)
    || !Number.isFinite(rsi[first.index])
    || !(long ? secondRsi > rsi[first.index] : secondRsi < rsi[first.index])
  ) return null;

  const block = blockEndingAt(candles, second.index, direction);
  return {
    obLow: block.obLow,
    obHigh: block.obHigh,
    shape: "rsi-divergence",
    tipIndex: second.index,
    boxBars: block.boxBars,
    clusterBars: index - (second.index - (block.boxBars - 1)) + 1,
    divergence: {
      firstTime: candles[first.index].openTime,
      firstPrice: first.price,
      firstRsi: rsi[first.index],
      secondTime: candles[second.index].openTime,
      secondPrice: second.price,
      secondRsi,
    },
  };
}

/**
 * XÁC NHẬN CẤU TRÚC — "hai higher high / lower low trên M15 rồi mới entry" (#22),
 * đo bằng swing chứ không bằng đỉnh từng nến. LONG: trong các đỉnh swing nằm SAU
 * nến đáy `tipIndex` và đã xác nhận tới nến `index`, có hai đỉnh LIỀN NHAU mà đỉnh
 * sau cao hơn đỉnh trước. SHORT: hai đáy swing liền nhau, đáy sau thấp hơn.
 * `swings` theo thứ tự index tăng dần, đúng như `findSwings` trả về.
 */
export function hasRisingSwings(
  swings: Swing[],
  tipIndex: number,
  index: number,
  direction: KeyVolumeDirection,
): boolean {
  const type = direction === "long" ? "high" : "low";
  let previous: Swing | null = null;
  for (const swing of swings) {
    if (swing.type !== type || swing.index <= tipIndex || swing.confirmIndex > index) continue;
    if (previous && (direction === "long" ? swing.price > previous.price : swing.price < previous.price)) {
      return true;
    }
    previous = swing;
  }
  return false;
}

/**
 * "Dựng hộp xong thì đợi thêm 3-4 nến xem các nến có GIÁ ĐÓNG nằm ngoài hộp
 * không." Chỉ giá đóng phải ra ngoài — râu thò lại vào hộp vẫn qua cửa, vì cái
 * cần chứng minh là giá đã BỎ LẠI hộp phía sau chứ không phải chưa từng chạm
 * nó. Thiếu nến để kiểm thì coi như KHÔNG qua.
 */
export function departedFromBlock(
  candles: Candle[],
  fromIndex: number,
  bars: number,
  direction: KeyVolumeDirection,
  obLow: number,
  obHigh: number,
  mode: KeyVolumeDepartMode = "candle",
): boolean {
  if (bars <= 0) return true;
  if (fromIndex < 0 || fromIndex + bars > candles.length) return false;
  for (let i = fromIndex; i < fromIndex + bars; i++) {
    // `candle`: mép gần hộp nhất của cây nến, tức cả râu. `close`: chỉ giá đóng.
    const edge = mode === "close"
      ? candles[i].close
      : (direction === "long" ? candles[i].low : candles[i].high);
    const outside = direction === "long" ? edge > obHigh : edge < obLow;
    if (!outside) return false;
  }
  return true;
}

/**
 * Giá đã TỪNG rời hẳn key trước khi chạm lại chưa — điều kiện để chữ "quay về"
 * có nội dung. Chỉ cần MỘT nến trong cửa sổ nhìn lại nằm trọn ngoài dải
 * `±keyDepartureAtr × ATR` quanh key là đủ; một đoạn đi ngang đè lên key sẽ
 * không có nến nào như thế và bị loại.
 *
 * Dùng ATR của CHÍNH nến đang xét, không phải ATR lúc chạm: cửa sổ nhìn lại có
 * thể trải qua vùng biến động khác hẳn.
 */
export function departedFromKey(
  candles: Candle[],
  atr: number[],
  touchIndex: number,
  keyPrice: number,
  lookback: number,
  atrMult: number,
): boolean {
  if (lookback <= 0 || !(atrMult > 0)) return true;
  return lastDepartureSide(candles, atr, touchIndex, keyPrice, lookback, atrMult) != null;
}

/**
 * Phía của lần rời key GẦN NHẤT trước `touchIndex` — tức giá về key từ đâu.
 * `null` khi trong cửa sổ không có nến nào nằm trọn ngoài dải.
 */
function lastDepartureSide(
  candles: Candle[],
  atr: number[],
  touchIndex: number,
  keyPrice: number,
  lookback: number,
  atrMult: number,
): "above" | "below" | null {
  for (let i = touchIndex - 1; i >= Math.max(0, touchIndex - lookback); i--) {
    const distance = atrMult * atr[i];
    if (!(distance > 0)) continue;
    if (candles[i].low > keyPrice + distance) return "above";
    if (candles[i].high < keyPrice - distance) return "below";
  }
  return null;
}

/**
 * Nến `index` có phải đỉnh (đáy) swing `bars`/`bars` không — cùng quy ước với
 * `findSwings`: bên trái phải thấp hơn hẳn, bên phải không được cao hơn. Chỉ biết
 * được khi nến `index + bars` đã đóng.
 */
function isPivotAt(candles: Candle[], index: number, bars: number, type: "high" | "low"): boolean {
  if (index - bars < 0 || index + bars >= candles.length) return false;
  const value = candles[index][type];
  for (let k = 1; k <= bars; k++) {
    const left = candles[index - k][type];
    const right = candles[index + k][type];
    if (type === "high" ? left >= value || right > value : left <= value || right < value) return false;
  }
  return true;
}

/** Mức đặt lệnh chờ: mép THUẬN chiều của hộp. */
export function orderBlockEntry(
  ob: { obLow: number; obHigh: number },
  direction: KeyVolumeDirection,
): number {
  return direction === "long" ? ob.obHigh : ob.obLow;
}

/**
 * "Mô hình hai đỉnh hai đáy là đủ tray rồi" (`#23`) và `#22` nhấn mạnh phải chờ
 * đủ hai đáy mới đẩy được giá lên. Hai swing cùng loại, giá xấp xỉ nhau.
 */
export function hasDoubleTopBottom(
  swings: Swing[],
  index: number,
  direction: KeyVolumeDirection,
  tolerance: number,
  lookback: number,
): boolean {
  if (!(tolerance > 0)) return false;
  const type = direction === "long" ? "low" : "high";
  const recent = swings
    .filter((swing) =>
      swing.type === type
      && swing.confirmIndex <= index
      && swing.index >= index - lookback)
    .sort((a, b) => b.index - a.index);
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      if (Math.abs(recent[i].price - recent[j].price) <= tolerance) return true;
    }
  }
  return false;
}

/**
 * `Q&A 006`: "thời gian tốt để trade là phiên Mỹ, phiên Mỹ là chạy mạnh".
 * Tác giả nói rõ đây là chuyện biến động chứ không phải phiên nào "đúng" hơn
 * ("phiên nào nó cũng chuẩn, tại vì nó biến động ít thôi"), nên đây là bộ lọc
 * chất lượng tuỳ chọn, không phải luật cứng của phương pháp.
 */
export function isWithinSession(
  openTime: number,
  fromHourUtc: number,
  toHourUtc: number,
): boolean {
  const hour = new Date(openTime).getUTCHours();
  return fromHourUtc <= toHourUtc
    ? hour >= fromHourUtc && hour < toHourUtc
    : hour >= fromHourUtc || hour < toHourUtc;
}

/**
 * "Từ giá cao nhất/thấp nhất đó đi về TRƯỚC cỡ một ngày thì không có nến nào
 * vượt qua nó": mức sắp bị quét phải là một đỉnh/đáy NỔI BẬT chứ không phải mút
 * của một đoạn đang trôi một chiều. Chỉ ràng buộc phía TRÁI của cây cực trị —
 * phía phải nằm gọn trong cửa sổ quét, nơi mức đó đã là cực trị theo định nghĩa.
 *
 * Bằng nhau KHÔNG bị loại: hai đáy ngang nhau là mức được giữ, không phải mức
 * bị vượt.
 */
export function isProminentExtreme(
  candles: Candle[],
  extremeIndex: number,
  field: "high" | "low",
  prominenceBars: number,
): boolean {
  if (prominenceBars <= 0) return true;
  const from = extremeIndex - prominenceBars;
  // Không đủ lịch sử để kiểm thì KHÔNG được coi như đã kiểm xong.
  if (from < 0) return false;
  const level = candles[extremeIndex][field];
  for (let i = from; i < extremeIndex; i++) {
    if (field === "high" ? candles[i].high > level : candles[i].low < level) return false;
  }
  return true;
}

/** Một cú quét hoàn tất ở nến `reclaimIndex` — nến ĐÓNG trở lại vào trong mức. */
export interface SweepEvent {
  /** Nến đầu tiên thủng mức. Bằng `reclaimIndex` khi giá rút râu ngay trong một nến. */
  breakIndex: number;
  reclaimIndex: number;
  /** Mức bị quét: đáy (đỉnh) của `lookback` nến ngay trước nến thủng. */
  level: number;
  /** Điểm xa nhất giá đi được bên ngoài mức, từ nến thủng tới nến đóng lại. */
  extreme: number;
  extremeIndex: number;
}

/**
 * Stop hunt: giá vượt qua đáy (đỉnh) của `lookback` nến trước nó rồi trở lại bên
 * trong — ăn hết thanh khoản của những stop đặt ngoài mức đó rồi trả giá về. Hai
 * kiểu, xét tại nến `index`:
 *   · RÚT RÂU — chính nến `index` thủng mức rồi đóng lại bên trong.
 *   · CHẠY TỪ TỪ LẠI — nến thủng (sớm hơn) ĐÓNG ngoài mức, mọi nến sau đó tới
 *     trước `index` cũng đóng ngoài mức, và `index` là nến ĐẦU TIÊN đóng trở lại
 *     vào trong. Tính cả nến thủng, giá nằm ngoài tối đa `maxOutsideBars` nến.
 * Mức là đỉnh/đáy của cửa sổ ngay trước NẾN THỦNG, không phải trước nến đóng
 * lại — cửa sổ trước nến đóng lại đã chứa chính đoạn vượt mức. Mức còn phải qua
 * `isProminentExtreme`. Nhiều nến thủng cùng khớp thì lấy nến SỚM nhất: mức của
 * nó là mức 5 ngày bị thủng đầu tiên, các mức sau chỉ là đáy mới của đoạn vượt.
 *
 * `windowExtremes[b]` (tuỳ chọn) là index cực trị cửa sổ của nến `b`, tính sẵn
 * để engine khỏi quét lại 480 nến cho mỗi nến thủng ứng viên.
 */
export function findSweep(
  candles: Candle[],
  index: number,
  direction: KeyVolumeDirection,
  lookback: number,
  prominenceBars = 0,
  maxOutsideBars = 0,
  windowExtremes?: number[],
): SweepEvent | null {
  const long = direction === "long";
  const field = long ? "low" : "high";
  const close = candles[index].close;
  for (let b = Math.max(lookback, index - Math.max(0, maxOutsideBars)); b <= index; b++) {
    const extremeIndex = windowExtremes?.[b] ?? rangeExtremeIndex(candles, b - lookback, b, field);
    const level = candles[extremeIndex][field];
    const broke = long ? candles[b].low < level : candles[b].high > level;
    const back = long ? close > level : close < level;
    if (!broke || !back) continue;
    let stayedOutside = true;
    for (let j = b; j < index && stayedOutside; j++) {
      if (long ? candles[j].close > level : candles[j].close < level) stayedOutside = false;
    }
    if (!stayedOutside || !isProminentExtreme(candles, extremeIndex, field, prominenceBars)) continue;
    let far = b;
    for (let j = b + 1; j <= index; j++) {
      if (long ? candles[j].low < candles[far].low : candles[j].high > candles[far].high) far = j;
    }
    return {
      breakIndex: b,
      reclaimIndex: index,
      level,
      extreme: candles[far][field],
      extremeIndex: far,
    };
  }
  return null;
}

/** Bản trả lời có/không của `findSweep`. */
export function sweptAndReclaimed(
  candles: Candle[],
  index: number,
  direction: KeyVolumeDirection,
  lookback: number,
  prominenceBars = 0,
  maxOutsideBars = 0,
): boolean {
  return findSweep(candles, index, direction, lookback, prominenceBars, maxOutsideBars) != null;
}

/**
 * Quét thanh khoản bên này thì chạy sang cụm thanh khoản bên kia — đỉnh/đáy của
 * CÙNG cửa sổ đã cho ra mức bị quét.
 */
function sweepTargetOf(
  candles: Candle[],
  sweep: SweepEvent,
  direction: KeyVolumeDirection,
  lookback: number,
): number {
  return direction === "long"
    ? rangeMax(candles, sweep.breakIndex - lookback, sweep.breakIndex, "high")
    : rangeMin(candles, sweep.breakIndex - lookback, sweep.breakIndex, "low");
}

/** Index cực trị của `lookback` nến ngay trước mỗi nến; -1 khi chưa đủ lịch sử. */
function windowExtremeIndices(candles: Candle[], lookback: number, field: "low" | "high"): number[] {
  return candles.map((_, i) => (i < lookback ? -1 : rangeExtremeIndex(candles, i - lookback, i, field)));
}

function invalidatedByClose(
  candle: Candle,
  level: KeyVolumeLevel,
  direction: KeyVolumeDirection,
): boolean {
  return direction === "long"
    ? candle.close < level.zoneLow
    : candle.close > level.zoneHigh;
}

/** `Q&A 006` là bộ lọc chất lượng tuỳ chọn, áp cho CẢ HAI nhánh. */
function passesSession(candle: Candle, params: KeyVolumeParams): boolean {
  return !params.sessionHoursUtc
    || isWithinSession(candle.openTime, params.sessionHoursUtc[0], params.sessionHoursUtc[1]);
}

function buildEntryPlans(
  confirm: Candle[],
  levels: KeyVolumeLevel[],
  diagnostics: KeyVolumeDiagnostics,
  params: KeyVolumeParams,
): KeyVolumeEntryPlan[] {
  const atr15 = atrSeriesForward(confirm);
  const rsi = rsiSeries(confirm, params.rsiPeriod);
  const volumes = confirm.map(quoteVolume);
  const swings = findSwings(confirm, params.swingPivotLeft, params.swingPivotRight);
  // Cực trị cửa sổ quét của từng nến, tính một lần: mỗi nến xét tới 17 nến thủng ứng viên.
  const sweepLows = params.enableSweepBranch ? windowExtremeIndices(confirm, params.sweepLookback, "low") : [];
  const sweepHighs = params.enableSweepBranch ? windowExtremeIndices(confirm, params.sweepLookback, "high") : [];
  const used = new Set<string>();
  const touchCounts = new Map<string, number>();
  const plans: KeyVolumeEntryPlan[] = [];
  let setup: KeyTouchSetup | null = null;
  // `order-block`: cú quét đã đóng lại, đang chờ cụm đảo chiều có mũi nhọn là râu quét.
  let pendingSweeps: { direction: KeyVolumeDirection; sweep: SweepEvent }[] = [];
  // Nhánh trap: phía giá đóng gần nhất so với từng key (1 trên, -1 dưới), và cú
  // phá đang chờ giá quay về.
  const trapSides = new Map<string, 1 | -1>();
  const trapBreaks = new Map<string, { side: 1 | -1; breakIndex: number }>();
  // Nhánh 4: đỉnh (SHORT) / đáy (LONG) gần nhất của chuỗi đang chạy trên từng key.
  const lowerHighChains = new Map<string, Partial<Record<KeyVolumeDirection, { price: number; index: number }>>>();
  const startIndex = Math.max(
    params.touchVolumeLookback,
    params.sweepLookback + params.sweepProminenceBars,
    1,
  );
  const volumeRatioAt = (index: number): number => {
    const baseline = medianPrior(volumes, index, params.touchVolumeLookback);
    return baseline > 0 ? volumes[index] / baseline : 0;
  };

  for (let i = startIndex; i < confirm.length; i++) {
    const closeTime = confirm[i].openTime + TF_MS[params.confirmTf];
    // Hộp dựng xong ở cuối nến `i`, rồi giá phải rời hộp trọn `obDepartBars`
    // nến. Sớm nhất đặt được lệnh chờ là cây ngay sau cửa đó.
    const readyIndex = i + 1 + params.obDepartBars;
    const trigger = confirm[i];

    // ── NHÁNH 1 — THUẦN SĂN THANH KHOẢN ──────────────────────────────────
    // Không key, không nến chạm, không volume. Ở `order-block`, cú quét chỉ mở
    // chỗ chờ; bóp cò là cụm đảo chiều ở khối dưới.
    // `reclaim-close`: vào ngay ở giá đóng của chính nến `i`, nên không cần nến
    // nào phía sau; `box-retest` còn phải chờ đủ nến cho cửa rời hộp.
    const sweepDirect = params.sweepEntry === "reclaim-close";
    const sweepCluster = params.sweepEntry === "order-block";
    if (params.enableSweepBranch && (sweepDirect || sweepCluster || readyIndex < confirm.length)) {
      const sweptLow = findSweep(
        confirm, i, "long", params.sweepLookback, params.sweepProminenceBars,
        params.sweepMaxOutsideBars, sweepLows,
      );
      const sweptHigh = findSweep(
        confirm, i, "short", params.sweepLookback, params.sweepProminenceBars,
        params.sweepMaxOutsideBars, sweepHighs,
      );
      if (sweptLow || sweptHigh) diagnostics.sweeps++;
      if ((sweptLow && sweptLow.breakIndex < i) || (sweptHigh && sweptHigh.breakIndex < i)) {
        diagnostics.sweepsSlow++;
      }
      const sweep = sweptLow ?? sweptHigh;
      // Nến đóng lại vào trong CẢ HAI mức một lúc không nói được chiều nào.
      if (sweep && !(sweptLow && sweptHigh) && sweepCluster) {
        pendingSweeps.push({ direction: sweptLow ? "long" : "short", sweep });
      } else if (sweep && !(sweptLow && sweptHigh)) {
        if (!passesSession(trigger, params)) diagnostics.rejectedSession++;
        else {
          const direction: KeyVolumeDirection = sweptLow ? "long" : "short";
          // SL bám điểm XA NHẤT giá đi được ngoài mức: chính cái râu ở kiểu rút
          // râu, đáy (đỉnh) của cả đoạn vượt mức ở kiểu chạy từ từ lại.
          const wick = sweep.extreme;
          const triggerVolumeRatio = volumeRatioAt(i);
          // Nhánh quét không có cụm nến; "hộp" của nó là thân cây nến ĐÓNG LẠI vào
          // trong — ở kiểu rút râu đó cũng chính là cây thủng mức. Chỉ luật cũ
          // `box-retest` dùng hộp để vào lệnh; luật đang chạy chỉ giữ để vẽ.
          const ob = orderBlockFromCluster(confirm, i, 1);
          if (!sweepDirect && !departedFromBlock(
            confirm, i + 1, params.obDepartBars, direction, ob.obLow, ob.obHigh, params.obDepartMode,
          )) {
            diagnostics.rejectedDepart++;
          } else {
            plans.push({
              id: `sweep:${direction}:${trigger.openTime}`,
              branch: "sweep-reclaim",
              direction,
              // `reclaim-close`: vào ở giá ĐÓNG của chính nến đóng lại.
              readyIndex: sweepDirect ? i : readyIndex,
              triggerTime: trigger.openTime,
              key: null,
              approach: null,
              tipIndex: sweep.extremeIndex,
              clusterBars: 1,
              clusterShape: null,
              divergence: null,
              obLow: ob.obLow,
              obHigh: ob.obHigh,
              obEntryEdge: orderBlockEntry(ob, direction),
              structuralStop: wick,
              patternStop: wick,
              sweepTarget: sweepTargetOf(confirm, sweep, direction, params.sweepLookback),
              sweepBreakTime: confirm[sweep.breakIndex].openTime,
              triggerVolumeRatio,
              score: triggerVolumeRatio,
            });
            diagnostics.sweepBranchPlans++;
          }
        }
      }
    }

    // ── NHÁNH 1 `order-block` — ORDER BLOCK SAU CÚ QUÉT ──────────────────
    // Thấy rút râu chưa vào. Trong `sweepObWaitBars` nến kể từ nến đóng lại, chờ
    // một cụm đảo chiều mà mũi nhọn là một nến SAU cú quét quay lại CHẠM mức bị
    // quét — chính cây râu quét không tính, nó là cú quét chứ không phải order
    // block. Giá vượt qua râu quét thì cú quét chết. Có cụm thì đặt lệnh chờ ở
    // mép thuận chiều của hộp, khớp từ nến sau.
    if (sweepCluster && pendingSweeps.length > 0) {
      pendingSweeps = pendingSweeps.filter(({ direction, sweep }) =>
        i - sweep.reclaimIndex <= params.sweepObWaitBars
        && (direction === "long" ? trigger.low >= sweep.extreme : trigger.high <= sweep.extreme));
      for (let k = 0; k < pendingSweeps.length; k++) {
        const { direction, sweep } = pendingSweeps[k];
        const cluster = reversalOrderBlock(confirm, i, direction, atr15[i], params);
        if (!cluster || cluster.tipIndex <= sweep.reclaimIndex) continue;
        const tip = direction === "long" ? confirm[cluster.tipIndex].low : confirm[cluster.tipIndex].high;
        if (direction === "long" ? tip > sweep.level : tip < sweep.level) continue;
        // Cửa phiên hỏng thì GIỮ cú quét: cụm sau vẫn được xét, giống `setup` của nhánh key.
        if (!passesSession(trigger, params)) {
          diagnostics.rejectedSession++;
          continue;
        }
        const triggerVolumeRatio = volumeRatioAt(i);
        plans.push({
          id: `sweep:${direction}:${trigger.openTime}`,
          branch: "sweep-reclaim",
          direction,
          readyIndex: i + 1,
          triggerTime: trigger.openTime,
          key: null,
          approach: null,
          tipIndex: cluster.tipIndex,
          clusterBars: cluster.clusterBars,
          clusterShape: cluster.shape,
          divergence: null,
          obLow: cluster.obLow,
          obHigh: cluster.obHigh,
          obEntryEdge: orderBlockEntry(cluster, direction),
          // SL vẫn ngay ngoài râu quét, không ở mép thân hộp.
          structuralStop: sweep.extreme,
          patternStop: sweep.extreme,
          sweepTarget: sweepTargetOf(confirm, sweep, direction, params.sweepLookback),
          sweepBreakTime: confirm[sweep.breakIndex].openTime,
          triggerVolumeRatio,
          score: triggerVolumeRatio,
        });
        diagnostics.sweepBranchPlans++;
        pendingSweeps.splice(k, 1);
        k--;
      }
    }

    // ── NHÁNH 3 — TRAP QUA KEY ───────────────────────────────────────────
    // Đóng qua bên kia key rồi trong `keyTrapMaxBars` nến đóng quay về phía cũ,
    // cách key ít nhất `keyTrapCloseAtr` ATR: cú phá là bẫy. Nến đóng sát key
    // không tính và không huỷ trap; đóng qua lại nhiều lần vẫn đếm từ nến phá đầu.
    if (params.enableKeyTrapBranch) {
      for (const key of levels) {
        if (!isKeyVolumeLevelActive(key, closeTime)) {
          trapSides.delete(key.id);
          trapBreaks.delete(key.id);
          continue;
        }
        const side = trigger.close > key.zoneHigh ? 1 : trigger.close < key.zoneLow ? -1 : 0;
        const pending = trapBreaks.get(key.id);
        if (pending && i - pending.breakIndex > params.keyTrapMaxBars) {
          // Nằm bên kia quá hạn: cú phá là thật, không còn là trap.
          trapBreaks.delete(key.id);
        } else if (pending) {
          const gap = params.keyTrapCloseAtr * atr15[i];
          const back = pending.side === 1
            ? trigger.close <= key.zoneLow - gap
            : trigger.close >= key.zoneHigh + gap;
          if (back) {
            trapBreaks.delete(key.id);
            if (!passesSession(trigger, params)) diagnostics.rejectedSession++;
            else {
              const direction: KeyVolumeDirection = pending.side === 1 ? "short" : "long";
              // Đoạn trap bắt đầu từ cây ĐẦU TIÊN thò qua key, kể cả chỉ bằng râu rồi
              // đóng ở phía cũ. BTC 02/10: râu 19:30 lên 87.249,6, tới 19:45 mới đóng
              // trên key — SL tính từ 19:45 bị chính vùng râu đó quét lúc 20:30.
              let excursionStart = pending.breakIndex;
              while (excursionStart > 0) {
                const prior = confirm[excursionStart - 1];
                const wickedThrough = direction === "short"
                  ? prior.high > key.zoneHigh && prior.close <= key.zoneHigh
                  : prior.low < key.zoneLow && prior.close >= key.zoneLow;
                if (!wickedThrough) break;
                excursionStart--;
              }
              const extremeIndex = rangeExtremeIndex(
                confirm, excursionStart, i + 1, direction === "short" ? "high" : "low",
              );
              const extreme = direction === "short" ? confirm[extremeIndex].high : confirm[extremeIndex].low;
              // "Hộp" của trap là dải từ key tới cực trị cú phá — chỉ để vẽ.
              const zone = direction === "short"
                ? { obLow: key.zoneLow, obHigh: extreme }
                : { obLow: extreme, obHigh: key.zoneHigh };
              const triggerVolumeRatio = volumeRatioAt(i);
              plans.push({
                id: `${key.id}:key-trap:${trigger.openTime}`,
                branch: "key-trap",
                direction,
                // Vào ở giá ĐÓNG của chính nến quay về.
                readyIndex: i,
                triggerTime: trigger.openTime,
                key,
                approach: null,
                tipIndex: extremeIndex,
                clusterBars: i - pending.breakIndex + 1,
                clusterShape: null,
                divergence: null,
                obLow: zone.obLow,
                obHigh: zone.obHigh,
                obEntryEdge: orderBlockEntry(zone, direction),
                structuralStop: extreme,
                patternStop: extreme,
                sweepTarget: null,
                sweepBreakTime: confirm[pending.breakIndex].openTime,
                triggerVolumeRatio,
                score: key.volumeRatio + triggerVolumeRatio,
              });
              diagnostics.keyTrapPlans++;
            }
          }
        } else if (side !== 0 && trapSides.get(key.id) === -side) {
          trapBreaks.set(key.id, { side, breakIndex: i });
        }
        if (side !== 0) trapSides.set(key.id, side);
      }
    }

    // ── NHÁNH 4 — ĐỈNH THẤP DẦN SAU PHẢN ỨNG TẠI KEY ─────────────────────
    // Đỉnh swing có nến chạm key ngay trước/tại nó là ĐỈNH PHẢN ỨNG, mở chuỗi. Mỗi
    // đỉnh swing sau thấp hơn đỉnh trước là một ĐỈNH THẤP HƠN: đặt lệnh chờ SHORT ở
    // mép dưới order block của nó, SL trên đỉnh liền trước. Đỉnh cao hơn làm gãy
    // chuỗi, trừ khi chính nó cũng vừa chạm key (thành đỉnh phản ứng mới). LONG gương.
    if (params.enableLowerHighBranch) {
      const bars = params.lowerHighPivotBars;
      const pivot = i - bars;
      const emitted = new Set<KeyVolumeDirection>();
      // Key volume lớn xét trước: hai key cùng nhận một đỉnh thì key mạnh hơn giữ kế hoạch.
      const active = levels
        .filter((key) => {
          if (isKeyVolumeLevelActive(key, closeTime)) return true;
          lowerHighChains.delete(key.id);
          return false;
        })
        .sort((a, b) => b.volumeRatio - a.volumeRatio);
      for (const key of active) {
        const chains = lowerHighChains.get(key.id) ?? {};
        for (const direction of ["short", "long"] as const) {
          const type = direction === "short" ? "high" : "low";
          if (!isPivotAt(confirm, pivot, bars, type)) continue;
          const extreme = confirm[pivot][type];
          const chain = chains[direction];
          if (chain && (direction === "short" ? extreme < chain.price : extreme > chain.price)) {
            // Order block = THÂN cây nến NGƯỢC MÀU cuối cùng của nhịp lên tới đỉnh thấp
            // hơn (SHORT: nến xanh), tính từ đỉnh lùi về tới ngay sau đỉnh trước.
            let obIndex = -1;
            for (let j = pivot; j > chain.index && obIndex < 0; j--) {
              if (direction === "short" ? confirm[j].close > confirm[j].open : confirm[j].close < confirm[j].open) obIndex = j;
            }
            const block = obIndex < 0 ? null : {
              obLow: Math.min(confirm[obIndex].open, confirm[obIndex].close),
              obHigh: Math.max(confirm[obIndex].open, confirm[obIndex].close),
            };
            const edge = block ? orderBlockEntry(block, direction) : NaN;
            // Lệnh chờ phải nằm đúng phía key (SHORT dưới key — key làm cản; LONG trên),
            // và là LIMIT thật: SHORT treo TRÊN giá lúc đặt, LONG treo DƯỚI. Mép đã bị
            // giá vượt qua thì lệnh chờ thành lệnh thị trường — bỏ.
            const sideOk = block != null
              && (direction === "short" ? edge < key.price : edge > key.price)
              && (direction === "short" ? edge > trigger.close : edge < trigger.close);
            // Kế hoạch ở nến CUỐI vẫn được sinh (`readyIndex` = ngay sau dữ liệu): backtest
            // không bao giờ chạm tới nó, còn bot live cần đúng nó để đặt lệnh chờ.
            if (block && sideOk && !emitted.has(direction)) {
              if (!passesSession(trigger, params)) diagnostics.rejectedSession++;
              else {
                emitted.add(direction);
                const triggerVolumeRatio = volumeRatioAt(i);
                plans.push({
                  id: `${key.id}:key-lower-high:${direction}:${trigger.openTime}`,
                  branch: "key-lower-high",
                  direction,
                  // Lệnh chờ đặt lúc nến xác nhận đỉnh đóng, khớp từ nến sau.
                  readyIndex: i + 1,
                  triggerTime: trigger.openTime,
                  key,
                  approach: null,
                  tipIndex: pivot,
                  clusterBars: i - obIndex + 1,
                  clusterShape: null,
                  divergence: null,
                  obLow: block.obLow,
                  obHigh: block.obHigh,
                  obEntryEdge: edge,
                  structuralStop: chain.price,
                  patternStop: chain.price,
                  sweepTarget: null,
                  sweepBreakTime: null,
                  priorExtremeTime: confirm[chain.index].openTime,
                  triggerVolumeRatio,
                  score: key.volumeRatio + triggerVolumeRatio,
                });
                diagnostics.lowerHighPlans++;
              }
            }
            chains[direction] = { price: extreme, index: pivot };
          } else {
            let touched = false;
            for (let j = Math.max(0, pivot - params.lowerHighTouchBars); j <= pivot && !touched; j++) {
              touched = touchesLevel(confirm[j], key, params.keyTouchAtr * atr15[j]);
            }
            chains[direction] = touched ? { price: extreme, index: pivot } : undefined;
          }
        }
        lowerHighChains.set(key.id, chains);
      }
    }

    // ── NHÁNH 2 — KEY + CỤM NẾN ĐẢO CHIỀU ────────────────────────────────
    if (setup) {
      // Giá đóng qua bên kia key: luận điểm hướng này chết. KHÔNG khoá key lại —
      // dưới luật hướng mới, chính key đó vừa đổi vai đỡ <-> cản.
      const broken = !isKeyVolumeLevelActive(setup.key, closeTime)
        || invalidatedByClose(trigger, setup.key, setup.direction);
      if (broken || i - setup.touchIndex > params.sweepWaitBars) setup = null;
    }

    if (!setup) {
      const touch = selectKeyTouch(trigger, closeTime, atr15[i], levels, used, params);
      if (touch) {
        diagnostics.keyTouches++;
        const touchCount = (touchCounts.get(touch.key.id) ?? 0) + 1;
        touchCounts.set(touch.key.id, touchCount);
        // "Cái phát đầu tiên là không thể nào mà tray được" (#22).
        if (params.requireSecondTouch && touchCount < 2) diagnostics.rejectedFirstTouch++;
        else if (volumeRatioAt(i) >= params.touchVolumeSpikeMult) {
          diagnostics.touchVolumeConfirmed++;
          // Chạm key mà trước đó giá chưa từng rời nó thì đây không phải cú
          // QUAY VỀ, chỉ là giá đang đi ngang đè lên mức.
          if (!departedFromKey(
            confirm, atr15, i, touch.key.price,
            params.keyDepartureLookback, params.keyDepartureAtr,
          )) {
            diagnostics.rejectedNoDeparture++;
          } else {
            const side = params.keyDepartureLookback > 0 && params.keyDepartureAtr > 0
              ? lastDepartureSide(
                confirm, atr15, i, touch.key.price,
                params.keyDepartureLookback, params.keyDepartureAtr,
              )
              : null;
            const approach: KeyVolumeApproach | null = side == null
              ? null
              : (side === "above") === (touch.direction === "long") ? "bounce" : "breakout";
            setup = { direction: touch.direction, key: touch.key, touchIndex: i, approach };
          }
        }
      }
    }
    if (!setup || !params.enableVolumeReversalBranch) continue;

    // Hai cách bóp cò, thử theo thứ tự: cụm mũi nhọn, rồi tín hiệu A. Cụm trượt
    // cửa của nó (key ngoài hộp, volume thấp) thì KHÔNG chặn A — A là đường vào
    // lệnh song song, có phép đo "tại key" riêng.
    let found: ReversalOrderBlock | null = null;
    let clusterCounted = false;
    const cluster = reversalOrderBlock(confirm, i, setup.direction, atr15[i], params);
    if (cluster) {
      // Đảo chiều phải xảy ra NGAY TẠI key: đường key chạy xuyên thân hộp. Không
      // khoá `setup` lại — cụm sau trong cùng cửa sổ chờ vẫn được xét.
      if (
        params.requireKeyInsideBlock
        && (setup.key.price < cluster.obLow || setup.key.price > cluster.obHigh)
      ) {
        diagnostics.rejectedKeyOutsideBlock++;
      } else {
        diagnostics.candlePatterns++;
        clusterCounted = true;
        if (volumeRatioAt(i) >= params.reversalVolumeMult) found = cluster;
      }
    }
    if (!found && params.enableDivergenceSignal) {
      found = rsiDivergenceAtKey(
        confirm, swings, rsi, atr15[i], i, setup.touchIndex, setup.direction, setup.key.price, params,
      );
    }
    if (!found) continue;
    if (found !== cluster) {
      // Cụm đã được đếm ở nến này (rồi trượt cửa volume) thì không đếm nến lần hai.
      if (!clusterCounted) diagnostics.candlePatterns++;
      diagnostics.structureSignals++;
    }
    const triggerVolumeRatio = volumeRatioAt(i);

    if (
      params.requireDoubleTopBottom
      && !hasDoubleTopBottom(
        swings,
        i,
        setup.direction,
        params.doubleTolAtr * atr15[i],
        params.doubleLookbackBars,
      )
    ) {
      diagnostics.rejectedDouble++;
      continue;
    }

    if (!passesSession(trigger, params)) {
      diagnostics.rejectedSession++;
      continue;
    }

    const structuralStop = setup.direction === "long"
      ? rangeMin(confirm, setup.touchIndex, i + 1, "low")
      : rangeMax(confirm, setup.touchIndex, i + 1, "high");

    if (
      !departedFromBlock(
        confirm, i + 1, params.obDepartBars, setup.direction,
        found.obLow, found.obHigh, params.obDepartMode,
      )
    ) {
      // Không khoá `setup` lại: cửa này hỏng giống mọi cửa khác của nhánh 2
      // (volume, phiên, hai đỉnh) — key vẫn còn hiệu lực, cụm sau vẫn được xét.
      diagnostics.rejectedDepart++;
      continue;
    }

    if (!params.allowKeyReentry) used.add(setup.key.id);
    if (readyIndex < confirm.length) {
      plans.push({
        id: `${setup.key.id}:volume-reversal:${trigger.openTime}`,
        branch: "volume-reversal",
        direction: setup.direction,
        readyIndex,
        triggerTime: trigger.openTime,
        key: setup.key,
        approach: setup.approach,
        tipIndex: found.tipIndex,
        clusterBars: found.clusterBars,
        clusterShape: found.shape,
        divergence: found.divergence ?? null,
        obLow: found.obLow,
        obHigh: found.obHigh,
        obEntryEdge: orderBlockEntry(found, setup.direction),
        structuralStop,
        patternStop: setup.direction === "long" ? trigger.low : trigger.high,
        sweepTarget: null,
        sweepBreakTime: null,
        triggerVolumeRatio,
        score: setup.key.volumeRatio + triggerVolumeRatio,
      });
      diagnostics.volumeBranchPlans++;
    }
    setup = null;
  }

  plans.sort((a, b) => a.readyIndex - b.readyIndex);
  diagnostics.plans = plans.length;
  return plans;
}

/** Key gần nhất nằm bên kia entry — vùng cấu trúc đối diện để đo dư địa và TP. */
function nearestOpposingTarget(
  levels: KeyVolumeLevel[],
  time: number,
  direction: KeyVolumeDirection,
  entry: number,
): number | null {
  const candidates = levels
    .filter((level) =>
      isKeyVolumeLevelActive(level, time)
      && (direction === "long" ? level.price > entry : level.price < entry))
    .map((level) => level.price)
    .sort((a, b) => direction === "long" ? a - b : b - a);
  return candidates[0] ?? null;
}

/**
 * Mục tiêu cấu trúc của một kế hoạch, tuỳ nhánh. Nhánh quét đã chốt cụm thanh
 * khoản đối diện ngay lúc bóp cò; nhánh 2 tra key đối diện tại giá vào. Cả hai
 * đều phải nằm ĐÚNG PHÍA trước mặt — `sweepTarget` chốt từ trước nên vẫn phải
 * kiểm lại, nến vào lệnh có thể đã nhảy qua nó.
 */
function planTarget(
  plan: KeyVolumeEntryPlan,
  levels: KeyVolumeLevel[],
  time: number,
  entry: number,
): number | null {
  const price = plan.branch === "sweep-reclaim"
    ? plan.sweepTarget
    : nearestOpposingTarget(levels, time, plan.direction, entry);
  if (price == null) return null;
  const ahead = plan.direction === "long" ? price > entry : price < entry;
  return ahead ? price : null;
}

export function resolveTargetR(
  opposingR: number | null,
  params: Pick<KeyVolumeParams, "targetMode" | "finalTargetR">,
): number {
  if (opposingR == null) return params.finalTargetR;
  return params.targetMode === "capped-r"
    ? Math.min(params.finalTargetR, opposingR)
    : opposingR;
}

export function canReenterKey(
  direction: KeyVolumeDirection,
  currentSweep: number | undefined,
  previousReason: KeyVolumeExitReason,
  previousSweep: number | undefined,
  enabled: boolean,
  mode: KeyVolumeReentryMode = "deeper-sweep",
): boolean {
  if (!enabled) return false;
  // #23/#43: giá chạm key lần nữa và kích volume lần nữa là vào lại — tác giả
  // coi đây là thao tác thường quy, không đòi cú quét sâu hơn. User 04/10/26:
  // dính SL thật cũng GIỮ key — cú phá có thể là trap, hoặc key đổi vai và lệnh
  // sau đi chiều ngược lại. Trước đây chỉ stop dương mới mở lại key; BTC 79.054,3
  // bị khoá câm lặng từ 28/08 tới hết hạn 03/09 sau một lệnh trap dính SL.
  if (mode === "volume-retouch") return true;
  if (previousReason !== "positive-stop") return false;
  if (currentSweep == null || previousSweep == null) return false;
  return direction === "long"
    ? currentSweep < previousSweep
    : currentSweep > previousSweep;
}

function tradeCostR(
  entry: number,
  stop: number,
  entryTime: number,
  exitTime: number,
  partialTime?: number,
  /** Phần khối lượng đã chốt ở `partialTime` — chỉ phần còn lại chịu funding tới lúc thoát. */
  partialShare = 0,
): number {
  if (!CONFIG.costs.enabled) return 0;
  const riskFraction = Math.abs(entry - stop) / entry;
  if (!(riskFraction > 0)) return 0;
  const feeFraction = ((CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100) * 2;
  const periods = (from: number, to: number) =>
    Math.max(0, Math.floor(to / FUNDING_INTERVAL_MS) - Math.floor(from / FUNDING_INTERVAL_MS));
  const fundingPeriods = partialTime == null
    ? periods(entryTime, exitTime)
    : partialShare * periods(entryTime, partialTime) + (1 - partialShare) * periods(entryTime, exitTime);
  const fundingFraction = fundingPeriods * (CONFIG.costs.fundingPer8hPct / 100);
  return (feeFraction + fundingFraction) / riskFraction;
}

/**
 * Chốt `fraction` khối lượng ở `partialPrice` rồi dời SL phần còn lại về đúng giá
 * vào: giá quay ngược lại thì phần còn lại hoà vốn, không mất tiền (trước phí).
 * Mức chốt là lệnh chờ nằm sẵn, nên chỉ cần râu chạm là khớp.
 */
function takePartial(position: OpenPosition, index: number, fraction: number): void {
  position.realizedR += fraction * position.partialR;
  position.remaining -= fraction;
  position.partialIndex = index;
  position.stop = position.plan.direction === "long"
    ? Math.max(position.stop, position.entry)
    : Math.min(position.stop, position.entry);
}

function finishTrade(
  symbol: string,
  confirm: Candle[],
  position: OpenPosition,
  exitIndex: number,
  exitPrice: number,
  exitReason: KeyVolumeExitReason,
): KeyVolumeTrade {
  const direction = position.plan.direction;
  const finalR = direction === "long"
    ? (exitPrice - position.entry) / position.risk
    : (position.entry - exitPrice) / position.risk;
  const grossR = position.realizedR + position.remaining * finalR;
  const entryTime = confirm[position.entryIndex].openTime;
  const exitTime = confirm[exitIndex].openTime;
  const partialTime = position.partialIndex == null
    ? undefined
    : confirm[position.partialIndex].openTime;
  const costR = tradeCostR(
    position.entry, position.initialStop, entryTime, exitTime, partialTime, 1 - position.remaining,
  );
  return {
    symbol,
    planId: position.plan.id,
    dir: direction,
    branch: position.plan.branch,
    approach: position.plan.approach,
    entryTime,
    entryPrice: position.entry,
    initialSL: position.initialStop,
    target: position.target,
    exitTime,
    exitPrice,
    exitReason,
    grossR,
    costR,
    netR: grossR - costR,
    holdBars: exitIndex - position.entryIndex,
    retouchTime: position.retouchIndex == null ? null : confirm[position.retouchIndex].openTime,
    maxFavorableR: position.risk > 0 ? position.maxFavorable / position.risk : 0,
    partialTaken: position.partialIndex != null,
    keyPrice: position.plan.key?.price ?? null,
    keyVolumeRatio: position.plan.key?.volumeRatio ?? null,
    triggerVolumeRatio: position.plan.triggerVolumeRatio,
  };
}

/**
 * Hộp đang canh retest đã chết chưa. Đúng hai cách: giá ĐÓNG xuyên qua hộp
 * ngược chiều lệnh, hoặc key sinh ra nó hết hiệu lực / bị đóng xuyên.
 */
function boxIsDead(plan: KeyVolumeEntryPlan, candle: Candle): boolean {
  const brokenAgainst = plan.direction === "long"
    ? candle.close < plan.obLow
    : candle.close > plan.obHigh;
  if (brokenAgainst) return true;
  return plan.key != null
    && (!isKeyVolumeLevelActive(plan.key, candle.openTime)
      || invalidatedByClose(candle, plan.key, plan.direction));
}

export interface KeyVolumeEntryCandidate {
  /** Index engine của nến vào lệnh (nến đóng, hoặc nến lệnh chờ khớp). */
  index: number;
  time: number;
  plan: KeyVolumeEntryPlan;
  entry: number;
  stop: number;
  target: number;
  viaLimit: boolean;
}

/**
 * SL, mục tiêu và hai cửa cuối (rủi ro `minStopPct`–`maxStopPct`, dư địa `minRR`) của một kế hoạch ở
 * một giá vào cụ thể. Backtest và bot live dùng CHUNG hàm này nên hai bên không lệch luật.
 * `entryAtr`: ATR của nến vào ở giá đóng, hoặc của nến đặt lệnh chờ.
 */
export function resolveEntryLevels(
  plan: KeyVolumeEntryPlan,
  levels: KeyVolumeLevel[],
  entry: number,
  entryAtr: number,
  time: number,
  params: KeyVolumeParams,
): { ok: true; stop: number; target: number; risk: number } | { ok: false; reason: "risk" | "room" } {
  const dir = plan.direction;
  const key = plan.key;
  // Nhánh quét ở MỌI mode: SL ngay ngoài cái râu vừa quét — "sl sẽ đặt ở
  // trên/dưới phần râu mới tạo". Mép thân nến quét nằm TRONG râu, tức trong
  // vùng giá vừa bị quét, nên không phải điểm sai của setup. Nhánh trap cũng
  // vậy: SL ngay ngoài cực trị của đoạn giá nằm bên kia key.
  // Nhánh key, "order-block": vào bằng nến bật ra khỏi hộp thì thoát ngay
  // ngoài mép KIA của chính hộp đó. Ba mode còn lại là luật cũ giữ để ablation.
  const stopReference = plan.branch !== "volume-reversal" || !key
    ? plan.structuralStop
    : params.stopMode === "order-block"
      ? (dir === "long" ? plan.obLow : plan.obHigh)
      : params.stopMode === "confirmation"
        ? plan.patternStop
        : params.stopMode === "key"
          ? (dir === "long" ? key.zoneLow : key.zoneHigh)
          : plan.structuralStop;
  const stop = dir === "long"
    ? stopReference - params.stopBufferAtr * entryAtr
    : stopReference + params.stopBufferAtr * entryAtr;
  const risk = Math.abs(entry - stop);
  if (
    !(risk > 0)
    || risk / entry < params.minStopPct
    || risk / entry > params.maxStopPct
    || (dir === "long" ? stop <= 0 || stop >= entry : stop <= entry)
  ) return { ok: false, reason: "risk" };
  const opposing = planTarget(plan, levels, time, entry);
  const opposingR = opposing == null ? Infinity : Math.abs(opposing - entry) / risk;
  // User 04/10/26: nhánh 4 không đòi dư địa tối thiểu — vẫn nhắm key đối diện.
  const minRR = plan.branch === "key-lower-high" ? 0 : params.minRR;
  if ((opposing == null && params.requireStructuralTarget) || opposingR < minRR) return { ok: false, reason: "room" };
  const targetR = resolveTargetR(opposing == null ? null : opposingR, params);
  return { ok: true, stop, target: dir === "long" ? entry + targetR * risk : entry - targetR * risk, risk };
}

function simulatePlans(
  symbol: string,
  confirm: Candle[],
  plans: KeyVolumeEntryPlan[],
  levels: KeyVolumeLevel[],
  diagnostics: KeyVolumeDiagnostics,
  params: KeyVolumeParams,
  /** Có thì chạy chế độ ứng viên: không giữ vị thế giả lập, ghi mọi lệnh sẽ vào. */
  candidates?: KeyVolumeEntryCandidate[],
): { trades: KeyVolumeTrade[]; openTrade: KeyVolumeTrade | null } {
  const trades: KeyVolumeTrade[] = [];
  const atr = atrSeriesForward(confirm);
  const trailSwings = findSwings(confirm, params.swingPivotLeft, params.swingPivotRight);
  const swingsConfirmedAt = new Map<number, Swing[]>();
  for (const swing of trailSwings) {
    const values = swingsConfirmedAt.get(swing.confirmIndex) ?? [];
    values.push(swing);
    swingsConfirmedAt.set(swing.confirmIndex, values);
  }
  const consumed = new Set<string>();
  const keyOutcomes = new Map<string, {
    reason: KeyVolumeExitReason;
    sweepExtreme: number;
  }>();
  let position: OpenPosition | null = null;
  const armed: ArmedBox[] = [];
  // Lệnh chờ ở mép order block: nhánh quét `order-block` và nhánh 4.
  const limits: { plan: KeyVolumeEntryPlan; expiresAtIndex: number }[] = [];
  let cooldownUntil = -1;

  for (let i = 20; i < confirm.length; i++) {
    const candle = confirm[i];

    if (position) {
      const direction = position.plan.direction;
      const stopHit = direction === "long" ? candle.low <= position.stop : candle.high >= position.stop;
      const targetHit = direction === "long" ? candle.high >= position.target : candle.low <= position.target;
      let exitPrice: number | null = null;
      let reason: KeyVolumeExitReason | null = null;

      // Không còn M5 để biết cái nào chạm trước trong cùng một nến -> STOP thắng.
      if (stopHit) {
        exitPrice = position.stop;
        const isPositiveStop = direction === "long"
          ? position.stop > position.entry
            || (position.partialIndex != null && position.stop >= position.entry)
          : position.stop < position.entry
            || (position.partialIndex != null && position.stop <= position.entry);
        reason = isPositiveStop ? "positive-stop" : "stop";
      } else if (targetHit) {
        // Mục tiêu xa hơn mức chốt một phần thì giá đã đi qua mức đó trước khi tới
        // mục tiêu: phần chốt sớm vẫn phải tính dù hai việc rơi vào cùng một nến.
        if (
          params.partialFraction > 0
          && position.partialIndex == null
          && Math.abs(position.target - position.entry) > Math.abs(position.partialPrice - position.entry)
        ) {
          takePartial(position, i, params.partialFraction);
        }
        exitPrice = position.target;
        reason = "target";
      } else {
        const favorable = direction === "long"
          ? candle.high - position.entry
          : position.entry - candle.low;
        position.maxFavorable = Math.max(position.maxFavorable, favorable);

        const partialHit = direction === "long"
          ? candle.high >= position.partialPrice
          : candle.low <= position.partialPrice;
        if (params.partialFraction > 0 && position.partialIndex == null && partialHit) {
          takePartial(position, i, params.partialFraction);
        }

        // Ở `order-block`, SL ĐÃ nằm ngay ngoài chính mép này (obLow - đệm).
        // Giữ thêm luật đóng-xuyên-thân sẽ luôn cắt trước SL vài phần nghìn giá,
        // tức là luật thoát người dùng đặt ra KHÔNG BAO GIỜ chạy. Nên ở mode đó
        // mép hộp chỉ còn một vai trò duy nhất: chỗ đặt SL.
        //
        // Ở các mode cũ, luật này chỉ có nghĩa với NHÁNH 2 nơi thân nến là một
        // vùng thật. Nến quét-và-giành-lại có thân bé và giá vào nằm NGAY TRÊN
        // biên thân đó nên luật chỉ bắt nhiễu: đo trên 250 ngày, 610 lệnh thoát
        // kiểu này và 326 trong số đó chết trong đúng một nến M15.
        const entryInvalid = params.stopMode !== "order-block"
          && position.plan.branch !== "sweep-reclaim"
          && (direction === "long"
            ? candle.close < position.plan.obLow
            : candle.close > position.plan.obHigh);
        // User 03/10/26: bỏ luật thoát khi nến đóng xuyên key lúc đang giữ lệnh, rồi
        // bỏ luật "vào xong giá không chạy thì cắt" — lệnh nhánh key giờ chỉ ra bằng
        // SL hoặc mục tiêu.
        if (entryInvalid) {
          exitPrice = candle.close;
          reason = "entry-invalid";
        }

        if (exitPrice == null && params.trailMode === "swing") {
          for (const swing of swingsConfirmedAt.get(i) ?? []) {
            if (swing.index <= position.entryIndex) continue;
            const favorableSwing = direction === "long"
              ? swing.type === "low" && swing.price > position.entry
              : swing.type === "high" && swing.price < position.entry;
            if (!favorableSwing) continue;
            const candidate = direction === "long"
              ? swing.price - params.stopBufferAtr * atr[i]
              : swing.price + params.stopBufferAtr * atr[i];
            const valid = direction === "long"
              ? candidate > position.entry && candidate < candle.close
              : candidate < position.entry && candidate > candle.close;
            if (!valid) continue;
            position.stop = direction === "long"
              ? Math.max(position.stop, candidate)
              : Math.min(position.stop, candidate);
          }
        }
      }

      if (exitPrice != null && reason) {
        trades.push(finishTrade(symbol, confirm, position, i, exitPrice, reason));
        // Luật vào-lại chỉ có nghĩa với nhánh dùng key; nhánh quét chỉ chịu cooldown.
        if (position.plan.key) {
          keyOutcomes.set(position.plan.key.id, {
            reason,
            sweepExtreme: position.plan.structuralStop,
          });
        }
        position = null;
        cooldownUntil = i + params.cooldownBars;
      }
      // KHÔNG `continue`: đang giữ lệnh vẫn phải dọn, trang bị và cập nhật hộp
      // bên dưới — chỉ riêng bước vào lệnh bị chặn. Bỏ qua ở đây thì kế hoạch có
      // `readyIndex` rơi vào lúc giữ lệnh mất hẳn, và hộp đang canh không chết
      // dù giá đã đóng xuyên nó.
    }

    // ── DỌN các hộp đã chết ──────────────────────────────────────────────
    // Ba cách chết, đếm riêng vì chúng nói hai chuyện khác nhau: BỊ PHÁ là luận
    // điểm sai, HẾT HẠN là giá không bao giờ về.
    for (let k = armed.length - 1; k >= 0; k--) {
      if (boxIsDead(armed[k].plan, candle)) {
        diagnostics.boxesBroken++;
        armed.splice(k, 1);
      } else if (i >= armed[k].expiresAtIndex) {
        diagnostics.boxesExpired++;
        armed.splice(k, 1);
      }
    }

    // ── TRANG BỊ mọi hộp vừa qua cửa rời hộp ─────────────────────────────
    // CANH nhiều hộp cùng lúc, nhưng chỉ GIỮ một vị thế. Luật cũ chỉ giữ một
    // lệnh chờ vì lệnh đó sống đúng 4 nến, nên "một lệnh chờ" xấp xỉ "một vị
    // thế". Hộp retest sống tới khi bị phá — trung bình cả chục ngày — nên nếu
    // vẫn giữ một chỗ canh thì một hộp sẽ ngồi chiếm slot và nuốt gần hết setup
    // còn lại. Ràng buộc "một thời điểm một lệnh" nằm ở tầng vị thế, không phải
    // ở tầng canh hộp.
    //
    // Nhánh quét `reclaim-close` và nhánh trap không có hộp nào để canh: kế hoạch
    // của chúng là ứng viên vào lệnh NGAY ở giá đóng của nến này, hoặc không bao
    // giờ. Nhánh quét `order-block` cũng không canh hộp: nó đặt lệnh chờ ở mép hộp.
    const enterNow: KeyVolumeEntryPlan[] = [];
    for (const plan of plans) {
      if (plan.readyIndex !== i || consumed.has(plan.id)) continue;
      if (plan.key) {
        if (!isKeyVolumeLevelActive(plan.key, candle.openTime)) continue;
        const previous = keyOutcomes.get(plan.key.id);
        if (
          previous
          && !canReenterKey(
            plan.direction,
            plan.structuralStop,
            previous.reason,
            previous.sweepExtreme,
            params.allowKeyReentry,
            params.reentryMode,
          )
        ) continue;
      }
      consumed.add(plan.id);
      if (
        plan.branch === "key-trap"
        || (plan.branch === "sweep-reclaim" && params.sweepEntry === "reclaim-close")
      ) {
        enterNow.push(plan);
        continue;
      }
      if (
        (plan.branch === "sweep-reclaim" && params.sweepEntry === "order-block")
        || plan.branch === "key-lower-high"
      ) {
        diagnostics.limitsPlaced++;
        // Cây đặt lệnh TÍNH LÀ một nến chờ, giống cách đếm hạn của hộp.
        limits.push({ plan, expiresAtIndex: i + Math.max(1, params.obLimitBars) });
        continue;
      }
      // Hộp VỪA trang bị cũng phải qua đúng phép chấm trên: `readyIndex` là cây
      // đầu tiên cửa rời hộp KHÔNG phủ, nên nó hoàn toàn có thể là cây đóng
      // xuyên qua hộp. Hộp chết ngay khi sinh không được tính là "đã quay lại".
      diagnostics.boxesArmed++;
      if (boxIsDead(plan, candle)) diagnostics.boxesBroken++;
      else {
        armed.push({
          plan,
          retouched: false,
          retouchIndex: null,
          // Cây trang bị TÍNH LÀ một nến canh, nên hộp còn sống hết cây
          // `i + boxWaitBars - 1` và hết hạn ở cây kế tiếp.
          expiresAtIndex: i + Math.max(1, params.boxWaitBars),
        });
      }
    }

    // ── QUAY LẠI HỘP rồi BẬT RA: điều kiện vào lệnh duy nhất ─────────────
    // Hai bước tách rời, và bước hai KHÔNG được rơi vào cùng cây nến với bước
    // một: phải thấy giá quay về hộp trước đã, rồi mới tính tới nến xác nhận.
    // Mọi hộp đều được cập nhật ở đây, kể cả khi cooldown đang chặn vào lệnh —
    // cờ "đã quay lại" là chuyện của giá, không phải chuyện của sổ lệnh.
    let confirmed: ArmedBox | null = null;
    for (const box of armed) {
      const dir = box.plan.direction;
      const touchesBox = candle.low <= box.plan.obHigh && candle.high >= box.plan.obLow;
      if (!box.retouched) {
        if (touchesBox) {
          box.retouched = true;
          box.retouchIndex = i;
          diagnostics.boxesRetouched++;
        }
        continue;
      }
      // Nến xác nhận phải đủ BA thứ:
      //   1. còn dính hộp — chỉ bật ra được khỏi cái hộp mình đang ở trong.
      //      Thiếu điều kiện này thì cờ `retouched` treo mãi và một nến xanh
      //      cách hộp rất xa vẫn bóp cò, cho ra giá vào vô nghĩa và R khổng lồ.
      //   2. đúng màu thuận chiều lệnh (long: xanh, short: đỏ),
      //   3. ĐÓNG CỬA ra ngoài hộp đúng chiều — nến xanh mà vẫn đóng trong hộp
      //      thì hộp chưa đẩy được giá đi, chưa vào.
      const rightColour = dir === "long"
        ? candle.close > candle.open
        : candle.close < candle.open;
      const closedOutside = dir === "long"
        ? candle.close > box.plan.obHigh
        : candle.close < box.plan.obLow;
      if (!touchesBox || !rightColour || !closedOutside) continue;
      // Nhánh key: chưa có hai swing xác nhận liền nhau tăng (giảm) dần sau nến
      // đáy thì chưa vào; hộp vẫn sống, cấu trúc đủ ở nến sau thì vào được.
      if (
        params.requireSwingConfirmation
        && box.plan.key
        && !hasRisingSwings(trailSwings, box.plan.tipIndex, i, dir)
      ) {
        diagnostics.rejectedNoStructure++;
        continue;
      }
      // Nhiều hộp cùng bật ra trên một cây: lấy hộp có score cao nhất.
      if (!confirmed || box.plan.score > confirmed.plan.score) confirmed = box;
    }
    // Nhánh quét `reclaim-close` và nhánh trap cạnh tranh cùng các hộp bật ra trên
    // cây này. Chúng không nằm trong `armed`, nên bị chặn (đang giữ lệnh, cooldown,
    // cửa risk/dư địa) là mất luôn — không có lần thử sau.
    for (const plan of enterNow) {
      if (!confirmed || plan.score > confirmed.plan.score) {
        confirmed = { plan, retouched: false, retouchIndex: null, expiresAtIndex: i + 1 };
      }
    }

    // ── LỆNH CHỜ Ở MÉP ORDER BLOCK (nhánh quét `order-block`, nhánh 4) ──
    // Khớp TRONG nến, tức trước mọi lệnh vào ở giá đóng, nên được ưu tiên. Râu
    // chạm mép là khớp; mở cửa đã vượt qua mép thì khớp ở giá mở. Đang giữ lệnh
    // hay đang cooldown thì lệnh chờ vẫn treo tới khi hết hạn.
    let fill: { limit: (typeof limits)[number]; price: number } | null = null;
    for (let k = limits.length - 1; k >= 0; k--) {
      const limit = limits[k];
      if (i >= limit.expiresAtIndex) {
        diagnostics.limitsExpired++;
        limits.splice(k, 1);
        continue;
      }
      const edge = limit.plan.obEntryEdge;
      const long = limit.plan.direction === "long";
      if (long ? candle.low > edge : candle.high < edge) continue;
      const price = long ? Math.min(edge, candle.open) : Math.max(edge, candle.open);
      if (!fill || limit.plan.score > fill.limit.plan.score) fill = { limit, price };
    }
    if (fill) confirmed = { plan: fill.limit.plan, retouched: false, retouchIndex: null, expiresAtIndex: i + 1 };

    if (!confirmed || (!candidates && (i < cooldownUntil || position))) continue;
    // Lệnh chờ đã khớp thì rời sổ chờ, kể cả khi trượt cửa risk/dư địa ngay dưới.
    if (fill) limits.splice(limits.indexOf(fill.limit), 1);

    // ── Giá vào chỉ biết được Ở ĐÂY, nên mọi cửa cũng chấm ở đây ─────────
    // Vào ở GIÁ ĐÓNG nến xác nhận. Nến này đã đóng trọn vẹn nên dùng ATR của
    // chính nó KHÔNG phải nhìn trước — khác hẳn luật lệnh chờ cũ, nơi lệnh đặt
    // và khớp có thể rơi vào cùng một cây.
    const plan = confirmed.plan;
    const dir = plan.direction;
    const entry = fill ? fill.price : candle.close;
    // Lệnh chờ đặt lúc nến cụm (`readyIndex - 1`) đóng nên SL chốt bằng ATR lúc
    // đó — ATR của nến khớp chứa cả phần nến chưa xảy ra lúc khớp.
    const entryAtr = fill ? atr[plan.readyIndex - 1] : atr[i];
    const gate = resolveEntryLevels(plan, levels, entry, entryAtr, candle.openTime, params);
    if (!gate.ok) {
      if (gate.reason === "risk") diagnostics.rejectedRisk++;
      else diagnostics.rejectedRoom++;
      continue;
    }
    const { stop, target, risk } = gate;
    if (candidates) {
      // Chế độ ỨNG VIÊN (bot live): ghi lại lệnh engine sẽ vào ở cây này rồi coi như
      // không vào — vị thế thật do sàn quyết, không phải vị thế giả lập.
      candidates.push({ index: i, time: candle.openTime, plan, entry, stop, target, viaLimit: fill != null });
      const at = armed.indexOf(confirmed);
      if (at >= 0) armed.splice(at, 1);
      continue;
    }
    position = {
      plan,
      entryIndex: i,
      retouchIndex: confirmed.retouchIndex,
      entry,
      initialStop: stop,
      stop,
      target,
      risk,
      partialPrice: dir === "long"
        ? entry + params.partialAtR * risk
        : entry - params.partialAtR * risk,
      partialR: params.partialAtR,
      remaining: 1,
      realizedR: 0,
      maxFavorable: 0,
    };
    // Kế hoạch vào thẳng không nằm trong `armed`: indexOf -1 mà splice thì xoá
    // nhầm hộp CUỐI danh sách.
    const confirmedAt = armed.indexOf(confirmed);
    if (confirmedAt >= 0) armed.splice(confirmedAt, 1);
    diagnostics.entries++;
    // KHÔNG chạy lại cây này qua nhánh quản lý vị thế. Giá vào là giá ĐÓNG của
    // chính nó, nên 15 phút rủi ro đầu tiên là cây KẾ TIẾP; chấm SL/TP trên
    // high/low của cây đã đóng rồi mới vào là nhìn trước quá khứ của chính mình.
    // Riêng lệnh chờ khớp TRONG nến: phần còn lại của nến vẫn là rủi ro thật. Nến
    // chạm SL thì chắc chắn đã khớp trước đó (mép nằm giữa giá và SL) -> thua.
    // Mục tiêu và mức chốt một phần KHÔNG chấm trên nến này: không biết chúng tới
    // trước hay sau lúc khớp.
    if (fill && (dir === "long" ? candle.low <= stop : candle.high >= stop)) {
      trades.push(finishTrade(symbol, confirm, position, i, stop, "stop"));
      position = null;
      cooldownUntil = i + params.cooldownBars;
    }
  }

  diagnostics.boxesUnresolved += armed.length;
  diagnostics.limitsUnresolved += limits.length;

  const last = confirm.length - 1;
  const openTrade = position && last >= 0
    ? finishTrade(symbol, confirm, position, last, confirm[last].close, "open")
    : null;
  return { trades, openTrade };
}

/**
 * `candles` phải là nến M15 ĐÃ ĐÓNG. Engine không gộp khung nữa — người gọi tự
 * lo dữ liệu đúng khung, và tự cắt cây cuối chưa đóng.
 */
export function runKeyVolume(
  symbol: string,
  candles: Candle[],
  params: KeyVolumeParams = KEY_VOLUME_CONFIG,
  candidateSink?: { candidates: KeyVolumeEntryCandidate[]; candles: Candle[] },
): KeyVolumeResult {
  const confirm = candles
    .filter((candle) =>
      Number.isFinite(candle.open)
      && Number.isFinite(candle.high)
      && Number.isFinite(candle.low)
      && Number.isFinite(candle.close)
      && candle.high >= candle.low,
    )
    .sort((a, b) => a.openTime - b.openTime);
  const detected = limitKeyTouches(confirm, detectKeyVolumeLevels(confirm, params.confirmTf, params), params);
  // Key chưa chín không được chạm, không làm mục tiêu, không làm vật cản dư địa.
  const levels = capActiveKeyLevels(
    params.requireKeyMaturation ? matureKeyLevels(confirm, detected, params) : detected,
    params.maxActiveKeys,
  );
  const diagnostics: KeyVolumeDiagnostics = {
    m15Levels: detected.length,
    keysMatured: levels.length,
    keyTouches: 0,
    touchVolumeConfirmed: 0,
    sweeps: 0,
    sweepsSlow: 0,
    candlePatterns: 0,
    structureSignals: 0,
    rejectedNoStructure: 0,
    rejectedKeyOutsideBlock: 0,
    rejectedNoDeparture: 0,
    plans: 0,
    sweepBranchPlans: 0,
    volumeBranchPlans: 0,
    keyTrapPlans: 0,
    lowerHighPlans: 0,
    entries: 0,
    rejectedDepart: 0,
    boxesArmed: 0,
    boxesRetouched: 0,
    boxesBroken: 0,
    boxesExpired: 0,
    boxesUnresolved: 0,
    limitsPlaced: 0,
    limitsExpired: 0,
    limitsUnresolved: 0,
    rejectedRisk: 0,
    rejectedRoom: 0,
    rejectedFirstTouch: 0,
    rejectedDouble: 0,
    rejectedSession: 0,
  };
  const plans = buildEntryPlans(confirm, levels, diagnostics, params);
  if (candidateSink) {
    simulatePlans(symbol, confirm, plans, levels, diagnostics, params, candidateSink.candidates);
    candidateSink.candles = confirm;
    return { trades: [], openTrade: null, plans, levels, diagnostics };
  }
  const { trades, openTrade } = simulatePlans(symbol, confirm, plans, levels, diagnostics, params);
  return { trades, openTrade, plans, levels, diagnostics };
}

/**
 * Cho bot live: kế hoạch, key, và mọi lệnh engine SẼ vào ở từng nến nếu đang trống
 * vị thế — không có vị thế giả lập nào chặn, vì vị thế thật nằm trên sàn. `candles`
 * là đúng mảng nến engine đã dùng (đã lọc, đã sắp xếp), để index khớp với kế hoạch.
 */
export function runKeyVolumeCandidates(
  symbol: string,
  candles: Candle[],
  params: KeyVolumeParams = KEY_VOLUME_CONFIG,
): KeyVolumeResult & { candidates: KeyVolumeEntryCandidate[]; candles: Candle[] } {
  const sink = { candidates: [] as KeyVolumeEntryCandidate[], candles: [] as Candle[] };
  const result = runKeyVolume(symbol, candles, params, sink);
  return { ...result, candidates: sink.candidates, candles: sink.candles };
}
