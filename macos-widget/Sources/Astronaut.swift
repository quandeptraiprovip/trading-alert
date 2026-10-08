import SwiftUI

// Phi hành gia — nhân vật nói trạng thái bằng dáng người, không bằng chữ.
// Vẽ trên lưới 120×120 rồi co theo khung. Một nguồn cho cả ba bề mặt:
//   • panel thanh menu + cửa sổ dashboard: chuyển động lặp (TimelineView)
//   • widget màn hình: KHUNG TĨNH — WidgetKit không chạy hoạt ảnh lặp.

/// Bảy tâm trạng, mỗi cái ứng với một trạng thái của nguồn dữ liệu.
enum AstroMood: Equatable {
    case loading, offline, profit, loss, idle, risk, stale

    /// Nhiều điều kiện cùng đúng thì cái đứng trước thắng:
    /// mất nguồn › dữ liệu cũ › sát stop › không lệnh › lãi/lỗ.
    init(_ state: FeedState) {
        switch state {
        case .loading: self = .loading
        case .offline: self = .offline
        case .loaded(let f):
            let positions = f.venues.flatMap(\.positions)
            if f.health.state == "stopped" {
                self = .offline
            } else if f.health.state == "stale" {
                self = .stale
            } else if positions.contains(where: { $0.stop == nil || ($0.stopDistancePct ?? 1) < 0.015 }) {
                // Cùng ngưỡng 1,5% với thanh "cách stop".
                self = .risk
            } else if f.positionCount == 0 {
                self = .idle
            } else {
                let d = f.dayChange ?? positions.reduce(0) { $0 + $1.pnl }
                self = d < 0 ? .loss : .profit
            }
        }
    }

    /// Màu kính mũ — cùng bảng màu với chữ lãi/lỗ.
    var accent: Color {
        switch self {
        case .loading: return T.blue
        case .offline, .loss: return T.red
        case .profit: return T.green
        case .idle: return Astro.glove
        case .risk, .stale: return T.amber
        }
    }
}

struct Astronaut: View {
    let mood: AstroMood
    /// false: một khung tĩnh — cho widget màn hình và ImageRenderer.
    var animated = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var from: AstroMood?
    @State private var changedAt = Date.distantPast

    var body: some View {
        Group {
            if animated && !reduceMotion {
                TimelineView(.animation(minimumInterval: 1.0 / 30)) { tl in
                    Canvas { g, size in
                        let t = tl.date.timeIntervalSinceReferenceDate
                        var p = Astro.pose(mood, t, live: true)
                        // Đổi tâm trạng: tay chân nội suy 0,6 s, hơi nảy quá đích.
                        let e = tl.date.timeIntervalSince(changedAt) / 0.6
                        if let from, e < 1 {
                            p = Astro.Pose.mix(Astro.pose(from, t, live: true), p, Astro.backOut(e))
                        }
                        // Lơ lửng không trọng lực, chồng lên dáng riêng của tâm trạng: nhấp nhô,
                        // lắc ngang, nghiêng — ba chu kỳ lệch nhau nên không bao giờ lặp đều.
                        p.dy += CGFloat(-6 * sin(t * 2 * .pi / 5))
                        p.dx += CGFloat(3 * sin(t * 2 * .pi / 7))
                        p.rot += 6 * sin(t * 2 * .pi / 6.5)
                        Astro.draw(g, size, p, mood.accent, Astro.uniform(mood))
                    }
                }
            } else {
                Canvas { g, size in
                    Astro.draw(g, size, Astro.pose(mood, 0, live: false), mood.accent, Astro.uniform(mood))
                }
            }
        }
        .onChange(of: mood) { old, _ in
            from = old
            changedAt = Date()
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Dáng + nét vẽ

enum Astro {
    static let suit = Color(hex: 0xEEF0F3)
    static let suit2 = Color(hex: 0xD9DCE2)
    static let pack = Color(hex: 0xAEB3BD)
    static let glove = Color(hex: 0x8E949F)
    static let visor = Color(hex: 0x121418)
    static let nozzle = Color(hex: 0x6B717C)
    static let off = Color(hex: 0x4A4E57)

    /// Đồng phục: màu vải, màu nếp (tay, thắt lưng), màu viền/hoa văn và kiểu dệt.
    struct Suit {
        enum Weave { case trim, sash, patches, dots, hazard, quilt, scuffs }
        let cloth: Color, shade: Color, trim: Color, rim: Color
        let weave: Weave
    }

    /// Mỗi tâm trạng một bộ — nhìn màu áo là biết trạng thái, kể cả khi chưa thấy dáng.
    static func uniform(_ m: AstroMood) -> Suit {
        switch m {
        case .loading:  // trắng cổ điển, sọc viền xanh
            return Suit(cloth: suit, shade: suit2, trim: T.blue, rim: Color(hex: 0xD3D7DE), weave: .trim)
        case .profit:   // vàng champagne, dải chéo xanh lá như huy chương
            return Suit(cloth: Color(hex: 0xF4E3B5), shade: Color(hex: 0xE2C47E), trim: T.green, rim: Color(hex: 0xD9BE7C), weave: .sash)
        case .loss:     // xám than, áo vá, cổ tay đỏ
            return Suit(cloth: Color(hex: 0x6E7484), shade: Color(hex: 0x575C6A), trim: T.red, rim: Color(hex: 0x8A90A0), weave: .patches)
        case .idle:     // pyjama tím nhạt chấm bi
            return Suit(cloth: Color(hex: 0xDCD5F2), shade: Color(hex: 0xC4BBE6), trim: Color(hex: 0x8E7FD0), rim: Color(hex: 0xCBC3EA), weave: .dots)
        case .risk:     // cam cảnh báo, băng sọc vàng đen
            return Suit(cloth: Color(hex: 0xF7A04E), shade: Color(hex: 0xE3832F), trim: Color(hex: 0x2A2420), rim: Color(hex: 0xE9934A), weave: .hazard)
        case .stale:    // kaki cũ, may chần trám
            return Suit(cloth: Color(hex: 0xCFC7A6), shade: Color(hex: 0xB8AF8C), trim: Color(hex: 0x8F865F), rim: Color(hex: 0xC2BA98), weave: .quilt)
        case .offline:  // xám bạc màu, trầy xước
            return Suit(cloth: Color(hex: 0xA3A8B2), shade: Color(hex: 0x8B909B), trim: Color(hex: 0x4E535C), rim: Color(hex: 0x9AA0AA), weave: .scuffs)
        }
    }

    private enum Part { case torso, arm, leg }

    /// Hoa văn trên một bộ phận, cắt gọn trong khuôn của nó.
    private static func weave(_ base: GraphicsContext, _ box: CGRect, _ radius: CGFloat, _ part: Part, _ s: Suit) {
        var c = base
        c.clip(to: Path(roundedRect: box, cornerRadius: radius))
        func band(_ y: CGFloat, _ h: CGFloat, _ col: Color) {
            c.fill(Path(CGRect(x: box.minX, y: y, width: box.width, height: h)), with: .color(col))
        }
        func diagonals(_ step: CGFloat, _ width: CGFloat, _ col: Color, flip: Bool = false, in zone: CGRect? = nil) {
            let r = zone ?? box
            var p = Path()
            var x = r.minX - r.height
            while x < r.maxX + r.height {
                p.move(to: CGPoint(x: x, y: flip ? r.minY : r.maxY))
                p.addLine(to: CGPoint(x: x + r.height, y: flip ? r.maxY : r.minY))
                x += step
            }
            var z = c
            if let zone { z.clip(to: Path(zone)) }
            z.stroke(p, with: .color(col), lineWidth: width)
        }
        func patch(_ r: CGRect) {
            c.fill(Path(roundedRect: r, cornerRadius: 1), with: .color(s.rim))
            c.stroke(Path(roundedRect: r.insetBy(dx: 0.9, dy: 0.9), cornerRadius: 0.6), with: .color(s.shade),
                     style: StrokeStyle(lineWidth: 0.5, dash: [1, 0.8]))
        }

        switch s.weave {
        case .trim:
            switch part {
            case .torso:
                c.fill(Path(CGRect(x: 47, y: 57, width: 2, height: 24)), with: .color(s.trim))
                c.fill(Path(CGRect(x: 71, y: 57, width: 2, height: 24)), with: .color(s.trim))
            case .arm: band(box.maxY - 7, 2, s.trim)
            case .leg: band(box.minY + 6, 2, s.trim)
            }
        case .sash:
            switch part {
            case .torso:
                var p = Path()
                p.move(to: CGPoint(x: 43, y: 63)); p.addLine(to: CGPoint(x: 49, y: 57))
                p.addLine(to: CGPoint(x: 77, y: 83)); p.addLine(to: CGPoint(x: 71, y: 89))
                p.closeSubpath()
                c.fill(p, with: .color(s.trim.opacity(0.9)))
            case .arm: band(box.maxY - 7, 2.5, s.trim)
            case .leg: c.fill(Path(CGRect(x: box.midX - 0.75, y: box.minY, width: 1.5, height: box.height)), with: .color(s.trim.opacity(0.8)))
            }
        case .patches:
            switch part {
            case .torso: patch(CGRect(x: 64, y: 76, width: 9, height: 7))
            case .arm: band(box.maxY - 7, 2, s.trim)
            case .leg: patch(CGRect(x: box.minX + 2, y: box.minY + 4, width: box.width - 4, height: 5))
            }
        case .dots:
            var p = Path()
            var y = box.minY + 2, row = 0
            while y < box.maxY {
                var x = box.minX + (row % 2 == 0 ? 2 : 5)
                while x < box.maxX {
                    p.addEllipse(in: CGRect(x: x - 1, y: y - 1, width: 2, height: 2))
                    x += 6
                }
                y += 5; row += 1
            }
            c.fill(p, with: .color(s.trim.opacity(0.55)))
        case .hazard:
            let zone: CGRect
            switch part {
            case .torso: zone = CGRect(x: 43, y: 76, width: 34, height: 9)
            case .arm: zone = CGRect(x: box.minX, y: box.maxY - 8, width: box.width, height: 4)
            case .leg: zone = CGRect(x: box.minX, y: box.minY + 5, width: box.width, height: 4)
            }
            c.fill(Path(zone), with: .color(Color(hex: 0xF3D34A)))
            diagonals(4, 1.6, s.trim, in: zone)
        case .quilt:
            diagonals(5, 0.5, s.trim.opacity(0.55))
            diagonals(5, 0.5, s.trim.opacity(0.55), flip: true)
        case .scuffs:
            var p = Path()
            for (u, v, l) in [(0.2, 0.3, 4.0), (0.6, 0.55, 3.0), (0.35, 0.8, 5.0)] as [(CGFloat, CGFloat, CGFloat)] {
                let x = box.minX + box.width * u, y = box.minY + box.height * v
                p.move(to: CGPoint(x: x, y: y))
                p.addQuadCurve(to: CGPoint(x: x + l, y: y + 1), control: CGPoint(x: x + l / 2, y: y - 1.2))
            }
            c.stroke(p, with: .color(s.trim.opacity(0.6)), style: StrokeStyle(lineWidth: 0.6, lineCap: .round))
        }
    }

    /// Một khung hình. Đơn vị là ô của lưới 120×120, góc tính bằng độ.
    struct Pose {
        var dx: CGFloat = 0, dy: CGFloat = 0
        var rot: Double = 0            // cả người, quanh (60, 64)
        var scale: CGFloat = 1
        var armL: Double = 12, armR: Double = -12
        var tint: Double = 0.32        // độ đậm màu kính mũ
        var led: Double = 1, antenna: Double = 1
        var lampOn = true, antennaOn = true
        var beam: Double?              // đèn mũ quét (độ)
        var flame: CGFloat?            // lửa phản lực, tỉ lệ dọc
        var stars: [Double]?           // mức sáng 0…1 từng sao
        var drop: Double?              // giọt mồ hôi, tiến độ 0…1
        var zs: [Double]?              // chữ z, tiến độ 0…1
        var alert: Double?             // đèn cảnh báo, mức sáng
        var bars: [Double]?            // vạch sóng, mức sáng
        var cut = false, tether = false

        /// Phần thân nội suy; hiệu ứng lấy luôn của đích.
        static func mix(_ a: Pose, _ b: Pose, _ k: Double) -> Pose {
            func l(_ x: CGFloat, _ y: CGFloat) -> CGFloat { x + (y - x) * k }
            func l(_ x: Double, _ y: Double) -> Double { x + (y - x) * k }
            var r = b
            r.dx = l(a.dx, b.dx); r.dy = l(a.dy, b.dy); r.scale = l(a.scale, b.scale)
            // Góc thân đi đường ngắn: trôi xoay (offline) có thể đã quay nhiều vòng.
            var d = (b.rot - a.rot).truncatingRemainder(dividingBy: 360)
            if d > 180 { d -= 360 } else if d < -180 { d += 360 }
            r.rot = b.rot - d * (1 - k)
            r.armL = l(a.armL, b.armL); r.armR = l(a.armR, b.armR)
            r.tint = l(a.tint, b.tint)
            return r
        }
    }

    static func backOut(_ x: Double) -> Double {
        let c1 = 1.70158, c3 = c1 + 1, u = min(1, max(0, x)) - 1
        return 1 + c3 * u * u * u + c1 * u * u
    }

    /// Dáng tại thời điểm t (giây). live = false trả về khung tĩnh của tâm trạng.
    static func pose(_ m: AstroMood, _ t: Double, live: Bool) -> Pose {
        // 0 → 1 → 0 mượt trong một chu kỳ, như keyframe 0% / 50% / 100% ease-in-out.
        func w(_ period: Double, _ delay: Double = 0) -> Double {
            live ? (1 - cos(2 * .pi * (t - delay) / period)) / 2 : 0
        }
        func phase(_ period: Double, _ delay: Double = 0) -> Double {
            let x = (t - delay) / period
            return x - x.rounded(.down)
        }

        var p = Pose()
        switch m {
        case .loading:
            p.dy = -3 * w(3.2)
            p.beam = live ? -14 + 28 * w(3.2) : 0
            p.antenna = 1 - 0.85 * w(1)
            p.led = p.antenna
        case .offline:
            p.rot = 25 + (live ? 360 * phase(20) : 0)
            p.armL = 75; p.armR = -75
            p.cut = true; p.lampOn = false; p.antennaOn = false
        case .profit:
            p.dy = 1 - 6 * w(1.8)
            p.armL = 24; p.armR = -150 + 32 * w(1.8)
            p.flame = 1 - 0.3 * w(0.28)
            p.stars = (0..<4).map { live ? w(1.6, Double($0) * 0.4) : 1 }
        case .loss:
            p.dy = -1 + 5 * w(3.6)
            p.rot = 6 + 3 * w(3.6)
            p.armL = 4; p.armR = -4
            p.drop = live ? phase(2.2) : 0.3
        case .idle:
            let b = w(4.5)
            p.rot = -24 + 3 * b; p.dy = -2 * b; p.scale = 1 + 0.03 * b
            p.armL = 58; p.armR = -58
            p.tint = 0.1; p.led = 0.25; p.lampOn = false
            p.zs = (0..<3).map { live ? phase(3, Double($0)) : 0.3 }
        case .risk:
            // Đứng yên gần hết chu kỳ, rồi run một nhịp ngắn.
            let j = jitter(live ? phase(3) : 0)
            p.dx = j.x; p.dy = j.y
            p.armL = 30; p.armR = -160
            p.tether = true
            p.alert = 1 - 0.85 * w(0.8)
        case .stale:
            p.dy = -3 * w(4)
            p.armL = 150
            p.bars = (0..<3).map { live ? w(2.4, Double($0) * 0.3) : 1 }
            p.antenna = 1 - 0.85 * w(2)
        }
        return p
    }

    private static func jitter(_ ph: Double) -> CGPoint {
        let keys: [(Double, CGFloat, CGFloat)] = [
            (0, 0, 0), (0.88, 0, 0), (0.90, -1.2, 0), (0.92, 1.2, 0.4),
            (0.94, -1, 0), (0.96, 0.8, 0), (1, 0, 0),
        ]
        for i in 1..<keys.count where ph <= keys[i].0 {
            let (t0, x0, y0) = keys[i - 1], (t1, x1, y1) = keys[i]
            let k = CGFloat((ph - t0) / (t1 - t0))
            return CGPoint(x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k)
        }
        return .zero
    }

    // MARK: Vẽ

    private static func rr(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat) -> Path {
        Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: r)
    }
    private static func dot(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
    }
    private static func turn(_ g: inout GraphicsContext, _ deg: Double, _ x: CGFloat, _ y: CGFloat) {
        g.translateBy(x: x, y: y)
        g.rotate(by: .degrees(deg))
        g.translateBy(x: -x, y: -y)
    }
    private static func star(_ cx: CGFloat, _ cy: CGFloat, _ s: CGFloat) -> Path {
        let i = s * 0.26
        var p = Path()
        p.move(to: CGPoint(x: cx, y: cy - s))
        p.addLine(to: CGPoint(x: cx + i, y: cy - i)); p.addLine(to: CGPoint(x: cx + s, y: cy))
        p.addLine(to: CGPoint(x: cx + i, y: cy + i)); p.addLine(to: CGPoint(x: cx, y: cy + s))
        p.addLine(to: CGPoint(x: cx - i, y: cy + i)); p.addLine(to: CGPoint(x: cx - s, y: cy))
        p.addLine(to: CGPoint(x: cx - i, y: cy - i)); p.closeSubpath()
        return p
    }

    static func draw(_ base: GraphicsContext, _ size: CGSize, _ p: Pose, _ accent: Color, _ s: Suit) {
        var g = base
        let k = min(size.width, size.height) / 120
        g.translateBy(x: (size.width - 120 * k) / 2, y: (size.height - 120 * k) / 2)
        g.scaleBy(x: k, y: k)
        let line = StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round)

        // Sao đứng yên trong không gian, không theo người.
        if let lv = p.stars {
            let spots: [(CGFloat, CGFloat, CGFloat)] = [(14, 26, 4), (104, 20, 4), (10, 76, 3), (110, 74, 3)]
            for (i, s) in spots.enumerated() where i < lv.count {
                var c = g
                let sc = 0.6 + 0.4 * lv[i]
                c.translateBy(x: s.0, y: s.1); c.scaleBy(x: sc, y: sc); c.translateBy(x: -s.0, y: -s.1)
                c.opacity = 0.15 + 0.85 * lv[i]
                c.fill(star(s.0, s.1, s.2), with: .color(accent))
            }
        }

        var f = g
        f.translateBy(x: p.dx, y: p.dy)
        f.translateBy(x: 60, y: 64)
        f.rotate(by: .degrees(p.rot))
        f.scaleBy(x: p.scale, y: p.scale)
        f.translateBy(x: -60, y: -64)

        if let a = p.beam {
            var b = f
            turn(&b, a, 80, 36)
            var cone = Path()
            cone.move(to: CGPoint(x: 80, y: 36))
            cone.addLine(to: CGPoint(x: 122, y: 20)); cone.addLine(to: CGPoint(x: 122, y: 54))
            cone.closeSubpath()
            b.fill(cone, with: .color(accent.opacity(0.16)))
        }

        if p.cut {
            var rope = Path()
            rope.move(to: CGPoint(x: 44, y: 84))
            rope.addCurve(to: CGPoint(x: 16, y: 90), control1: CGPoint(x: 34, y: 92), control2: CGPoint(x: 26, y: 80))
            rope.addCurve(to: CGPoint(x: 8, y: 96), control1: CGPoint(x: 12, y: 94), control2: CGPoint(x: 10, y: 92))
            for end in [CGPoint(x: 4, y: 95), CGPoint(x: 6, y: 99.5), CGPoint(x: 9.5, y: 99.5)] {
                rope.move(to: CGPoint(x: 8, y: 96)); rope.addLine(to: end)
            }
            f.stroke(rope, with: .color(pack), style: line)
        }

        if let s = p.flame {
            for cx in [CGFloat(41), 79] {
                var c = f
                c.translateBy(x: cx, y: 92); c.scaleBy(x: 1, y: s); c.translateBy(x: -cx, y: -92)
                var outer = Path()
                outer.move(to: CGPoint(x: cx - 2.5, y: 92))
                outer.addQuadCurve(to: CGPoint(x: cx + 2.5, y: 92), control: CGPoint(x: cx, y: 110))
                var inner = Path()
                inner.move(to: CGPoint(x: cx - 1, y: 92))
                inner.addQuadCurve(to: CGPoint(x: cx + 1, y: 92), control: CGPoint(x: cx, y: 102))
                c.fill(outer, with: .color(T.amber))
                c.fill(inner, with: .color(Color(hex: 0xFFF4DA)))
            }
        }

        // Ba lô, vòi phun, chân.
        f.fill(rr(37, 57, 46, 35, 8), with: .color(pack))
        f.fill(rr(38, 89, 6, 4, 1), with: .color(nozzle))
        f.fill(rr(76, 89, 6, 4, 1), with: .color(nozzle))
        for x in [CGFloat(46), 62] {
            f.fill(rr(x, 85, 12, 18, 5), with: .color(s.cloth))
            weave(f, CGRect(x: x, y: 85, width: 12, height: 18), 5, .leg, s)
        }
        f.fill(rr(45, 98, 14, 8, 3.5), with: .color(glove))
        f.fill(rr(61, 98, 14, 8, 3.5), with: .color(glove))

        var armL = f
        turn(&armL, p.armL, 38, 62)
        armL.fill(rr(31, 59, 12, 26, 6), with: .color(s.shade))
        weave(armL, CGRect(x: 31, y: 59, width: 12, height: 26), 6, .arm, s)
        armL.fill(dot(37, 85, 5), with: .color(glove))

        // Thân + bảng đèn ngực.
        f.fill(rr(43, 57, 34, 33, 10), with: .color(s.cloth))
        f.fill(Path(CGRect(x: 43, y: 81, width: 34, height: 4)), with: .color(s.shade))
        weave(f, CGRect(x: 43, y: 57, width: 34, height: 33), 10, .torso, s)
        f.fill(rr(52, 65, 16, 10, 2.5), with: .color(Color(hex: 0x23262C)))
        f.fill(dot(56.5, 70, 1.7), with: .color(accent.opacity(p.led)))
        f.fill(dot(61.5, 70, 1.2), with: .color(.white.opacity(0.55)))
        f.fill(dot(65, 70, 1.2), with: .color(.white.opacity(0.3)))

        if p.tether {
            var rope = Path()
            rope.move(to: CGPoint(x: 89, y: 40))
            rope.addCurve(to: CGPoint(x: 112, y: -6), control1: CGPoint(x: 91, y: 22), control2: CGPoint(x: 99, y: 8))
            f.stroke(rope, with: .color(pack), style: line)
        }

        var armR = f
        turn(&armR, p.armR, 82, 62)
        armR.fill(rr(77, 59, 12, 26, 6), with: .color(s.shade))
        weave(armR, CGRect(x: 77, y: 59, width: 12, height: 26), 6, .arm, s)
        armR.fill(dot(83, 85, 5), with: .color(glove))

        // Cổ, ăng-ten, mũ.
        f.fill(rr(48, 54, 24, 5, 2.5), with: .color(pack))
        var mast = Path()
        mast.move(to: CGPoint(x: 72, y: 21)); mast.addLine(to: CGPoint(x: 78, y: 10))
        f.stroke(mast, with: .color(pack), style: line)
        f.fill(dot(78, 10, 2.2), with: .color(p.antennaOn ? accent.opacity(p.antenna) : off))
        f.fill(dot(60, 38, 21), with: .color(s.cloth))
        f.stroke(dot(60, 38, 20.4), with: .color(s.rim), lineWidth: 1.2)
        let visorRect = rr(46, 29, 28, 19, 9.5)
        f.fill(visorRect, with: .color(visor))
        f.fill(visorRect, with: .color(accent.opacity(p.tint)))
        var shine = Path()
        shine.move(to: CGPoint(x: 51, y: 35))
        shine.addQuadCurve(to: CGPoint(x: 59, y: 31.5), control: CGPoint(x: 54, y: 31.5))
        f.stroke(shine, with: .color(.white.opacity(0.75)), style: StrokeStyle(lineWidth: 2, lineCap: .round))
        f.fill(dot(80, 36, 2.4), with: .color(p.lampOn ? accent : off))

        if let a = p.alert {
            f.fill(dot(60, 13, 6), with: .color(T.amber.opacity(0.25 * a)))
            f.fill(rr(56.5, 15, 7, 3, 1), with: .color(pack))
            f.fill(dot(60, 13, 3), with: .color(T.amber.opacity(a)))
        }

        if let d = p.drop {
            var c = f
            c.translateBy(x: 0, y: 12 * d)
            c.opacity = d < 0.15 ? d / 0.15 : 1 - (d - 0.15) / 0.85
            var drop = Path()
            drop.move(to: CGPoint(x: 86, y: 23))
            drop.addCurve(to: CGPoint(x: 89, y: 29.5), control1: CGPoint(x: 86, y: 23), control2: CGPoint(x: 89, y: 27.5))
            drop.addArc(center: CGPoint(x: 86, y: 29.5), radius: 3, startAngle: .zero, endAngle: .degrees(180), clockwise: false)
            drop.addCurve(to: CGPoint(x: 86, y: 23), control1: CGPoint(x: 83, y: 27.5), control2: CGPoint(x: 86, y: 23))
            c.fill(drop, with: .color(T.blue))
        }

        if let lv = p.bars {
            let bars: [(CGFloat, CGFloat, CGFloat)] = [(17, 28, 4), (22, 24, 8), (27, 20, 12)]
            for (i, b) in bars.enumerated() where i < lv.count {
                f.fill(rr(b.0, b.1, 3, b.2, 1), with: .color(accent.opacity(0.2 + 0.8 * lv[i])))
            }
        }

        // Chữ z bay lên trong không gian, không xoay theo người.
        if let zs = p.zs {
            let spots: [(CGFloat, CGFloat, CGFloat)] = [(66, 26, 8), (75, 17, 10), (85, 8, 12)]
            for (i, z) in spots.enumerated() where i < zs.count {
                let q = zs[i]
                let a = q < 0.3 ? q / 0.3 * 0.85 : 0.85 * (1 - (q - 0.3) / 0.7)
                g.draw(
                    Text("z").font(.system(size: z.2, weight: .bold)).foregroundColor(.white.opacity(0.72 * a)),
                    at: CGPoint(x: z.0 + 8 * q, y: z.1 + 4 - 14 * q),
                    anchor: .bottomLeading
                )
            }
        }
    }
}

// MARK: - Nền ngân hà

/// Bầu trời sau lưng phi hành gia: Dải Ngân Hà nằm chéo, ba lớp sao trôi lệch tốc độ
/// (xa chậm, gần nhanh), tinh vân lấy màu kính mũ, mặt trăng và sao băng.
/// animated = false: một khung tĩnh — cho widget màn hình và ImageRenderer.
struct SpaceBackdrop: View {
    let mood: AstroMood
    var animated = true
    /// Chỗ phi hành gia đứng, tỉ lệ 0…1 của khung — tinh vân và mặt trăng bám theo.
    var focus = UnitPoint(x: 0.85, y: 0.45)
    /// Phủ tối dần từ mép trái cho chữ đặt trên nền vẫn dễ đọc.
    var scrim = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            // Nền + Dải Ngân Hà không đổi theo thời gian — vẽ một lần, không vẽ lại mỗi khung.
            Canvas { g, size in Sky.drawStill(g, size, mood, focus) }
            if animated && !reduceMotion {
                TimelineView(.animation(minimumInterval: 1.0 / 30)) { tl in
                    Canvas { g, size in
                        Sky.drawLive(g, size, mood, focus, tl.date.timeIntervalSinceReferenceDate, live: true)
                    }
                }
            } else {
                Canvas { g, size in Sky.drawLive(g, size, mood, focus, 0, live: false) }
            }
            if scrim {
                LinearGradient(
                    stops: [
                        .init(color: Sky.deep.opacity(0.8), location: 0),
                        .init(color: Sky.deep.opacity(0.55), location: 0.3),
                        .init(color: Sky.deep.opacity(0.18), location: 0.5),
                        .init(color: Sky.deep.opacity(0), location: 0.72),
                    ],
                    startPoint: .leading, endPoint: .trailing
                )
            }
        }
        .accessibilityHidden(true)
    }
}

private enum Sky {
    static let deep = Color(hex: 0x0A0B0E)
    static let tints: [Color] = [.white, Color(hex: 0xCFE0FF), Color(hex: 0xFFE7C4)]

    struct Star {
        let x, y, r, a: Double
        let tint: Int
        let tw: Double, ph: Double     // chu kỳ nhấp nháy (0 = đứng yên), lệch pha
    }

    /// SplitMix64 với hạt cố định — lần vẽ nào, target nào cũng ra cùng một bầu trời.
    private struct RNG {
        var s: UInt64
        mutating func next() -> Double {
            s &+= 0x9E37_79B9_7F4A_7C15
            var z = s
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            z ^= z >> 31
            return Double(z >> 11) / Double(UInt64(1) << 53)
        }
        mutating func range(_ r: ClosedRange<Double>) -> Double { r.lowerBound + next() * (r.upperBound - r.lowerBound) }
    }

    /// band = true: x chạy dọc dải (0…1), y lệch khỏi trục giữa theo phân bố gần chuẩn (−1…1).
    private static func make(_ n: Int, seed: UInt64, r: ClosedRange<Double>, a: ClosedRange<Double>,
                             twinkle: Double, tinted: Bool, band: Bool = false) -> [Star] {
        var g = RNG(s: seed)
        return (0..<n).map { _ in
            let x = g.next()
            let y = band ? (g.next() + g.next() + g.next() - 1.5) / 1.5 : g.next()
            return Star(
                x: x, y: y, r: g.range(r), a: g.range(a),
                tint: tinted ? Int(g.next() * 3) % 3 : 0,
                tw: g.next() < twinkle ? g.range(3...7) : 0, ph: g.range(0...7)
            )
        }
    }

    // Số sao ứng với khung 1000×400; khung khác co giãn theo diện tích (đến 1,5×).
    static let far = make(225, seed: 11, r: 0.35...0.6, a: 0.22...0.55, twinkle: 0.2, tinted: false)
    static let mid = make(90, seed: 23, r: 0.55...0.85, a: 0.4...0.8, twinkle: 0.5, tinted: true)
    static let near = make(21, seed: 37, r: 1...1.3, a: 0.7...1, twinkle: 0.7, tinted: true)
    static let band = make(360, seed: 41, r: 0.3...0.65, a: 0.2...0.75, twinkle: 0, tinted: true, band: true)

    /// Thiên thạch: chỗ đứng cố định trong khung, trôi trọn một vòng sau `drift` giây.
    struct Rock {
        let x, y, size, drift, spin, ph: Double
        let shape: [Double]            // bán kính từng đỉnh, tỉ lệ — cho hình méo
    }
    static let rocks: [Rock] = {
        var g = RNG(s: 53)
        // Chỗ trống ở cả hero lẫn widget lớn: nửa phải, tránh dòng chữ, tàu và hành tinh.
        let spots: [(Double, Double)] = [(0.66, 0.12), (0.78, 0.3), (0.55, 0.62), (0.72, 0.5), (0.97, 0.7), (0.93, 0.92)]
        return spots.map { p in
            Rock(x: p.0, y: p.1, size: g.range(0.6...1.3), drift: g.range(70...140), spin: g.range(-30...30),
                 ph: g.range(0...360), shape: (0..<8).map { _ in g.range(0.7...1.05) })
        }
    }()

    private static func density(_ size: CGSize) -> Double {
        min(1.5, max(0.3, Double(size.width * size.height) / 400_000))
    }

    /// Mất nguồn: bầu trời tối hẳn đi.
    private static func dim(_ m: AstroMood) -> Double { m == .offline ? 0.45 : 1 }

    private static func dot(_ p: CGPoint, _ r: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2))
    }

    /// Một quầng elip rx×ry, mờ dần từ tâm ra viền.
    private static func glow(_ g: GraphicsContext, _ c: CGPoint, _ rx: CGFloat, _ ry: CGFloat, _ stops: [Gradient.Stop]) {
        var e = g
        e.translateBy(x: c.x, y: c.y)
        e.scaleBy(x: 1, y: ry / rx)
        e.fill(dot(.zero, rx), with: .radialGradient(Gradient(stops: stops), center: .zero, startRadius: 0, endRadius: rx))
    }

    private static func rgb(_ hex: UInt32, _ a: Double) -> Color { Color(hex: hex).opacity(a) }

    /// Cung tròn bán kính r từ góc a tới b (độ, y hướng xuống: 180→360 là nửa trên).
    private static func arc(_ r: CGFloat, _ a: Double, _ b: Double) -> Path {
        var p = Path()
        for i in 0...32 {
            let t = (a + (b - a) * Double(i) / 32) * .pi / 180
            let pt = CGPoint(x: cos(t) * r, y: sin(t) * r)
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        return p
    }

    /// Mặt trăng đá, nắng chiếu từ trên trái như hành tinh và thiên thạch: biển tối loang,
    /// miệng hố có thành sáng/tối, pha trăng khuyết với ranh giới mềm, viền tối dần — không có điểm bóng.
    private static func moon(_ g: GraphicsContext, _ c: CGPoint, _ r: CGFloat) {
        func at(_ u: CGFloat, _ v: CGFloat) -> CGPoint { CGPoint(x: c.x + u * r, y: c.y + v * r) }
        let disc = dot(c, r)
        // Đá không tự phát sáng — chỉ một quầng tán rất mờ.
        glow(g, c, r * 1.8, r * 1.8, [
            .init(color: rgb(0xD8D4CC, 0.07), location: 0),
            .init(color: rgb(0xD8D4CC, 0), location: 1),
        ])
        g.fill(disc, with: .linearGradient(
            Gradient(colors: [Color(hex: 0xD2CDC3), Color(hex: 0xA19C93)]),
            startPoint: at(-1, -1), endPoint: at(1, 1)
        ))

        var s = g
        s.clip(to: disc)
        // Biển mặt trăng: vài mảng tối loang chồng lên nhau.
        let maria: [(CGFloat, CGFloat, CGFloat, CGFloat, Double)] = [
            (-0.25, -0.2, 0.45, 0.32, 0.5), (0.05, -0.02, 0.3, 0.38, 0.4),
            (0.3, 0.3, 0.4, 0.25, 0.35), (-0.45, 0.35, 0.22, 0.18, 0.3),
        ]
        for (u, v, a, b, al) in maria {
            glow(s, at(u, v), r * a, r * b, [
                .init(color: rgb(0x6F6A63, al), location: 0),
                .init(color: rgb(0x6F6A63, al * 0.6), location: 0.6),
                .init(color: rgb(0x6F6A63, 0), location: 1),
            ])
        }
        // Miệng hố là chỗ lõm: thành dưới phải hứng nắng, lòng hố tối lệch lên trên trái.
        if r >= 8 {
            let craters: [(CGFloat, CGFloat, CGFloat)] = [
                (-0.42, -0.45, 0.16), (-0.55, 0.05, 0.12), (0.12, 0.55, 0.14), (-0.1, -0.65, 0.09), (0.5, -0.2, 0.1),
            ]
            for (u, v, k) in craters {
                let p = at(u, v), cr = r * k
                s.fill(dot(CGPoint(x: p.x + cr * 0.3, y: p.y + cr * 0.3), cr * 1.05), with: .color(rgb(0xEEEAE2, 0.5)))
                s.fill(dot(CGPoint(x: p.x - cr * 0.12, y: p.y - cr * 0.12), cr * 0.9), with: .color(rgb(0x625D56, 0.65)))
            }
        }
        // Pha trăng: phần khuất bóng phía dưới phải, ranh giới nhoè chứ không sắc.
        var night = s
        night.addFilter(.blur(radius: r * 0.18))
        night.fill(dot(at(0.95, 0.85), r * 1.1), with: .color(rgb(0x07070F, 0.85)))
        // Viền tối dần về mép — mặt cầu đá, không phải bi thuỷ tinh.
        s.fill(disc, with: .radialGradient(
            Gradient(stops: [
                .init(color: rgb(0x000000, 0), location: 0.7),
                .init(color: rgb(0x000000, 0.3), location: 1),
            ]),
            center: c, startRadius: 0, endRadius: r
        ))
    }

    /// Hành tinh cam có vành đai: nửa sau vành vẽ trước thân, nửa trước vẽ sau.
    private static func ringedPlanet(_ g: GraphicsContext, _ c: CGPoint, _ r: CGFloat) {
        glow(g, c, r * 2.4, r * 2.4, [
            .init(color: rgb(0xFF9A5C, 0.18), location: 0),
            .init(color: rgb(0xFF9A5C, 0), location: 1),
        ])
        var ring = g
        ring.translateBy(x: c.x, y: c.y)
        ring.rotate(by: .degrees(-16))
        ring.scaleBy(x: 1, y: 0.3)
        func rings(_ a: Double, _ b: Double) {
            ring.stroke(arc(r * 2, a, b), with: .color(rgb(0xF1DDB8, 0.6)), lineWidth: r * 0.36)
            ring.stroke(arc(r * 1.55, a, b), with: .color(rgb(0xC9A27A, 0.5)), lineWidth: r * 0.2)
        }
        rings(180, 360)

        let body = dot(c, r)
        g.fill(body, with: .radialGradient(
            Gradient(stops: [
                .init(color: Color(hex: 0xFFD7A3), location: 0),
                .init(color: Color(hex: 0xEE8E58), location: 0.45),
                .init(color: Color(hex: 0x8C3440), location: 1),
            ]),
            center: CGPoint(x: c.x - r * 0.35, y: c.y - r * 0.35), startRadius: 0, endRadius: r * 1.6
        ))
        var bands = g
        bands.clip(to: body)
        bands.translateBy(x: c.x, y: c.y)
        bands.rotate(by: .degrees(-16))
        for (y, hh) in [(-0.42, 0.12), (0.02, 0.2), (0.45, 0.1)] as [(CGFloat, CGFloat)] {
            bands.fill(Path(CGRect(x: -r, y: r * y, width: r * 2, height: r * hh)), with: .color(rgb(0x9C4A3C, 0.3)))
        }
        // Mặt khuất bóng: tối dần về phía dưới phải.
        g.fill(body, with: .radialGradient(
            Gradient(stops: [
                .init(color: rgb(0x0C0818, 0), location: 0.5),
                .init(color: rgb(0x0C0818, 0.65), location: 1),
            ]),
            center: CGPoint(x: c.x - r * 0.4, y: c.y - r * 0.45), startRadius: 0, endRadius: r * 1.9
        ))
        rings(0, 180)
    }

    /// Một hòn đá méo, ánh sáng cố định từ trên trái dù đá tự xoay.
    private static func rock(_ g: GraphicsContext, _ c: CGPoint, _ r: CGFloat, _ deg: Double, _ shape: [Double]) {
        let rot = deg * .pi / 180
        func at(_ a: Double, _ m: Double) -> CGPoint {
            CGPoint(x: c.x + cos(a + rot) * r * m, y: c.y + sin(a + rot) * r * m)
        }
        var p = Path()
        for (i, m) in shape.enumerated() {
            let pt = at(Double(i) / Double(shape.count) * 2 * .pi, m)
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        p.closeSubpath()
        g.fill(p, with: .radialGradient(
            Gradient(colors: [Color(hex: 0xB0A69C), Color(hex: 0x5E5550), Color(hex: 0x2B2624)]),
            center: CGPoint(x: c.x - r * 0.35, y: c.y - r * 0.4), startRadius: 0, endRadius: r * 1.6
        ))
        if r > 3 {
            g.fill(dot(at(0.6, 0.35), r * 0.22), with: .color(rgb(0x2B2624, 0.7)))
            g.fill(dot(at(2.4, 0.45), r * 0.14), with: .color(rgb(0x2B2624, 0.6)))
        }
    }

    /// Đồng hồ cho hoạt ảnh của tàu; live = false trả về một khung tĩnh dễ nhìn.
    struct Clock {
        let t: Double, live: Bool
        /// 0 → 1 → 0 mượt trong một chu kỳ.
        func wave(_ p: Double) -> Double { live ? (1 - cos(2 * .pi * t / p)) / 2 : 0.5 }
        /// Tiến độ 0…1 trong chu kỳ, lệch `d` giây.
        func phase(_ p: Double, _ d: Double = 0) -> Double {
            let x = ((live ? t : 0) + d) / p
            return x - x.rounded(.down)
        }
        /// Bật trong `duty` phần đầu mỗi chu kỳ — đèn nháy. Khung tĩnh: luôn bật.
        func on(_ p: Double, _ duty: Double, _ d: Double = 0) -> Bool { !live || phase(p, d) < duty }
        func swing(_ p: Double, _ amp: Double, rest: Double = 0) -> Double { live ? amp * sin(2 * .pi * t / p) : rest }
    }

    private static func local(_ g: GraphicsContext, _ c: CGPoint, _ deg: Double, _ s: CGFloat) -> GraphicsContext {
        var k = g
        k.translateBy(x: c.x, y: c.y)
        k.rotate(by: .degrees(deg))
        k.scaleBy(x: s, y: s)
        return k
    }
    private static func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
    private static func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat = 0) -> Path {
        Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: r)
    }
    private static func line(_ k: GraphicsContext, _ a: CGPoint, _ b: CGPoint, _ col: Color, _ w: CGFloat) {
        var p = Path()
        p.move(to: a); p.addLine(to: b)
        k.stroke(p, with: .color(col), style: StrokeStyle(lineWidth: w, lineCap: .round))
    }
    /// Luồng phụt hình nêm: lõi sáng ở miệng, nhạt dần về đuôi, có quầng.
    private static func plume(_ k: GraphicsContext, from o: CGPoint, length: CGFloat, width: CGFloat,
                              core: Color, halo: Color) {
        glow(k, pt(o.x - length * 0.4, o.y), length * 0.6, width * 2.2, [
            .init(color: halo.opacity(0.45), location: 0),
            .init(color: halo.opacity(0), location: 1),
        ])
        var p = Path()
        p.move(to: pt(o.x, o.y - width / 2)); p.addLine(to: pt(o.x - length, o.y)); p.addLine(to: pt(o.x, o.y + width / 2))
        p.closeSubpath()
        k.fill(p, with: .linearGradient(
            Gradient(colors: [core, halo.opacity(0.8), halo.opacity(0)]),
            startPoint: o, endPoint: pt(o.x - length, o.y)
        ))
    }

    static let steel = Color(hex: 0x9AA0AA), hullLight = Color(hex: 0xE6E9EF), gunmetal = Color(hex: 0x4A4E57)

    /// Góc đậu (widget) của từng con tàu.
    private static func parkAngle(_ m: AstroMood) -> Double {
        switch m {
        case .loading: return -12
        case .profit: return -14
        case .loss: return 16
        case .idle: return -6
        case .risk: return -18
        case .stale: return -8
        case .offline: return 35
        }
    }

    /// Đường bay trong dashboard: vị trí + hướng mũi, nil khi tàu đang ở ngoài khung.
    private static func flight(_ m: AstroMood, _ t: Double, _ w: CGFloat, _ h: CGFloat) -> (CGPoint, Double)? {
        // chu kỳ (s), phần chu kỳ đang bay, độ lên (âm = chìm), biên độ lượn, số lần lượn
        let f: (period: Double, active: Double, rise: Double, wob: Double, turns: Double)
        switch m {
        case .loading: f = (18, 0.9, 0.45, 0.03, 1)
        case .profit: f = (12, 0.88, 0.55, 0.05, 1.5)
        case .loss: f = (20, 0.9, -0.4, 0.03, 2)
        case .idle: f = (30, 0.92, 0.2, 0.02, 1)
        case .risk: f = (11, 0.88, 0.35, 0.1, 3)
        case .stale: f = (26, 0.92, 0.25, 0.04, 1)
        case .offline: f = (28, 0.92, 0.1, 0.03, 1)
        }
        var ph = t / f.period
        ph -= ph.rounded(.down)
        guard ph < f.active else { return nil }
        let q = ph / f.active, W = Double(w), H = Double(h)
        let k = 2 * Double.pi * f.turns
        let y0 = f.rise >= 0 ? 0.82 : 0.3
        let p = CGPoint(x: (-0.1 + 1.2 * q) * W, y: (y0 - f.rise * q) * H + f.wob * H * sin(k * q))
        var ang = atan2(-f.rise * H + f.wob * H * k * cos(k * q), 1.2 * W) * 180 / .pi
        if m == .loss { ang += 8 * sin(t * 1.3) }    // chao đảo
        if m == .offline { ang = t * 12 }            // xác tàu lộn vòng
        return (p, ang)
    }

    private static func vessel(_ g: GraphicsContext, _ m: AstroMood, _ c: CGPoint, _ deg: Double, _ s: CGFloat, _ clock: Clock) {
        switch m {
        case .profit: ship(g, c, deg, s, clock.wave(0.18), spin: clock.live ? clock.t * 36 : 12)
        case .loading: probe(local(g, c, deg, s), clock)
        case .loss: lifeboat(local(g, c, deg, s), clock)
        case .idle: freighter(local(g, c, deg, s), clock)
        case .risk: interceptor(local(g, c, deg, s), clock)
        case .stale: solarSail(local(g, c, deg, s), clock)
        case .offline: derelict(local(g, c, deg, s), clock)
        }
    }

    /// Đang tải — tàu thăm dò: đầu cầu, trục lưới dài, chảo ăng-ten quét và phát sóng, động cơ ion xanh mảnh.
    private static func probe(_ k: GraphicsContext, _ c: Clock) {
        plume(k, from: pt(-30, 0), length: 13 + 3 * CGFloat(c.wave(0.3)), width: 1.6, core: .white, halo: Color(hex: 0x65A9FF))
        k.fill(box(-29, -4, 8, 8, 1.5), with: .color(Color(hex: 0x6B717C)))
        k.fill(box(-30.5, -3, 1.6, 2), with: .color(gunmetal))
        k.fill(box(-30.5, 1, 1.6, 2), with: .color(gunmetal))
        k.fill(box(-21, -1.6, 32, 0.7), with: .color(steel))
        k.fill(box(-21, 0.9, 32, 0.7), with: .color(steel))
        var lattice = Path()
        var x: CGFloat = -21, up = true
        lattice.move(to: pt(x, -1.25))
        while x < 11 { x += 2.6; up.toggle(); lattice.addLine(to: pt(x, up ? -1.25 : 1.25)) }
        k.stroke(lattice, with: .color(steel.opacity(0.8)), lineWidth: 0.45)

        // Chảo ăng-ten trên cần, quét qua lại; sóng phát ra theo hướng chảo.
        line(k, pt(-6, -1.6), pt(-6, -7), steel, 0.8)
        var d = k
        d.translateBy(x: -6, y: -7)
        d.rotate(by: .degrees(c.swing(5, 25, rest: 12)))
        for i in 0..<3 {
            let ph = c.phase(1.8, Double(i) * 0.6)
            d.stroke(arc(4 + CGFloat(ph) * 14, 225, 315).applying(.init(translationX: 0, y: -4)),
                     with: .color(T.blue.opacity(0.6 * (1 - ph))), lineWidth: 0.7)
        }
        var dish = Path()
        dish.move(to: pt(-6, -2)); dish.addQuadCurve(to: pt(6, -2), control: pt(0, 5))
        dish.addQuadCurve(to: pt(-6, -2), control: pt(0, 1.4))
        d.fill(dish, with: .linearGradient(Gradient(colors: [hullLight, Color(hex: 0xA9AFBB)]), startPoint: pt(0, -2), endPoint: pt(0, 3)))
        line(d, pt(0, 1), pt(0, -4.5), steel, 0.5)
        d.fill(dot(pt(0, -4.8), 0.8), with: .color(T.blue))

        // Đầu cầu ở mũi, dải cửa sổ phía trước.
        k.fill(box(9, -2.5, 3.5, 5, 0.8), with: .color(steel))
        k.fill(dot(pt(16, 0), 6.5), with: .radialGradient(
            Gradient(stops: [
                .init(color: Color(hex: 0xF4F6FA), location: 0),
                .init(color: Color(hex: 0xC3C8D2), location: 0.6),
                .init(color: Color(hex: 0x7E8491), location: 1),
            ]),
            center: pt(13.5, -2.5), startRadius: 0, endRadius: 9.5
        ))
        glow(k, pt(19.6, -0.4), 2.6, 1.6, [
            .init(color: Color(hex: 0x1B2A44), location: 0.7),
            .init(color: Color(hex: 0x1B2A44).opacity(0), location: 1),
        ])
        k.fill(dot(pt(19, -1), 0.55), with: .color(rgb(0x9FD8FF, 0.9)))
    }

    /// Lỗ — khoang cứu hộ hư hỏng: cháy xém, đèn đỏ nháy, mảnh vỏ lủng lẳng, khói và tia lửa.
    private static func lifeboat(_ k: GraphicsContext, _ c: Clock) {
        for i in 0..<7 {
            let f = (Double(i) + c.phase(0.9)) / 7
            let r = 2 + CGFloat(f) * 6
            let y = CGFloat(sin(f * 9 + (c.live ? c.t : 0))) * 2 * CGFloat(f)
            k.fill(dot(pt(-15 - CGFloat(f) * 42, y), r), with: .color(rgb(0x8A8F99, 0.4 * (1 - f))))
        }
        k.fill(box(-14.5, -8, 3.4, 16, 1.6), with: .color(Color(hex: 0x5A3B2E)))
        var cap = Path()
        cap.move(to: pt(-12, -7.5)); cap.addLine(to: pt(7, -4))
        cap.addQuadCurve(to: pt(7, 4), control: pt(13, 0))
        cap.addLine(to: pt(-12, 7.5)); cap.closeSubpath()
        k.fill(cap, with: .linearGradient(Gradient(colors: [Color(hex: 0xDADDE3), Color(hex: 0x8A8F99)]), startPoint: pt(0, -7), endPoint: pt(0, 7)))
        var sk = k
        sk.clip(to: cap)
        line(sk, pt(-4, -8), pt(-4, 8), Color(hex: 0x7E8491), 0.5)
        glow(sk, pt(-8, 3.5), 4.5, 2.8, [.init(color: rgb(0x1E140F, 0.6), location: 0), .init(color: rgb(0x1E140F, 0), location: 1)])
        glow(sk, pt(3, -2.6), 2.6, 1.5, [.init(color: rgb(0x1E140F, 0.45), location: 0), .init(color: rgb(0x1E140F, 0), location: 1)])
        k.fill(dot(pt(0, -0.8), 1.8), with: .color(Color(hex: 0x1B2A44)))
        k.fill(dot(pt(-0.5, -1.4), 0.5), with: .color(.white.opacity(0.7)))

        let alarm = c.on(0.7, 0.5)
        if alarm {
            glow(k, pt(3, -4.4), 3.8, 3.8, [.init(color: T.red.opacity(0.55), location: 0), .init(color: T.red.opacity(0), location: 1)])
        }
        k.fill(dot(pt(3, -4.4), 1.1), with: .color(T.red.opacity(alarm ? 1 : 0.25)))

        var panel = k
        panel.translateBy(x: -6, y: 6.6)
        panel.rotate(by: .degrees(32 + c.swing(1.7, 12)))
        panel.fill(box(0, -0.8, 5.5, 1.6, 0.3), with: .color(Color(hex: 0xB9BFCB)))
        if c.on(0.23, 0.4) {
            for (x, y) in [(-4.2, 8.6), (-2.6, 9.8), (-5.4, 10.4)] as [(CGFloat, CGFloat)] {
                k.fill(dot(pt(x, y), 0.5), with: .color(Color(hex: 0xFFB25C)))
            }
        }
    }

    /// Không lệnh — tàu chở hàng nằm im: máy tắt, container dọc trục, đèn ca-bin vàng ấm, đèn hàng hải nháy chậm.
    private static func freighter(_ k: GraphicsContext, _ c: Clock) {
        k.fill(box(-33, -5, 6, 10, 1.5), with: .color(gunmetal))
        k.fill(box(-35, -4, 2.2, 3), with: .color(Color(hex: 0x2E3138)))
        k.fill(box(-35, 1, 2.2, 3), with: .color(Color(hex: 0x2E3138)))
        k.fill(box(-27, -1, 38, 2), with: .color(Color(hex: 0x6B717C)))
        let crates: [UInt32] = [0x8A5A3C, 0x5F6B78, 0x9C7B4A, 0x56606C]
        for (i, hex) in crates.enumerated() {
            let x = -26 + CGFloat(i) * 8.6
            k.fill(box(x, -5.5, 7.6, 11, 0.8), with: .linearGradient(
                Gradient(colors: [Color(hex: hex).opacity(1), Color(hex: hex).opacity(0.7)]),
                startPoint: pt(0, -5.5), endPoint: pt(0, 5.5)
            ))
            line(k, pt(x + 3.8, -5), pt(x + 3.8, 5), .black.opacity(0.25), 0.35)
            line(k, pt(x + 0.5, 0), pt(x + 7.1, 0), .black.opacity(0.2), 0.35)
        }
        var bridge = Path()
        bridge.move(to: pt(9, -6)); bridge.addLine(to: pt(22, -6)); bridge.addLine(to: pt(27, -1))
        bridge.addLine(to: pt(27, 4)); bridge.addLine(to: pt(9, 4)); bridge.closeSubpath()
        k.fill(bridge, with: .linearGradient(Gradient(colors: [Color(hex: 0xD3D7DE), Color(hex: 0x8E949F)]), startPoint: pt(0, -6), endPoint: pt(0, 4)))
        k.fill(box(12, -10, 7, 4.5, 1), with: .color(Color(hex: 0xB9BFCB)))
        line(k, pt(15.5, -10), pt(15.5, -13.5), steel, 0.5)
        for i in 0..<4 {
            k.fill(dot(pt(13.4 + CGFloat(i) * 1.5, -8), 0.45), with: .color(rgb(0xFFD08A, 0.9)))
        }
        k.fill(box(21, -4.6, 4, 1.1, 0.4), with: .color(rgb(0xFFD08A, 0.55)))
        // Đèn hàng hải: đỏ mũi, xanh đuôi, thay nhau nháy.
        let port = c.on(2.4, 0.5)
        k.fill(dot(pt(27, -1), 0.9), with: .color(T.red.opacity(port ? 1 : 0.25)))
        k.fill(dot(pt(-33, 5), 0.9), with: .color(T.green.opacity(port && c.live ? 0.25 : 1)))
    }

    /// Sát stop — tàu chặn hình mũi tên: sọc cảnh báo trên cánh, đèn hiệu hổ phách, phụt cạnh để né.
    private static func interceptor(_ k: GraphicsContext, _ c: Clock) {
        let fl = 10 + 3 * CGFloat(c.wave(0.12))
        plume(k, from: pt(-19, -2.1), length: fl, width: 2, core: Color(hex: 0xFFF4DA), halo: T.amber)
        plume(k, from: pt(-19, 2.1), length: fl, width: 2, core: Color(hex: 0xFFF4DA), halo: T.amber)
        var hull = Path()
        hull.move(to: pt(24, 0)); hull.addLine(to: pt(-9, -10)); hull.addLine(to: pt(-6, -3.5))
        hull.addLine(to: pt(-17, -3.5)); hull.addLine(to: pt(-17, 3.5)); hull.addLine(to: pt(-6, 3.5))
        hull.addLine(to: pt(-9, 10)); hull.closeSubpath()
        k.fill(hull, with: .linearGradient(Gradient(colors: [Color(hex: 0xE0E3E8), Color(hex: 0x8E949F)]), startPoint: pt(0, -10), endPoint: pt(0, 10)))
        var wing = k
        wing.clip(to: hull)
        for zone in [CGRect(x: -8, y: -9, width: 7, height: 4.6), CGRect(x: -8, y: 4.4, width: 7, height: 4.6)] {
            var z = wing
            z.clip(to: Path(zone))
            z.fill(Path(zone), with: .color(Color(hex: 0xF3D34A)))
            var stripes = Path()
            var x = zone.minX - zone.height
            while x < zone.maxX { stripes.move(to: pt(x, zone.maxY)); stripes.addLine(to: pt(x + zone.height, zone.minY)); x += 2.6 }
            z.stroke(stripes, with: .color(Color(hex: 0x2A2420)), lineWidth: 1)
        }
        line(k, pt(-15, 0), pt(18, 0), Color(hex: 0xA9AFBB), 0.6)
        glow(k, pt(9, 0), 4.5, 1.8, [.init(color: Color(hex: 0x1B2A44), location: 0.75), .init(color: Color(hex: 0x1B2A44).opacity(0), location: 1)])
        k.fill(dot(pt(8, -0.6), 0.6), with: .color(T.amber.opacity(0.9)))
        k.fill(box(-19, -3.4, 2.5, 2.6, 0.6), with: .color(gunmetal))
        k.fill(box(-19, 0.8, 2.5, 2.6, 0.6), with: .color(gunmetal))
        // Phụt cạnh: luân phiên trên/dưới.
        if c.on(1.1, 0.18) {
            let side: CGFloat = Int((c.live ? c.t : 0) / 1.1) % 2 == 0 ? -1 : 1
            glow(k, pt(6, 6.5 * side), 1.8, 2.6, [.init(color: .white.opacity(0.7), location: 0), .init(color: .white.opacity(0), location: 1)])
        }
        let flash = c.on(0.5, 0.5)
        if flash {
            glow(k, pt(-12, 0), 4, 4, [.init(color: T.amber.opacity(0.6), location: 0), .init(color: T.amber.opacity(0), location: 1)])
        }
        k.fill(dot(pt(-12, 0), 1.2), with: .color(T.amber.opacity(flash ? 1 : 0.3)))
    }

    /// Dữ liệu cũ — tàu buồm mặt trời: cánh buồm lá kim loại phấp phới, không động cơ, khoang tải kéo sau.
    private static func solarSail(_ k: GraphicsContext, _ c: Clock) {
        let fl = CGFloat(c.swing(3.2, 1.6, rest: 0.6))
        line(k, pt(0, 0), pt(-19, 2.5), steel, 0.4)
        k.fill(box(-22, 0.6, 4.2, 3.6, 0.8), with: .color(Color(hex: 0x8E949F)))
        k.fill(dot(pt(-20, 0.4), 0.6), with: .color(T.amber.opacity(c.on(3, 0.25) ? 1 : 0.25)))
        let a = pt(-12, -18), b = pt(8, -13 + fl), cc = pt(12, 13 + fl), d = pt(-8, 18)
        var sail = Path()
        sail.move(to: a)
        sail.addQuadCurve(to: b, control: pt(-1, -16 + fl * 1.5))
        sail.addLine(to: cc)
        sail.addQuadCurve(to: d, control: pt(3, 16 + fl * 1.5))
        sail.closeSubpath()
        k.fill(sail, with: .linearGradient(
            Gradient(stops: [
                .init(color: rgb(0xF3E7BE, 0.92), location: 0),
                .init(color: rgb(0xC9B98A, 0.85), location: 0.55),
                .init(color: rgb(0x8F8160, 0.85), location: 1),
            ]),
            startPoint: a, endPoint: cc
        ))
        var creases = Path()
        let mid = pt((a.x + cc.x) / 2, (a.y + cc.y) / 2)
        for e in [pt((a.x + b.x) / 2, (a.y + b.y) / 2), pt((b.x + cc.x) / 2, (b.y + cc.y) / 2),
                  pt((cc.x + d.x) / 2, (cc.y + d.y) / 2), pt((d.x + a.x) / 2, (d.y + a.y) / 2)] {
            creases.move(to: mid); creases.addLine(to: e)
        }
        k.stroke(creases, with: .color(.white.opacity(0.3)), lineWidth: 0.4)
        line(k, a, cc, Color(hex: 0x6B717C), 0.7)
        line(k, b, d, Color(hex: 0x6B717C), 0.7)
        k.fill(box(mid.x - 2.5, mid.y - 2.5, 5, 5, 1), with: .color(Color(hex: 0xB9BFCB)))
        k.fill(dot(mid, 1), with: .color(gunmetal))
    }

    /// Mất nguồn — xác tàu: trục gãy, nửa vòng mô-đun còn sót, mảnh vụn trôi quanh, không một ngọn đèn.
    private static func derelict(_ k: GraphicsContext, _ c: Clock) {
        let hull = Color(hex: 0x737883), dark = Color(hex: 0x464A53), edge = Color(hex: 0x8E949F)
        k.fill(box(-25, -3.6, 7, 7.2, 1.2), with: .color(dark))
        var bell = Path()
        bell.move(to: pt(-25, -2.4)); bell.addLine(to: pt(-28, -3.4)); bell.addLine(to: pt(-28, 3.4)); bell.addLine(to: pt(-25, 2.4))
        bell.closeSubpath()
        k.fill(bell, with: .color(Color(hex: 0x2E3138)))
        var spine = Path()
        spine.move(to: pt(-18, -1.2)); spine.addLine(to: pt(6, -1.2)); spine.addLine(to: pt(8.5, -2.2))
        spine.addLine(to: pt(7, 0)); spine.addLine(to: pt(9.5, 1)); spine.addLine(to: pt(6, 1.2)); spine.addLine(to: pt(-18, 1.2))
        spine.closeSubpath()
        k.fill(spine, with: .color(hull))
        // Nửa vòng còn lại quanh tâm (-2, 0); một mô-đun đã rơi mất.
        let R: CGFloat = 15, tilt: CGFloat = 0.3
        func ring(_ deg: Double) -> CGPoint {
            let a = deg * .pi / 180
            return pt(-2 + CGFloat(cos(a)) * R * tilt, CGFloat(sin(a)) * R)
        }
        var rail = Path()
        for (i, deg) in stride(from: 120.0, through: 300, by: 6).enumerated() {
            if i == 0 { rail.move(to: ring(deg)) } else { rail.addLine(to: ring(deg)) }
        }
        k.stroke(rail, with: .color(edge.opacity(0.7)), lineWidth: 0.8)
        line(k, pt(-2, 0), ring(210), edge.opacity(0.6), 0.6)
        line(k, pt(-2, 0), pt(1, -7), edge.opacity(0.6), 0.6)
        for deg in [140.0, 170, 200, 260, 290] {
            var m = k
            let p = ring(deg)
            m.translateBy(x: p.x, y: p.y)
            m.rotate(by: .radians(atan2(cos(deg * .pi / 180), -sin(deg * .pi / 180) * Double(tilt))))
            m.fill(box(-2.4, -1.9, 4.8, 3.8, 0.8), with: .color(hull))
            m.fill(box(-2.4, -0.35, 4.8, 0.7), with: .color(dark))
        }
        var lost = k
        lost.translateBy(x: 16, y: 9)
        lost.rotate(by: .degrees(c.live ? c.t * 20 : 30))
        lost.fill(box(-2.4, -1.9, 4.8, 3.8, 0.8), with: .color(hull))
        for (x, y, r) in [(12, -6, 0.6), (19, 3, 0.8), (22, -2, 0.5), (-8, 12, 0.7), (4, 14, 0.5)] as [(CGFloat, CGFloat, CGFloat)] {
            k.fill(dot(pt(x, y), r), with: .color(edge))
        }
        // Một đèn tàn hiếm hoi chớp lên rồi tắt.
        if c.live && c.on(5, 0.04) {
            k.fill(dot(pt(-21, -3.8), 0.7), with: .color(T.red.opacity(0.6)))
        }
    }

    /// Tàu "vòng quay": trục dài hướng +x, giữa trục là vòng mô-đun quay tạo trọng lực
    /// (cảm hứng Interstellar), đuôi là động cơ phụt luồng sáng trắng xanh (cảm hứng Project Hail Mary).
    /// Vòng nằm trong mặt phẳng vuông góc với trục, nhìn xiên nên thành elip hẹp; `spin` là góc quay (độ).
    private static func ship(_ g: GraphicsContext, _ c: CGPoint, _ deg: Double, _ s: CGFloat, _ flick: Double, spin: Double) {
        var k = g
        k.translateBy(x: c.x, y: c.y)
        k.rotate(by: .degrees(deg))
        k.scaleBy(x: s, y: s)
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
        let hull = Color(hex: 0xE6E9EF), steel = Color(hex: 0x9AA0AA)

        // Luồng phụt: quầng xanh rộng, lõi trắng mảnh — sáng nhất sát miệng loa.
        let plume = 34 + 6 * CGFloat(flick)
        glow(k, pt(-30 - plume * 0.35, 0), plume * 0.6, 5, [
            .init(color: rgb(0x7FD4FF, 0.45), location: 0),
            .init(color: rgb(0x7FD4FF, 0), location: 1),
        ])
        var core = Path()
        core.move(to: pt(-29, -1.3)); core.addLine(to: pt(-29 - plume, 0)); core.addLine(to: pt(-29, 1.3))
        core.closeSubpath()
        k.fill(core, with: .linearGradient(
            Gradient(colors: [.white, rgb(0xBDEBFF, 0.8), rgb(0x7FD4FF, 0)]),
            startPoint: pt(-29, 0), endPoint: pt(-29 - plume, 0)
        ))
        k.fill(dot(pt(-29, 0), 2.6), with: .color(.white.opacity(0.9)))

        // Vòng: N mô-đun, y = R·sinθ, chiều sâu z = R·cosθ, lệch ngang theo z để ra elip.
        let n = 10, R: CGFloat = 15, tilt: CGFloat = 0.3
        struct Seg { let p: CGPoint; let z: CGFloat; let a: Double }
        let segs: [Seg] = (0..<n).map { i in
            let a = (Double(i) / Double(n) * 360 + spin) * .pi / 180
            return Seg(p: pt(CGFloat(cos(a)) * R * tilt, CGFloat(sin(a)) * R), z: CGFloat(cos(a)), a: a)
        }
        func rail(front: Bool) {
            var p = Path()
            for i in 0...40 {
                let a = Double(i) / 40 * .pi + (front ? -.pi / 2 : .pi / 2)
                let q = pt(CGFloat(cos(a)) * R * tilt, CGFloat(sin(a)) * R)
                if i == 0 { p.move(to: q) } else { p.addLine(to: q) }
            }
            k.stroke(p, with: .color(steel.opacity(front ? 0.9 : 0.45)), lineWidth: 0.9)
        }
        func spokes(front: Bool) {
            for (i, sg) in segs.enumerated() where i % (n / 4 == 0 ? 1 : n / 4) == 0 && (sg.z >= 0) == front {
                var p = Path()
                p.move(to: .zero); p.addLine(to: sg.p)
                k.stroke(p, with: .color(steel.opacity(front ? 0.85 : 0.4)), lineWidth: 0.7)
            }
        }
        func modules(front: Bool) {
            for sg in segs.sorted(by: { $0.z < $1.z }) where (sg.z >= 0) == front {
                var m = k
                m.translateBy(x: sg.p.x, y: sg.p.y)
                // Hộp mô-đun nằm dọc theo tiếp tuyến của elip.
                m.rotate(by: .radians(atan2(Double(cos(sg.a)) * Double(R), -Double(sin(sg.a)) * Double(R * tilt))))
                let lit = 0.45 + 0.55 * Double((sg.z + 1) / 2)
                let box = CGRect(x: -2.4, y: -1.9, width: 4.8, height: 3.8)
                m.fill(Path(roundedRect: box, cornerRadius: 0.8), with: .color(hull.opacity(0.35 + 0.65 * lit)))
                m.fill(Path(CGRect(x: -2.4, y: -0.35, width: 4.8, height: 0.7)), with: .color(Color(hex: 0x3B4250).opacity(lit)))
            }
        }

        rail(front: false); spokes(front: false); modules(front: false)

        // Trục, động cơ đuôi, khoang chỉ huy ở mũi.
        k.fill(Path(CGRect(x: -22, y: -0.8, width: 42, height: 1.6)), with: .color(steel))
        k.fill(Path(roundedRect: CGRect(x: -27, y: -3.2, width: 9, height: 6.4), cornerRadius: 1.2), with: .color(Color(hex: 0x6B717C)))
        var bell = Path()
        bell.move(to: pt(-27, -2.2)); bell.addLine(to: pt(-30, -3.4)); bell.addLine(to: pt(-30, 3.4)); bell.addLine(to: pt(-27, 2.2))
        bell.closeSubpath()
        k.fill(bell, with: .color(Color(hex: 0x4A4E57)))
        for x in [CGFloat(-25.5), -22.5] {
            k.fill(Path(CGRect(x: x, y: -3.2, width: 0.8, height: 6.4)), with: .color(Color(hex: 0x4A4E57)))
        }
        var cmd = Path()
        cmd.move(to: pt(12, -3)); cmd.addLine(to: pt(20, -3))
        cmd.addQuadCurve(to: pt(25, 0), control: pt(24, -3))
        cmd.addQuadCurve(to: pt(20, 3), control: pt(24, 3))
        cmd.addLine(to: pt(12, 3)); cmd.closeSubpath()
        k.fill(cmd, with: .linearGradient(Gradient(colors: [hull, Color(hex: 0xA9AFBB)]), startPoint: pt(0, -3), endPoint: pt(0, 3)))
        k.fill(Path(CGRect(x: 18, y: -1.2, width: 3.2, height: 1.1)), with: .color(Color(hex: 0x1B2A44)))
        k.fill(Path(CGRect(x: 18.2, y: -1.1, width: 1.2, height: 0.5)), with: .color(rgb(0x9FD8FF, 0.9)))
        k.fill(dot(.zero, 2.8), with: .color(Color(hex: 0xC9CED8)))
        k.fill(dot(.zero, 1.2), with: .color(steel))

        spokes(front: true); rail(front: true); modules(front: true)
    }

    static func drawStill(_ g: GraphicsContext, _ size: CGSize, _ mood: AstroMood, _ focus: UnitPoint) {
        let w = size.width, h = size.height
        let f = CGPoint(x: focus.x * w, y: focus.y * h)
        g.fill(
            Path(CGRect(origin: .zero, size: size)),
            with: .radialGradient(
                Gradient(stops: [
                    .init(color: Color(hex: 0x2A1D6E), location: 0),
                    .init(color: Color(hex: 0x141233), location: 0.52),
                    .init(color: deep, location: 1),
                ]),
                center: f, startRadius: 0, endRadius: max(w, h) * 0.95
            )
        )

        // Dải Ngân Hà: elip mờ nằm chéo, lõi ấm lệch phải, vệt bụi tối dọc giữa.
        var b = g
        b.opacity = dim(mood)
        b.translateBy(x: w * 0.5, y: h * 0.45)
        b.rotate(by: .degrees(-12))
        let len = w * 1.5, thick = max(h * 0.75, 80)
        glow(b, .zero, len / 2, thick / 2, [
            .init(color: rgb(0xC9BCFF, 0.36), location: 0),
            .init(color: rgb(0x8A64F0, 0.22), location: 0.45),
            .init(color: rgb(0x3C2878, 0), location: 1),
        ])
        glow(b, CGPoint(x: len * 0.23, y: 0), len * 0.135, thick * 0.27, [
            .init(color: rgb(0xFFE4C8, 0.4), location: 0),
            .init(color: rgb(0xFFB08C, 0.12), location: 0.6),
            .init(color: rgb(0xFFC4AA, 0), location: 1),
        ])
        glow(b, .zero, len * 0.39, max(thick * 0.05, 4), [
            .init(color: rgb(0x06060C, 0.55), location: 0),
            .init(color: rgb(0x06060C, 0.4), location: 0.5),
            .init(color: rgb(0x06060C, 0), location: 1),
        ])
        for s in band.prefix(Int((240 * density(size)).rounded())) {
            let p = CGPoint(x: (s.x - 0.5) * len, y: s.y * thick * 0.3)
            b.fill(dot(p, s.r), with: .color(tints[s.tint].opacity(s.a)))
        }
    }

    static func drawLive(_ g: GraphicsContext, _ size: CGSize, _ mood: AstroMood, _ focus: UnitPoint,
                         _ t: Double, live: Bool) {
        let w = size.width, h = size.height
        let f = CGPoint(x: focus.x * w, y: focus.y * h)
        func wave(_ period: Double, _ delay: Double = 0) -> Double {
            live ? (1 - cos(2 * .pi * (t + delay) / period)) / 2 : 0
        }
        var sky = g
        sky.opacity = dim(mood)

        // Tinh vân sau lưng phi hành gia lấy màu kính mũ; mất nguồn thì xám.
        let tone = mood == .offline ? Astro.off : mood.accent
        let strength = mood == .idle || mood == .offline ? 0.24 : 0.46
        let k = 1 + 0.1 * wave(9)
        var neb = sky
        neb.opacity = sky.opacity * (0.8 + 0.2 * wave(9))
        glow(neb, CGPoint(x: f.x + w * 0.02, y: f.y), max(w * 0.23, 90) * k, max(h * 0.48, 70) * k, [
            .init(color: tone.opacity(strength), location: 0),
            .init(color: tone.opacity(strength * 0.45), location: 0.5),
            .init(color: tone.opacity(0), location: 1),
        ])
        glow(sky, CGPoint(x: w * 0.5, y: 0), w * 0.23, h * 0.4, [
            .init(color: rgb(0x7B4DFF, 0.4), location: 0),
            .init(color: rgb(0x7652E6, 0), location: 1),
        ])
        glow(sky, CGPoint(x: w * 0.08, y: h), w * 0.2, h * 0.37, [
            .init(color: rgb(0x22B8E0, 0.26), location: 0),
            .init(color: rgb(0x2FA7C9, 0), location: 1),
        ])
        glow(sky, CGPoint(x: w * 0.62, y: h * 1.05), w * 0.22, h * 0.42, [
            .init(color: rgb(0xE04FB0, 0.22), location: 0),
            .init(color: rgb(0xE04FB0, 0), location: 1),
        ])

        // Ba lớp sao, mỗi lớp trôi trọn một chiều rộng khung sau `period` giây.
        let d = density(size)
        func layer(_ stars: [Star], _ base: Double, _ period: Double) {
            let shift = live ? t / period : 0
            for s in stars.prefix(Int((base * d).rounded())) {
                var x = s.x - shift
                x -= x.rounded(.down)
                let a = s.a * (s.tw > 0 ? 1 - 0.78 * wave(s.tw, s.ph) : 1)
                let p = CGPoint(x: x * w, y: s.y * h)
                if s.r > 0.95 {
                    glow(sky, p, s.r * 3.5, s.r * 3.5, [
                        .init(color: tints[s.tint].opacity(a * 0.35), location: 0),
                        .init(color: tints[s.tint].opacity(0), location: 1),
                    ])
                }
                sky.fill(dot(p, s.r), with: .color(tints[s.tint].opacity(a)))
            }
        }
        layer(far, 150, 260)
        layer(mid, 60, 150)
        layer(near, 14, 90)

        // Hành tinh vành đai và tàu chỉ vẽ ở khung đủ rộng (hero, widget lớn) — khung nhỏ sẽ đè chữ.
        let roomy = w >= 300 && h >= 180
        if roomy {
            ringedPlanet(sky, CGPoint(x: w * 0.5, y: h * 0.92), min(30, max(10, min(w, h) * 0.12)))
        }
        // Thiên thạch trôi sang trái và mờ dần trước khi chạm vùng chữ (40–55% bề ngang).
        if roomy {
            let rockR = min(7, max(2.5, min(w, h) / 220 * 5))
            for r in rocks {
                var x = r.x - (live ? t / r.drift : 0)
                x -= x.rounded(.down)
                let fade = min(1, max(0, (x - 0.4) / 0.15))
                guard fade > 0 else { continue }
                let y = r.y + (live ? 0.015 * sin(t / r.drift * 8 + r.ph) : 0)
                var rc = sky
                rc.opacity = sky.opacity * fade
                rock(rc, CGPoint(x: x * w, y: y * h), rockR * r.size, r.ph + (live ? r.spin * t : 0), r.shape)
            }
        }

        // Mặt trăng nhỏ phía trên bên trái phi hành gia — khung hẹp quá thì bỏ.
        if w >= 300 {
            let r = min(23, max(6, min(w, h) * 0.045))
            let c = CGPoint(x: f.x - max(h * 0.5, 40), y: max(r + 8, f.y - h * 0.33) - 2 * wave(12))
            moon(sky, c, r)
        }

        // Tàu vũ trụ — mỗi tâm trạng một con tàu, một kiểu bay. Widget: tàu đậu một chỗ.
        // Vẽ trên g chứ không trên sky: tàu là vật tiền cảnh, không mờ theo bầu trời lúc mất nguồn.
        if roomy {
            let sc = min(1.4, max(0.75, h / 220 * 1.25))
            let clock = Clock(t: t, live: live)
            if !live {
                vessel(g, mood, CGPoint(x: w * 0.74, y: h * 0.74), parkAngle(mood), sc, clock)
            } else if let (p, ang) = flight(mood, t, w, h) {
                vessel(g, mood, p, ang, sc, clock)
            }
        }

        // Sao băng: vụt qua trong 8% đầu mỗi chu kỳ, còn lại im.
        guard live, mood != .offline else { return }
        let dir = CGPoint(x: -cos(Double.pi * 24 / 180), y: sin(Double.pi * 24 / 180))
        for (period, delay, sx, sy, tail) in [(9.0, 0.0, 0.875, 0.065, 0.13), (13.0, 5.5, 0.625, 0.03, 0.1)] {
            var ph = (t - delay) / period
            ph -= ph.rounded(.down)
            guard ph < 0.08 else { continue }
            let q = ph / 0.08
            let a = q < 0.15 ? q / 0.15 : 1 - (q - 0.15) / 0.85
            let travel = w * 0.4 * q
            let head = CGPoint(x: sx * w + dir.x * travel, y: sy * h + dir.y * travel)
            let end = CGPoint(x: head.x - dir.x * w * tail, y: head.y - dir.y * w * tail)
            var line = Path()
            line.move(to: end)
            line.addLine(to: head)
            g.stroke(line, with: .linearGradient(
                Gradient(stops: [
                    .init(color: .white.opacity(0), location: 0),
                    .init(color: rgb(0xBED2FF, 0.35 * a), location: 0.7),
                    .init(color: .white.opacity(0.95 * a), location: 1),
                ]),
                startPoint: end, endPoint: head
            ), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
        }
    }
}
