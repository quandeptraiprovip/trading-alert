# Widget giao dịch macOS

Hiện tình trạng giao dịch Binance + MEXC ngay trên thanh menu. Không hiện tên
phương pháp ở bất kỳ đâu — vị thế chỉ nhận diện bằng sàn, mã và hướng.

Thứ tự đọc, từ trên xuống: **máy còn chạy không → còn bao nhiêu tiền →
đang mở gì → còn cách stop bao xa.**

## Hai lớp

| Lớp | Ở đâu | Trạng thái |
|---|---|---|
| Nguồn dữ liệu | `widget-feed.ts` + `widget-server.ts` (thư mục gốc) | Chạy được |
| Ô thanh menu + panel | `macos-widget/Sources/` → `TradingWidget.app` | Chạy được |
| Widget màn hình S/M/L | `macos-widget/WidgetExtension/` | Dựng xong, đã đăng ký với hệ |

Bí mật API **chỉ** nằm ở tiến trình Node. App Swift không giữ khoá nào —
nó chỉ đọc `http://127.0.0.1:3849/widget.json`.

## Chạy

```bash
npm run widget                      # nguồn dữ liệu, cổng 3849, CHỈ loopback
open macos-widget/TradingWidget.app # ô thanh menu
```

Bấm ô: mở panel. Bấm phải: menu Làm mới / Bảng điều khiển / Thoát.
Panel tự làm mới mỗi 20 giây.

Nút **Bảng điều khiển** mở `DASHBOARD_URL` (mặc định `127.0.0.1:3848`). Nguồn dữ liệu
thử TCP cổng đó mỗi lần đọc và trả về `dashboardUp`; nếu không ai nghe thì panel hiện
chữ xám *"Bảng điều khiển chưa chạy"* thay vì mở ra một tab chết. Bật nó bằng:

```bash
npm run dashboard
```

Dựng lại app sau khi sửa code Swift:

```bash
cd macos-widget && ./build.sh        # cần Command Line Tools, KHÔNG cần Xcode
```

## Sức khoẻ hệ thống được xác định thế nào

Không cần sửa gì trong bot. Ba tín hiệu sẵn có, không tín hiệu nào cần bot hợp tác:

1. `docker inspect swing-bot` — container còn chạy không (đổi bằng `WIDGET_BOT_CONTAINER`).
2. `lastBarTime` mới nhất trong các state file — quá 2 nến 4h chưa nhích thì là **trễ nhịp**
   (đổi bằng `WIDGET_STALE_MS`).
3. mtime của state file — lần cuối bot ghi được gì.

Docker tắt hoặc container chết → **Đã dừng**, và ô thanh menu **che luôn số dư**,
chỉ hiện `Dừng N ngày`. Cảnh báo phải thắng thông tin: một widget đẹp lúc chạy tốt
mà im lặng lúc máy chết thì vô dụng.

## Stop lấy từ đâu

Ưu tiên **lệnh chờ trên sàn** (`stopSource: "exchange"`) vì đó là stop sẽ thật sự
khớp; state của bot chỉ là ý định. Bên Binance stop nằm ở *algo order*
(`orderType: STOP_MARKET`, đọc qua `/fapi/v1/openAlgoOrders`) chứ không ở
`openOrders` — đọc thiếu chỗ này sẽ báo động giả "vị thế không có stop".

Không tìm thấy stop ở đâu cả → `unprotectedCount` tăng, panel hiện dòng đỏ
`KHÔNG tìm thấy stop cho vị thế này`.

## Thanh "cách stop"

Thang cố định 0–10%. Thanh dài = còn nhiều đệm, thanh ngắn = sắp bị quét.
Dưới 1,5% thì chuyển hổ phách. Đọc bằng mắt, không phải nhẩm giá trừ mức stop.

## Mức đổi trong ngày

`widget-equity-history.json` ghi lần đọc **đầu tiên** của mỗi ngày (giờ VN) làm mốc.
Nếu khởi động server giữa ngày thì mốc là giữa ngày → mức đổi sẽ nhỏ hơn thực tế.
Ngày đầu tiên luôn bằng 0.

## Widget màn hình S/M/L

`build.sh` dựng cả extension và nhúng vào app, **không cần tạo project Xcode**:

```
TradingWidget.app/
  Contents/MacOS/TradingWidget                        ← app thanh menu
  Contents/PlugIns/TradingWidgetExt.appex             ← widget S/M/L
```

Cài vào `/Applications` rồi đặt widget:

```bash
./build.sh && ./install.sh
open /Applications/TradingWidget.app
```

Bấm phải màn hình nền → **Sửa widget** (hoặc Trung tâm thông báo → Sửa widget).
Nhóm app tên **Trading Widget**, widget bên trong tên **Tình trạng giao dịch**.

Kiểm tra hệ đã thấy widget chưa:

```bash
pluginkit -m -v -p com.apple.widgetkit-extension | grep -i trading
```

Nếu không hiện trong thư viện widget: chép app vào `/Applications` rồi mở lại một lần
(Launch Services đôi khi không nhận app nằm ngoài các thư mục chuẩn).

### Ba thứ khiến widget KHÔNG hiện trong thư viện

Bundle dựng tay thiếu những thứ Xcode vẫn tự làm. Cả ba đều đã xử trong `build.sh`
và `install.sh`:

1. **Thiếu metadata nền tảng.** `CFBundleSupportedPlatforms`, `DTPlatformName`,
   `DTSDKName`, `DTSDKBuild`, `DTXcodeBuild`, `BuildMachineOSBuild` — widget của Apple
   đều mang, bundle tự dựng thì không. `build.sh` nhúng chúng từ giá trị thật của SDK.
2. **App nằm ngoài `/Applications`.** Launch Services đôi khi không nhận. `install.sh`
   chép vào đó và gọi `lsregister`.
3. **`LSUIElement` trong Info.plist.** Cờ này ẩn app khỏi Launch Services, mà thư viện
   widget lại liệt kê widget **theo app** — ẩn app thì ẩn luôn widget. Đã bỏ khỏi plist;
   Dock icon vẫn được ẩn ở runtime bằng `NSApp.setActivationPolicy(.accessory)`, hành vi
   y hệt (kiểm bằng `lsappinfo` → `ApplicationType="UIElement"`).

Kiểm tra nhanh:

```bash
pluginkit -m -i local.trading.widget.ext -vvv     # hệ thấy chưa, trỏ vào đâu
codesign -dvvv /Applications/TradingWidget.app/Contents/PlugIns/TradingWidgetExt.appex
```

### Ký ad-hoc — nghi phạm còn lại

Máy này **không có chứng chỉ ký nào** (`security find-identity -v -p codesigning`
→ 0 valid), nên app và extension ký ad-hoc: `Signature=adhoc`, `TeamIdentifier=not set`.

Nếu widget **vẫn không hiện** sau ba mục trên thì đây là nghi phạm còn lại — WidgetKit
kiểm chữ ký khi quyết định có nạp extension hay không. Cách gỡ: mở Xcode →
**Settings → Accounts** → thêm Apple ID (miễn phí, không cần tài khoản trả phí) →
Xcode tạo chứng chỉ *Apple Development*. Sau đó ký lại:

```bash
security find-identity -v -p codesigning     # lấy tên identity
# rồi đổi `--sign -` trong build.sh thành `--sign "Apple Development: ..."`
```

Ký ad-hoc dù sao cũng **không phân phát được** sang máy khác.

### Ba khổ hiện gì

| Khổ | Nội dung |
|---|---|
| Small 155×155 | Sức khoẻ · vốn · mức đổi ngày · số vị thế + tổng R (không có R thì hiện $) |
| Medium 329×155 | Thêm risk mở, đệm stop gần nhất, và 2 dòng vị thế |
| Large 329×345 | Mọi vị thế (trần 3, quá thì ghi *+N nữa*) kèm thanh cách stop + thanh risk |

Cùng một sàn thì số vốn chỉ ghi ở dòng đầu, không lặp lại từng dòng.

**Giới hạn thật của WidgetKit:** hệ chỉ cho làm mới vài chục lần mỗi ngày, nên widget
màn hình là bề mặt **liếc** (đặt 15 phút/lần). Muốn theo sát từng phút thì dùng ô thanh
menu — nó poll 20 giây và không bị hạn mức đó.

Extension bị sandbox (app extension buộc phải vậy), nên nó mang entitlement
`com.apple.security.network.client` để gọi được `127.0.0.1`. Thiếu entitlement này
thì nó im lặng không lấy được dữ liệu, không báo lỗi gì.
## Kích thước panel — đừng đo tay

`NSHostingController` được tạo **một lần** và dùng `sizingOptions = [.preferredContentSize]`;
state đi vào panel qua `PanelModel: ObservableObject`.

Bản đầu làm sai theo hai cách cộng dồn: đo `fittingSize` trên view **chưa gắn window**
rồi kẹp `max(160, h)`, và tạo `NSHostingController` MỚI gán vào popover **đang mở**.
Vì `refresh()` là async, lúc đo state còn là `.loading` (~111px) → popover bị chốt 160px,
rồi 438px nội dung thật bị nhồi vào đó. Phần co giãn biến mất, chỉ còn thanh chân
cao cố định 40px hiện ra.

Chiều cao báo ra hiện đi theo nội dung: `.loading` 120px · `.offline` 135px ·
`.loaded` (2 vị thế) 438px.
## Biến môi trường

| Biến | Mặc định | Nghĩa |
|---|---|---|
| `WIDGET_PORT` | `3849` | Cổng nguồn dữ liệu (cả server và app đọc) |
| `WIDGET_CACHE_MS` | `5000` | Nhiều client không nhân số lần gọi sàn lên |
| `WIDGET_BOT_CONTAINER` | `swing-bot` | Container để hỏi liveness |
| `WIDGET_STALE_MS` | `28800000` | Quá bao lâu không có nến mới thì coi là trễ nhịp |
| `DASHBOARD_URL` | `http://127.0.0.1:3848` | Nút "Bảng điều khiển" mở cái gì |
| `MAX_PORTFOLIO_RISK_PCT` | `20` | Trần của thanh risk (dùng chung với bot) |

## Thiết kế

Bản thiết kế đã chốt: <https://claude.ai/code/artifact/a31ffaeb-f9f3-421b-bef5-98e244eee205>

Màu và token lấy nguyên từ `public/styles.css` để widget và dashboard là một hệ.
Riêng ô thanh menu dùng màu semantic **đổi theo giao diện sáng/tối** — thanh menu
có thể sáng tuỳ hình nền, màu xanh của dashboard tối sẽ không đọc được ở đó.
