/*
 * ReactSurface — resolve a URL for a Detour React surface (chat,
 * browser, gallery, workspace, ...). Companions use this to point
 * their WKWebView at the right Bun-served HTML.
 *
 * Resolution order:
 *   1. DETOUR_DEV_URL env (dev server)
 *   2. http://127.0.0.1:2138/<view>.html (Bun-served bundled assets)
 *
 * The bun-side server.ts already serves the per-view HTML shells out
 * of Resources/app/views/main/ for any GET that doesn't hit an api route.
 */

import Foundation

func detourReactURL(view: String) -> URL {
    if let dev = ProcessInfo.processInfo.environment["DETOUR_DEV_URL"], !dev.isEmpty {
        let base = dev.hasSuffix("/") ? dev : dev + "/"
        return URL(string: "\(base)\(view).html") ?? URL(string: "http://127.0.0.1:2138/\(view).html")!
    }
    return URL(string: "http://127.0.0.1:2138/\(view).html")!
}
