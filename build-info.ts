/**
 * build-info.ts — DANH TÍNH CỦA CODE ĐANG CHẠY, để `/health` chứng minh được deploy từ Telegram.
 *
 * VÌ SAO CẦN, dù đã có fingerprint luật: `turtleConfigLine()`/`fastConfigLine()` chỉ hash các THAM SỐ
 * LUẬT. Mọi thay đổi CODE không đụng tham số — ví dụ lần thêm đo trượt giá ở chiều thoát — đều để
 * fingerprint y nguyên. Nghĩa là fingerprint không đổi tương thích với CẢ HAI khả năng: "deploy đúng"
 * và "chưa deploy gì cả". Đúng khoảng trống đó đã làm mất một vòng lặp xác minh ngày 12/08/2026.
 *
 * Hai mã bổ sung cho nhau, đừng lẫn:
 *   fingerprint luật → LUẬT nào đang chạy
 *   BUILD_ID         → CODE nào đang chạy
 *
 * BUILD_ID = 7 ký tự đầu của sha256 trên toàn bộ file `.ts` lúc build (xem Dockerfile). Dùng hash
 * SOURCE chứ không dùng git SHA vì `.git` bị loại khỏi build context (`.dockerignore`, 148MB) — và vì
 * hash source còn ĐÚNG HƠN: nó phản ánh code thật đã build, kể cả thay đổi chưa commit.
 *
 * Chạy bằng ts-node (không qua esbuild) thì hai define không tồn tại ⇒ trả "dev"/"local". Dùng `typeof`
 * để tránh ReferenceError khi biến toàn cục không được khai báo.
 */
declare const __BUILD_ID__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

export const BUILD_ID: string = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__! : "dev";
export const BUILD_TIME: string = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__! : "local";

/** Một dòng cho `/health`. `dev · local` = đang chạy trực tiếp bằng ts-node, KHÔNG phải bundle deploy. */
export function buildLine(): string {
  return `\`${BUILD_ID}\` · build ${BUILD_TIME}`;
}
