# Transcript gốc — 6 video Key Volume (2026-08-16)

Transcript thô (Whisper `small`, tiếng Việt, chạy CPU) từ 6 video cục bộ ở
`~/Downloads/dream/`, dùng để dựng báo cáo minh hoạ
[Giải Phẫu Key Volume](https://claude.ai/code/artifact/e6f90f8b-6eea-4dcd-8db0-0efa374e57b7).

| File | Video nguồn | Nội dung |
|---|---|---|
| `09-setup-trade-cot-loi-9-vi-du.txt` | `9-SETUP-TRADE-COT-LOI-THEO-HE-THONG-KEYV_Media_8zpC59b-zA0_001_1080p.mp4` | 9 ví dụ setup liên tiếp trên BTC/Vàng |
| `12-setup-trade-keyvolume-fomc.txt` | `12-SETUP-TRADE-keyvolume-FX-DREAM-TRADIN_Media_rf931k1iUs4_001_1080p.mp4` | Case FOMC + thesis "Market Maker bảo vệ chỗ đã vào lệnh" |
| `21-keyvolume-than-thanh-tuan-vang-usdjpy.txt` | `21-Keyvolume-than-thanh-Trade-5-nam-van-_Media_Wvu2pq9QBoA_001_1080p.mp4` | Tự chấm điểm 2 cặp trong tuần: Vàng (long) + USDJPY (short theo macro) |
| `22-setup-ftr-ob-bulltrap-volume.txt` | `YTSave_YouTube_Setup-FTR-x-OB-x-Bulltrap-x-Volume-keyvo_Media_b-zNRg90nQw_001_1080p.mp4` | Model nâng cao khác Key Volume: FTR + double-top + RSI phân kỳ + Order Block, live-trade BTC M15 short |
| `23-short-btc-keyvolume-orderblock.txt` | `YTDown.com_YouTube_Phan-tich-vao-lenh-theo-keyvolume-hoc-do_Media_qgyu-Bvccb8_001_720p.mp4` | Short dọc (TikTok @fxdreamtrading) — BTC/USDT M15, Key Volume hợp lưu Order Block, SL dưới OB |
| `24-short-gold-keyvolume-breakin-retest.txt` | `YTSave_YouTube_Vao-lenh-theo-keyvolume-Hoc-doc-volume-f_Media_7tc3aUPuPTg_001_1080p.mp4` | Short dọc — Vàng M15, Volume Đột Biến + Order Block + "Break in + Retest" |

**Chất lượng ASR — đọc có phê phán trước khi trích dẫn lại:** model `small` bị lẫn nhiều
thuật ngữ, ví dụ `"Market Maker"` → `"Makyamaka"`/`"Maka Maka"`, `"Order Block"` →
`"order top"`/`"o đập lóc"`, `"Big Boy"` → `"BitBoy"`, `"các bạn"` đôi chỗ ra
`"các vợ"`, và trong `21-...txt` dòng 39-46 `"giá đang xệ"` (đà tăng yếu dần,
sắp gãy xu hướng) bị nghe nhầm thành `"giá đang sợi"`. Không dùng trực tiếp làm
nguồn trích dẫn nguyên văn mà không đối chiếu lại với video gốc hoặc ít nhất với
ngữ cảnh câu xung quanh.

`24-...txt` dòng 9 có từ chỉ hướng lệnh không rõ nghĩa: `"Là shock theo cái order
block"` — có thể là "short" (xọt) bị nghe sai, nhưng hình ảnh chart lại cho thấy
giá TĂNG mạnh sau đó (long mới khớp). Đã không dùng từ này trong báo cáo, chỉ mô
tả theo hướng giá thực tế quan sát được trên chart.

Không có timestamp (chỉ xuất `--output_format txt`, không có `.srt`) — muốn tra lại
đúng thời điểm trong video phải chạy lại whisper với `--output_format srt`.
