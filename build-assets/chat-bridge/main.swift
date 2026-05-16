/*
 * DetourChat — native window hosting the React chat surface.
 *
 * Today the body is a WKWebView pointing at Bun's chat HTML — same
 * pixels as the current Electrobun-hosted chat, just in a window
 * Swiftun (and the eventual cutover) owns. Future iterations replace
 * the WebView interior with SwiftUI as the React composer / streaming
 * deltas are ported.
 */

import AppKit
import WebKit

MainActor.assumeIsolated {
    runWebViewCompanion(WebViewCompanionConfig(
        title: "Detour",
        initialURL: detourReactURL(view: "index"),
        frameAutosaveName: "DetourChatWindow",
        defaultSize: CGSize(width: 1000, height: 720),
    ))
}
