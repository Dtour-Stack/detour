/*
 * DetourClient — shared HTTP client used by every Swift companion to
 * talk to the bun runtime at 127.0.0.1:2138.
 *
 * Loopback-only. The Mac process model is: one Detour.app (Electrobun)
 * runs Bun and exposes an HTTP surface; the Swift companions are
 * separate processes that read snapshots + fire mutations. They share
 * the user account, so no auth needed inside this trust boundary.
 *
 * Polls /api/tray-state for state, posts to /api/local-ai routes
 * (start/stop/preset), and opens detour:// URLs for actions that
 * route through the URL-scheme dispatcher (window opens, AppleScript).
 */

import Foundation
import AppKit

@MainActor
final class DetourClient: ObservableObject {
    /// The last-known tray snapshot. Updated by `startPolling` every
    /// ~4s; views observe this to re-render.
    @Published var snapshot: TraySnapshotWire? = nil
    /// Connection issue surface — populated when /api/tray-state is
    /// unreachable or decodes badly. Cleared on the next successful poll.
    @Published var lastError: String? = nil

    private let baseURL: URL
    private var pollTimer: Timer?
    private let pollInterval: TimeInterval

    /// Override `port` to point at a non-default Detour instance
    /// (useful for tests + multi-instance dev). `pollInterval` of 0
    /// disables polling — callers can `poll()` on demand instead.
    init(port: Int = 2138, pollInterval: TimeInterval = 4.0) {
        baseURL = URL(string: "http://127.0.0.1:\(port)")!
        self.pollInterval = pollInterval
    }

    func startPolling() {
        poll()
        guard pollInterval > 0 else { return }
        let interval = pollInterval
        pollTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    // MARK: - State reads

    func poll() {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/tray-state"), timeoutInterval: 3.0)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { [weak self] data, _, err in
            guard let self else { return }
            Task { @MainActor in
                if let data, err == nil {
                    do {
                        let snap = try JSONDecoder().decode(TraySnapshotWire.self, from: data)
                        self.snapshot = snap
                        self.lastError = nil
                    } catch {
                        self.lastError = "decode failed: \(error.localizedDescription)"
                    }
                } else if let err {
                    self.lastError = "unreachable: \(err.localizedDescription)"
                }
            }
        }.resume()
    }

    /// Generic GET helper for endpoints not covered by the tray
    /// snapshot. Returns nil on failure.
    func getJSON<T: Decodable>(_ path: String, query: [String: String] = [:], as: T.Type) async -> T? {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 5.0)
        req.httpMethod = "GET"
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            return nil
        }
    }

    /// Eval-token-aware GET — endpoints under /api/eval/* require a
    /// bearer token from .env. The companion reads it once at startup
    /// and reuses it. Returns nil if the token isn't available.
    private let evalToken: String? = readEvalToken()

    func getEvalJSON<T: Decodable>(_ path: String, query: [String: String] = [:], as: T.Type) async -> T? {
        guard let token = evalToken else { return nil }
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 8.0)
        req.httpMethod = "GET"
        req.addValue(token, forHTTPHeaderField: "x-detour-eval-token")
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            return nil
        }
    }

    // MARK: - Mutations

    /// POST /api/local-ai/{tier}/{action} — start (with optional preset)
    /// or stop the local-chat or companion tier.
    func localAI(tier: String, action: String, preset: String? = nil) async {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/local-ai/\(tier)/\(action)"))
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "content-type")
        if let preset, !preset.isEmpty {
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["preset": preset])
        } else {
            req.httpBody = "{}".data(using: .utf8)
        }
        _ = try? await URLSession.shared.data(for: req)
        await MainActor.run { self.poll() }
    }

    /// Write a runtime setting via the local RPC socket (not the eval
    /// HTTP API — RPC is unix-socket-local so no token gate is needed).
    /// Bun re-reads settings on every getSetting/process.env lookup,
    /// so changes take effect immediately for the local-mlx-* plugins.
    func setSetting(key: String, value: String) async {
        do {
            _ = try await RPCClient.shared.call("settings.set", params: ["key": key, "value": value])
        } catch {
            NSLog("[DetourClient] setSetting \(key) failed: \(error.localizedDescription)")
        }
        await MainActor.run { self.poll() }
    }

    /// Expose the eval token so callers that need to make a one-off
    /// fetch with custom JSON parsing (the character generator, the
    /// SSE chat reader) can read it. Returns nil if unset.
    var evalTokenPublic: String? { evalToken }

    /// Open a `detour://` URL via NSWorkspace — used for actions
    /// routed through the bun-side URL-scheme dispatcher (window
    /// opens, settings deep-links, AppleScript-compatible commands).
    func openDetourURL(_ urlString: String) {
        if let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
    }

    /// POST a JSON body to a token-gated /api/eval/* endpoint. Fire-
    /// and-forget — the SwiftUI caller usually re-polls the matching
    /// GET endpoint right after to pick up the new state.
    @discardableResult
    func postEval(_ path: String, body: [String: Any]) async -> Bool {
        guard let token = evalToken else { return false }
        var req = URLRequest(url: baseURL.appendingPathComponent(path), timeoutInterval: 8.0)
        req.httpMethod = "POST"
        req.addValue(token, forHTTPHeaderField: "x-detour-eval-token")
        req.addValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse {
                return (200...299).contains(http.statusCode)
            }
            return false
        } catch {
            return false
        }
    }
}

// MARK: - Token resolution

/// Try to locate the DETOUR_EVAL_TOKEN at startup. Searches:
///   1. ENV var if set
///   2. ~/.detour/.env
///   3. The .env in the project root one dir above Detour.app
/// The token is shared with the bun-side eval HTTP routes; callers
/// like DetourActivity need it to hit /api/eval/trajectories etc.
private func readEvalToken() -> String? {
    if let env = ProcessInfo.processInfo.environment["DETOUR_EVAL_TOKEN"], !env.isEmpty {
        return env
    }
    let candidates = [
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".detour").appendingPathComponent(".env"),
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("detour").appendingPathComponent(".env"),
    ]
    for url in candidates {
        if let txt = try? String(contentsOf: url, encoding: .utf8) {
            for line in txt.components(separatedBy: .newlines) {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("DETOUR_EVAL_TOKEN=") {
                    return String(trimmed.dropFirst("DETOUR_EVAL_TOKEN=".count))
                        .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                }
            }
        }
    }
    return nil
}
