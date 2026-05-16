/*
 * WindowFactory — singleton that owns every Detour window. The tray,
 * AppleScript commands, and the macOS open-url handler all call into
 * this to open / focus a named surface. Windows are cached so a second
 * "open settings" focuses the existing window rather than spawning a
 * duplicate.
 *
 * Surfaces:
 *   - settings   → SwiftUI SettingsRootView (NSHostingController)
 *   - activity   → SwiftUI ActivityRootView
 *   - pensieve   → SwiftUI PensieveRootView
 *   - chat       → WKWebView pointing at the React chat shell
 *   - browser    → WKWebView for agent-browser
 *   - gallery    → WKWebView for generated-media gallery
 *   - workspace  → WKWebView for the coding workspace
 *
 * The WKWebView surfaces still need a proper Electroview RPC bridge
 * (today's `WindowFactory.openWebView` injects a stub shim that lets
 * the bundle mount but RPC calls fail silently). Tracked as task #50.
 */

import AppKit
import SwiftUI
import WebKit

@MainActor
final class WindowFactory: NSObject {
    static let shared = WindowFactory()

    private var windows: [String: NSWindow] = [:]

    /// Open (or focus) a named surface. Returns true if recognized.
    @discardableResult
    func open(target: String) -> Bool {
        switch target {
        case "settings":
            openSettings()
            return true
        case "activity":
            openActivity()
            return true
        case "pensieve":
            openPensieve()
            return true
        case "chat":
            // Native SwiftUI chat — replaces the WKWebView that
            // white-screened against the Electrobun-built React bundle.
            // Streams via SSE chatDelta / chatComplete from bun.
            openHosting(
                key: "chat",
                title: "Detour",
                autosave: "DetourChatWindow",
                size: CGSize(width: 900, height: 720),
            ) { AnyView(ChatRootView()) }
            return true
        case "browser":
            // Native SwiftUI browser — URL bar + WKWebView loading real
            // websites (not the broken Bun-served React shell).
            openHosting(
                key: "browser",
                title: "Detour Browser",
                autosave: "DetourBrowserWindow",
                size: CGSize(width: 1280, height: 820),
            ) { AnyView(BrowserRootView()) }
            return true
        case "gallery":
            openHosting(
                key: "gallery",
                title: "Detour Gallery",
                autosave: "DetourGalleryWindow",
                size: CGSize(width: 1100, height: 760),
            ) { AnyView(GalleryRootView()) }
            return true
        case "workspace":
            openHosting(
                key: "workspace",
                title: "Detour Workspace",
                autosave: "DetourWorkspaceWindow",
                size: CGSize(width: 1280, height: 800),
            ) { AnyView(WorkspaceRootView()) }
            return true
        case "pet":
            openPet()
            return true
        default:
            return false
        }
    }

    /// Float the Detour Squirrel sprite on the desktop. Borderless,
    /// transparent, always-on-top — the agent's "presence."
    func openPet() {
        if let existing = windows["pet"] {
            existing.makeKeyAndOrderFront(nil)
            return
        }
        let host = NSHostingController(rootView: AnyView(PetRootView().detourAccent()))
        let win = NSWindow(
            // Sprite is 192×208 + a 240-px chat bubble + 6px gap to the
            // left = 460×208 total. The bubble lives invisibly when the
            // agent is idle, so the pet still looks like just a sprite.
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 208),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false,
        )
        win.title = "Detour Pet"
        win.isOpaque = false
        win.backgroundColor = NSColor.clear
        win.hasShadow = false
        win.level = .floating
        win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        win.contentViewController = host
        // One-time migration: clear the old autosave frame from when
        // the window was 192×208. The new 460×208 layout needs to
        // re-anchor to the screen's right edge — without this, users
        // who had the pet open at the old position end up with the
        // window offscreen.
        let migrationKey = "detour.pet.frameMigrated.v2"
        if !UserDefaults.standard.bool(forKey: migrationKey) {
            UserDefaults.standard.removeObject(forKey: "NSWindow Frame DetourPetWindow")
            UserDefaults.standard.set(true, forKey: migrationKey)
        }
        win.setFrameAutosaveName("DetourPetWindow")
        // Position near the bottom-right corner on first show — out of
        // the way of typical app windows but still visible.
        if let screen = NSScreen.main {
            let frame = screen.visibleFrame
            // Window is 460×208 (sprite + chat bubble). Anchor its
            // RIGHT edge ~16px from the screen's right edge so the
            // sprite (which sits at the trailing end of the HStack)
            // is the only thing near the corner — bubble extends
            // leftward toward screen center.
            win.setFrameOrigin(NSPoint(
                x: frame.maxX - 460 - 16,
                y: frame.minY + 20,
            ))
        }
        win.isReleasedWhenClosed = false
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: win, queue: .main,
        ) { [weak self] _ in self?.windows.removeValue(forKey: "pet") }
        win.makeKeyAndOrderFront(nil)
        windows["pet"] = win
    }

    /// Close the floating pet, removing it from the windows cache.
    func closePet() {
        windows["pet"]?.close()
    }

    /// Open Settings on a specific tab path (e.g. "configuration:providers").
    /// Today the SwiftUI Settings root doesn't accept a deep-link param,
    /// so this just opens it; React fallback still handles unrecognized tabs.
    func openSettings(tab _: String? = nil) {
        openHosting(
            key: "settings",
            title: "Detour Settings",
            autosave: "DetourSettingsWindow",
            size: CGSize(width: 920, height: 700),
        ) { AnyView(SettingsRootView()) }
    }

    func openActivity() {
        // Consolidated: Activity + Pensieve share one Knowledge window
        // with sidebar tabs. We default to the trajectories tab when the
        // caller asked for Activity. Re-opening focuses the same window.
        openHosting(
            key: "knowledge",
            title: "Detour Knowledge",
            autosave: "DetourKnowledgeWindow",
            size: CGSize(width: 1180, height: 780),
        ) { AnyView(KnowledgeRootView(initial: .trajectories)) }
    }

    func openPensieve() {
        openHosting(
            key: "knowledge",
            title: "Detour Knowledge",
            autosave: "DetourKnowledgeWindow",
            size: CGSize(width: 1180, height: 780),
        ) { AnyView(KnowledgeRootView(initial: .memories)) }
    }

    private func openHosting(
        key: String,
        title: String,
        autosave: String,
        size: CGSize,
        viewBuilder: () -> AnyView,
    ) {
        if let existing = windows[key] {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        // Wrap every root view in DetourAccent so the user's Appearance
        // → Accent selection actually tints buttons / toggles / pickers
        // across the app.
        let host = NSHostingController(rootView: AnyView(viewBuilder().detourAccent()))
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: size.width, height: size.height),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false,
        )
        win.title = title
        win.center()
        win.contentViewController = host
        win.setFrameAutosaveName(autosave)
        win.isReleasedWhenClosed = false
        // Standard solid window — content area uses the system window
        // background so text reads cleanly. Liquid Glass is reserved
        // for the sidebar + individual cards/pills (the "floating
        // accent" pattern Apple uses for Tahoe). Earlier we cleared the
        // background entirely and the windows ended up see-through,
        // which made content unreadable.
        win.titlebarAppearsTransparent = true
        // Forget the cached window when the user closes it so the next
        // open call builds a fresh one — avoids holding onto stale
        // hosting controllers across show/hide cycles.
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: win, queue: .main,
        ) { [weak self] _ in self?.windows.removeValue(forKey: key) }
        win.makeKeyAndOrderFront(nil)
        windows[key] = win
        NSApp.activate(ignoringOtherApps: true)
    }

    private func openWebView(
        key: String,
        title: String,
        url: URL,
        size: CGSize,
    ) {
        if let existing = windows[key] {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        let userContent = WKUserContentController()
        // Minimal Electrobun shim so React bundles compiled against
        // electrobun/view don't throw on `window.__electrobun.
        // receiveMessageFromBun = …`. Full RPC parity requires a real
        // Electroview-compatible bridge (encrypted WebSocket, broadcast
        // fan-out) which we don't have yet — for now this gets the
        // bundle past boot.
        let shim = """
        (function(){
          if (window.__electrobun) return;
          window.__electrobun = {};
          var noopPost = function(){};
          window.__electrobunBunBridge = { postMessage: noopPost };
          window.__electrobunInternalBridge = { postMessage: noopPost };
          window.__electrobunEventBridge = { postMessage: noopPost };
          window.__electrobunSendToHost = noopPost;
          window.__electrobunWebviewId = 'detour-\(key)';
        })();
        """
        userContent.addUserScript(WKUserScript(
            source: shim,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
        ))
        cfg.userContentController = userContent
        let wv = WKWebView(frame: .zero, configuration: cfg)
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: size.width, height: size.height),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false,
        )
        win.title = title
        win.center()
        win.contentView = wv
        wv.translatesAutoresizingMaskIntoConstraints = false
        if let host = win.contentView {
            wv.frame = host.bounds
            wv.autoresizingMask = [.width, .height]
        }
        wv.load(URLRequest(url: url))
        win.isReleasedWhenClosed = false
        win.setFrameAutosaveName("Detour\(key.capitalized)Window")
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: win, queue: .main,
        ) { [weak self] _ in self?.windows.removeValue(forKey: key) }
        win.makeKeyAndOrderFront(nil)
        windows[key] = win
        NSApp.activate(ignoringOtherApps: true)
    }
}
