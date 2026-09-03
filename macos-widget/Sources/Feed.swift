import Foundation

// Khớp 1-1 với widget-feed.ts. Trường nào bên đó có thể null thì bên này Optional.

struct Position: Decodable, Identifiable {
    let symbol: String
    let dir: String
    let units: Int
    let entry: Double
    let mark: Double
    let stop: Double?
    let stopSource: String?
    let r: Double?
    let pnl: Double
    let riskUsd: Double?
    let heldDays: Double?
    let stopDistancePct: Double?

    var id: String { symbol + dir }
    var isLong: Bool { dir == "long" }
}

struct Venue: Decodable, Identifiable {
    let id: String
    let name: String
    let equity: Double?
    let ok: Bool
    let error: String?
    let positions: [Position]
}

struct Health: Decodable {
    let state: String       // running | stale | stopped
    let detail: String
    let lastWriteMs: Double?
    let lastBarMs: Double?
    let containerRunning: Bool?
}

struct Feed: Decodable {
    let now: Double
    let health: Health
    let totalEquity: Double?
    let dayChange: Double?
    let dayChangePct: Double?
    let openRiskUsd: Double?
    let openRiskPct: Double?
    let maxRiskPct: Double
    let minStopDistancePct: Double?
    let totalR: Double?
    let positionCount: Int
    let unprotectedCount: Int
    /// Dashboard web có đang nghe không — để panel không mở ra một tab chết.
    let dashboardUp: Bool?
    let venues: [Venue]
}

/// Trạng thái hiển thị — gộp cả trường hợp không gọi được server (server tắt).
enum FeedState {
    case loading
    case offline(String)
    case loaded(Feed)
}

/// Đọc widget.json từ loopback. Không giữ khoá API — mọi bí mật nằm ở tiến trình Node.
final class FeedLoader {
    private let url: URL
    private let session: URLSession

    init(port: Int) {
        self.url = URL(string: "http://127.0.0.1:\(port)/widget.json")!
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 20
        cfg.waitsForConnectivity = false
        self.session = URLSession(configuration: cfg)
    }

    func load(_ done: @escaping (FeedState) -> Void) {
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        session.dataTask(with: req) { data, _, err in
            let result: FeedState
            if let err = err {
                let ns = err as NSError
                result = .offline(
                    ns.code == NSURLErrorCannotConnectToHost || ns.code == NSURLErrorTimedOut
                        ? "Chưa chạy widget-server" : ns.localizedDescription
                )
            } else if let data = data, let feed = try? JSONDecoder().decode(Feed.self, from: data) {
                result = .loaded(feed)
            } else {
                result = .offline("Dữ liệu không đọc được")
            }
            DispatchQueue.main.async { done(result) }
        }.resume()
    }
}
