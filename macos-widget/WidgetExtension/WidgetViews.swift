import SwiftUI
import WidgetKit

// MARK: - Mảnh chung

private func statusColor(_ s: String) -> Color {
    s == "running" ? T.green : (s == "stale" ? T.amber : T.red)
}
private func statusLabel(_ s: String) -> String {
    s == "running" ? "Đang chạy" : (s == "stale" ? "Trễ nhịp" : "Đã dừng")
}

extension Feed {
    /// Dùng khi state của bot không có vị thế → không tính được R, nhưng $ thì luôn có.
    var totalPnl: Double { venues.flatMap { $0.positions }.map { $0.pnl }.reduce(0, +) }
    var flatPositions: [(Venue, Position)] { venues.flatMap { v in v.positions.map { (v, $0) } } }
}

private struct StatusRow: View {
    let feed: Feed
    var showAgo: Bool = true
    var body: some View {
        HStack(spacing: 8) {
            StatusPill(color: statusColor(feed.health.state), label: statusLabel(feed.health.state))
            Spacer(minLength: 4)
            if showAgo, let bar = feed.health.lastBarMs {
                Text(Fmt.ago(bar, now: feed.now)).font(T.sans(10)).foregroundColor(T.muted)
            }
        }
    }
}

private struct Equity: View {
    let feed: Feed
    let size: CGFloat
    var body: some View {
        let stopped = feed.health.state == "stopped"
        VStack(alignment: .leading, spacing: 7) {
            Text(feed.totalEquity.map { Fmt.money($0) } ?? "—")
                .font(T.mono(size, .thin)).kerning(-0.8)
                .foregroundColor(stopped ? T.muted : T.text)
                .numeral().lineLimit(1).minimumScaleFactor(0.8)
            if let d = feed.dayChange, let p = feed.dayChangePct {
                let c = d >= 0 ? T.green : T.red
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(Fmt.money(d, sign: true)).font(T.mono(12, .semibold)).foregroundColor(c).numeral()
                    Text(Fmt.pct(p, sign: true)).font(T.mono(12, .semibold)).foregroundColor(c).numeral()
                    Text("hôm nay").font(T.sans(9)).foregroundColor(T.muted)
                }
            }
        }
    }
}

/// Một dòng vị thế gọn: [SÀN] $vốn | MÃ [HƯỚNG] … +R
private struct CompactRow: View {
    let venue: Venue
    let p: Position
    /// false khi dòng trên đã ghi số vốn của cùng sàn này.
    var showEquity: Bool = true

    var body: some View {
        HStack(spacing: 8) {
            Badge(text: venue.name, color: T.venue(venue.id), size: 8)
            if showEquity {
                Text(venue.equity.map { Fmt.money($0) } ?? "—")
                    .font(T.mono(11, .medium)).foregroundColor(T.textSoft).numeral().fixedSize()
            }
            Text(p.symbol).font(T.mono(12, .semibold)).foregroundColor(T.text).fixedSize()
            Badge(text: p.isLong ? "LONG" : "SHORT", color: p.isLong ? T.green : T.red, size: 8)
            // KHÔNG nhét thanh cách stop vào đây: 329px không đủ và mọi nhãn bị cắt.
            // Khổ vừa đã có "gần stop nhất" ở đầu; thanh đầy đủ để cho khổ lớn.
            Spacer(minLength: 4)
            if let r = p.r {
                Text(Fmt.r(r)).font(T.mono(12, .semibold))
                    .foregroundColor(r >= 0 ? T.green : T.red).numeral()
            } else {
                Text(Fmt.money(p.pnl, sign: true)).font(T.mono(12, .semibold))
                    .foregroundColor(p.pnl >= 0 ? T.green : T.red).numeral()
            }
        }
    }
}

private struct Fallback: View {
    let text: String
    let color: Color
    var body: some View {
        VStack(spacing: 9) {
            StatusDot(color: color)
            Text(text).font(T.sans(11, .medium)).foregroundColor(T.textSoft)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Khổ nhỏ 155×155

struct SmallWidgetView: View {
    let entry: FeedEntry
    var body: some View {
        Group {
            switch entry.state {
            case .loading: Fallback(text: "Đang đọc…", color: T.muted)
            case .offline(let why): Fallback(text: why, color: T.red)
            case .loaded(let f):
                VStack(alignment: .leading, spacing: 0) {
                    StatusPill(color: statusColor(f.health.state), label: statusLabel(f.health.state))
                    VStack(alignment: .leading, spacing: 7) {
                        Text(f.totalEquity.map { Fmt.money($0) } ?? "—")
                            .font(T.mono(25, .thin)).kerning(-0.8)
                            .foregroundColor(f.health.state == "stopped" ? T.muted : T.text)
                            .numeral().minimumScaleFactor(0.72).lineLimit(1)
                        if let d = f.dayChange, let p = f.dayChangePct {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(Fmt.pct(p, sign: true)).font(T.mono(12, .semibold))
                                    .foregroundColor(d >= 0 ? T.green : T.red).numeral()
                                Text(Fmt.money(d, sign: true)).font(T.mono(10, .medium))
                                    .foregroundColor(T.muted)
                            }
                        }
                    }
                    .padding(.top, 13)
                    Spacer(minLength: 8)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(f.positionCount == 0 ? "Chờ tín hiệu" : "\(f.positionCount) vị thế")
                            .font(T.sans(9)).foregroundColor(T.muted)
                        Spacer(minLength: 4)
                        if let r = f.totalR {
                            Text(Fmt.r(r)).font(T.mono(11, .semibold))
                                .foregroundColor(r >= 0 ? T.green : T.red).numeral()
                        } else if f.positionCount > 0 {
                            Text(Fmt.money(f.totalPnl, sign: true)).font(T.mono(11, .semibold))
                                .foregroundColor(f.totalPnl >= 0 ? T.green : T.red).numeral()
                        }
                    }
                    .padding(.horizontal, 9).padding(.vertical, 7)
                    .innerGlass(14)
                }
            }
        }
        .padding(13)
    }
}

// MARK: - Khổ vừa 329×155

struct MediumWidgetView: View {
    let entry: FeedEntry
    var body: some View {
        Group {
            switch entry.state {
            case .loading: Fallback(text: "Đang đọc…", color: T.muted)
            case .offline(let why): Fallback(text: why, color: T.red)
            case .loaded(let f):
                VStack(alignment: .leading, spacing: 0) {
                    StatusRow(feed: f)
                    HStack(alignment: .bottom, spacing: 12) {
                        Equity(feed: f, size: 28)
                        Spacer(minLength: 6)
                        VStack(alignment: .trailing, spacing: 6) {
                            micro("risk mở", f.openRiskPct.map { Fmt.pct($0, places: 1) })
                            micro("gần stop nhất", f.minStopDistancePct.map { Fmt.pct($0) })
                        }
                        .padding(.bottom, 1)
                    }
                    .padding(.top, 11)
                    Spacer(minLength: 8)
                    if f.positionCount == 0 {
                        Text(f.health.state == "running" ? "Không có vị thế nào mở — đang chờ tín hiệu" : f.health.detail)
                            .font(T.sans(10)).foregroundColor(T.muted)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.vertical, 14)
                            .innerGlass(15)
                    } else {
                        let rs = Array(f.flatPositions.prefix(2))
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(rs.enumerated()), id: \.element.1.id) { i, pair in
                                CompactRow(venue: pair.0, p: pair.1,
                                           showEquity: i == 0 || rs[i - 1].0.id != pair.0.id)
                            }
                        }
                        .padding(.horizontal, 10).padding(.vertical, 9)
                        .innerGlass(15)
                    }
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 13)
    }

    @ViewBuilder
    private func micro(_ label: String, _ value: String?) -> some View {
        HStack(spacing: 4) {
            Text(label).font(T.sans(9)).foregroundColor(T.muted)
            Text(value ?? "—").font(T.mono(10, .semibold)).foregroundColor(T.textSoft).numeral()
        }
    }
}

// MARK: - Khổ lớn 329×345

struct LargeWidgetView: View {
    let entry: FeedEntry
    var body: some View {
        Group {
            switch entry.state {
            case .loading: Fallback(text: "Đang đọc…", color: T.muted)
            case .offline(let why): Fallback(text: why, color: T.red)
            case .loaded(let f):
                VStack(alignment: .leading, spacing: 0) {
                    StatusRow(feed: f)
                    Equity(feed: f, size: 31).padding(.top, 12)
                    if f.health.state == "stopped" && f.positionCount > 0 {
                        Text("\(f.positionCount) vị thế vẫn đang mở — số trên là lần đọc gần nhất")
                            .font(T.sans(10, .medium)).foregroundColor(T.red.opacity(0.82))
                            .padding(.top, 8)
                    }

                    if f.positionCount == 0 {
                        VStack(spacing: 8) {
                            Text("Không có vị thế nào mở")
                                .font(T.sans(11, .medium)).foregroundColor(T.textSoft)
                            Text(f.health.state == "running" ? "Đang chờ tín hiệu" : f.health.detail)
                                .font(T.sans(10)).foregroundColor(T.dim)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        let shown = Array(f.flatPositions.prefix(3))
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(shown.enumerated()), id: \.element.1.id) { i, pair in
                                venueRow(pair.0, pair.1,
                                         showHeader: i == 0 || shown[i - 1].0.id != pair.0.id)
                                    .padding(.horizontal, 10).padding(.vertical, 9)
                                    .innerGlass(15)
                            }
                        }
                        .padding(.top, 12)
                        if f.positionCount > shown.count {
                            Text("+\(f.positionCount - shown.count) vị thế nữa")
                                .font(T.sans(10)).foregroundColor(T.dim).padding(.top, 8)
                        }
                        Spacer(minLength: 4)
                    }

                    HStack(spacing: 10) {
                        Text("Risk đang mở").font(T.sans(10)).foregroundColor(T.muted).fixedSize()
                        Gauge(fraction: (f.openRiskPct ?? 0) / max(f.maxRiskPct, 0.0001), color: T.textSoft)
                        Text(f.openRiskPct.map { Fmt.pct($0, places: 1) } ?? "—")
                            .font(T.mono(11, .semibold)).foregroundColor(T.textSoft).fixedSize().numeral()
                        Text("/ \(Fmt.pct(f.maxRiskPct, places: 0))")
                            .font(T.sans(10)).foregroundColor(T.dim).fixedSize()
                    }
                    .padding(.top, 11)
                }
            }
        }
        .padding(.horizontal, 15).padding(.vertical, 15)
    }

    @ViewBuilder
    private func venueRow(_ v: Venue, _ p: Position, showHeader: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if showHeader {
                HStack(spacing: 8) {
                    Badge(text: v.name, color: T.venue(v.id))
                    Spacer(minLength: 6)
                    Text(v.equity.map { Fmt.money($0) } ?? "—")
                        .font(T.mono(11, .medium)).foregroundColor(T.textSoft).numeral()
                }
                .padding(.bottom, 10)
            }
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(p.symbol).font(T.mono(13, .semibold)).foregroundColor(T.text)
                Badge(text: p.isLong ? "LONG" : "SHORT", color: p.isLong ? T.green : T.red)
                Text(sub(p)).font(T.sans(10)).foregroundColor(T.muted)
                Spacer(minLength: 4)
                if let r = p.r {
                    Text(Fmt.r(r)).font(T.mono(14, .semibold))
                        .foregroundColor(r >= 0 ? T.green : T.red).numeral()
                } else {
                    Text(Fmt.money(p.pnl, sign: true)).font(T.mono(14, .semibold))
                        .foregroundColor(p.pnl >= 0 ? T.green : T.red).numeral()
                }
            }
            HStack(spacing: 9) {
                if let dist = p.stopDistancePct {
                    Gauge(fraction: dist / 0.10, color: dist < 0.015 ? T.amber : T.green)
                    Text("cách stop \(Fmt.pct(dist))")
                        .font(T.sans(10)).foregroundColor(T.muted).fixedSize()
                } else {
                    Text("KHÔNG có stop").font(T.sans(10, .semibold)).foregroundColor(T.red)
                    Spacer(minLength: 0)
                }
                Text(Fmt.money(p.pnl, sign: true))
                    .font(T.mono(10, .medium)).foregroundColor(T.textSoft).fixedSize()
            }
            .padding(.top, 9)
        }
    }

    private func sub(_ p: Position) -> String {
        var parts: [String] = []
        if p.units > 1 { parts.append("\(p.units) unit") }
        if let d = p.heldDays { parts.append(Fmt.days(d)) }
        return parts.joined(separator: " · ")
    }
}
