import Foundation

// Cấu hình dùng CHUNG cho app thanh menu và widget extension.
let WIDGET_PORT = Int(ProcessInfo.processInfo.environment["WIDGET_PORT"] ?? "") ?? 3849
let DASHBOARD_URL = ProcessInfo.processInfo.environment["DASHBOARD_URL"] ?? "http://127.0.0.1:3848"
