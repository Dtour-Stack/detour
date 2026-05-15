/*
 * ShellWindow — the main NSWindow with an embedded WKWebView.
 *
 * For the scaffold, this just loads the URL it's given (typically
 * http://127.0.0.1:2138/ — Bun's static surface that mirrors the
 * Electrobun React bundle). Future commits add:
 *   - `views://` scheme handler (WKURLSchemeHandler) for offline
 *     bundled-asset loading
 *   - JS↔Swift typed-RPC bridge (replaces Electrobun's postMessage)
 *   - Window-state restoration
 *   - Multi-window support (cmd+N opens a new chat)
 */

import AppKit
import WebKit

@MainActor
final class ShellWindow: NSObject {
    private let window: NSWindow
    private let webView: WKWebView

    init(initialURL: URL) {
        let config = WKWebViewConfiguration()
        // Keep the agent's React bundle running in a persistent
        // store so localStorage and IndexedDB survive window
        // close/reopen.
        config.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: config)
        self.webView = webView

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false,
        )
        win.title = "Detour"
        win.titleVisibility = .visible
        win.setFrameAutosaveName("SwiftunMainWindow")
        win.center()
        win.contentView = webView
        win.isReleasedWhenClosed = false
        self.window = win

        super.init()

        webView.translatesAutoresizingMaskIntoConstraints = false
        if let host = win.contentView {
            webView.frame = host.bounds
            webView.autoresizingMask = [.width, .height]
        }
        webView.load(URLRequest(url: initialURL))
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
    }

    func hide() {
        window.orderOut(nil)
    }
}
