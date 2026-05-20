/*
 * WebViewCompanion — shared infrastructure for "native window hosting
 * a React surface" companions (Chat, Browser, Gallery, Workspace).
 *
 * Each per-surface companion has 50 lines of main.swift that supplies:
 *   - bundle title
 *   - which detour:// URL (or http://127.0.0.1:2138/<view>.html) to
 *     load in the WebView
 *   - the autosave name for window position restore
 *
 * Everything else (window creation, navigation, app lifecycle) lives
 * here. Future commits incrementally replace the WKWebView contents
 * with pure SwiftUI surfaces — the companion stays, the substrate
 * shrinks.
 */

import AppKit
import WebKit

struct WebViewCompanionConfig: Sendable {
    let title: String
    let initialURL: URL
    let frameAutosaveName: String
    let defaultSize: CGSize

    init(title: String, initialURL: URL, frameAutosaveName: String, defaultSize: CGSize = CGSize(width: 1100, height: 760)) {
        self.title = title
        self.initialURL = initialURL
        self.frameAutosaveName = frameAutosaveName
        self.defaultSize = defaultSize
    }
}

@MainActor
final class WebViewCompanionAppDelegate: NSObject, NSApplicationDelegate {
    private let config: WebViewCompanionConfig
    private var window: NSWindow?
    private var webView: WKWebView?
    private var closeObserver: NSObjectProtocol?

    init(config: WebViewCompanionConfig) {
        self.config = config
    }

    func applicationDidFinishLaunching(_: Notification) {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()

        // Same Electrobun shim as ShellWindow — see Swiftun's
        // ShellWindow.swift for full rationale. Without this stub
        // every webview companion loads to a blank screen because the
        // React bundle calls window.__electrobun.receiveMessageFromBun
        // = … on a non-existent object.
        let userContent = WKUserContentController()
        let shim = """
        (function(){
          if (window.__electrobun) return;
          window.__electrobun = {};
          var noopPost = function(msg) {
            try {
              fetch('http://127.0.0.1:2138/api/url-scheme/dispatch', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ kind: 'webview-bridge', msg: String(msg) })
              }).catch(function(){});
            } catch (e) {}
          };
          window.__electrobunBunBridge = { postMessage: noopPost };
          window.__electrobunInternalBridge = { postMessage: noopPost };
          window.__electrobunEventBridge = { postMessage: noopPost };
          window.__electrobunSendToHost = noopPost;
          window.__electrobunWebviewId = 'swiftun-companion';
        })();
        """
        let script = WKUserScript(
            source: shim,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
        )
        userContent.addUserScript(script)
        cfg.userContentController = userContent

        let wv = WKWebView(frame: .zero, configuration: cfg)
        let win = NSWindow(
            contentRect: NSRect(
                x: 0, y: 0,
                width: config.defaultSize.width,
                height: config.defaultSize.height,
            ),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false,
        )
        win.title = config.title
        win.setFrameAutosaveName(config.frameAutosaveName)
        win.center()
        win.contentView = wv
        wv.translatesAutoresizingMaskIntoConstraints = false
        if let host = win.contentView {
            wv.frame = host.bounds
            wv.autoresizingMask = [.width, .height]
        }
        wv.load(URLRequest(url: config.initialURL))
        win.isReleasedWhenClosed = false
        win.makeKeyAndOrderFront(nil)
        webView = wv
        window = win
        closeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: win,
            queue: .main,
        ) { _ in NSApplication.shared.terminate(nil) }
        NSApp.activate(ignoringOtherApps: true)
    }

    deinit {
        if let closeObserver {
            NotificationCenter.default.removeObserver(closeObserver)
        }
    }
}

/// Run a WebView-backed companion app. Call this from each
/// per-surface main.swift after constructing its config.
@MainActor
func runWebViewCompanion(_ config: WebViewCompanionConfig) {
    let delegate = WebViewCompanionAppDelegate(config: config)
    NSApplication.shared.delegate = delegate
    NSApplication.shared.setActivationPolicy(.accessory)
    // Keep a strong ref so ARC doesn't drop the delegate after the
    // function returns and `run()` starts the event loop.
    objc_setAssociatedObject(NSApplication.shared, "swiftunDelegate", delegate, .OBJC_ASSOCIATION_RETAIN)
    NSApplication.shared.run()
}
