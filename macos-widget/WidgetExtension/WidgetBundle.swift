import SwiftUI
import WidgetKit

struct TradingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "local.trading.widget.status", provider: FeedProvider()) { entry in
            WidgetRoot(entry: entry)
        }
        .configurationDisplayName("Tình trạng giao dịch")
        .description("Vốn, vị thế đang mở và đệm tới stop trên Binance + MEXC.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct WidgetRoot: View {
    @Environment(\.widgetFamily) private var family
    let entry: FeedEntry

    var body: some View {
        content
            .containerBackground(for: .widget) {
                // Vật liệu do HỆ dựng — chỉ chồng thêm lớp gương mỏng và sắc tint,
                // phủ gradient đục lên đây là mất luôn kính của Tahoe.
                ZStack {
                    Rectangle().fill(.ultraThinMaterial)
                    LinearGradient(
                        colors: entry.isStopped
                            ? [Color(hex: 0xFF6B70).opacity(0.16), Color.black.opacity(0.24)]
                            : [Color.white.opacity(0.10), Color.white.opacity(0.015)],
                        startPoint: .top, endPoint: .bottom
                    )
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .systemSmall: SmallWidgetView(entry: entry)
        case .systemLarge: LargeWidgetView(entry: entry)
        default: MediumWidgetView(entry: entry)
        }
    }
}

extension FeedEntry {
    var isStopped: Bool {
        if case .loaded(let f) = state { return f.health.state == "stopped" }
        if case .offline = state { return true }
        return false
    }
}

@main
struct TradingWidgetBundle: WidgetBundle {
    var body: some Widget { TradingWidget() }
}
