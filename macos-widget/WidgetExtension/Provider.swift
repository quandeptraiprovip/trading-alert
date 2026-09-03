import WidgetKit
import SwiftUI

struct FeedEntry: TimelineEntry {
    let date: Date
    let state: FeedState
}

/// WidgetKit chỉ cho làm mới vài chục lần/ngày, nên widget màn hình là bề mặt LIẾC.
/// Muốn theo sát từng phút thì dùng ô thanh menu.
struct FeedProvider: TimelineProvider {
    private let loader = FeedLoader(port: WIDGET_PORT)
    private static let refresh: TimeInterval = 15 * 60

    func placeholder(in context: Context) -> FeedEntry {
        FeedEntry(date: Date(), state: .loading)
    }

    func getSnapshot(in context: Context, completion: @escaping (FeedEntry) -> Void) {
        loader.load { completion(FeedEntry(date: Date(), state: $0)) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<FeedEntry>) -> Void) {
        loader.load { state in
            let entry = FeedEntry(date: Date(), state: state)
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(Self.refresh))))
        }
    }
}
