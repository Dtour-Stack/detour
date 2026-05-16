/*
 * NotificationManager — bridges bun's broadcast event stream into native
 * macOS notifications. Detour runs the agent continuously in the
 * background; when significant things happen (a turn completes, an
 * action fails, a sub-agent finishes a coding task, a Dreaming reflection
 * surfaces, an arbiter refuses a local-model start, …) the user should
 * see a real macOS notification at the top right of their screen.
 *
 * Architecture:
 *   1. On app launch we request UNUserNotification authorization once.
 *   2. We connect a long-lived URLSession data task to
 *      GET /api/eval/events (SSE; bun fans broadcaster broadcasts into
 *      it). Parse the text/event-stream feed by lines.
 *   3. For each event whose `name` is in the "notify on" set, build a
 *      UNNotificationRequest and add() it.
 *   4. Tapping a notification deep-links into the right native window
 *      via WindowFactory (the response handler runs in-process — no URL
 *      scheme round-trip needed).
 *
 * Network resilience: if the SSE connection drops we retry with
 * exponential backoff up to 30s. bun emits a `: heartbeat` comment every
 * 15s so the OS-level TCP stay-alive isn't strictly required.
 */

import AppKit
import Foundation
import UserNotifications

final class NotificationManager: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = NotificationManager()

    private var streamTask: URLSessionDataTask?
    private var streamBuffer = ""
    private var reconnectDelaySeconds: TimeInterval = 1
    private var streamSession: URLSession?
    private var retryTask: Task<Void, Never>?

    /// Broadcast names we surface as notifications. Anything else from
    /// the SSE stream is ignored. Keep this list small — too many
    /// notifications == notification fatigue.
    private let notifyNames: Set<String> = [
        "chatComplete",
        "workerStatusUpdate",
        "trajectoryFailed",
        "providerQuotaExhausted",
        "dreamApplied",
    ]

    /// Running count of agent events the user hasn't acknowledged. Drives
    /// the tray icon badge (and Dock badge if we ever go .regular). Reset
    /// when the user clicks the tray.
    private var unread = 0

    override init() {
        super.init()
    }

    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // Request first so the system prompt fires on first launch.
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, err in
            if let err = err {
                NSLog("[notifications] auth error: \(err.localizedDescription)")
            }
            NSLog("[notifications] requestAuthorization granted=\(granted)")
            // Then read back the actual settings so we surface the
            // current state (could be provisional, denied-but-asked, etc).
            center.getNotificationSettings { settings in
                NSLog("[notifications] authorizationStatus=\(settings.authorizationStatus.rawValue) (0=notDetermined,1=denied,2=authorized,3=provisional,4=ephemeral)")
                NSLog("[notifications] alertSetting=\(settings.alertSetting.rawValue) soundSetting=\(settings.soundSetting.rawValue)")
            }
        }
        connectStream()
    }

    /// Diagnostic: post a test banner so the user can confirm
    /// permission is granted + the OS is rendering banners.
    ///
    /// We try UNUserNotificationCenter first (the "right" API). If
    /// auth is anything other than `.authorized` / `.provisional`, we
    /// immediately fall back to osascript so the user actually SEES a
    /// banner — that's what they care about, and ad-hoc-signed dev
    /// builds outside /Applications routinely get auth denied.
    func sendTestNotification() async -> String {
        let title = "Detour test"
        let body = "If you can see this, native notifications are working."
        // Primary path — in-app SwiftUI banner with the Squirrel icon.
        await MainActor.run {
            InAppBannerManager.shared.show(title: title, body: body, target: "settings")
        }
        // Best-effort UN dispatch in case the user has /Applications
        // install + auth granted (system banner stacks alongside ours).
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        let stStr: String
        switch settings.authorizationStatus {
        case .notDetermined: stStr = "notDetermined"
        case .denied: stStr = "denied"
        case .authorized: stStr = "authorized"
        case .provisional: stStr = "provisional"
        case .ephemeral: stStr = "ephemeral"
        @unknown default: stStr = "unknown"
        }
        if settings.authorizationStatus == .authorized
            || settings.authorizationStatus == .provisional {
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            content.userInfo = ["target": "settings"]
            let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            try? await center.add(req)
        }
        return "posted in-app (Detour icon); UN auth=\(stStr)"
    }

    /// Open System Settings → Notifications → Detour so the user can
    /// flip the toggle on if requestAuthorization was denied at first run.
    func openSystemSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.notifications") {
            NSWorkspace.shared.open(url)
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        retryTask?.cancel()
        retryTask = nil
    }

    // MARK: - SSE stream

    private func connectStream() {
        guard let token = resolveEvalToken() else {
            NSLog("[notifications] DETOUR_EVAL_TOKEN not set; SSE stream disabled")
            return
        }
        let url = URL(string: "http://127.0.0.1:2138/api/eval/events?names=\(notifyNames.joined(separator: ","))")!
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue(token, forHTTPHeaderField: "x-detour-eval-token")
        req.setValue("text/event-stream", forHTTPHeaderField: "accept")
        req.timeoutInterval = .infinity

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = .infinity
        config.timeoutIntervalForResource = .infinity
        let session = URLSession(configuration: config, delegate: SSEDelegate(parent: self), delegateQueue: nil)
        self.streamSession = session
        streamTask = session.dataTask(with: req)
        streamTask?.resume()
        NSLog("[notifications] SSE connected to /api/eval/events")
    }

    fileprivate func handleStreamChunk(_ chunk: Data) {
        guard let text = String(data: chunk, encoding: .utf8) else { return }
        streamBuffer += text
        // SSE events are separated by blank lines.
        while let range = streamBuffer.range(of: "\n\n") {
            let raw = String(streamBuffer[..<range.lowerBound])
            streamBuffer.removeSubrange(streamBuffer.startIndex..<range.upperBound)
            parseEvent(raw)
        }
    }

    fileprivate func handleStreamEnd(error: Error?) {
        NSLog("[notifications] SSE stream ended: \(error?.localizedDescription ?? "(no error)")")
        streamTask?.cancel()
        streamTask = nil
        // Reconnect with exponential backoff, capped at 30s.
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            guard let self else { return }
            let delay = self.reconnectDelaySeconds
            self.reconnectDelaySeconds = min(30, delay * 2)
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            await MainActor.run { self.connectStream() }
        }
    }

    private func parseEvent(_ raw: String) {
        var eventName: String? = nil
        var dataLines: [String] = []
        for line in raw.split(separator: "\n", omittingEmptySubsequences: false) {
            let s = String(line)
            if s.hasPrefix(":") {
                continue  // comment / heartbeat
            }
            if s.hasPrefix("event:") {
                eventName = s.dropFirst("event:".count).trimmingCharacters(in: .whitespaces)
            } else if s.hasPrefix("data:") {
                dataLines.append(s.dropFirst("data:".count).trimmingCharacters(in: .whitespaces).description)
            }
        }
        guard let name = eventName else { return }
        // Reset reconnect backoff on every successful event.
        reconnectDelaySeconds = 1
        let dataString = dataLines.joined(separator: "\n")
        let payload = (try? JSONSerialization.jsonObject(with: Data(dataString.utf8))) as? [String: Any]
        handleEvent(name: name, payload: payload ?? [:])
    }

    // MARK: - Event → notification mapping

    private func handleEvent(name: String, payload: [String: Any]) {
        switch name {
        case "chatComplete":
            let summary = (payload["summary"] as? String) ?? (payload["text"] as? String) ?? "Detour finished a turn"
            post(title: "Detour replied",
                 body: truncate(summary, 200),
                 category: "chat",
                 target: "chat")
        case "workerStatusUpdate":
            let workerName = (payload["workerName"] as? String) ?? "Worker"
            let status = (payload["status"] as? String) ?? "updated"
            // Only notify on terminal states — running pings are too noisy.
            if status == "completed" || status == "failed" || status == "blocked" {
                post(title: "\(workerName) \(status)",
                     body: (payload["summary"] as? String) ?? "Sub-agent state changed",
                     category: "worker",
                     target: "activity")
            }
        case "trajectoryFailed":
            let err = (payload["error"] as? String) ?? "Trajectory failed"
            post(title: "Trajectory failed",
                 body: truncate(err, 200),
                 category: "error",
                 target: "activity")
        case "providerQuotaExhausted":
            let provider = (payload["provider"] as? String) ?? "Provider"
            post(title: "\(provider) quota exhausted",
                 body: "Switch in Settings → Providers, or top up your plan.",
                 category: "provider",
                 target: "settings")
        case "dreamApplied":
            let summary = (payload["summary"] as? String) ?? "A Dreaming reflection was applied to the agent."
            post(title: "Detour reflected",
                 body: truncate(summary, 200),
                 category: "dream",
                 target: "activity")
        default:
            return
        }
    }

    private func post(title: String, body: String, category: String, target: String) {
        unread += 1
        // Primary path: in-app SwiftUI banner. Shows the Detour Squirrel
        // icon, top-right of the screen, auto-dismisses. We control
        // every pixel — no system limitation on app icon.
        Task { @MainActor in
            InAppBannerManager.shared.show(title: title, body: body, target: target)
            TrayController.shared?.setUnread(self.unread)
        }
        // Also fire a UN notification IF authorized — covers the case
        // where the user has Detour properly installed at /Applications
        // and granted permission. macOS then shows the native banner
        // in addition to ours; not duplicative if auth is denied, since
        // the UN add silently no-ops.
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized
                  || settings.authorizationStatus == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            content.userInfo = ["target": target]
            content.threadIdentifier = category
            content.badge = NSNumber(value: self.unread)
            if let iconURL = Self.appIconURL(),
               let att = try? UNNotificationAttachment(identifier: "icon", url: iconURL, options: nil) {
                content.attachments = [att]
            }
            let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(req) { err in
                if let err = err {
                    NSLog("[notifications] UN add error: \(err.localizedDescription)")
                }
            }
        }
    }

    /// Resolve the squirrel icon shipped in Contents/Resources/AppIcon.png.
    /// Used both as the notification attachment (UN path) and as the
    /// NSApp icon at runtime so the Dock + osascript notifications
    /// also pick up the brand.
    static func appIconURL() -> URL? {
        let url = Bundle.main.bundleURL
            .appendingPathComponent("Contents")
            .appendingPathComponent("Resources")
            .appendingPathComponent("AppIcon.png")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Last-resort top-right banner via osascript's `display notification`.
    /// This works for ANY signed status because Script Editor itself is
    /// the authorized notification source, not us. Used as a fallback
    /// when UNUserNotificationCenter rejects the request (ad-hoc-signed
    /// builds outside /Applications hit this routinely).
    static func postViaOsascript(title: String, body: String) {
        let escTitle = title.replacingOccurrences(of: "\"", with: "\\\"")
        let escBody = body.replacingOccurrences(of: "\"", with: "\\\"")
        let script = "display notification \"\(escBody)\" with title \"\(escTitle)\""
        Task.detached {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            proc.arguments = ["-e", script]
            do {
                try proc.run()
                proc.waitUntilExit()
            } catch {
                NSLog("[notifications] osascript fallback failed: \(error)")
            }
        }
    }

    /// Called by TrayController when the user clicks the menu — clears
    /// the unread badge.
    func acknowledge() {
        unread = 0
        UNUserNotificationCenter.current().setBadgeCount(0)
        Task { @MainActor in
            TrayController.shared?.setUnread(0)
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Show the alert even when Detour is the frontmost app (default
    /// behavior on macOS suppresses banners for the foreground app, but
    /// since we're an accessory app we want to surface every notification).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
    ) async -> UNNotificationPresentationOptions {
        return [.banner, .sound]
    }

    /// Tap handler — deep-link into the matching native window via the
    /// in-process WindowFactory. No URL scheme round-trip needed.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
    ) async {
        let target = response.notification.request.content.userInfo["target"] as? String ?? ""
        await MainActor.run {
            switch target {
            case "chat": WindowFactory.shared.open(target: "chat")
            case "activity": WindowFactory.shared.openActivity()
            case "settings": WindowFactory.shared.openSettings()
            case "pensieve": WindowFactory.shared.openPensieve()
            default: WindowFactory.shared.open(target: target)
            }
        }
    }

    // MARK: - Helpers

    private func resolveEvalToken() -> String? {
        if let env = ProcessInfo.processInfo.environment["DETOUR_EVAL_TOKEN"], !env.isEmpty {
            return env
        }
        let path = NSString(string: "~/.detour/.env").expandingTildeInPath
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        for line in text.split(separator: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("DETOUR_EVAL_TOKEN=") {
                var v = String(t.dropFirst("DETOUR_EVAL_TOKEN=".count))
                if (v.hasPrefix("\"") && v.hasSuffix("\"")) || (v.hasPrefix("'") && v.hasSuffix("'")) {
                    v = String(v.dropFirst().dropLast())
                }
                return v.isEmpty ? nil : v
            }
        }
        return nil
    }

    private func truncate(_ s: String, _ n: Int) -> String {
        if s.count <= n { return s }
        return String(s.prefix(n)) + "…"
    }
}

/// URLSessionDataDelegate that forwards raw chunks back to the manager
/// for SSE parsing. Lives in its own class because URLSession delegates
/// can't be MainActor-isolated, and we want a clean hop.
private final class SSEDelegate: NSObject, URLSessionDataDelegate {
    weak var parent: NotificationManager?
    init(parent: NotificationManager) {
        self.parent = parent
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        Task { @MainActor [weak parent] in
            parent?.handleStreamChunk(data)
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        Task { @MainActor [weak parent] in
            parent?.handleStreamEnd(error: error)
        }
    }
}
