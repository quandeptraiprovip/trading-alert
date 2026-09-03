import SwiftUI

// MARK: - Mảnh dùng lại

/// Chấm trạng thái + quầng sáng — mang toàn bộ tin về sức khoẻ hệ thống.
struct StatusDot: View {
    let color: Color
    var body: some View {
        Circle().fill(color).frame(width: 7, height: 7)
            .shadow(color: color.opacity(0.85), radius: 4)
    }
}

/// Nhãn dạng viên nang. Tahoe dùng viên nang, không dùng chữ nhật bo nhẹ.
struct Badge: View {
    let text: String
    let color: Color
    var size: CGFloat = 9
    var body: some View {
        Text(text)
            .font(T.sans(size, .bold)).kerning(0.8).foregroundColor(color)
            // Nhãn KHÔNG bao giờ được co lại: HStack chật thì nó cắt chữ nhãn
            // trước khi bóp Spacer, ra "BINAN…".
            .fixedSize()
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.18)))
    }
}

/// Chấm + chữ trạng thái, gói trong một viên nang kính.
struct StatusPill: View {
    let color: Color
    let label: String
    var body: some View {
        HStack(spacing: 6) {
            StatusDot(color: color)
            Text(label).font(T.sans(10, .semibold)).foregroundColor(color)
        }
        .padding(.leading, 7).padding(.trailing, 9).padding(.vertical, 4)
        .background(
            Capsule().fill(T.chipFill)
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5))
        )
    }
}

/// Thanh "cách stop": thang cố định 0–10%. Dài = còn đệm, ngắn = sắp bị quét.
struct Gauge: View {
    let fraction: Double
    var color: Color = T.green
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(T.trackFill)
                Capsule().fill(color)
                    .frame(width: max(4, geo.size.width * min(1, max(0, fraction))))
                    .shadow(color: color.opacity(0.7), radius: 4)
            }
        }
        .frame(height: 5)
    }
}

// MARK: - Panel

/// Giữ state cho panel. Một NSHostingController duy nhất quan sát object này,
/// nên SwiftUI tự vẽ lại và tự báo lại preferredContentSize khi dữ liệu về.
final class PanelModel: ObservableObject {
    @Published var state: FeedState = .loading
}

struct PanelView: View {
    @ObservedObject var model: PanelModel
    var onRefresh: () -> Void
    var onDashboard: () -> Void
    var onQuit: () -> Void

    /// Bán kính ngoài của panel; các khối trong tính đồng tâm từ số này.
    private let radius: CGFloat = 26
    private let pad: CGFloat = 15

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch model.state {
            case .loading:
                message("Đang đọc…", T.muted)
            case .offline(let why):
                offline(why)
            case .loaded(let feed):
                header(feed)
                if feed.positionCount == 0 {
                    empty(feed)
                } else {
                    VStack(alignment: .leading, spacing: 9) {
                        ForEach(feed.venues.filter { !$0.positions.isEmpty || !$0.ok }) { v in
                            venueBlock(v)
                        }
                    }
                    .padding(.horizontal, pad)
                    riskRow(feed)
                }
            }
            footer(dashboardUp: dashboardUp)
        }
        .frame(width: 360)
        .frame(minHeight: 120)
        .glassSurface(radius)
    }

    // MARK: Đầu panel

    private func statusColor(_ s: String) -> Color {
        s == "running" ? T.green : (s == "stale" ? T.amber : T.red)
    }
    private func statusLabel(_ s: String) -> String {
        s == "running" ? "Đang chạy" : (s == "stale" ? "Trễ nhịp" : "Đã dừng")
    }

    @ViewBuilder
    private func header(_ f: Feed) -> some View {
        let stopped = f.health.state == "stopped"
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                StatusPill(color: statusColor(f.health.state), label: statusLabel(f.health.state))
                Spacer(minLength: 8)
                if let bar = f.health.lastBarMs {
                    Text(Fmt.ago(bar, now: f.now)).font(T.sans(10)).foregroundColor(T.muted)
                }
            }

            if stopped {
                Text(f.health.detail)
                    .font(T.sans(11, .medium)).foregroundColor(T.red).padding(.top, 10)
                if f.positionCount > 0 {
                    Text("\(f.positionCount) vị thế vẫn đang mở — số dưới là lần đọc gần nhất")
                        .font(T.sans(10)).foregroundColor(T.red.opacity(0.78)).padding(.top, 5)
                }
            }

            Text(f.totalEquity.map { Fmt.money($0) } ?? "—")
                .font(T.mono(32, .thin)).kerning(-0.9)
                .foregroundColor(stopped ? T.muted : T.text)
                .numeral()
                .padding(.top, stopped ? 12 : 13)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let d = f.dayChange, let p = f.dayChangePct {
                    let c = d >= 0 ? T.green : T.red
                    Text(Fmt.money(d, sign: true)).font(T.mono(13, .semibold)).foregroundColor(c).numeral()
                    Text(Fmt.pct(p, sign: true)).font(T.mono(13, .semibold)).foregroundColor(c).numeral()
                    Text("hôm nay").font(T.sans(10)).foregroundColor(T.muted)
                } else {
                    Text("chưa có mốc đầu ngày").font(T.sans(10)).foregroundColor(T.muted)
                }
            }
            .padding(.top, 8)
        }
        .padding(.horizontal, pad).padding(.top, 14).padding(.bottom, 15)
    }

    // MARK: Một sàn

    @ViewBuilder
    private func venueBlock(_ v: Venue) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Badge(text: v.name, color: T.venue(v.id))
                Spacer(minLength: 8)
                Text(v.equity.map { Fmt.money($0) } ?? "—")
                    .font(T.mono(11, .medium)).foregroundColor(T.textSoft).numeral()
            }

            if !v.ok {
                HStack(spacing: 7) {
                    Image(systemName: "exclamationmark.triangle").font(.system(size: 10))
                    Text(v.error ?? "Không đọc được").font(T.sans(10, .medium)).lineLimit(2)
                }
                .foregroundColor(T.amber).padding(.top, 11)
            }

            ForEach(v.positions) { p in
                positionRow(p).padding(.top, 11)
            }
        }
        .padding(11)
        // Đồng tâm: 26 ngoài − 15 padding = 11... nhưng khối này lùi vào 15,
        // nên bán kính của nó là 26 − 15 = 11, cộng padding trong 11 → 17.
        .innerGlass(17)
    }

    @ViewBuilder
    private func positionRow(_ p: Position) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(p.symbol).font(T.mono(14, .semibold)).foregroundColor(T.text)
                Badge(text: p.isLong ? "LONG" : "SHORT", color: p.isLong ? T.green : T.red, size: 8)
                Text(subtitle(p)).font(T.sans(10)).foregroundColor(T.muted)
                Spacer(minLength: 6)
                if let r = p.r {
                    Text(Fmt.r(r)).font(T.mono(15, .semibold))
                        .foregroundColor(r >= 0 ? T.green : T.red).numeral()
                } else {
                    Text(Fmt.money(p.pnl, sign: true)).font(T.mono(15, .semibold))
                        .foregroundColor(p.pnl >= 0 ? T.green : T.red).numeral()
                }
            }

            HStack(spacing: 9) {
                Text(detailLine(p)).font(T.mono(10)).foregroundColor(T.muted).lineLimit(1)
                Spacer(minLength: 6)
                if p.r != nil {
                    Text(Fmt.money(p.pnl, sign: true))
                        .font(T.mono(10, .medium)).foregroundColor(T.textSoft)
                }
            }
            .padding(.top, 9)

            if let dist = p.stopDistancePct {
                HStack(spacing: 9) {
                    // Dưới 1,5% đệm là sắp bị quét — đổi màu để mắt bắt được trước khi đọc số.
                    Gauge(fraction: dist / 0.10, color: dist < 0.015 ? T.amber : T.green)
                    Text("cách stop \(Fmt.pct(dist))")
                        .font(T.sans(10)).foregroundColor(T.muted).fixedSize()
                }
                .padding(.top, 11)
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 9))
                    Text("KHÔNG tìm thấy stop cho vị thế này").font(T.sans(10, .semibold))
                }
                .foregroundColor(T.red).padding(.top, 10)
            }
        }
    }

    private func subtitle(_ p: Position) -> String {
        var parts: [String] = []
        if p.units > 1 { parts.append("\(p.units) unit") }
        if let d = p.heldDays { parts.append(Fmt.days(d)) }
        return parts.joined(separator: " · ")
    }

    private func detailLine(_ p: Position) -> String {
        var s = "vào \(Fmt.price(p.entry)) · giá \(Fmt.price(p.mark))"
        if let stop = p.stop { s += " · stop \(Fmt.price(stop))" }
        return s
    }

    // MARK: Chân

    @ViewBuilder
    private func riskRow(_ f: Feed) -> some View {
        HStack(spacing: 10) {
            Text("Risk đang mở").font(T.sans(10)).foregroundColor(T.muted).fixedSize()
            Gauge(fraction: (f.openRiskPct ?? 0) / max(f.maxRiskPct, 0.0001), color: T.textSoft)
            Text(f.openRiskPct.map { Fmt.pct($0, places: 1) } ?? "—")
                .font(T.mono(11, .semibold)).foregroundColor(T.textSoft).fixedSize().numeral()
            Text("/ \(Fmt.pct(f.maxRiskPct, places: 0))")
                .font(T.sans(10)).foregroundColor(T.dim).fixedSize()
        }
        .padding(.horizontal, pad).padding(.vertical, 14)
    }

    @ViewBuilder
    private func empty(_ f: Feed) -> some View {
        VStack(spacing: 8) {
            Text("Không có vị thế nào mở").font(T.sans(11, .medium)).foregroundColor(T.textSoft)
            Text(f.health.state == "running" ? "Đang chờ tín hiệu" : f.health.detail)
                .font(T.sans(10)).foregroundColor(T.dim)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 26)
        .padding(.horizontal, pad)
    }

    @ViewBuilder
    private func offline(_ why: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            StatusPill(color: T.red, label: "Không có dữ liệu")
            Text(why).font(T.sans(11, .medium)).foregroundColor(T.textSoft)
            Text("Chạy: npm run widget").font(T.mono(10)).foregroundColor(T.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, pad).padding(.top, 16).padding(.bottom, 18)
    }

    @ViewBuilder
    private func message(_ s: String, _ c: Color) -> some View {
        Text(s).font(T.sans(11)).foregroundColor(c)
            .frame(maxWidth: .infinity).padding(.vertical, 28)
    }

    /// nil khi chưa có dữ liệu — lúc đó cứ cho bấm, đừng đoán.
    private var dashboardUp: Bool? {
        if case .loaded(let f) = model.state { return f.dashboardUp }
        return nil
    }

    @ViewBuilder
    private func footer(dashboardUp: Bool?) -> some View {
        HStack(spacing: 9) {
            FooterButton(label: "Làm mới", action: onRefresh)
            if dashboardUp == false {
                // Không mở ra một tab chết: nói thẳng là nó chưa chạy.
                Text("Bảng điều khiển chưa chạy")
                    .font(T.sans(11, .medium)).foregroundColor(T.dim)
                    .help("Chạy: npm run dashboard")
            } else {
                FooterButton(label: "Bảng điều khiển", action: onDashboard)
            }
            Spacer(minLength: 0)
            FooterButton(label: "Thoát", action: onQuit, quiet: true)
        }
        .padding(.horizontal, pad).padding(.vertical, 11)
    }
}

private struct FooterButton: View {
    let label: String
    let action: () -> Void
    var quiet: Bool = false
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Text(label).font(T.sans(11, .medium))
                .foregroundColor(hover ? T.text : T.textSoft)
                .padding(.horizontal, quiet ? 4 : 12).padding(.vertical, 6)
                .background(
                    quiet ? nil
                        : Capsule().fill(hover ? Color.white.opacity(0.16) : T.chipFill)
                )
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}
