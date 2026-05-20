/*
 * DetourBrowser — native window hosting the React agent-browser
 * surface. (The agent-browser itself is already a WKWebView inside
 * React — this companion just owns the outer chrome.)
 */

import AppKit
import WebKit

MainActor.assumeIsolated {
    runWebViewCompanion(WebViewCompanionConfig(
        title: "Detour Browser",
        initialURL: detourReactURL(view: "browser"),
        frameAutosaveName: "DetourBrowserWindow",
        defaultSize: CGSize(width: 1280, height: 820),
    ))
}
