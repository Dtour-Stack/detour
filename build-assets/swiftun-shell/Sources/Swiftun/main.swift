/*
 * Swiftun — Detour's native macOS shell. Boots Bun, hosts a single
 * NSApplication with the main React WebView + native windows.
 *
 * This is the scaffold. The shell currently:
 *   - Spawns Bun as a child process
 *   - Opens a single window with a WKWebView pointing at
 *     http://127.0.0.1:2138/ (Bun's static surface)
 *   - Routes `open-url` events (the detour:// scheme)
 *   - Exits Bun cleanly on `applicationShouldTerminate`
 *
 * Future commits incrementally pull in the companion code:
 *   - tray-bridge/main.swift  → TrayController in this process
 *   - applescript-bridge/main.swift → AppleScript NSScriptCommand classes
 *   - settings-bridge/main.swift → Settings window
 *   - activity-bridge/main.swift → Activity window
 *   - pensieve-bridge/main.swift → Pensieve window
 */

import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let bun = BunProcess()
    private var tray: TrayController?

    func applicationDidFinishLaunching(_: Notification) {
        do {
            try bun.start()
        } catch {
            NSLog("[Detour] failed to start Bun: \(error)")
            NSApplication.shared.terminate(nil)
            return
        }
        // Single NSStatusItem owned in-process. The tray menu items
        // call WindowFactory directly to open Settings / Activity /
        // Pensieve / Chat / Browser / Gallery / Workspace as siblings
        // under this one NSApplication — one app, many windows.
        tray = TrayController()
        NSApp.setActivationPolicy(.accessory)
        // Apply persisted Appearance prefs at boot so Light/Dark
        // selection survives across launches.
        let theme = UserDefaults.standard.string(forKey: "detour.appearance.theme") ?? "system"
        AppearanceController.applyTheme(theme)
        // App icon (the Detour Squirrel) — picked up by the Dock,
        // notifications fallback path, and any system surface that
        // queries NSApp.applicationIconImage.
        if let iconURL = NotificationManager.appIconURL(),
           let img = NSImage(contentsOf: iconURL) {
            NSApp.applicationIconImage = img
        }
        // Background-agent notifications. Subscribes to bun's SSE event
        // stream and posts UNNotifications for trajectory completions,
        // sub-agent state changes, quota errors, and Dreaming
        // reflections. Tapping a notification deep-links into the
        // matching window via WindowFactory.
        NotificationManager.shared.start()
        // Global system-wide keyboard shortcuts (⌘⌃P toggles the pet).
        GlobalHotKeys.shared.installDefaults()
        // Smoke-run the in-process JSC runtime so we have a live proof
        // that pure-logic agent code can run inside the Swift binary
        // (medium-term: replaces the Bun subprocess). Logs the parse
        // result for visibility — doesn't affect agent behavior yet.
        _ = JSRuntime.shared.runPrototype()
        // Exercise the Node-compat polyfill layer end-to-end (path /
        // os / fs / process). Proves the bridges work before eliza
        // modules depend on them.
        _ = JSRuntime.shared.runPolyfillTest()
        // 2026 perf foundation: open the typed-RPC unix socket to bun.
        // Per-call latency ~80µs vs the HTTP loopback. Existing HTTP
        // surface stays up during migration; new code uses RPCClient.
        RPCClient.shared.connect()
        // Reverse direction: Swift-as-server on ~/.detour/mlx.sock so
        // the bun-side local-mlx-image plugin can request GPU work
        // (text-to-image via Stable Diffusion / Sana when vendored).
        // Isolated from the UI socket — if MLX inference hangs, the
        // tray + chat surfaces keep working.
        MLXSocketServer.shared.start()
        // Wire chat / activity events from RPC notifications to the
        // existing pet activity feed. Replaces SSE.
        RPCClient.shared.onNotification("event.agentNarrate") { params in
            guard let dict = params as? [String: Any],
                  let text = dict["text"] as? String else { return }
            Task { @MainActor in PetActivityFeed.shared.publishExternal(text) }
        }
        // Poll for the socket file to appear, THEN do the smoke health
        // call. Avoids the cosmetic "RPC socket not connected" line at
        // boot when Swift wins the race against bun startup.
        Task { @MainActor in
            let socketPath = NSString(string: "~/.detour/rpc.sock").expandingTildeInPath
            for _ in 0..<60 {
                if FileManager.default.fileExists(atPath: socketPath) { break }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            do {
                let data = try await RPCClient.shared.call("health")
                let s = String(data: data, encoding: .utf8) ?? "<\(data.count)B>"
                NSLog("[RPCClient] smoke health: \(s)")
            } catch {
                NSLog("[RPCClient] smoke health failed: \(error.localizedDescription)")
            }
        }
    }

    func applicationShouldTerminate(_: NSApplication) -> NSApplication.TerminateReply {
        NotificationManager.shared.stop()
        MLXSocketServer.shared.stop()
        bun.stop()
        return .terminateNow
    }

    /// Route external `detour://` URLs (Shortcuts.app, terminal `open
    /// detour://…`) into the in-process WindowFactory + bun's
    /// url-scheme dispatcher. macOS calls this when our bundle is
    /// registered as the URL scheme handler.
    func application(_: NSApplication, open urls: [URL]) {
        for u in urls {
            guard u.scheme == "detour" else { continue }
            handleDetourURL(u)
        }
    }

    private func handleDetourURL(_ url: URL) {
        let host = (url.host ?? "").lowercased()
        switch host {
        case "settings":
            let tab = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "tab" })?.value
            WindowFactory.shared.openSettings(tab: tab)
        case "window":
            let target = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "target" })?.value ?? ""
            if !WindowFactory.shared.open(target: target) {
                // Unknown target — forward to bun's dispatcher in case
                // it knows what to do (e.g. agent action).
                forwardToBun(url)
            }
        case "chat", "pensieve", "activity":
            // Both an open command and (for chat / pensieve) a query
            // payload. Open the window; bun handles the query side.
            WindowFactory.shared.open(target: host)
            forwardToBun(url)
        default:
            // ping / action / localchat / companion — bun owns these.
            forwardToBun(url)
        }
    }

    private func forwardToBun(_ url: URL) {
        let endpoint = URL(string: "http://127.0.0.1:2138/api/url-scheme/dispatch")!
        var req = URLRequest(url: endpoint, timeoutInterval: 3.0)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["url": url.absoluteString])
        URLSession.shared.dataTask(with: req).resume()
    }
}

// Headless mode for end-to-end MLX socket smoke-testing.
//
// Boots only `MLXSocketServer.shared.start()` + runs the NSApplication
// runloop so Speech / AVFoundation / Vision dispatch sources work, but
// skips tray, windows, Bun spawn, notifications, and JS runtime. The
// Bun-side smoke driver can then dial ~/.detour/mlx.sock and exercise
// the full plugin → mlxRpc → socket → MLXService → bytes path without
// the full app starting.
//
//   swift run -c release Swiftun --mlx-server-only
//
// Stops on SIGINT/SIGTERM.
if CommandLine.arguments.contains("--mlx-server-only") {
    // SIGPIPE kills the process when our write() races a client close.
    signal(SIGPIPE, SIG_IGN)
    // MLXSocketServer is non-actor now — safe to call from main.
    MLXSocketServer.shared.start()
    NSLog("[mlx-server-only] socket up; waiting (Ctrl-C to stop)")
    signal(SIGINT) { _ in
        NSLog("[mlx-server-only] SIGINT")
        exit(0)
    }
    signal(SIGTERM) { _ in exit(0) }
    dispatchMain()
}

// SIGPIPE ignore — when an MLX socket client disconnects mid-write,
// the default SIGPIPE handler would kill the process. We handle EPIPE
// in user code via the socket error path. Same protection needed on
// the main app boot, not just --mlx-server-only.
signal(SIGPIPE, SIG_IGN)

// Swift 6 actor-isolation: AppDelegate is @MainActor. Top-level code
// in an executable is non-isolated by default, so wrap the boot.
MainActor.assumeIsolated {
    let delegate = AppDelegate()
    NSApplication.shared.delegate = delegate
    // Accessory = tray-only, no Dock icon. The native companions each
    // bring their own window when launched via detour://.
    NSApplication.shared.setActivationPolicy(.accessory)
}
NSApplication.shared.run()
