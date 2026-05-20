/*
 * AppIntents — declare Detour's surface to Spotlight + Shortcuts.app.
 * Users can run any of these from Spotlight search or stitch them into
 * macOS Shortcuts. Each intent routes through the in-process
 * WindowFactory + URL-scheme dispatcher so the behavior matches the
 * tray, AppleScript, and `open detour://…` paths.
 *
 * Surface (macOS 26 App Intents):
 *   - AskDetourIntent      "Ask Detour: <prompt>"
 *   - SearchMemoryIntent   "Search Detour Memory: <query>"
 *   - OpenWindowIntent     "Open Detour <window>"
 *   - StartLocalChatIntent "Start Detour local chat"
 *   - StopLocalChatIntent  "Stop Detour local chat"
 *
 * Donation: these appear in Spotlight's "Suggested Shortcuts" because
 * we provide a static AppShortcutsProvider. Users can also drag them
 * into Shortcuts and combine with other apps' intents.
 */

import AppIntents
import AppKit
import Foundation

@available(macOS 26.0, *)
struct AskDetourIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Detour"
    static let description: IntentDescription = IntentDescription(
        "Send a prompt to the Detour agent and wait for a reply.",
        categoryName: "Agent",
    )
    static let openAppWhenRun: Bool = true

    @Parameter(title: "Prompt")
    var prompt: String

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let encoded = prompt.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let url = URL(string: "detour://chat?text=\(encoded)&submit=1")!
        _ = await MainActor.run { NSWorkspace.shared.open(url) }
        // Best-effort: hit /api/eval/send synchronously if a token is
        // available so the Shortcut returns the reply text.
        if let token = readEvalTokenForIntent() {
            do {
                let reply = try await driveTurn(prompt: prompt, token: token)
                return .result(value: reply)
            } catch {
                return .result(value: "(Detour got the prompt; couldn't fetch reply: \(error.localizedDescription))")
            }
        }
        return .result(value: "Sent to Detour")
    }

    private func driveTurn(prompt: String, token: String) async throws -> String {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:2138/api/eval/send")!,
                             timeoutInterval: 120)
        req.httpMethod = "POST"
        req.addValue(token, forHTTPHeaderField: "x-detour-eval-token")
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "text": prompt, "wait": true, "timeoutMs": 90000,
        ])
        let (data, _) = try await URLSession.shared.data(for: req)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ""
        }
        return (obj["reply"] as? String) ?? ""
    }
}

@available(macOS 26.0, *)
struct SearchMemoryIntent: AppIntent {
    static let title: LocalizedStringResource = "Search Detour Memory"
    static let description: IntentDescription = IntentDescription(
        "Run a Pensieve memory search and open the result.",
        categoryName: "Knowledge",
    )
    static let openAppWhenRun: Bool = true

    @Parameter(title: "Query")
    var query: String

    func perform() async throws -> some IntentResult {
        let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let url = URL(string: "detour://pensieve/search?q=\(encoded)")!
        _ = await MainActor.run { NSWorkspace.shared.open(url) }
        return .result()
    }
}

@available(macOS 26.0, *)
struct OpenDetourWindowIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Detour Window"
    static let description: IntentDescription = IntentDescription(
        "Bring a Detour native window forward.",
        categoryName: "Navigation",
    )
    static let openAppWhenRun: Bool = true

    @Parameter(title: "Window")
    var target: DetourWindowTarget

    func perform() async throws -> some IntentResult {
        let url = URL(string: "detour://window?target=\(target.rawValue)")!
        _ = await MainActor.run { NSWorkspace.shared.open(url) }
        return .result()
    }
}

@available(macOS 26.0, *)
enum DetourWindowTarget: String, AppEnum {
    case chat, settings, knowledge, browser, gallery, workspace, pensieve, activity
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Detour Window" }
    static var caseDisplayRepresentations: [DetourWindowTarget: DisplayRepresentation] {
        [
            .chat: "Chat",
            .settings: "Settings",
            .knowledge: "Knowledge",
            .browser: "Browser",
            .gallery: "Gallery",
            .workspace: "Workspace",
            .pensieve: "Pensieve",
            .activity: "Activity",
        ]
    }
}

@available(macOS 26.0, *)
struct StartLocalChatIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Detour Local Chat"
    static let description: IntentDescription = IntentDescription(
        "Boot the local llama chat tier with the default preset.",
        categoryName: "Agent",
    )
    func perform() async throws -> some IntentResult {
        let url = URL(string: "detour://localchat/start")!
        _ = await MainActor.run { NSWorkspace.shared.open(url) }
        return .result()
    }
}

@available(macOS 26.0, *)
struct StopLocalChatIntent: AppIntent {
    static let title: LocalizedStringResource = "Stop Detour Local Chat"
    static let description: IntentDescription = IntentDescription(
        "Stop the local llama chat tier and free its RAM.",
        categoryName: "Agent",
    )
    func perform() async throws -> some IntentResult {
        let url = URL(string: "detour://localchat/stop")!
        _ = await MainActor.run { NSWorkspace.shared.open(url) }
        return .result()
    }
}

@available(macOS 26.0, *)
struct DetourAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskDetourIntent(),
            phrases: ["Ask \(.applicationName) \(\.$prompt)"],
            shortTitle: "Ask Detour",
            systemImageName: "ellipsis.bubble",
        )
        AppShortcut(
            intent: SearchMemoryIntent(),
            phrases: ["Search \(.applicationName) memory for \(\.$query)"],
            shortTitle: "Search Memory",
            systemImageName: "magnifyingglass",
        )
        AppShortcut(
            intent: OpenDetourWindowIntent(),
            phrases: ["Open \(.applicationName) \(\.$target)"],
            shortTitle: "Open Window",
            systemImageName: "macwindow",
        )
        AppShortcut(
            intent: StartLocalChatIntent(),
            phrases: ["Start \(.applicationName) local chat"],
            shortTitle: "Start Local Chat",
            systemImageName: "cpu",
        )
        AppShortcut(
            intent: StopLocalChatIntent(),
            phrases: ["Stop \(.applicationName) local chat"],
            shortTitle: "Stop Local Chat",
            systemImageName: "stop.circle",
        )
    }
}

private func readEvalTokenForIntent() -> String? {
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
