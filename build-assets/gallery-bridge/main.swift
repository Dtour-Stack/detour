/*
 * DetourGallery — native window for browsing generated media.
 * Hosts the React gallery for now; a pure-SwiftUI grid + detail
 * sheet would be a clean future port.
 */

import AppKit
import WebKit

MainActor.assumeIsolated {
    runWebViewCompanion(WebViewCompanionConfig(
        title: "Detour Gallery",
        initialURL: detourReactURL(view: "gallery"),
        frameAutosaveName: "DetourGalleryWindow",
        defaultSize: CGSize(width: 1100, height: 760),
    ))
}
