/*
 * DetourPensieve — native SwiftUI memory + relationship browser.
 *
 * Initial scope: read-only. Memory tree + search + relationship list.
 * Edit operations (template authoring, embedding-map exploration,
 * graph viewer) still live in React — deep-link via the sidebar.
 */

import AppKit
import SwiftUI

enum PensieveSection: String, CaseIterable, Identifiable, Hashable {
    case memories, search, relationships
    var id: String { rawValue }
    var label: String {
        switch self {
        case .memories: return "Memories"
        case .search: return "Search"
        case .relationships: return "Relationships"
        }
    }
    var systemImage: String {
        switch self {
        case .memories: return "brain"
        case .search: return "magnifyingglass"
        case .relationships: return "person.2.fill"
        }
    }
}

struct RootView: View {
    @StateObject private var client = DetourClient()
    @State private var section: PensieveSection = .memories
    var body: some View {
        NavigationSplitView {
            List(PensieveSection.allCases, selection: $section) { s in
                Label(s.label, systemImage: s.systemImage).tag(s)
            }
            .listStyle(.sidebar)
            .frame(minWidth: 180)
            Section("Open in main window") {
                DeepLinkButton(label: "Knowledge",
                               url: "detour://window?target=pensieve",
                               client: client)
                DeepLinkButton(label: "Templates",
                               url: "detour://window?target=pensieve",
                               client: client)
                DeepLinkButton(label: "Graph + Embedding map",
                               url: "detour://window?target=pensieve",
                               client: client)
                DeepLinkButton(label: "Chronicler",
                               url: "detour://window?target=pensieve",
                               client: client)
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        } detail: {
            switch section {
            case .memories: MemoriesPlaceholder(client: client)
            case .search: SearchView(client: client)
            case .relationships: RelationshipsPlaceholder(client: client)
            }
        }
        .onAppear { client.startPolling() }
        .frame(minWidth: 920, idealWidth: 1080, minHeight: 600, idealHeight: 740)
    }
}

struct SearchView: View {
    @ObservedObject var client: DetourClient
    @State private var query: String = ""
    @State private var submitting: Bool = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Search Pensieve").font(.title2).bold()
            Text("Run a memory query. Results open in the React Pensieve view (full graph + filter UI lives there).")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                TextField("e.g. project codename squirrel-alpha", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { runSearch() }
                Button("Search", action: runSearch).buttonStyle(.borderedProminent)
                    .disabled(query.isEmpty)
            }
            Spacer()
        }
        .padding(20)
    }
    private func runSearch() {
        let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        client.openDetourURL("detour://pensieve/search?q=\(encoded)")
    }
}

struct MemoriesPlaceholder: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Memories").font(.title2).bold()
                Spacer()
                Button("Open in main window") {
                    client.openDetourURL("detour://window?target=pensieve")
                }
            }
            Text("Memory tree + table view will land here. Today the full React Pensieve has memory browsing, template editing, embedding maps, and the relationship graph — open it via the button above.")
                .font(.callout).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 6) {
                Text("Recent activity").font(.headline).padding(.top, 8)
                if let recent = client.snapshot?.recentTrajectories, !recent.isEmpty {
                    ForEach(recent) { t in
                        HStack {
                            Image(systemName: "doc.text").foregroundStyle(.secondary)
                            Text(t.source ?? "turn")
                            Spacer()
                            if let ts = t.startTime {
                                Text(ts.relativeTimeAgo()).font(.caption).foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                } else {
                    EmptyStateView(title: "No memories surfaced yet", systemImage: "brain")
                }
            }
            Spacer()
        }
        .padding(20)
    }
}

struct RelationshipsPlaceholder: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Relationships").font(.title2).bold()
                Spacer()
                Button("Open in main window") {
                    client.openDetourURL("detour://window?target=pensieve")
                }
            }
            Text("People + tagged-entity browser will land here. The React Pensieve has the full relationship graph + the per-person memory drill-down today.")
                .font(.callout).foregroundStyle(.secondary)
            Spacer()
        }
        .padding(20)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    func applicationDidFinishLaunching(_: Notification) {
        let host = NSHostingController(rootView: RootView())
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 740),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false,
        )
        win.title = "Detour Pensieve"
        win.center()
        win.contentViewController = host
        win.setFrameAutosaveName("DetourPensieveWindow")
        win.isReleasedWhenClosed = false
        win.makeKeyAndOrderFront(nil)
        window = win
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: win, queue: .main,
        ) { _ in NSApplication.shared.terminate(nil) }
        NSApp.activate(ignoringOtherApps: true)
    }
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
