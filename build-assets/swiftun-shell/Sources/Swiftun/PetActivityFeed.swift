/*
 * PetActivityFeed — subscribes to bun's /api/eval/events SSE and
 * surfaces a human-readable "what the agent is doing right now" line
 * for the floating pet's chat bubble.
 *
 * We deliberately do NOT reuse NotificationManager's SSE socket —
 * that one is filtered to a small set of notify-worthy events. The
 * pet wants ALL chatDelta / workerStatusUpdate / planner activity
 * so the bubble feels alive while the agent is mid-thought.
 *
 * Events translated:
 *   chatDelta            → "thinking…" + first few tokens of the reply
 *   chatComplete         → final reply (truncated)
 *   workerStatusUpdate   → "WorkerName: status" (running/completed/failed)
 *   trajectoryFailed     → "trajectory failed — see Activity"
 *   dreamApplied         → "reflected — adjusted persona"
 *
 * The published `latest` value updates as events come in. The pet
 * view shows it for 5 seconds since last update, then fades the
 * bubble out.
 */

import Foundation
import SwiftUI

@MainActor
final class PetActivityFeed: ObservableObject {
    static let shared = PetActivityFeed()

    /// The current status string. `nil` means hide the bubble.
    @Published private(set) var latest: String? = nil
    @Published private(set) var lastUpdateAt: Date = Date.distantPast

    private var sseTask: URLSessionDataTask?
    private var sseSession: URLSession?
    private var streamBuffer = ""
    private var fadeoutTask: Task<Void, Never>?
    private var streamingReplyBuffer = ""

    init() {
        connect()
    }

    func connect() {
        sseTask?.cancel()
        guard let token = readEvalToken() else { return }
        // Subscribe to the curated narration stream (`agentNarrate`)
        // plus the raw streaming + worker / dream / failure events the
        // bubble can also surface on its own. The narrator broadcast is
        // the PREFERRED source — it's already been polished by the local
        // companion model into a real-voice line — but the raw events
        // give us coverage during turns where the companion isn't running.
        // Subscribe to every event the pet bubble should narrate:
        //   - agentNarrate: companion-polished one-liners (preferred when present)
        //   - chatDelta + chatComplete: streaming + final reply preview
        //   - inboxItemCreated: NEW — inbound Discord/Telegram/iMessage/X DMs
        //   - chatError: NEW — model/runtime errors so the user sees them
        //   - workerStatusUpdate / trajectoryFailed / dreamApplied: agent autonomy
        //   - providerQuotaChanged: cap hit / restored
        //   - goalChanged: new active goal surfaced by the agent
        let url = URL(string: "http://127.0.0.1:2138/api/eval/events?names=agentNarrate,chatDelta,chatComplete,inboxItemCreated,chatError,workerStatusUpdate,trajectoryFailed,dreamApplied,providerQuotaChanged,goalChanged")!
        var req = URLRequest(url: url)
        req.setValue(token, forHTTPHeaderField: "x-detour-eval-token")
        req.setValue("text/event-stream", forHTTPHeaderField: "accept")
        req.timeoutInterval = .infinity
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = .infinity
        config.timeoutIntervalForResource = .infinity
        let session = URLSession(configuration: config, delegate: ActivityFeedDelegate(parent: self), delegateQueue: nil)
        sseSession = session
        sseTask = session.dataTask(with: req)
        sseTask?.resume()
    }

    fileprivate func appendChunk(_ data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        streamBuffer += text
        while let range = streamBuffer.range(of: "\n\n") {
            let raw = String(streamBuffer[..<range.lowerBound])
            streamBuffer.removeSubrange(streamBuffer.startIndex..<range.upperBound)
            parseEvent(raw)
        }
    }

    fileprivate func streamEnded() {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            self.connect()
        }
    }

    private func parseEvent(_ raw: String) {
        var name: String? = nil
        var dataLines: [String] = []
        for line in raw.split(separator: "\n", omittingEmptySubsequences: false) {
            let s = String(line)
            if s.hasPrefix(":") { continue }
            if s.hasPrefix("event:") {
                name = s.dropFirst("event:".count).trimmingCharacters(in: .whitespaces)
            } else if s.hasPrefix("data:") {
                dataLines.append(s.dropFirst("data:".count).trimmingCharacters(in: .whitespaces).description)
            }
        }
        guard let n = name else { return }
        let payload = (try? JSONSerialization.jsonObject(with: Data(dataLines.joined(separator: "\n").utf8))) as? [String: Any]
        Task { @MainActor in
            self.handle(name: n, payload: payload ?? [:])
        }
    }

    private func handle(name: String, payload: [String: Any]) {
        switch name {
        case "agentNarrate":
            if let text = payload["text"] as? String, !text.isEmpty {
                publish(text)
            }
        case "chatDelta":
            let delta = (payload["delta"] as? String) ?? ""
            streamingReplyBuffer += delta
            let preview = streamingReplyBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
            if !preview.isEmpty {
                publish("✏️ \(truncate(preview, 60))")
            } else {
                publish("thinking…")
            }
        case "chatComplete":
            let full = ((payload["text"] as? String) ?? (payload["summary"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            streamingReplyBuffer = ""
            if !full.isEmpty {
                publish("💬 \(truncate(full, 80))")
            } else {
                publish("done thinking")
            }
        case "inboxItemCreated":
            // New inbound message / notification surfaced — Discord,
            // Telegram, iMessage, X, etc. Pin longer (10s) so the user
            // actually catches the ping when working in another app.
            let channel = (payload["channel"] as? String) ?? (payload["source"] as? String) ?? "channel"
            let from = (payload["fromHandle"] as? String) ?? ""
            let body = (payload["body"] as? String) ?? (payload["title"] as? String) ?? ""
            let icon = channelIcon(channel)
            let prefix = from.isEmpty ? channel : "\(channel) · \(from)"
            publish("\(icon) \(prefix): \(truncate(body, 100))", linger: 10)
        case "chatError":
            let msg = (payload["message"] as? String) ?? "chat error"
            publish("❌ \(truncate(msg, 100))", linger: 10)
        case "workerStatusUpdate":
            let worker = (payload["workerName"] as? String) ?? "Worker"
            let status = (payload["status"] as? String) ?? "updated"
            publish("🐿️ \(worker) · \(status)")
        case "trajectoryFailed":
            let err = (payload["error"] as? String) ?? "trajectory failed"
            publish("⚠ \(truncate(err, 80))", linger: 10)
        case "dreamApplied":
            let summary = (payload["summary"] as? String) ?? "adjusted persona"
            publish("✨ \(truncate(summary, 80))")
        case "providerQuotaChanged":
            // Capped / restored — model provider quota crossed a boundary.
            let provider = (payload["provider"] as? String) ?? "provider"
            let state = (payload["state"] as? String) ?? "changed"
            publish("📊 \(provider) · \(state)", linger: 8)
        case "goalChanged":
            let goal = (payload["goal"] as? String) ?? (payload["text"] as? String) ?? "goal updated"
            publish("🎯 \(truncate(goal, 80))")
        default:
            break
        }
    }

    /// Map a channel name to an emoji icon for the bubble.
    private func channelIcon(_ channel: String) -> String {
        switch channel.lowercased() {
        case "discord": return "💬"
        case "telegram": return "✈️"
        case "imessage": return "💙"
        case "x", "twitter": return "🐦"
        case "chat", "tray-app": return "💭"
        default: return "📨"
        }
    }

    /// Public entry point so RPC-pushed narrations (replacing the
    /// SSE stream) can feed the bubble without going through the
    /// internal SSE parser.
    func publishExternal(_ text: String) { publish(text) }

    private func publish(_ text: String, linger seconds: Double = 6.0) {
        latest = text
        lastUpdateAt = Date()
        let lingerNs = UInt64(seconds * 1_000_000_000)
        // Auto-fade if no new event arrives within `seconds`. Higher-
        // priority events (inbox/error) pass a longer linger so the user
        // catches them.
        fadeoutTask?.cancel()
        fadeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: lingerNs)
            guard let self else { return }
            if Date().timeIntervalSince(self.lastUpdateAt) >= seconds - 0.5 {
                self.latest = nil
            }
        }
    }

    private func truncate(_ s: String, _ n: Int) -> String {
        if s.count <= n { return s }
        return String(s.prefix(n)) + "…"
    }

    private func readEvalToken() -> String? {
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
}

private final class ActivityFeedDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    weak var parent: PetActivityFeed?
    init(parent: PetActivityFeed) { self.parent = parent }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        Task { @MainActor [weak parent] in parent?.appendChunk(data) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        Task { @MainActor [weak parent] in parent?.streamEnded() }
    }
}
