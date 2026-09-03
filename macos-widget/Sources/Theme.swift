import AppKit
import SwiftUI

/// Token lấy nguyên từ public/styles.css của dashboard — một hệ màu duy nhất.
enum T {
    static let text      = Color.white.opacity(0.96)
    static let textSoft  = Color.white.opacity(0.68)
    static let muted     = Color.white.opacity(0.44)
    static let dim       = Color.white.opacity(0.28)

    /// Nền của khối lồng trong. Tahoe phân nhóm bằng VẬT LIỆU, không bằng vạch 1px.
    static let innerFill = Color.white.opacity(0.055)
    static let chipFill  = Color.white.opacity(0.10)
    static let trackFill = Color.black.opacity(0.26)
    static let green     = Color(hex: 0x4EE2A1)
    static let red       = Color(hex: 0xFF6B70)
    static let blue      = Color(hex: 0x65A9FF)
    static let amber     = Color(hex: 0xF3BA63)

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }

    /// Màu của sàn — giúp quét mắt, không phải trang trí.
    static func venue(_ id: String) -> Color { id == "binance" ? amber : blue }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// Số kiểu Việt: dấu phẩy thập phân.
enum Fmt {
    private static func dec(_ v: Double, _ places: Int) -> String {
        String(format: "%.\(places)f", v).replacingOccurrences(of: ".", with: ",")
    }
    static func money(_ v: Double, sign: Bool = false) -> String {
        let s = sign && v > 0 ? "+" : (v < 0 ? "-" : "")
        return "\(s)$\(dec(abs(v), 2))"
    }
    static func pct(_ v: Double, sign: Bool = false, places: Int = 2) -> String {
        let s = sign && v > 0 ? "+" : (v < 0 ? "-" : "")
        return "\(s)\(dec(abs(v) * 100, places))%"
    }
    static func r(_ v: Double) -> String {
        "\(v >= 0 ? "+" : "-")\(dec(abs(v), 2)) R"
    }
    static func price(_ v: Double) -> String {
        dec(v, v >= 10 ? 2 : (v >= 1 ? 3 : 4))
    }
    /// "2 phút trước", "3 ngày trước" — đủ thô để liếc, không cần chính xác giây.
    static func ago(_ ms: Double, now: Double) -> String {
        let s = max(0, (now - ms) / 1000)
        if s < 90 { return "\(Int(s)) giây trước" }
        if s < 5400 { return "\(Int(s / 60)) phút trước" }
        if s < 172_800 { return "\(Int(s / 3600)) giờ trước" }
        return "\(Int(s / 86_400)) ngày trước"
    }
    static func days(_ d: Double) -> String {
        d < 1 ? "\(Int(d * 24)) giờ" : "\(Int(d)) ngày"
    }
}

/// Màu cho ô THANH MENU. Thanh menu sáng hay tối tuỳ hình nền + giao diện hệ thống,
/// nên màu semantic phải đổi theo, không dùng cùng màu với panel tối.
enum MenuColor {
    static let green = dynamic(light: 0x0B7A4B, dark: 0x4EE2A1)
    static let red = dynamic(light: 0xC02B31, dark: 0xFF6B70)
    static let amber = dynamic(light: 0x8A5A00, dark: 0xF3BA63)
    static let gray = NSColor.secondaryLabelColor

    private static func dynamic(light: UInt32, dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(rgb: isDark ? dark : light)
        }
    }
}

extension NSColor {
    convenience init(rgb: UInt32) {
        self.init(
            srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}


// MARK: - Kính

extension View {
    /// Nền kính cho bề mặt lớn. macOS 26 có Liquid Glass thật; cũ hơn rơi về vật liệu mờ.
    @ViewBuilder
    func glassSurface(_ radius: CGFloat) -> some View {
        if #available(macOS 26.0, *) {
            self.glassEffect(.regular, in: .rect(cornerRadius: radius))
        } else {
            self.background(
                .ultraThinMaterial,
                in: RoundedRectangle(cornerRadius: radius, style: .continuous)
            )
        }
    }

    /// Khối lồng trong. Bán kính phải ĐỒNG TÂM: bán kính ngoài trừ padding.
    func innerGlass(_ radius: CGFloat) -> some View {
        background(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(T.innerFill)
                .overlay(
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5)
                )
        )
    }

    /// Số liệu trên kính cần bóng chữ để đọc được khi nền sau đổi sáng tối.
    func numeral() -> some View {
        shadow(color: .black.opacity(0.34), radius: 2, y: 1)
    }
}
