/*
 * DetourWorkspace — native window for the coding-agents workspace
 * (project files, agent sessions, previews, GitHub channel).
 */

import AppKit
import WebKit

MainActor.assumeIsolated {
    runWebViewCompanion(WebViewCompanionConfig(
        title: "Detour Workspace",
        initialURL: detourReactURL(view: "workspace"),
        frameAutosaveName: "DetourWorkspaceWindow",
        defaultSize: CGSize(width: 1280, height: 800),
    ))
}
