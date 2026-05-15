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
    private var mainWindow: ShellWindow?

    func applicationDidFinishLaunching(_: Notification) {
        do {
            try bun.start()
        } catch {
            NSLog("[Swiftun] failed to start Bun: \(error)")
            NSApplication.shared.terminate(nil)
            return
        }

        // Open the main window. URL is the React shell served by Bun.
        // Bun must be reachable before the window loads — for the
        // scaffold we just give it ~500ms; a real impl would poll
        // /api/health until it returns 200.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.mainWindow = ShellWindow(initialURL: URL(string: "http://127.0.0.1:2138/")!)
            self?.mainWindow?.show()
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func applicationShouldTerminate(_: NSApplication) -> NSApplication.TerminateReply {
        bun.stop()
        return .terminateNow
    }

    func applicationShouldHandleReopen(_: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            mainWindow?.show()
        }
        return true
    }
}

// Swift 6 actor-isolation: AppDelegate is @MainActor. Top-level code
// in an executable is non-isolated by default, so wrap the boot.
MainActor.assumeIsolated {
    let delegate = AppDelegate()
    NSApplication.shared.delegate = delegate
    NSApplication.shared.setActivationPolicy(.regular)
}
NSApplication.shared.run()
