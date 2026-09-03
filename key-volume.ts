/**
 * Key Volume — bản số hoá phương pháp FX Dream Trading, chạy TRỌN VẸN trên M15.
 *
 * Engine nhận thẳng nến M15 và không dùng khung nào khác. Không còn Daily,
 * Weekly, H4, H1, và cũng không còn M5: nến M15 vừa là khung luật vừa là khung
 * mô phỏng. Hệ quả bắt buộc của việc bỏ M5: khi một nến chạm CẢ SL lẫn mục tiêu
 * thì không biết cái nào trước, nên tính STOP trước — quy ước bi quan, giống
 * mọi backtest lệnh chờ khác của repo.
 *
 * HAI NHÁNH VÀO LỆNH ĐỘC LẬP NHAU, không chia sẻ một điều kiện nào:
 *
 *   NHÁNH 1 — `sweep-reclaim`, THUẦN SĂN THANH KHOẢN, không đụng tới key.
 *     · Bóp cò: nến M15 thủng đỉnh/đáy `sweepLookback` nến trước (480 nến = năm
 *       ngày, chỗ đọng stop của người khác) rồi ĐÓNG lại trong biên — râu ăn
 *       hết stop rồi trả giá về.
 *     · Mức bị quét phải NỔI BẬT: đi ngược về trước `sweepProminenceBars` nến
 *       (96 = một ngày) tính từ chính cây tạo ra cực trị, không nến nào được
 *       vượt qua nó. Lọc này gạt các cực trị chỉ là mút của một đoạn đang trôi.
 *     · Hướng: quét đáy -> LONG, quét đỉnh -> SHORT. Không cần key, không cần
 *       nến chạm key, không cần volume, không cần mô hình nến xác nhận.
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
 *     · HƯỚNG — giá đang ở TRÊN key thì key là đỡ -> LONG; ở DƯỚI thì key là
 *       cản -> SHORT.
 *     · QUAY VỀ: nến chạm key chỉ tính khi giá đã TỪNG rời hẳn key —
 *       `keyDepartureLookback` nến trước đó phải có ít nhất một nến nằm ngoài
 *       dải `±keyDepartureAtr × ATR`. Giá đi ngang đè lên key không phải quay về.
 *     · Bóp cò: CỤM NẾN ĐẢO CHIỀU ngay tại key (xem dưới), miễn cây nến đảo
 *       chiều có volume >= `reversalVolumeMult` lần trung vị các nến liền trước
 *       — nhỏ hơn hẳn ngưỡng chọn key, chỉ cần nhỉnh hơn xung quanh — VÀ đường
 *       key phải nằm TRONG thân hộp order block của cụm (`requireKeyInsideBlock`).
 *     · TP là key đối diện gần nhất.
 *
 * CỤM NẾN ĐẢO CHIỀU — chỉ còn MỘT luật, xét trong cửa sổ 3 nến, và luật đó vừa
 * chọn cụm vừa quyết định luôn hộp order block:
 *   · THÂN cây đảo chiều nhấn chìm THÂN cả 2 nến liền trước
 *       -> hộp = min/max open-close của ĐÚNG 2 nến BỊ nhấn chìm.
 *   · Chỉ nhấn chìm 1 nến liền trước
 *       -> hộp = THÂN cây ĐANG nhấn chìm, tức chính cây đảo chiều.
 *   · Không rơi vào hai trường hợp trên -> KHÔNG xét, bỏ setup.
 * Cây đảo chiều còn phải đúng màu: LONG cần nến xanh, SHORT cần nến đỏ. Màu của
 * các nến bị nhấn chìm KHÔNG bị ràng buộc. In3 và 3-bar reversal đã bị bỏ khỏi
 * đường vào lệnh. Nhánh quét không có cụm nào: hộp của nó là thân đúng cây nến
 * quét.
 *
 * ORDER BLOCK — cả hai nhánh vào và thoát bằng CÙNG một hộp, râu KHÔNG tính:
 *   · LONG  vào ở giá đóng nến bật lên trên `obHigh`, SL ở `obLow  - stopBufferAtr × ATR`
 *   · SHORT vào ở giá đóng nến bật xuống dưới `obLow`, SL ở `obHigh + stopBufferAtr × ATR`
 * Giá vào lùi xa mép hộp hơn luật lệnh chờ cũ, nên R của mỗi lệnh TO hơn — đây
 * là chỗ luật mới mua thêm biên trên sàn chi phí.
 *
 * VÀO LỆNH — BA BƯỚC, không có lệnh chờ nào nằm sẵn trên sổ:
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
 * không quá `maxStopPct` giá, và dư địa tới mục tiêu >= `minRR`. Nến vào lệnh
 * đã đóng trọn nên KHÔNG được chấm SL/TP trên chính nó; 15 phút rủi ro đầu tiên
 * là cây kế tiếp.
 *
 * KHÔNG có trần thời gian giữ lệnh. Nhánh 1 ra bằng SL, mục tiêu, hoặc luật
 * "vào xong giá không chạy". Nhánh 2 có thêm đường key bị phá.
 *
 * Binance kline không có volume-at-price thật, và việc chấm "key đẹp" trên kênh
 * vẫn là discretionary — model này không phải bản sao 100% của phương pháp tay.
 */
import { Candle, CONFIG, TF_MS, findSwings, Swing } from "./strategy";

export type KeyVolumeDirection = "long" | "short";
export type KeyVolumeSourceTf = "15m" | "1h" | "4h";
export type KeyVolumeTargetMode = "nearest-structure" | "capped-r";
/**
 * `order-block` là luật ĐANG CHẠY và là mode DUY NHẤT áp cho CẢ HAI nhánh: SL
 * ngay ngoài mép ĐỐI DIỆN của chính hộp order block đã quyết định giá vào, đệm
 * `stopBufferAtr`. Vào ở mép này thì thoát ở mép kia — một hộp, hai đầu.
 *
 * Ba mode dưới là luật CŨ, chỉ còn để ablation so sánh, và chỉ có nghĩa với
 * NHÁNH 2; ở các mode đó nhánh quét quay lại luật riêng của nó (SL ngay ngoài
 * cái râu vừa quét).
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
export type KeyVolumeEntryBranch = "sweep-reclaim" | "volume-reversal";

export interface KeyVolumeParams {
  /** Khung DUY NHẤT: key, hướng, quét, mô hình nến, entry, stop và mô phỏng. */
  confirmTf: "15m";
  /** Tổng số nến XUNG QUANH dùng làm trung vị volume, chia đều hai bên. */
  volumeLookback: number;
  volumeSpikeMult: number;
  keyHistoryDays: number;
  minKeyReactions: number;
  keyReactionAtr: number;
  keyMaxAgeDays: number;
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
  enableSweepBranch: boolean;
  enableVolumeReversalBranch: boolean;
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
  partialAtR: number;
  partialFraction: number;
  followThroughBars: number;
  minFollowThroughR: number;
  /**
   * "Lon xong là giá sẽ chạy. Giá không chạy nữa là các bạn phải bỏ ngay lập
   * tức" (LiveTrade +50R) và "nó không sập liền mà nó còn quay lên nữa thì
   * mình phải thoát ra liền" (#26).
   */
  requireFollowThrough: boolean;
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
  keyHistoryDays: 90,
  // Chọn Key chỉ cần một nến volume đột biến. Lịch sử phản ứng là context để
  // trader chấm chất lượng, không phải điều kiện sinh Key tự động.
  minKeyReactions: 0,
  keyReactionAtr: 0.5,
  keyMaxAgeDays: 180,
  keyTouchAtr: 0.2,
  touchVolumeLookback: 12,
  touchVolumeSpikeMult: 1,
  reversalVolumeMult: 1.2,
  enableSweepBranch: true,
  enableVolumeReversalBranch: true,
  // 5 ngày M15 = 480 nến; mức bị quét phải sạch 1 ngày (96 nến) về phía trước.
  sweepLookback: 480,
  sweepProminenceBars: 96,
  sweepWaitBars: 4,
  // Cụm đảo chiều chỉ tính khi đường key chạy XUYÊN thân hộp của nó.
  requireKeyInsideBlock: true,
  // 20 nến M15 = 5 giờ nhìn lại; phải có nến cách key hơn 1 ATR mới gọi là đã rời.
  keyDepartureLookback: 20,
  keyDepartureAtr: 1,
  swingPivotLeft: 2,
  swingPivotRight: 2,
  stopBufferAtr: 0.15,
  maxStopPct: 0.03,
  minRR: 3,
  targetMode: "nearest-structure",
  requireStructuralTarget: true,
  // Vào ở mép thuận chiều của order block thì thoát ngay ngoài mép đối diện
  // của CHÍNH hộp đó — một hộp giữ cả hai đầu lệnh.
  stopMode: "order-block",
  // Giá phải rời hộp trọn 3 nến M15 rồi hộp mới được trang bị chờ retest.
  obDepartBars: 3,
  // Đo bằng GIÁ ĐÓNG: 3 nến sau khi dựng hộp đều phải đóng NGOÀI hộp, đúng
  // chiều lệnh. Râu được phép thò lại vào hộp.
  obDepartMode: "close",
  // 192 nến M15 = HAI ngày canh hộp rồi bỏ.
  boxWaitBars: 2 * 96,
  finalTargetR: 5,
  partialAtR: 2,
  partialFraction: 0,
  // 2 nến M15 = 30 phút, đúng cửa sổ cũ khi còn đếm bằng 6 nến M5.
  followThroughBars: 2,
  minFollowThroughR: 0.5,
  requireFollowThrough: true,
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

export interface KeyVolumeLevel {
  id: string;
  sourceTf: KeyVolumeSourceTf;
  price: number;
  zoneLow: number;
  zoneHigh: number;
  eventTime: number;
  /** Mốc nến CUỐI của cửa sổ có tâm đóng — trước mốc này key chưa biết được. */
  confirmedAt: number;
  expiresAt: number;
  volumeRatio: number;
}

export interface KeyVolumeEntryPlan {
  id: string;
  branch: KeyVolumeEntryBranch;
  direction: KeyVolumeDirection;
  /** Index nến M15 sẽ vào lệnh ở giá OPEN — luôn là nến ngay sau nến bóp cò. */
  readyIndex: number;
  /**
   * `openTime` của nến BÓP CÒ (nến cuối của cụm). Dùng MỐC THỜI GIAN chứ không
   * dùng `readyIndex` vì `runKeyVolume` lọc bỏ nến lỗi trước khi chạy, nên index
   * của engine không đảm bảo trùng index của mảng nến mà chart đang giữ.
   */
  triggerTime: number;
  /** `null` ở nhánh quét: nhánh đó không dùng key ở bất kỳ khâu nào. */
  key: KeyVolumeLevel | null;
  /**
   * Số nến của CỤM ĐẢO CHIỀU dựng ra order block: 2 (nhấn chìm/in3), 3 (3-bar
   * reversal), hoặc 1 ở nhánh quét (chính cây nến quét).
   */
  clusterBars: number;
  /** Mép THÂN NẾN dưới của cả cụm — min(open, close), râu không tính. */
  obLow: number;
  /** Mép THÂN NẾN trên của cả cụm — max(open, close), râu không tính. */
  obHigh: number;
  /**
   * Mép THUẬN CHIỀU của hộp: `obHigh` với long, `obLow` với short. Engine KHÔNG
   * đặt lệnh ở mức này nữa — giá vào là giá ĐÓNG của nến bật ra khỏi hộp. Giữ
   * lại vì chart/journal cần vẽ đúng cái mép mà giá phải đóng vượt qua.
   */
  obEntryEdge: number;
  /**
   * Gốc của SL. Nhánh quét: cực trị CÁI RÂU vừa quét. Nhánh 2: cực trị cửa sổ
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
  triggerVolumeRatio: number;
  score: number;
}

export type KeyVolumeExitReason =
  | "stop"
  | "positive-stop"
  | "target"
  | "entry-invalid"
  | "key-invalid"
  | "no-follow-through";

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
  partialTaken: boolean;
  /** `null` khi lệnh đến từ nhánh quét — nhánh đó không có key. */
  keyPrice: number | null;
  keyVolumeRatio: number | null;
  triggerVolumeRatio: number;
}

export interface KeyVolumeDiagnostics {
  m15Levels: number;
  keyTouches: number;
  touchVolumeConfirmed: number;
  /** Số nến quét-và-giành-lại phát hiện được, kể cả nến quét cả hai đầu. */
  sweeps: number;
  /** Cụm đảo chiều HỢP LỆ: đã qua cả cửa "key trong hộp". */
  candlePatterns: number;
  /** Cụm dựng được nhưng đường key nằm NGOÀI thân hộp -> bỏ. */
  rejectedKeyOutsideBlock: number;
  /** Nến chạm key hợp lệ nhưng trước đó giá chưa từng RỜI key -> không mở setup. */
  rejectedNoDeparture: number;
  plans: number;
  sweepBranchPlans: number;
  volumeBranchPlans: number;
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
  rejectedRisk: number;
  rejectedRoom: number;
  rejectedFirstTouch: number;
  rejectedDouble: number;
  rejectedSession: number;
}

export interface KeyVolumeResult {
  trades: KeyVolumeTrade[];
  plans: KeyVolumeEntryPlan[];
  levels: KeyVolumeLevel[];
  diagnostics: KeyVolumeDiagnostics;
}

interface KeyTouchSetup {
  direction: KeyVolumeDirection;
  key: KeyVolumeLevel;
  touchIndex: number;
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
  /** Index nến ĐẦU TIÊN mà hộp đã hết hạn (không còn vào lệnh được). */
  expiresAtIndex: number;
}

interface OpenPosition {
  plan: KeyVolumeEntryPlan;
  entryIndex: number;
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
      expiresAt: confirmedAt + params.keyMaxAgeDays * TF_MS["1d"],
      volumeRatio,
    });
  }
  return levels;
}

export function isKeyVolumeLevelActive(level: KeyVolumeLevel, time: number): boolean {
  return level.confirmedAt <= time && time <= level.expiresAt;
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
 * CỤM NẾN ĐẢO CHIỀU + ORDER BLOCK, một luật duy nhất trong cửa sổ 3 nến.
 *
 * `#50 SFP` từng liệt kê ba mô hình (nhấn chìm, in3, 3-bar reversal); luật này
 * thu về đúng một tiêu chí đo được: THÂN cây đảo chiều nhấn chìm THÂN mấy nến
 * liền trước. Số nến bị nhấn chìm quyết định luôn hộp:
 *
 *   nhấn chìm 2 nến -> hộp là min/max open-close của ĐÚNG 2 nến BỊ nhấn chìm
 *   nhấn chìm 1 nến -> hộp là THÂN cây ĐANG nhấn chìm (chính cây đảo chiều)
 *   không nhấn chìm nến nào -> `null`, bỏ setup
 *
 * Cây đảo chiều phải đúng màu (LONG cần xanh, SHORT cần đỏ). Màu các nến bị
 * nhấn chìm KHÔNG bị ràng buộc: "nhấn chìm 2 nến trước" không nói gì về màu, và
 * đòi cả hai cùng màu ngược sẽ gần như không bao giờ khớp.
 */
export interface ReversalOrderBlock {
  obLow: number;
  obHigh: number;
  /** Số nến liền trước bị THÂN cây đảo chiều nhấn chìm: 2 hoặc 1. */
  engulfed: number;
  /** Tổng số nến của cụm, tính cả cây đảo chiều: 3 hoặc 2. */
  clusterBars: number;
}

/** Thân nến `index` có trùm trọn thân nến `target` không. */
export function bodyEngulfs(candles: Candle[], index: number, target: number): boolean {
  if (target < 0) return false;
  const low = Math.min(candles[index].open, candles[index].close);
  const high = Math.max(candles[index].open, candles[index].close);
  return low <= Math.min(candles[target].open, candles[target].close)
    && high >= Math.max(candles[target].open, candles[target].close);
}

export function reversalOrderBlock(
  candles: Candle[],
  index: number,
  direction: KeyVolumeDirection,
): ReversalOrderBlock | null {
  if (index < 2) return null;
  const trigger = candles[index];
  const rightColour = direction === "long"
    ? trigger.close > trigger.open
    : trigger.close < trigger.open;
  if (!rightColour) return null;
  if (!bodyEngulfs(candles, index, index - 1)) return null;

  if (bodyEngulfs(candles, index, index - 2)) {
    // Nhấn chìm CẢ HAI: hộp là vùng vừa bị ăn, không phải cây đi ăn.
    return { ...orderBlockFromCluster(candles, index - 1, 2), engulfed: 2, clusterBars: 3 };
  }
  // Chỉ nhấn chìm một: hộp là thân chính cây đang nhấn chìm.
  return {
    obLow: Math.min(trigger.open, trigger.close),
    obHigh: Math.max(trigger.open, trigger.close),
    engulfed: 1,
    clusterBars: 2,
  };
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
  for (let i = Math.max(0, touchIndex - lookback); i < touchIndex; i++) {
    const distance = atrMult * atr[i];
    if (!(distance > 0)) continue;
    if (candles[i].low > keyPrice + distance || candles[i].high < keyPrice - distance) return true;
  }
  return false;
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

/**
 * Stop hunt: nến vượt qua cực trị `lookback` nến trước rồi ĐÓNG lại bên trong —
 * râu ăn hết thanh khoản của những stop đặt ngoài mức đó rồi trả giá về. Mức bị
 * quét còn phải qua `isProminentExtreme`.
 */
export function sweptAndReclaimed(
  candles: Candle[],
  index: number,
  direction: KeyVolumeDirection,
  lookback: number,
  prominenceBars = 0,
): boolean {
  if (index < lookback) return false;
  const field = direction === "long" ? "low" : "high";
  const extremeIndex = rangeExtremeIndex(candles, index - lookback, index, field);
  const level = candles[extremeIndex][field];
  const swept = direction === "long"
    ? candles[index].low < level && candles[index].close > level
    : candles[index].high > level && candles[index].close < level;
  if (!swept) return false;
  return isProminentExtreme(candles, extremeIndex, field, prominenceBars);
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
  const volumes = confirm.map(quoteVolume);
  const swings = findSwings(confirm, params.swingPivotLeft, params.swingPivotRight);
  const used = new Set<string>();
  const touchCounts = new Map<string, number>();
  const plans: KeyVolumeEntryPlan[] = [];
  let setup: KeyTouchSetup | null = null;
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
    // Không key, không nến chạm, không volume, không mô hình nến xác nhận:
    // thủng cực trị một ngày rồi đóng lại trong biên là đủ bóp cò.
    if (params.enableSweepBranch && readyIndex < confirm.length) {
      const sweptLow = sweptAndReclaimed(
        confirm, i, "long", params.sweepLookback, params.sweepProminenceBars,
      );
      const sweptHigh = sweptAndReclaimed(
        confirm, i, "short", params.sweepLookback, params.sweepProminenceBars,
      );
      if (sweptLow || sweptHigh) diagnostics.sweeps++;
      // Nến nuốt trọn cả hai đầu rồi đóng vào trong không nói được chiều nào.
      if (sweptLow !== sweptHigh) {
        if (!passesSession(trigger, params)) diagnostics.rejectedSession++;
        else {
          const direction: KeyVolumeDirection = sweptLow ? "long" : "short";
          // SL bám đúng CÁI RÂU vừa tạo ra cú quét, không phải cực trị cửa sổ.
          // Chỉ còn dùng khi `stopMode` KHÁC "order-block".
          const wick = direction === "long" ? trigger.low : trigger.high;
          const triggerVolumeRatio = volumeRatioAt(i);
          // Nhánh quét không có cụm nến; "hộp" của nó là thân đúng cây nến quét.
          const ob = orderBlockFromCluster(confirm, i, 1);
          // Hộp của nhánh quét cũng phải được giá bỏ lại phía sau mới tính.
          if (!departedFromBlock(
            confirm, i + 1, params.obDepartBars, direction, ob.obLow, ob.obHigh, params.obDepartMode,
          )) {
            diagnostics.rejectedDepart++;
          } else {
            plans.push({
              id: `sweep:${direction}:${trigger.openTime}`,
              branch: "sweep-reclaim",
              direction,
              readyIndex,
              triggerTime: trigger.openTime,
              key: null,
              clusterBars: 1,
              obLow: ob.obLow,
              obHigh: ob.obHigh,
              obEntryEdge: orderBlockEntry(ob, direction),
              structuralStop: wick,
              patternStop: wick,
              // Quét thanh khoản bên này thì chạy sang cụm thanh khoản bên kia.
              sweepTarget: direction === "long"
                ? rangeMax(confirm, i - params.sweepLookback, i, "high")
                : rangeMin(confirm, i - params.sweepLookback, i, "low"),
              triggerVolumeRatio,
              score: triggerVolumeRatio,
            });
            diagnostics.sweepBranchPlans++;
          }
        }
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
            setup = { direction: touch.direction, key: touch.key, touchIndex: i };
          }
        }
      }
    }
    if (!setup || !params.enableVolumeReversalBranch) continue;

    const cluster = reversalOrderBlock(confirm, i, setup.direction);
    if (!cluster) continue;
    // Đảo chiều phải xảy ra NGAY TẠI key: đường key chạy xuyên thân hộp. Không
    // khoá `setup` lại — cụm sau trong cùng cửa sổ chờ vẫn được xét.
    if (
      params.requireKeyInsideBlock
      && (setup.key.price < cluster.obLow || setup.key.price > cluster.obHigh)
    ) {
      diagnostics.rejectedKeyOutsideBlock++;
      continue;
    }
    diagnostics.candlePatterns++;

    const triggerVolumeRatio = volumeRatioAt(i);
    if (triggerVolumeRatio < params.reversalVolumeMult) continue;

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
        cluster.obLow, cluster.obHigh, params.obDepartMode,
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
        clusterBars: cluster.clusterBars,
        obLow: cluster.obLow,
        obHigh: cluster.obHigh,
        obEntryEdge: orderBlockEntry(cluster, setup.direction),
        structuralStop,
        patternStop: setup.direction === "long" ? trigger.low : trigger.high,
        sweepTarget: null,
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
  if (!enabled || previousReason !== "positive-stop") return false;
  // #23/#43: sau stop dương, giá chạm key lần nữa và kích volume lần nữa là vào
  // lại — tác giả coi đây là thao tác thường quy, không đòi cú quét sâu hơn.
  if (mode === "volume-retouch") return true;
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
): number {
  if (!CONFIG.costs.enabled) return 0;
  const riskFraction = Math.abs(entry - stop) / entry;
  if (!(riskFraction > 0)) return 0;
  const feeFraction = ((CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100) * 2;
  const periods = (from: number, to: number) =>
    Math.max(0, Math.floor(to / FUNDING_INTERVAL_MS) - Math.floor(from / FUNDING_INTERVAL_MS));
  const fundingPeriods = partialTime == null
    ? periods(entryTime, exitTime)
    : 0.5 * periods(entryTime, partialTime) + 0.5 * periods(entryTime, exitTime);
  const fundingFraction = fundingPeriods * (CONFIG.costs.fundingPer8hPct / 100);
  return (feeFraction + fundingFraction) / riskFraction;
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
  const costR = tradeCostR(position.entry, position.initialStop, entryTime, exitTime, partialTime);
  return {
    symbol,
    planId: position.plan.id,
    dir: direction,
    branch: position.plan.branch,
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

function simulatePlans(
  symbol: string,
  confirm: Candle[],
  plans: KeyVolumeEntryPlan[],
  levels: KeyVolumeLevel[],
  diagnostics: KeyVolumeDiagnostics,
  params: KeyVolumeParams,
): KeyVolumeTrade[] {
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
  let cooldownUntil = -1;

  for (let i = 20; i < confirm.length; i++) {
    const candle = confirm[i];

    if (position) {
      const held = i - position.entryIndex;
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
          position.realizedR += params.partialFraction * position.partialR;
          position.remaining -= params.partialFraction;
          position.partialIndex = i;
          // Sau TP1, phần còn lại không được quay về full initial risk. Đây là
          // cách tối thiểu để số hoá "chốt 1/2 rồi giữ bằng stop dương".
          position.stop = direction === "long"
            ? Math.max(position.stop, position.entry)
            : Math.min(position.stop, position.entry);
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
        if (entryInvalid) {
          exitPrice = candle.close;
          reason = "entry-invalid";
        } else if (
          position.plan.key
          && invalidatedByClose(candle, position.plan.key, direction)
        ) {
          exitPrice = candle.close;
          reason = "key-invalid";
        } else if (
          params.requireFollowThrough
          && held >= params.followThroughBars
          && position.maxFavorable < params.minFollowThroughR * position.risk
        ) {
          exitPrice = candle.close;
          reason = "no-follow-through";
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
      continue;
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
      // Hộp VỪA trang bị cũng phải qua đúng phép chấm trên: `readyIndex` là cây
      // đầu tiên cửa rời hộp KHÔNG phủ, nên nó hoàn toàn có thể là cây đóng
      // xuyên qua hộp. Hộp chết ngay khi sinh không được tính là "đã quay lại".
      diagnostics.boxesArmed++;
      if (boxIsDead(plan, candle)) diagnostics.boxesBroken++;
      else {
        armed.push({
          plan,
          retouched: false,
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
      // Nhiều hộp cùng bật ra trên một cây: lấy hộp có score cao nhất.
      if (!confirmed || box.plan.score > confirmed.plan.score) confirmed = box;
    }

    if (!confirmed || i < cooldownUntil) continue;

    // ── Giá vào chỉ biết được Ở ĐÂY, nên mọi cửa cũng chấm ở đây ─────────
    // Vào ở GIÁ ĐÓNG nến xác nhận. Nến này đã đóng trọn vẹn nên dùng ATR của
    // chính nó KHÔNG phải nhìn trước — khác hẳn luật lệnh chờ cũ, nơi lệnh đặt
    // và khớp có thể rơi vào cùng một cây.
    const plan = confirmed.plan;
    const dir = plan.direction;
    const key = plan.key;
    const entry = candle.close;
    const entryAtr = atr[i];
    // "order-block": vào bằng nến bật ra khỏi hộp thì thoát ngay ngoài mép KIA
    // của chính hộp đó — luật duy nhất áp cho CẢ HAI nhánh. Ba mode còn lại là
    // luật cũ giữ để ablation, và ở đó nhánh quét quay về SL ngoài râu quét.
    const stopReference = params.stopMode === "order-block"
      ? (dir === "long" ? plan.obLow : plan.obHigh)
      : plan.branch === "sweep-reclaim" || !key
        ? plan.structuralStop
        : params.stopMode === "confirmation"
          ? plan.patternStop
          : params.stopMode === "key"
            ? (dir === "long" ? key.zoneLow : key.zoneHigh)
            : plan.structuralStop;
    const stop = dir === "long"
      ? stopReference - params.stopBufferAtr * entryAtr
      : stopReference + params.stopBufferAtr * entryAtr;
    const risk = Math.abs(entry - stop);
    const riskFraction = risk / entry;
    if (
      !(risk > 0)
      || riskFraction > params.maxStopPct
      || (dir === "long" ? stop <= 0 || stop >= entry : stop <= entry)
    ) {
      diagnostics.rejectedRisk++;
      continue;
    }
    const opposing = planTarget(plan, levels, candle.openTime, entry);
    const opposingR = opposing == null ? Infinity : Math.abs(opposing - entry) / risk;
    if ((opposing == null && params.requireStructuralTarget) || opposingR < params.minRR) {
      diagnostics.rejectedRoom++;
      continue;
    }
    const targetR = resolveTargetR(opposing == null ? null : opposingR, params);
    const target = dir === "long" ? entry + targetR * risk : entry - targetR * risk;

    position = {
      plan,
      entryIndex: i,
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
    armed.splice(armed.indexOf(confirmed), 1);
    diagnostics.entries++;
    // KHÔNG chạy lại cây này qua nhánh quản lý vị thế. Giá vào là giá ĐÓNG của
    // chính nó, nên 15 phút rủi ro đầu tiên là cây KẾ TIẾP; chấm SL/TP trên
    // high/low của cây đã đóng rồi mới vào là nhìn trước quá khứ của chính mình.
  }

  diagnostics.boxesUnresolved += armed.length;

  return trades;
}

/**
 * `candles` phải là nến M15 ĐÃ ĐÓNG. Engine không gộp khung nữa — người gọi tự
 * lo dữ liệu đúng khung, và tự cắt cây cuối chưa đóng.
 */
export function runKeyVolume(
  symbol: string,
  candles: Candle[],
  params: KeyVolumeParams = KEY_VOLUME_CONFIG,
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
  const levels = detectKeyVolumeLevels(confirm, params.confirmTf, params);
  const diagnostics: KeyVolumeDiagnostics = {
    m15Levels: levels.length,
    keyTouches: 0,
    touchVolumeConfirmed: 0,
    sweeps: 0,
    candlePatterns: 0,
    rejectedKeyOutsideBlock: 0,
    rejectedNoDeparture: 0,
    plans: 0,
    sweepBranchPlans: 0,
    volumeBranchPlans: 0,
    entries: 0,
    rejectedDepart: 0,
    boxesArmed: 0,
    boxesRetouched: 0,
    boxesBroken: 0,
    boxesExpired: 0,
    boxesUnresolved: 0,
    rejectedRisk: 0,
    rejectedRoom: 0,
    rejectedFirstTouch: 0,
    rejectedDouble: 0,
    rejectedSession: 0,
  };
  const plans = buildEntryPlans(confirm, levels, diagnostics, params);
  const trades = simulatePlans(symbol, confirm, plans, levels, diagnostics, params);
  return { trades, plans, levels, diagnostics };
}
