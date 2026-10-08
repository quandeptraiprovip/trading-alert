import SwiftUI
import WidgetKit

// Cùng ngôn ngữ với cửa sổ dashboard: một màu nền, ba mức chữ, không khung thẻ,
// nhóm bằng khoảng trắng và vạch mảnh. Xanh/đỏ chỉ dành cho lãi/lỗ.

// MARK: - Mảnh chung

extension Feed {
    var flatPositions: [(Venue, Position)] { venues.flatMap { v in v.positions.map { (v, $0) } } }
}

private struct StatusLine: View {
    let feed: Feed
    var body: some View {
        let s = feed.health.state
        let c = s == "running" ? Ink.up : (s == "stale" ? Ink.warn : Ink.down)
        HStack(spacing: 6) {
            Circle().fill(c).frame(width: 5, height: 5)
            Text(s == "running" ? "Đang chạy" : feed.health.detail)
                .font(Typo.text(10, .medium))
                .foregroundColor(s == "running" ? Ink.tertiary : c)
                .lineLimit(1)
        }
    }
}

private struct Label: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(Typo.text(10)).foregroundColor(Ink.tertiary)
    }
}

/// Số vốn lớn + mức đổi hôm nay.
private struct Equity: View {
    let feed: Feed
    let size: CGFloat
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Số lớn: chữ số tỉ lệ — chữ số đều làm "1" trông lỏng.
            Text(feed.totalEquity.map { Fmt.money($0) } ?? "—")
                .font(.system(size: size, weight: .light)).kerning(-0.8)
                .foregroundColor(Ink.primary)
                .lineLimit(1).minimumScaleFactor(0.7)
            if let d = feed.dayChange, let p = feed.dayChangePct {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(Fmt.money(d, sign: true))  \(Fmt.pct(p, sign: true))")
                        .font(Typo.num(11, .medium)).foregroundColor(Ink.signed(d))
                    Text("hôm nay").font(Typo.text(10)).foregroundColor(Ink.tertiary)
                }
                .lineLimit(1)
            }
        }
    }
}

private struct Hairline: View {
    var body: some View { Rectangle().fill(Ink.hair).frame(height: 0.5) }
}

/// Một dòng vị thế: MÃ  Long        +$12,30
///                  cách stop 2,1%      +0,8 R
private struct PositionLine: View {
    let p: Position
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(p.symbol).font(Typo.text(12, .semibold)).foregroundColor(Ink.primary)
                    Text(p.isLong ? "Long" : "Short")
                        .font(Typo.text(10, .medium)).foregroundColor(p.isLong ? Ink.up : Ink.down)
                }
                if let d = p.stopDistancePct {
                    Text("cách stop \(Fmt.pct(d))")
                        .font(Typo.num(10)).foregroundColor(d < 0.015 ? Ink.warn : Ink.tertiary)
                } else {
                    Text("không có stop").font(Typo.text(10, .medium)).foregroundColor(Ink.down)
                }
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 3) {
                Text(Fmt.money(p.pnl, sign: true))
                    .font(Typo.num(12, .medium)).foregroundColor(Ink.signed(p.pnl))
                if let r = p.r {
                    Text(Fmt.r(r)).font(Typo.num(10)).foregroundColor(Ink.tertiary)
                }
            }
        }
    }
}

private struct Fallback: View {
    let text: String
    var color: Color = Ink.secondary
    let mood: AstroMood
    let size: CGFloat
    var body: some View {
        VStack(spacing: 6) {
            Astronaut(mood: mood, animated: false).frame(width: size, height: size)
            Text(text).font(Typo.text(11)).foregroundColor(color)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Phi hành gia góc trên phải. Widget màn hình chỉ vẽ khung tĩnh:
/// WidgetKit không chạy hoạt ảnh lặp, chuyển động sống ở panel và dashboard.
private struct CornerAstronaut: View {
    let feed: Feed
    let size: CGFloat
    var body: some View {
        Astronaut(mood: AstroMood(.loaded(feed)), animated: false)
            .frame(width: size, height: size)
            // Ô vẽ có lề trong — đẩy ra mép để nhân vật không lấn vào số.
            .offset(x: size * 0.08, y: -size * 0.14)
    }
}

// MARK: - Khổ nhỏ

struct SmallWidgetView: View {
    let entry: FeedEntry
    var body: some View {
        Group {
            switch entry.state {
            case .loading: Fallback(text: "Đang đọc…", mood: .loading, size: 72)
            case .offline(let why): Fallback(text: why, color: Ink.down, mood: .offline, size: 72)
            case .loaded(let f):
                VStack(alignment: .leading, spacing: 0) {
                    StatusLine(feed: f)
                    Spacer(minLength: 8)
                    Label("Tổng vốn")
                    Equity(feed: f, size: 26).padding(.top, 4)
                    Spacer(minLength: 8)
                    // Mỗi lúc chỉ một lệnh: hiện thẳng lệnh đó, không đếm.
                    if let p = f.flatPositions.first?.1 {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Text(p.symbol).font(Typo.text(11, .semibold)).foregroundColor(Ink.primary)
                            Text(p.isLong ? "Long" : "Short")
                                .font(Typo.text(10, .medium)).foregroundColor(p.isLong ? Ink.up : Ink.down)
                            Spacer(minLength: 4)
                            Text(Fmt.money(p.pnl, sign: true))
                                .font(Typo.num(11, .medium)).foregroundColor(Ink.signed(p.pnl))
                        }
                    } else {
                        Text("Không có lệnh").font(Typo.text(10)).foregroundColor(Ink.tertiary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .topTrailing) { CornerAstronaut(feed: f, size: 48) }
            }
        }
        .padding(2)
    }
}

// MARK: - Khổ vừa

struct MediumWidgetView: View {
    let entry: FeedEntry
    var body: some View {
        Group {
            switch entry.state {
            case .loading: Fallback(text: "Đang đọc…", mood: .loading, size: 84)
            case .offline(let why): Fallback(text: why, color: Ink.down, mood: .offline, size: 84)
            case .loaded(let f):
                HStack(alignment: .top, spacing: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        StatusLine(feed: f)
                        Spacer(minLength: 8)
                        Label("Tổng vốn")
                        Equity(feed: f, size: 30).padding(.top, 4)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .overlay(alignment: .topTrailing) { CornerAstronaut(feed: f, size: 64) }

                    Rectangle().fill(Ink.hair).frame(width: 0.5).padding(.horizontal, 16)

                    VStack(alignment: .leading, spacing: 0) {
                        Label("Lệnh đang mở")
                        Spacer(minLength: 6)
                        if let p = f.flatPositions.first?.1 {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(p.symbol).font(Typo.text(13, .semibold)).foregroundColor(Ink.primary)
                                Text(p.isLong ? "Long" : "Short")
                                    .font(Typo.text(10, .medium)).foregroundColor(p.isLong ? Ink.up : Ink.down)
                            }
                            Text(Fmt.money(p.pnl, sign: true))
                                .font(Typo.num(15, .medium)).foregroundColor(Ink.signed(p.pnl))
                                .padding(.top, 6)
                            Text(p.r.map { Fmt.r($0) } ?? (p.stop == nil ? "không có stop" : " "))
                                .font(Typo.num(10)).foregroundColor(p.stop == nil ? Ink.down : Ink.tertiary)
                                .padding(.top, 3)
                        } else {
                            Text("Không có lệnh").font(Typo.text(12)).foregroundColor(Ink.secondary)
                        }
                    }
                    .frame(width: 100, alignment: .leading)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
                }
            }
        }
        .padding(2)
    }
}

// MARK: - Khổ lớn

struct LargeWidgetView: View {
    let entry: FeedEntry
    var body: some View {
        Group {
            switch entry.state {
            case .loading: Fallback(text: "Đang đọc…", mood: .loading, size: 110)
            case .offline(let why): Fallback(text: why, color: Ink.down, mood: .offline, size: 110)
            case .loaded(let f):
                VStack(alignment: .leading, spacing: 0) {
                    StatusLine(feed: f)
                    Label("Tổng vốn").padding(.top, 18)
                    Equity(feed: f, size: 36).padding(.top, 4)

                    Hairline().padding(.top, 20)
                    Label("Lệnh đang mở").padding(.top, 14)
                    if f.positionCount == 0 {
                        Text("Không có lệnh nào mở")
                            .font(Typo.text(11)).foregroundColor(Ink.secondary)
                            .padding(.top, 8)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(Array(f.flatPositions.enumerated()), id: \.element.1.id) { i, pair in
                                PositionLine(p: pair.1)
                                    .padding(.vertical, 10)
                                    .overlay(alignment: .top) { if i > 0 { Hairline() } }
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
                .overlay(alignment: .topTrailing) { CornerAstronaut(feed: f, size: 88) }
            }
        }
        .padding(2)
    }
}
