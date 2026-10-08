import SwiftUI
import WidgetKit

struct TradingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "local.trading.widget.status", provider: FeedProvider()) { entry in
            WidgetRoot(entry: entry)
        }
        .configurationDisplayName("Tình trạng giao dịch")
        .description("Vốn, vị thế đang mở và đệm tới stop trên Binance.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct WidgetRoot: View {
    @Environment(\.widgetFamily) private var family
    let entry: FeedEntry

    var body: some View {
        content
            // Nền ngân hà như hero của dashboard — khung tĩnh, WidgetKit không chạy hoạt ảnh lặp.
            .containerBackground(for: .widget) {
                SpaceBackdrop(mood: AstroMood(entry.state), animated: false, focus: focus)
            }
            .environment(\.colorScheme, .dark)
    }

    /// Tinh vân đặt sau chỗ phi hành gia: góc trên phải, hoặc giữa khung khi lỗi/đang đọc.
    private var focus: UnitPoint {
        guard case .loaded = entry.state else { return UnitPoint(x: 0.5, y: 0.4) }
        switch family {
        case .systemSmall: return UnitPoint(x: 0.82, y: 0.2)
        case .systemLarge: return UnitPoint(x: 0.85, y: 0.12)
        default: return UnitPoint(x: 0.55, y: 0.25)
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

@main
struct TradingWidgetBundle: WidgetBundle {
    var body: some Widget { TradingWidget() }
}
