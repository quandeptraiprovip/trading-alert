import AppKit
import CoreGraphics

// Sinh icon app từ logo B: thân nến trắng đứng trên vạch stop xanh.
// Chạy: swiftc -O -o gen-icon main.swift && ./gen-icon <thư mục ra>

let GREEN = CGColor(srgbRed: 0.306, green: 0.886, blue: 0.631, alpha: 1)   // #4ee2a1

/// Squircle thật (superellipse n≈5), không phải bo góc tròn.
func squircle(in r: CGRect, n: Double = 5.0, samples: Int = 720) -> CGPath {
    let p = CGMutablePath()
    let a = Double(r.width) / 2, b = Double(r.height) / 2
    let cx = Double(r.midX), cy = Double(r.midY)
    for i in 0...samples {
        let t = Double(i) / Double(samples) * 2 * .pi
        let ct = cos(t), st = sin(t)
        let x = cx + a * pow(abs(ct), 2 / n) * (ct < 0 ? -1 : 1)
        let y = cy + b * pow(abs(st), 2 / n) * (st < 0 ? -1 : 1)
        if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
    }
    p.closeSubpath()
    return p
}

func draw(size S: CGFloat) -> CGImage {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: Int(S), height: Int(S), bitsPerComponent: 8,
                        bytesPerRow: 0, space: cs,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high

    // Icon macOS chiếm ~80% khung, chừa chỗ cho bóng.
    let inset = S * 0.0977
    let rect = CGRect(x: inset, y: inset, width: S - inset * 2, height: S - inset * 2)
    let shape = squircle(in: rect)

    // Bóng đổ dưới hình.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -S * 0.014), blur: S * 0.045,
                  color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.42))
    ctx.addPath(shape)
    ctx.setFillColor(CGColor(srgbRed: 0.04, green: 0.07, blue: 0.09, alpha: 1))
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(shape)
    ctx.clip()

    // Nền kính: sáng lạnh trên-trái xuống xanh sâu dưới-phải.
    let grad = CGGradient(colorsSpace: cs, colors: [
        CGColor(srgbRed: 0.243, green: 0.400, blue: 0.416, alpha: 1),
        CGColor(srgbRed: 0.106, green: 0.239, blue: 0.243, alpha: 1),
        CGColor(srgbRed: 0.035, green: 0.098, blue: 0.110, alpha: 1),
    ] as CFArray, locations: [0, 0.52, 1])!
    ctx.drawLinearGradient(grad, start: CGPoint(x: rect.minX, y: rect.maxY),
                           end: CGPoint(x: rect.maxX, y: rect.minY), options: [])

    // Vệt sáng thấu kính góc trên-trái.
    if let lens = CGGradient(colorsSpace: cs, colors: [
        CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.30),
        CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0),
    ] as CFArray, locations: [0, 1]) {
        ctx.drawRadialGradient(lens,
            startCenter: CGPoint(x: rect.minX + rect.width * 0.24, y: rect.maxY - rect.height * 0.1),
            startRadius: 0,
            endCenter: CGPoint(x: rect.minX + rect.width * 0.24, y: rect.maxY - rect.height * 0.1),
            endRadius: rect.width * 0.62, options: [])
    }

    // ── Dấu: nến + vạch stop ───────────────────────────────────────────────
    // Toạ độ gốc theo viewBox 48×48 của bản thiết kế, ánh xạ vào 66% khung.
    let m = rect.width * 0.70
    let ox = rect.midX - m / 2
    let oy = rect.midY - m / 2
    func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        CGPoint(x: ox + x / 48 * m, y: oy + (48 - y) / 48 * m)   // CG gốc dưới-trái
    }
    let U = m / 48

    ctx.setLineCap(.round)

    // Râu trên và dưới. Dày hơn bản thiết kế để còn đọc được ở 32px.
    ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.97))
    ctx.setLineWidth(4.5 * U)
    ctx.move(to: P(24, 5));  ctx.addLine(to: P(24, 13)); ctx.strokePath()
    ctx.move(to: P(24, 32)); ctx.addLine(to: P(24, 37)); ctx.strokePath()

    // Thân nến: chữ nhật bo MỀM. Bo tròn hết cạnh ngắn sẽ ra viên thuốc,
    // không ra thân nến — bán kính phải nhỏ hơn nửa bề rộng.
    let body = CGRect(x: P(15, 32).x, y: P(15, 32).y, width: 18 * U, height: 21 * U)
    ctx.addPath(CGPath(roundedRect: body, cornerWidth: 5.5 * U, cornerHeight: 5.5 * U, transform: nil))
    ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.97))
    ctx.fillPath()

    // Vạch stop — thứ quyết định risk, nên nó là mảng màu duy nhất.
    ctx.setStrokeColor(GREEN)
    ctx.setLineWidth(5 * U)
    ctx.move(to: P(8, 42)); ctx.addLine(to: P(40, 42)); ctx.strokePath()

    ctx.restoreGState()

    // Viền phản chiếu quanh mép.
    ctx.saveGState()
    ctx.addPath(shape)
    ctx.setLineWidth(max(1, S * 0.0032))
    ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.34))
    ctx.strokePath()
    ctx.restoreGState()

    return ctx.makeImage()!
}

func write(_ img: CGImage, to path: String) {
    let rep = NSBitmapImageRep(cgImage: img)
    rep.size = NSSize(width: img.width, height: img.height)
    guard let data = rep.representation(using: .png, properties: [:]) else { return }
    try? data.write(to: URL(fileURLWithPath: path))
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
for s in [16, 32, 64, 128, 256, 512, 1024] {
    write(draw(size: CGFloat(s)), to: "\(out)/icon_\(s).png")
    print("icon_\(s).png")
}
