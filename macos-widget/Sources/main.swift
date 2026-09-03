import AppKit
import SwiftUI

let REFRESH_SEC: TimeInterval = 20

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let loader = FeedLoader(port: WIDGET_PORT)
    private var timer: Timer?
    private var state: FeedState = .loading
    private let model = PanelModel()

    /// TẠO MỘT LẦN. Đổi contentViewController của popover đang mở làm nó không
    /// lay out lại — trước đây chỉ còn thanh chân hiện ra.
    private lazy var hosting: NSHostingController<PanelView> = {
        let h = NSHostingController(rootView: PanelView(
            model: model,
            onRefresh: { [weak self] in self?.refresh() },
            onDashboard: { [weak self] in
                if let url = URL(string: DASHBOARD_URL) { NSWorkspace.shared.open(url) }
                self?.popover.performClose(nil)
            },
            onQuit: { NSApp.terminate(nil) }
        ))
        // Để SwiftUI tự báo kích thước; KHÔNG tự đo fittingSize trên view chưa gắn window.
        h.sizingOptions = [.preferredContentSize]
        return h
    }()

    func applicationDidFinishLaunching(_ note: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(click(_:))
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])

        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self
        popover.contentViewController = hosting

        render()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: REFRESH_SEC, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    // MARK: Dữ liệu

    private func refresh() {
        loader.load { [weak self] s in
            guard let self = self else { return }
            self.state = s
            self.model.state = s
            self.render()
        }
    }

    // MARK: Ô trên thanh menu

    /// Tiêu đề ô: chấm màu + số. Khi ĐÃ DỪNG thì che số dư — cảnh báo phải thắng thông tin.
    private func render() {
        guard let button = statusItem.button else { return }
        let font = NSFont.systemFont(ofSize: 13, weight: .medium)
        let small = NSFont.systemFont(ofSize: 12, weight: .semibold)
        let out = NSMutableAttributedString()

        func dot(_ c: NSColor) {
            out.append(NSAttributedString(
                string: "● ",
                attributes: [.font: NSFont.systemFont(ofSize: 9), .foregroundColor: c,
                             .baselineOffset: 1]))
        }

        switch state {
        case .loading:
            dot(MenuColor.gray)
            out.append(NSAttributedString(string: "…", attributes: [.font: font]))

        case .offline:
            dot(MenuColor.red)
            out.append(NSAttributedString(
                string: "Mất nguồn",
                attributes: [.font: font, .foregroundColor: MenuColor.red]))

        case .loaded(let f):
            let red = MenuColor.red
            let green = MenuColor.green
            let amber = MenuColor.amber

            if f.health.state == "stopped" {
                dot(red)
                let ago = f.health.lastBarMs.map { Fmt.ago($0, now: f.now) } ?? "không rõ"
                out.append(NSAttributedString(
                    string: "Dừng \(ago)",
                    attributes: [.font: font, .foregroundColor: red]))
            } else {
                dot(f.health.state == "stale" ? amber : green)
                out.append(NSAttributedString(
                    string: f.totalEquity.map { Fmt.money($0) } ?? "—",
                    attributes: [.font: font]))
                if let p = f.dayChangePct {
                    out.append(NSAttributedString(
                        string: "  " + Fmt.pct(p, sign: true, places: 1),
                        attributes: [.font: small, .foregroundColor: p >= 0 ? green : red]))
                }
            }
        }

        button.attributedTitle = out
        button.toolTip = tooltip()
    }

    private func tooltip() -> String {
        switch state {
        case .loading: return "Đang đọc…"
        case .offline(let why): return why
        case .loaded(let f):
            var lines = [f.health.detail]
            if f.positionCount > 0 { lines.append("\(f.positionCount) vị thế mở") }
            if f.unprotectedCount > 0 { lines.append("⚠︎ \(f.unprotectedCount) vị thế KHÔNG có stop") }
            return lines.joined(separator: " · ")
        }
    }

    // MARK: Panel


    @objc private func click(_ sender: NSStatusBarButton) {
        let rightClick = NSApp.currentEvent?.type == .rightMouseUp
        if rightClick {
            statusItem.menu = contextMenu()
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
            return
        }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .maxY)
            refresh()
        }
    }

    private func contextMenu() -> NSMenu {
        let m = NSMenu()
        m.addItem(withTitle: "Làm mới", action: #selector(doRefresh), keyEquivalent: "r").target = self
        m.addItem(withTitle: "Mở bảng điều khiển", action: #selector(doDashboard), keyEquivalent: "d").target = self
        m.addItem(.separator())
        m.addItem(withTitle: "Thoát", action: #selector(doQuit), keyEquivalent: "q").target = self
        return m
    }

    @objc private func doRefresh() { refresh() }
    @objc private func doDashboard() {
        if let url = URL(string: DASHBOARD_URL) { NSWorkspace.shared.open(url) }
    }
    @objc private func doQuit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // không hiện ở Dock — chỉ sống trên thanh menu
app.run()
